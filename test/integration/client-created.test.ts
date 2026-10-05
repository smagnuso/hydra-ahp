import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatState, SessionState, Snapshot } from "@microsoft/agent-host-protocol";
import { connectAhp, Driver, ROOT, type AhpConnection } from "../support/driver.js";
import { act, openSession } from "../support/harness.js";
import { ReducerOracle } from "../support/oracle.js";
import { ScratchDaemon, until } from "../support/scratch.js";

// Clients such as VS Code create a session under a URI they pick, "<provider>:/<id>", and pipeline their calls.
describe("a client-created session with a provider-scheme URI", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let ahp: AhpConnection;
  const channel = "fake:/6f1d2a1c-5b7e-4a53-9a55-0c2f6d7c9e11";

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({ name: "clientcreated" });
    driver = await Driver.open(daemon);
    ahp = await connectAhp(daemon, driver, await driver.newSession());
  });

  afterAll(async () => {
    await ahp.session.shutdown();
    driver.close();
    await daemon.destroy();
  });

  async function items(): Promise<Array<{ resource: string }>> {
    const result = (await ahp.session.client.request("listSessions", { channel: ROOT } as never)) as unknown as {
      items: Array<{ resource: string }>;
    };
    return result.items;
  }

  it("creates it, lists it under the chosen URI and runs a turn dispatched right behind the chat subscribe", async () => {
    await ahp.session.client.request("createSession", {
      channel,
      provider: "fake",
      workingDirectories: ["file:///tmp"],
    } as never);
    const sub = await ahp.session.client.subscribe(channel);
    const state = sub.result.snapshot?.state as SessionState;
    expect(state.defaultChat).toMatch(/^ahp-chat:\//);
    if (state.lifecycle !== "ready") {
      await ahp.session.waitFor((e) => e.channel === channel && e.action.type === "session/ready", 5000);
    }

    const chat = state.defaultChat as string;
    const oracle = new ReducerOracle();
    const subscribed = ahp.session.client.subscribe(chat);
    const { clientSeq } = ahp.session.client.dispatch(
      chat,
      act({
        type: "chat/turnStarted",
        turnId: "pipelined-1",
        startedAt: new Date().toISOString(),
        message: { text: "ping", origin: { kind: "user" } },
      }),
    );
    oracle.applySnapshot((await subscribed).result.snapshot as Snapshot);
    const echo = await ahp.session.waitFor((e) => e.origin?.clientSeq === clientSeq, 5000);
    expect(echo.rejectionReason).toBeUndefined();
    await ahp.session.waitFor((e) => e.channel === chat && e.action.type === "chat/turnComplete", 10000);
    for (const envelope of ahp.session.events) {
      oracle.applyEnvelope(envelope);
    }
    const finished = oracle.state(chat) as ChatState;
    const reply = finished.turns.at(-1)?.responseParts.flatMap((part) => (part.kind === "markdown" ? [part.content] : [])).join("");
    expect(reply).toContain("pong");
  });

  it("runs a turn dispatched before the new session is ready and streams it to a chat subscribed during creation", async () => {
    const early = "fake:/0b8e6c55-3c1e-4d0a-8d57-5a0f2a3b7c21";
    const chat = "ahp-chat:/0b8e6c55-3c1e-4d0a-8d57-5a0f2a3b7c21";
    await ahp.session.client.request("createSession", { channel: early, provider: "fake", workingDirectories: ["file:///tmp"] } as never);
    const oracle = new ReducerOracle();
    oracle.applySnapshot((await ahp.session.client.subscribe(early)).result.snapshot as Snapshot);
    oracle.applySnapshot((await ahp.session.client.subscribe(chat)).result.snapshot as Snapshot);
    const { clientSeq } = ahp.session.client.dispatch(
      chat,
      act({ type: "chat/turnStarted", turnId: "early-1", startedAt: new Date().toISOString(), message: { text: "ping", origin: { kind: "user" } } }),
    );
    const echo = await ahp.session.waitFor((e) => e.origin?.clientSeq === clientSeq, 15000);
    expect(echo.rejectionReason).toBeUndefined();
    await ahp.session.waitFor((e) => e.channel === chat && e.action.type === "chat/turnComplete", 15000);
    for (const envelope of ahp.session.events) {
      oracle.applyEnvelope(envelope);
    }
    const finished = oracle.state(chat) as ChatState;
    const reply = finished.turns.at(-1)?.responseParts.flatMap((part) => (part.kind === "markdown" ? [part.content] : [])).join("");
    expect(reply).toContain("pong");
    await ahp.session.client.request("disposeSession", { channel: early } as never);
  });

  it("keeps the session under the chosen URI after an extension restart, and disposes it", async () => {
    await daemon.admin.request("POST", "/v1/extensions/ahp/restart");
    await until("socket closed", () => ahp.session.closed);
    await ahp.session.shutdown().catch(() => undefined);
    ahp.session = await until("reconnect", async () => {
      try {
        const session = await openSession(`ws://127.0.0.1:${daemon.ahpPort}/?tkn=${encodeURIComponent(ahp.token)}`);
        await session.client.initialize({ clientId: "after-restart", protocolVersions: ["0.9.0"] });
        return session;
      } catch {
        return undefined;
      }
    });
    await until("listed again", async () => (await items()).find((item) => item.resource === channel));
    const again = await ahp.session.client.subscribe(channel);
    expect((again.result.snapshot?.state as SessionState).defaultChat).toBe(`ahp-chat:/${channel.slice("fake:/".length)}`);
    await ahp.session.client.request("disposeSession", { channel } as never);
    await until("gone", async () => ((await items()).some((item) => item.resource === channel) ? undefined : true));
  });
});
