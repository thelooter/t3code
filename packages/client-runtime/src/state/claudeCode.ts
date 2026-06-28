import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Atoms for the Claude Code transcript import feature.
 *
 * `discovery` scans `~/.claude/projects` on the server and is cached (it reads
 * the filesystem, so we don't want it to refetch aggressively). `importSessions`
 * is a serialized command that synthesizes orchestration events for the selected
 * transcripts.
 */
export function createClaudeCodeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    discovery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:claude-code:discover",
      tag: WS_METHODS.claudeCodeDiscover,
      staleTimeMs: 60_000,
    }),
    planImport: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:claude-code:plan-import",
      tag: WS_METHODS.claudeCodePlanImport,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    importSessions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:claude-code:import",
      tag: WS_METHODS.claudeCodeImport,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
