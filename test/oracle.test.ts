import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Snapshot } from "@microsoft/agent-host-protocol";
import { chatUri, sessionUri } from "../src/protocol/fake-backend.js";
import { ReducerOracle } from "./support/oracle.js";
import { act, startHarness, type Harness, type Session } from "./support/harness.js";

const ROOT = "ahp-root://";
const SESSION = sessionUri("s1");
const CHAT = chatUri("s1-chat");

describe.each(["0.9.0", "1.0.0"])("reducer oracle at %s", (version) => {
  let harness: Harness;
  let session: Session;

  beforeEach(async () => {
    harness = await startHarness();
    session = await harness.connect();
  });

  afterEach(async () => {
    await harness.stop();
  });

  const now = (): string => new Date().toISOString();

  // A chat-heavy script touching every client-dispatchable chat action we serve.
  async function script(): Promise<void> {
    const dispatch = (channel: string, action: Record<string, unknown>): void => {
      session.client.dispatch(channel, act(action));
    };
    const message = (text: string): Record<string, unknown> => ({ text, origin: { kind: "user" } });
    dispatch(CHAT, { type: "chat/draftChanged", draft: message("typing") });
    dispatch(CHAT, { type: "chat/turnStarted", turnId: "t1", startedAt: now(), message: message("first") });
    await session.waitFor((e) => e.action.type === "chat/turnStarted");
    harness.backend.core.publish(CHAT, act({ type: "chat/responsePart", turnId: "t1", part: { kind: "reasoning", id: "r1", content: "" } }));
    harness.backend.core.publish(CHAT, act({ type: "chat/reasoning", turnId: "t1", partId: "r1", content: "hmm" }));
    harness.backend.streamReply(CHAT, "t1-x", "ignored but still reduced");
    harness.backend.askConfirmation(CHAT, "t1", "call1");
    await session.waitFor((e) => e.action.type === "chat/toolCallReady");
    dispatch(CHAT, { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "call1", approved: true, confirmed: "user-action" });
    dispatch(CHAT, { type: "chat/turnCancelled", turnId: "t1", duration: 7 });
    dispatch(CHAT, { type: "chat/turnCancelled", turnId: "t1", duration: 7 });
    dispatch(CHAT, { type: "chat/pendingMessageSet", kind: "queued", id: "q1", message: message("later") });
    dispatch(CHAT, { type: "chat/pendingMessageSet", kind: "steering", id: "s1", message: message("steer") });
    dispatch(CHAT, { type: "chat/pendingMessageRemoved", kind: "queued", id: "q1" });
    dispatch(CHAT, { type: "chat/isReadChanged", isRead: true });
    dispatch(SESSION, { type: "session/titleChanged", title: "Renamed" });
    dispatch(SESSION, { type: "session/isReadChanged", isRead: true });
    dispatch(ROOT, { type: "root/agentsChanged", agents: [] });
    dispatch(CHAT, { type: "chat/turnStarted", turnId: "t2", startedAt: now(), message: message("second") });
    await session.waitFor((e) => e.action.type === "chat/turnStarted" && (e.action as { turnId?: string }).turnId === "t2");
    harness.backend.streamReply(CHAT, "t2", "done now");
    harness.core.publish(SESSION, act({ type: "session/activityChanged", activity: "idle" }));
    dispatch(CHAT, { type: "chat/draftChanged" });
    await session.waitFor((e) => e.action.type === "chat/draftChanged" && e.serverSeq === harness.core.store.serverSeq);
  }

  it("matches the store's snapshots when envelopes are replayed through the official reducers", async () => {
    const init = await session.client.initialize({
      clientId: "c1",
      protocolVersions: version === "1.0.0" ? ["1.0.0"] : ["0.9.0"],
      initialSubscriptions: [ROOT, SESSION, CHAT],
    });
    const oracle = new ReducerOracle();
    for (const snapshot of init.snapshots) {
      oracle.applySnapshot(snapshot);
    }
    await script();
    for (const envelope of session.events) {
      oracle.applyEnvelope(envelope);
    }
    expect(oracle.channels().sort()).toEqual([CHAT, ROOT, SESSION].sort());
    for (const channel of oracle.channels()) {
      expect(oracle.state(channel)).toEqual(harness.core.store.snapshot(channel)?.state);
    }
    const chat = oracle.state(CHAT) as { turns: unknown[]; draft?: unknown };
    expect(chat.turns.length).toBeGreaterThan(0);
  });

  it("matches after a replay reconnect and after a snapshot reconnect", async () => {
    const init = await session.client.initialize({
      clientId: "c1",
      protocolVersions: version === "1.0.0" ? ["1.0.0"] : ["0.9.0"],
      initialSubscriptions: [ROOT, SESSION, CHAT],
    });
    const oracle = new ReducerOracle();
    for (const snapshot of init.snapshots) {
      oracle.applySnapshot(snapshot);
    }
    await script();
    for (const envelope of session.events) {
      oracle.applyEnvelope(envelope);
    }
    const lastSeen = Math.max(...session.events.map((e) => e.serverSeq));

    harness.backend.streamReply(CHAT, "t3", "while away");
    const again = await harness.connect();
    const replay = await again.client.reconnect({ clientId: "c1", lastSeenServerSeq: lastSeen, subscriptions: [ROOT, SESSION, CHAT] });
    expect(replay.type).toBe("replay");
    if (replay.type === "replay") {
      for (const envelope of replay.actions) {
        oracle.applyEnvelope(envelope);
      }
    }
    for (const channel of oracle.channels()) {
      expect(oracle.state(channel)).toEqual(harness.core.store.snapshot(channel)?.state);
    }

    const stale = await harness.connect();
    const snap = await stale.client.reconnect({ clientId: "c1", lastSeenServerSeq: 1, subscriptions: [ROOT, SESSION, CHAT] });
    expect(snap.type).toBe("snapshot");
    if (snap.type === "snapshot") {
      const fresh = new ReducerOracle();
      snap.snapshots.forEach((s: Snapshot) => fresh.applySnapshot(s));
      for (const channel of fresh.channels()) {
        expect(fresh.state(channel)).toEqual(harness.core.store.snapshot(channel)?.state);
      }
    }
  });
});
