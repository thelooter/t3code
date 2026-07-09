import { createClaudeCodeEnvironmentAtoms } from "@t3tools/client-runtime/state/claude-code";

import { connectionAtomRuntime } from "../connection/runtime";

export const claudeCodeEnvironment = createClaudeCodeEnvironmentAtoms(connectionAtomRuntime);
