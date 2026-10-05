import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FlagStore } from "../src/store/flags.js";
import { STATUS_IDLE, STATUS_IS_ARCHIVED, STATUS_IS_READ, withFlagBits } from "../src/bridge/summary.js";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ahp-flags-"));
  dirs.push(dir);
  return join(dir, "ext", "flags.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("flag store", () => {
  it("persists marks across instances in a 0600 file, keyed by session id including federated ones", () => {
    const path = scratch();
    const store = new FlagStore(path);
    expect(store.set("hydra_session_a", { isArchived: true })).toBe(true);
    expect(store.set("beta:hydra_session_b", { isRead: true })).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = new FlagStore(path);
    expect(again.get("hydra_session_a")).toEqual({ isRead: false, isArchived: true });
    expect(again.get("beta:hydra_session_b")).toEqual({ isRead: true, isArchived: false });
    expect(again.get("unknown")).toEqual({ isRead: false, isArchived: false });
  });

  it("reports whether a set changed anything and drops entries that return to the default", () => {
    const path = scratch();
    const store = new FlagStore(path);
    expect(store.set("s", { isRead: false })).toBe(false);
    expect(store.set("s", { isRead: true })).toBe(true);
    expect(store.set("s", { isRead: true })).toBe(false);
    expect(store.set("s", { isRead: false })).toBe(true);
    expect(JSON.parse(JSON.stringify(Object.fromEntries([["s", new FlagStore(path).get("s")]])))).toEqual({
      s: { isRead: false, isArchived: false },
    });
  });

  it("forgets a deleted session and survives a corrupt file", () => {
    const path = scratch();
    const store = new FlagStore(path);
    store.set("s", { isArchived: true });
    store.forget("s");
    expect(new FlagStore(path).get("s").isArchived).toBe(false);
    writeFileSync(path, "{not json");
    expect(new FlagStore(path).get("s")).toEqual({ isRead: false, isArchived: false });
  });
});

describe("withFlagBits", () => {
  it("sets and clears the orthogonal bits without touching the activity bits", () => {
    expect(withFlagBits(STATUS_IDLE, { isRead: true, isArchived: false })).toBe(STATUS_IDLE | STATUS_IS_READ);
    expect(withFlagBits(8 | STATUS_IS_ARCHIVED, { isRead: false, isArchived: false })).toBe(8);
    expect(withFlagBits(STATUS_IDLE, { isRead: true, isArchived: true })).toBe(STATUS_IDLE | 96);
  });
});
