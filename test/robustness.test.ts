import { afterEach, describe, expect, it } from "vitest";
import type { ActionEnvelope, ChatState, Snapshot } from "@microsoft/agent-host-protocol";
import type { Json } from "../src/bridge/turns.js";
import { ReducerOracle } from "./support/oracle.js";
import { startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";
import { act, sleep, type Session } from "./support/harness.js";
import { chatOf, sessionOf } from "./support/chat-uri.js";

const CHAT = chatOf("h1");
const SESSION = sessionOf("h1");
const ROOT = "ahp-root://";

const OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

describe("turn accounting around steering, cancels and agent-initiated turns", () => {
  let harness: BridgeHarness;

  afterEach(async () => {
    await harness.stop();
  });

  async function open(): Promise<{ session: Session; oracle: ReducerOracle }> {
    const session = await harness.connect();
    await session.client.initialize({ clientId: `c-${Math.random().toString(16).slice(2)}`, protocolVersions: ["0.9.0"], initialSubscriptions: [ROOT] });
    const oracle = new ReducerOracle();
    oracle.applySnapshot((await session.client.subscribe(SESSION)).result.snapshot as Snapshot);
    oracle.applySnapshot((await session.client.subscribe(CHAT)).result.snapshot as Snapshot);
    return { session, oracle };
  }

  async function dispatch(session: Session, action: Record<string, unknown>): Promise<ActionEnvelope> {
    const { clientSeq } = session.client.dispatch(CHAT, act(action));
    return session.waitFor((envelope) => envelope.origin?.clientSeq === clientSeq);
  }

  function chat(session: Session, oracle: ReducerOracle): ChatState {
    for (const envelope of session.events.splice(0)) {
      oracle.applyEnvelope(envelope);
    }
    return oracle.state(CHAT) as ChatState;
  }

  function hydra(update: Json, recordedAt?: number): void {
    harness.hydra.listener!.update({ update, ...(recordedAt !== undefined ? { recordedAt } : {}) });
  }

  const agentStarted = (messageId: string): Json => ({
    sessionUpdate: "_hydra_turn_started",
    messageId,
    _meta: { "hydra-acp": { unsolicited: true } },
  });

  const agentEnded = (startedMessageId: string, durationMs: number): Json => ({
    sessionUpdate: "_hydra_turn_ended",
    messageId: `end-${startedMessageId}`,
    startedMessageId,
    durationMs,
    _meta: { "hydra-acp": { unsolicited: true, reason: "completed" } },
  });

  const said = (body: string): Json => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: body } });

  it("books a detached steering turn once, through Hydra's own turn pair", async () => {
    harness = await startBridgeHarness((fake) => {
      fake.steering = { outcome: "startedNewTurn", detached: true };
    });
    const { session, oracle } = await open();
    hydra(agentStarted("a1"), 1_000);
    await session.waitFor((envelope) => envelope.action.type === "chat/turnStarted");

    const echo = await dispatch(session, {
      type: "chat/pendingMessageSet",
      kind: "steering",
      id: "s1",
      message: { text: "change course", origin: { kind: "user" } },
    });
    expect(echo.rejectionReason).toBeUndefined();
    await session.waitFor((envelope) => envelope.action.type === "chat/pendingMessageRemoved");
    expect(harness.hydra.writes.map((write) => write.method)).toEqual(["_session/steering"]);

    hydra(agentEnded("a1", 400), 1_400);
    hydra(agentStarted("a2"), 1_500);
    hydra(said("redirected"), 1_600);
    hydra(agentEnded("a2", 250), 1_750);
    await session.waitFor((envelope) => envelope.action.type === "chat/turnComplete" && (envelope.action as { turnId?: string }).turnId === "a2");

    const state = chat(session, oracle);
    expect(state.activeTurn).toBeUndefined();
    expect(state.steeringMessage).toBeUndefined();
    expect(state.turns.map((turn) => [turn.id, turn.state, turn.duration])).toEqual([
      ["a1", "complete", 400],
      ["a2", "complete", 250],
    ]);
    expect(state.turns.map((turn) => turn.message.origin.kind)).toEqual(["agent", "agent"]);
  });

  it("puts the agent's answer to an injected steer in the steered turn even when it beats Hydra's reply", async () => {
    harness = await startBridgeHarness();
    const { session, oracle } = await open();
    hydra(agentStarted("a1"), 1_000);
    hydra(said("working"), 1_100);
    await session.waitFor((envelope) => envelope.action.type === "chat/delta");
    harness.hydra.sessions.steer = async () => {
      hydra(said("steered answer"), 1_200);
      await sleep(30);
      return { outcome: "injected" };
    };

    await dispatch(session, {
      type: "chat/pendingMessageSet",
      kind: "steering",
      id: "s1",
      message: { text: "change course", origin: { kind: "user" } },
    });
    hydra(agentEnded("a1", 400), 1_400);
    await session.waitFor((envelope) => envelope.action.type === "chat/turnComplete" && (envelope.action as { turnId?: string }).turnId === "steer-s1");

    const text = (turn: ChatState["turns"][number]) =>
      turn.responseParts.map((part) => (part.kind === "markdown" ? part.content : "")).join("");
    const state = chat(session, oracle);
    expect(state.turns.map((turn) => [turn.id, turn.message.text, text(turn)])).toEqual([
      ["a1", "", "working"],
      ["steer-s1", "change course", "steered answer"],
    ]);
  });

  it("decides a cancel on the turns Hydra reported while a steer was in flight, so it never reaches the next turn", async () => {
    harness = await startBridgeHarness();
    const { session } = await open();
    hydra(agentStarted("a1"), 1_000);
    await session.waitFor((envelope) => envelope.action.type === "chat/turnStarted");
    let reply = (_result: { outcome: string }): void => undefined;
    harness.hydra.sessions.steer = () =>
      new Promise((resolve) => {
        reply = resolve as typeof reply;
      });
    await dispatch(session, {
      type: "chat/pendingMessageSet",
      kind: "steering",
      id: "s1",
      message: { text: "change course", origin: { kind: "user" } },
    });
    hydra(agentEnded("a1", 400), 1_400);
    hydra(agentStarted("a2"), 1_500);

    const cancelled = dispatch(session, { type: "chat/turnCancelled", turnId: "a1", duration: 1 });
    await sleep(50);
    // The new turn's start retries the steer, which the cancel waits out too.
    harness.hydra.sessions.steer = async () => ({ outcome: "promptRequired" });
    reply({ outcome: "promptRequired" });
    expect((await cancelled).rejectionReason).toBeDefined();
    await sleep(50);
    expect(harness.hydra.writes.map((write) => write.method)).not.toContain("session/cancel");
  });

  it("waits out a steer retried as the first one settles before deciding a cancel", async () => {
    harness = await startBridgeHarness();
    const { session } = await open();
    hydra(agentStarted("a1"), 1_000);
    await session.waitFor((envelope) => envelope.action.type === "chat/turnStarted");
    const replies: Array<(result: { outcome: string }) => void> = [];
    harness.hydra.sessions.steer = () =>
      new Promise((resolve) => {
        replies.push(resolve as (result: { outcome: string }) => void);
      });
    await dispatch(session, {
      type: "chat/pendingMessageSet",
      kind: "steering",
      id: "s1",
      message: { text: "change course", origin: { kind: "user" } },
    });
    const cancelled = dispatch(session, { type: "chat/turnCancelled", turnId: "a1", duration: 1 });
    // Past the retry interval, the held chunk's delivery steers again and so holds again.
    await sleep(600);
    hydra(said("still going"), 1_100);
    replies[0]!({ outcome: "promptRequired" });
    await sleep(50);
    expect(replies).toHaveLength(2);
    hydra(agentEnded("a1", 400), 1_400);
    hydra(agentStarted("a2"), 1_500);
    await sleep(50);
    expect(harness.hydra.writes.map((write) => write.method)).not.toContain("session/cancel");
    harness.hydra.sessions.steer = async () => ({ outcome: "promptRequired" });
    replies[1]!({ outcome: "promptRequired" });
    expect((await cancelled).rejectionReason).toBeDefined();
    await sleep(50);
    expect(harness.hydra.writes.map((write) => write.method)).not.toContain("session/cancel");
  });

  it("stays attached until a steer sent just before the client left has settled", async () => {
    harness = await startBridgeHarness();
    const { session } = await open();
    hydra(agentStarted("a1"), 1_000);
    await session.waitFor((envelope) => envelope.action.type === "chat/turnStarted");
    let reply = (_result: { outcome: string }): void => undefined;
    harness.hydra.sessions.steer = () =>
      new Promise((resolve) => {
        reply = resolve as typeof reply;
      });
    await dispatch(session, {
      type: "chat/pendingMessageSet",
      kind: "steering",
      id: "s1",
      message: { text: "change course", origin: { kind: "user" } },
    });
    await session.client.unsubscribe(CHAT);
    await session.client.unsubscribe(SESSION);
    await sleep(100);
    expect(harness.hydra.detaches).toEqual([]);
    reply({ outcome: "injected" });
    await sleep(100);
    expect(harness.hydra.detaches).toEqual(["h1"]);
  });

  it("stays attached until a prompt sent just before the client left has run", async () => {
    harness = await startBridgeHarness();
    const { session } = await open();
    await dispatch(session, { type: "chat/turnStarted", turnId: "t-away", startedAt: new Date().toISOString(), message: { text: "go", origin: { kind: "user" } } });
    await session.client.unsubscribe(CHAT);
    await session.client.unsubscribe(SESSION);
    await sleep(100);
    expect(harness.hydra.prompts).toHaveLength(1);
    expect(harness.hydra.detaches).toEqual([]);
    harness.hydra.prompts[0]!.end("end_turn");
    await sleep(100);
    expect(harness.hydra.detaches).toEqual(["h1"]);
  });

  it("refuses to cancel a turn that is not running and sends Hydra no cancel", async () => {
    harness = await startBridgeHarness();
    const { session } = await open();
    const idle = await dispatch(session, { type: "chat/turnCancelled", turnId: "nope", duration: 1 });
    expect(idle.rejectionReason).toBeDefined();
    hydra(agentStarted("a1"));
    await session.waitFor((envelope) => envelope.action.type === "chat/turnStarted");
    const wrong = await dispatch(session, { type: "chat/turnCancelled", turnId: "other", duration: 1 });
    expect(wrong.rejectionReason).toBeDefined();
    expect(harness.hydra.writes).toEqual([]);
  });

  it("never shows a permission request another client answers while it is held", async () => {
    harness = await startBridgeHarness(undefined, { permissionDelayMs: 300 });
    const { session } = await open();
    await dispatch(session, { type: "chat/turnStarted", turnId: "t1", startedAt: new Date().toISOString(), message: { text: "go", origin: { kind: "user" } } });
    const answer = harness.hydra.listener!.permission!({ sessionId: "h1", toolCall: { toolCallId: "c1", title: "run ls", status: "pending" }, options: OPTIONS });
    await sleep(50);
    hydra({ sessionUpdate: "permission_resolved", toolCallId: "c1", chosenOptionId: "allow" });
    await expect(answer).rejects.toMatchObject({ code: -32601 });
    await sleep(400);
    expect(session.events.some((envelope) => envelope.action.type === "chat/toolCallReady" || envelope.action.type === "chat/toolCallConfirmed")).toBe(false);
  });

  it("shows a held permission request once the delay passes with nobody answering", async () => {
    harness = await startBridgeHarness(undefined, { permissionDelayMs: 300 });
    const { session, oracle } = await open();
    await dispatch(session, { type: "chat/turnStarted", turnId: "t1", startedAt: new Date().toISOString(), message: { text: "go", origin: { kind: "user" } } });
    const asked = Date.now();
    const answer = harness.hydra.listener!.permission!({ sessionId: "h1", toolCall: { toolCallId: "c1", title: "run ls", status: "pending" }, options: OPTIONS });
    await session.waitFor((envelope) => envelope.action.type === "chat/toolCallReady", 2000);
    expect(Date.now() - asked).toBeGreaterThanOrEqual(250);
    const confirmed = await dispatch(session, { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "c1", approved: true, confirmed: "user-action" });
    expect(confirmed.rejectionReason).toBeUndefined();
    expect(await answer).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(chat(session, oracle).activeTurn?.id).toBe("t1");
  });

  it("leaves alone a queued turn that started while a cancel waited on its permissions", async () => {
    harness = await startBridgeHarness();
    const { session, oracle } = await open();
    await dispatch(session, { type: "chat/turnStarted", turnId: "t1", startedAt: new Date().toISOString(), message: { text: "go", origin: { kind: "user" } } });
    const answer = harness.hydra.listener!.permission!({
      sessionId: "h1",
      toolCall: { toolCallId: "c1", title: "run ls", status: "pending" },
      options: OPTIONS,
    });
    await session.waitFor((envelope) => envelope.action.type === "chat/toolCallReady");

    const cancelled = await dispatch(session, { type: "chat/turnCancelled", turnId: "t1", duration: 1 });
    expect(cancelled.rejectionReason).toBeUndefined();
    expect(await answer).toEqual({ outcome: { outcome: "cancelled" } });
    hydra({ sessionUpdate: "prompt_received", messageId: "m2", prompt: [{ type: "text", text: "next" }] });
    await sleep(700);

    expect(harness.hydra.writes.map((write) => write.method)).toEqual(["session/prompt"]);
    const state = chat(session, oracle);
    expect(state.turns.map((turn) => [turn.id, turn.state])).toEqual([["t1", "cancelled"]]);
    expect(state.activeTurn?.id).toBe("m2");

    harness.hydra.prompts.shift()!.end("cancelled");
    await sleep(20);
    expect(chat(session, oracle).activeTurn?.id).toBe("m2");
  });

  it("closes a turn left open when Hydra closes the session, and runs the next prompt on a fresh attach", async () => {
    harness = await startBridgeHarness();
    const { session, oracle } = await open();
    hydra(agentStarted("a1"));
    await session.waitFor((envelope) => envelope.action.type === "chat/turnStarted");
    harness.hydra.listener!.closed();
    await session.waitFor((envelope) => envelope.action.type === "chat/turnCancelled");
    expect(chat(session, oracle).activeTurn).toBeUndefined();
    expect(harness.hydra.listener).toBeUndefined();

    harness.hydra.newest = {
      entries: [{ method: "session/update", params: { sessionId: "h1", update: agentStarted("a1") }, seq: 1, recordedAt: 1_000 }],
      hasMore: false,
    } as never;
    const echo = await dispatch(session, { type: "chat/turnStarted", turnId: "t2", startedAt: new Date().toISOString(), message: { text: "again", origin: { kind: "user" } } });
    expect(echo.rejectionReason).toBeUndefined();
    expect(harness.hydra.attaches).toHaveLength(2);
    expect(harness.hydra.detaches).toEqual([]);
    harness.hydra.prompts.shift()!.end("end_turn");
    await session.waitFor((envelope) => envelope.action.type === "chat/turnComplete");
    expect(chat(session, oracle).turns.map((turn) => [turn.id, turn.state])).toEqual([
      ["a1", "cancelled"],
      ["t2", "complete"],
    ]);
  });
});
