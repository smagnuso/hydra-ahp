import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionSummary } from "@microsoft/agent-host-protocol";
import { connectAhp, Driver, ROOT, type AhpConnection } from "../support/driver.js";
import { ScratchDaemon, until, WORK_DIR } from "../support/scratch.js";
import { sessionOf } from "../support/chat-uri.js";

const PASSWORD = "scratch-password";

// Daemon "alpha" runs the extension and federates to "beta".
describe("two scratch daemons, alpha federated to beta", () => {
  let alpha: ScratchDaemon;
  let beta: ScratchDaemon;
  let alphaDriver: Driver;
  let betaDriver: Driver;
  let host: string;
  let ahp: AhpConnection;
  let betaSession: string;
  let federatedId: string;

  const list = async (): Promise<SessionSummary[]> =>
    ((await ahp.session.client.request("listSessions", { channel: ROOT } as never)) as unknown as { items: SessionSummary[] }).items;

  beforeAll(async () => {
    beta = await ScratchDaemon.create({ name: "beta", ahp: false, password: PASSWORD, probe: true });
    alpha = await ScratchDaemon.create({ name: "alpha", probe: true });
    await alpha.admin.request("POST", "/v1/remotes", {
      name: "beta",
      host: "127.0.0.1",
      port: beta.port,
      password: PASSWORD,
    });
    alphaDriver = await Driver.open(alpha);
    betaDriver = await Driver.open(beta);
    host = await alphaDriver.newSession();
    ahp = await connectAhp(alpha, alphaDriver, host);
    betaSession = await betaDriver.newSession(WORK_DIR);
    await betaDriver.prompt(betaSession, "ping");
    federatedId = `beta:${betaSession}`;
  });

  afterAll(async () => {
    await ahp?.session.shutdown();
    alphaDriver?.close();
    betaDriver?.close();
    await alpha?.destroy();
    await beta?.destroy();
  });

  it("lists the peer's sessions under name:localId with the remote as label", async () => {
    const summary = await until("federated row", async () => (await list()).find((s) => s.resource === sessionOf(federatedId)), 20000);
    expect(summary.provider).toBe("fake");
    expect((summary as unknown as { project?: { displayName: string } }).project?.displayName).toBe("beta");
    expect(summary.workingDirectories).toBeUndefined();
  });

  it("upserts a federated row that appears after the first poll", async () => {
    const later = await betaDriver.newSession(WORK_DIR);
    await betaDriver.prompt(later, "ping");
    const row = await until("second federated row", async () => (await list()).find((s) => s.resource === sessionOf(`beta:${later}`)), 20000);
    expect(row).toBeDefined();
    expect(ahp.session.notifications.some((n) => n.method === "root/sessionAdded" && (n.params as { summary: SessionSummary }).summary.resource.endsWith(`beta:${later}`))).toBe(true);
  });

  it("drops a federated row when the peer deletes the session", async () => {
    const doomed = await betaDriver.newSession(WORK_DIR);
    await betaDriver.prompt(doomed, "ping");
    await until("row appears", async () => (await list()).find((s) => s.resource.endsWith(`beta:${doomed}`)), 20000);
    await beta.admin.deleteSession(doomed);
    await until("row removed", async () => !(await list()).some((s) => s.resource.endsWith(`beta:${doomed}`)), 20000);
    expect(ahp.session.notifications.some((n) => n.method === "root/sessionRemoved" && (n.params as { session: string }).session.endsWith(`beta:${doomed}`))).toBe(true);
  });

  it("forwards attach and prompt through alpha", async () => {
    await alphaDriver.attach(federatedId);
    expect(await alphaDriver.prompt(federatedId, "ping again")).toBe("pong");
    await alphaDriver.detach(federatedId);
  });

  // Hydra 0.1.197 relays only hydra-acp/session/request_permission upstream, but a peer sends
  // session/request_permission, so the forwarding connection abstains and no local client is ever asked.
  it("does not relay federated permission requests to the local client; the peer's own clients decide", async () => {
    await alphaDriver.attach(federatedId);
    alphaDriver.permissionAnswer = "allow";
    betaDriver.permissionAnswer = "allow";
    const asked = betaDriver.permissions.length;
    expect(await alphaDriver.prompt(federatedId, "needs permission")).toBe("pongpermission:allow");
    expect(alphaDriver.permissions).toHaveLength(0);
    expect(betaDriver.permissions.length).toBe(asked + 1);

    betaDriver.permissionAnswer = "abstain";
    expect(await alphaDriver.prompt(federatedId, "needs permission")).toBe("pongpermission:none");
    expect(alphaDriver.permissions).toHaveLength(0);
    betaDriver.permissionAnswer = "allow";
    await alphaDriver.detach(federatedId);
  });

  it("pages history through the forwarding", async () => {
    for (let i = 0; i < 3; i += 1) {
      await betaDriver.prompt(betaSession, `turn ${i}`);
    }
    // The forwarded single-session route answers with the peer's raw id, not name:localId.
    const info = await alpha.admin.request<{ sessionId: string }>("GET", `/v1/sessions/${encodeURIComponent(federatedId)}`);
    expect(info.sessionId).toBe(betaSession);
    const direct = await beta.admin.historyPage(betaSession, Number.MAX_SAFE_INTEGER, 2);
    const forwarded = await alpha.admin.historyPage(federatedId, Number.MAX_SAFE_INTEGER, 2);
    expect(forwarded.entries.length).toBeGreaterThan(0);
    expect(forwarded).toEqual(direct);
  });

  it("reports whether extension_state reaches a federated session", async () => {
    const run = async (daemon: ScratchDaemon, sessionId: string, readOnly = false) => {
      const result = join(daemon.home, "probe-result.json");
      rmSync(result, { force: true });
      writeFileSync(join(daemon.home, "probe-job.json"), JSON.stringify({ sessionId, readOnly }));
      return until("probe result", () => (existsSync(result) ? JSON.parse(readFileSync(result, "utf8")) : undefined), 10000);
    };
    const local = await run(alpha, host);
    expect(local.get.result.value).toEqual({ at: 1 });
    const federated = await run(alpha, federatedId);
    // set answers ok but nothing is stored: not on alpha under the alias, and not on beta's session either.
    expect(federated.set.result).toEqual({ ok: true });
    expect(federated.get.result.value).toBeNull();
    expect(federated.list.result.state).toEqual({});
    const onPeer = await run(beta, betaSession, true);
    expect(onPeer.get.result.value).toBeNull();
  });
});
