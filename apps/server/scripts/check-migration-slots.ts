#!/usr/bin/env node

/**
 * Audit an existing T3 database against this checkout's migration registry.
 *
 * The migrator only runs migrations whose id is above the highest id already
 * recorded in `effect_sql_migrations`, and it compares ids only — never names.
 * So a migration that squats on an id upstream later claims does not conflict
 * loudly; it makes upstream's migration at that id disappear, and the failure
 * only surfaces later as `no such column: ...` when a query hits the column
 * that was never added.
 *
 * `migrate-dev-db` already guards the dev-worktree database this way, but it
 * only ever inspects the database it just cloned. Long-lived databases — a
 * packaged desktop build's state, a sandbox home, `~/.t3` itself — are the
 * ones that actually carry a stale id from an older build, so point this at
 * them directly before shipping a build:
 *
 *   node apps/server/scripts/check-migration-slots.ts --database <path>
 *
 * Read-only: it opens the database without writing and never migrates.
 */

// @effect-diagnostics nodeBuiltinImport:off - node:os resolves the default T3 home.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Command, Flag } from "effect/unstable/cli";

import { migrationManifest } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";

export class CheckMigrationSlotsDatabaseMissingError extends Schema.TaggedErrorClass<CheckMigrationSlotsDatabaseMissingError>()(
  "CheckMigrationSlotsDatabaseMissingError",
  {
    databasePath: Schema.String,
  },
) {
  override get message(): string {
    return `No database at '${this.databasePath}'. Pass --database to point at one.`;
  }
}

export class CheckMigrationSlotsFailedError extends Schema.TaggedErrorClass<CheckMigrationSlotsFailedError>()(
  "CheckMigrationSlotsFailedError",
  {
    databasePath: Schema.String,
    issueCount: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.issueCount} migration slot issue(s) in '${this.databasePath}'. This database would silently skip the migrations listed above; renumber them above the highest applied id.`;
  }
}

/**
 * `collision` — the slot was applied under a different name, so this
 * checkout's migration for that slot never ran and never will.
 *
 * `stranded` — this checkout registers a migration the database never
 * applied, but its id sits at or below the highest applied id, so the
 * migrator will skip it forever.
 */
export type MigrationSlotIssue =
  | {
      readonly kind: "collision";
      readonly slot: number;
      readonly codeName: string;
      readonly appliedName: string;
    }
  | {
      readonly kind: "stranded";
      readonly slot: number;
      readonly codeName: string;
      readonly highestAppliedSlot: number;
    };

export const formatMigrationSlotIssue = (issue: MigrationSlotIssue): string =>
  issue.kind === "collision"
    ? `  slot ${issue.slot}: code registers '${issue.codeName}' but the database applied '${issue.appliedName}' — '${issue.codeName}' was skipped.`
    : `  slot ${issue.slot}: code registers '${issue.codeName}', never applied, and the database is already at ${issue.highestAppliedSlot} — it will never run.`;

/**
 * Compare the registry against what the database recorded. Returns every
 * migration this database can no longer apply.
 */
export const auditMigrationSlots = Effect.fn("auditMigrationSlots")(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A database that has never been migrated has no bookkeeping table yet, and
  // applies the whole registry in order — nothing can be stranded.
  const bookkeeping = yield* sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
  if (bookkeeping.length === 0) {
    return [] as ReadonlyArray<MigrationSlotIssue>;
  }

  const applied = yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations`;
  const appliedById = new Map(applied.map((row) => [Number(row.migration_id), row.name]));
  const highestAppliedSlot = applied.reduce(
    (highest, row) => Math.max(highest, Number(row.migration_id)),
    0,
  );

  const issues: Array<MigrationSlotIssue> = [];
  for (const [slot, codeName] of migrationManifest) {
    const appliedName = appliedById.get(slot);
    if (appliedName === undefined) {
      if (slot <= highestAppliedSlot) {
        issues.push({ kind: "stranded", slot, codeName, highestAppliedSlot });
      }
      continue;
    }
    if (appliedName !== codeName) {
      issues.push({ kind: "collision", slot, codeName, appliedName });
    }
  }
  return issues as ReadonlyArray<MigrationSlotIssue>;
});

export interface CheckMigrationSlotsInput {
  /** Database to audit. Defaults to `~/.t3/userdata/state.sqlite`. */
  readonly database?: string | undefined;
}

export const runCheckMigrationSlots = Effect.fn("runCheckMigrationSlots")(function* (
  input: CheckMigrationSlotsInput = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const databasePath = path.resolve(
    input.database ?? path.join(NodeOS.homedir(), ".t3", "userdata", "state.sqlite"),
  );
  if (!(yield* fs.exists(databasePath))) {
    return yield* new CheckMigrationSlotsDatabaseMissingError({ databasePath });
  }

  const issues = yield* auditMigrationSlots().pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })),
  );
  return { databasePath, issues };
});

export const checkMigrationSlotsCommand = Command.make(
  "check-migration-slots",
  {
    database: Flag.string("database").pipe(
      Flag.optional,
      Flag.withDescription("Database to audit. Defaults to ~/.t3/userdata/state.sqlite."),
    ),
  },
  ({ database }) =>
    Effect.gen(function* () {
      const { databasePath, issues } = yield* runCheckMigrationSlots({
        database: Option.getOrUndefined(database),
      });
      if (issues.length === 0) {
        yield* Console.log(
          `Migration slots OK: ${databasePath} agrees with all ${migrationManifest.length} registered migrations.`,
        );
        return;
      }
      yield* Console.error(`Migration slot issues in ${databasePath}:`);
      for (const issue of issues) {
        yield* Console.error(formatMigrationSlotIssue(issue));
      }
      return yield* new CheckMigrationSlotsFailedError({
        databasePath,
        issueCount: issues.length,
      });
    }),
).pipe(
  Command.withDescription(
    "Audit a database's applied migrations against this checkout's registry and fail on any that can no longer run.",
  ),
);

if (import.meta.main) {
  Command.run(checkMigrationSlotsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
