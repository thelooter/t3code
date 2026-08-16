import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildFileChangePatch,
  classifyFileChangeError,
  FILE_CHANGE_PATCH_MAX_BYTES,
  toPatchPath,
} from "./fileChangePatch.ts";

const WORKSPACE = "/home/dev/project";

/** Shape of a real `tool_use_result` from the Edit tool, trimmed to what we read. */
function editResult(hunks: unknown, filePath = `${WORKSPACE}/src/app.ts`) {
  return { filePath, oldString: "old", newString: "new", structuredPatch: hunks };
}

describe("toPatchPath", () => {
  it("makes an absolute path workspace-relative", () => {
    NodeAssert.equal(toPatchPath(`${WORKSPACE}/src/app.ts`, WORKSPACE), "src/app.ts");
  });

  it("tolerates a trailing slash on the workspace root", () => {
    NodeAssert.equal(toPatchPath(`${WORKSPACE}/src/app.ts`, `${WORKSPACE}/`), "src/app.ts");
  });

  it("drops the leading slash for paths outside the workspace", () => {
    NodeAssert.equal(toPatchPath("/etc/hosts", WORKSPACE), "etc/hosts");
  });

  it("leaves a path alone when no workspace root is known", () => {
    NodeAssert.equal(toPatchPath("src/app.ts", undefined), "src/app.ts");
  });
});

describe("buildFileChangePatch", () => {
  it("renders a single hunk with counts taken from the line prefixes", () => {
    const change = buildFileChangePatch(
      editResult([
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [" line one", "-line two", "+line TWO", " line three"],
        },
      ]),
      WORKSPACE,
    );

    NodeAssert.ok(change);
    NodeAssert.equal(change.additions, 1);
    NodeAssert.equal(change.deletions, 1);
    NodeAssert.equal(
      change.patch,
      [
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,3 +1,3 @@",
        " line one",
        "-line two",
        "+line TWO",
        " line three",
        "",
      ].join("\n"),
    );
  });

  it("emits one @@ header per hunk for a multi-hunk edit", () => {
    const change = buildFileChangePatch(
      editResult([
        { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+B", " c"] },
        { oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [" x", "+Y", " y", " z"] },
      ]),
      WORKSPACE,
    );

    NodeAssert.ok(change);
    const headers = change.patch.split("\n").filter((line) => line.startsWith("@@"));
    NodeAssert.deepEqual(headers, ["@@ -1,3 +1,3 @@", "@@ -10,3 +10,4 @@"]);
    NodeAssert.equal(change.additions, 2);
    NodeAssert.equal(change.deletions, 1);
  });

  it("counts additions and deletions across every hunk, not just the first", () => {
    const hunks = Array.from({ length: 19 }, (_unused, index) => ({
      oldStart: index * 10 + 1,
      oldLines: 2,
      newStart: index * 10 + 1,
      newLines: 2,
      lines: [`-old ${index}`, `+new ${index}`],
    }));

    const change = buildFileChangePatch(editResult(hunks), WORKSPACE);

    NodeAssert.ok(change);
    NodeAssert.equal(change.additions, 19);
    NodeAssert.equal(change.deletions, 19);
  });

  it("keeps pure-insertion hunks whose oldLines is zero", () => {
    const change = buildFileChangePatch(
      editResult([{ oldStart: 3, oldLines: 0, newStart: 4, newLines: 2, lines: ["+one", "+two"] }]),
      WORKSPACE,
    );

    NodeAssert.ok(change);
    NodeAssert.ok(change.patch.includes("@@ -3,0 +4,2 @@"));
    NodeAssert.equal(change.additions, 2);
    NodeAssert.equal(change.deletions, 0);
  });

  it("synthesizes an all-additions patch for a new-file write", () => {
    const change = buildFileChangePatch(
      {
        type: "create",
        filePath: `${WORKSPACE}/src/new.ts`,
        content: "alpha\nbeta\n",
        structuredPatch: [],
      },
      WORKSPACE,
    );

    NodeAssert.ok(change);
    NodeAssert.equal(change.additions, 2);
    NodeAssert.equal(change.deletions, 0);
    NodeAssert.equal(
      change.patch,
      ["--- a/src/new.ts", "+++ b/src/new.ts", "@@ -0,0 +1,2 @@", "+alpha", "+beta", ""].join("\n"),
    );
  });

  it("drops the patch text but keeps the stat line when it exceeds the cap", () => {
    const line = "x".repeat(200);
    const lines = Array.from(
      { length: Math.ceil(FILE_CHANGE_PATCH_MAX_BYTES / 100) },
      () => `+${line}`,
    );
    const change = buildFileChangePatch(
      editResult([{ oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, lines }]),
      WORKSPACE,
    );

    NodeAssert.ok(change);
    NodeAssert.equal(change.truncated, true);
    NodeAssert.equal(change.patch, "");
    NodeAssert.equal(change.additions, lines.length);
  });

  it("returns undefined when there is nothing renderable", () => {
    NodeAssert.equal(buildFileChangePatch(undefined, WORKSPACE), undefined);
    NodeAssert.equal(buildFileChangePatch({ structuredPatch: [] }, WORKSPACE), undefined);
    NodeAssert.equal(buildFileChangePatch(editResult([]), WORKSPACE), undefined);
  });
});

describe("classifyFileChangeError", () => {
  it("recognizes the unread-file block and unwraps the tag", () => {
    const error = classifyFileChangeError(
      "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
    );
    NodeAssert.equal(error?.kind, "stale-read");
    NodeAssert.equal(
      error?.message,
      "File has not been read yet. Read it first before writing to it.",
    );
  });

  it("recognizes a failed match and keeps the attempted string", () => {
    const error = classifyFileChangeError(
      "<tool_use_error>String to replace not found in file.\nString: const x = 1;",
    );
    NodeAssert.equal(error?.kind, "no-match");
    NodeAssert.ok(error?.message.includes("const x = 1;"));
  });

  it("keeps unrecognized failures rather than swallowing them", () => {
    const error = classifyFileChangeError("<tool_use_error>Disk on fire</tool_use_error>");
    NodeAssert.equal(error?.kind, "unknown");
    NodeAssert.equal(error?.message, "Disk on fire");
  });

  it("returns undefined for text that is empty once unwrapped", () => {
    NodeAssert.equal(classifyFileChangeError("<tool_use_error></tool_use_error>"), undefined);
    NodeAssert.equal(classifyFileChangeError("   "), undefined);
  });
});
