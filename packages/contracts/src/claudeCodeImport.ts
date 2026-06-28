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

export const ClaudeCodeImportInput = Schema.Struct({
  /** Absolute transcript paths to import (from a prior discover call). */
  filePaths: Schema.Array(Schema.String),
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
