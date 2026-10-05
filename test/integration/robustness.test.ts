import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ActionEnvelope, ChatState, ReconnectResult, Snapshot, ToolCallState } from "@microsoft/agent-host-protocol";
import { ChatView, markdown, user } from "../support/chat-view.js";
import { connectAhp, Driver, ROOT, type AhpConnection } from "../support/driver.js";
import { act, openSession, type Session } from "../support/harness.js";
import { ReducerOracle } from "../support/oracle.js";
import { ScratchDaemon, until, WORK_URI } from "../support/scratch.js";
import { chatOf, sessionOf } from "../support/chat-uri.js";

describe("agent-initiated turns and attach mid-turn against a scratch daemon", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let ahp: AhpConnection;
  const views: ChatView[] = [];

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({ name: "robustness" });
    driver = await Driver.open(daemon);
    ahp = await connectAhp(daemon, driver, await driver.newSession());
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
  });

  async function listed(id: string): Promise<boolean> {
    const result = (await ahp.session.client.request("listSessions", { channel: ROOT } as never)) as unknown as {
      items: Array<{ resource: string }>;
    };
    return result.items.some((item) => item.resource === sessionOf(id));
  }

  async function prompted(): Promise<string> {
    const id = await driver.newSession();
    await driver.prompt(id, "ping");
    await until("session listed", () => listed(id));
    return id;
  }

  async function open(id: string): Promise<ChatView> {
    const view = await ChatView.open(ahp, id);
    views.push(view);
    return view;
  }

  const hydraTurnEnded = (id: string, reason: string): Promise<boolean> =>
    until(`_hydra_turn_ended ${reason}`, () =>
      driver.updates.some(
        (u) =>
          u.sessionId === id &&
          u.update.sessionUpdate === "_hydra_turn_ended" &&
          (u.update._meta as { "hydra-acp"?: { reason?: string } } | undefined)?.["hydra-acp"]?.reason === reason,
      ),
    );

  const agentTurn = (view: ChatView): Promise<string> =>
    view.until("agent-initiated turn", (chat) =>
      chat.activeTurn !== undefined && chat.activeTurn.message.origin.kind !== "user" ? chat.activeTurn.id : undefined,
    );

  it("shows a turn the agent started by itself, from start to finish", async () => {
    const view = await open(await prompted());
    await driver.prompt(view.id, "script:wake");
    const turnId = await agentTurn(view);
    const chat = await view.until("agent turn finished", (state) =>
      state.activeTurn === undefined && state.turns.some((turn) => turn.id === turnId) ? state : undefined,
    );
    expect(chat.turns.map((turn) => turn.message.text).slice(0, 2)).toEqual(["ping", "script:wake"]);
    const own = chat.turns.at(-1)!;
    expect(own).toMatchObject({ id: turnId, state: "complete" });
    expect(own.message.origin.kind).not.toBe("user");
    expect(markdown(own.responseParts)).toBe("woke done");
    expect(typeof own.duration).toBe("number");
  });

  it("cancels a turn the agent started by itself from AHP", async () => {
    const view = await open(await prompted());
    await driver.prompt(view.id, "script:wake-long");
    const turnId = await agentTurn(view);
    await view.dispatch({ type: "chat/turnCancelled", turnId, duration: 1 });
    const chat = await view.until("agent turn cancelled", (state) =>
      state.activeTurn === undefined && state.turns.some((turn) => turn.id === turnId) ? state : undefined,
    );
    expect(chat.turns.at(-1)).toMatchObject({ id: turnId, state: "cancelled" });
    await hydraTurnEnded(view.id, "cancelled");
    expect(await driver.agentLog(view.id)).toContain("cancel");
    expect((await daemon.admin.getSession(view.id)).busy).toBeFalsy();
  });

  it("cancels from AHP a turn that was already running when it subscribed", async () => {
    const id = await prompted();
    const turn = driver.client.request<{ stopReason: string }>("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "script:wait" }] });
    await until("agent waiting", () => driver.updates.some((u) => u.sessionId === id && u.update.content?.text === "waiting "));
    const view = await open(id);
    const active = view.chat().activeTurn;
    expect(active).toBeDefined();
    await view.dispatch({ type: "chat/turnCancelled", turnId: active!.id, duration: 1 });
    expect(await turn).toMatchObject({ stopReason: "cancelled" });
    const chat: ChatState = await view.until("turn cancelled", (state) => (state.activeTurn === undefined ? state : undefined));
    expect(chat.turns.at(-1)).toMatchObject({ id: active!.id, state: "cancelled" });
    expect(await driver.agentLog(id)).toContain("cancel");
  });

  it("offers a permission that was already pending when it subscribed", async () => {
    const id = await prompted();
    driver.permissionAnswer = "hold";
    const turn = driver.prompt(id, "script:ask");
    await until("driver holds the request", () => driver.held.length === 1);
    const view = await open(id);
    const pending = (): ToolCallState | undefined => view.toolCalls().find((call) => call.status === "pending-confirmation");
    const call = await view.until("replayed confirmation", () => pending());
    expect(call.toolCallId).toBe("ask-1");
    const turnId = view.chat().activeTurn!.id;
    await view.dispatch({ type: "chat/toolCallConfirmed", turnId, toolCallId: "ask-1", approved: false, reason: "denied" });
    expect(await turn).toContain("ask-1:reject");
    await view.until("turn finished", (state) => state.activeTurn === undefined);
    expect(view.toolCall("ask-1")?.status).not.toBe("pending-confirmation");
  });

  it("shows another client's amend as a cancelled turn followed by the new one", async () => {
    const view = await open(await prompted());
    const from = driver.notifications.length;
    const turn = driver.client.request<{ stopReason: string }>("session/prompt", { sessionId: view.id, prompt: [{ type: "text", text: "script:wait" }] });
    const added = await until("queue echo", () =>
      driver.notifications.slice(from).find((n) => n.method === "hydra-acp/prompt_queue/added" && n.params.sessionId === view.id),
    );
    const first = await view.until("waiting turn", (chat) => (chat.activeTurn?.message.text === "script:wait" ? chat.activeTurn.id : undefined));
    await until("agent waiting", () => driver.updates.some((u) => u.sessionId === view.id && u.update.content?.text === "waiting "));
    await driver.client.request("hydra-acp/prompt/amend", {
      sessionId: view.id,
      targetMessageId: added.params.messageId,
      prompt: [{ type: "text", text: "amended" }],
    });
    expect(await turn).toMatchObject({ stopReason: "cancelled" });
    const chat = await view.until("amended turn finished", (state) =>
      state.activeTurn === undefined && state.turns.at(-1)?.message.text === "amended" ? state : undefined,
    );
    const [cancelled, replacement] = chat.turns.slice(-2);
    expect(cancelled).toMatchObject({ id: first, state: "cancelled" });
    expect(replacement).toMatchObject({ state: "complete" });
    expect(markdown(replacement!.responseParts)).toBe("pong");
    expect(chat.turns.filter((entry) => entry.message.text === "amended")).toHaveLength(1);
  });
});

