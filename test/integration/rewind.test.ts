import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { connectAhp, Driver, ROOT, type AhpConnection } from "../support/driver.js";
import { act } from "../support/harness.js";
import { ScratchDaemon, until, WORK_DIR } from "../support/scratch.js";
import { chatOf, sessionOf } from "../support/chat-uri.js";

const texts = (chat: ChatState): Array<string | undefined> => chat.turns.map((turn) => turn.message.text);

describe("edit and resend against a scratch daemon", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let ahp: AhpConnection;

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({ name: "rewind" });
    driver = await Driver.open(daemon);
    ahp = await connectAhp(daemon, driver, await driver.newSession(), { version: "1.0.0" });
  });

  afterAll(async () => {
    await ahp.session.shutdown();
    driver.close();
    await daemon.destroy();
  });

  async function listed(uri: string): Promise<boolean> {
    const result = (await ahp.session.client.request("listSessions", { channel: ROOT } as never)) as unknown as {
      items: Array<{ resource: string }>;
    };
    return result.items.some((item) => item.resource === uri);
  }

  async function chatState(chat: string): Promise<ChatState> {
    const sub = await ahp.session.client.subscribe(chat);
    return sub.result.snapshot?.state as ChatState;
  }

  async function dispatch(chat: string, action: Record<string, unknown>): Promise<string | undefined> {
    const { clientSeq } = ahp.session.client.dispatch(chat, act(action));
    const echo = await ahp.session.waitFor((e) => e.origin?.clientSeq === clientSeq, 15000);
    return echo.rejectionReason;
  }

  async function say(chat: string, turnId: string, words: string): Promise<void> {
    const reason = await dispatch(chat, { type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message: { text: words, origin: { kind: "user" } } });
    expect(reason).toBeUndefined();
    await ahp.session.waitFor((e) => e.channel === chat && e.action.type === "chat/turnComplete" && (e.action as { turnId?: string }).turnId === turnId, 15000);
  }

  async function twoTurns(): Promise<{ id: string; chat: string }> {
    const id = await driver.newSession(WORK_DIR);
    await driver.prompt(id, "first");
    const uri = sessionOf(id);
    await until("session listed", async () => ((await listed(uri)) ? true : undefined));
    const chat = chatOf(id);
    await ahp.session.client.subscribe(uri);
    await chatState(chat);
    await say(chat, `second-${id}`, "second");
    return { id, chat };
  }

  async function historyText(id: string): Promise<string> {
    return JSON.stringify((await daemon.admin.historyPage(id, Number.MAX_SAFE_INTEGER, 50)).entries);
  }

  async function forksOf(id: string): Promise<number> {
    const rows = (await daemon.admin.listSessions({ includeNonInteractive: true })).sessions;
    return rows.filter((row) => row.forkedFromSessionId === id).length;
  }

  it("rewinds the Hydra session in place and resends into it", async () => {
    const { id, chat } = await twoTurns();
    const kept = (await chatState(chat)).turns[0]!.id;
    expect(await dispatch(chat, { type: "chat/truncated", turnId: kept })).toBeUndefined();
    expect(texts(await chatState(chat))).toEqual(["first"]);
    expect(await historyText(id)).not.toContain('"second"');

    await say(chat, `edited-${id}`, "edited");
    expect(texts(await chatState(chat))).toEqual(["first", "edited"]);
    expect(await forksOf(id)).toBe(0);
  });

  it("clears every turn when no turn is kept", async () => {
    const { id, chat } = await twoTurns();
    expect(await dispatch(chat, { type: "chat/truncated" })).toBeUndefined();
    expect(texts(await chatState(chat))).toEqual([]);
    await say(chat, `fresh-${id}`, "fresh");
    expect(texts(await chatState(chat))).toEqual(["fresh"]);
  });

  it("leaves Hydra alone when nothing would be dropped", async () => {
    const { id, chat } = await twoTurns();
    const before = await historyText(id);
    const last = (await chatState(chat)).turns.at(-1)!.id;
    expect(await dispatch(chat, { type: "chat/truncated", turnId: last })).toBeUndefined();
    expect(await dispatch(chat, { type: "chat/truncated", turnId: "no-such-turn" })).toBeUndefined();
    expect(texts(await chatState(chat))).toEqual(["first", "second"]);
    expect(await historyText(id)).toBe(before);
  });

  it("follows a rewind another client made", async () => {
    const { id, chat } = await twoTurns();
    const pages = (await daemon.admin.historyPage(id, Number.MAX_SAFE_INTEGER, 50)).entries;
    const firstPrompt = pages
      .map((entry) => (entry.params as { update?: { sessionUpdate?: string; messageId?: string } }).update)
      .find((update) => update?.sessionUpdate === "prompt_received")?.messageId;
    await daemon.admin.rewindSession(id, firstPrompt!);
    await until("chat follows the rewind", async () => {
      const state = await chatState(chat);
      return texts(state).join("|") === "first" ? true : undefined;
    });
  });
});
