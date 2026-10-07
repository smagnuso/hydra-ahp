import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { ChatMapper, type Frame } from "../src/bridge/mapping.js";
import { reduceChat } from "../src/bridge/replay.js";
import { blankChat, foldRecorded } from "./support/oracle.js";

let tick = 1_000_000;
const frame = (update: Record<string, unknown>, at = (tick += 10)): Frame => ({ update, recordedAt: at, seq: at });
const prompt = (id = "m1", text = "go") => frame({ sessionUpdate: "prompt_received", messageId: id, prompt: [{ type: "text", text }], sentBy: { clientId: "c" } });
const say = (text: string) => frame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const think = (text: string) => frame({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
const done = (stopReason = "end_turn") => frame({ sessionUpdate: "turn_complete", stopReason });
const call = (update: Record<string, unknown>) => frame({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Run", ...update });
const change = (update: Record<string, unknown>) => frame({ sessionUpdate: "tool_call_update", toolCallId: "c1", ...update });

const types = (frames: Frame[]): string[] => foldRecorded(frames).actions.map((a) => String(a.type));

describe("chat mapping", () => {
  it("opens a part before streaming into it and appends to the open run", () => {
    expect(types([prompt(), say("a"), say("b")])).toEqual(["chat/turnStarted", "chat/responsePart", "chat/delta", "chat/delta"]);
    expect(types([prompt(), think("a"), say("b")])).toEqual([
      "chat/turnStarted",
      "chat/responsePart",
      "chat/reasoning",
      "chat/responsePart",
      "chat/delta",
    ]);
  });

  it("holds a whitespace-only run and leads the next part with it", () => {
    const folded = foldRecorded([prompt(), say("\n"), say("  "), call({ status: "in_progress" }), say("\n"), say("text")]);
    const parts = folded.state.activeTurn!.responseParts.map((part) => part.kind);
    expect(parts).toEqual(["toolCall", "markdown"]);
    expect((folded.state.activeTurn!.responseParts[1] as { content: string }).content).toBe("\ntext");
  });

  it("synthesizes a start for a tool_call_update that arrives first", () => {
    const folded = foldRecorded([prompt(), change({ status: "completed", title: "Late" })]);
    expect(folded.actions.map((a) => a.type)).toEqual(["chat/turnStarted", "chat/toolCallStart", "chat/toolCallReady", "chat/toolCallComplete"]);
    expect(folded.ignored).toEqual([]);
  });

  it("holds the ready while the call is pending and re-readies on late arguments", () => {
    const folded = foldRecorded([
      prompt(),
      call({ status: "pending", rawInput: {} }),
      change({ status: "in_progress" }),
      change({ rawInput: { command: "ls" } }),
      change({ status: "completed" }),
    ]);
    expect(folded.actions.map((a) => a.type)).toEqual([
      "chat/turnStarted",
      "chat/toolCallStart",
      "chat/toolCallReady",
      "chat/toolCallReady",
      "chat/toolCallComplete",
    ]);
    expect(folded.actions[2]).toMatchObject({ toolInput: "{}" });
    expect(folded.actions[3]).toMatchObject({ toolInput: '{"command":"ls"}' });
    expect(folded.ignored).toEqual([]);
  });

  it("does not claim nobody is asked about a call a permission is pending on", () => {
    const mapper = new ChatMapper();
    mapper.map(prompt());
    mapper.map(call({ status: "pending" }));
    mapper.noteAsked("c1");
    expect(mapper.map(change({ status: "in_progress" })).map((a) => a.type)).toEqual([]);
  });

  it("keeps content that arrives before the ready and shows it once the call runs", () => {
    const text = [{ type: "content", content: { type: "text", text: "out" } }];
    const folded = foldRecorded([prompt(), call({ status: "pending", content: text }), change({ status: "in_progress" })]);
    expect(folded.actions.map((a) => a.type).slice(-2)).toEqual(["chat/toolCallReady", "chat/toolCallContentChanged"]);
    expect(folded.ignored).toEqual([]);
  });

  it("falls back to rawOutput for a failed call with no content", () => {
    const folded = foldRecorded([prompt(), call({ status: "in_progress" }), change({ status: "failed", rawOutput: "boom" })]);
    const part = folded.state.activeTurn!.responseParts[0] as { toolCall: Record<string, unknown> };
    expect(part.toolCall).toMatchObject({ status: "completed", success: false, error: { message: "boom" } });
  });

  it("keeps one plan call per turn and completes it at the turn end", () => {
    const plan = (status: string) => frame({ sessionUpdate: "plan", entries: [{ content: "step", priority: "high", status }] });
    const folded = foldRecorded([prompt("m9"), plan("pending"), plan("in_progress"), done()]);
    const turn = folded.state.turns[0]!;
    const calls = turn.responseParts.filter((part) => part.kind === "toolCall");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolCall: { toolCallId: "m9:plan", status: "completed", content: [{ text: "▶ step" }] } });
    expect(calls[0]).toMatchObject({ toolCall: { pastTenseMessage: { markdown: "**Plan**\n\n- **▶ step**" } } });
    expect(folded.ignored).toEqual([]);
  });

  it("shows the whole plan in the plan row while it runs", () => {
    const plan = (statuses: string[]) => frame({ sessionUpdate: "plan", entries: statuses.map((status, i) => ({ content: `step ${i}`, priority: "high", status })) });
    const folded = foldRecorded([prompt("m8"), plan(["in_progress", "pending"]), plan(["completed", "in_progress"])]);
    const part = folded.state.activeTurn!.responseParts[0] as { toolCall: Record<string, unknown> };
    expect(part.toolCall).toMatchObject({ status: "running", invocationMessage: { markdown: "**Plan**\n\n- ✓ step 0\n- **▶ step 1**" } });
  });

  it("shows opencode's todowrite list as the turn's plan instead of as a tool call", () => {
    const todos = [
      { content: "inspect", status: "completed", priority: "high" },
      { content: "analyze", status: "in_progress", priority: "high" },
      { content: "summarize", status: "pending", priority: "medium" },
    ];
    const folded = foldRecorded([
      prompt("m7"),
      call({ toolCallId: "t1", title: "todowrite", status: "pending", rawInput: {} }),
      change({ toolCallId: "t1", title: "todowrite", status: "in_progress", rawInput: { todos: todos.slice(0, 2) } }),
      change({ toolCallId: "t1", title: "3 todos", status: "completed", content: [{ type: "content", content: { type: "text", text: JSON.stringify(todos) } }], rawOutput: { output: JSON.stringify(todos), metadata: { todos } } }),
      done(),
    ]);
    const calls = folded.state.turns[0]!.responseParts.filter((part) => part.kind === "toolCall");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      toolCall: {
        toolCallId: "m7:plan",
        status: "completed",
        content: [{ text: "✓ inspect" }, { text: "▶ analyze" }, { text: "○ summarize" }],
      },
    });
    expect(folded.ignored).toEqual([]);
  });

  it("marks shell commands as terminal calls for VS Code, and only those", () => {
    const shell = foldRecorded([
      prompt(),
      call({ toolCallId: "sh", title: "ls", kind: "execute", status: "in_progress", rawInput: { command: "ls" } }),
      call({ toolCallId: "argv", title: "ls", kind: "execute", status: "in_progress", rawInput: { command: ["ls", "-l"] } }),
      call({ toolCallId: "rd", title: "Read", kind: "read", status: "in_progress", rawInput: { path: "a" } }),
    ]);
    const meta = (id: string) =>
      (shell.state.activeTurn!.responseParts.find((part) => (part as { toolCall?: { toolCallId: string } }).toolCall?.toolCallId === id) as {
        toolCall: { _meta?: Record<string, unknown> };
      }).toolCall._meta ?? {};
    expect(meta("sh")).toMatchObject({ toolKind: "terminal", language: "shellscript" });
    expect(meta("argv").toolKind).toBeUndefined();
    expect(meta("rd").toolKind).toBeUndefined();
  });

  it("passes a call's described purpose through as its intention", () => {
    const folded = foldRecorded([
      prompt(),
      call({ toolCallId: "sh", title: "git log", kind: "execute", status: "in_progress", rawInput: { command: "git log -1", description: "Show the last commit" } }),
      call({ toolCallId: "rd", title: "Read", kind: "read", status: "in_progress", rawInput: { path: "a" } }),
    ]);
    const intention = (id: string) =>
      (folded.state.activeTurn!.responseParts.find((part) => (part as { toolCall?: { toolCallId: string } }).toolCall?.toolCallId === id) as {
        toolCall: { intention?: string };
      }).toolCall.intention;
    expect(intention("sh")).toBe("Show the last commit");
    expect(intention("rd")).toBeUndefined();
  });

  it("shows a wake-up Hydra could not attribute as a notification, not an empty request", () => {
    const turn = foldRecorded([frame({ sessionUpdate: "_hydra_turn_started", messageId: "w1", _meta: { "hydra-acp": { unsolicited: true } } }), say("hi")]).state.activeTurn!;
    expect(turn.message).toMatchObject({ origin: { kind: "systemNotification" }, text: "The agent continued on its own" });
  });

  it("links a prompt another session sent back to that session, when it is listed", () => {
    const mapper = new ChatMapper({ sourceOf: (id) => (id === "hs_known" ? { session: "claude:/hs_known", chat: "ahp-chat://default/x" } : undefined) });
    const sent = (fromSession: string) =>
      mapper.map(frame({ sessionUpdate: "prompt_received", messageId: `m-${fromSession}`, prompt: [{ type: "text", text: "hi" }], sentBy: { fromSession } }));
    const started = (actions: Array<Record<string, unknown>>) =>
      actions.find((action) => action.type === "chat/turnStarted") as { message: { _meta?: Record<string, unknown> } };
    expect(started(sent("hs_known")).message._meta?.["vscode.chat.delegation"]).toEqual({ sourceSession: "claude:/hs_known", sourceChat: "ahp-chat://default/x" });
    mapper.map(done());
    expect(started(sent("hs_gone")).message._meta?.["vscode.chat.delegation"]).toBeUndefined();
  });

  it("ends turns by stop reason with a duration each time", () => {
    const run = (stop: string) => foldRecorded([prompt("a"), say("x"), done(stop)]).state.turns[0]!;
    expect(run("end_turn")).toMatchObject({ state: "complete", duration: 20 });
    expect(run("max_tokens").state).toBe("complete");
    expect(run("cancelled").state).toBe("cancelled");
    expect(run("refusal").state).toBe("error");
    expect(run("error").responseParts.at(-1)).toMatchObject({ kind: "error" });
  });

  it("starts agent-initiated turns from _hydra_turn_started and ends them with the reported duration", () => {
    const started = frame({ sessionUpdate: "_hydra_turn_started", messageId: "auto1", _meta: { "hydra-acp": { unsolicited: true, cause: { label: "build" } } } });
    const ended = frame({ sessionUpdate: "_hydra_turn_ended", messageId: "e", startedMessageId: "auto1", durationMs: 2100, _meta: { "hydra-acp": { reason: "completed" } } });
    const turn = foldRecorded([started, say("hi"), ended]).state.turns[0]!;
    expect(turn).toMatchObject({ id: "auto1", duration: 2100, state: "complete", message: { origin: { kind: "systemNotification" }, text: "build" } });
    const cancelled = frame({ sessionUpdate: "_hydra_turn_ended", messageId: "e", startedMessageId: "auto1", durationMs: 5, _meta: { "hydra-acp": { reason: "cancelled" } } });
    expect(foldRecorded([started, cancelled]).state.turns[0]!.state).toBe("cancelled");
  });

  it("starts a headless turn when content arrives with no turn open", () => {
    const folded = foldRecorded([say("tail of a long turn"), done()]);
    expect(folded.state.turns).toHaveLength(1);
    expect(folded.state.turns[0]!.message.text).toBe("");
  });

  it("ignores the compat user_message_chunk that duplicates prompt_received", () => {
    const compat = frame({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "go" }, _meta: { "hydra-acp": { compatFor: "prompt_received" } } });
    expect(types([prompt(), compat])).toEqual(["chat/turnStarted"]);
  });

  it("opens an active turn from busy and turnStartedAt when no start event was seen", () => {
    const mapper = new ChatMapper();
    let state: ChatState = blankChat();
    state = reduceChat(state, mapper.openFromBusy(5_000));
    expect(state.activeTurn).toMatchObject({ startedAt: "1970-01-01T00:00:05.000Z" });
    expect(state.status & 8).toBe(8);
    state = reduceChat(state, mapper.map(frame({ sessionUpdate: "turn_complete", stopReason: "end_turn" }, 9_000)));
    expect(state.turns[0]).toMatchObject({ duration: 4000, state: "complete" });
  });

  it("mirrors queued prompts as pending messages and consumes one when its turn starts", () => {
    const mapper = new ChatMapper();
    const added = (id: string, position: number) => mapper.queueAdded({ messageId: id, position, prompt: [{ type: "text", text: id }] });
    expect(added("head", 0)).toEqual([]);
    const set = added("q1", 1);
    expect(set).toEqual([{ type: "chat/pendingMessageSet", kind: "queued", id: "q1", message: { text: "q1", origin: { kind: "user" } } }]);
    const started = mapper.map(prompt("q1", "q1"));
    expect(started[0]).toMatchObject({ type: "chat/turnStarted", queuedMessageId: "q1" });
    expect(mapper.queueRemoved({ messageId: "q1", reason: "started" })).toEqual([]);
    added("q2", 1);
    expect(mapper.queueRemoved({ messageId: "q2", reason: "cancelled" })).toEqual([
      { type: "chat/pendingMessageRemoved", kind: "queued", id: "q2" },
    ]);
  });

  it("reconciles the queue from the attach snapshot", () => {
    const mapper = new ChatMapper();
    mapper.queueAdded({ messageId: "old", position: 1, prompt: [] });
    const actions = mapper.syncQueue([
      { messageId: "head", position: 0, prompt: [] },
      { messageId: "new", position: 1, prompt: [{ type: "text", text: "n" }] },
    ]);
    expect(actions.map((a) => `${a.type}:${a.id}`)).toEqual(["chat/pendingMessageRemoved:old", "chat/pendingMessageSet:new"]);
  });

  it("closes the open turn as cancelled when the session closes", () => {
    const mapper = new ChatMapper();
    mapper.map(prompt());
    const actions = mapper.closeActive("cancelled", 1_000_050);
    expect(actions[0]).toMatchObject({ type: "chat/turnCancelled" });
  });

  it("splits the running turn at a steer so the steering message shows", () => {
    const steered = frame({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "go left" }, _meta: { "hydra-acp": { steered: true } } });
    const { state } = foldRecorded([prompt("m1", "go"), say("working "), steered, say("turning"), done()]);
    expect(state.turns.map((turn) => [turn.message.text, turn.state])).toEqual([
      ["go", "complete"],
      ["go left", "complete"],
    ]);
    expect(state.turns.map((turn) => turn.responseParts.map((part) => (part as { content?: string }).content))).toEqual([["working "], ["turning"]]);
  });

  it("ends a steered split when Hydra ends the turn it started", () => {
    const mapper = new ChatMapper();
    mapper.map(frame({ sessionUpdate: "_hydra_turn_started", messageId: "auto1" }));
    mapper.steer("s", 5, { text: "go left", origin: { kind: "user" } });
    expect(mapper.activeOriginId).toBe("auto1");
    const ended = mapper.map(frame({ sessionUpdate: "_hydra_turn_ended", messageId: "e", startedMessageId: "auto1", _meta: { "hydra-acp": { reason: "completed" } } }));
    expect(ended).toContainEqual(expect.objectContaining({ type: "chat/turnComplete", turnId: "s" }));
    expect(mapper.activeTurnId).toBeUndefined();
  });

  it("holds a steer back while a confirmation is waiting in the turn", () => {
    const mapper = new ChatMapper();
    mapper.map(prompt());
    mapper.map(call({ status: "pending" }));
    mapper.confirmationReady({ toolCallId: "c1", title: "Run" }, []);
    expect(mapper.steer("s", 5, { text: "go left", origin: { kind: "user" } }, "p1")).toEqual([]);
    mapper.noteConfirmed("c1");
    const next = mapper.map(change({ status: "completed" }));
    expect(next.map((action) => action.type)).toContain("chat/turnStarted");
    expect(next.find((action) => action.type === "chat/turnStarted")).toMatchObject({ turnId: "s", queuedMessageId: "p1" });
    expect(mapper.activeOriginId).toBe("m1");
  });

  it("stamps the session's current model on the turns it opens", () => {
    const mapper = new ChatMapper();
    expect(mapper.map(prompt("m1"))[0]).toMatchObject({ type: "chat/turnStarted", message: { text: "go" } });
    expect((mapper.map(prompt("m1"))[1] as { message: { model?: unknown } }).message.model).toBeUndefined();
    mapper.model = "gpt-6-luna";
    const started = mapper.map(prompt("m2")).find((action) => action.type === "chat/turnStarted");
    expect(started).toMatchObject({ message: { model: { id: "gpt-6-luna" } } });
  });
  it("shows a tool's images: inline data as embedded content, a saved file as a resource", () => {
    const png = "iVBORw0KGgo=";
    const folded = foldRecorded([
      prompt(),
      call({ status: "in_progress" }),
      change({
        status: "completed",
        content: [
          { type: "content", content: { type: "image", mimeType: "image/png", data: png } },
          { type: "content", content: { type: "resource_link", name: "/tmp/shot.png", uri: "/tmp/shot.png" } },
          { type: "content", content: { type: "resource_link", name: "notes.txt", uri: "/tmp/notes.txt" } },
        ],
      }),
    ]);
    const complete = folded.actions.find((a) => a.type === "chat/toolCallComplete") as { result: { content: unknown[] } };
    expect(complete.result.content).toEqual([
      { type: "embeddedResource", data: png, contentType: "image/png" },
      { type: "resource", uri: pathToFileURL("/tmp/shot.png").href, contentType: "image/png" },
    ]);
  });

  it("gives a replayed prompt its images back as attachments", () => {
    const folded = foldRecorded([
      frame({
        sessionUpdate: "prompt_received",
        messageId: "m1",
        prompt: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        ],
        sentBy: { clientId: "c" },
      }),
    ]);
    expect(folded.state.activeTurn?.message).toMatchObject({
      text: "look",
      attachments: [{ type: "embeddedResource", label: "Image", displayKind: "image", data: "iVBORw0KGgo=", contentType: "image/png" }],
    });
  });
  it("inlines a saved image it can read, and links one it cannot", () => {
    const saved = (uri: string) =>
      change({ status: "completed", content: [{ type: "content", content: { type: "resource_link", name: uri, uri } }] });
    const shown = (path: string): unknown => {
      const folded = foldRecorded([prompt(), call({ status: "in_progress" }), saved(path)], {
        mapper: { readImage: (file) => (file.endsWith("shot.png") ? "iVBORw0KGgo=" : undefined) },
      });
      return (folded.actions.find((a) => a.type === "chat/toolCallComplete") as { result: { content: unknown[] } }).result.content;
    };
    expect(shown("/tmp/shot.png")).toEqual([{ type: "embeddedResource", data: "iVBORw0KGgo=", contentType: "image/png" }]);
    expect(shown("/tmp/huge.png")).toEqual([{ type: "resource", uri: pathToFileURL("/tmp/huge.png").href, contentType: "image/png" }]);
  });

  it("carries an image file inline once, linking it from later calls", () => {
    const view = (id: string) =>
      frame({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "content", content: { type: "resource_link", name: "/tmp/shot.png", uri: "/tmp/shot.png" } }] });
    const folded = foldRecorded([prompt(), view("a"), view("a"), view("b")], { mapper: { readImage: () => "iVBORw0KGgo=" } });
    const kinds = folded.state.activeTurn!.responseParts.map((part) => ((part as { toolCall?: { content?: Array<{ type: string }> } }).toolCall?.content ?? []).map((c) => c.type));
    expect(kinds).toEqual([["embeddedResource"], ["resource"]]);
  });
});
