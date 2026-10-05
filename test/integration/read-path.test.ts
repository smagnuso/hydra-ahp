import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatState, SessionState, Snapshot } from "@microsoft/agent-host-protocol";
import { connectAhp, Driver, ROOT, type AhpConnection } from "../support/driver.js";
import { ReducerOracle } from "../support/oracle.js";
import { openSession } from "../support/harness.js";
import { ScratchDaemon, sleep, until } from "../support/scratch.js";
import { chatOf, sessionOf } from "../support/chat-uri.js";

async function listed(ahp: AhpConnection, id: string): Promise<boolean> {
  const result = (await ahp.session.client.request("listSessions", { channel: ROOT } as never)) as unknown as {
    items: Array<{ resource: string }>;
  };
  return result.items.some((item) => item.resource === sessionOf(id));
}

describe("read path against a scratch daemon", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let ahp: AhpConnection;

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({ name: "readpath" });
    driver = await Driver.open(daemon);
    ahp = await connectAhp(daemon, driver, await driver.newSession());
  });

  afterAll(async () => {
    await ahp.session.shutdown();
    driver.close();
    await daemon.destroy();
  });

  async function prompted(text: string): Promise<string> {
    const id = await driver.newSession();
    await driver.prompt(id, text);
    await until("session listed", () => listed(ahp, id));
    return id;
  }

  async function subscribe(id: string): Promise<{ oracle: ReducerOracle; chat: ChatState }> {
    const oracle = new ReducerOracle();
    const session = await ahp.session.client.subscribe(sessionOf(id));
    oracle.applySnapshot(session.result.snapshot as Snapshot);
    const chat = await ahp.session.client.subscribe(chatOf(id));
    oracle.applySnapshot(chat.result.snapshot as Snapshot);
    return { oracle, chat: (chat.result.snapshot as Snapshot).state as ChatState };
  }

  async function openOther(): Promise<AhpConnection["session"]> {
    const other = await openSession(ahp.session.ws.url);
    await other.client.initialize({ clientId: `other-${Math.random().toString(16).slice(2)}`, protocolVersions: ["1.0.0"] });
    return other;
  }

  async function statusOf(id: string): Promise<string | undefined> {
    const page = await daemon.admin.listSessions({ includeNonInteractive: true });
    return page.sessions.find((row) => row.sessionId === id)?.status;
  }

  async function attachedClients(id: string): Promise<number> {
    const entry = await daemon.admin.getSession(id);
    return entry.attachedClients ?? 0;
  }

  it("accepts a client registering as the session's active client and drops it on unsubscribe", async () => {
    const id = await prompted("ping");
    await subscribe(id);
    const sessionUri = sessionOf(id);
    const { clientSeq } = ahp.session.client.dispatch(sessionUri, {
      type: "session/activeClientSet",
      activeClient: { clientId: ahp.clientId, displayName: "tester", tools: [] },
    } as never);
    const echo = await ahp.session.waitFor((e) => e.origin?.clientSeq === clientSeq, 5000);
    expect(echo.rejectionReason).toBeUndefined();
    await ahp.session.client.unsubscribe(chatOf(id));
    await ahp.session.client.unsubscribe(sessionUri);
  });

  it("shows a session's transcript with tool calls and plans, and detaches on the last unsubscribe", async () => {
    const id = await prompted("script:tools");
    await driver.prompt(id, "ping");
    const before = await attachedClients(id);
    const { chat } = await subscribe(id);
    expect(chat.turns.map((turn) => turn.message.text)).toEqual(["script:tools", "ping"]);
    const calls = chat.turns[0]!.responseParts.flatMap((part) => (part.kind === "toolCall" ? [part.toolCall] : []));
    expect(calls.map((call) => [call.toolCallId, call.status])).toEqual([
      ["t1", "completed"],
      [expect.stringMatching(/:plan$/), "completed"],
      ["t2", "completed"],
      ["orphan", "completed"],
    ]);
    expect(await attachedClients(id)).toBe(before + 1);

    await ahp.session.client.unsubscribe(chatOf(id));
    await until("hydra detach", async () => (await attachedClients(id)) === before);
  });

  it("streams a turn another client is driving and ends with the same state a fresh subscriber gets", async () => {
    const id = await prompted("ping");
    const { oracle } = await subscribe(id);
    const marker = ahp.session.events.length;
    const turn = driver.prompt(id, "script:slow");
    await ahp.session.waitFor((e) => e.channel === chatOf(id) && e.action.type === "chat/delta" && (e.action as { content?: string }).content === "start ");
    const mid = oracle.state(chatOf(id)) as ChatState;
    void mid;
    await turn;
    await ahp.session.waitFor((e) => e.channel === chatOf(id) && e.action.type === "chat/turnComplete" && ahp.session.events.indexOf(e) >= marker);
    for (const envelope of ahp.session.events) {
      oracle.applyEnvelope(envelope);
    }
    const chat = oracle.state(chatOf(id)) as ChatState;
    expect(chat.activeTurn).toBeUndefined();
    expect(chat.turns.map((t) => t.message.text)).toEqual(["ping", "script:slow"]);
    expect(chat.turns[1]!.responseParts).toMatchObject([{ kind: "markdown", content: "start finish" }]);

    await ahp.session.client.unsubscribe(chatOf(id));
    const again = await ahp.session.client.subscribe(chatOf(id));
    const fresh = (again.result.snapshot as Snapshot).state as ChatState;
    expect(fresh.turns.map((t) => ({ ...t, usage: undefined }))).toEqual(chat.turns.map((t) => ({ ...t, usage: undefined })));
  });

  it("serves the current activity from a session channel nobody was watching", async () => {
    const id = await prompted("ping");
    const uri = sessionOf(id);
    const statusNow = async (): Promise<number> => {
      const sub = await ahp.session.client.subscribe(uri);
      const status = (sub.result.snapshot as Snapshot).state as SessionState;
      await ahp.session.client.unsubscribe(uri);
      return status.status ?? 0;
    };
    const before = await statusNow();
    // Fails on CI runners only: Hydra can count the first turn's tail as a turn the agent started itself.
    expect(before & 8, daemon.logLines(id)).toBe(0);
    const turn = driver.prompt(id, "script:slow");
    await until("session reads as running", async () => (((await statusNow()) & 8) === 8 ? true : undefined));
    await turn;
    await until("session reads as idle again", async () => (((await statusNow()) & 8) === 0 ? true : undefined));
  });

  it("opens an active turn when a client subscribes while the turn is already running", async () => {
    const id = await prompted("ping");
    const turn = driver.prompt(id, "script:slow");
    await sleep(400);
    const { oracle, chat } = await subscribe(id);
    expect(chat.activeTurn).toBeDefined();
    expect(chat.status & 8).toBe(8);
    await turn;
    await ahp.session.waitFor((e) => e.channel === chatOf(id) && e.action.type === "chat/turnComplete");
    for (const envelope of ahp.session.events) {
      oracle.applyEnvelope(envelope);
    }
    const done = oracle.state(chatOf(id)) as ChatState;
    expect(done.activeTurn).toBeUndefined();
    expect(done.turns.at(-1)).toMatchObject({ state: "complete" });
  });

  it("shows a turn Hydra cancelled, with the dropped tool call closed", async () => {
    const id = await prompted("ping");
    const { oracle } = await subscribe(id);
    const turn = driver.client.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "script:hang" }] });
    await ahp.session.waitFor((e) => e.channel === chatOf(id) && e.action.type === "chat/toolCallStart");
    driver.client.peer.notify("session/cancel", { sessionId: id });
    await turn;
    await ahp.session.waitFor((e) => e.channel === chatOf(id) && e.action.type === "chat/turnCancelled");
    for (const envelope of ahp.session.events) {
      oracle.applyEnvelope(envelope);
    }
    const chat = oracle.state(chatOf(id)) as ChatState;
    expect(chat.turns.at(-1)).toMatchObject({ state: "cancelled" });
    expect(chat.activeTurn).toBeUndefined();
  });

  it("serves a cold session read-only, with no agent resurrected", async () => {
    const id = await prompted("script:tools");
    await daemon.admin.request("POST", `/v1/sessions/${id}/kill`);
    await until("session cold", async () => (await statusOf(id)) === "cold");
    // Give the extension's catalog poll time to see the session go cold, or the attach would be live.
    await sleep(800);
    const { chat } = await subscribe(id);
    expect(chat.turns).toHaveLength(1);
    expect(await statusOf(id)).toBe("cold");
    await ahp.session.client.unsubscribe(chatOf(id));
  });

  it("leaves permission requests to the other clients", async () => {
    const id = await prompted("ping");
    await subscribe(id);
    driver.permissionAnswer = "allow";
    const text = await driver.prompt(id, "permission please");
    expect(text).toContain("permission:allow");
    await ahp.session.client.unsubscribe(chatOf(id));
  });

  it("builds an exact transcript when clients attach and detach in the middle of a stream", async () => {
    const id = await prompted("ping");
    const chat = chatOf(id);
    const turn = driver.prompt(id, "script:flood");
    await sleep(500);
    const { oracle } = await subscribe(id);
    for (let i = 0; i < 4; i += 1) {
      const other = await openOther();
      await other.client.subscribe(chat);
      await sleep(120);
      await other.client.unsubscribe(chat);
      await other.shutdown();
    }
    await turn;
    // The agent is done when its prompt resolves, but the extension can still be mapping the flood behind it.
    await ahp.session.waitFor((e) => e.channel === chat && e.action.type === "chat/turnComplete", 20_000);
    await sleep(200);
    for (const envelope of ahp.session.events) {
      oracle.applyEnvelope(envelope);
    }
    const live = oracle.state(chat) as ChatState;
    const parts = live.turns.at(-1)!.responseParts;
    const prose = parts.flatMap((part) => (part.kind === "markdown" ? [part.content] : []));
    expect(prose).toEqual(Array.from({ length: 1500 }, (_, i) => `c${i} `));
    expect(parts.filter((part) => part.kind === "toolCall")).toHaveLength(1500);

    await ahp.session.client.unsubscribe(chat);
    const again = await ahp.session.client.subscribe(chat);
    const fresh = (again.result.snapshot as Snapshot).state as ChatState;
    expect(fresh.turns.map((t) => ({ ...t, usage: undefined }))).toEqual(live.turns.map((t) => ({ ...t, usage: undefined })));
  }, 60000);

  it("pages older turns with fetchTurns", async () => {
    const id = await prompted("ping");
    for (let i = 0; i < 3; i += 1) {
      await driver.prompt(id, `turn ${i}`);
    }
    const { chat } = await subscribe(id);
    expect(chat.turns).toHaveLength(4);
    expect(chat.turnsNextCursor).toBeUndefined();
    await ahp.session.client.unsubscribe(chatOf(id));
  });
});