// One AHP client that can lose its socket and come back with reconnect, rebuilding its state from what it is sent.
class Reconnecting {
  readonly clientId = `restart-${Math.random().toString(16).slice(2)}`;
  private oracle = new ReducerOracle();
  private applied = 0;

  constructor(
    private readonly daemon: ScratchDaemon,
    private readonly token: string,
    public session: Session,
  ) {
  }

  static async connect(daemon: ScratchDaemon, token: string, id: string): Promise<Reconnecting> {
    const session = await openSession(`ws://127.0.0.1:${daemon.ahpPort}/?tkn=${encodeURIComponent(token)}`);
    const client = new Reconnecting(daemon, token, session);
    await session.client.initialize({ clientId: client.clientId, protocolVersions: ["0.9.0"], initialSubscriptions: [ROOT] });
    for (const uri of [sessionOf(id), chatOf(id)]) {
      client.oracle.applySnapshot((await session.client.subscribe(uri)).result.snapshot as Snapshot);
    }
    return client;
  }

  private lastSeen(): number {
    return Math.max(0, ...this.session.events.map((envelope) => envelope.serverSeq));
  }

  // Waits out the restart, then reconnects to whatever host comes up on the same port.
  async reconnect(): Promise<ReconnectResult> {
    await this.session.closed;
    const lastSeenServerSeq = this.lastSeen();
    const subscriptions = this.oracle.channels();
    const { session, result } = await until(
      "AHP host back",
      async () => {
        const fresh = await openSession(`ws://127.0.0.1:${this.daemon.ahpPort}/?tkn=${encodeURIComponent(this.token)}`).catch(() => undefined);
        if (!fresh) {
          return undefined;
        }
        try {
          return { session: fresh, result: await fresh.client.reconnect({ clientId: this.clientId, lastSeenServerSeq, subscriptions }) };
        } catch {
          fresh.ws.close();
          return undefined;
        }
      },
      30000,
      200,
    );
    this.session = session;
    this.applied = 0;
    if (result.type === "snapshot") {
      this.oracle = new ReducerOracle();
      for (const snapshot of result.snapshots) {
        this.oracle.applySnapshot(snapshot);
      }
    }
    return result;
  }

