import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "../src/persistence/Migrations.ts";
import { runForkMigrations } from "../src/persistence/ForkMigrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { runCheckMigrationSlots } from "./check-migration-slots.ts";

const withDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

/** A fully migrated database, i.e. what a healthy install looks like. */
const createMigratedDatabase = Effect.fn("createMigratedDatabase")(function* (baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "state.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      yield* runMigrations();
      yield* runForkMigrations();
    }),
  );
  return databasePath;
});

const highestUpstreamSlot = migrationManifest.reduce(
  (highest, [slot]) => Math.max(highest, slot),
  0,
);

it.layer(NodeServices.layer)("check-migration-slots", (it) => {
  it.effect("reports no issues for a database migrated by this checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "check-slots-ok-" });
      const databasePath = yield* createMigratedDatabase(dir);

      const result = yield* runCheckMigrationSlots({ database: databasePath });

      assert.deepStrictEqual(result.issues, []);
    }),
  );

  it.effect("flags a slot another branch claimed under a different name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "check-slots-collision-" });
      const databasePath = yield* createMigratedDatabase(dir);
      const [slot, codeName] = migrationManifest[0]!;
      // Stand in for a build whose migration at this slot had a different name.
      yield* withDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE effect_sql_migrations SET name = 'SomeOtherBranchMigration' WHERE migration_id = ${slot}`;
        }),
      );

      const result = yield* runCheckMigrationSlots({ database: databasePath });

      assert.deepStrictEqual(result.issues, [
        {
          kind: "collision",
          namespace: "upstream",
          slot,
          codeName,
          appliedName: "SomeOtherBranchMigration",
        },
      ]);
    }),
  );

  it.effect("flags a registered migration the database can no longer reach", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "check-slots-stranded-" });
      const databasePath = yield* createMigratedDatabase(dir);
      const [slot, codeName] = migrationManifest[0]!;
      // Dropping the row leaves the slot below the high-water mark, so the
      // migrator will never revisit it.
      yield* withDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${slot}`;
        }),
      );

      const result = yield* runCheckMigrationSlots({ database: databasePath });

      assert.deepStrictEqual(result.issues, [
        {
          kind: "stranded",
          namespace: "upstream",
          slot,
          codeName,
          highestAppliedSlot: highestUpstreamSlot,
        },
      ]);
    }),
  );

  it.effect("flags an applied id this checkout does not register", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "check-slots-orphan-" });
      const databasePath = yield* createMigratedDatabase(dir);
      // The row a pre-namespace fork build left behind, at an id upstream has
      // not allocated yet. Below the manifest's high-water mark the same row
      // reads as a collision instead, which the collision case already covers.
      const orphanSlot = highestUpstreamSlot + 1;
      yield* withDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${orphanSlot}, 'ProjectionThreadsImportedSource')`;
        }),
      );

      const result = yield* runCheckMigrationSlots({ database: databasePath });

      assert.deepStrictEqual(result.issues, [
        {
          kind: "orphan",
          namespace: "upstream",
          slot: orphanSlot,
          appliedName: "ProjectionThreadsImportedSource",
        },
      ]);
    }),
  );

  it.effect("audits the fork namespace independently of upstream's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "check-slots-fork-" });
      const databasePath = yield* createMigratedDatabase(dir);
      yield* withDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE fork_sql_migrations SET name = 'RenamedByAnotherForkBranch' WHERE migration_id = 1`;
        }),
      );

      const result = yield* runCheckMigrationSlots({ database: databasePath });

      assert.deepStrictEqual(result.issues, [
        {
          kind: "collision",
          namespace: "fork",
          slot: 1,
          codeName: "ProjectionThreadsImportedSource",
          appliedName: "RenamedByAnotherForkBranch",
        },
      ]);
    }),
  );

  it.effect("treats a never-migrated database as sound", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "check-slots-fresh-" });
      const databasePath = path.join(dir, "state.sqlite");
      // Touch a real but empty sqlite file: no bookkeeping tables yet.
      yield* withDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE placeholder (id INTEGER)`;
        }),
      );

      const result = yield* runCheckMigrationSlots({ database: databasePath });

      assert.deepStrictEqual(result.issues, []);
    }),
  );

  it.effect("fails when the database does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "check-slots-missing-" });

      const error = yield* runCheckMigrationSlots({
        database: path.join(dir, "nope.sqlite"),
      }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "CheckMigrationSlotsDatabaseMissingError");
    }),
  );
});
