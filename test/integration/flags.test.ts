import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatView } from "../support/chat-view.js";
import { connectAhp, Driver, ROOT, type AhpConnection } from "../support/driver.js";
import { ScratchDaemon, until } from "../support/scratch.js";

const IS_READ = 32;
const IS_ARCHIVED = 64;

describe("read and archive marks against a scratch daemon", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let ahp: AhpConnection;

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({ name: "flags" });
    driver = await Driver.open(daemon);
    ahp = await connectAhp(daemon, driver, await driver.newSession());
  });

  afterAll(async () => {
    await ahp.session.shutdown();
    driver.close();
    await daemon.destroy();
  });

  async function rowStatus(id: string): Promise<number | undefined> {
    const result = (await ahp.session.client.request("listSessions", { channel: ROOT } as never)) as unknown as {
      items: Array<{ resource: string; status: number }>;
    };
    return result.items.find((item) => item.resource === `ahp-session:/${id}`)?.status;
  }

  async function opened(): Promise<{ id: string; view: ChatView }> {
    const id = await driver.newSession("/tmp");
    await driver.prompt(id, "ping");
    await until("session listed", async () => (await rowStatus(id)) !== undefined);
    return { id, view: await ChatView.open(ahp, id) };
  }

  it("archives from the session channel, mirrors it to the chat, lists it and persists it", async () => {
    const { id, view } = await opened();
    await view.dispatch({ type: "session/isArchivedChanged", isArchived: true }, view.sessionUri);
    expect(view.session().status & IS_ARCHIVED).toBe(IS_ARCHIVED);
    await view.until("chat mirrors the archive", (chat) => (chat.status & IS_ARCHIVED) === IS_ARCHIVED || undefined);
    await until("row archived", async () => (((await rowStatus(id)) ?? 0) & IS_ARCHIVED) === IS_ARCHIVED);
    const stored = JSON.parse(readFileSync(join(daemon.home, "extensions", "ahp", "flags.json"), "utf8"));
    expect(stored[id]).toEqual({ isRead: false, isArchived: true });
    await view.dispatch({ type: "session/isArchivedChanged", isArchived: false }, view.sessionUri);
    await until("row unarchived", async () => (((await rowStatus(id)) ?? 0) & IS_ARCHIVED) === 0);
    await view.close();
  });

  it("marks read from the chat channel and serves the mark to a fresh subscriber", async () => {
    const { id, view } = await opened();
    await view.dispatch({ type: "chat/isReadChanged", isRead: true });
    await view.until("chat read", (chat) => (chat.status & IS_READ) === IS_READ || undefined);
    await until("session mirrors the read mark", async () => (view.session().status & IS_READ) === IS_READ);
    await view.close();
    const fresh = await ChatView.open(ahp, id);
    expect(fresh.session().status & IS_READ).toBe(IS_READ);
    expect(fresh.chat().status & IS_READ).toBe(IS_READ);
    await fresh.close();
  });

  it("clears the read mark when the session sees new activity", async () => {
    const { id, view } = await opened();
    await view.dispatch({ type: "session/isReadChanged", isRead: true }, view.sessionUri);
    await until("row read", async () => (((await rowStatus(id)) ?? 0) & IS_READ) === IS_READ);
    await driver.prompt(id, "again");
    await until("row unread", async () => (((await rowStatus(id)) ?? 0) & IS_READ) === 0);
    await view.until("chat unread", (chat) => (chat.status & IS_READ) === 0 || undefined);
    await until("session unread", async () => (view.session().status & IS_READ) === 0);
    const stored = JSON.parse(readFileSync(join(daemon.home, "extensions", "ahp", "flags.json"), "utf8"));
    expect(stored[id]).toBeUndefined();
    await view.close();
  });
});
