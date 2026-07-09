/**
 * Discovers and imports Claude Code conversation transcripts.
 *
 * Discovery scans `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Import is
 * a two-step flow: `planImport` previews how the selected sessions map to
 * projects (existing matches by cwd + proposed new projects), then `importSessions`
 * applies the user-confirmed mapping — creating any new projects (with edited
 * titles) and synthesizing historical orchestration events appended through the
 * engine, so the import replays cleanly on a read-model rebuild. Imported threads
 * are marked read-only / non-resumable via `importedSource`.
 */
import {
  type ClaudeCodeDiscoverResult,
  ClaudeCodeImportError,
  type ClaudeCodeImportInput,
  type ClaudeCodeImportPlan,
  type ClaudeCodeImportPlanInput,
  type ClaudeCodeImportPlanProject,
  type ClaudeCodeImportPlanSession,
  type ClaudeCodeImportResult,
  type ClaudeCodeImportSessionAssignment,
  type ClaudeCodeImportTargetProject,
  type ClaudeCodeImportedThread,
  type ClaudeCodeSessionSummary,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../Services/ProjectionSnapshotQuery.ts";
import { buildImportEvents } from "./claudeCodeImportEvents.ts";
import { parseTranscript, summarizeTranscript } from "./claudeCodeTranscript.ts";

const IMPORT_SOURCE = "claude-code";
const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_INSTANCE_ID = "claudeCode";
/** Fallback project for sessions whose transcript has no recorded cwd. */
const NO_CWD_WORKSPACE = "Claude Code imports";

/** Effects read the local filesystem; both services are ambient in the server runtime. */
type ImportContext = FileSystem.FileSystem | Path.Path;

export interface ClaudeCodeImportShape {
  readonly discover: Effect.Effect<ClaudeCodeDiscoverResult, ClaudeCodeImportError, ImportContext>;
  readonly planImport: (
    input: ClaudeCodeImportPlanInput,
  ) => Effect.Effect<ClaudeCodeImportPlan, ClaudeCodeImportError, ImportContext>;
  readonly importSessions: (
    input: ClaudeCodeImportInput,
  ) => Effect.Effect<ClaudeCodeImportResult, ClaudeCodeImportError, ImportContext>;
}

function threadIdForSession(sessionId: string): ThreadId {
  return ThreadId.make(`cc-import:${sessionId}`);
}

function projectIdForWorkspace(workspaceRoot: string): ProjectId {
  return ProjectId.make(`cc-import-project:${workspaceRoot}`);
}

function modelSelectionFor(model: string | null): ModelSelection {
  return {
    instanceId: ProviderInstanceId.make(DEFAULT_INSTANCE_ID),
    model: model ?? DEFAULT_MODEL,
  };
}

export function makeClaudeCodeImportService(deps: {
  readonly engine: OrchestrationEngineShape;
  readonly snapshot: ProjectionSnapshotQueryShape;
}): ClaudeCodeImportShape {
  const { engine, snapshot } = deps;

  // List every `.jsonl` transcript under ~/.claude/projects. A missing root or
  // unreadable entries degrade to an empty list rather than failing the scan.
  const listTranscriptFiles = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(NodeOS.homedir(), ".claude", "projects");
    const exists = yield* fs.exists(root).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!exists) return [] as string[];

    const dirNames = yield* fs
      .readDirectory(root)
      .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
    const files: string[] = [];
    for (const name of dirNames) {
      const dir = path.join(root, name);
      const info = yield* fs.stat(dir).pipe(Effect.catch(() => Effect.succeed(null)));
      if (info === null || info.type !== "Directory") continue;
      const entries = yield* fs
        .readDirectory(dir)
        .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
      for (const entry of entries) {
        if (entry.endsWith(".jsonl")) files.push(path.join(dir, entry));
      }
    }
    return files;
  });

  const readText = (filePath: string) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(filePath));

  const basename = (filePath: string) =>
    Effect.map(Path.Path, (path) => path.basename(filePath, ".jsonl"));

  const isAlreadyImported = (sessionId: string | null) =>
    sessionId === null
      ? Effect.succeed(false)
      : snapshot.getThreadShellById(threadIdForSession(sessionId)).pipe(
          Effect.map(Option.isSome),
          Effect.catch(() => Effect.succeed(false)),
        );

  const discover: ClaudeCodeImportShape["discover"] = Effect.gen(function* () {
    const path = yield* Path.Path;
    const files = yield* listTranscriptFiles;
    const summaries: ClaudeCodeSessionSummary[] = [];
    for (const filePath of files) {
      const summary = yield* readText(filePath).pipe(
        Effect.map((text) => summarizeTranscript(text)),
        // Skip unreadable/corrupt files rather than failing the whole scan.
        Effect.catch(() => Effect.succeed(null)),
      );
      if (summary === null) continue;
      // Skip Claude Code internals with no real conversation: SDK title-generation
      // runs and pure slash-command/hook sessions have neither an ai-title nor a
      // real user prompt, so the parser leaves the title null.
      if (summary.title === null) continue;
      const alreadyImported = yield* isAlreadyImported(summary.sessionId);
      summaries.push({
        sessionId: summary.sessionId ?? path.basename(filePath, ".jsonl"),
        filePath,
        cwd: summary.cwd,
        gitBranch: summary.gitBranch,
        title: summary.title,
        model: summary.model,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        firstUserPrompt: summary.firstUserPrompt,
        messageCount: summary.messageCount,
        alreadyImported,
      });
    }
    // Most-recent first.
    summaries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { sessions: summaries };
  });

  const planImport: ClaudeCodeImportShape["planImport"] = (input) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      // Group the selected sessions by cwd; each group becomes one project,
      // matched to an existing project by workspaceRoot or proposed as new.
      interface MutablePlanProject {
        projectId: ProjectId;
        title: string;
        workspaceRoot: string;
        isExisting: boolean;
        sessionCount: number;
      }
      const projectsByRoot = new Map<string, MutablePlanProject>();
      const sessions: ClaudeCodeImportPlanSession[] = [];

      for (const filePath of input.filePaths) {
        const summary = yield* readText(filePath).pipe(
          Effect.map((text) => summarizeTranscript(text)),
          Effect.catch(() => Effect.succeed(null)),
        );
        if (summary === null || summary.title === null) continue;
        const sessionId = summary.sessionId ?? path.basename(filePath, ".jsonl");
        if (yield* isAlreadyImported(sessionId)) continue;

        const workspaceRoot = summary.cwd ?? NO_CWD_WORKSPACE;
        let group = projectsByRoot.get(workspaceRoot);
        if (group === undefined) {
          const existing = yield* snapshot
            .getActiveProjectByWorkspaceRoot(workspaceRoot)
            .pipe(Effect.catch(() => Effect.succeed(Option.none())));
          group = Option.isSome(existing)
            ? {
                projectId: existing.value.id,
                title: existing.value.title,
                workspaceRoot,
                isExisting: true,
                sessionCount: 0,
              }
            : {
                projectId: projectIdForWorkspace(workspaceRoot),
                title: path.basename(workspaceRoot) || workspaceRoot,
                workspaceRoot,
                isExisting: false,
                sessionCount: 0,
              };
          projectsByRoot.set(workspaceRoot, group);
        }
        group.sessionCount += 1;
        sessions.push({
          filePath,
          sessionId,
          title: summary.title,
          cwd: summary.cwd,
          messageCount: summary.messageCount,
          projectId: group.projectId,
        });
      }

      const projects: ClaudeCodeImportPlanProject[] = [...projectsByRoot.values()];
      return { projects, sessions };
    });

  const importOne = (
    assignment: ClaudeCodeImportSessionAssignment,
    projectById: ReadonlyMap<string, ClaudeCodeImportTargetProject>,
    createdProjects: Set<string>,
    ingestedAt: string,
  ): Effect.Effect<ClaudeCodeImportedThread, never, ImportContext> =>
    Effect.gen(function* () {
      const text = yield* readText(assignment.filePath);
      const parsed = parseTranscript(text);
      const sessionId = parsed.sessionId ?? (yield* basename(assignment.filePath));

      const failed = (reason: string): ClaudeCodeImportedThread => ({
        sessionId,
        filePath: assignment.filePath,
        status: "failed",
        threadId: null,
        projectId: null,
        reason,
      });

      if (parsed.items.length === 0) {
        return { ...failed("No conversation messages found."), status: "skipped" as const };
      }

      const target = projectById.get(assignment.projectId);
      if (target === undefined) return failed("Unknown target project.");

      const threadId = threadIdForSession(sessionId);
      const existing = yield* snapshot
        .getThreadShellById(threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isSome(existing)) {
        return {
          sessionId,
          filePath: assignment.filePath,
          status: "skipped" as const,
          threadId,
          projectId: target.projectId,
          reason: "Already imported.",
        };
      }

      // Create each new project exactly once across the batch (on the first of
      // its sessions). Existing projects are assumed to already exist.
      const needCreate = !target.isExisting && !createdProjects.has(target.projectId);
      const events = buildImportEvents({
        parsed,
        projectId: target.projectId,
        threadId,
        project: needCreate
          ? { create: true, title: target.title, workspaceRoot: target.workspaceRoot }
          : { create: false },
        modelSelection: modelSelectionFor(parsed.model),
        importSource: IMPORT_SOURCE,
        importSessionId: sessionId,
        ingestedAt,
      });

      yield* engine.importEvents(events);
      // Mark created only after a successful append (the transaction committed).
      if (needCreate) createdProjects.add(target.projectId);
      return {
        sessionId,
        filePath: assignment.filePath,
        status: "imported" as const,
        threadId,
        projectId: target.projectId,
        reason: null,
      };
    }).pipe(
      // One failed session must not abort the rest of the batch.
      Effect.catch((error) =>
        Effect.gen(function* () {
          const sessionId = yield* basename(assignment.filePath);
          return {
            sessionId,
            filePath: assignment.filePath,
            status: "failed" as const,
            threadId: null,
            projectId: null,
            reason: error instanceof Error ? error.message : String(error),
          } satisfies ClaudeCodeImportedThread;
        }),
      ),
    );

  const importSessions: ClaudeCodeImportShape["importSessions"] = (input) =>
    Effect.gen(function* () {
      const ingestedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
      const projectById = new Map(input.projects.map((project) => [project.projectId, project]));
      const createdProjects = new Set<string>();
      const results: ClaudeCodeImportedThread[] = [];
      // Sequential so a project created for one session is reused by the next.
      for (const assignment of input.sessions) {
        results.push(yield* importOne(assignment, projectById, createdProjects, ingestedAt));
      }
      return { results };
    });

  return { discover, planImport, importSessions };
}
