import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { FileDiffMetadata } from "@pierre/diffs/types";

const testState = vi.hoisted(() => ({
  fileDiffClassName: null as string | null,
  fileDiffOptions: null as Record<string, unknown> | null,
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: { className: string; options: Record<string, unknown> }) => {
    testState.fileDiffClassName = props.className;
    testState.fileDiffOptions = props.options;
    return null;
  },
}));

import { StyledFileDiff } from "./StyledFileDiff";

const fileDiffFor = (name: string) => ({ name, hunks: [] }) as unknown as FileDiffMetadata;

describe("StyledFileDiff", () => {
  beforeEach(() => {
    testState.fileDiffClassName = null;
    testState.fileDiffOptions = null;
  });

  it("hands Pierre the app's themed stylesheet instead of its bundled colors", () => {
    renderToStaticMarkup(
      <StyledFileDiff
        fileDiff={fileDiffFor("b/src/app.ts")}
        options={{ theme: "pierre-dark", collapsed: false, diffStyle: "unified" }}
      />,
    );

    expect(testState.fileDiffClassName).toBe("styled-file-diff");
    expect(testState.fileDiffOptions).toMatchObject({
      theme: "pierre-dark",
      collapsed: false,
      diffStyle: "unified",
    });
    expect(testState.fileDiffOptions?.unsafeCSS).toEqual(
      expect.stringContaining("--diffs-bg: var(--code-background) !important;"),
    );
    expect(testState.fileDiffOptions?.unsafeCSS).toEqual(
      expect.stringContaining("[data-diffs-header]"),
    );
  });

  it("keeps a caller's own class alongside the styling hook", () => {
    renderToStaticMarkup(
      <StyledFileDiff fileDiff={fileDiffFor("b/src/app.ts")} className="mt-1" />,
    );

    expect(testState.fileDiffClassName).toBe("styled-file-diff mt-1");
  });
});
