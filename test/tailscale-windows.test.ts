import type { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ELEVATION_REQUIRED_MESSAGE, mintTailscaleCert } from "../src/setup/tailscale.js";
import { chownHint, confWrittenLine, declinedSudoMessage, operatorHint, restrictCertFiles, WINDOWS_MODE_NOTE } from "../src/setup/wizard.js";

const denied = { status: 1, stderr: "Access denied: cert access denied" };

function run(platform: NodeJS.Platform, results: Array<{ status: number; stderr?: string }>, answer = true) {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const queue = [...results];
  const spawn = ((cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args });
    return queue.shift() ?? { status: 0, stderr: "" };
  }) as unknown as typeof spawnSync;
  const confirmSudo = vi.fn(async () => answer);
  const promise = mintTailscaleCert({ dnsName: "h.ts.net", certPath: "c", keyPath: "k", confirmSudo, platform, spawn });
  return { calls, confirmSudo, promise };
}

describe("tailscale cert on Windows", () => {
  it("never asks for sudo or spawns it, and says to elevate", async () => {
    const r = run("win32", [denied]);
    await expect(r.promise).resolves.toEqual({ kind: "error", message: ELEVATION_REQUIRED_MESSAGE });
    expect(r.confirmSudo).not.toHaveBeenCalled();
    expect(r.calls.map((c) => c.cmd)).toEqual(["tailscale"]);
    expect(ELEVATION_REQUIRED_MESSAGE).toMatch(/Administrator/);
  });

  it("still succeeds directly on Windows", async () => {
    const r = run("win32", [{ status: 0 }]);
    await expect(r.promise).resolves.toEqual({ kind: "ok", usedSudo: false, chownFailed: false });
  });

  it("POSIX still asks, then runs sudo cert and sudo chown", async () => {
    const r = run("linux", [denied, { status: 0 }, { status: 0 }]);
    await expect(r.promise).resolves.toEqual({ kind: "ok", usedSudo: true, chownFailed: false });
    expect(r.confirmSudo).toHaveBeenCalledOnce();
    expect(r.calls.map((c) => `${c.cmd} ${c.args[0]}`)).toEqual(["tailscale cert", "sudo tailscale", "sudo chown"]);
  });

  it("POSIX declined sudo is unchanged", async () => {
    const r = run("darwin", [denied], false);
    await expect(r.promise).resolves.toEqual({ kind: "declined-sudo" });
  });
});

describe("wizard wording by platform", () => {
  it("has no sudo or whoami on Windows", () => {
    for (const text of [operatorHint("win32"), declinedSudoMessage("win32"), chownHint("win32", "c", "k")]) {
      expect(text).not.toMatch(/sudo|whoami/);
    }
    expect(operatorHint("win32")).toMatch(/Administrator/);
  });

  it("keeps the POSIX wording", () => {
    expect(operatorHint("linux")).toBe("Fix this permanently: sudo tailscale set --operator=$(whoami)");
    expect(declinedSudoMessage("linux")).toBe("Run `sudo tailscale set --operator=$(whoami)`, then re-run this setup.");
    expect(chownHint("linux", "c", "k")).toBe("Couldn't chown the cert files. Fix manually: sudo chown $(whoami) c k");
  });

  it("does not chmod or mention it on Windows", () => {
    const chmod = vi.fn();
    expect(restrictCertFiles("win32", "c", "k", chmod)).toBe(WINDOWS_MODE_NOTE);
    expect(chmod).not.toHaveBeenCalled();
    expect(WINDOWS_MODE_NOTE).not.toMatch(/chmod/);
    expect(confWrittenLine("win32", "p")).toBe("Wrote p");
  });

  it("chmods 0600 on POSIX and reports failure", () => {
    const chmod = vi.fn();
    expect(restrictCertFiles("linux", "c", "k", chmod)).toBeUndefined();
    expect(chmod.mock.calls).toEqual([["c", 0o600], ["k", 0o600]]);
    const boom = vi.fn(() => {
      throw new Error("nope");
    });
    expect(restrictCertFiles("darwin", "c", "k", boom)).toBe("Couldn't chmod cert files (nope).");
    expect(confWrittenLine("linux", "p")).toBe("Wrote p (chmod 600)");
  });
});
