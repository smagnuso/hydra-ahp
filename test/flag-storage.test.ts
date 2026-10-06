import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FlagStore } from "../src/store/flags.js";
import { sleep } from "./support/harness.js";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";

describe("where done marks live", () => {
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

  const settle = async (check: () => boolean): Promise<void> => {
    for (let tries = 0; tries < 100 && !check(); tries += 1) {
      await sleep(10);
    }
  };

  it("keeps a local session's done mark in its extension_state and a federated session's in the file", async () => {
    dir = mkdtempSync(join(tmpdir(), "ahp-flags-"));
    const flags = new FlagStore(join(dir, "flags.json"));
    harness = await startBridgeHarness(
      (hydra) => {
        hydra.rows = [ROW(), ROW({ sessionId: "peer:r1", remote: "peer" } as never)];
      },
      { flags },
    );
    const { catalog, hydra } = harness;

    expect(catalog.setFlags("h1", { isArchived: true })).toBe(true);
    await settle(() => hydra.buckets.get("h1")?.flags !== undefined);
    expect(hydra.buckets.get("h1")?.flags).toEqual({ isRead: false, isArchived: true, archivedAt: expect.any(Number) });
    expect(flags.get("h1").isArchived).toBe(false);

    catalog.setFlags("h1", { isArchived: false });
    await settle(() => hydra.buckets.get("h1")?.flags === undefined);
    expect(hydra.buckets.get("h1")?.flags).toBeUndefined();

    expect(catalog.setFlags("peer:r1", { isArchived: true })).toBe(true);
    expect(flags.get("peer:r1").isArchived).toBe(true);
    expect(hydra.buckets.has("peer:r1")).toBe(false);
  });

  it("moves a local session's done mark from the old file into its extension_state", async () => {
    dir = mkdtempSync(join(tmpdir(), "ahp-flags-"));
    const flags = new FlagStore(join(dir, "flags.json"));
    flags.set("h1", { isArchived: true });
    harness = await startBridgeHarness(() => undefined, { flags });
    const { catalog, hydra } = harness;

    await settle(() => hydra.buckets.get("h1")?.flags !== undefined);
    expect(hydra.buckets.get("h1")?.flags).toEqual({ isRead: false, isArchived: true, archivedAt: expect.any(Number) });
    expect(catalog.flagsFor("h1").isArchived).toBe(true);
    expect(new FlagStore(join(dir, "flags.json")).get("h1").isArchived).toBe(false);
  });
});
