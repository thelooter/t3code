/* oxlint-disable eslint/no-restricted-imports -- This is the single styled adapter around Pierre's raw file diff. */
import { FileDiff, type FileDiffProps } from "@pierre/diffs/react";
/* oxlint-enable eslint/no-restricted-imports */
import { getFiletypeFromFileName } from "@pierre/diffs/utils/getFiletypeFromFileName";
import { Suspense, use, type ReactNode } from "react";

import { resolveFileDiffPath } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

import { RenderErrorBoundary } from "../RenderErrorBoundary";

import { DIFF_VIEW_UNSAFE_CSS } from "./StyledDiffCodeView";

export type StyledFileDiffOptions<LAnnotation> = Omit<
  NonNullable<FileDiffProps<LAnnotation>["options"]>,
  "unsafeCSS"
>;

type StyledFileDiffProps<LAnnotation> = Omit<FileDiffProps<LAnnotation>, "options"> & {
  readonly options?: StyledFileDiffOptions<LAnnotation>;
};

/**
 * Blocks until the file's grammar is in the shared highlighter. Pierre tokenizes
 * once on mount and never re-tokenizes, so a diff mounted before its grammar
 * loads stays plain for as long as the row is open, and highlighting ends up
 * depending on whether something else in the thread happened to load that
 * language first. Mirrors the gate the markdown code block already uses.
 */
function HighlighterGate({ fileName, children }: { fileName: string; children: ReactNode }) {
  use(getSyntaxHighlighterPromise(getFiletypeFromFileName(fileName)));
  return children;
}

/**
 * One file's diff embedded in surrounding chrome, such as a chat row or a review
 * comment. Pierre paints its own bundled colors unless the app hands it a
 * stylesheet, so this shares the diff panel's — the palette a user picks reaches
 * an inline diff the same way it reaches the panel.
 */
export function StyledFileDiff<LAnnotation = undefined>({
  options,
  className,
  ...props
}: StyledFileDiffProps<LAnnotation>) {
  const diff = (
    <FileDiff<LAnnotation>
      {...props}
      className={className ? `styled-file-diff ${className}` : "styled-file-diff"}
      options={{ ...options, unsafeCSS: DIFF_VIEW_UNSAFE_CSS }}
    />
  );

  // The unhighlighted diff is the fallback for both waiting and failing, rather
  // than a spinner or a gap: the change itself is what the reader came for, and
  // color arriving a beat later — or never — costs them nothing. Only the first
  // file of a given language waits at all. Losing the highlighter must not be
  // able to take the surrounding thread down with it.
  return (
    <RenderErrorBoundary fallback={diff}>
      <Suspense fallback={diff}>
        <HighlighterGate fileName={resolveFileDiffPath(props.fileDiff)}>{diff}</HighlighterGate>
      </Suspense>
    </RenderErrorBoundary>
  );
}
