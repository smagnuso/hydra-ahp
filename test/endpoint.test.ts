import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEndpoint, removeEndpoint, writeEndpoint } from "../src/store/endpoint.js";

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
});
