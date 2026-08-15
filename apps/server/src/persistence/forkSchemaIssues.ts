import type { ServerConfigIssue } from "@t3tools/contracts";

import { getForkSchemaRepairs } from "./forkSchemaRepairs.ts";

const formatColumns = (columns: ReadonlyArray<string>): string =>
  columns.length === 1 ? columns[0]! : `${columns.slice(0, -1).join(", ")} and ${columns.at(-1)!}`;

/**
 * Fork schema repairs performed this process, as config issues for the client.
 *
 * Empty in the normal case, so this adds nothing to the config payload unless
 * something actually went wrong.
 */
export const forkSchemaConfigIssues = (): ReadonlyArray<ServerConfigIssue> => {
  const columns = getForkSchemaRepairs();
  if (columns.length === 0) {
    return [];
  }
  return [
    {
      kind: "fork-schema.columns-restored",
      // The columns are back but empty; say that plainly rather than implying
      // the repair was lossless.
      message: `Restored ${formatColumns(columns)} on projection_threads after they went missing. The columns are empty, so provenance for imported threads may have been lost.`,
      columns,
    },
  ];
};
