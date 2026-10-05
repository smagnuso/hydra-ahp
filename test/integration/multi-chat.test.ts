import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatState, SessionState } from "@microsoft/agent-host-protocol";
import { connectAhp, Driver, ROOT, type AhpConnection } from "../support/driver.js";
import { act, openSession } from "../support/harness.js";
import { ScratchDaemon, until } from "../support/scratch.js";
import { chatOf } from "../support/chat-uri.js";

const text = (chat: ChatState, index: number): string | undefined => chat.turns[index]?.message.text;

describe("several chats in one session against a scratch daemon", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let ahp: AhpConnection;

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({ name: "multichat" });
    driver = await Driver.open(daemon);
    ahp = await connectAhp(daemon, driver, await driver.newSession(), { version: "1.0.0" });
  });

  afterAll(async () => {
    await ahp.session.shutdown();
    driver.close();
    await daemon.destroy();
  });

  async function items(): Promise<Array<{ resource: string; chats?: Array<{ resource: string }>; defaultChat?: string }>> {
    const result = (await ahp.session.client.request("listSessions", { channel: ROOT } as never)) as unknown as {
      items: Array<{ resource: string; chats?: Array<{ resource: string }>; defaultChat?: string }>;
    };
    return result.items;
  }

  async function prompted(): Promise<{ id: string; uri: string; chat: string }> {
    const id = await driver.newSession("/tmp");
    await driver.prompt(id, "first");
    const uri = `ahp-session:/${id}`;
    await until("session listed", async () => ((await items()).some((item) => item.resource === uri) ? true : undefined));
    return { id, uri, chat: chatOf(id) };
  }

  async function session(uri: string): Promise<SessionState> {
    const sub = await ahp.session.client.subscribe(uri);
    return sub.result.snapshot?.state as SessionState;
  }

  async function chatState(chat: string): Promise<ChatState> {
    const sub = await ahp.session.client.subscribe(chat);
    return sub.result.snapshot?.state as ChatState;
  }

  async function say(chat: string, turnId: string, words: string): Promise<void> {
    const { clientSeq } = ahp.session.client.dispatch(
      chat,
      act({ type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message: { text: words, origin: { kind: "user" } } }),
    );
    const echo = await ahp.session.waitFor((e) => e.origin?.clientSeq === clientSeq, 8000);
    expect(echo.rejectionReason).toBeUndefined();
    await ahp.session.waitFor((e) => e.channel === chat && e.action.type === "chat/turnComplete" && (e.action as { turnId?: string }).turnId === turnId, 15000);
  }

  it("advertises multiple chats with fork and side chats on every agent", () => {
    for (const agent of ahp.root.agents) {
      expect(agent.capabilities?.multipleChats).toEqual({ fork: true, sideChat: true });
    }
  });

  it("adds a chat as a second Hydra session, announces it, and keeps the transcripts apart", async () => {
    const { uri, chat } = await prompted();
    const state = await session(uri);
    expect(state.chats.map((c) => c.resource)).toEqual([chat]);
    const second = `ahp-chat:/${randomUUID()}`;
    const before = ahp.session.events.length;
    await ahp.session.client.request("createChat", { channel: uri, chat: second } as never);
    await ahp.session.waitFor((e) => e.channel === uri && e.action.type === "session/chatAdded", 8000);
    expect(ahp.session.events.slice(before).some((e) => e.channel === uri && e.action.type === "session/chatAdded")).toBe(true);
    const row = (await items()).find((item) => item.resource === uri);
    expect(row?.chats?.map((c) => c.resource)).toEqual([chat, second]);
    expect(row?.defaultChat).toBe(chat);

    const fresh = await chatState(second);
    expect(fresh.turns).toHaveLength(0);
    expect(fresh.title).toBe("Untitled chat");
    await say(second, "second-1", "hello second");
    const after = await chatState(second);
    expect(text(after, 0)).toBe("hello second");
    const original = await chatState(chat);
    expect(original.turns.map((t) => t.message.text)).toEqual(["first"]);
    expect(daemon.admin).toBeDefined();
    const hydraRows = (await daemon.admin.listSessions({ includeNonInteractive: true })).sessions;
    expect(hydraRows.filter((s) => s.agentId === "fake").length).toBeGreaterThanOrEqual(2);
  });

  it("forks a chat at a turn into a new Hydra session that records its source", async () => {
    const { id, uri, chat } = await prompted();
    await session(uri);
    const original = await chatState(chat);
    const turnId = original.turns.at(-1)!.id;
    const forked = `ahp-chat:/${randomUUID()}`;
    await ahp.session.client.request("createChat", {
      channel: uri,
      chat: forked,
      source: { kind: "fork", chat, turnId },
    } as never);
    const row = await until("fork listed", async () => {
      const found = (await items()).find((item) => item.resource === uri);
      return found?.chats?.some((c) => c.resource === forked) ? found : undefined;
    });
    expect(row.chats).toHaveLength(2);
    const members = (await daemon.admin.listSessions({ includeNonInteractive: true })).sessions;
    expect(members.find((s) => s.forkedFromSessionId === id)).toBeDefined();
    await chatState(forked);
    await until("copied turn appears", async () => (text(await chatState(forked), 0) === "first" ? true : undefined));
    await say(forked, "after-fork", "next");
    const done = await chatState(forked);
    expect([text(done, 0), text(done, 1)]).toEqual(["first", "next"]);
  });

  it("opens a side chat that knows its source but shows none of its history", async () => {
    const { id, uri, chat } = await prompted();
    await session(uri);
    const turnId = (await chatState(chat)).turns.at(-1)!.id;
    const side = `ahp-chat:/${randomUUID()}`;
    const selection = { text: "first" };
    await ahp.session.client.request("createChat", { channel: uri, chat: side, source: { kind: "sideChat", chat, turnId, selection } } as never);
    const row = await until("side chat listed", async () => {
      const found = (await items()).find((item) => item.resource === uri) as { chats?: Array<{ resource: string; origin?: unknown }> } | undefined;
      return found?.chats?.some((c) => c.resource === side) ? found : undefined;
    });
    const expected = { kind: "sideChat", chat, turnId, selection };
    expect(row.chats?.find((c) => c.resource === side)?.origin).toEqual(expected);
    const members = (await daemon.admin.listSessions({ includeNonInteractive: true })).sessions;
    expect(members.find((s) => s.forkedFromSessionId === id)).toBeDefined();
    const opened = await chatState(side);
    expect(opened.origin).toEqual(expected);
    expect(opened.turns).toHaveLength(0);
    await say(side, "aside", "what was that?");
    const done = await chatState(side);
    expect(done.turns.map((turn) => turn.message.text)).toEqual(["what was that?"]);
    expect((await chatState(chat)).turns.map((turn) => turn.message.text)).toEqual(["first"]);
  });

  it("starts the first turn of a chat created with an initial message", async () => {
    const { uri } = await prompted();
    await session(uri);
    const chat = `ahp-chat:/${randomUUID()}`;
    await ahp.session.client.request("createChat", {
      channel: uri,
      chat,
      initialMessage: { text: "opening line", origin: { kind: "user" } },
    } as never);
    await chatState(chat);
    const done = await until("initial turn finished", async () => {
      const state = (await ahp.session.client.subscribe(chat)).result.snapshot?.state as ChatState;
      return state.turns.length === 1 && !state.activeTurn ? state : undefined;
    }, 20000);
    expect(text(done, 0)).toBe("opening line");
  });

  it("runs the initial message of a chat nobody opened, then lets go of it", async () => {
    const { uri } = await prompted();
    const chat = `ahp-chat:/${randomUUID()}`;
    await ahp.session.client.request("createChat", {
      channel: uri,
      chat,
      initialMessage: { text: "headless hello", origin: { kind: "user" } },
    } as never);
    const row = await until("headless turn recorded", async () => {
      const rows = (await daemon.admin.listSessions({ includeNonInteractive: true })).sessions;
      const found = rows.find((r) => r.title === "headless hello");
      return found && !found.busy ? found : undefined;
    }, 20000);
    await until("attachment released", async () => ((await daemon.admin.getSession(row.sessionId)).attachedClients === 0 ? true : undefined));
  });

  it("answers resolveSessionConfig with an empty schema", async () => {
    const result = (await ahp.session.client.request("resolveSessionConfig", { channel: ROOT, provider: "fake" } as never)) as unknown as {
      schema: { type: string; properties: Record<string, unknown> };
      values: Record<string, unknown>;
    };
    expect(result.schema).toEqual({ type: "object", properties: {} });
    expect(result.values).toEqual({});
  });

  it("removes one chat, promotes the next default, and removes the session with its last chat", async () => {
    const { id, uri, chat } = await prompted();
    await session(uri);
    const second = `ahp-chat:/${randomUUID()}`;
    await ahp.session.client.request("createChat", { channel: uri, chat: second } as never);
    await until("two chats", async () => {
      const row = (await items()).find((item) => item.resource === uri);
      return row?.chats?.length === 2 ? true : undefined;
    });

    await ahp.session.client.request("disposeChat", { channel: chat } as never);
    await ahp.session.waitFor((e) => e.channel === uri && e.action.type === "session/chatRemoved", 8000);
    await until("first chat's Hydra session deleted", async () => (await daemon.admin.getSession(id).then(() => undefined, () => true)));
    await until("second is the default", async () => {
      const row = (await items()).find((item) => item.resource === uri);
      return row?.chats?.length === 1 && row.defaultChat === second ? true : undefined;
    });
    expect((await session(uri)).defaultChat).toBe(second);

    await ahp.session.client.request("disposeChat", { channel: second } as never);
    await until("session gone", async () => ((await items()).some((item) => item.resource === uri) ? undefined : true));
  });

  it("disposeSession removes every chat", async () => {
    const { id, uri } = await prompted();
    const second = `ahp-chat:/${randomUUID()}`;
    await ahp.session.client.request("createChat", { channel: uri, chat: second } as never);
    await until("two chats", async () => {
      const row = (await items()).find((item) => item.resource === uri);
      return row?.chats?.length === 2 ? true : undefined;
    });
    await ahp.session.client.request("disposeSession", { channel: uri } as never);
    await until("session gone", async () => ((await items()).some((item) => item.resource === uri) ? undefined : true));
    await until("hydra session deleted", async () => (await daemon.admin.getSession(id).then(() => undefined, () => true)));
  });

  it("refuses a duplicate chat, an unknown session, a side chat and a foreign source", async () => {
    const { uri, chat } = await prompted();
    await session(uri);
    const dup = `ahp-chat:/${randomUUID()}`;
    await ahp.session.client.request("createChat", { channel: uri, chat: dup } as never);
    await expect(ahp.session.client.request("createChat", { channel: uri, chat: dup } as never)).rejects.toMatchObject({ code: -32003 });
    await expect(ahp.session.client.request("createChat", { channel: "ahp-session:/nope", chat: `ahp-chat:/${randomUUID()}` } as never)).rejects.toMatchObject({ code: -32001 });
    await expect(
      ahp.session.client.request("createChat", { channel: uri, chat: `ahp-chat:/${randomUUID()}`, source: { kind: "branch", chat, turnId: "x" } } as never),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      ahp.session.client.request("createChat", { channel: uri, chat: `ahp-chat:/${randomUUID()}`, source: { kind: "fork", chat: "ahp-chat:/elsewhere", turnId: "x" } } as never),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(ahp.session.client.request("createChat", { channel: uri, chat: "not-a-chat" } as never)).rejects.toMatchObject({ code: -32602 });
    await expect(ahp.session.client.request("disposeChat", { channel: "ahp-chat:/missing" } as never)).rejects.toMatchObject({ code: -32001 });
  });

  it("keeps the chats of a session across an extension restart", async () => {
    const { uri, chat } = await prompted();
    const second = `ahp-chat:/${randomUUID()}`;
    await ahp.session.client.request("createChat", { channel: uri, chat: second } as never);
    await until("two chats", async () => {
      const row = (await items()).find((item) => item.resource === uri);
      return row?.chats?.length === 2 ? true : undefined;
    });
    await daemon.admin.request("POST", "/v1/extensions/ahp/restart");
    await until("socket closed", () => ahp.session.closed);
    await ahp.session.shutdown().catch(() => undefined);
    ahp.session = await until("reconnect", async () => {
      try {
        const opened = await openSession(`ws://127.0.0.1:${daemon.ahpPort}/?tkn=${encodeURIComponent(ahp.token)}`);
        await opened.client.initialize({ clientId: "after-restart", protocolVersions: ["1.0.0"] });
        return opened;
      } catch {
        return undefined;
      }
    });
    const row = await until("both chats listed again", async () => {
      const found = (await items()).find((item) => item.resource === uri);
      return found?.chats?.length === 2 ? found : undefined;
    });
    expect(row.chats?.map((c) => c.resource)).toEqual([chat, second]);
    expect((await session(uri)).chats.map((c) => c.resource)).toEqual([chat, second]);
  });
});
