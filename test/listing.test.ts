import { afterEach, describe, expect, it } from "vitest";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";

let harness: BridgeHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

type Page = { items: { resource: string }[]; nextCursor?: string };

describe("listSessions", () => {
  it("returns every session to a client that asks without a limit or cursor, and pages one that passes a limit", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = Array.from({ length: 150 }, (_, i) => ROW({ sessionId: `s${i}` }));
    });
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    const whole = (await session.client.request("listSessions", {} as never)) as unknown as Page;
    expect(whole.items).toHaveLength(150);
    expect(whole.nextCursor).toBeUndefined();

    const first = (await session.client.request("listSessions", { limit: 100 } as never)) as unknown as Page;
    expect(first.items).toHaveLength(100);
    const rest = (await session.client.request("listSessions", { limit: 100, cursor: first.nextCursor } as never)) as unknown as Page;
    expect(rest.items).toHaveLength(50);
    expect(new Set([...first.items, ...rest.items].map((item) => item.resource)).size).toBe(150);
  });
});
