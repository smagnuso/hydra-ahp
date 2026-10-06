import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatState, RootState, SessionState } from "@microsoft/agent-host-protocol";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import { chatUri, sessionUri } from "../src/protocol/fake-backend.js";
import { act, sleep, startHarness, type Harness, type Session } from "./support/harness.js";

const SESSION = sessionUri("s1");
const CHAT = chatUri("s1-chat");
const ROOT = "ahp-root://";

// VS Code lands on 0.9.0; the spec's newest baseline is 1.0.0.
describe.each(["0.9.0", "1.0.0"])("protocol at %s", (version) => {
  let harness: Harness;
  let session: Session;

  const offers = (): string[] => (version === "1.0.0" ? ["1.0.0", "0.9.0"] : ["0.10.0", "0.9.0", "0.7.0"]);

  beforeEach(async () => {
    harness = await startHarness();
    session = await harness.connect();
  });

  afterEach(async () => {
    await harness.stop();
  });

  it("tracks active clients and removes them when the client unsubscribes or disconnects", async () => {
    const other = await harness.connect();
    await session.client.initialize({ clientId: "ca", protocolVersions: offers() });
    await other.client.initialize({ clientId: "cb", protocolVersions: offers() });
    await session.client.subscribe(SESSION);
    await other.client.subscribe(SESSION);
    const active = (): string[] => (harness.core.store.state(SESSION) as SessionState).activeClients.map((c) => c.clientId);

    const { clientSeq } = session.client.dispatch(
      SESSION,
      act({ type: "session/activeClientSet", activeClient: { clientId: "ca", displayName: "a", tools: [] } }),
    );
    const echo = await session.waitFor((e) => e.origin?.clientSeq === clientSeq, 2000);
    expect(echo.rejectionReason).toBeUndefined();
    expect(active()).toEqual(["ca"]);

    await session.client.unsubscribe(SESSION);
    await other.waitFor((e) => e.action.type === "session/activeClientRemoved", 2000);
    expect(active()).toEqual([]);

    await session.client.subscribe(SESSION);
    session.client.dispatch(
      SESSION,
      act({ type: "session/activeClientSet", activeClient: { clientId: "ca", displayName: "a", tools: [] } }),
    );
    await sleep(100);
    expect(active()).toEqual(["ca"]);
    await session.shutdown();
    await sleep(200);
    expect(active()).toEqual([]);
  });

  it("refuses an active entry change for another client", async () => {
    await session.client.initialize({ clientId: "ca", protocolVersions: offers() });
    await session.client.subscribe(SESSION);
    const set = session.client.dispatch(
      SESSION,
      act({ type: "session/activeClientSet", activeClient: { clientId: "someone-else", displayName: "x", tools: [] } }),
    );
    expect((await session.waitFor((e) => e.origin?.clientSeq === set.clientSeq, 2000)).rejectionReason).toBe("a client can only change its own active entry");
    const own = session.client.dispatch(
      SESSION,
      act({ type: "session/activeClientSet", activeClient: { clientId: "ca", displayName: "a", tools: [] } }),
    );
    expect((await session.waitFor((e) => e.origin?.clientSeq === own.clientSeq, 2000)).rejectionReason).toBeUndefined();
    const removed = session.client.dispatch(SESSION, act({ type: "session/activeClientRemoved", clientId: "someone-else" }));
    expect((await session.waitFor((e) => e.origin?.clientSeq === removed.clientSeq, 2000)).rejectionReason).toBe("a client can only change its own active entry");
    expect((harness.core.store.state(SESSION) as SessionState).activeClients.map((c) => c.clientId)).toEqual(["ca"]);
  });

  it("negotiates the version and serves initial snapshots", async () => {
    const result = await session.client.initialize({
      clientId: "c1",
      protocolVersions: offers(),
      initialSubscriptions: [ROOT],
    });
    expect(result.protocolVersion).toBe(version);
    expect(result.serverInfo?.name).toBe("hydra-ahp-fake");
    expect(result.defaultDirectory).toBe("file:///tmp");
    expect(result.serverSeq).toBe(harness.core.store.serverSeq);
    expect(result.snapshots).toHaveLength(1);
    const [snapshot] = result.snapshots;
    expect(snapshot?.resource).toBe(ROOT);
    expect(snapshot?.fromSeq).toBe(result.serverSeq);
    expect((snapshot?.state as RootState).agents[0]?.provider).toBe("fake");
  });

  it("subscribes to session and chat channels and unsubscribes", async () => {
    await session.client.initialize({ clientId: "c1", protocolVersions: offers() });
    const sub = await session.client.subscribe(SESSION);
    expect(sub.result.snapshot?.resource).toBe(SESSION);
    expect((sub.result.snapshot?.state as SessionState).chats[0]?.resource).toBe(CHAT);
    const chat = await session.client.subscribe(CHAT);
    expect((chat.result.snapshot?.state as ChatState).turns).toEqual([]);
    expect(harness.backend.attached).toEqual([SESSION, CHAT]);

    await session.client.unsubscribe(CHAT);
    await session.client.ping();
    expect(harness.backend.detached).toEqual([CHAT]);

    harness.backend.streamReply(CHAT, "t0", "ignored");
    await sleep(30);
    expect(session.events.filter((e) => e.channel === CHAT)).toEqual([]);
  });

  it("answers ping and listSessions, shaping summaries to the version", async () => {
    await session.client.initialize({ clientId: "c1", protocolVersions: offers() });
    await session.client.ping();
    const list = (await session.client.request("listSessions", { channel: ROOT })) as {
      items: Array<Record<string, unknown>>;
    };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.resource).toBe(SESSION);
    expect("chats" in (list.items[0] ?? {})).toBe(version === "1.0.0");
    expect("defaultChat" in (list.items[0] ?? {})).toBe(true);
  });

  it("sends root notifications only to root subscribers, shaped to the version", async () => {
    await session.client.initialize({ clientId: "c1", protocolVersions: offers(), initialSubscriptions: [ROOT] });
    await session.client.request("createSession", { channel: sessionUri("new") } as never);
    await sleep(30);
    const added = session.notifications.find((n) => n.method === "root/sessionAdded");
    const summary = (added?.params as { summary: Record<string, unknown> }).summary;
    expect(summary.resource).toBe(sessionUri("new"));
    expect("chats" in summary).toBe(version === "1.0.0");
    await session.client.request("disposeSession", { channel: sessionUri("new") } as never);
    await sleep(30);
    expect(session.notifications.map((n) => n.method)).toEqual(["root/sessionAdded", "root/sessionRemoved"]);
  });

  it("fans out server actions to every subscriber with one global serverSeq", async () => {
    const other = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: offers(), initialSubscriptions: [CHAT] });
    await other.client.initialize({ clientId: "c2", protocolVersions: offers(), initialSubscriptions: [CHAT] });
    harness.backend.streamReply(CHAT, "t1", "one two");
    await session.waitFor((e) => e.action.type === "chat/turnComplete");
    await other.waitFor((e) => e.action.type === "chat/turnComplete");
    const seqs = session.events.map((e) => e.serverSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(other.events.map((e) => e.serverSeq)).toEqual(seqs);
    const state = harness.core.store.state(CHAT) as ChatState;
    expect(state.turns).toHaveLength(0);
  });

  it("echoes accepted client actions with their origin", async () => {
    await session.client.initialize({ clientId: "c1", protocolVersions: offers(), initialSubscriptions: [CHAT] });
    const message = { text: "hi", origin: { kind: "user" } };
    const { clientSeq } = session.client.dispatch(
      CHAT,
      act({ type: "chat/turnStarted", turnId: "t1", startedAt: new Date().toISOString(), message }),
    );
    const echo = await session.waitFor((e) => e.action.type === "chat/turnStarted");
    expect(echo.origin).toEqual({ clientId: "c1", clientSeq });
    expect(echo.rejectionReason).toBeUndefined();
    expect((harness.core.store.state(CHAT) as ChatState).activeTurn?.id).toBe("t1");
    expect(harness.backend.actions).toHaveLength(1);
  });

  describe("rejections", () => {
    const turnStarted = (): Record<string, unknown> => ({
      type: "chat/turnStarted",
      turnId: "t1",
      startedAt: new Date().toISOString(),
      message: { text: "hi", origin: { kind: "user" } },
    });

    beforeEach(async () => {
      await session.client.initialize({ clientId: "c1", protocolVersions: offers(), initialSubscriptions: [CHAT, SESSION] });
    });

    const expectRejected = async (channel: string, action: Record<string, unknown>, match: RegExp): Promise<void> => {
      const seqBefore = harness.core.store.serverSeq;
      const stateBefore = JSON.stringify(harness.core.store.state(channel));
      const { clientSeq } = session.client.dispatch(channel, act(action));
      const echo = await session.waitFor((e) => e.origin?.clientSeq === clientSeq && e.rejectionReason !== undefined);
      expect(echo.rejectionReason).toMatch(match);
      expect(echo.channel).toBe(channel);
      expect(echo.serverSeq).toBe(seqBefore);
      expect(harness.core.store.serverSeq).toBe(seqBefore);
      expect(JSON.stringify(harness.core.store.state(channel))).toBe(stateBefore);
      expect(harness.backend.actions.some((r) => r.action.type === action.type && r.origin.clientSeq === clientSeq)).toBe(false);
    };

    it("rejects toolCallConfirmed unless the call is pending confirmation", async () => {
      await expectRejected(CHAT, { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "x", approved: true, confirmed: "user-action" }, /not pending confirmation/);

      session.client.dispatch(CHAT, act(turnStarted()));
      await session.waitFor((e) => e.action.type === "chat/turnStarted");
      harness.backend.askConfirmation(CHAT, "t1", "call1");
      await session.waitFor((e) => e.action.type === "chat/toolCallReady");
      await expectRejected(CHAT, { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "other", approved: true, confirmed: "user-action" }, /not pending confirmation/);

      const { clientSeq } = session.client.dispatch(
        CHAT,
        act({ type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "call1", approved: true, confirmed: "user-action" }),
      );
      const accepted = await session.waitFor((e) => e.origin?.clientSeq === clientSeq && e.action.type === "chat/toolCallConfirmed");
      expect(accepted.rejectionReason).toBeUndefined();

      await expectRejected(CHAT, { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "call1", approved: false, reason: "user-action" }, /not pending confirmation/);
    });

    it("fills in the active turn when a client leaves the turnId out of a confirmation", async () => {
      session.client.dispatch(CHAT, act(turnStarted()));
      await session.waitFor((e) => e.action.type === "chat/turnStarted");
      harness.backend.askConfirmation(CHAT, "t1", "call1");
      await session.waitFor((e) => e.action.type === "chat/toolCallReady");
      const { clientSeq } = session.client.dispatch(
        CHAT,
        act({ type: "chat/toolCallConfirmed", toolCallId: "call1", approved: true, confirmed: "user-action" }),
      );
      const echo = await session.waitFor((e) => e.origin?.clientSeq === clientSeq && e.action.type === "chat/toolCallConfirmed");
      expect(echo.rejectionReason).toBeUndefined();
      expect((echo.action as { turnId?: string }).turnId).toBe("t1");
      const call = (harness.core.store.state(CHAT) as ChatState).activeTurn?.responseParts.find((part) => part.kind === "toolCall");
      expect(call?.kind === "toolCall" ? call.toolCall.status : undefined).not.toBe("pending-confirmation");
    });

    it("rejects turnCancelled with no active turn", async () => {
      await expectRejected(CHAT, { type: "chat/turnCancelled", turnId: "t1", duration: 1 }, /no active turn/);
    });

    it("accepts turnCancelled for the active turn", async () => {
      session.client.dispatch(CHAT, act(turnStarted()));
      await session.waitFor((e) => e.action.type === "chat/turnStarted");
      const { clientSeq } = session.client.dispatch(CHAT, act({ type: "chat/turnCancelled", turnId: "t1", duration: 5 }));
      const echo = await session.waitFor((e) => e.origin?.clientSeq === clientSeq && e.action.type === "chat/turnCancelled");
      expect(echo.rejectionReason).toBeUndefined();
      expect((harness.core.store.state(CHAT) as ChatState).activeTurn).toBeUndefined();
    });

    it("rejects pending message removal and input actions that match nothing", async () => {
      await expectRejected(CHAT, { type: "chat/pendingMessageRemoved", kind: "queued", id: "m1" }, /no pending queued/);
      await expectRejected(CHAT, { type: "chat/pendingMessageRemoved", kind: "steering", id: "m1" }, /no pending steering/);
      await expectRejected(CHAT, { type: "chat/inputCompleted", requestId: "r1", response: "cancel" }, /no open input request/);
      await expectRejected(CHAT, { type: "chat/inputAnswerChanged", requestId: "r1", questionId: "q" }, /no open input request/);
    });

    it("rejects turnResume without a resumable errored turn", async () => {
      await expectRejected(CHAT, { type: "chat/turnResume", turnId: "t1" }, /cannot be resumed/);
    });

    it("rejects actions that clients may not dispatch", async () => {
      await expectRejected(CHAT, { type: "chat/delta", turnId: "t1", partId: "p", content: "x" }, /not client-dispatchable/);
      await expectRejected(SESSION, { type: "session/ready" }, /not client-dispatchable/);
    });

    it("rejects actions on the wrong channel and unknown action types", async () => {
      await expectRejected(CHAT, { type: "session/isReadChanged", isRead: true }, /does not apply/);
      await expectRejected(SESSION, turnStarted(), /does not apply/);
      await expectRejected(CHAT, { type: "chat/doesNotExist" }, /unknown action type/);
    });

    it("rejects actions newer than the negotiated version", async () => {
      const reason = version === "0.9.0" ? /not part of protocol/ : /not client-dispatchable/;
      await expectRejected(CHAT, { type: "chat/canvasesChanged", canvases: [] }, reason);
    });

    it("does not deliver server actions newer than the negotiated version", async () => {
      harness.core.publish(CHAT, act({ type: "chat/canvasesChanged", canvases: [] }));
      harness.core.publish(CHAT, act({ type: "chat/activityChanged", activity: "thinking" }));
      await session.waitFor((e) => e.action.type === "chat/activityChanged");
      const delivered = session.events.some((e) => e.action.type === "chat/canvasesChanged");
      expect(delivered).toBe(version === "1.0.0");
    });

    it("silently ignores actions for unknown channels and malformed dispatches", async () => {
      session.client.dispatch("ahp-chat:/ghost", act(turnStarted()));
      session.client.notify("dispatchAction", { channel: CHAT, clientSeq: "x", action: null } as never);
      const { clientSeq } = session.client.dispatch(CHAT, act(turnStarted()));
      await session.waitFor((e) => e.origin?.clientSeq === clientSeq);
      expect(session.events.filter((e) => e.rejectionReason !== undefined)).toEqual([]);
      expect(session.events.filter((e) => e.channel === "ahp-chat:/ghost")).toEqual([]);
    });

    it("accepts client actions without requiring a subscription to the channel", async () => {
      const lone = await harness.connect();
      await lone.client.initialize({ clientId: "lone", protocolVersions: offers() });
      lone.client.dispatch(SESSION, act({ type: "session/titleChanged", title: "Renamed" }));
      await session.waitFor((e) => e.action.type === "session/titleChanged");
      expect((harness.core.store.state(SESSION) as SessionState).title).toBe("Renamed");
    });
  });

  describe("errors", () => {
    it("refuses requests before initialize", async () => {
      await expect(session.client.ping()).rejects.toMatchObject({ code: -32600 });
      await expect(session.client.subscribe(ROOT)).rejects.toMatchObject({ code: -32600 });
    });

    it("refuses a second initialize", async () => {
      await session.client.initialize({ clientId: "c1", protocolVersions: offers() });
      await expect(session.client.initialize({ clientId: "c1", protocolVersions: offers() })).rejects.toMatchObject({ code: -32600 });
    });

    it("reports subscribe failures and unknown methods", async () => {
      await session.client.initialize({ clientId: "c1", protocolVersions: offers() });
      await expect(session.client.subscribe("ahp-session:/ghost")).rejects.toMatchObject({ code: -32001 });
      await expect(session.client.subscribe("ahp-terminal:/t")).rejects.toMatchObject({ code: -32001 });
      await expect(session.client.subscribe("not-a-channel")).rejects.toMatchObject({ code: -32602 });
      await expect(session.client.request("resourceList", { channel: ROOT, uri: "file:///" } as never)).rejects.toMatchObject({ code: -32601 });
      await expect(session.client.request("initialize", { channel: ROOT } as never)).rejects.toBeInstanceOf(RpcError);
    });
  });

  describe("reconnect", () => {
    const subscriptions = [ROOT, SESSION, CHAT];

    it("replays the envelopes missed on subscribed channels and reports missing ones", async () => {
      harness.backend.addSession({ id: "s2", title: "Second" }, false);
      const first = await session.client.initialize({
        clientId: "c1",
        protocolVersions: offers(),
        initialSubscriptions: [...subscriptions, sessionUri("s2")],
      });
      await session.client.ping();
      await session.client.shutdown();
      await session.closed;
      const wanted = [...subscriptions, sessionUri("s2")].sort();
      // The client sees its socket close before the server has detached every channel.
      for (let tries = 0; tries < 100 && harness.backend.detached.length < wanted.length; tries++) {
        await sleep(20);
      }
      expect(harness.backend.detached.sort()).toEqual(wanted);

      harness.backend.streamReply(CHAT, "t1", "alpha beta");
      harness.backend.core.publish(SESSION, act({ type: "session/titleChanged", title: "Renamed" }));
      harness.backend.removeSession("s2");

      const again = await harness.connect();
      const result = await again.client.reconnect({
        clientId: "c1",
        lastSeenServerSeq: first.serverSeq,
        subscriptions: [...subscriptions, sessionUri("s2")],
      });
      expect(result.type).toBe("replay");
      if (result.type !== "replay") {
        return;
      }
      expect(result.missing).toEqual([sessionUri("s2")]);
      expect(result.actions.map((e) => e.action.type)).toEqual([
        "chat/responsePart",
        "chat/delta",
        "chat/delta",
        "chat/turnComplete",
        "session/titleChanged",
      ]);
      expect(result.actions.every((e) => e.serverSeq > first.serverSeq)).toBe(true);

      harness.backend.core.publish(SESSION, act({ type: "session/titleChanged", title: "Again" }));
      await again.waitFor((e) => e.action.type === "session/titleChanged");
    });

    it("sends snapshots when the gap exceeds the replay ring", async () => {
      await harness.stop();
      harness = await startHarness({ store: { ringSize: 3 } });
      session = await harness.connect();
      const first = await session.client.initialize({ clientId: "c1", protocolVersions: offers(), initialSubscriptions: subscriptions });
      await session.client.shutdown();
      await session.closed;

      harness.backend.streamReply(CHAT, "t1", "a b c d e");
      const again = await harness.connect();
      const result = await again.client.reconnect({ clientId: "c1", lastSeenServerSeq: first.serverSeq, subscriptions });
      expect(result.type).toBe("snapshot");
      if (result.type !== "snapshot") {
        return;
      }
      expect(result.snapshots.map((s) => s.resource).sort()).toEqual([...subscriptions].sort());
      for (const snapshot of result.snapshots) {
        expect(snapshot.fromSeq).toBe(harness.core.store.serverSeq);
        expect(snapshot.state).toEqual(harness.core.store.snapshot(snapshot.resource)?.state);
      }
      harness.backend.core.publish(SESSION, act({ type: "session/titleChanged", title: "Live" }));
      await again.waitFor((e) => e.action.type === "session/titleChanged");
    });

    it("sends snapshots to a client that claims a future sequence", async () => {
      await session.client.initialize({ clientId: "c1", protocolVersions: offers() });
      const again = await harness.connect();
      const result = await again.client.reconnect({
        clientId: "c1",
        lastSeenServerSeq: harness.core.store.serverSeq + 1000,
        subscriptions: [SESSION],
      });
      expect(result.type).toBe("snapshot");
    });

    it("replays nothing when the client is current", async () => {
      await session.client.initialize({ clientId: "c1", protocolVersions: offers() });
      const again = await harness.connect();
      const result = await again.client.reconnect({
        clientId: "c1",
        lastSeenServerSeq: harness.core.store.serverSeq,
        subscriptions,
      });
      expect(result).toEqual({ type: "replay", actions: [], missing: [] });
    });

    it("refuses reconnect after the connection initialized", async () => {
      await session.client.initialize({ clientId: "c1", protocolVersions: offers() });
      await expect(
        session.client.reconnect({ clientId: "c1", lastSeenServerSeq: 0, subscriptions: [] }),
      ).rejects.toMatchObject({ code: -32600 });
    });
  });

  describe("subscriptions and detach", () => {
    it("keeps the backend attached until the last subscriber leaves", async () => {
      const other = await harness.connect();
      await session.client.initialize({ clientId: "c1", protocolVersions: offers() });
      await other.client.initialize({ clientId: "c2", protocolVersions: offers() });
      await session.client.subscribe(CHAT);
      await other.client.subscribe(CHAT);
      expect(harness.backend.attached.filter((uri) => uri === CHAT)).toHaveLength(1);

      await session.client.unsubscribe(CHAT);
      await session.client.ping();
      expect(harness.backend.detached).toEqual([]);

      await other.shutdown();
      await sleep(50);
      expect(harness.backend.detached).toEqual([CHAT]);
    });

    it("detaches every subscription when the socket drops", async () => {
      await session.client.initialize({ clientId: "c1", protocolVersions: offers(), initialSubscriptions: [ROOT, SESSION, CHAT] });
      session.ws.terminate();
      await session.closed;
      await sleep(30);
      expect(harness.backend.detached.sort()).toEqual([CHAT, ROOT, SESSION].sort());
    });
  });
});

