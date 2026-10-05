import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatState, SessionState, Snapshot } from "@microsoft/agent-host-protocol";
import type { Frame } from "../src/bridge/mapping.js";
import { ReducerOracle, framesFromNotifications, framesFromHistory, type HistoryRow, type RecordedFrame } from "./support/oracle.js";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";
import { act, sleep, type Session } from "./support/harness.js";
import { chatOf, sessionOf } from "./support/chat-uri.js";

const CHAT = chatOf("h1");
const SESSION = sessionOf("h1");
const ROOT = "ahp-root://";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/scripted.json", import.meta.url), "utf8")) as {
  replay: RecordedFrame[];
  history: HistoryRow[];
};
const replay = framesFromNotifications(fixture.replay);
const maxSeq = Math.max(...replay.map((frame) => frame.seq ?? 0));
const newest = { entries: fixture.history as unknown[], hasMore: false };

const stamped = (update: Record<string, unknown>, seq: number): Frame => ({ update, seq, recordedAt: 1_800_000_000_000 + seq });

async function open(harness: BridgeHarness, version = "1.0.0"): Promise<{ session: Session; oracle: ReducerOracle; chat: ChatState }> {
  const session = await harness.connect();
  const init = await session.client.initialize({
    clientId: `c-${Math.random().toString(16).slice(2)}`,
    protocolVersions: version === "1.0.0" ? ["1.0.0"] : ["0.9.0"],
    initialSubscriptions: [ROOT],
  });
  void init;
  const oracle = new ReducerOracle();
  const sub = await session.client.subscribe(SESSION);
  oracle.applySnapshot(sub.result.snapshot as Snapshot);
  const chat = await session.client.subscribe(CHAT);
  oracle.applySnapshot(chat.result.snapshot as Snapshot);
  return { session, oracle, chat: (chat.result.snapshot as Snapshot).state as ChatState };
}

function settle(session: Session, oracle: ReducerOracle): void {
  for (const envelope of session.events) {
    oracle.applyEnvelope(envelope);
  }
}

