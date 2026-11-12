import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceWatchService } from "../src/files/watch.js";
import type { ClientContext } from "../src/protocol/backend.js";
import type { ProtocolCore } from "../src/protocol/core.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string | undefined;
let service: ResourceWatchService | undefined;

afterEach(() => {
  service?.stop();
  service = undefined;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

// A watch over a real directory whose OS events the test fires by hand.
async function watchedRoot(onActivity: (path: string) => void) {
  dir = mkdtempSync(join(tmpdir(), "ahp-activity-"));
  mkdirSync(join(dir, "src"));
  const listeners = new Map<string, (event: string, name: string | null) => void>();
  const core = {
    store: { has: () => false },
    createChannel: () => undefined,
    publish: () => undefined,
    hasSubscribers: () => true,
  } as unknown as ProtocolCore;
  service = new ResourceWatchService({
    files: { authorizeWatch: async () => dir as string } as never,
    watch: (path, listener) => {
      listeners.set(path, listener as never);
      return { on: () => undefined, close: () => undefined } as unknown as FSWatcher;
    },
    debounceMs: 5,
    onActivity,
  });
  service.start(core);
  const client = { token: { level: "full" } } as unknown as ClientContext;
  const { channel } = await service.handle("createResourceWatch", { uri: `file://${dir}`, recursive: true }, client);
  await service.attach(channel);
  return { root: dir, listeners };
}

describe("resource watch activity", () => {
  it("reports a change under a watched tree to the activity hook", async () => {
    const seen: string[] = [];
    const { root, listeners } = await watchedRoot((path) => seen.push(path));
    listeners.get(join(root, "src"))?.("change", "a.ts");
    await sleep(20);
    expect(seen).toEqual([join(root, "src", "a.ts")]);
  });

  it("does not report version-control or package directories", async () => {
    const seen: string[] = [];
    const { root, listeners } = await watchedRoot((path) => seen.push(path));
    listeners.get(root)?.("change", ".git");
    listeners.get(root)?.("change", "node_modules");
    await sleep(20);
    expect(seen).toEqual([]);
  });
});