describe("version negotiation", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.stop();
  });

  it("answers -32005 with supportedVersions and closes the connection", async () => {
    const session = await harness.connect();
    const error = await session.client
      .initialize({ clientId: "c1", protocolVersions: ["0.8.0", "0.10.0", "2.0.0"] })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(-32005);
    expect((error as RpcError).data).toEqual({ supportedVersions: ["1.0.0", "0.9.0"] });
    await session.closed;
  });

  it("treats malformed offers as unsupported", async () => {
    const session = await harness.connect();
    await expect(
      session.client.initialize({ clientId: "c1", protocolVersions: ["banana"] }),
    ).rejects.toMatchObject({ code: -32005 });
  });

  it("rejects an initialize without a client id", async () => {
    const session = await harness.connect();
    await expect(
      session.client.request("initialize", { channel: "ahp-root://", protocolVersions: ["0.9.0"] } as never),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("picks the highest compatible version from VS Code's offer", async () => {
    const session = await harness.connect();
    const result = await session.client.initialize({
      clientId: "vscode",
      protocolVersions: ["0.10.0", "0.9.0", "0.7.0", "0.6.0", "0.5.2", "0.5.1"],
    });
    expect(result.protocolVersion).toBe("0.9.0");
  });

  it("falls back to the oldest baseline when reconnecting an unknown client", async () => {
    const session = await harness.connect();
    const result = await session.client.reconnect({ clientId: "never-seen", lastSeenServerSeq: 0, subscriptions: ["ahp-session:/s1"] });
    expect(result.type).toBe("snapshot");
    expect(harness.core.recallVersion("never-seen")).toBe("0.9.0");
  });
});

describe("detach grace", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.stop();
  });

  it("keeps a channel attached through a quick unsubscribe and resubscribe, and detaches once it stays unwatched", async () => {
    harness = await startHarness({ detachGraceMs: 150 });
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    await session.client.subscribe(CHAT);

    await session.client.unsubscribe(CHAT);
    await session.client.subscribe(CHAT);
    await sleep(250);
    expect(harness.backend.detached).toEqual([]);

    await session.client.unsubscribe(CHAT);
    await session.client.ping();
    expect(harness.backend.detached).toEqual([]);
    await sleep(250);
    expect(harness.backend.detached).toEqual([CHAT]);
  });
});
