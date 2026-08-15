#!/usr/bin/env node

/**
 * Audit an existing T3 database against this checkout's migration registries.
 *
 * The migrator only runs migrations whose id is above the highest id already
 * recorded in its bookkeeping table, and it compares ids only -- never names.
 * So a migration that squats on an id another branch later claims does not
 * conflict loudly; it makes that branch's migration disappear, and the failure
 * only surfaces later as `no such column: ...` when a query hits the column
 * that was never added.
 *
 * `migrate-dev-db` already guards the dev-worktree database this way, but it
 * only ever inspects the database it just cloned. Long-lived databases -- a
 * packaged desktop build's state, a sandbox home, `~/.t3` itself -- are the
 * ones that actually carry a stale id from an older build, so point this at
 * them directly before shipping a build:
 *
 *   node apps/server/scripts/check-migration-slots.ts --database <path>
 *
 * Both namespaces are audited: upstream's `effect_sql_migrations` and the
 * fork's `fork_sql_migrations` (see src/persistence/ForkMigrations.ts).
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
import { FORK_MIGRATIONS_TABLE, forkMigrationManifest } from "../src/persistence/ForkMigrations.ts";
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
    return `${this.issueCount} migration slot issue(s) in '${this.databasePath}'. Migrations listed above cannot run against this database; renumber them above the highest applied id, or drop the stale rows.`;
  }
}

export interface MigrationNamespace {
  readonly label: string;
  readonly table: string;
  readonly manifest: ReadonlyArray<readonly [number, string]>;
}

export const MIGRATION_NAMESPACES: ReadonlyArray<MigrationNamespace> = [
  { label: "upstream", table: "effect_sql_migrations", manifest: migrationManifest },
  { label: "fork", table: FORK_MIGRATIONS_TABLE, manifest: forkMigrationManifest },
];

/**
 * `collision` -- the slot was applied under a different name, so this
 * checkout's migration for that slot never ran and never will.
 *
 * `stranded` -- this checkout registers a migration the database never
 * applied, but its id sits at or below the highest applied id, so the
 * migrator will skip it forever.
 *
 * `orphan` -- the database applied an id this checkout does not register.
 * Harmless on its own, but it still counts toward the high-water mark, so it
 * can block a migration this checkout adds at that id later.
 */
export type MigrationSlotIssue =
  | {
      readonly kind: "collision";
      readonly namespace: string;
      readonly slot: number;
      readonly codeName: string;
      readonly appliedName: string;
    }
  | {
      readonly kind: "stranded";
      readonly namespace: string;
      readonly slot: number;
      readonly codeName: string;
      readonly highestAppliedSlot: number;
    }
  | {
      readonly kind: "orphan";
      readonly namespace: string;
      readonly slot: number;
      readonly appliedName: string;
    };

export const formatMigrationSlotIssue = (issue: MigrationSlotIssue): string => {
  const at = `  [${issue.namespace}] slot ${issue.slot}`;
  switch (issue.kind) {
    case "collision":
      return `${at}: code registers '${issue.codeName}' but the database applied '${issue.appliedName}' — '${issue.codeName}' was skipped.`;
    case "stranded":
      return `${at}: code registers '${issue.codeName}', never applied, and the database is already at ${issue.highestAppliedSlot} — it will never run.`;
    case "orphan":
      return `${at}: the database applied '${issue.appliedName}', which this checkout does not register — it holds the high-water mark at or above ${issue.slot}.`;
  }
};

/**
 * Compare one namespace's registry against what the database recorded.
 */
export const auditNamespace = Effect.fn("auditNamespace")(function* (
  namespace: MigrationNamespace,
) {
  const sql = yield* SqlClient.SqlClient;

  // A namespace that has never run has no bookkeeping table yet, and applies
  // its whole registry in order -- nothing can be stranded or orphaned.
  const bookkeeping = yield* sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${namespace.table}`;
  if (bookkeeping.length === 0) {
    return [] as ReadonlyArray<MigrationSlotIssue>;
  }

  const applied = yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM ${sql(namespace.table)}`;
  const appliedById = new Map(applied.map((row) => [Number(row.migration_id), row.name]));
  const highestAppliedSlot = applied.reduce(
    (highest, row) => Math.max(highest, Number(row.migration_id)),
    0,
  );
  const registeredIds = new Set(namespace.manifest.map(([slot]) => slot));

  const issues: Array<MigrationSlotIssue> = [];
  for (const [slot, codeName] of namespace.manifest) {
    const appliedName = appliedById.get(slot);
    if (appliedName === undefined) {
      if (slot <= highestAppliedSlot) {
        issues.push({
          kind: "stranded",
          namespace: namespace.label,
          slot,
          codeName,
          highestAppliedSlot,
        });
      }
      continue;
    }
    if (appliedName !== codeName) {
      issues.push({
        kind: "collision",
        namespace: namespace.label,
        slot,
        codeName,
        appliedName,
      });
    }
  }
  for (const [slot, appliedName] of appliedById) {
    if (!registeredIds.has(slot)) {
      issues.push({ kind: "orphan", namespace: namespace.label, slot, appliedName });
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

  const issues = yield* Effect.gen(function* () {
    const collected: Array<MigrationSlotIssue> = [];
    for (const namespace of MIGRATION_NAMESPACES) {
      collected.push(...(yield* auditNamespace(namespace)));
    }
    return collected as ReadonlyArray<MigrationSlotIssue>;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })));

  return { databasePath, issues };
});

const registeredCount = MIGRATION_NAMESPACES.reduce(
  (total, namespace) => total + namespace.manifest.length,
  0,
);

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
          `Migration slots OK: ${databasePath} agrees with all ${registeredCount} registered migrations across ${MIGRATION_NAMESPACES.length} namespaces.`,
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
    "Audit a database's applied migrations against this checkout's registries and fail on any that can no longer run.",
  ),
);

if (import.meta.main) {
  Command.run(checkMigrationSlotsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
