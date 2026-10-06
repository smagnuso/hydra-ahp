import { afterEach, describe, expect, it } from "vitest";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";
import { act, sleep } from "./support/harness.js";
import { chatOf, sessionOf } from "./support/chat-uri.js";
import { STATUS_IS_READ } from "../src/bridge/summary.js";

const CHAT = chatOf("h1");
const SESSION = sessionOf("h1");

describe("a read mark and later turns", () => {
  let harness: BridgeHarness;

  afterEach(async () => {
    await harness.stop();
  });

  it("clears when a turn starts after it, with no client watching", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ turnStartedAt: Date.now() - 60_000 })];
    });
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    session.client.dispatch(SESSION, act({ type: "session/isReadChanged", isRead: true }));
    await sleep(100);
    expect(harness.catalog.flagsFor("h1")).toMatchObject({ isRead: true, readAt: expect.any(Number) });
    session.client.unsubscribe(SESSION);
    await sleep(150);
    expect(harness.catalog.flagsFor("h1").isRead).toBe(true);
    harness.hydra.rows = [ROW({ turnStartedAt: Date.now() + 1 })];
    await sleep(150);
    expect(harness.catalog.flagsFor("h1").isRead).toBe(false);
    expect(harness.hydra.buckets.get("h1")?.flags).toBeUndefined();
    expect(harness.catalog.summaryFor(SESSION)!.status & STATUS_IS_READ).toBe(0);
  });

  it("clears a mark from before read times were kept on any turn", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.buckets.set("h1", { flags: { isRead: true, isArchived: false } });
      hydra.rows = [ROW({ turnStartedAt: Date.now() - 60_000 })];
    });
    await sleep(150);
    expect(harness.catalog.flagsFor("h1").isRead).toBe(false);
  });

  it("follows into an open chat channel", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ turnStartedAt: Date.now() - 60_000 })];
    });
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    await session.client.subscribe(CHAT);
    session.client.dispatch(CHAT, act({ type: "chat/isReadChanged", isRead: true }));
    await sleep(100);
    expect((harness.core.store.state(CHAT) as { status: number }).status & STATUS_IS_READ).toBe(STATUS_IS_READ);
    harness.catalog.noteTurn("h1", Date.now() + 1);
    await sleep(50);
    expect((harness.core.store.state(CHAT) as { status: number }).status & STATUS_IS_READ).toBe(0);
    expect((harness.core.store.state(SESSION) as { status: number }).status & STATUS_IS_READ).toBe(0);
  });
});
