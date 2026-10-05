import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatState, Snapshot, ToolCallState } from "@microsoft/agent-host-protocol";
import { ChatView, markdown, user } from "../support/chat-view.js";
import { connectAhp, Driver, ROOT, type AhpConnection } from "../support/driver.js";
import { openSession } from "../support/harness.js";
import { ScratchDaemon, sleep, until } from "../support/scratch.js";

describe("write path against a scratch daemon", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let ahp: AhpConnection;
  let gates: string;
  let gateCount = 0;
  const views: ChatView[] = [];

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({ name: "writepath" });
    driver = await Driver.open(daemon);
    ahp = await connectAhp(daemon, driver, await driver.newSession());
    gates = mkdtempSync(join(tmpdir(), "ahp-gates-"));
  });

  afterEach(async () => {
    for (const view of views.splice(0)) {
      await view.close().catch(() => undefined);
    }
    driver.permissionAnswer = "allow";
    driver.held.splice(0);
  });

  afterAll(async () => {
    await ahp.session.shutdown();
    driver.close();
    await daemon.destroy();
    rmSync(gates, { recursive: true, force: true });
  });

  async function listed(id: string): Promise<boolean> {
    const result = (await ahp.session.client.request("listSessions", { channel: ROOT } as never)) as unknown as {
      items: Array<{ resource: string }>;
    };
    return result.items.some((item) => item.resource === `ahp-session:/${id}`);
  }

  // A session the driver created and prompted once, so Hydra lists it, opened in AHP.
  async function open(agentId?: string): Promise<ChatView> {
    const id = await driver.newSession("/tmp", agentId);
    await driver.prompt(id, "ping");
    await until("session listed", () => listed(id));
    const view = await ChatView.open(ahp, id);
    views.push(view);
    return view;
  }

  function gate(): { path: string; open(): void } {
    const path = join(gates, `gate-${++gateCount}`);
    return { path, open: () => writeFileSync(path, "") };
  }

  const pendingCalls = (view: ChatView): ToolCallState[] => view.toolCalls().filter((call) => call.status === "pending-confirmation");

  const option = (call: ToolCallState, kind: "approve" | "deny"): string | undefined => {
    const options = (call as { options?: Array<{ id: string; kind: string }> }).options ?? [];
    return options.find((entry) => entry.kind === kind)?.id;
  };

  const finished = (view: ChatView, turnId: string): Promise<ChatState> =>
    view.until(`turn ${turnId} finished`, (chat) => (chat.activeTurn === undefined && chat.turns.some((turn) => turn.id === turnId) ? chat : undefined));

  it("prompts from AHP while another Hydra client watches", async () => {
    const view = await open();
    const from = driver.updates.length;
    await view.startTurn("ahp-t1", "hello");
    const chat = await finished(view, "ahp-t1");
    expect(chat.turns.map((turn) => [turn.id, turn.message.text, turn.state])).toEqual([
      [expect.any(String), "ping", "complete"],
      ["ahp-t1", "hello", "complete"],
    ]);
    expect(markdown(chat.turns[1]!.responseParts)).toBe("pong");
    expect(view.envelopes("chat/turnComplete").filter((e) => (e.action as { turnId: string }).turnId === "ahp-t1")).toHaveLength(1);

    const seen = driver.updates.slice(from).filter((u) => u.sessionId === view.id);
    expect(seen.map((u) => u.update.sessionUpdate)).toContain("prompt_received");
    expect(driver.textSince(view.id, from)).toBe("pong");

    const other = await openSession(ahp.session.ws.url);
    await other.client.initialize({ clientId: `other-${Math.random().toString(16).slice(2)}`, protocolVersions: ["0.9.0"] });
    const fresh = (await other.client.subscribe(view.chatUri)).result.snapshot as Snapshot;
    expect((fresh.state as ChatState).turns.map((turn) => [turn.id, turn.message.text])).toEqual(chat.turns.map((turn) => [turn.id, turn.message.text]));
    await other.client.unsubscribe(view.chatUri);
    await other.shutdown();
  });

  it("confirms a permission from AHP and the agent runs the tool", async () => {
    const view = await open();
    driver.permissionAnswer = "hold";
    await view.startTurn("ahp-ask", "script:ask");
    const [call] = await view.until("pending confirmation", () => (pendingCalls(view).length === 1 ? pendingCalls(view) : undefined));
    expect(call!.toolCallId).toBe("ask-1");
    await view.dispatch({
      type: "chat/toolCallConfirmed",
      turnId: "ahp-ask",
      toolCallId: "ask-1",
      approved: true,
      confirmed: "user-action",
      ...(option(call!, "approve") ? { selectedOptionId: option(call!, "approve") } : {}),
    });
    const chat = await finished(view, "ahp-ask");
    expect(markdown(chat.turns.at(-1)!.responseParts)).toContain("ask-1:allow");
    expect(view.toolCall("ask-1")?.status).toBe("completed");
  });

  it("clears the pending confirmation when another client answers first", async () => {
    const view = await open();
    driver.permissionAnswer = "hold";
    await view.startTurn("ahp-race", "script:ask");
    await view.until("pending confirmation", () => pendingCalls(view).length === 1);
    await until("driver holds the request", () => driver.held.length === 1);
    const asking = view.session().inputNeeded;
    if (asking !== undefined) {
      expect(asking).toHaveLength(1);
    }

    driver.held.shift()!.answer("allow");
    const chat = await finished(view, "ahp-race");
    expect(markdown(chat.turns.at(-1)!.responseParts)).toContain("ask-1:allow");
    expect(pendingCalls(view)).toHaveLength(0);
    expect(view.toolCall("ask-1")?.status).toBe("completed");
    expect(view.session().inputNeeded ?? []).toHaveLength(0);
    expect(await driver.agentLog(view.id)).toContain("permission:ask-1:allow");
  });

  it("answers a parked permission cancelled before cancelling the turn", async () => {
    const view = await open();
    driver.permissionAnswer = "hold";
    await view.startTurn("ahp-cancel", "script:ask");
    await view.until("pending confirmation", () => pendingCalls(view).length === 1);
    await view.dispatch({ type: "chat/turnCancelled", turnId: "ahp-cancel", duration: 1 });
    const chat = await finished(view, "ahp-cancel");
    expect(chat.turns.at(-1)).toMatchObject({ id: "ahp-cancel", state: "cancelled" });
    expect(pendingCalls(view)).toHaveLength(0);

    driver.permissionAnswer = "allow";
    const log = await driver.agentLog(view.id);
    expect(log).toContain("permission:ask-1:cancelled");
    expect(log.indexOf("permission:ask-1:cancelled")).toBeLessThan(log.indexOf("cancel"));
  });

  it("abstains on a permission when no AHP client is subscribed to the chat", async () => {
    const view = await open();
    const release = gate();
    driver.permissionAnswer = "hold";
    await view.startTurn("ahp-away", `script:gate ${release.path} then-ask`);
    await view.until("turn running", (chat) => chat.activeTurn?.id === "ahp-away");
    await view.close();
    views.splice(views.indexOf(view), 1);
    release.open();
    await until("driver holds the request", () => driver.held.length === 1);
    // Anything but -32601 from the extension would already have settled the race.
    await sleep(500);
    driver.held.shift()!.answer("reject");
    await until("turn ended", async () => (await daemon.admin.getSession(view.id)).busy === false);
    driver.permissionAnswer = "allow";
    expect(await driver.agentLog(view.id)).toContain("permission:ask-1:reject");
  });

  it("parks two parallel permission requests separately", async () => {
    const view = await open();
    driver.permissionAnswer = "hold";
    await view.startTurn("ahp-two", "script:ask2");
    const calls = await view.until("two pending confirmations", () => (pendingCalls(view).length === 2 ? pendingCalls(view) : undefined));
    expect(calls.map((call) => call.toolCallId).sort()).toEqual(["ask-1", "ask-2"]);
    const byId = new Map(calls.map((call) => [call.toolCallId, call]));

    await view.dispatch({
      type: "chat/toolCallConfirmed",
      turnId: "ahp-two",
      toolCallId: "ask-2",
      approved: true,
      confirmed: "user-action",
      ...(option(byId.get("ask-2")!, "approve") ? { selectedOptionId: option(byId.get("ask-2")!, "approve") } : {}),
    });
    await view.until("ask-2 confirmed", () => view.toolCall("ask-2")?.status !== "pending-confirmation");
    expect(view.toolCall("ask-1")?.status).toBe("pending-confirmation");

    await view.dispatch({
      type: "chat/toolCallConfirmed",
      turnId: "ahp-two",
      toolCallId: "ask-1",
      approved: false,
      reason: "denied",
      ...(option(byId.get("ask-1")!, "deny") ? { selectedOptionId: option(byId.get("ask-1")!, "deny") } : {}),
    });
    const chat = await finished(view, "ahp-two");
    const text = markdown(chat.turns.at(-1)!.responseParts);
    expect(text).toContain("ask-1:reject");
    expect(text).toContain("ask-2:allow");
    expect(view.session().inputNeeded ?? []).toHaveLength(0);
  });

  it("queues three prompts, then edits one and removes another", async () => {
    const view = await open();
    const release = gate();
    await view.startTurn("ahp-gate", `script:gate ${release.path}`);
    await view.until("turn running", (chat) => chat.activeTurn?.id === "ahp-gate");
    const added = (): Array<Record<string, unknown>> =>
      driver.notifications.filter((n) => n.method === "hydra-acp/prompt_queue/added" && n.params.sessionId === view.id).map((n) => n.params);

    for (const [id, text] of [["q1", "one"], ["q2", "two"], ["q3", "three"]] as const) {
      await view.dispatch({ type: "chat/pendingMessageSet", kind: "queued", id, message: user(text) });
    }
    await until("three queued in Hydra", () => added().filter((entry) => (entry.position as number) >= 1).length === 3);
    expect(view.chat().queuedMessages?.map((entry) => [entry.id, entry.message.text])).toEqual([["q1", "one"], ["q2", "two"], ["q3", "three"]]);

    await view.dispatch({ type: "chat/pendingMessageSet", kind: "queued", id: "q2", message: user("two edited") });
    await until("Hydra updated the entry", () =>
      driver.notifications.some(
        (n) => n.method === "hydra-acp/prompt_queue/updated" && n.params.sessionId === view.id && JSON.stringify(n.params.prompt).includes("two edited"),
      ),
    );
    await view.dispatch({ type: "chat/pendingMessageRemoved", kind: "queued", id: "q3" });
    await until("Hydra cancelled the entry", () =>
      driver.notifications.some((n) => n.method === "hydra-acp/prompt_queue/removed" && n.params.sessionId === view.id && n.params.reason === "cancelled"),
    );
    expect(view.chat().queuedMessages?.map((entry) => [entry.id, entry.message.text])).toEqual([["q1", "one"], ["q2", "two edited"]]);
    expect(added().filter((entry) => (entry.position as number) >= 1)).toHaveLength(3);

    release.open();
    const chat = await view.until("queue drained", (state) =>
      state.activeTurn === undefined && state.turns.length === 4 && (state.queuedMessages ?? []).length === 0 ? state : undefined,
    );
    expect(chat.turns.map((turn) => [turn.message.text, turn.state])).toEqual([
      ["ping", "complete"],
      [`script:gate ${release.path}`, "complete"],
      ["one", "complete"],
      ["two edited", "complete"],
    ]);
    const started = view.envelopes("chat/turnStarted").map((e) => (e.action as { queuedMessageId?: string }).queuedMessageId).filter(Boolean);
    expect(started).toEqual(["q1", "q2"]);
    const prompts = (await driver.agentLog(view.id)).filter((line) => line.startsWith("prompt:"));
    expect(prompts).toEqual(["prompt:ping", `prompt:script:gate ${release.path}`, "prompt:one", "prompt:two edited", "prompt:script:log"]);
  });

  it("steers a running turn on an agent with native steering", async () => {
    const view = await open("fake-steering");
    await view.startTurn("ahp-steer", "script:wait");
    await view.until("agent waiting", (chat) => chat.activeTurn?.id === "ahp-steer" && markdown(chat.activeTurn.responseParts) === "waiting ");
    await view.dispatch({ type: "chat/pendingMessageSet", kind: "steering", id: "s1", message: user("go left") });
    await view.until("steering consumed", () =>
      view.envelopes("chat/pendingMessageRemoved").some((e) => (e.action as { kind: string; id: string }).kind === "steering" && (e.action as { id: string }).id === "s1"),
    );
    const chat = await finished(view, "ahp-steer");
    expect(chat.turns.map((turn) => turn.id)).toEqual([expect.any(String), "ahp-steer"]);
    expect(chat.turns.at(-1)).toMatchObject({ state: "complete" });
    expect(markdown(chat.turns.at(-1)!.responseParts)).toContain("steered:go left");
    expect(chat.steeringMessage).toBeUndefined();
    expect(await driver.agentLog(view.id)).toContain("steer:go left");
  });

  it("steers a running turn on an agent without native steering as cancel and resubmit", async () => {
    const view = await open();
    await view.startTurn("ahp-steer", "script:wait");
    await view.until("agent waiting", (chat) => chat.activeTurn?.id === "ahp-steer" && markdown(chat.activeTurn.responseParts) === "waiting ");
    await view.dispatch({ type: "chat/pendingMessageSet", kind: "steering", id: "s1", message: user("go right") });
    const chat = await view.until("steered turn done", (state) =>
      state.activeTurn === undefined && state.turns.length === 3 ? state : undefined,
    );
    expect(chat.turns.map((turn) => [turn.message.text, turn.state])).toEqual([
      ["ping", "complete"],
      ["script:wait", "cancelled"],
      ["go right", "complete"],
    ]);
    expect(chat.turns[1]!.id).toBe("ahp-steer");
    expect(markdown(chat.turns[2]!.responseParts)).toBe("pong");
    expect(chat.steeringMessage).toBeUndefined();
    const log = await driver.agentLog(view.id);
    expect(log.slice(1, 4)).toEqual(["prompt:script:wait", "cancel", "prompt:go right"]);
  });

  it("holds a steering message sent while idle until the next turn starts", async () => {
    const view = await open("fake-steering");
    const before = driver.kinds(view.id).length;
    await view.dispatch({ type: "chat/pendingMessageSet", kind: "steering", id: "s1", message: user("go up") });
    await sleep(600);
    expect(view.chat().steeringMessage).toMatchObject({ id: "s1", message: { text: "go up" } });
    expect(view.chat().activeTurn).toBeUndefined();
    expect(driver.kinds(view.id).slice(before)).not.toContain("prompt_received");
    expect((await daemon.admin.getSession(view.id)).busy).toBeFalsy();

    await view.startTurn("ahp-next", "script:wait");
    const chat = await finished(view, "ahp-next");
    expect(markdown(chat.turns.at(-1)!.responseParts)).toContain("steered:go up");
    expect(chat.steeringMessage).toBeUndefined();
    expect(chat.turns).toHaveLength(2);
    const log = await driver.agentLog(view.id);
    expect(log.slice(1, 3)).toEqual(["prompt:script:wait", "steer:go up"]);
  });
});
