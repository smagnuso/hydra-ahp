import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { quoteForCmd, resolveSpawnTarget, resolveWindowsCommand } from "../src/util/windows-command.js";

const eqPath = (actual: string, expected: string): void => {
  expect(actual.toLowerCase()).toBe(expected.toLowerCase());
};
let dir: string;
let binDir: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hydra-ahp-wincmd-"));
  binDir = join(dir, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "tool"), "#!/bin/sh\n");
  writeFileSync(join(binDir, "tool.cmd"), "@echo off\n");
  writeFileSync(join(dir, "npm.cmd"), "@echo off\n");
  writeFileSync(join(dir, "real-tool.exe"), "MZ");
  env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveWindowsCommand", () => {
  it("is identity off Windows even when a .cmd sibling exists", () => {
    expect(resolveWindowsCommand("npm", { env, platform: "linux" })).toBe("npm");
  });

  it("finds a bare command on PATH via PATHEXT", () => {
    eqPath(resolveWindowsCommand("npm", { env, platform: "win32" }), join(dir, "npm.cmd"));
  });

  it("prefers the .cmd sibling over an extensionless sh shim", () => {
    const shim = join(binDir, "tool");
    eqPath(resolveWindowsCommand(shim, { env, platform: "win32" }), `${shim}.cmd`);
  });

  it("leaves a command that already carries an extension alone", () => {
    const exe = join(dir, "real-tool.exe");
    eqPath(resolveWindowsCommand(exe, { env, platform: "win32" }), exe);
  });

  it("returns the input unchanged when nothing resolves", () => {
    expect(resolveWindowsCommand("definitely-not-here", { env, platform: "win32" })).toBe("definitely-not-here");
  });

  it("searches every PATH entry", () => {
    const multi = { ...env, PATH: [join(dir, "nope"), dir].join(delimiter) };
    eqPath(resolveWindowsCommand("npm", { env: multi, platform: "win32" }), join(dir, "npm.cmd"));
  });
});

describe("quoteForCmd", () => {
  it("leaves plain tokens alone and quotes ones cmd would split or interpret", () => {
    expect(quoteForCmd("restart")).toBe("restart");
    expect(quoteForCmd("a b")).toBe('"a b"');
    expect(quoteForCmd("a&b")).toBe('"a&b"');
  });

  it("refuses tokens it cannot quote safely", () => {
    for (const bad of ['a"b', "100%", "a\nb", "a\rb"]) {
      expect(() => quoteForCmd(bad)).toThrow(/cannot pass/);
    }
  });
});

describe("resolveSpawnTarget", () => {
  it("routes a .cmd shim through the shell with quoted tokens on win32", () => {
    const target = resolveSpawnTarget("npm", ["install", "a b"], { env, platform: "win32" });
    expect(target.shell).toBe(true);
    expect(target.command.toLowerCase()).toBe(quoteForCmd(join(dir, "npm.cmd")).toLowerCase());
    expect(target.args).toEqual(["install", '"a b"']);
  });

  it("does not use the shell for a real .exe on win32", () => {
    const exe = join(dir, "real-tool.exe");
    const target = resolveSpawnTarget(exe, ["x y"], { env, platform: "win32" });
    expect(target.shell).toBe(false);
    expect(target.args).toEqual(["x y"]);
  });

  it("is a plain passthrough on linux, never quoting", () => {
    expect(resolveSpawnTarget("npm", ["a b", "100%"], { env, platform: "linux" })).toEqual({
      command: "npm",
      args: ["a b", "100%"],
      shell: false,
    });
  });

  it("throws on an unquotable token only for shell targets", () => {
    expect(() => resolveSpawnTarget("npm", ["a%b"], { env, platform: "win32" })).toThrow(/cannot pass/);
    expect(() => resolveSpawnTarget("npm", ["a%b"], { env, platform: "linux" })).not.toThrow();
  });
});
