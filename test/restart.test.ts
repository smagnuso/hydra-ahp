import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restartExtension, type SpawnSyncFn } from "../src/setup/restart.js";

function recorder(status: number | null) {
  const calls: { command: string; args: string[]; options: unknown }[] = [];
  const spawn: SpawnSyncFn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status };
  };
  return { calls, spawn };
}

describe("restartExtension", () => {
  it("resolves the .cmd shim and spawns through the shell on win32", () => {
    const dir = mkdtempSync(join(tmpdir(), "hydra-ahp-restart-"));
    try {
      const shim = join(dir, "hydra-acp.cmd");
      writeFileSync(shim, "@echo off\n");
      const { calls, spawn } = recorder(0);
      const result = restartExtension("hydra-ahp", spawn, {
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      });
      expect(result).toEqual({ kind: "restarted" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command.replace(/"/g, "").toLowerCase()).toBe(shim.toLowerCase());
      expect(calls[0]!.args).toEqual(["extension", "restart", "hydra-ahp"]);
      expect(calls[0]!.options).toEqual({ stdio: "inherit", shell: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("quotes a shim path containing spaces on win32", () => {
    const dir = mkdtempSync(join(tmpdir(), "hydra ahp restart "));
    try {
      writeFileSync(join(dir, "hydra-acp.cmd"), "@echo off\n");
      const { calls, spawn } = recorder(0);
      restartExtension("hydra-ahp", spawn, { platform: "win32", env: { PATH: dir, PATHEXT: ".CMD" } });
      expect(calls[0]!.command.startsWith('"')).toBe(true);
      expect(calls[0]!.command.endsWith('"')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an unquotable argument instead of throwing or spawning", () => {
    const { calls, spawn } = recorder(0);
    const dir = mkdtempSync(join(tmpdir(), "hydra-ahp-restart-"));
    try {
      writeFileSync(join(dir, "hydra-acp.cmd"), "@echo off\n");
      const result = restartExtension("bad%name", spawn, {
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".CMD" },
      });
      expect(result.kind).toBe("unquotable");
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("spawns the bare command with no shell on linux", () => {
    const { calls, spawn } = recorder(0);
    const result = restartExtension("hydra-ahp", spawn, { platform: "linux", env: {} });
    expect(result).toEqual({ kind: "restarted" });
    expect(calls).toEqual([
      {
        command: "hydra-acp",
        args: ["extension", "restart", "hydra-ahp"],
        options: { stdio: "inherit", shell: false },
      },
    ]);
  });

  it("leaves arguments unquoted on linux", () => {
    const { calls, spawn } = recorder(0);
    restartExtension("bad%name with space", spawn, { platform: "linux", env: {} });
    expect(calls[0]!.args[2]).toBe("bad%name with space");
  });

  it("reports the exit status, including null for a failed launch", () => {
    expect(restartExtension("x", recorder(3).spawn, { platform: "linux" })).toEqual({ kind: "exited", status: 3 });
    expect(restartExtension("x", recorder(null).spawn, { platform: "linux" })).toEqual({ kind: "exited", status: null });
  });
});
