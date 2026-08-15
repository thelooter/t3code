import { FORK_SCHEMA_ISSUE_PREFIX, type ServerConfigIssue } from "@t3tools/contracts";

export const FORK_SCHEMA_DISMISSAL_STORAGE_KEY = "t3code.fork-schema-repair-dismissed";

export interface ForkSchemaRepairNotice {
  /** Stable identity for this repair, so a later, different repair re-shows. */
  readonly signature: string;
  readonly message: string;
}

const isForkSchemaIssue = (
  issue: ServerConfigIssue,
): issue is Extract<ServerConfigIssue, { readonly columns: ReadonlyArray<string> }> =>
  issue.kind.startsWith(FORK_SCHEMA_ISSUE_PREFIX);

/**
 * Pick the fork schema repair out of a server config's issues.
 *
 * Returns null when nothing was repaired, which is the normal case.
 */
export function selectForkSchemaRepairNotice(
  issues: ReadonlyArray<ServerConfigIssue> | undefined,
): ForkSchemaRepairNotice | null {
  const issue = issues?.find(isForkSchemaIssue);
  if (!issue) {
    return null;
  }
  return {
    signature: `${issue.kind}:${[...issue.columns].sort().join(",")}`,
    message: issue.message,
  };
}

/**
 * Whether the banner should show.
 *
 * Dismissal is keyed by signature rather than a single flag: dismissing a
 * repair of one column must not hide a later repair of a different one.
 */
export function shouldShowForkSchemaBanner(input: {
  readonly notice: ForkSchemaRepairNotice | null;
  readonly dismissedSignature: string | null;
}): boolean {
  if (!input.notice) {
    return false;
  }
  return input.dismissedSignature !== input.notice.signature;
}

export function readDismissedSignature(storage: Pick<Storage, "getItem">): string | null {
  try {
    return storage.getItem(FORK_SCHEMA_DISMISSAL_STORAGE_KEY);
  } catch {
    // Private-mode and sandboxed contexts can throw on access; a banner that
    // reappears is better than one that breaks the shell.
    return null;
  }
}

export function writeDismissedSignature(
  storage: Pick<Storage, "setItem">,
  signature: string,
): void {
  try {
    storage.setItem(FORK_SCHEMA_DISMISSAL_STORAGE_KEY, signature);
  } catch {
    // Dismissal is a convenience; losing it must not break the interaction.
  }
}
