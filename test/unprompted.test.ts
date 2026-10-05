import { afterEach, describe, expect, it } from "vitest";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";
import { sleep } from "./support/harness.js";

const STAMPED = "fake:/h2";

describe("sessions the extension created that nobody prompted", () => {
  let harness: BridgeHarness;

  afterEach(async () => {
    await harness.stop();
  });

  const listed = (): string[] => harness.catalog.summaries().map((summary) => summary.resource);

  it("stay listed while a client has them open and drop out a grace after", async () => {
    harness = await startBridgeHarness(
      (hydra) => {
        hydra.rows = [ROW(), ROW({ sessionId: "h2", interactive: undefined }), ROW({ sessionId: "h3", interactive: false })];
        hydra.buckets.set("h2", { ahpUri: STAMPED });
        hydra.buckets.set("h3", { ahpUri: "fake:/h3" });
      },
      { unpromptedGraceMs: 300 },
    );
    expect(listed()).toContain(STAMPED);
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(STAMPED);
    await sleep(500);
    expect(listed()).toContain(STAMPED);
    await session.client.unsubscribe(STAMPED);
    await sleep(500);
    expect(listed()).not.toContain(STAMPED);
    expect(listed()).not.toContain("fake:/h3");
    expect(listed()).toContain("fake:/h1");
  });

  it("stay listed once prompted", async () => {
    harness = await startBridgeHarness(
      (hydra) => {
        hydra.rows = [ROW({ sessionId: "h2", interactive: true })];
        hydra.buckets.set("h2", { ahpUri: STAMPED });
      },
      { unpromptedGraceMs: 100 },
    );
    await sleep(300);
    expect(listed()).toEqual([STAMPED]);
  });
});
