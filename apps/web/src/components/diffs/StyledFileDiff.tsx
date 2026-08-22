/* oxlint-disable eslint/no-restricted-imports -- This is the single styled adapter around Pierre's raw file diff. */
import { FileDiff, type FileDiffProps } from "@pierre/diffs/react";
/* oxlint-enable eslint/no-restricted-imports */

import { DIFF_VIEW_UNSAFE_CSS } from "./StyledDiffCodeView";

export type StyledFileDiffOptions<LAnnotation> = Omit<
  NonNullable<FileDiffProps<LAnnotation>["options"]>,
  "unsafeCSS"
>;

type StyledFileDiffProps<LAnnotation> = Omit<FileDiffProps<LAnnotation>, "options"> & {
  readonly options?: StyledFileDiffOptions<LAnnotation>;
};

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
  return (
    <FileDiff<LAnnotation>
      {...props}
      className={className ? `styled-file-diff ${className}` : "styled-file-diff"}
      options={{ ...options, unsafeCSS: DIFF_VIEW_UNSAFE_CSS }}
    />
  );
}
