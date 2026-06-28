/**
 * Wire schemas for importing Claude Code conversation transcripts.
 *
 * Discovery scans the local `~/.claude/projects` store and returns a pickable
 * list of sessions; import synthesizes historical orchestration events for the
 * selected sessions. Imported threads are read-only / non-resumable for now.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Summary of a discovered Claude Code session, used to populate the picker. */
export const ClaudeCodeSessionSummary = Schema.Struct({
  sessionId: Schema.String,
  /** Absolute path to the session's `.jsonl` transcript. */
  filePath: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  gitBranch: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  firstUserPrompt: Schema.NullOr(Schema.String),
  messageCount: NonNegativeInt,
  /** True when a thread for this session has already been imported. */
  alreadyImported: Schema.Boolean,
});
export type ClaudeCodeSessionSummary = typeof ClaudeCodeSessionSummary.Type;

export const ClaudeCodeDiscoverResult = Schema.Struct({
  sessions: Schema.Array(ClaudeCodeSessionSummary),
});
export type ClaudeCodeDiscoverResult = typeof ClaudeCodeDiscoverResult.Type;

// --- Plan (preview) ---------------------------------------------------------
// Import is a two-step flow: `planImport` previews how the selected sessions map
// to projects (matched existing ones + proposed new ones, all editable), then
// `import` applies the user-confirmed mapping.

export const ClaudeCodeImportPlanInput = Schema.Struct({
  /** Absolute transcript paths to plan (from a prior discover call). */
  filePaths: Schema.Array(Schema.String),
});
export type ClaudeCodeImportPlanInput = typeof ClaudeCodeImportPlanInput.Type;

/** A target project in the plan: either an existing match or a proposed new one. */
export const ClaudeCodeImportPlanProject = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  /** True = an existing project matched by workspaceRoot; false = will be created. */
  isExisting: Schema.Boolean,
  sessionCount: NonNegativeInt,
});
export type ClaudeCodeImportPlanProject = typeof ClaudeCodeImportPlanProject.Type;

export const ClaudeCodeImportPlanSession = Schema.Struct({
  filePath: Schema.String,
  sessionId: Schema.String,
  title: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  messageCount: NonNegativeInt,
  /** Target project; references a `ClaudeCodeImportPlanProject.projectId`. */
  projectId: ProjectId,
});
export type ClaudeCodeImportPlanSession = typeof ClaudeCodeImportPlanSession.Type;

export const ClaudeCodeImportPlan = Schema.Struct({
  projects: Schema.Array(ClaudeCodeImportPlanProject),
  sessions: Schema.Array(ClaudeCodeImportPlanSession),
});
export type ClaudeCodeImportPlan = typeof ClaudeCodeImportPlan.Type;

// --- Apply (the user-confirmed mapping) -------------------------------------

/** A target project to import into; `isExisting: false` ones are created on apply. */
export const ClaudeCodeImportTargetProject = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: Schema.String,
  isExisting: Schema.Boolean,
});
export type ClaudeCodeImportTargetProject = typeof ClaudeCodeImportTargetProject.Type;

export const ClaudeCodeImportSessionAssignment = Schema.Struct({
  filePath: Schema.String,
  /** Target project; references a `ClaudeCodeImportTargetProject.projectId`. */
  projectId: ProjectId,
});
export type ClaudeCodeImportSessionAssignment = typeof ClaudeCodeImportSessionAssignment.Type;

export const ClaudeCodeImportInput = Schema.Struct({
  projects: Schema.Array(ClaudeCodeImportTargetProject),
  sessions: Schema.Array(ClaudeCodeImportSessionAssignment),
});
export type ClaudeCodeImportInput = typeof ClaudeCodeImportInput.Type;

export const ClaudeCodeImportStatus = Schema.Literals(["imported", "skipped", "failed"]);
export type ClaudeCodeImportStatus = typeof ClaudeCodeImportStatus.Type;

export const ClaudeCodeImportedThread = Schema.Struct({
  sessionId: Schema.String,
  filePath: Schema.String,
  status: ClaudeCodeImportStatus,
  threadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(ProjectId),
  /** Human-readable detail for skipped/failed sessions. */
  reason: Schema.NullOr(Schema.String),
});
export type ClaudeCodeImportedThread = typeof ClaudeCodeImportedThread.Type;

export const ClaudeCodeImportResult = Schema.Struct({
  results: Schema.Array(ClaudeCodeImportedThread),
});
export type ClaudeCodeImportResult = typeof ClaudeCodeImportResult.Type;

export class ClaudeCodeImportError extends Schema.TaggedErrorClass<ClaudeCodeImportError>()(
  "ClaudeCodeImportError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