  chat(id: string): ChatState {
    for (const envelope of this.session.events.slice(this.applied)) {
      this.oracle.applyEnvelope(envelope);
    }
    this.applied = this.session.events.length;
    return this.oracle.state(chatOf(id)) as ChatState;
  }

  until<T>(id: string, what: string, probe: (chat: ChatState) => T | undefined | false): Promise<T> {
    return until(what, () => probe(this.chat(id)), 15000, 50);
  }

  async dispatch(id: string, action: Record<string, unknown>): Promise<ActionEnvelope> {
    const { clientSeq } = this.session.client.dispatch(chatOf(id), act(action));
    const echo = await this.session.waitFor((e) => e.origin?.clientSeq === clientSeq, 5000);
    expect(echo.rejectionReason, `${String(action.type)} rejected`).toBeUndefined();
    return echo;
  }

  async close(): Promise<void> {
    await this.session.shutdown().catch(() => undefined);
  }
}

describe("extension and daemon restarts against a scratch daemon", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let ahp: AhpConnection;
  const clients: Reconnecting[] = [];

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({ name: "restarts" });
    driver = await Driver.open(daemon);
    ahp = await connectAhp(daemon, driver, await driver.newSession());
    await ahp.session.shutdown();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.close();
    }
  });

  afterAll(async () => {
    driver.close();
    await daemon.destroy();
  });

  async function prompted(): Promise<string> {
    const id = await driver.newSession();
    await driver.prompt(id, "ping");
    return id;
  }

  async function watch(id: string): Promise<Reconnecting> {
    const client = await until("session listed", () => Reconnecting.connect(daemon, ahp.token, id).catch(() => undefined));
    clients.push(client);
    return client;
  }

  it("gives clients fresh snapshots after an extension restart, with a turn that is still running", async () => {
    const id = await prompted();
    const client = await watch(id);
    expect(client.chat(id).turns.map((turn) => turn.message.text)).toEqual(["ping"]);
    const turn = driver.client.request<{ stopReason: string }>("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "script:wait" }] });
    await client.until(id, "waiting turn", (chat) => chat.activeTurn);

    await daemon.admin.request("POST", "/v1/extensions/ahp/restart");
    const result = await client.reconnect();
    expect(result.type).toBe("snapshot");
    const chat = await client.until(id, "running turn after restart", (state) => (state.activeTurn ? state : undefined));
    expect(chat.turns.map((entry) => [entry.message.text, markdown(entry.responseParts)])).toEqual([["ping", "pong"]]);

    await client.dispatch(id, { type: "chat/turnCancelled", turnId: chat.activeTurn!.id, duration: 1 });
    expect(await turn).toMatchObject({ stopReason: "cancelled" });
    expect((await daemon.admin.getSession(id)).busy).toBeFalsy();
  });

  it("serves the same transcript after the daemon restarts, and takes a new prompt", async () => {
    const id = await prompted();
    const client = await watch(id);
    driver.close();
    await daemon.stop();
    await daemon.start();
    driver = await Driver.open(daemon);

    const result = await client.reconnect();
    expect(result.type).toBe("snapshot");
    const chat = client.chat(id);
    expect(chat.activeTurn).toBeUndefined();
    expect(chat.turns.map((entry) => [entry.message.text, markdown(entry.responseParts)])).toEqual([["ping", "pong"]]);

    await client.dispatch(id, { type: "chat/turnStarted", turnId: "after-restart", startedAt: new Date().toISOString(), message: user("again") });
    const done = await client.until(id, "turn after restart", (state) =>
      state.turns.find((entry) => entry.id === "after-restart" && entry.state === "complete"),
    );
    expect(markdown(done.responseParts)).toBe("pong");
  });
});