describe.each(["0.9.0", "1.0.0"])("session bridge at %s", (version) => {
  let harness: BridgeHarness;

  afterEach(async () => {
    await harness.stop();
  });

  it("attaches once for a live session's settings and builds the chat snapshot from the replay", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.newest = newest;
      hydra.meta = { busy: false };
    });
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: [version], initialSubscriptions: [ROOT] });
    await session.client.subscribe(SESSION);
    const attach = { id: "h1", readonly: false, history: "pending_only" };
    expect(harness.hydra.attaches).toEqual([attach]);
    const sub = await session.client.subscribe(CHAT);
    expect(harness.hydra.attaches).toEqual([attach]);
    const chat = (sub.result.snapshot as Snapshot).state as ChatState;
    expect(chat.turns.map((turn) => turn.state)).toEqual(["complete", "complete", "error", "cancelled"]);
    expect(chat.activeTurn).toBeUndefined();
    expect(chat.turns[0]!.message.text).toBe("script:tools");
  });

  it("detaches explicitly only when the last subscriber leaves", async () => {
    harness = await startBridgeHarness();
    const first = await open(harness, version);
    const second = await open(harness, version);
    expect(harness.hydra.attaches).toHaveLength(1);
    await first.session.client.unsubscribe(CHAT);
    await sleep(30);
    expect(harness.hydra.detaches).toEqual([]);
    await second.session.client.unsubscribe(CHAT);
    await sleep(30);
    expect(harness.hydra.detaches).toEqual(["h1"]);
  });

  it("detaches when a connection just drops", async () => {
    harness = await startBridgeHarness();
    const { session } = await open(harness, version);
    session.ws.terminate();
    await session.closed;
    await sleep(60);
    expect(harness.hydra.detaches).toEqual(["h1"]);
  });

  it("takes a read-only viewer attach for a cold session", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ status: "cold" })];
      hydra.replay = replay;
    });
    const { chat } = await open(harness, version);
    expect(harness.hydra.attaches).toEqual([{ id: "h1", readonly: true, history: "full" }]);
    expect(chat.turns).toHaveLength(4);
  });

  it("keeps a client's mirror equal to the channel while a turn streams live", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.newest = newest;
    });
    const { session, oracle } = await open(harness, version);
    const live = harness.hydra.listener!;
    let seq = maxSeq;
    const send = (update: Record<string, unknown>): void => live.update(stamped(update, ++seq));
    send({ sessionUpdate: "prompt_received", messageId: "live1", prompt: [{ type: "text", text: "from the tui" }], sentBy: { clientId: "tui" } });
    send({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "from the tui" }, _meta: { "hydra-acp": { compatFor: "prompt_received" } } });
    send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } });
    send({ sessionUpdate: "tool_call", toolCallId: "x", title: "Read", status: "pending", rawInput: { path: "/a" } });
    send({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "in_progress" });
    send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } });
    send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } });
    live.update({ update: { sessionUpdate: "usage_update", used: 5, size: 10 } });
    await session.waitFor((e) => e.action.type === "chat/delta" && (e.action as { content?: string }).content === " world");
    settle(session, oracle);
    const mid = harness.core.store.state(CHAT) as ChatState;
    expect(mid.activeTurn?.id).toBe("live1");
    expect(mid.status & 8).toBe(8);
    expect(oracle.state(CHAT)).toEqual(mid);

    send({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] });
    send({ sessionUpdate: "turn_complete", stopReason: "end_turn" });
    await session.waitFor((e) => e.action.type === "chat/turnComplete" && (e.action as { turnId?: string }).turnId === "live1");
    settle(session, oracle);
    const end = harness.core.store.state(CHAT) as ChatState;
    expect(end.turns).toHaveLength(5);
    expect(end.turns[4]!.state).toBe("complete");
    expect(oracle.state(CHAT)).toEqual(end);
    expect((oracle.state(SESSION) as SessionState).chats[0]!.status).toBe(end.status);
    for (const channel of oracle.channels()) {
      expect(oracle.state(channel)).toEqual(harness.core.store.snapshot(channel)?.state);
    }
  });

  it("opens an active turn when attaching mid-turn, from busy and turnStartedAt", async () => {
    const startedAt = 1_800_000_100_000;
    harness = await startBridgeHarness((hydra) => {
      hydra.newest = newest;
      hydra.meta = { busy: true, turnStartedAt: startedAt, currentUsage: { used: 7, size: 100 } };
    });
    const { session, oracle, chat } = await open(harness, version);
    expect(chat.activeTurn).toBeDefined();
    expect(chat.activeTurn!.startedAt).toBe(new Date(startedAt).toISOString());
    expect(chat.activeTurn!.usage).toEqual({ _meta: { context: { used: 7, size: 100 } } });
    expect(chat.status & 8).toBe(8);
    harness.hydra.listener!.update(stamped({ sessionUpdate: "turn_complete", stopReason: "end_turn" }, maxSeq + 50));
    await session.waitFor((e) => e.action.type === "chat/turnComplete");
    settle(session, oracle);
    expect((oracle.state(CHAT) as ChatState).activeTurn).toBeUndefined();
    expect((oracle.state(CHAT) as ChatState).turns.at(-1)).toMatchObject({ state: "complete" });
  });

  it("keeps the turn a replay left open when Hydra says the session is busy", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.newest = { entries: fixture.history.filter((row) => row.seq === undefined || row.seq < maxSeq - 100), hasMore: false };
      hydra.meta = { busy: true, turnStartedAt: 1 };
    });
    const { chat } = await open(harness, version);
    expect(chat.activeTurn).toMatchObject({ message: { text: "script:hang" } });
    expect(chat.turns).toHaveLength(3);
  });

  it("closes a turn the replay left open when Hydra says the session is not busy", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.newest = {
        entries: [{ method: "session/update", params: { update: { sessionUpdate: "prompt_received", messageId: "p", prompt: [{ type: "text", text: "x" }] } }, recordedAt: 1_800_000_000_005, seq: 5 }],
        hasMore: false,
      };
      hydra.meta = { busy: false };
    });
    const { chat } = await open(harness, version);
    expect(chat.activeTurn).toBeUndefined();
    expect(chat.turns[0]).toMatchObject({ id: "p", state: "cancelled" });
  });

  it("keeps older loaded turns and picks up new ones when a chat is subscribed again", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.newest = newest;
    });
    const first = await open(harness, version);
    await first.session.client.unsubscribe(CHAT);
    await first.session.client.unsubscribe(SESSION);
    await sleep(30);
    const later: HistoryRow[] = [
      { method: "session/update", params: { update: { sessionUpdate: "prompt_received", messageId: "later", prompt: [{ type: "text", text: "more" }] } }, recordedAt: 1_800_000_000_001, seq: maxSeq + 1 },
      { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "sure" } } }, recordedAt: 1_800_000_000_002, seq: maxSeq + 2 },
      { method: "session/update", params: { update: { sessionUpdate: "turn_complete", stopReason: "end_turn" } }, recordedAt: 1_800_000_000_003, seq: maxSeq + 3 },
    ];
    harness.hydra.newest = { entries: [...fixture.history.slice(-14), ...later], hasMore: true };
    const second = await open(harness, version);
    expect(harness.hydra.attaches.map((call) => call.history)).toEqual(["pending_only", "pending_only"]);
    expect(second.chat.turns).toHaveLength(5);
    expect(second.chat.turns.at(-1)!.message.text).toBe("more");
    expect(second.chat.turns.slice(0, 4).map((turn) => turn.state)).toEqual(["complete", "complete", "error", "cancelled"]);
  });

  it("rebuilds from the page when it no longer overlaps what the chat held", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.newest = newest;
    });
    const first = await open(harness, version);
    await first.session.client.unsubscribe(CHAT);
    await first.session.client.unsubscribe(SESSION);
    await sleep(30);
    harness.hydra.newest = {
      entries: [
        { method: "session/update", params: { update: { sessionUpdate: "prompt_received", messageId: "fresh", prompt: [{ type: "text", text: "new" }] } }, recordedAt: 1_800_000_000_001, seq: maxSeq + 10 },
        { method: "session/update", params: { update: { sessionUpdate: "turn_complete", stopReason: "end_turn" } }, recordedAt: 1_800_000_000_002, seq: maxSeq + 11 },
      ],
      hasMore: false,
    };
    const second = await open(harness, version);
    expect(second.chat.turns.map((turn) => turn.id)).toEqual(["fresh"]);
  });

  it("updates subscribers in place when a dormant session re-attaches", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.newest = newest;
      hydra.meta = { busy: false };
    });
    const { session, oracle } = await open(harness, version);
    harness.hydra.listener!.closed();
    harness.hydra.rows = [ROW({ status: "cold" })];
    await sleep(120);
    const turns = [...fixture.history];
    harness.hydra.newest = {
      entries: [
        ...turns,
        { method: "session/update", params: { update: { sessionUpdate: "prompt_received", messageId: "again", prompt: [{ type: "text", text: "back" }] } }, recordedAt: 1_800_000_000_001, seq: maxSeq + 1 },
        { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } }, recordedAt: 1_800_000_000_002, seq: maxSeq + 2 },
      ],
      hasMore: false,
    };
    harness.hydra.meta = { busy: true, turnStartedAt: 1_800_000_000_001 };
    harness.hydra.rows = [ROW({ status: "warm" })];
    await sleep(300);
    settle(session, oracle);
    const chat = oracle.state(CHAT) as ChatState;
    expect(chat.turns).toHaveLength(4);
    expect(chat.activeTurn?.id).toBe("again");
    expect(oracle.state(CHAT)).toEqual(harness.core.store.state(CHAT));
  });

  it("orders live frames that race the attach after the history, and drops the ones the history already holds", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.newest = newest;
      hydra.meta = { busy: true, turnStartedAt: 1_800_000_000_000 };
      hydra.early = [
        stamped({ sessionUpdate: "prompt_received", messageId: "racing", prompt: [{ type: "text", text: "now" }] }, maxSeq + 5),
        stamped({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } }, maxSeq + 6),
        stamped({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "dup of history" } }, maxSeq),
      ];
    });
    const { chat } = await open(harness, version);
    expect(chat.turns).toHaveLength(4);
    expect(chat.turns.map((turn) => turn.id)).not.toContain("racing");
    expect(chat.activeTurn).toMatchObject({ id: "racing", responseParts: [{ kind: "markdown", content: "partial" }] });
  });

  it("closes the active turn on session/closed and re-attaches when the session is warm again", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.newest = newest;
      hydra.meta = { busy: true, turnStartedAt: 1_800_000_000_000 };
    });
    const { session, oracle } = await open(harness, version);
    expect((harness.core.store.state(CHAT) as ChatState).activeTurn).toBeDefined();
    harness.hydra.rows = [ROW({ status: "cold" })];
    harness.hydra.listener!.closed();
    await session.waitFor((e) => e.action.type === "chat/turnCancelled");
    settle(session, oracle);
    expect((oracle.state(CHAT) as ChatState).activeTurn).toBeUndefined();
    expect(harness.backend.bridgeFor(CHAT)!.isAttached).toBe(false);

    harness.hydra.meta = { busy: false };
    harness.hydra.rows = [ROW({ status: "warm" })];
    await sleep(300);
    expect(harness.hydra.attaches.length).toBeGreaterThanOrEqual(2);
    expect(harness.hydra.attaches.at(-1)).toMatchObject({ id: "h1", readonly: false, history: "pending_only" });
    expect(harness.backend.bridgeFor(CHAT)!.isAttached).toBe(true);
  });

  it("upgrades a viewer attach once the session turns warm", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ status: "cold" })];
      hydra.replay = replay;
    });
    await open(harness, version);
    harness.hydra.newest = newest;
    harness.hydra.rows = [ROW({ status: "warm" })];
    await sleep(300);
    expect(harness.hydra.attaches.map((call) => call.readonly)).toEqual([true, false]);
    expect(harness.hydra.detaches).toEqual(["h1"]);
  });

  it("pages older turns in through fetchTurns", async () => {
    const older = framesFromHistory(fixture.history.slice(0, 12));
    harness = await startBridgeHarness((hydra) => {
      hydra.newest = { entries: fixture.history.slice(-8), hasMore: true };
      hydra.history = [
        { entries: fixture.history.slice(0, 12), hasMore: true },
        { entries: [], hasMore: false },
      ];
    });
    const { session, chat } = await open(harness, version);
    const firstSeq = Math.min(...fixture.history.slice(-8).flatMap((row) => (row.seq === undefined ? [] : [row.seq])));
    expect(chat.turnsNextCursor).toBe(String(firstSeq));
    expect(harness.hydra.pageCalls[0]).toEqual({ beforeSeq: Number.MAX_SAFE_INTEGER, turns: 20 });
    await expect(session.client.request("fetchTurns", { channel: CHAT, cursor: "bogus" } as never)).rejects.toMatchObject({ code: -32602 });
    await session.client.request("fetchTurns", { channel: CHAT, cursor: chat.turnsNextCursor } as never);
    const loaded = harness.core.store.state(CHAT) as ChatState;
    const oldest = Math.min(...older.flatMap((f) => (f.seq === undefined ? [] : [f.seq])));
    expect(loaded.turnsNextCursor).toBe(String(oldest));
    expect(loaded.turns.length).toBeGreaterThan(chat.turns.length);
    expect(harness.hydra.pageCalls[1]).toEqual({ beforeSeq: firstSeq, turns: 10 });
    await session.client.request("fetchTurns", { channel: CHAT } as never);
    expect((harness.core.store.state(CHAT) as ChatState).turnsNextCursor).toBeUndefined();
    await session.client.request("fetchTurns", { channel: CHAT } as never);
    expect(harness.hydra.pageCalls).toHaveLength(3);
  });

  it("reports a missing session instead of a half-built channel", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.failure = Object.assign(new Error("session not found"), { code: -32001 });
    });
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: [version], initialSubscriptions: [ROOT] });
    await expect(session.client.subscribe(CHAT)).rejects.toBeDefined();
    expect(harness.hydra.attaches).toHaveLength(1);
    expect(harness.core.hasSubscribers(CHAT)).toBe(false);
  });

  it("renames the Hydra session from either channel, as VS Code sends the rename to the chat", async () => {
    harness = await startBridgeHarness();
    const { session } = await open(harness, version);
    for (const [channel, title] of [[CHAT, "From the chat"], [SESSION, "From the session"]] as const) {
      const { clientSeq } = session.client.dispatch(channel, act({ type: "session/titleChanged", title }));
      const echo = await session.waitFor((e) => e.origin?.clientSeq === clientSeq);
      expect(echo.rejectionReason).toBeUndefined();
    }
    expect(harness.hydra.writes.filter((write) => write.method === "PATCH").map((write) => write.params)).toEqual([
      { title: "From the chat" },
      { title: "From the session" },
    ]);
  });

  it("applies title changes from session_info_update and from the catalog", async () => {
    harness = await startBridgeHarness();
    const { session } = await open(harness, version);
    harness.hydra.listener!.update({ update: { sessionUpdate: "session_info_update", title: "Renamed live" } });
    await session.waitFor((e) => e.action.type === "session/titleChanged");
    expect((harness.core.store.state(SESSION) as SessionState).title).toBe("Renamed live");
    const announced = await session.waitFor((e) => e.action.type === "session/chatUpdated");
    expect(announced.action).toMatchObject({ chat: CHAT, changes: { title: "Renamed live" } });
    expect((harness.core.store.state(CHAT) as { title: string }).title).toBe("Renamed live");
    harness.hydra.rows = [ROW({ title: "Renamed in Hydra", updatedAt: "2026-10-05T01:00:00.000Z" })];
    await sleep(300);
    expect((harness.core.store.state(SESSION) as SessionState).title).toBe("Renamed in Hydra");
  });
});

void act;
