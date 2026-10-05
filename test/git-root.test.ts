import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../src/changesets/git.js";

// Windows needs extra rights to create symlinks.
describe.skipIf(process.platform === "win32")("the repository root of a session's cwd", () => {
  let dir: string;

  beforeAll(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ahp-gitroot-")));
    execFileSync("git", ["init", "-q", join(dir, "repo")]);
    mkdirSync(join(dir, "repo", "src"));
    symlinkSync(join(dir, "repo"), join(dir, "linked-repo"));
    symlinkSync(join(dir, "repo", "src"), join(dir, "shortcut"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is git's own top level for a plain directory inside it", async () => {
    expect(await repoRoot(join(dir, "repo", "src"))).toBe(join(dir, "repo"));
  });

  it("keeps the path the session uses when the repository is reached through a symlink", async () => {
    expect(await repoRoot(join(dir, "linked-repo", "src"))).toBe(join(dir, "linked-repo"));
  });

  it("falls back to git's top level when the cwd is a symlink into the repository", async () => {
    expect(await repoRoot(join(dir, "shortcut"))).toBe(join(dir, "repo"));
  });

  it("is nothing outside a repository", async () => {
    expect(await repoRoot(dir)).toBeUndefined();
  });
});
