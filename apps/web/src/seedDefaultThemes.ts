import { importOpenVsxThemeExtension, searchOpenVsxThemes } from "./openVsxThemes";
import { getCustomThemes, replaceCustomThemeCollection } from "./themePalette";

const SEED_DONE_KEY = "t3code:default-themes-seeded:v1";
const SEED_ATTEMPTS_KEY = "t3code:default-themes-seed-attempts:v1";
const MAX_SEED_ATTEMPTS = 5;

/**
 * Official Open VSX theme packs the fork installs on first run so its preferred
 * palettes are available without manual searching. Each pack bundles every
 * variant — Catppuccin ships Latte/Frappé/Macchiato/Mocha and Rosé Pine ships
 * Dawn/base/Moon — so a single import surfaces all flavours as selectable
 * themes. Nord and Solarized are intentionally omitted: neither has a canonical
 * publisher on Open VSX (only third-party forks), so they stay manual-import.
 */
const SEED_EXTENSIONS: ReadonlyArray<{ readonly query: string; readonly id: string }> = [
  { query: "catppuccin", id: "catppuccin.catppuccin-vsc" },
  { query: "rose pine", id: "mvllow.rose-pine" },
];

let startedThisSession = false;

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode, quota) — seeding is best-effort.
  }
}

/**
 * Imports the fork's default community palettes from Open VSX once, so they are
 * available without the user searching for them. A fully successful pass sets a
 * done flag and never repeats; a failing pass (e.g. offline) leaves the flag
 * unset so a later launch can retry, capped by an attempt counter to avoid
 * hammering the network. Safe to call on every mount — it self-guards.
 */
export async function seedDefaultThemesOnce(signal?: AbortSignal): Promise<void> {
  if (typeof window === "undefined") return;
  if (startedThisSession) return;
  startedThisSession = true;

  if (readStorage(SEED_DONE_KEY) !== null) return;
  const attempts = Number.parseInt(readStorage(SEED_ATTEMPTS_KEY) ?? "0", 10) || 0;
  if (attempts >= MAX_SEED_ATTEMPTS) return;
  writeStorage(SEED_ATTEMPTS_KEY, String(attempts + 1));

  let allResolved = true;
  for (const target of SEED_EXTENSIONS) {
    try {
      const results = await searchOpenVsxThemes(target.query, signal ? { signal } : {});
      const extension = results.find(
        (candidate) => candidate.id.toLowerCase() === target.id.toLowerCase(),
      );
      if (!extension) {
        // Not surfaced by search this run — treat as transient and retry later.
        allResolved = false;
        continue;
      }
      const alreadyInstalled = getCustomThemes().some(
        (theme) => theme.collection?.id === extension.collectionId,
      );
      if (alreadyInstalled) continue;
      const themes = await importOpenVsxThemeExtension(extension, signal);
      replaceCustomThemeCollection(extension.collectionId, themes);
    } catch {
      // Offline or a transient import failure — retry on a later launch.
      allResolved = false;
    }
  }

  if (allResolved) writeStorage(SEED_DONE_KEY, "1");
}
