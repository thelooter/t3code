/**
 * Fork-owned migrations, tracked in their own bookkeeping table.
 *
 * Upstream's migrator gates on a single high-water mark: it runs migrations
 * whose id is greater than MAX(migration_id) in the table, comparing ids only
 * and never names. A fork migration sharing that table therefore has to squat
 * on an id, and every id is one upstream may later claim -- at which point
 * upstream's migration at that id is silently skipped in every database that
 * recorded the fork's, surfacing later as an unrelated "no such column".
 *
 * Pointing the fork's migrations at their own table sidesteps the whole
 * contest: `fork_sql_migrations` carries an independent sequence starting at
 * 1, so upstream can allocate ids forever without ever interacting with it.
 *
 * These run after upstream's migrations complete, so a fork migration always
 * observes the fully migrated upstream schema. The reverse ordering is never
 * needed -- upstream cannot depend on fork state, since it does not know the
 * fork exists. If a fork migration ever genuinely has to precede an upstream
 * one, `runMigrations({ toMigrationInclusive })` can stage upstream's run
 * around it.
 */

import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_ProjectionThreadsImportedSource.ts";
import { recordForkSchemaRepair } from "./forkSchemaRepairs.ts";

/** Deliberately not `effect_sql_migrations`; see the module comment. */
export const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

export const forkMigrationEntries = [
  [1, "ProjectionThreadsImportedSource", ForkMigration0001],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

export const makeForkMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

export interface RunForkMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run pending fork migrations. Returns the [id, name] pairs that ran.
 */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* ({
  toMigrationInclusive,
}: RunForkMigrationsOptions = {}) {
  const executed = yield* run({
    table: FORK_MIGRATIONS_TABLE,
    loader: makeForkMigrationLoader(toMigrationInclusive),
  });
  const migrations = executed.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Fork schema is current")
    : Effect.log("Fork migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executed;
});

/** Columns the fork owns on tables upstream also writes to. */
const FORK_THREAD_COLUMNS = ["fork_imported_source", "fork_imported_session_id"] as const;

/**
 * Re-assert fork columns that an upstream migration may have removed.
 *
 * Migrations run once, so a fork migration cannot repair damage that lands
 * after it was recorded. Upstream occasionally rebuilds a table rather than
 * altering it -- 031_AuthAuthorizationScopes drops and recreates the auth
 * tables -- and a rebuild copies only the columns upstream knows about,
 * dropping the fork's silently and with no error. Today no upstream migration
 * rebuilds `projection_threads`, so this is a guard rather than a fix; it
 * costs one PRAGMA per boot and turns a silent data loss into a logged repair.
 */
export const assertForkSchema = Effect.fn("assertForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const missing = FORK_THREAD_COLUMNS.filter(
    (column) => !columns.some((existing) => existing.name === column),
  );
  if (missing.length === 0) {
    return missing;
  }
  // Re-adding restores the schema but not the data: whatever dropped these
  // columns took their contents with it, so say so loudly rather than
  // silently presenting emptied imports as intact.
  yield* Effect.logWarning("Restored fork columns dropped from projection_threads").pipe(
    Effect.annotateLogs({ columns: missing }),
  );
  for (const column of missing) {
    yield* sql.unsafe(`ALTER TABLE projection_threads ADD COLUMN ${column} TEXT`).unprepared;
  }
  // A boot log is invisible when the app is launched from a desktop launcher,
  // so hand this to the config surface for the UI to report as well.
  recordForkSchemaRepair(missing);
  return missing;
});
