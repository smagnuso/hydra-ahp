import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelStore } from "../src/store/models.js";
import { sleep } from "./support/harness.js";
import { startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";

describe("default model", () => {
  let harness: BridgeHarness | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("lists the model Hydra seeds new sessions with first, through the extends chain", async () => {
    dir = mkdtempSync(join(tmpdir(), "ahp-models-"));
    const models = new ModelStore(join(dir, "models.json"));
    models.set("fake-dev", [
      { id: "image", name: "Image" },
      { id: "luna", name: "Luna" },
    ]);
    let defaults: Record<string, Record<string, string>> = { fake: { model: "luna" } };
    harness = await startBridgeHarness(
      (hydra) => {
        hydra.rest.agents = async () => ({ agents: [{ id: "fake-dev", name: "Fake (dev)", extendsChain: ["fake-dev", "fake"] }] });
        hydra.rest.config = async () => ({ sessionDefaults: defaults });
      },
      { models },
    );
    expect(harness.catalog.agents()[0]?.models.map((model) => model.id)).toEqual(["luna", "image"]);

    defaults = { "fake-dev": { model: "nova" } };
    const ids = (): string[] | undefined => harness?.catalog.agents()[0]?.models.map((model) => model.id);
    for (let tries = 0; tries < 100 && ids()?.[0] !== "nova"; tries += 1) {
      await sleep(20);
    }
    expect(ids()).toEqual(["nova", "image", "luna"]);
  });
});
