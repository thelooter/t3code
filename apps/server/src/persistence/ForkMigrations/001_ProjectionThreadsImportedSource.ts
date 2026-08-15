import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds provenance columns for threads imported from an external tool (e.g.
 * Claude Code transcripts). `fork_imported_source` marks the thread as
 * read-only / non-resumable; `fork_imported_session_id` stores the external
 * session id so a future "resume" can reattach a live provider session. Both
 * null for natively created threads.
 *
 * The `fork_` prefix keeps these out of any name upstream might later pick:
 * an upstream `ALTER TABLE ... ADD COLUMN imported_source` against a database
 * that already had the unprefixed column would fail with "duplicate column
 * name" and crash-loop the backend, and that migration lives in upstream's
 * namespace where the fork cannot renumber around it.
 *
 * Databases built before the rename carry the unprefixed names, so adopt them
 * in place rather than adding a second pair and stranding the imported rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("fork_imported_source")) {
    yield* has("imported_source")
      ? sql`ALTER TABLE projection_threads RENAME COLUMN imported_source TO fork_imported_source`
      : sql`ALTER TABLE projection_threads ADD COLUMN fork_imported_source TEXT`;
  }

  if (!has("fork_imported_session_id")) {
    yield* has("imported_session_id")
      ? sql`ALTER TABLE projection_threads RENAME COLUMN imported_session_id TO fork_imported_session_id`
      : sql`ALTER TABLE projection_threads ADD COLUMN fork_imported_session_id TEXT`;
  }
});
