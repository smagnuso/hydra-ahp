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
    expect(state.turns.map((turn) => turn.message.origin.kind)).toEqual(["systemNotification", "systemNotification"]);
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
      ["a1", "The agent continued on its own", "working"],
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

const FORM = {
  sessionId: "h1",
  mode: "form",
  message: "Which stack?",
  requestedSchema: {
    type: "object",
    properties: {
      question_0: { type: "string", title: "Stack", oneOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] },
      question_0_custom: { type: "string", title: "Other" },
    },
    required: ["question_0"],
  },
  _meta: { "hydra-acp": { elicitationId: "e1" } },
};

describe("elicitation forms", () => {
  let harness: BridgeHarness;

  afterEach(async () => {
    await harness.stop();
  });

  async function begin(): Promise<{ session: Session; oracle: ReducerOracle }> {
    harness = await startBridgeHarness();
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c-form", protocolVersions: ["0.9.0"], initialSubscriptions: [ROOT] });
    const oracle = new ReducerOracle();
    oracle.applySnapshot((await session.client.subscribe(SESSION)).result.snapshot as Snapshot);
    oracle.applySnapshot((await session.client.subscribe(CHAT)).result.snapshot as Snapshot);
    const { clientSeq } = session.client.dispatch(CHAT, act({ type: "chat/turnStarted", turnId: "t1", startedAt: new Date().toISOString(), message: { text: "go", origin: { kind: "user" } } }));
    await session.waitFor((envelope) => envelope.origin?.clientSeq === clientSeq);
    return { session, oracle };
  }

  function send(session: Session, action: Record<string, unknown>): Promise<ActionEnvelope> {
    const { clientSeq } = session.client.dispatch(CHAT, act(action));
    return session.waitFor((envelope) => envelope.origin?.clientSeq === clientSeq);
  }

  it("asks the form as an input request and answers Hydra with the folded content", async () => {
    const { session } = await begin();
    const answer = harness.hydra.listener!.elicitation!(FORM);
    const asked = await session.waitFor((envelope) => envelope.action.type === "chat/inputRequested");
    expect(asked.action).toMatchObject({
      request: {
        id: "e1",
        questions: [{ id: "question_0", kind: "single-select", message: "Which stack?", required: true, allowFreeformInput: true, options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }],
      },
    });
    const missing = await send(session, { type: "chat/inputCompleted", requestId: "e1", response: "accept", answers: {} });
    expect(missing.rejectionReason).toBeDefined();
    const again = await session.waitFor((envelope) => envelope.action.type === "chat/inputRequested" && (envelope.action as { request: { id: string } }).request.id === "e1~1");
    expect((again.action as { request: { message: string } }).request.message).toContain("question_0");
    const done = await send(session, { type: "chat/inputCompleted", requestId: "e1~1", response: "accept", answers: { question_0: { state: "submitted", value: { kind: "selected", value: "b" } } } });
    expect(done.rejectionReason).toBeUndefined();
    expect(await answer).toEqual({ action: "accept", content: { question_0: "b" } });
  });

  it("sends free-form text to the custom field and a decline as a bare action", async () => {
    const { session } = await begin();
    const answer = harness.hydra.listener!.elicitation!(FORM);
    await session.waitFor((envelope) => envelope.action.type === "chat/inputRequested");
    await send(session, { type: "chat/inputCompleted", requestId: "e1", response: "accept", answers: { question_0: { state: "submitted", value: { kind: "selected", value: "", freeformValues: ["gamma"] } } } });
    expect(await answer).toEqual({ action: "accept", content: { question_0_custom: "gamma" } });

    const second = harness.hydra.listener!.elicitation!({ ...FORM, _meta: { "hydra-acp": { elicitationId: "e2" } } });
    await session.waitFor((envelope) => envelope.action.type === "chat/inputRequested" && (envelope.action as { request: { id: string } }).request.id === "e2");
    await send(session, { type: "chat/inputCompleted", requestId: "e2", response: "decline" });
    expect(await second).toEqual({ action: "decline" });
  });

  it("closes the form and abstains when another client answers first", async () => {
    const { session } = await begin();
    const answer = harness.hydra.listener!.elicitation!(FORM);
    await session.waitFor((envelope) => envelope.action.type === "chat/inputRequested");
    harness.hydra.listener!.update({ update: { sessionUpdate: "elicitation_resolved", elicitationId: "e1", action: "accept" } });
    await expect(answer).rejects.toMatchObject({ code: -32601 });
    const closed = await session.waitFor((envelope) => envelope.action.type === "chat/inputCompleted");
    expect(closed.action).toMatchObject({ requestId: "e1", response: "accept" });
  });

  it("closes the form on a daemon cancel with no resolver", async () => {
    const { session } = await begin();
    const answer = harness.hydra.listener!.elicitation!(FORM);
    await session.waitFor((envelope) => envelope.action.type === "chat/inputRequested");
    harness.hydra.listener!.update({ update: { sessionUpdate: "elicitation_resolved", elicitationId: "e1", action: "cancel" } });
    await expect(answer).rejects.toMatchObject({ code: -32601 });
    const closed = await session.waitFor((envelope) => envelope.action.type === "chat/inputCompleted");
    expect(closed.action).toMatchObject({ requestId: "e1", response: "cancel" });
  });

  it("refuses an accept that breaks a field limit", async () => {
    const { session } = await begin();
    const form = { ...FORM, requestedSchema: { type: "object", properties: { n: { type: "integer", minimum: 5 } } } };
    const answer = harness.hydra.listener!.elicitation!(form);
    await session.waitFor((envelope) => envelope.action.type === "chat/inputRequested");
    const bad = await send(session, { type: "chat/inputCompleted", requestId: "e1", response: "accept", answers: { n: { state: "submitted", value: { kind: "number", value: 2 } } } });
    expect(bad.rejectionReason).toBeDefined();
    const again = await session.waitFor((envelope) => envelope.action.type === "chat/inputRequested" && (envelope.action as { request: { id: string } }).request.id === "e1~1");
    expect(again.action).toMatchObject({ request: { id: "e1~1", message: expect.stringContaining("at least 5"), answers: { n: { state: "draft", value: { kind: "number", value: 2 } } } } });
    const closed = await session.waitFor((envelope) => envelope.action.type === "chat/inputCompleted" && (envelope.action as { response: string }).response === "cancel");
    expect(closed.action).toMatchObject({ requestId: "e1" });
    await send(session, { type: "chat/inputCompleted", requestId: "e1~1", response: "accept", answers: { n: { state: "submitted", value: { kind: "number", value: 7 } } } });
    expect(await answer).toEqual({ action: "accept", content: { n: 7 } });
  });

  it("offers free-form input only where the form has a custom slot", async () => {
    const { session } = await begin();
    const multi = { ...FORM, requestedSchema: { type: "object", properties: { m: { type: "array", items: { enum: ["a", "b"] } } } } };
    void harness.hydra.listener!.elicitation!(multi).catch(() => undefined);
    const asked = await session.waitFor((envelope) => envelope.action.type === "chat/inputRequested");
    expect(asked.action).toMatchObject({ request: { questions: [{ kind: "multi-select", allowFreeformInput: false }] } });
  });

  it("abstains from a form AHP cannot express", async () => {
    const { session } = await begin();
    const odd = { ...FORM, requestedSchema: { type: "object", properties: { x: { type: "object" } } } };
    await expect(harness.hydra.listener!.elicitation!(odd)).rejects.toMatchObject({ code: -32601 });
    expect(session.events.some((envelope) => envelope.action.type === "chat/inputRequested")).toBe(false);
  });

  it("answers a pending form cancelled when the turn is cancelled", async () => {
    const { session } = await begin();
    const answer = harness.hydra.listener!.elicitation!(FORM);
    await session.waitFor((envelope) => envelope.action.type === "chat/inputRequested");
    await send(session, { type: "chat/turnCancelled", turnId: "t1", duration: 1 });
    expect(await answer).toEqual({ action: "cancel" });
  });
});
