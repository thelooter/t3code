import { ProjectId, ProviderInstanceId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildImportEvents } from "./claudeCodeImportEvents.ts";
import type { ParsedTranscript, TranscriptItem } from "./claudeCodeTranscript.ts";

const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeCode"),
  model: "claude-opus-4-8",
};

function parsed(
  items: TranscriptItem[],
  overrides: Partial<ParsedTranscript> = {},
): ParsedTranscript {
  return {
    sessionId: "sess-1",
    cwd: "/home/me/project",
    gitBranch: "main",
    version: "2.1.179",
    title: "My session",
    model: "claude-opus-4-8",
    createdAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:09.000Z",
    firstUserPrompt: "hi",
    messageCount: 2,
    items,
    ...overrides,
  };
}

const baseInput = {
  projectId: ProjectId.make("proj-1"),
  threadId: ThreadId.make("cc-import:sess-1"),
  modelSelection: MODEL,
  importSource: "claude-code",
  importSessionId: "sess-1",
  ingestedAt: "2026-02-02T00:00:00.000Z",
};

describe("buildImportEvents", () => {
  it("emits thread.created with import provenance and ordered message/activity events", () => {
    const items: TranscriptItem[] = [
      { kind: "user-message", uuid: "u1", text: "hi", createdAt: "2026-01-01T00:00:01.000Z" },
      { kind: "thinking", uuid: "a1", text: "hmm", createdAt: "2026-01-01T00:00:02.000Z" },
      {
        kind: "assistant-message",
        uuid: "a1",
        text: "hello",
        model: "claude-opus-4-8",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      {
        kind: "tool-call",
        uuid: "a1",
        toolUseId: "t1",
        name: "Bash",
        input: { command: "ls" },
        result: "file-a",
        isError: false,
        createdAt: "2026-01-01T00:00:03.000Z",
      },
    ];

    const events = buildImportEvents({
      ...baseInput,
      project: { create: false },
      parsed: parsed(items),
    });

    expect(events.map((e) => e.type)).toEqual([
      "thread.created",
      "thread.message-sent",
      "thread.activity-appended",
      "thread.message-sent",
      "thread.activity-appended",
    ]);

    const created = events[0];
    expect(created?.type).toBe("thread.created");
    if (created?.type === "thread.created") {
      expect(created.payload.importedSource).toBe("claude-code");
      expect(created.payload.importedSessionId).toBe("sess-1");
      expect(created.payload.title).toBe("My session");
      expect(created.payload.branch).toBe("main");
      expect(created.occurredAt).toBe("2026-01-01T00:00:01.000Z");
    }

    // Every event id is unique.
    const ids = events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);

    // Roles are preserved on messages.
    const messages = events.filter((e) => e.type === "thread.message-sent");
    expect(messages.map((e) => (e.type === "thread.message-sent" ? e.payload.role : null))).toEqual(
      ["user", "assistant"],
    );
  });

  it("emits a project.created event first when the project must be created", () => {
    const events = buildImportEvents({
      ...baseInput,
      project: { create: true, title: "project", workspaceRoot: "/home/me/project" },
      parsed: parsed([
        { kind: "user-message", uuid: "u1", text: "hi", createdAt: "2026-01-01T00:00:01.000Z" },
      ]),
    });

    expect(events[0]?.type).toBe("project.created");
    expect(events[0]?.aggregateKind).toBe("project");
    if (events[0]?.type === "project.created") {
      expect(events[0].payload.workspaceRoot).toBe("/home/me/project");
    }
    expect(events[1]?.type).toBe("thread.created");
  });

  it("marks failed tool calls with error tone and kind", () => {
    const events = buildImportEvents({
      ...baseInput,
      project: { create: false },
      parsed: parsed([
        {
          kind: "tool-call",
          uuid: "a1",
          toolUseId: "t1",
          name: "Bash",
          input: { command: "false" },
          result: "boom",
          isError: true,
          createdAt: "2026-01-01T00:00:03.000Z",
        },
      ]),
    });

    const activity = events.find((e) => e.type === "thread.activity-appended");
    expect(activity?.type).toBe("thread.activity-appended");
    if (activity?.type === "thread.activity-appended") {
      expect(activity.payload.activity.tone).toBe("error");
      expect(activity.payload.activity.kind).toBe("tool.failed");
    }
  });

  it("falls back to a default title when the transcript has none", () => {
    const events = buildImportEvents({
      ...baseInput,
      project: { create: false },
      parsed: parsed(
        [{ kind: "user-message", uuid: "u1", text: "hi", createdAt: "2026-01-01T00:00:01.000Z" }],
        {
          title: null,
        },
      ),
    });
    const created = events[0];
    if (created?.type === "thread.created") {
      expect(created.payload.title.length).toBeGreaterThan(0);
    }
  });
});
