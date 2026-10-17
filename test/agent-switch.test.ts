import { afterEach, describe, expect, it } from "vitest";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";

let harness: BridgeHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("agent switch", () => {
  it("moves a stamped session to the new agent's URI", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ sessionId: "h1", agentId: "alpha" })];
      hydra.buckets.set("h1", { ahpUri: "alpha:/abc" });
      (hydra.rest as { agents: () => Promise<unknown> }).agents = async () => ({
        agents: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }],
      });
    });
    const { hydra, catalog } = harness;
    await until(() => catalog.groupOf("h1") === "alpha:/abc");
    expect(catalog.groupOf("h1")).toBe("alpha:/abc");

    hydra.rows = [ROW({ sessionId: "h1", agentId: "beta" })];
    await until(() => catalog.groupOf("h1") !== "alpha:/abc");
    expect(catalog.groupOf("h1")).toBe("beta:/abc");
    expect(hydra.buckets.get("h1")?.ahpUri).toBe("beta:/abc");
  });
});
