import { createFileRoute } from "@tanstack/react-router";

import { ClaudeCodeImportPanel } from "../components/settings/ClaudeCodeImportSettings";

export const Route = createFileRoute("/settings/import")({
  component: ClaudeCodeImportPanel,
});
