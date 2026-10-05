import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolCore } from "../src/protocol/core.js";
import { FakeBackend, chatUri } from "../src/protocol/fake-backend.js";
import { AhpListener, originAllowed } from "../src/server/listener.js";
import { TokenRegistry } from "../src/store/tokens.js";
import { openSession, openSocket, sleep, startHarness, type Harness } from "./support/harness.js";

describe("listener auth", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.stop();
  });

  const base = (): string => `ws://127.0.0.1:${harness.port}/`;

  it("accepts the token as ?tkn= and as a Bearer header", async () => {
    const { token } = harness.mint();
    const viaQuery = await openSession(`${base()}?tkn=${token}`);
    await viaQuery.client.initialize({ clientId: "q", protocolVersions: ["0.9.0"] });
    const viaHeader = await openSession(base(), { Authorization: `Bearer ${token}` });
    await viaHeader.client.initialize({ clientId: "h", protocolVersions: ["0.9.0"] });
    await viaQuery.shutdown();
    await viaHeader.shutdown();
  });

  it("rejects missing, wrong and expired tokens before initialize", async () => {
    await expect(openSocket(base())).rejects.toThrow("status 401");
    await expect(openSocket(`${base()}?tkn=nope`)).rejects.toThrow("status 401");
    await expect(openSocket(base(), { Authorization: "Bearer nope" })).rejects.toThrow("status 401");
    await expect(openSocket(base(), { Authorization: "Basic abc" })).rejects.toThrow("status 401");
  });

  it("rejects revoked tokens", async () => {
    const { token, id } = harness.mint();
    harness.tokens.revoke(id);
    await expect(openSocket(`${base()}?tkn=${token}`)).rejects.toThrow("status 401");
  });

  it("refuses web-page origins and allows none and vscode origins", async () => {
    const { token } = harness.mint();
    await expect(openSocket(`${base()}?tkn=${token}`, { Origin: "https://evil.example" })).rejects.toThrow("status 403");
    await expect(openSocket(`${base()}?tkn=${token}`, { Origin: "http://localhost:3000" })).rejects.toThrow("status 403");
    const ok = await openSocket(`${base()}?tkn=${token}`, { Origin: "vscode-file://vscode-app" });
    ok.close();
    expect(originAllowed(undefined, [])).toBe(true);
    expect(originAllowed("vscode-webview://abc", [])).toBe(true);
    expect(originAllowed("https://x.example", ["https://x.example"])).toBe(true);
  });

  it("answers plain HTTP requests without serving anything", async () => {
    const response = await fetch(`http://127.0.0.1:${harness.port}/`);
    expect(response.status).toBe(404);
  });

  it("closes only the revoked token's connections, immediately", async () => {
    const doomed = harness.mint();
    const kept = harness.mint();
    const a = await harness.connect(doomed.token);
    const b = await harness.connect(doomed.token);
    const c = await harness.connect(kept.token);
    await a.client.initialize({ clientId: "a", protocolVersions: ["0.9.0"], initialSubscriptions: [chatUri("s1-chat")] });
    await b.client.initialize({ clientId: "b", protocolVersions: ["0.9.0"] });
    await c.client.initialize({ clientId: "c", protocolVersions: ["0.9.0"] });

    harness.tokens.revoke(doomed.id);
    expect(await a.closed).toBe(4001);
    expect(await b.closed).toBe(4001);
    await c.client.ping();
    expect(harness.backend.detached).toEqual([chatUri("s1-chat")]);
  });

  it("only listens on loopback", () => {
    const backend = new FakeBackend();
    const core = new ProtocolCore({ backend });
    const tokens = new TokenRegistry({ path: join(mkdtempSync(join(tmpdir(), "ahp-l-")), "t.json") });
    expect(() => new AhpListener({ core, tokens, host: "0.0.0.0" })).toThrow("non-loopback");
  });
});

describe("listener throttling", () => {
  it("backs off an address after repeated bad tokens, but still lets a valid token in", async () => {
    const harness = await startHarness();
    const listener = new AhpListener({
      core: harness.core,
      tokens: harness.tokens,
      maxBadAttempts: 3,
      badAttemptWindowMs: 60_000,
    });
    const port = await listener.listen();
    const url = (token: string): string => `ws://127.0.0.1:${port}/?tkn=${token}`;
    for (let i = 0; i < 3; i += 1) {
      await expect(openSocket(url("bad"))).rejects.toThrow("status 401");
    }
    await expect(openSocket(url("bad"))).rejects.toThrow("status 429");
    const { token } = harness.mint();
    const ok = await openSocket(url(token));
    ok.close();
    await expect(openSocket(url("bad"))).rejects.toThrow("status 429");
    await listener.close();
    await harness.stop();
    await sleep(0);
  });
});

describe("token revocation from another process", () => {
  it("closes a live connection within the watch interval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ahp-revoke-"));
    const path = join(dir, "tokens.json");
    const tokens = new TokenRegistry({ path });
    const core = new ProtocolCore({ backend: new FakeBackend() });
    await core.start();
    const listener = new AhpListener({ core, tokens, watchTokensMs: 50 });
    const port = await listener.listen();
    const { token, info } = tokens.mint("live");
    const session = await openSession(`ws://127.0.0.1:${port}/?tkn=${token}`);
    await session.client.initialize({ clientId: "live", protocolVersions: ["0.9.0"] });
    new TokenRegistry({ path }).revoke(info.id);
    await sleep(400);
    expect(session.closed).toBeDefined();
    await expect(session.client.ping()).rejects.toBeDefined();
    await listener.close();
  });
});
