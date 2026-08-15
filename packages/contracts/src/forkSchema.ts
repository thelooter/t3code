import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Reported when the server had to re-add fork-owned columns that went missing
 * from `projection_threads` -- typically because an upstream migration rebuilt
 * the table and copied only the columns it knew about.
 *
 * The schema is repairable; the data in those columns is not. Boot logs are
 * invisible when the app is launched from a desktop launcher, so this travels
 * to the client as a `ServerConfigIssue` and is surfaced in the UI.
 */
export const ForkSchemaColumnsRestoredIssue = Schema.Struct({
  kind: Schema.Literal("fork-schema.columns-restored"),
  message: TrimmedNonEmptyString,
  columns: ForwardCompatibleArray(TrimmedNonEmptyString),
});
export type ForkSchemaColumnsRestoredIssue = typeof ForkSchemaColumnsRestoredIssue.Type;

/** Prefix used to pick fork schema issues out of `ServerConfig.issues`. */
export const FORK_SCHEMA_ISSUE_PREFIX = "fork-schema.";