describe("idle close and session GC against a scratch daemon", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let ahp: AhpConnection;
  const views: ChatView[] = [];

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({
      name: "idle",
      daemon: { sessionIdleTimeoutSeconds: 2, sessionGcIntervalMinutes: 0.01, sessionGcMaxAgeDays: 3 / 86400 },
    });
    driver = await Driver.open(daemon);
    ahp = await connectAhp(daemon, driver, await driver.newSession());
  });

  afterEach(async () => {
    for (const view of views.splice(0)) {
      await view.close().catch(() => undefined);
    }
  });

  afterAll(async () => {
    await ahp.session.shutdown();
    driver.close();
    await daemon.destroy();
  });

  async function listed(channel: string): Promise<boolean> {
    const result = (await ahp.session.client.request("listSessions", { channel: ROOT } as never)) as unknown as {
      items: Array<{ resource: string }>;
    };
    return result.items.some((item) => item.resource === channel);
  }

  async function open(id: string): Promise<ChatView> {
    const view = await until("session listed", () => ChatView.open(ahp, id).catch(() => undefined));
    views.push(view);
    return view;
  }

  const cold = (id: string): Promise<boolean> =>
    until(`${id} cold`, async () => (await daemon.admin.getSession(id)).status === "cold", 20000);

  it("stays subscribed through an idle close and follows the session when it comes back", async () => {
    const id = await driver.newSession();
    await driver.prompt(id, "ping");
    const view = await open(id);
    await cold(id);
    expect(view.chat().activeTurn).toBeUndefined();

    await driver.attach(id);
    await driver.prompt(id, "from hydra");
    // Waking a cold session respawns its agent, which is slow on Windows runners.
    const resumed = await view.until("turn after resurrect", (chat) => chat.turns.find((turn) => turn.message.text === "from hydra" && turn.state === "complete"), 30_000);
    expect(markdown(resumed.responseParts)).toBe("pong");
    await driver.detach(id);

    await cold(id);
    await view.startTurn("after-idle", "from ahp");
    const own = await view.until("AHP turn after idle", (chat) => chat.turns.find((turn) => turn.id === "after-idle" && turn.state === "complete"));
    expect(markdown(own.responseParts)).toBe("pong");
    expect(view.chat().turns.map((turn) => turn.message.text)).toEqual(["ping", "from hydra", "from ahp"]);
  });

  it("drops a never-prompted session the GC collected while subscribed, and keeps prompted ones", async () => {
    const channel = sessionOf("gc-unprompted");
    await ahp.session.client.request("createSession", { channel, provider: "fake", workingDirectories: [WORK_URI] } as never);
    const view = await open("gc-unprompted");
    const kept = await driver.newSession();
    await driver.prompt(kept, "ping");

    await until(
      "root/sessionRemoved",
      () => ahp.session.notifications.find((n) => n.method === "root/sessionRemoved" && (n.params as { session: string }).session === channel),
      30000,
    );
    expect(await listed(channel)).toBe(false);
    await expect(ahp.session.client.subscribe(view.chatUri)).rejects.toMatchObject({ code: -32001 });
    expect(await listed(sessionOf(kept))).toBe(true);
    // Its own idle close runs on its own timer, which can trail the unprompted session's collection.
    await until(`${kept} cold`, async () => (await daemon.admin.getSession(kept)).status === "cold", 30000);
    expect(await listed(sessionOf(kept))).toBe(true);
  });
});
