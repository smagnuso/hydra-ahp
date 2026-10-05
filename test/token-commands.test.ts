import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTokenCommand } from "../src/commands/tokens.js";
import { TokenRegistry } from "../src/store/tokens.js";

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), "ahp-cmd-")), "tokens.json");
  const tokens = new TokenRegistry({ path });
  return { path, tokens, run: (args: string) => runTokenCommand({ tokens, address: () => "127.0.0.1:55590" }, args) };
}

describe("token verbs", () => {
  it("mint prints the complete chat.remoteAgentHosts entry", () => {
    const { run, tokens } = setup();
    const reply = run("mint my laptop --files read");
    const entry = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? "{}") as Record<string, string>;
    expect(entry.address).toBe("127.0.0.1:55590");
    expect(entry.name).toBe("my laptop");
    expect(tokens.validate(entry.connectionToken as string)?.level).toBe("read");
  });

  it("defaults to the scoped level and rejects bad input", () => {
    const { run, tokens } = setup();
    run("mint vscode");
    expect(tokens.list()[0]?.level).toBe("scoped");
    expect(run("mint")).toContain("a label is required");
    expect(run("mint x --files wide")).toContain("--files must be one of");
    expect(run("mint x --bogus")).toContain("unknown option");
    expect(run("revoke")).toContain("a token id is required");
    expect(run("nonsense")).toContain("usage:");
  });

  it("lists with levels and revokes by id", () => {
    const { run, tokens } = setup();
    run("mint a --files full");
    const [{ id }] = tokens.list() as [{ id: string }];
    expect(run("list")).toMatch(new RegExp(`${id}  a  files: full`));
    expect(run(`revoke ${id}`)).toContain("Revoked");
    expect(run(`revoke ${id}`)).toContain("No token");
    expect(run("list")).toContain("No tokens");
  });

  it("a running registry sees tokens minted and revoked by another process", () => {
    const { path, tokens, run } = setup();
    const other = new TokenRegistry({ path });
    const minted = other.mint("cli", "read");
    expect(tokens.validate(minted.token)?.id).toBe(minted.info.id);

    const revoked: string[] = [];
    tokens.onRevoke((id) => revoked.push(id));
    other.revoke(minted.info.id);
    expect(tokens.refresh()).toBe(true);
    expect(revoked).toEqual([minted.info.id]);
    expect(tokens.validate(minted.token)).toBeUndefined();
    expect(run("list")).toContain("No tokens");
  });
});
