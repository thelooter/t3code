import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import { assertForkSchema, runForkMigrations } from "./ForkMigrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const threadColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  return columns.map((column) => column.name);
});

const inMemory = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

it.layer(NodeServices.layer)("ForkMigrations", (it) => {
  it.effect("creates fork columns on a fresh database", () =>
    inMemory(
      Effect.gen(function* () {
        yield* runMigrations();
        yield* runForkMigrations();

        const columns = yield* threadColumns;
        assert.include(columns, "fork_imported_source");
        assert.include(columns, "fork_imported_session_id");
      }),
    ),
  );

  it.effect("tracks its own high-water mark, independent of upstream's", () =>
    inMemory(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* runForkMigrations();

        const [upstream] = yield* sql<{ n: number }>`
          SELECT MAX(migration_id) AS n FROM effect_sql_migrations`;
        const [fork] = yield* sql<{ n: number }>`
          SELECT MAX(migration_id) AS n FROM fork_sql_migrations`;

        assert.strictEqual(Number(fork?.n), 1);
        assert.isAbove(Number(upstream?.n), 1);
      }),
    ),
  );

  it.effect("is a no-op on a second run", () =>
    inMemory(
      Effect.gen(function* () {
        yield* runMigrations();
        const first = yield* runForkMigrations();
        const second = yield* runForkMigrations();

        assert.strictEqual(first.length, 1);
        assert.strictEqual(second.length, 0);
      }),
    ),
  );

  it.effect("adopts unprefixed columns from a pre-namespace database, keeping data", () =>
    inMemory(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        // Reproduce what an older fork build left behind.
        yield* sql`ALTER TABLE projection_threads ADD COLUMN imported_source TEXT`;
        yield* sql`ALTER TABLE projection_threads ADD COLUMN imported_session_id TEXT`;
        yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
          VALUES ('p1', 'P', '/tmp/p', '[]', '2026-08-01', '2026-08-01', NULL)`;
        yield* sql`INSERT INTO projection_threads
          (thread_id, project_id, title, created_at, updated_at, imported_source, imported_session_id)
          VALUES ('t1', 'p1', 'T', '2026-08-01', '2026-08-01', 'claude-code', 'sess-1')`;

        yield* runForkMigrations();

        const columns = yield* threadColumns;
        assert.include(columns, "fork_imported_source");
        assert.notInclude(columns, "imported_source");

        const [row] = yield* sql<{ source: string; session: string }>`
          SELECT fork_imported_source AS source, fork_imported_session_id AS session
          FROM projection_threads WHERE thread_id = 't1'`;
        assert.strictEqual(row?.source, "claude-code");
        assert.strictEqual(row?.session, "sess-1");
      }),
    ),
  );

  it.effect("restores fork columns dropped by a table rebuild", () =>
    inMemory(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* runForkMigrations();
        // Stand in for an upstream migration that rebuilds the table without
        // knowing about the fork's columns.
        yield* sql`ALTER TABLE projection_threads DROP COLUMN fork_imported_source`;

        const restored = yield* assertForkSchema();

        assert.deepStrictEqual([...restored], ["fork_imported_source"]);
        assert.include(yield* threadColumns, "fork_imported_source");
      }),
    ),
  );

  it.effect("assertForkSchema is a no-op when the schema is intact", () =>
    inMemory(
      Effect.gen(function* () {
        yield* runMigrations();
        yield* runForkMigrations();

        assert.deepStrictEqual([...(yield* assertForkSchema())], []);
      }),
    ),
  );

  it.effect("server boot layer applies both namespaces", () =>
    Effect.gen(function* () {
      const columns = yield* threadColumns;
      assert.include(columns, "fork_imported_source");
      assert.include(columns, "fork_imported_session_id");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
