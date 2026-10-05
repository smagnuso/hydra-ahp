import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelStore } from "../src/store/models.js";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ahp-models-"));
  dirs.push(dir);
  return join(dir, "ext", "models.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("model store", () => {
  it("keeps each agent's models in a 0600 file across instances", () => {
    const path = scratch();
    const store = new ModelStore(path);
    expect(store.set("claude-acp", [{ id: "opus", name: "Opus" }, { id: "sonnet", name: "Sonnet" }])).toBe(true);
    // Windows has no POSIX permission bits.
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const again = new ModelStore(path);
    expect(again.get("claude-acp").map((m) => m.id)).toEqual(["opus", "sonnet"]);
    expect(again.get("other")).toEqual([]);
  });

  it("reports whether the list changed and never replaces a known list with an empty one", () => {
    const store = new ModelStore(scratch());
    const list = [{ id: "m1", name: "One" }];
    expect(store.set("a", list)).toBe(true);
    expect(store.set("a", list)).toBe(false);
    expect(store.set("a", [])).toBe(false);
    expect(store.get("a")).toEqual(list);
    expect(store.set("a", [{ id: "m1", name: "One" }, { id: "m2", name: "Two" }])).toBe(true);
  });

  it("survives a corrupt file", () => {
    const path = scratch();
    new ModelStore(path).set("a", [{ id: "m", name: "M" }]);
    writeFileSync(path, "{nope");
    expect(new ModelStore(path).get("a")).toEqual([]);
  });
});
