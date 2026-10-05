import { afterEach, describe, expect, it } from "vitest";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";
import { act, sleep } from "./support/harness.js";
import { chatOf, sessionOf } from "./support/chat-uri.js";
import { STATUS_IS_ARCHIVED } from "../src/bridge/summary.js";

const CHAT = chatOf("h1");
const SESSION = sessionOf("h1");

describe("marking a chat done", () => {
  let harness: BridgeHarness;

  afterEach(async () => {
    await harness.stop();
  });

  async function markDone(): Promise<string[]> {
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    await session.client.subscribe(CHAT);
    session.client.dispatch(CHAT, act({ type: "chat/isArchivedChanged", isArchived: true }));
    await sleep(100);
    return harness.hydra.writes.filter((write) => write.method === "KILL").map((write) => write.id as string);
  }

  it("lets an idle session go cold even with other clients attached", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.live = { status: "warm", attachedClients: 2 };
    });
    expect(await markDone()).toEqual(["h1"]);
  });

  it("leaves a session that is working", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.live = { status: "warm", attachedClients: 1, busy: true };
    });
    expect(await markDone()).toEqual([]);
  });

  it("comes back when a turn starts after it was marked done", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.live = { status: "warm", attachedClients: 1, busy: true };
      hydra.rows = [ROW({ busy: true, turnStartedAt: Date.now() - 60_000 })];
    });
    await markDone();
    expect(harness.catalog.flagsFor("h1")).toMatchObject({ isArchived: true });
    await sleep(150);
    expect(harness.catalog.flagsFor("h1").isArchived).toBe(true);
    harness.hydra.rows = [ROW({ busy: true, turnStartedAt: Date.now() + 1 })];
    await sleep(150);
    expect(harness.catalog.flagsFor("h1").isArchived).toBe(false);
    expect(harness.hydra.buckets.get("h1")?.flags).toBeUndefined();
    const chat = harness.core.store.state(CHAT) as { status: number };
    expect(chat.status & STATUS_IS_ARCHIVED).toBe(0);
    expect(harness.catalog.summaryFor(SESSION)!.status & STATUS_IS_ARCHIVED).toBe(0);
  });
});
