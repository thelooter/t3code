import { describe, expect, it } from "vite-plus/test";

import {
  parseTranscript,
  summarizeTranscript,
  type TranscriptItem,
} from "./claudeCodeTranscript.ts";

/** Build a JSONL document from line objects. */
function jsonl(lines: ReadonlyArray<Record<string, unknown>>): string {
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

let clock = 0;
function ts(): string {
  clock += 1;
  // Deterministic, strictly increasing ISO timestamps (no `new Date()`: the repo
  // bans it in favour of Effect's DateTime).
  const pad = (n: number) => String(n).padStart(2, "0");
  const ss = clock % 60;
  const mm = Math.floor(clock / 60) % 60;
  const hh = Math.floor(clock / 3600) % 24;
  return `2026-01-01T${pad(hh)}:${pad(mm)}:${pad(ss)}.000Z`;
}

const BASE = {
  sessionId: "sess-1",
  cwd: "/home/me/project",
  gitBranch: "main",
  version: "2.1.179",
  isSidechain: false,
  userType: "external",
};

function userString(uuid: string, parentUuid: string | null, text: string, promptSource = "typed") {
  return {
    ...BASE,
    type: "user",
    uuid,
    parentUuid,
    timestamp: ts(),
    promptSource,
    message: { role: "user", content: text },
  };
}

function assistant(
  uuid: string,
  parentUuid: string | null,
  content: ReadonlyArray<unknown>,
  model = "claude-opus-4-8",
) {
  return {
    ...BASE,
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: ts(),
    message: { role: "assistant", model, content },
  };
}

function toolResult(
  uuid: string,
  parentUuid: string,
  toolUseId: string,
  content: unknown,
  isError = false,
) {
  return {
    ...BASE,
    type: "user",
    uuid,
    parentUuid,
    timestamp: ts(),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  };
}

describe("parseTranscript", () => {
  it("linearizes a simple conversation with thinking, text and tool calls in order", () => {
    clock = 0;
    const doc = jsonl([
      { type: "ai-title", aiTitle: "Set up project", sessionId: "sess-1" },
      userString("u1", null, "Help me set up"),
      assistant("a1", "u1", [
        { type: "thinking", thinking: "Let me look around", signature: "sig" },
        { type: "text", text: "Sure, let me check." },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
      ]),
      toolResult("u2", "a1", "tool-1", "file-a\nfile-b"),
      assistant("a2", "u2", [{ type: "text", text: "Found two files." }]),
    ]);

    const parsed = parseTranscript(doc);

    expect(parsed.title).toBe("Set up project");
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.cwd).toBe("/home/me/project");
    expect(parsed.model).toBe("claude-opus-4-8");
    expect(parsed.firstUserPrompt).toBe("Help me set up");
    expect(parsed.messageCount).toBe(3); // u1, a1 text, a2 text

    const kinds = parsed.items.map((i) => i.kind);
    expect(kinds).toEqual([
      "user-message",
      "thinking",
      "assistant-message",
      "tool-call",
      "assistant-message",
    ]);

    const tool = parsed.items.find(
      (i): i is Extract<TranscriptItem, { kind: "tool-call" }> => i.kind === "tool-call",
    );
    expect(tool?.name).toBe("Bash");
    expect(tool?.input).toEqual({ command: "ls" });
    expect(tool?.result).toBe("file-a\nfile-b");
    expect(tool?.isError).toBe(false);
  });

  it("follows the active branch and drops abandoned edit/rerun branches", () => {
    clock = 0;
    // u1 -> a1(old, abandoned)   and later   u1 -> a2(new) -> u-final
    const doc = jsonl([
      userString("u1", null, "First question"),
      assistant("a-old", "u1", [{ type: "text", text: "OLD answer" }]),
      // user edits/reruns: a new assistant child of u1 with a later timestamp
      assistant("a-new", "u1", [{ type: "text", text: "NEW answer" }]),
      userString("u2", "a-new", "Follow up"),
      assistant("a3", "u2", [{ type: "text", text: "Final answer" }]),
    ]);

    const parsed = parseTranscript(doc);
    const texts = parsed.items
      .filter(
        (i): i is Extract<TranscriptItem, { kind: "assistant-message" }> =>
          i.kind === "assistant-message",
      )
      .map((i) => i.text);

    expect(texts).toContain("NEW answer");
    expect(texts).toContain("Final answer");
    expect(texts).not.toContain("OLD answer");
  });

  it("treats a dangling parentUuid (cross-session continuation) as a root", () => {
    clock = 0;
    const doc = jsonl([
      // parentUuid references a node not present in this file
      userString("u1", "uuid-from-a-previous-session", "Continue please"),
      assistant("a1", "u1", [{ type: "text", text: "Continuing." }]),
    ]);

    const parsed = parseTranscript(doc);
    expect(parsed.items.map((i) => i.kind)).toEqual(["user-message", "assistant-message"]);
    expect(parsed.firstUserPrompt).toBe("Continue please");
  });

  it("skips sidechain (subagent) nodes", () => {
    clock = 0;
    const doc = jsonl([
      userString("u1", null, "Run a subagent"),
      assistant("a1", "u1", [{ type: "text", text: "Done." }]),
      {
        ...BASE,
        type: "user",
        isSidechain: true,
        uuid: "sc1",
        parentUuid: "a1",
        timestamp: ts(),
        message: { role: "user", content: "subagent prompt" },
      },
      {
        ...BASE,
        type: "assistant",
        isSidechain: true,
        uuid: "sc2",
        parentUuid: "sc1",
        timestamp: ts(),
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "subagent reply" }],
        },
      },
    ]);

    const parsed = parseTranscript(doc);
    const texts = parsed.items.map((i) => ("text" in i ? i.text : ""));
    expect(texts).not.toContain("subagent prompt");
    expect(texts).not.toContain("subagent reply");
  });

  it("normalizes array-shaped tool_result content and flags errors", () => {
    clock = 0;
    const doc = jsonl([
      userString("u1", null, "Search tools"),
      assistant("a1", "u1", [
        { type: "tool_use", id: "t1", name: "ToolSearch", input: { query: "x" } },
      ]),
      toolResult("u2", "a1", "t1", [
        { type: "tool_reference", tool_name: "WebFetch" },
        { type: "text", text: "matched 1" },
      ]),
      assistant("a2", "u2", [
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "false" } },
      ]),
      toolResult("u3", "a2", "t2", "command failed", true),
    ]);

    const parsed = parseTranscript(doc);
    const tools = parsed.items.filter(
      (i): i is Extract<TranscriptItem, { kind: "tool-call" }> => i.kind === "tool-call",
    );
    expect(tools[0]?.result).toBe("→ WebFetch\nmatched 1");
    expect(tools[0]?.isError).toBe(false);
    expect(tools[1]?.result).toBe("command failed");
    expect(tools[1]?.isError).toBe(true);
  });

  it("emits a user message from text blocks but ignores pure tool_result nodes", () => {
    clock = 0;
    const doc = jsonl([
      userString("u1", null, "go"),
      assistant("a1", "u1", [{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
      // user node carrying BOTH a tool_result and a text block
      {
        ...BASE,
        type: "user",
        uuid: "u2",
        parentUuid: "a1",
        timestamp: ts(),
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "contents" },
            { type: "text", text: "also do this" },
          ],
        },
      },
      assistant("a2", "u2", [{ type: "text", text: "ok" }]),
    ]);

    const parsed = parseTranscript(doc);
    const userMessages = parsed.items.filter((i) => i.kind === "user-message");
    expect(userMessages.map((i) => ("text" in i ? i.text : ""))).toEqual(["go", "also do this"]);
  });

  it("ignores synthetic model when picking the thread model", () => {
    clock = 0;
    const doc = jsonl([
      userString("u1", null, "hi"),
      assistant("a1", "u1", [{ type: "text", text: "[Request interrupted]" }], "<synthetic>"),
      assistant("a2", "u1", [{ type: "text", text: "real reply" }], "claude-sonnet-4-6"),
    ]);
    const parsed = parseTranscript(doc);
    expect(parsed.model).toBe("claude-sonnet-4-6");
  });

  it("ignores hook/sdk-injected prompts for title and preview, preferring the typed prompt", () => {
    clock = 0;
    const doc = jsonl([
      // A hook-injected user line (not real input) precedes the real typed prompt.
      userString("u0", null, "Stop hook feedback: do not use as a title", "system"),
      assistant("a0", "u0", [{ type: "text", text: "ack" }]),
      userString("u1", "a0", "Actually fix the bug in foo.ts", "typed"),
      assistant("a1", "u1", [{ type: "text", text: "done" }]),
    ]);
    const parsed = parseTranscript(doc);
    expect(parsed.firstUserPrompt).toBe("Actually fix the bug in foo.ts");
    expect(parsed.title).toBe("Actually fix the bug in foo.ts");
  });

  it("leaves title null for sessions with no ai-title and no typed prompt (e.g. sdk title-gen)", () => {
    clock = 0;
    const doc = jsonl([
      userString("u1", null, "You write concise thread titles for coding conversations…", "sdk"),
      assistant("a1", "u1", [{ type: "text", text: '{"title":"x"}' }]),
    ]);
    const parsed = parseTranscript(doc);
    expect(parsed.firstUserPrompt).toBeNull();
    expect(parsed.title).toBeNull();
  });

  it("uses ai-title even when the only prompts are injected", () => {
    clock = 0;
    const doc = jsonl([
      { type: "ai-title", aiTitle: "Curated title", sessionId: "sess-1" },
      userString("u1", null, "<command-message>some-skill</command-message>", "system"),
      assistant("a1", "u1", [{ type: "text", text: "ok" }]),
    ]);
    const parsed = parseTranscript(doc);
    expect(parsed.title).toBe("Curated title");
  });

  it("keeps real prompts regardless of promptSource (sdk-driven sessions are real work)", () => {
    clock = 0;
    const doc = jsonl([
      // Real human prompt, but the session is SDK-driven so promptSource is "sdk".
      userString("u1", null, "Build the importer feature", "sdk"),
      assistant("a1", "u1", [{ type: "text", text: "on it" }]),
    ]);
    const parsed = parseTranscript(doc);
    expect(parsed.firstUserPrompt).toBe("Build the importer feature");
    expect(parsed.title).toBe("Build the importer feature");
  });

  it("drops isMeta-injected user lines (e.g. Stop-hook output) from body and title", () => {
    clock = 0;
    const doc = jsonl([
      {
        ...BASE,
        type: "user",
        uuid: "m1",
        parentUuid: null,
        timestamp: ts(),
        isMeta: true,
        message: { role: "user", content: "An injected hook note, not real conversation" },
      },
      userString("u1", "m1", "Real first prompt", "typed"),
      assistant("a1", "u1", [{ type: "text", text: "ok" }]),
    ]);
    const parsed = parseTranscript(doc);
    expect(parsed.firstUserPrompt).toBe("Real first prompt");
    expect(
      parsed.items.filter((i) => i.kind === "user-message").map((i) => ("text" in i ? i.text : "")),
    ).toEqual(["Real first prompt"]);
  });

  it("tolerates blank and corrupt lines", () => {
    clock = 0;
    const doc = [
      "",
      "{ not valid json",
      JSON.stringify(userString("u1", null, "hello")),
      "   ",
      JSON.stringify(assistant("a1", "u1", [{ type: "text", text: "hi back" }])),
    ].join("\n");

    const parsed = parseTranscript(doc);
    expect(parsed.items.map((i) => i.kind)).toEqual(["user-message", "assistant-message"]);
  });

  it("returns an empty transcript for input with no conversation nodes", () => {
    clock = 0;
    const doc = jsonl([
      { type: "ai-title", aiTitle: "Empty", sessionId: "sess-1" },
      {
        ...BASE,
        type: "attachment",
        uuid: "att1",
        parentUuid: null,
        timestamp: ts(),
        attachment: { type: "hook_success" },
      },
    ]);
    const parsed = parseTranscript(doc);
    expect(parsed.items).toEqual([]);
    expect(parsed.messageCount).toBe(0);
  });
});

describe("summarizeTranscript", () => {
  it("produces counts, preview, model and timestamps without a tree walk", () => {
    clock = 0;
    const doc = jsonl([
      { type: "ai-title", aiTitle: "My session", sessionId: "sess-1" },
      userString("u1", null, "  first prompt  "),
      assistant("a1", "u1", [{ type: "text", text: "answer" }]),
      toolResult("u2", "a1", "t1", "ignored"),
      userString("u3", "a1", "second prompt"),
    ]);

    const summary = summarizeTranscript(doc);
    expect(summary.title).toBe("My session");
    expect(summary.firstUserPrompt).toBe("first prompt");
    expect(summary.model).toBe("claude-opus-4-8");
    expect(summary.messageCount).toBe(3); // u1, a1, u3 (tool_result-only node not counted)
    expect(summary.createdAt).not.toBeNull();
    expect(summary.updatedAt).not.toBeNull();
  });
});
