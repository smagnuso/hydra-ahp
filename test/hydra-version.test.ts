import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { startApp } from "../src/app.js";
import { MIN_HYDRA_VERSION, checkHydraVersion, compareVersions } from "../src/hydra/version.js";

describe("hydra version gate", () => {
  it("compares numerically, not lexically", () => {
    expect(compareVersions("0.1.200", "0.1.195")).toBeGreaterThan(0);
    expect(compareVersions("0.1.9", "0.1.195")).toBeLessThan(0);
    expect(compareVersions("0.2.0", "0.1.999")).toBeGreaterThan(0);
    expect(compareVersions("0.1.195", "0.1.195")).toBe(0);
  });

  it("accepts the minimum and newer", () => {
    expect(() => checkHydraVersion(MIN_HYDRA_VERSION)).not.toThrow();
    expect(() => checkHydraVersion("0.1.197")).not.toThrow();
    expect(() => checkHydraVersion("1.0.0")).not.toThrow();
  });

  it("refuses older and unknown versions with a clear message", () => {
    expect(() => checkHydraVersion("0.1.194")).toThrow(/needs Hydra 0\.1\.195 or newer.*0\.1\.194/);
    expect(() => checkHydraVersion(undefined)).toThrow(/could not determine/);
    expect(() => checkHydraVersion("banana")).toThrow(/could not determine/);
  });

  it("stops startup before connecting when the daemon is too old", async () => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(req.url === "/v1/system" ? JSON.stringify({ hydraVersion: "0.1.100" }) : "{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        startApp(
          {
            daemonUrl: `http://127.0.0.1:${port}`,
            wsUrl: `ws://127.0.0.1:${port}/acp`,
            token: "t",
            home: "/nonexistent",
            port: 0,
            idleMs: undefined,
            pollMs: undefined,
            warmPollMs: undefined,
            debug: false,
            tokensPath: "/nonexistent/tokens.json",
            flagsPath: "/nonexistent/flags.json",
            modelsPath: "/nonexistent/models.json",
          },
          "0.0.0",
        ),
      ).rejects.toThrow(/needs Hydra 0\.1\.195 or newer.*0\.1\.100/);
    } finally {
      server.close();
    }
  });
});
