import { TriangleAlertIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { ServerConfigIssue } from "@t3tools/contracts";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  readDismissedSignature,
  selectForkSchemaRepairNotice,
  shouldShowForkSchemaBanner,
  writeDismissedSignature,
} from "./ForkSchemaRepairBanner.logic";

/**
 * Warns that fork-owned columns went missing and were re-added at boot.
 *
 * This is a banner rather than a toast on purpose: the columns come back empty,
 * so the user has silently lost data, and a notice that disappears on its own
 * is the same failure as the log line nobody reads.
 */
export function ForkSchemaRepairBanner({
  issues,
}: {
  readonly issues: ReadonlyArray<ServerConfigIssue> | undefined;
}) {
  const notice = useMemo(() => selectForkSchemaRepairNotice(issues), [issues]);
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readDismissedSignature(window.localStorage),
  );

  const dismiss = useCallback(() => {
    if (!notice) {
      return;
    }
    if (typeof window !== "undefined") {
      writeDismissedSignature(window.localStorage, notice.signature);
    }
    setDismissedSignature(notice.signature);
  }, [notice]);

  if (!shouldShowForkSchemaBanner({ notice, dismissedSignature })) {
    return null;
  }

  return (
    <div className="px-3 pt-3">
      <Alert variant="warning" role="alert">
        <TriangleAlertIcon aria-hidden="true" className="size-4" />
        <AlertTitle>Imported thread data may be missing</AlertTitle>
        <AlertDescription>{notice?.message}</AlertDescription>
        <AlertAction>
          <Button onClick={dismiss} size="sm" variant="outline">
            Dismiss
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
