import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatView } from "../support/chat-view.js";
import { connectAhp, Driver, ROOT, type AhpConnection } from "../support/driver.js";
import { ScratchDaemon, until, WORK_DIR } from "../support/scratch.js";
import { sessionOf } from "../support/chat-uri.js";

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
    return result.items.find((item) => item.resource === sessionOf(id))?.status;
  }

  async function daemonRow(id: string): Promise<{ unread?: boolean } | undefined> {
    const page = await daemon.admin.listSessions({ includeNonInteractive: true } as never);
    return page.sessions.find((row) => row.sessionId === id);
  }

  // Done marks live in the session's own extension_state, so they travel with it.
  function marks(id: string): { isRead: boolean; isArchived: boolean } | undefined {
    const meta = JSON.parse(readFileSync(join(daemon.home, "sessions", id, "meta.json"), "utf8"));
    return meta.extensionState?.ahp?.flags;
  }

  async function opened(): Promise<{ id: string; view: ChatView }> {
    const id = await driver.newSession(WORK_DIR);
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
    await until("archive stored with the session", () => marks(id)?.isArchived === true);
    expect(marks(id)).toEqual({ isRead: false, isArchived: true, archivedAt: expect.any(Number) });
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

  it("keeps the read mark when the chat is reopened after its Hydra session detached", async () => {
    const { id, view } = await opened();
    await view.dispatch({ type: "session/isReadChanged", isRead: true }, view.sessionUri);
    await until("row read", async () => (((await rowStatus(id)) ?? 0) & IS_READ) === IS_READ);
    await view.close();
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    const fresh = await ChatView.open(ahp, id);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(fresh.chat().status & IS_READ).toBe(IS_READ);
    expect(fresh.session().status & IS_READ).toBe(IS_READ);
    expect(((await rowStatus(id)) ?? 0) & IS_READ).toBe(IS_READ);
    await fresh.close();
  }, 30_000);

  it("marks read from a session channel the client never subscribed to", async () => {
    const id = await driver.newSession(WORK_DIR);
    await driver.prompt(id, "ping");
    await until("session listed", async () => (await rowStatus(id)) !== undefined);
    ahp.session.client.dispatch(sessionOf(id), { type: "session/isReadChanged", isRead: true } as never);
    await until("row read", async () => (((await rowStatus(id)) ?? 0) & IS_READ) === IS_READ, 5_000);
  });

  it("clears the read mark when a turn ends after it", async () => {
    const { id, view } = await opened();
    await view.dispatch({ type: "session/isReadChanged", isRead: true }, view.sessionUri);
    await until("daemon has the read mark", async () => (await daemonRow(id))?.unread === false);
    await driver.prompt(id, "again");
    await until("row unread", async () => (((await rowStatus(id)) ?? 0) & IS_READ) === 0);
    await view.until("chat unread", (chat) => (chat.status & IS_READ) === 0 || undefined);
    await until("session unread", async () => (view.session().status & IS_READ) === 0);
    await until("marks cleared from the session", () => marks(id) === undefined);
    await view.close();
  });
});
