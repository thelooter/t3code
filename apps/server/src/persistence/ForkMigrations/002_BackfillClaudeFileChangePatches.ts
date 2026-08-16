import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { buildFileChangePatch } from "../../provider/Layers/fileChangePatch.ts";

/**
 * Recovers file-edit diffs for activities recorded before the adapter started
 * keeping them.
 *
 * Claude sessions driven through the SDK still leave CLI transcripts under
 * `~/.claude/projects/<slug>/<session>.jsonl`, and those carry the
 * `structuredPatch` the adapter used to discard. Our own payloads keep
 * `data.result.tool_use_id`, which appears verbatim in the transcript's
 * `tool_result` block, so the two join exactly with no heuristics. Measured on
 * one real database, 91.7% of historical file changes were recoverable.
 *
 * Deliberately best-effort: it recovers whatever is still on *this* disk. A
 * fresh machine has no transcripts and gets nothing, transcripts age out, and
 * neither is an error — every step below degrades to "backfill fewer rows"
 * rather than failing, because a migration that throws blocks the boot.
 *
 * Patch synthesis is shared with the live path (`buildFileChangePatch`) on
 * purpose: a backfilled row and a freshly captured one must come out
 * byte-identical, or the same edit would render differently depending on when
 * it happened.
 */

/** Only transcript lines mentioning a tool result can contribute. */
const TOOL_RESULT_MARKER = '"toolUseResult"';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The tool_use_id a transcript line's result belongs to, if any. */
function readToolUseId(entry: Record<string, unknown>): string | undefined {
  const content = asRecord(entry.message)?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "tool_result" && typeof record.tool_use_id === "string") {
      return record.tool_use_id;
    }
  }
  return undefined;
}

/** Writes `data.fileChange` into a stored payload, leaving everything else alone. */
function withFileChange(payloadJson: string, fileChange: unknown): string | undefined {
  const payload = parseJsonRecord(payloadJson);
  const data = asRecord(payload?.data);
  if (!payload || !data) {
    return undefined;
  }
  return JSON.stringify({ ...payload, data: { ...data, fileChange } });
}

/** Same, for the `{threadId, activity}` envelope stored in the event log. */
function withFileChangeInEvent(payloadJson: string, fileChange: unknown): string | undefined {
  const envelope = parseJsonRecord(payloadJson);
  const activity = asRecord(envelope?.activity);
  const payload = asRecord(activity?.payload);
  const data = asRecord(payload?.data);
  if (!envelope || !activity || !payload || !data) {
    return undefined;
  }
  return JSON.stringify({
    ...envelope,
    activity: { ...activity, payload: { ...payload, data: { ...data, fileChange } } },
  });
}

/**
 * Every `.jsonl` transcript under ~/.claude/projects. A missing root or an
 * unreadable entry degrades to fewer files rather than failing.
 */
const listTranscriptFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(NodeOS.homedir(), ".claude", "projects");
  const exists = yield* fs.exists(root).pipe(Effect.catch(() => Effect.succeed(false)));
  if (!exists) {
    return [] as string[];
  }

  const dirNames = yield* fs
    .readDirectory(root)
    .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
  const files: string[] = [];
  for (const name of dirNames) {
    const dir = path.join(root, name);
    const info = yield* fs.stat(dir).pipe(Effect.catch(() => Effect.succeed(null)));
    if (info === null || info.type !== "Directory") {
      continue;
    }
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) {
        files.push(path.join(dir, entry));
      }
    }
  }
  return files;
});

