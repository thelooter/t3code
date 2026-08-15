import { describe, expect, it } from "vite-plus/test";

import type { ServerConfigIssue } from "@t3tools/contracts";

import {
  selectForkSchemaRepairNotice,
  shouldShowForkSchemaBanner,
} from "./ForkSchemaRepairBanner.logic";

const repairIssue = (columns: ReadonlyArray<string>): ServerConfigIssue =>
  ({
    kind: "fork-schema.columns-restored",
    message: "Restored columns.",
    columns,
  }) as ServerConfigIssue;

const keybindingsIssue: ServerConfigIssue = {
  kind: "keybindings.malformed-config",
  message: "bad json",
} as ServerConfigIssue;

describe("selectForkSchemaRepairNotice", () => {
  it("returns null when there are no issues", () => {
    expect(selectForkSchemaRepairNotice(undefined)).toBeNull();
    expect(selectForkSchemaRepairNotice([])).toBeNull();
  });

  it("ignores issues from other subsystems", () => {
    expect(selectForkSchemaRepairNotice([keybindingsIssue])).toBeNull();
  });

  it("picks the fork schema repair out of a mixed list", () => {
    const notice = selectForkSchemaRepairNotice([
      keybindingsIssue,
      repairIssue(["fork_imported_source"]),
    ]);

    expect(notice?.message).toBe("Restored columns.");
    expect(notice?.signature).toBe("fork-schema.columns-restored:fork_imported_source");
  });

  it("builds a column-order-independent signature", () => {
    const a = selectForkSchemaRepairNotice([repairIssue(["b_col", "a_col"])]);
    const b = selectForkSchemaRepairNotice([repairIssue(["a_col", "b_col"])]);

    expect(a?.signature).toBe(b?.signature);
  });
});

describe("shouldShowForkSchemaBanner", () => {
  const notice = selectForkSchemaRepairNotice([repairIssue(["fork_imported_source"])]);

  it("hides when nothing was repaired", () => {
    expect(shouldShowForkSchemaBanner({ notice: null, dismissedSignature: null })).toBe(false);
  });

  it("shows an undismissed repair", () => {
    expect(shouldShowForkSchemaBanner({ notice, dismissedSignature: null })).toBe(true);
  });

  it("hides a repair that was dismissed", () => {
    expect(shouldShowForkSchemaBanner({ notice, dismissedSignature: notice!.signature })).toBe(
      false,
    );
  });

  it("shows again when a later repair touches different columns", () => {
    const later = selectForkSchemaRepairNotice([repairIssue(["fork_imported_session_id"])]);

    expect(
      shouldShowForkSchemaBanner({ notice: later, dismissedSignature: notice!.signature }),
    ).toBe(true);
  });
});
