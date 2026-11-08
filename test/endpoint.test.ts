import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pidAlive, readEndpoint, removeEndpoint, writeEndpoint } from "../src/store/endpoint.js";

describe("endpoint record", () => {
  it("round-trips and disappears on remove", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ahp-ep-")), "x", "endpoint.json");
    writeEndpoint(path, { address: "box.ts.net:55590", scheme: "wss", wildcard: true });
    expect(readEndpoint(path)).toEqual({ address: "box.ts.net:55590", scheme: "wss", wildcard: true });
    removeEndpoint(path);
    expect(readEndpoint(path)).toBeUndefined();
  });

  it("ignores a malformed file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ahp-ep-")), "endpoint.json");
    writeFileSync(path, JSON.stringify({ address: 5, scheme: "http" }));
    expect(readEndpoint(path)).toBeUndefined();
  });

  it("ignores a record whose extension is gone, as after a hard kill", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ahp-ep-")), "endpoint.json");
    writeEndpoint(path, { address: "box.ts.net:55590", scheme: "wss", wildcard: false, pid: 4242 });
    expect(readEndpoint(path, () => false)).toBeUndefined();
    expect(readEndpoint(path, (pid) => pid === 4242)).toEqual({ address: "box.ts.net:55590", scheme: "wss", wildcard: false, pid: 4242 });
  });

  it("trusts a record with no pid (written by an older version)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ahp-ep-")), "endpoint.json");
    writeEndpoint(path, { address: "a:1", scheme: "ws", wildcard: false });
    expect(readEndpoint(path, () => false)).toEqual({ address: "a:1", scheme: "ws", wildcard: false });
  });

  it("pidAlive tells a live process from a dead one", () => {
    expect(pidAlive(process.pid)).toBe(true);
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    expect(pidAlive(dead.pid ?? 0)).toBe(false);
  });
});
