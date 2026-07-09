import { createFileRoute } from "@tanstack/react-router";

import { ImportSettingsPanel } from "../components/settings/ImportSettings";

export const Route = createFileRoute("/settings/import")({
  component: ImportSettingsPanel,
});
