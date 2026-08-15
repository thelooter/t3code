import { afterEach, describe, expect, it } from "vite-plus/test";

import { forkSchemaConfigIssues } from "./forkSchemaIssues.ts";
import { recordForkSchemaRepair, resetForkSchemaRepairs } from "./forkSchemaRepairs.ts";

afterEach(() => {
  resetForkSchemaRepairs();
});

describe("forkSchemaConfigIssues", () => {
  it("reports nothing when no repair happened", () => {
    expect(forkSchemaConfigIssues()).toEqual([]);
  });

  it("reports a repaired column, saying the data may be lost", () => {
    recordForkSchemaRepair(["fork_imported_source"]);

    const [issue] = forkSchemaConfigIssues();

    expect(issue?.kind).toBe("fork-schema.columns-restored");
    expect(issue?.message).toContain("fork_imported_source");
    expect(issue?.message).toContain("may have been lost");
  });

  it("lists several columns readably", () => {
    recordForkSchemaRepair(["fork_imported_source", "fork_imported_session_id"]);

    const [issue] = forkSchemaConfigIssues();

    expect(issue?.message).toContain("fork_imported_session_id and fork_imported_source");
  });

  it("collapses repeated reports of the same column", () => {
    recordForkSchemaRepair(["fork_imported_source"]);
    recordForkSchemaRepair(["fork_imported_source"]);

    const [issue] = forkSchemaConfigIssues();

    expect(issue && "columns" in issue ? issue.columns : []).toEqual(["fork_imported_source"]);
  });
});
