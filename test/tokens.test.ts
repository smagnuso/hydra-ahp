import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_IDLE_MS, TokenRegistry } from "../src/store/tokens.js";

function setup(start = 1_000_000) {
  const path = join(mkdtempSync(join(tmpdir(), "ahp-tokens-")), "sub", "tokens.json");
  const clock = { now: start };
  const registry = new TokenRegistry({ path, now: () => clock.now });
  return { path, clock, registry };
}

describe("TokenRegistry", () => {
  it("mints a token with label, id and level and stores only its sha256", () => {
    const { path, registry } = setup();
    const { token, info } = registry.mint("vscode", "read");
    expect(info.label).toBe("vscode");
    expect(info.level).toBe("read");
    expect(info.id).toMatch(/^[0-9a-f]{8}$/);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).toContain(createHash("sha256").update(token).digest("hex"));
    // Windows has no POSIX permission bits.
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("defaults to the full level and rejects unknown levels", () => {
    const { registry } = setup();
    expect(registry.mint("a").info.level).toBe("full");
    expect(() => registry.mint("b", "root" as never)).toThrow();
  });

  it("validates the token and nothing else", () => {
    const { registry } = setup();
    const { token, info } = registry.mint("a", "full");
    expect(registry.validate(token)?.id).toBe(info.id);
    expect(registry.validate(token)?.level).toBe("full");
    expect(registry.validate(`${token}x`)).toBeUndefined();
    expect(registry.validate("")).toBeUndefined();
  });

  it("slides the expiry on use and expires after the idle window", () => {
    const { clock, registry } = setup();
    const { token } = registry.mint("a");
    clock.now += DEFAULT_IDLE_MS - 1000;
    const first = registry.validate(token);
    expect(first).toBeDefined();
    clock.now += DEFAULT_IDLE_MS - 1000;
    expect(registry.validate(token)).toBeDefined();
    clock.now += DEFAULT_IDLE_MS + 1000;
    expect(registry.validate(token)).toBeUndefined();
  });

  it("persists across instances and bumps lastUsedAt", () => {
    const { path, clock, registry } = setup();
    const { token, info } = registry.mint("a");
    clock.now += 5000;
    registry.validate(token);
    const reloaded = new TokenRegistry({ path, now: () => clock.now });
    const [entry] = reloaded.list();
    expect(entry?.id).toBe(info.id);
    expect(Date.parse(entry?.lastUsedAt ?? "")).toBe(clock.now);
    expect(reloaded.validate(token)).toBeDefined();
  });

  it("revokes by id and notifies listeners", () => {
    const { registry } = setup();
    const { token, info } = registry.mint("a");
    const seen: string[] = [];
    registry.onRevoke((id) => seen.push(id));
    expect(registry.revoke("nope")).toBe(false);
    expect(registry.revoke(info.id)).toBe(true);
    expect(seen).toEqual([info.id]);
    expect(registry.validate(token)).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("never exposes the hash through list", () => {
    const { registry } = setup();
    registry.mint("a");
    expect(JSON.stringify(registry.list())).not.toContain("hash");
  });
});
