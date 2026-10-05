import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionState } from "@microsoft/agent-host-protocol";
import { connectAhp, Driver, ROOT, type AhpConnection } from "../support/driver.js";
import { act } from "../support/harness.js";
import { ScratchDaemon, until } from "../support/scratch.js";
import { sessionOf } from "../support/chat-uri.js";

describe("an agent's config options as session settings against a scratch daemon", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let ahp: AhpConnection;

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({ name: "config" });
    driver = await Driver.open(daemon);
    ahp = await connectAhp(daemon, driver, await driver.newSession(), { version: "1.0.0" });
  });

  afterAll(async () => {
    await ahp.session.shutdown();
    driver.close();
    await daemon.destroy();
  });

  async function prompted(agent: string): Promise<{ id: string; uri: string }> {
    const id = await driver.newSession("/tmp", agent);
    await driver.prompt(id, "ping");
    const uri = sessionOf(id, agent);
    await until("session listed", async () => {
      const result = (await ahp.session.client.request("listSessions", { channel: ROOT } as never)) as unknown as {
        items: Array<{ resource: string }>;
      };
      return result.items.some((item) => item.resource === uri) ? true : undefined;
    });
    return { id, uri };
  }

  async function configOf(uri: string): Promise<SessionState["config"]> {
    const sub = await ahp.session.client.subscribe(uri);
    const state = sub.result.snapshot?.state as SessionState;
    return state.config;
  }

  async function change(uri: string, config: Record<string, unknown>): Promise<string | undefined> {
    const { clientSeq } = ahp.session.client.dispatch(uri, act({ type: "session/configChanged", config }));
    const echo = await ahp.session.waitFor((e) => e.origin?.clientSeq === clientSeq, 8000);
    return echo.rejectionReason;
  }

  it("offers only Hydra's agent switch for an agent that advertises no options", async () => {
    const { uri } = await prompted("fake");
    const config = await configOf(uri);
    expect(Object.keys(config?.schema.properties ?? {})).toEqual(["acp.agent"]);
    expect(config?.values["acp.agent"]).toBe("fake");
    expect(config?.schema.properties["acp.agent"]?.enum).toContain("fake-config");
  });

  it("lists the agent's options as mutable settings with their current values", async () => {
    const { uri } = await prompted("fake-config");
    const config = await configOf(uri);
    expect(config?.values).toEqual({ "acp.agent": "fake-config", "acp.effort": "medium", "acp.fast": "off" });
    expect(Object.keys(config?.schema.properties ?? {})).toEqual(["acp.agent", "acp.effort", "acp.fast"]);
    expect(config?.schema.properties["acp.effort"]).toMatchObject({
      type: "string",
      title: "Effort",
      description: "How hard the agent thinks",
      enum: ["low", "medium", "high"],
      enumLabels: ["Low", "Medium", "High"],
      enumDescriptions: ["", "The default", ""],
      sessionMutable: true,
    });
    await ahp.session.client.unsubscribe(uri);
  });

  it("applies a client's change through the agent and echoes it", async () => {
    const { id, uri } = await prompted("fake-config");
    await configOf(uri);
    expect(await change(uri, { "acp.effort": "high" })).toBeUndefined();
    await until("agent saw it", async () => ((await driver.agentLog(id)).includes("config:effort=high") ? true : undefined));
    expect((await configOf(uri))?.values["acp.effort"]).toBe("high");
  });

  it("corrects the values when the agent reshapes another setting", async () => {
    const { uri } = await prompted("fake-config");
    await configOf(uri);
    expect(await change(uri, { "acp.fast": "on" })).toBeUndefined();
    await until("effort dropped", async () => {
      const values = (await configOf(uri))?.values;
      return values?.["acp.effort"] === "low" && values?.["acp.fast"] === "on" ? true : undefined;
    });
  });

  it("switches the session's agent, which moves it to the new agent's URI", async () => {
    const { id, uri } = await prompted("fake");
    await configOf(uri);
    expect(await change(uri, { "acp.agent": "fake-config" })).toBeUndefined();
    const moved = sessionOf(id, "fake-config");
    await until(
      "listed under the new agent",
      async () => {
        const result = (await ahp.session.client.request("listSessions", { channel: ROOT } as never)) as unknown as {
          items: Array<{ resource: string }>;
        };
        const resources = result.items.map((item) => item.resource);
        return resources.includes(moved) && !resources.includes(uri) ? true : undefined;
      },
      20000,
    );
    const config = await configOf(moved);
    expect(config?.values).toMatchObject({ "acp.agent": "fake-config", "acp.effort": "medium" });
  });

  it("refuses unknown settings, bad values and replacing them all", async () => {
    const { uri } = await prompted("fake-config");
    await configOf(uri);
    expect(await change(uri, { "acp.nope": "x" })).toMatch(/unknown setting/);
    expect(await change(uri, { "acp.effort": "extreme" })).toMatch(/not a valid value/);
    expect(await change(uri, { effort: "high" })).toMatch(/unknown setting/);
    const { clientSeq } = ahp.session.client.dispatch(uri, act({ type: "session/configChanged", config: { "acp.effort": "low" }, replace: true }));
    expect((await ahp.session.waitFor((e) => e.origin?.clientSeq === clientSeq, 8000)).rejectionReason).toMatch(/one at a time/);
  });

  it("offers a new session the options last seen from its agent, and applies the picks once it exists", async () => {
    const offered = (await ahp.session.client.request("resolveSessionConfig", {
      channel: ROOT,
      provider: "fake-config",
      config: { "acp.effort": "high", "acp.fast": "bogus" },
    } as never)) as unknown as { schema: { properties: Record<string, unknown> }; values: Record<string, unknown> };
    expect(Object.keys(offered.schema.properties)).toEqual(["acp.agent", "acp.effort", "acp.fast"]);
    expect(offered.values).toMatchObject({ "acp.effort": "high", "acp.fast": "off" });

    const before = new Set((await daemon.admin.listSessions({ includeNonInteractive: true })).sessions.map((row) => row.sessionId));
    const channel = `fake-config:/0b8e6c55-3c1e-4d0a-8d57-5a0f2a3b7c22`;
    await ahp.session.client.request("createSession", {
      channel,
      provider: "fake-config",
      workingDirectories: ["file:///tmp"],
      config: { "acp.effort": "high" },
    } as never);
    const hydraId = await until("session created", async () => {
      const rows = (await daemon.admin.listSessions({ includeNonInteractive: true })).sessions;
      return rows.find((row) => row.agentId === "fake-config" && !before.has(row.sessionId))?.sessionId;
    });
    await driver.attach(hydraId);
    await until("agent applied the pick", async () => ((await driver.agentLog(hydraId)).includes("config:effort=high") ? true : undefined));
  });
});
