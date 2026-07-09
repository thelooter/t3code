import { ChevronLeftIcon, FileJsonIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type {
  ClaudeCodeImportPlanProject,
  ClaudeCodeImportPlanSession,
  ClaudeCodeSessionSummary,
  ProjectId,
} from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { claudeCodeEnvironment } from "../../state/claudeCode";
import { usePrimaryEnvironment } from "../../state/environments";
import { useProjects } from "../../state/entities";
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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type WizardStep = "select" | "projects" | "mapping";

interface WizardPlan {
  projects: ClaudeCodeImportPlanProject[];
  sessions: ClaudeCodeImportPlanSession[];
}

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

function WizardFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-3 border-t border-border/60 px-4 py-3">
      {children}
    </div>
  );
}

function ClaudeCodeImportSource() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const allProjects = useProjects();
  const discovery = useEnvironmentQuery(
    environmentId === null ? null : claudeCodeEnvironment.discovery({ environmentId, input: {} }),
  );
  const runPlan = useAtomCommand(claudeCodeEnvironment.planImport, { reportFailure: false });
  const runImport = useAtomCommand(claudeCodeEnvironment.importSessions, { reportFailure: false });

  const [step, setStep] = useState<WizardStep>("select");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [plan, setPlan] = useState<WizardPlan | null>(null);
  const [isWorking, setIsWorking] = useState(false);

  const sessions = discovery.data?.sessions ?? [];
  const importableCount = useMemo(
    () => sessions.filter((session) => !session.alreadyImported).length,
    [sessions],
  );
  const isInitialScan = discovery.isPending && discovery.data === null;

  // Existing projects for the current environment, for "map to existing project".
  const existingProjects = useMemo(
    () => allProjects.filter((p) => p.environmentId === environmentId),
    [allProjects, environmentId],
  );

  // Project options shown in the per-thread mapping dropdown: the plan's projects
  // plus any other existing project the user might want to retarget to.
  const projectOptions = useMemo(() => {
    const options = new Map<string, { projectId: ProjectId; label: string }>();
    for (const p of plan?.projects ?? []) {
      options.set(p.projectId, {
        projectId: p.projectId,
        label: `${p.title || p.workspaceRoot}${p.isExisting ? "" : " (new)"}`,
      });
    }
    for (const p of existingProjects) {
      if (!options.has(p.id)) options.set(p.id, { projectId: p.id, label: p.title });
    }
    return [...options.values()];
  }, [plan, existingProjects]);

  const resetToSelect = useCallback(() => {
    setStep("select");
    setPlan(null);
    setSelected(new Set());
  }, []);

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

  const renameProject = useCallback((projectId: ProjectId, title: string) => {
    setPlan((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            projects: prev.projects.map((p) => (p.projectId === projectId ? { ...p, title } : p)),
          },
    );
  }, []);

  const reassignSession = useCallback((filePath: string, projectId: ProjectId) => {
    setPlan((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            sessions: prev.sessions.map((s) => (s.filePath === filePath ? { ...s, projectId } : s)),
          },
    );
  }, []);

  const handlePlan = useCallback(async () => {
    if (environmentId === null || selected.size === 0 || isWorking) return;
    setIsWorking(true);
    const result = await runPlan({ environmentId, input: { filePaths: [...selected] } });
    setIsWorking(false);
    if (result._tag !== "Success") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not prepare import",
          description: "Failed to read the selected sessions.",
        }),
      );
      return;
    }
    if (result.value.sessions.length === 0) {
      toastManager.add(
        stackedThreadToast({ type: "info", title: "Nothing to import", description: "" }),
      );
      return;
    }
    setPlan({
      projects: result.value.projects.map((p) => ({ ...p })),
      sessions: result.value.sessions.map((s) => ({ ...s })),
    });
    setStep("projects");
  }, [environmentId, isWorking, runPlan, selected]);

  const handleImport = useCallback(async () => {
    if (environmentId === null || plan === null || isWorking) return;
    setIsWorking(true);

    // Only send projects actually referenced by a session, with edited titles.
    const usedIds = new Set(plan.sessions.map((s) => s.projectId));
    const projects = [...usedIds].map((projectId) => {
      const planned = plan.projects.find((p) => p.projectId === projectId);
      if (planned !== undefined) {
        return {
          projectId,
          title: planned.title.trim() || planned.workspaceRoot,
          workspaceRoot: planned.workspaceRoot,
          isExisting: planned.isExisting,
        };
      }
      const existing = existingProjects.find((p) => p.id === projectId);
      return {
        projectId,
        title: existing?.title ?? "Imported",
        workspaceRoot: existing?.workspaceRoot ?? projectId,
        isExisting: true,
      };
    });
    const assignments = plan.sessions.map((s) => ({
      filePath: s.filePath,
      projectId: s.projectId,
    }));

    const result = await runImport({
      environmentId,
      input: { projects, sessions: assignments },
    });
    setIsWorking(false);

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
      resetToSelect();
      discovery.refresh();
    } else {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Import failed",
          description: "Could not import the selected conversations.",
        }),
      );
    }
  }, [discovery, environmentId, existingProjects, isWorking, plan, resetToSelect, runImport]);

  const rescanButton = (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => discovery.refresh()}
      disabled={discovery.isPending || step !== "select"}
    >
      <RefreshCwIcon className={cn("size-3", discovery.isPending && "animate-spin")} />
      Rescan
    </Button>
  );

  // ---- Step: select sessions -------------------------------------------------
  if (step === "select") {
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

            <WizardFooter>
              {selected.size > 0 && (
                <span className="mr-auto text-[12px] text-muted-foreground">
                  {selected.size} selected
                </span>
              )}
              <Button onClick={handlePlan} disabled={selected.size === 0 || isWorking}>
                {isWorking && <Spinner className="size-3.5" />}
                Import selected
              </Button>
            </WizardFooter>
          </>
        )}
      </SettingsSection>
    );
  }

  // ---- Step: review projects -------------------------------------------------
  if (step === "projects" && plan !== null) {
    return (
      <SettingsSection title="Claude Code · Projects" icon={<FileJsonIcon className="size-3.5" />}>
        <div className="border-b border-border/60 px-4 py-2.5 text-[12px] text-muted-foreground">
          {plan.projects.length} project{plan.projects.length === 1 ? "" : "s"} for{" "}
          {plan.sessions.length} thread{plan.sessions.length === 1 ? "" : "s"}. Rename the new ones
          if you like — existing projects are reused.
        </div>
        <div className="max-h-[420px] divide-y divide-border/60 overflow-y-auto">
          {plan.projects.map((project) => (
            <div key={project.projectId} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                {project.isExisting ? (
                  <span className="text-[13px] font-medium text-foreground">{project.title}</span>
                ) : (
                  <Input
                    size="sm"
                    value={project.title}
                    onValueChange={(value) => renameProject(project.projectId, value)}
                    aria-label="New project name"
                  />
                )}
                <p className="mt-1 truncate text-[11px] text-muted-foreground/70">
                  {project.workspaceRoot}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={project.isExisting ? "secondary" : "outline"}>
                  {project.isExisting ? "Existing" : "New"}
                </Badge>
                <span className="text-[11px] text-muted-foreground">
                  {project.sessionCount} thread{project.sessionCount === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          ))}
        </div>
        <WizardFooter>
          <Button variant="ghost" size="xs" className="mr-auto" onClick={resetToSelect}>
            <ChevronLeftIcon className="size-3" />
            Back
          </Button>
          <Button onClick={() => setStep("mapping")}>Next: thread mapping</Button>
        </WizardFooter>
      </SettingsSection>
    );
  }

  // ---- Step: review thread → project mapping ---------------------------------
  if (step === "mapping" && plan !== null) {
    return (
      <SettingsSection title="Claude Code · Threads" icon={<FileJsonIcon className="size-3.5" />}>
        <div className="border-b border-border/60 px-4 py-2.5 text-[12px] text-muted-foreground">
          Confirm where each thread lands. Reassign any thread to a different project below.
        </div>
        <div className="max-h-[420px] divide-y divide-border/60 overflow-y-auto">
          {plan.sessions.map((session) => (
            <div
              key={session.filePath}
              className="flex items-center gap-3 px-4 py-3 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-foreground">
                  {session.title ?? session.sessionId}
                </p>
                <p className="truncate text-[11px] text-muted-foreground/70">
                  {session.messageCount} message{session.messageCount === 1 ? "" : "s"}
                  {session.cwd !== null ? ` · ${session.cwd}` : ""}
                </p>
              </div>
              <Select
                value={session.projectId}
                onValueChange={(value) => reassignSession(session.filePath, value as ProjectId)}
              >
                <SelectTrigger className="w-44 shrink-0" aria-label="Target project">
                  <SelectValue>
                    {projectOptions.find((o) => o.projectId === session.projectId)?.label ??
                      "Select project"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {projectOptions.map((option) => (
                    <SelectItem key={option.projectId} value={option.projectId}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ))}
        </div>
        <WizardFooter>
          <Button
            variant="ghost"
            size="xs"
            className="mr-auto"
            onClick={() => setStep("projects")}
            disabled={isWorking}
          >
            <ChevronLeftIcon className="size-3" />
            Back
          </Button>
          <Button onClick={handleImport} disabled={isWorking}>
            {isWorking && <Spinner className="size-3.5" />}
            Import {plan.sessions.length} thread{plan.sessions.length === 1 ? "" : "s"}
          </Button>
        </WizardFooter>
      </SettingsSection>
    );
  }

  return null;
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
