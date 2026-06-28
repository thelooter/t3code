import { FileJsonIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ClaudeCodeSessionSummary } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { claudeCodeEnvironment } from "../../state/claudeCode";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

function formatTimestamp(iso: string | null): string {
  if (iso === null || iso.length < 10) return "";
  // ISO 8601 -> "YYYY-MM-DD HH:MM"; avoids `new Date()` (banned by the repo lint).
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return time.length === 5 ? `${date} ${time}` : date;
}

function SessionRow({
  session,
  selected,
  onToggle,
}: {
  session: ClaudeCodeSessionSummary;
  selected: boolean;
  onToggle: (filePath: string, checked: boolean) => void;
}) {
  const disabled = session.alreadyImported;
  const meta = [
    formatTimestamp(session.updatedAt ?? session.createdAt),
    `${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`,
    session.model,
    session.cwd,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);

  return (
    <label
      className={cn(
        "flex items-start gap-3 px-4 py-3 transition-colors",
        disabled ? "opacity-55" : "cursor-pointer hover:bg-secondary/40",
      )}
    >
      <Checkbox
        className="mt-0.5"
        checked={selected}
        disabled={disabled}
        onCheckedChange={(checked) => onToggle(session.filePath, checked === true)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">
            {session.title ?? session.sessionId}
          </span>
          {session.alreadyImported && (
            <Badge variant="secondary" className="shrink-0">
              Imported
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{meta.join("  ·  ")}</p>
        {session.firstUserPrompt !== null && (
          <p className="mt-1 line-clamp-2 text-[12px] text-muted-foreground/65">
            {session.firstUserPrompt}
          </p>
        )}
      </div>
    </label>
  );
}

function ClaudeCodeImportSource() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const discovery = useEnvironmentQuery(
    environmentId === null ? null : claudeCodeEnvironment.discovery({ environmentId, input: {} }),
  );
  const runImport = useAtomCommand(claudeCodeEnvironment.importSessions, { reportFailure: false });

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);

  const sessions = discovery.data?.sessions ?? [];
  const importableCount = useMemo(
    () => sessions.filter((session) => !session.alreadyImported).length,
    [sessions],
  );
  const isInitialScan = discovery.isPending && discovery.data === null;

  const toggle = useCallback((filePath: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(filePath);
      else next.delete(filePath);
      return next;
    });
  }, []);

  const selectAllImportable = useCallback(() => {
    setSelected(new Set(sessions.filter((s) => !s.alreadyImported).map((s) => s.filePath)));
  }, [sessions]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const handleImport = useCallback(async () => {
    if (environmentId === null || selected.size === 0 || isImporting) return;
    setIsImporting(true);
    const result = await runImport({ environmentId, input: { filePaths: [...selected] } });
    setIsImporting(false);

    if (result._tag === "Success") {
      const imported = result.value.results.filter((r) => r.status === "imported").length;
      const failed = result.value.results.filter((r) => r.status === "failed").length;
      const skipped = result.value.results.filter((r) => r.status === "skipped").length;
      toastManager.add(
        stackedThreadToast({
          type: failed > 0 ? "error" : "success",
          title:
            imported > 0
              ? `Imported ${imported} conversation${imported === 1 ? "" : "s"}`
              : "Nothing imported",
          description: [
            failed > 0 ? `${failed} failed` : null,
            skipped > 0 ? `${skipped} skipped` : null,
          ]
            .filter(Boolean)
            .join(", "),
        }),
      );
      clearSelection();
      discovery.refresh();
    } else {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Import failed",
          description: discovery.error ?? "Could not import the selected conversations.",
        }),
      );
    }
  }, [clearSelection, discovery, environmentId, isImporting, runImport, selected]);

  const rescanButton = (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => discovery.refresh()}
      disabled={discovery.isPending}
    >
      <RefreshCwIcon className={cn("size-3", discovery.isPending && "animate-spin")} />
      Rescan
    </Button>
  );

  return (
    <SettingsSection
      title="Claude Code"
      icon={<FileJsonIcon className="size-3.5" />}
      headerAction={rescanButton}
    >
      {environmentId === null ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No environment connected.
        </div>
      ) : isInitialScan ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="p-4">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileJsonIcon className="size-5" />
              </EmptyMedia>
              <EmptyTitle>No Claude Code sessions found</EmptyTitle>
              <EmptyDescription>
                Nothing was found under <code>~/.claude/projects</code> on the server.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{rescanButton}</EmptyContent>
          </Empty>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
            <span className="text-[12px] text-muted-foreground">
              {sessions.length} session{sessions.length === 1 ? "" : "s"} · {importableCount}{" "}
              importable
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="xs"
                variant="ghost"
                onClick={selectAllImportable}
                disabled={importableCount === 0}
              >
                Select all
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={clearSelection}
                disabled={selected.size === 0}
              >
                Clear
              </Button>
            </div>
          </div>

          <div className="max-h-[460px] divide-y divide-border/60 overflow-y-auto">
            {sessions.map((session) => (
              <SessionRow
                key={session.filePath}
                session={session}
                selected={selected.has(session.filePath)}
                onToggle={toggle}
              />
            ))}
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-border/60 px-4 py-3">
            {selected.size > 0 && (
              <span className="mr-auto text-[12px] text-muted-foreground">
                {selected.size} selected
              </span>
            )}
            <Button onClick={handleImport} disabled={selected.size === 0 || isImporting}>
              {isImporting && <Spinner className="size-3.5" />}
              Import selected
            </Button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}

export function ImportSettingsPanel() {
  return (
    <SettingsPageContainer>
      <p className="px-1 text-sm text-muted-foreground">
        Import conversations from other coding agents to browse them inside the app. Imported
        threads are read-only.
      </p>
      <ClaudeCodeImportSource />
    </SettingsPageContainer>
  );
}
