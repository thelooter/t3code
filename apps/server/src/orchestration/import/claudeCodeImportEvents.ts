/**
 * Pure builder that turns a parsed Claude Code transcript into the ordered list
 * of orchestration events to append for an imported thread. Kept free of I/O and
 * Effect so it can be unit-tested directly; the import service supplies the
 * resolved ids and timestamps.
 */
import {
  EventId,
  type ModelSelection,
  MessageId,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import type { ParsedTranscript, TranscriptItem } from "./claudeCodeTranscript.ts";

// Distributive Omit: keep `OrchestrationEvent` a discriminated union (so
// `type` correlates with `payload`) after dropping the store-assigned sequence.
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type ImportEvent = DistributiveOmit<OrchestrationEvent, "sequence">;

export interface BuildImportEventsInput {
  readonly parsed: ParsedTranscript;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  /**
   * When the cwd has no existing project, the builder emits a `project.created`
   * event for it; otherwise it attaches the thread to the existing project.
   */
  readonly project:
    | { readonly create: false }
    | { readonly create: true; readonly title: string; readonly workspaceRoot: string };
  readonly modelSelection: ModelSelection;
  readonly importSource: string;
  readonly importSessionId: string;
  /** ISO timestamp recorded as ingestion time on every event's metadata. */
  readonly ingestedAt: string;
}

// Tool results (file dumps, command output) can be enormous; cap what we persist
// in the activity payload to keep the read model lean.
const MAX_TOOL_RESULT_CHARS = 16_000;

function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

function previewText(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function toolSummary(item: Extract<TranscriptItem, { kind: "tool-call" }>): string {
  // A short, human-readable label; full detail lives in the payload.
  const input = item.input;
  if (input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const candidate =
      record.command ?? record.file_path ?? record.path ?? record.query ?? record.pattern;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return `${item.name}: ${previewText(candidate, 80)}`;
    }
  }
  return item.name;
}

export function buildImportEvents(input: BuildImportEventsInput): ImportEvent[] {
  const { parsed, projectId, threadId, modelSelection, importSource, importSessionId, ingestedAt } =
    input;
  const events: ImportEvent[] = [];
  let counter = 0;
  const nextEventId = (): EventId => EventId.make(`cc-import-${threadId}-${(counter += 1)}`);

  const metadata = { adapterKey: importSource, ingestedAt } as const;
  const threadCreatedAt = parsed.createdAt ?? ingestedAt;
  const threadUpdatedAt = parsed.updatedAt ?? threadCreatedAt;

  if (input.project.create) {
    events.push({
      eventId: nextEventId(),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: threadCreatedAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata,
      type: "project.created",
      payload: {
        projectId,
        title: input.project.title,
        workspaceRoot: input.project.workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: threadCreatedAt,
        updatedAt: threadUpdatedAt,
      },
    });
  }

  const title = parsed.title ?? `Imported Claude Code session`;
  events.push({
    eventId: nextEventId(),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: threadCreatedAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata,
    type: "thread.created",
    payload: {
      threadId,
      projectId,
      title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: parsed.gitBranch,
      worktreePath: null,
      importedSource: importSource,
      importedSessionId: importSessionId,
      createdAt: threadCreatedAt,
      updatedAt: threadUpdatedAt,
    },
  });

  let messageIndex = 0;
  let activitySequence = 0;
  for (const item of parsed.items) {
    if (item.kind === "user-message" || item.kind === "assistant-message") {
      const messageId = MessageId.make(`cc-import-${threadId}-msg-${(messageIndex += 1)}`);
      events.push({
        eventId: nextEventId(),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: item.createdAt,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata,
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId,
          role: item.kind === "user-message" ? "user" : "assistant",
          text: item.text,
          turnId: null,
          streaming: false,
          createdAt: item.createdAt,
          updatedAt: item.createdAt,
        },
      });
      continue;
    }

    // thinking + tool calls become activities, ordered by an increasing sequence.
    const sequence = (activitySequence += 1);
    if (item.kind === "thinking") {
      events.push(
        activityEvent(threadId, nextEventId(), metadata, {
          id: nextEventId(),
          tone: "info",
          kind: "thinking",
          summary: "Thinking",
          payload: { text: item.text },
          turnId: null,
          sequence,
          createdAt: item.createdAt,
        }),
      );
      continue;
    }

    const result = item.result === null ? null : truncate(item.result, MAX_TOOL_RESULT_CHARS);
    events.push(
      activityEvent(threadId, nextEventId(), metadata, {
        id: nextEventId(),
        tone: item.isError ? "error" : "tool",
        kind: item.isError ? "tool.failed" : "tool.completed",
        summary: toolSummary(item),
        payload: { name: item.name, input: item.input, result, isError: item.isError },
        turnId: null,
        sequence,
        createdAt: item.createdAt,
      }),
    );
  }

  return events;
}

interface ActivityFields {
  readonly id: EventId;
  readonly tone: "info" | "tool" | "approval" | "error";
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly turnId: null;
  readonly sequence: number;
  readonly createdAt: string;
}

function activityEvent(
  threadId: ThreadId,
  eventId: EventId,
  metadata: { readonly adapterKey: string; readonly ingestedAt: string },
  activity: ActivityFields,
): ImportEvent {
  return {
    eventId,
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: activity.createdAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata,
    type: "thread.activity-appended",
    payload: { threadId, activity },
  };
}
