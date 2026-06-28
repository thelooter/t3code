/**
 * Discovers and imports Claude Code conversation transcripts.
 *
 * Discovery scans `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Import
 * parses each selected transcript, resolves (or creates) a project for its cwd,
 * and synthesizes historical orchestration events that are appended through the
 * engine — so the import replays cleanly on a read-model rebuild. Imported
 * threads are marked read-only / non-resumable via `importedSource`.
 */
import {
  type ClaudeCodeDiscoverResult,
  ClaudeCodeImportError,
  type ClaudeCodeImportInput,
  type ClaudeCodeImportResult,
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

/** Effects read the local filesystem; both services are ambient in the server runtime. */
type ImportContext = FileSystem.FileSystem | Path.Path;

export interface ClaudeCodeImportShape {
  readonly discover: Effect.Effect<ClaudeCodeDiscoverResult, ClaudeCodeImportError, ImportContext>;
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

/**
 * Build the import service from already-resolved engine and snapshot-query
 * instances. A plain factory (not an Effect layer) so the WebSocket handler can
 * construct it from services it has already acquired; the filesystem services it
 * needs are taken from the ambient context when the effects run.
 */
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

  const importOne = (
    filePath: string,
    ingestedAt: string,
  ): Effect.Effect<ClaudeCodeImportedThread, never, ImportContext> =>
    Effect.gen(function* () {
      const text = yield* readText(filePath);
      const parsed = parseTranscript(text);
      const sessionId = parsed.sessionId ?? (yield* basename(filePath));

      if (parsed.items.length === 0) {
        return {
          sessionId,
          filePath,
          status: "skipped" as const,
          threadId: null,
          projectId: null,
          reason: "No conversation messages found.",
        };
      }

      const threadId = threadIdForSession(sessionId);
      const existing = yield* snapshot
        .getThreadShellById(threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isSome(existing)) {
        return {
          sessionId,
          filePath,
          status: "skipped" as const,
          threadId,
          projectId: null,
          reason: "Already imported.",
        };
      }

      const workspaceRoot = parsed.cwd ?? "Claude Code imports";
      const existingProject = yield* snapshot
        .getActiveProjectByWorkspaceRoot(workspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      const projectId = Option.isSome(existingProject)
        ? existingProject.value.id
        : projectIdForWorkspace(workspaceRoot);
      const path = yield* Path.Path;

      const events = buildImportEvents({
        parsed,
        projectId,
        threadId,
        project: Option.isSome(existingProject)
          ? { create: false }
          : { create: true, title: path.basename(workspaceRoot) || workspaceRoot, workspaceRoot },
        modelSelection: modelSelectionFor(parsed.model),
        importSource: IMPORT_SOURCE,
        importSessionId: sessionId,
        ingestedAt,
      });

      yield* engine.importEvents(events);
      return {
        sessionId,
        filePath,
        status: "imported" as const,
        threadId,
        projectId,
        reason: null,
      };
    }).pipe(
      // One failed session must not abort the rest of the batch.
      Effect.catch((error) =>
        Effect.gen(function* () {
          const sessionId = yield* basename(filePath);
          return {
            sessionId,
            filePath,
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
      const results: ClaudeCodeImportedThread[] = [];
      // Sequential: lets a project created for one session be reused by the next.
      for (const filePath of input.filePaths) {
        results.push(yield* importOne(filePath, ingestedAt));
      }
      return { results };
    });

  return { discover, importSessions };
}
