import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionSummary } from "@microsoft/agent-host-protocol";
import { openSession } from "../support/harness.js";
import { connectAhp, Driver, ROOT, type AhpConnection } from "../support/driver.js";
import { ScratchDaemon, sleep, until, WORK_DIR, WORK_URI } from "../support/scratch.js";
import { sessionOf } from "../support/chat-uri.js";

async function list(ahp: AhpConnection, params: Record<string, unknown> = {}) {
  return (await ahp.session.client.request("listSessions", { channel: ROOT, ...params } as never)) as unknown as {
    items: SessionSummary[];
    nextCursor?: string;
  };
}

describe("one scratch daemon", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let host: string;
  let ahp: AhpConnection;

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({ name: "single" });
    driver = await Driver.open(daemon);
    host = await driver.newSession();
    ahp = await connectAhp(daemon, driver, host);
  });

  afterAll(async () => {
    await ahp.session.shutdown();
    driver.close();
    await daemon.destroy();
  });

  it("serves installed agents as root agents", () => {
    const providers = ahp.root.agents.map((a) => a.provider);
    expect(providers).toContain("fake");
    expect(providers).not.toContain("amp-acp");
  });

  it("lists a session only once it has had a real turn", async () => {
    const id = await driver.newSession();
    await new Promise((r) => setTimeout(r, 900));
    expect((await list(ahp)).items.some((s) => s.resource === sessionOf(id))).toBe(false);

    const added = until("sessionAdded", () =>
      ahp.session.notifications.find(
        (n) => n.method === "root/sessionAdded" && (n.params as { summary: SessionSummary }).summary.resource === sessionOf(id),
      ),
    );
    expect(await driver.prompt(id, "ping")).toBe("pong");
    await added;
    // The status comes from the catalog's last poll, which can predate the end of the prompt by a poll interval.
    const summary = await until("listed as idle", async () =>
      (await list(ahp)).items.find((s) => s.resource === sessionOf(id) && s.status === 1),
    );
    expect(summary.provider).toBe("fake");
  });

  it("does not list sessions that were never prompted, even though the poll sees them", async () => {
    const result = await driver.client.request<{ sessionId: string }>("session/new", {
      cwd: WORK_DIR,
      mcpServers: [],
      _meta: { "hydra-acp": { interactive: false } },
    });
    await new Promise((r) => setTimeout(r, 900));
    expect((await list(ahp)).items.some((s) => s.resource.endsWith(result.sessionId))).toBe(false);
    const seen = await daemon.admin.listSessions({ includeNonInteractive: true });
    expect(seen.sessions.some((s) => s.sessionId === result.sessionId)).toBe(true);
  });

  it("tracks busy state through the warm poll", async () => {
    const id = await driver.newSession();
    await driver.prompt(id, "ping");
    await until("session listed", async () => (await list(ahp)).items.some((s) => s.resource.endsWith(id)));
    const listed = (await list(ahp)).items.find((s) => s.resource.endsWith(id));
    expect(listed?.workingDirectories).toEqual([WORK_URI]);
  });

  it("pages listSessions newest first without repeats", async () => {
    for (let i = 0; i < 4; i += 1) {
      const id = await driver.newSession();
      await driver.prompt(id, "ping");
    }
    await until("all listed", async () => (await list(ahp)).items.length >= 5);
    // New sessions keep arriving and reordering as titles land, so page only once two polls agree.
    let last = "";
    await until("the catalog settles", async () => {
      await sleep(400);
      const now = JSON.stringify((await list(ahp)).items.map((s) => [s.resource, s.modifiedAt]));
      const settled = now === last;
      last = now;
      return settled;
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(ahp, { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((s) => s.resource));
      cursor = page.nextCursor;
    } while (cursor);
    const all = (await list(ahp)).items.map((s) => s.resource);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
    const modified = (await list(ahp)).items.map((s) => s.modifiedAt);
    expect(modified).toEqual([...modified].sort().reverse());
  });

  it("rejects a malformed paging cursor", async () => {
    await expect(list(ahp, { cursor: "not-a-cursor" })).rejects.toThrow(/cursor/);
  });

  describe("createSession and disposeSession", () => {
    const channel = "ahp-session:/vscode-made-1";

    it("creates a Hydra session, stamps ahpUri and walks creating to ready", async () => {
      const before = new Set((await daemon.admin.listSessions({ includeNonInteractive: true })).sessions.map((s) => s.sessionId));
      await ahp.session.client.request("createSession", {
        channel,
        provider: "fake",
        workingDirectories: [WORK_URI],
      } as never);
      const sub = await ahp.session.client.subscribe(channel);
      const state = sub.result.snapshot?.state as { lifecycle: string };
      if (state.lifecycle !== "ready") {
        await ahp.session.waitFor((e) => e.channel === channel && e.action.type === "session/ready", 5000);
      }
      const created = await until("hydra session", async () => {
        const page = await daemon.admin.listSessions({ includeNonInteractive: true });
        return page.sessions.find((s) => !before.has(s.sessionId) && s.cwd === WORK_DIR && s.agentId === "fake");
      });
      expect(created.interactive).not.toBe(true);
      const listed = (await list(ahp)).items.find((s) => s.resource === channel);
      expect(listed?.provider).toBe("fake");
      expect(ahp.session.notifications.some((n) => n.method === "root/sessionAdded" && (n.params as { summary: SessionSummary }).summary.resource === channel)).toBe(true);
      await ahp.session.client.unsubscribe(channel);
    });

    it("refuses a duplicate channel and an unknown provider", async () => {
      await expect(ahp.session.client.request("createSession", { channel } as never)).rejects.toMatchObject({ code: -32003 });
      await expect(
        ahp.session.client.request("createSession", { channel: "ahp-session:/other", provider: "nope" } as never),
      ).rejects.toMatchObject({ code: -32002 });
    });

    it("keeps the unprompted session listed across an extension restart because of the stamp", async () => {
      await daemon.admin.request("POST", "/v1/extensions/ahp/restart");
      await until("socket closed", () => ahp.session.closed);
      await ahp.session.shutdown().catch(() => undefined);
      const fresh = await until("reconnect", async () => {
        try {
          const session = await openSession(`ws://127.0.0.1:${daemon.ahpPort}/?tkn=${encodeURIComponent(ahp.token)}`);
          await session.client.initialize({ clientId: "after-restart", protocolVersions: ["0.9.0"] });
          return session;
        } catch {
          return undefined;
        }
      });
      ahp.session = fresh;
      const items = (await list(ahp)).items;
      expect(items.find((s) => s.resource === channel)).toBeDefined();
    });

    it("disposes through session/delete and announces removal", async () => {
      await ahp.session.client.subscribe(ROOT);
      await ahp.session.client.request("disposeSession", { channel } as never);
      await until("removed notification", () =>
        ahp.session.notifications.find((n) => n.method === "root/sessionRemoved" && (n.params as { session: string }).session === channel),
      );
      expect((await list(ahp)).items.some((s) => s.resource === channel)).toBe(false);
      await expect(ahp.session.client.request("disposeSession", { channel } as never)).rejects.toMatchObject({ code: -32001 });
    });
  });

  describe("token verbs", () => {
    it("lists, mints at a level and revokes, closing the live connection", async () => {
      const read = await connectAhp(daemon, driver, host, { label: "second", files: "read" });
      const listing = await driver.prompt(host, "/hydra ahp token list");
      expect(listing).toContain("second");
      expect(listing).toContain("files: read");
      const id = /(\w{8})\s+second/.exec(listing)?.[1];
      expect(id).toBeDefined();
      const reply = await driver.prompt(host, `/hydra ahp token revoke ${id}`);
      expect(reply).toContain("Revoked");
      expect(await read.session.closed).toBe(4001);
      expect(await driver.prompt(host, "/hydra ahp token mint bad --files nope")).toContain("--files must be one of");
    });
  });
});
