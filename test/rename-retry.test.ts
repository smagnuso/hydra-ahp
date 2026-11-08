import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({ failures: [] as string[], renames: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      fsState.renames += 1;
      const code = fsState.failures.shift();
      if (code !== undefined) {
        throw Object.assign(new Error(code), { code });
      }
      actual.renameSync(from, to);
    },
  };
});

const { renameWithRetry } = await import("../src/store/rename-retry.js");
const { TokenRegistry } = await import("../src/store/tokens.js");
const { FlagStore } = await import("../src/store/flags.js");
const { ConfigStore } = await import("../src/store/configs.js");
const { ModelStore } = await import("../src/store/models.js");
const { ModelOptionStore } = await import("../src/store/model-options.js");

function errWith(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function harness(failures: string[]) {
  const calls = { rename: 0, sleeps: [] as number[], unlinked: [] as string[] };
  const queue = [...failures];
  return {
    calls,
    deps: {
      rename: () => {
        calls.rename += 1;
        const code = queue.shift();
        if (code !== undefined) {
          throw errWith(code);
        }
      },
      sleep: (ms: number) => {
        calls.sleeps.push(ms);
      },
      unlink: (p: string) => {
        calls.unlinked.push(p);
      },
    },
  };
}

describe("renameWithRetry", () => {
  it("succeeds first time without sleeping", () => {
    const h = harness([]);
    renameWithRetry("a.tmp", "a", h.deps);
    expect(h.calls).toMatchObject({ rename: 1, sleeps: [], unlinked: [] });
  });

  it("retries transient EPERM, EBUSY and EACCES with growing delays, then succeeds", () => {
    const h = harness(["EPERM", "EBUSY", "EACCES"]);
    renameWithRetry("a.tmp", "a", h.deps);
    expect(h.calls.rename).toBe(4);
    expect(h.calls.sleeps).toHaveLength(3);
    expect(h.calls.sleeps[0]!).toBeLessThan(h.calls.sleeps[1]!);
    expect(h.calls.sleeps[1]!).toBeLessThan(h.calls.sleeps[2]!);
    expect(h.calls.unlinked).toEqual([]);
  });

  it("gives up after 5 attempts, removes the temp file and rethrows the original", () => {
    const h = harness(Array(6).fill("EBUSY"));
    expect(() => renameWithRetry("a.tmp", "a", h.deps)).toThrow(expect.objectContaining({ code: "EBUSY" }));
    expect(h.calls.rename).toBe(5);
    expect(h.calls.sleeps).toHaveLength(4);
    expect(h.calls.unlinked).toEqual(["a.tmp"]);
  });

  it("does not retry other codes", () => {
    const h = harness(["ENOENT"]);
    expect(() => renameWithRetry("a.tmp", "a", h.deps)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(h.calls.rename).toBe(1);
    expect(h.calls.sleeps).toEqual([]);
    expect(h.calls.unlinked).toEqual(["a.tmp"]);
  });

  it("rethrows the rename error even if temp cleanup fails", () => {
    const h = harness(["ENOENT"]);
    const deps = {
      ...h.deps,
      unlink: () => {
        throw errWith("EIO");
      },
    };
    expect(() => renameWithRetry("a.tmp", "a", deps)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });
});

describe("stores retry a busy rename", () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), "ahp-rr-"));

  function savesThroughTransientFailure(name: string, make: (path: string) => () => void, reload: (path: string) => void): void {
    it(`${name} survives EPERM then EBUSY on rename`, () => {
      const path = join(dir(), "x.json");
      const save = make(path);
      fsState.failures = ["EPERM", "EBUSY"];
      fsState.renames = 0;
      save();
      expect(fsState.renames).toBe(3);
      expect(readdirSync(join(path, "..")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      expect(() => reload(path)).not.toThrow();
      expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);
    });
  }

  savesThroughTransientFailure(
    "token registry",
    (path) => {
      const reg = new TokenRegistry({ path });
      return () => {
        reg.mint("probe", "full");
      };
    },
    (path) => new TokenRegistry({ path }),
  );
  savesThroughTransientFailure(
    "flag store",
    (path) => {
      const store = new FlagStore(path);
      return () => store.set("s1", { isArchived: true });
    },
    (path) => new FlagStore(path),
  );
  savesThroughTransientFailure(
    "model store",
    (path) => {
      const store = new ModelStore(path);
      return () => store.set("agent", [{ id: "m", name: "M" }]);
    },
    (path) => new ModelStore(path),
  );
  savesThroughTransientFailure(
    "config store",
    (path) => {
      const store = new ConfigStore(path);
      return () => store.set("agent", [{ id: "tone", name: "T", currentValue: "a", options: [{ value: "a", name: "A" }] }]);
    },
    (path) => new ConfigStore(path),
  );
  savesThroughTransientFailure(
    "model option store",
    (path) => {
      const store = new ModelOptionStore(path);
      return () => store.set("agent", "m", [{ id: "tone", name: "T", currentValue: "a", options: [{ value: "a", name: "A" }] }]);
    },
    (path) => new ModelOptionStore(path),
  );
});
