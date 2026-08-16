/**
 * Turns the Claude SDK's file-edit tool results into a unified patch the
 * clients can render with `@pierre/diffs`.
 *
 * `Edit` and `Write` return a `tool_use_result` carrying `structuredPatch`, an
 * array of unified-diff hunks whose `lines` already have their " "/"+"/"-"
 * prefixes. `Write` against a *new* file returns an empty `structuredPatch`
 * plus the whole file in `content`, which is a quarter of all file changes in
 * practice — that case is synthesized as an all-additions patch instead.
 *
 * Paths are made workspace-relative before the "a/"/"b/" prefixes go on: the
 * SDK reports absolute paths, and prefixing one directly yields "b//home/...".
 */

/** Above this, the patch text is dropped and only the stat line survives. */
export const FILE_CHANGE_PATCH_MAX_BYTES = 32_768;

/** Failed-edit detail is a diagnostic, not a document; keep it bounded. */
const FILE_CHANGE_ERROR_MAX_CHARS = 2_000;

/**
 * Why an edit failed. `stale-read` and `no-match` are the two failures Claude
 * actually produces in practice and read very differently to a user: one is a
 * workflow nit, the other means the agent's picture of the file is wrong.
 */
export type FileChangeErrorKind = "stale-read" | "no-match" | "unknown";

export interface FileChangeError {
  readonly kind: FileChangeErrorKind;
  readonly message: string;
}

export interface FileChangePatch {
  readonly filePath: string;
  readonly patch: string;
  readonly additions: number;
  readonly deletions: number;
  readonly truncated?: true;
}

interface StructuredPatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: ReadonlyArray<string>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function readHunks(value: unknown): ReadonlyArray<StructuredPatchHunk> {
  if (!Array.isArray(value)) {
    return [];
  }
  const hunks: StructuredPatchHunk[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record || !Array.isArray(record.lines)) {
      continue;
    }
    const oldStart = asFiniteInteger(record.oldStart);
    const oldLines = asFiniteInteger(record.oldLines);
    const newStart = asFiniteInteger(record.newStart);
    const newLines = asFiniteInteger(record.newLines);
    if (
      oldStart === undefined ||
      oldLines === undefined ||
      newStart === undefined ||
      newLines === undefined
    ) {
      continue;
    }
    const lines = record.lines.filter((line): line is string => typeof line === "string");
    hunks.push({ oldStart, oldLines, newStart, newLines, lines });
  }
  return hunks;
}

/**
 * Strips the workspace root so the patch header reads `a/src/foo.ts` rather
 * than `a//home/user/project/src/foo.ts`. Falls back to dropping the leading
 * slash when the path sits outside the workspace.
 */
export function toPatchPath(filePath: string, workspaceRoot: string | undefined): string {
  const normalizedRoot = workspaceRoot?.replace(/\/+$/u, "");
  if (normalizedRoot && filePath.startsWith(`${normalizedRoot}/`)) {
    return filePath.slice(normalizedRoot.length + 1);
  }
  return filePath.replace(/^\/+/u, "");
}

function countLines(hunks: ReadonlyArray<StructuredPatchHunk>): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        additions += 1;
      } else if (line.startsWith("-")) {
        deletions += 1;
      }
    }
  }
  return { additions, deletions };
}

function renderPatch(patchPath: string, hunks: ReadonlyArray<StructuredPatchHunk>): string {
  const out = [`--- a/${patchPath}`, `+++ b/${patchPath}`];
  for (const hunk of hunks) {
    out.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines,
    );
  }
  return `${out.join("\n")}\n`;
}

/** A brand-new file: one hunk starting at 0,0 with every line an addition. */
function hunksForCreatedFile(content: string): ReadonlyArray<StructuredPatchHunk> {
  const lines = content.split("\n");
  // A trailing newline yields a final empty element that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return [];
  }
  return [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map((line) => `+${line}`),
    },
  ];
}

/**
 * Builds the canonical `data.fileChange` payload from a `tool_use_result`.
 * Returns undefined when the result carries nothing renderable, so callers can
 * fall back to the existing presentation rather than showing an empty diff.
 */
export function buildFileChangePatch(
  toolUseResult: Record<string, unknown> | undefined,
  workspaceRoot?: string,
): FileChangePatch | undefined {
  if (!toolUseResult) {
    return undefined;
  }
  const filePath = asNonEmptyString(toolUseResult.filePath);
  if (!filePath) {
    return undefined;
  }

  const structuredHunks = readHunks(toolUseResult.structuredPatch);
  const hunks =
    structuredHunks.length > 0
      ? structuredHunks
      : // Write-to-a-new-file reports no hunks; the whole file lives in `content`.
        hunksForCreatedFile(asNonEmptyString(toolUseResult.content) ?? "");
  if (hunks.length === 0) {
    return undefined;
  }

  const { additions, deletions } = countLines(hunks);
  const patch = renderPatch(toPatchPath(filePath, workspaceRoot), hunks);

  // Oversized patches keep their stat line; the text is what blows up the wire.
  if (Buffer.byteLength(patch, "utf8") > FILE_CHANGE_PATCH_MAX_BYTES) {
    return { filePath, patch: "", additions, deletions, truncated: true };
  }
  return { filePath, patch, additions, deletions };
}

/**
 * Normalizes a failed edit's `tool_result` text into a kind the UI can render
 * as something better than a raw `<tool_use_error>` blob. Unrecognized text is
 * still returned under `unknown` rather than swallowed — an unfamiliar failure
 * must not become an empty row.
 */
export function classifyFileChangeError(text: string): FileChangeError | undefined {
  const unwrapped = text
    .replace(/<\/?tool_use_error>/gu, "")
    .trim()
    .slice(0, FILE_CHANGE_ERROR_MAX_CHARS);
  if (unwrapped.length === 0) {
    return undefined;
  }
  if (/has not been read yet/iu.test(unwrapped)) {
    return { kind: "stale-read", message: unwrapped };
  }
  if (/string to replace not found|not found in file/iu.test(unwrapped)) {
    return { kind: "no-match", message: unwrapped };
  }
  return { kind: "unknown", message: unwrapped };
}
