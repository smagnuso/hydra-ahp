import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RootState } from "@microsoft/agent-host-protocol";
import { ChatView } from "../support/chat-view.js";
import { connectAhp, Driver, ROOT, type AhpConnection } from "../support/driver.js";
import { openSession } from "../support/harness.js";
import { ScratchDaemon, until } from "../support/scratch.js";

describe("model lists learned from sessions against a scratch daemon", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let ahp: AhpConnection;

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({ name: "models" });
    driver = await Driver.open(daemon);
    ahp = await connectAhp(daemon, driver, await driver.newSession(), { version: "1.0.0" });
    await ahp.session.client.subscribe(ROOT);
  });

  afterAll(async () => {
    await ahp.session.shutdown();
    driver.close();
    await daemon.destroy();
  });

  const modelsOf = (root: RootState, provider: string): string[] =>
    (root.agents.find((agent) => agent.provider === provider)?.models ?? []).map((model) => model.id);

  it("starts with no models for an agent nobody has used", () => {
    expect(modelsOf(ahp.root, "fake-models")).toEqual([]);
  });

  it("publishes an agent's models once a session of it is opened, and keeps them across a restart", async () => {
    const id = await driver.newSession("/tmp", "fake-models");
    await driver.prompt(id, "ping");
    await until("session listed", async () => {
      const result = (await ahp.session.client.request("listSessions", { channel: ROOT } as never)) as unknown as {
        items: Array<{ resource: string }>;
      };
      return result.items.some((item) => item.resource === `ahp-session:/${id}`) ? true : undefined;
    });
    const view = await ChatView.open(ahp, id);
    const changed = await ahp.session.waitFor((e) => e.channel === ROOT && e.action.type === "root/agentsChanged", 8000);
    const agents = (changed.action as unknown as { agents: RootState["agents"] }).agents;
    const known = agents.find((agent) => agent.provider === "fake-models");
    expect(known?.models.map((model) => model.id)).toEqual(["m1", "m2"]);
    expect(known?.models[0]).toMatchObject({ id: "m1", provider: "fake-models", name: "Model One" });
    expect(agents.find((agent) => agent.provider === "fake")?.models).toEqual([]);
    await view.close();

    const stored = JSON.parse(readFileSync(join(daemon.home, "extensions", "ahp", "models.json"), "utf8"));
    expect(stored["fake-models"].map((m: { id: string }) => m.id)).toEqual(["m1", "m2"]);

    await daemon.admin.request("POST", "/v1/extensions/ahp/restart");
    await until("socket closed", () => ahp.session.closed);
    await ahp.session.shutdown().catch(() => undefined);
    const fresh = await until("reconnect", async () => {
      try {
        const opened = await openSession(`ws://127.0.0.1:${daemon.ahpPort}/?tkn=${encodeURIComponent(ahp.token)}`);
        const init = await opened.client.initialize({ clientId: "after-restart", protocolVersions: ["1.0.0"], initialSubscriptions: [ROOT] });
        return { opened, root: init.snapshots.find((s) => s.resource === ROOT)?.state as RootState };
      } catch {
        return undefined;
      }
    });
    ahp.session = fresh.opened;
    expect(modelsOf(fresh.root, "fake-models")).toEqual(["m1", "m2"]);
  });
});
