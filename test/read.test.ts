import { afterEach, describe, expect, it } from "vitest";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";
import { act, sleep } from "./support/harness.js";
import { chatOf, sessionOf } from "./support/chat-uri.js";
import { STATUS_IS_READ } from "../src/bridge/summary.js";

const CHAT = chatOf("h1");
const SESSION = sessionOf("h1");

describe("read state from the daemon", () => {
  let harness: BridgeHarness;

  afterEach(async () => {
    await harness.stop();
  });

  const summaryRead = (): boolean => (harness.catalog.summaryFor(SESSION)!.status & STATUS_IS_READ) !== 0;
  const channelRead = (uri: string): boolean =>
    ((harness.core.store.state(uri) as { status: number }).status & STATUS_IS_READ) !== 0;

  it("lists a session read unless the daemon says a turn ended unseen", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW()];
    });
    expect(summaryRead()).toBe(true);
    harness.hydra.rows = [ROW({ unread: true, lastTurnEndedAt: Date.now() })];
    await sleep(150);
    expect(summaryRead()).toBe(false);
  });

  it("sends a client's mark to the daemon and shows it until a poll agrees", async () => {
    const endedAt = Date.now() - 60_000;
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ unread: true, lastTurnEndedAt: endedAt })];
    });
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    session.client.dispatch(SESSION, act({ type: "session/isReadChanged", isRead: true }));
    await sleep(100);
    expect(harness.hydra.writes).toContainEqual({ method: "PATCH", id: "h1", params: { read: true } });
    expect(summaryRead()).toBe(true);
    expect(harness.hydra.buckets.get("h1")?.flags).toBeUndefined();

    await sleep(150);
    expect(summaryRead()).toBe(true);
    harness.hydra.rows = [ROW({ lastTurnEndedAt: endedAt })];
    await sleep(150);
    expect(summaryRead()).toBe(true);
  });

  it("lets a turn that ends after the mark make the session unread again", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ unread: true, lastTurnEndedAt: Date.now() - 60_000 })];
    });
    harness.catalog.setFlags("h1", { isRead: true });
    expect(summaryRead()).toBe(true);
    harness.hydra.rows = [ROW({ unread: true, lastTurnEndedAt: Date.now() + 1 })];
    await sleep(150);
    expect(summaryRead()).toBe(false);
  });

  it("follows into open session and chat channels", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW()];
    });
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    await session.client.subscribe(CHAT);
    await sleep(100);
    expect(channelRead(CHAT)).toBe(true);
    harness.hydra.rows = [ROW({ unread: true, lastTurnEndedAt: Date.now() })];
    await sleep(150);
    expect(channelRead(CHAT)).toBe(false);
    expect(channelRead(SESSION)).toBe(false);
  });
});