const backfill = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;

  // Only rows missing a diff that still carry an id to join on.
  const candidates = yield* sql<{
    readonly activity_id: string;
    readonly tool_use_id: string;
  }>`
    SELECT activity_id, json_extract(payload_json, '$.data.result.tool_use_id') AS tool_use_id
    FROM projection_thread_activities
    WHERE kind = 'tool.completed'
      AND json_extract(payload_json, '$.itemType') = 'file_change'
      AND json_extract(payload_json, '$.data.fileChange') IS NULL
      AND json_extract(payload_json, '$.data.result.tool_use_id') IS NOT NULL
  `;
  if (candidates.length === 0) {
    return;
  }

  const wanted = new Map<string, string[]>();
  for (const row of candidates) {
    const existing = wanted.get(row.tool_use_id);
    if (existing) {
      existing.push(row.activity_id);
    } else {
      wanted.set(row.tool_use_id, [row.activity_id]);
    }
  }

  // activityId -> the diff recovered for it.
  const recovered = new Map<string, unknown>();
  let matchedResults = 0;
  const files = yield* listTranscriptFiles.pipe(
    Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
  );

  for (const file of files) {
    if (matchedResults === wanted.size) {
      break;
    }
    const text = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
    if (!text.includes(TOOL_RESULT_MARKER)) {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes(TOOL_RESULT_MARKER)) {
        continue;
      }
      const entry = parseJsonRecord(line);
      if (!entry) {
        continue;
      }
      const toolUseId = readToolUseId(entry);
      const activityIds = toolUseId ? wanted.get(toolUseId) : undefined;
      if (!toolUseId || !activityIds || recovered.has(activityIds[0]!)) {
        continue;
      }
      const fileChange = buildFileChangePatch(
        asRecord(entry.toolUseResult),
        typeof entry.cwd === "string" ? entry.cwd : undefined,
      );
      if (!fileChange) {
        continue;
      }
      matchedResults += 1;
      for (const activityId of activityIds) {
        recovered.set(activityId, fileChange);
      }
    }
  }

  if (recovered.size === 0) {
    yield* Effect.logDebug("No historical file-change diffs were recoverable").pipe(
      Effect.annotateLogs({ candidates: candidates.length, transcripts: files.length }),
    );
    return;
  }

  let patchedActivities = 0;
  for (const [activityId, fileChange] of recovered) {
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM projection_thread_activities WHERE activity_id = ${activityId}
    `;
    const next = rows[0] ? withFileChange(rows[0].payload_json, fileChange) : undefined;
    if (!next) {
      continue;
    }
    yield* sql`
      UPDATE projection_thread_activities
      SET payload_json = ${next}
      WHERE activity_id = ${activityId}
    `;
    patchedActivities += 1;
  }

  // The event log is the source of truth: a projection later rebuilt from
  // events that still lack the diff would silently undo the backfill.
  let patchedEvents = 0;
  const events = yield* sql<{
    readonly event_id: string;
    readonly activity_id: string | null;
    readonly payload_json: string;
  }>`
    SELECT event_id, json_extract(payload_json, '$.activity.id') AS activity_id, payload_json
    FROM orchestration_events
    WHERE event_type = 'thread.activity-appended'
      AND json_extract(payload_json, '$.activity.payload.itemType') = 'file_change'
      AND json_extract(payload_json, '$.activity.payload.data.fileChange') IS NULL
  `;
  for (const event of events) {
    const fileChange = event.activity_id ? recovered.get(event.activity_id) : undefined;
    if (fileChange === undefined) {
      continue;
    }
    const next = withFileChangeInEvent(event.payload_json, fileChange);
    if (!next) {
      continue;
    }
    yield* sql`
      UPDATE orchestration_events SET payload_json = ${next} WHERE event_id = ${event.event_id}
    `;
    patchedEvents += 1;
  }

  yield* Effect.log("Backfilled file-edit diffs from Claude transcripts").pipe(
    Effect.annotateLogs({
      candidates: candidates.length,
      recovered: recovered.size,
      patchedActivities,
      patchedEvents,
    }),
  );
});

/**
 * The migrator supplies only SqlClient, so the filesystem services this needs
 * are provided here rather than widening every other migration's context.
 */
export default backfill.pipe(Effect.provide(NodeServices.layer));
