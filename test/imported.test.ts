import { afterEach, describe, expect, it } from "vitest";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";

let harness: BridgeHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const ROWS = [
  ROW({ sessionId: "local", agentId: "fake" }),
  ROW({ sessionId: "copied", agentId: "elsewhere-only", importedFromMachine: "blackbox" }),
  // Resumed here after the import, so it is this machine's session again.
  ROW({ sessionId: "resumed", agentId: "fake", importedFromMachine: "blackbox", upstreamSessionId: "ses_1" }),
  // A live view of a peer, not a copy.
  ROW({ sessionId: "beta:remote", agentId: "fake", remote: "beta" }),
];

async function listed(showImported: boolean | undefined): Promise<string[]> {
  harness = await startBridgeHarness(
    (hydra) => {
      hydra.rows = ROWS;
    },
    showImported === undefined ? {} : { showImported },
  );
  const session = await harness.connect();
  await session.client.initialize({ clientId: "c1", protocolVersions: ["1.0.0"] });
  const result = (await session.client.request("listSessions", {})) as { items: { resource: string }[] };
  return result.items.map((item) => item.resource).sort();
}

describe("imported sessions", () => {
  it("hides sessions copied in from another machine by default", async () => {
    expect(await listed(undefined)).toEqual(["fake:/beta:remote", "fake:/local", "fake:/resumed"]);
  });

  it("lists them when showImported is set", async () => {
    expect(await listed(true)).toEqual([
      "elsewhere-only:/copied",
      "fake:/beta:remote",
      "fake:/local",
      "fake:/resumed",
    ]);
  });

  it("keeps an agent out of the picker while its only sessions are hidden", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = ROWS;
    });
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["1.0.0"] });
    const root = (await session.client.request("subscribe", { channel: "ahp-root://" })) as {
      snapshot: { state: { agents: { provider: string }[] } };
    };
    expect(root.snapshot.state.agents.map((agent) => agent.provider)).not.toContain("elsewhere-only");
  });
});
