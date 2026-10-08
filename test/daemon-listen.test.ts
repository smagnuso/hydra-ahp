import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { applyDaemonListen, pickDisplayName } from "../src/hydra/daemon-listen.js";
import { hostName } from "../src/server/listener.js";

const base = { HYDRA_ACP_TOKEN: "t" };
const tls = { cert: "/d/cert.pem", key: "/d/key.pem" };
const tailnet = { host: "100.64.0.1", port: 55514, publicHost: "box.ts.net", tls };

describe("applyDaemonListen", () => {
  it("adopts the daemon's cert, host and public name when nothing is set", () => {
    const config = applyDaemonListen(loadConfig(base), tailnet);
    expect(config.tls).toEqual(tls);
    expect(config.host).toBe("100.64.0.1");
    expect(config.preferredHost).toBe("box.ts.net");
    expect(config.port).toBe(55590);
  });

  it("adopts nothing when the daemon has no cert", () => {
    const config = applyDaemonListen(loadConfig(base), { host: "0.0.0.0", port: 1 });
    expect(config.host).toBe("127.0.0.1");
    expect(config.tls).toBeUndefined();
  });

  it("keeps an explicit keypair and stays on loopback", () => {
    const config = applyDaemonListen(loadConfig({ ...base, HYDRA_AHP_TLS_CERT: "/m/c", HYDRA_AHP_TLS_KEY: "/m/k" }), tailnet);
    expect(config.tls).toEqual({ cert: "/m/c", key: "/m/k" });
    expect(config.host).toBe("127.0.0.1");
  });

  it("keeps an explicit host and public name but takes the cert", () => {
    const config = applyDaemonListen(loadConfig({ ...base, HYDRA_AHP_HOST: "0.0.0.0", HYDRA_AHP_PREFERRED_HOST: "me.lan" }), tailnet);
    expect(config.host).toBe("0.0.0.0");
    expect(config.preferredHost).toBe("me.lan");
    expect(config.tls).toEqual(tls);
  });

  it("does nothing without daemon data", () => {
    const config = loadConfig(base);
    expect(applyDaemonListen(config, undefined)).toBe(config);
  });
});

describe("config tls", () => {
  it("requires cert and key together", () => {
    expect(() => loadConfig({ ...base, HYDRA_AHP_TLS_CERT: "/c" })).toThrow("both be set");
  });
});

describe("hostName", () => {
  it("strips port and brackets", () => {
    expect(hostName("Box.ts.net:55590")).toBe("box.ts.net");
    expect(hostName("[fd7a::1]:55590")).toBe("fd7a::1");
    expect(hostName("100.64.0.1")).toBe("100.64.0.1");
    expect(hostName(undefined)).toBeUndefined();
  });
});

describe("pickDisplayName", () => {
  it("prefers the cert name that extends this machine's hostname", () => {
    expect(pickDisplayName(["other.example", "blackbox.ts.net"], "blackbox")).toBe("blackbox.ts.net");
  });

  it("falls back to the first concrete name and skips wildcards", () => {
    expect(pickDisplayName(["*.example.com", "a.example.com"], "blackbox")).toBe("a.example.com");
    expect(pickDisplayName([], "blackbox")).toBeUndefined();
  });
});
