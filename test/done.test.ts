import { afterEach, describe, expect, it } from "vitest";
import { startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";
import { act, sleep } from "./support/harness.js";
import { chatOf, sessionOf } from "./support/chat-uri.js";

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
});
