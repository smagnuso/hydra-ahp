import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfigOptions } from "../src/bridge/config.js";
import { ConfigStore } from "../src/store/configs.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = undefined;
});

describe("ConfigStore", () => {
  it("keeps an agent's own value for the agent option after the session switched away", () => {
    dir = mkdtempSync(join(tmpdir(), "ahp-configs-"));
    const store = new ConfigStore(join(dir, "configs.json"));
    const reported = parseConfigOptions([
      { id: "agent", name: "Agent", currentValue: "codex-acp", options: [{ value: "opencode-dev" }, { value: "codex-acp" }] },
    ]);
    store.set("opencode-dev", reported);
    expect(store.get("opencode-dev")[0]?.currentValue).toBe("opencode-dev");
    expect(new ConfigStore(join(dir, "configs.json")).get("opencode-dev")[0]?.currentValue).toBe("opencode-dev");
  });
});
