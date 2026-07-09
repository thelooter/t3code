import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds provenance columns for threads imported from an external tool (e.g.
 * Claude Code transcripts). `imported_source` marks the thread as read-only /
 * non-resumable; `imported_session_id` stores the external session id so a
 * future "resume" can reattach a live provider session. Both null for natively
 * created threads.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "imported_source")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN imported_source TEXT
    `;
  }

  if (!columns.some((column) => column.name === "imported_session_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN imported_session_id TEXT
    `;
  }
});
