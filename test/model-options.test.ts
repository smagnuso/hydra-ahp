import { afterEach, describe, expect, it } from "vitest";
import type { RootState } from "@microsoft/agent-host-protocol";
import { parseConfigOptions } from "../src/bridge/config.js";
import type { ConfigStore } from "../src/store/configs.js";
import type { ModelStore } from "../src/store/models.js";
import type { ModelOptionStore } from "../src/store/model-options.js";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";

let harness: BridgeHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const effort = (values: string[]) =>
  parseConfigOptions([{ id: "effort", name: "Effort", currentValue: values[0], options: values.map((value) => ({ value })) }]);

describe("model options in the agent list", () => {
  it("gives each model its own effort choices, falling back to the agent's last set", async () => {
    const models = {
      get: () => [
        { id: "seen", name: "Seen" },
        { id: "unseen", name: "Unseen" },
      ],
      set: () => false,
    } as unknown as ModelStore;
    const configs = { get: () => effort(["low", "high"]), set: () => false } as unknown as ConfigStore;
    const modelOptions = {
      get: (_agent: string, model: string) => (model === "seen" ? effort(["off", "on"]) : undefined),
      set: () => false,
    } as unknown as ModelOptionStore;
    harness = await startBridgeHarness(
      (hydra) => {
        hydra.rows = [ROW({ sessionId: "h1", agentId: "alpha" })];
        (hydra.rest as { agents: () => Promise<unknown> }).agents = async () => ({ agents: [{ id: "alpha", name: "Alpha" }] });
      },
      { models, configs, modelOptions },
    );
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["1.0.0"] });
    const root = (await session.client.request("subscribe", { channel: "ahp-root://" })) as { snapshot: { state: RootState } };
    const alpha = root.snapshot.state.agents.find((agent) => agent.provider === "alpha");
    const choices = (id: string) =>
      (alpha?.models.find((model) => model.id === id)?.configSchema?.properties as Record<string, { enum: string[] }> | undefined)?.effort?.enum;
    expect(choices("seen")).toEqual(["off", "on"]);
    expect(choices("unseen")).toEqual(["low", "high"]);
  });
});
