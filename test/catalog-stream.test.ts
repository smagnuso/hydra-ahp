import { afterEach, describe, expect, it } from "vitest";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";

let harness: BridgeHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A stream the test writes frames into, as the daemon would.
function controllableStream() {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  return {
    open: async () => new Response(readable, { status: 200 }),
    push: (body: unknown) => writer.write(encoder.encode(`event: sessions\ndata: ${JSON.stringify(body)}\n\n`)),
  };
}

async function listedResources(h: BridgeHarness): Promise<string[]> {
  const session = await h.connect();
  await session.client.initialize({ clientId: "c1", protocolVersions: ["1.0.0"] });
  const result = (await session.client.request("listSessions", {})) as { items: { resource: string }[] };
  return result.items.map((item) => item.resource).sort();
}

describe("catalog with a session stream", () => {
  it("adds a session that arrives in a frame, and drops one named in removed", async () => {
    const stream = controllableStream();
    harness = await startBridgeHarness(
      (hydra) => {
        hydra.rows = [ROW({ sessionId: "base" })];
      },
      { openStream: stream.open },
    );
    await sleep(60);
    await stream.push({ sessions: [ROW({ sessionId: "pushed", title: "From a frame" })], removed: [], cursor: 3 });
    await sleep(80);
    expect(await listedResources(harness)).toContain("fake:/pushed");

    await stream.push({ sessions: [], removed: ["pushed"], cursor: 4 });
    await sleep(80);
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c2", protocolVersions: ["1.0.0"] });
    const after = (await session.client.request("listSessions", {})) as { items: { resource: string }[] };
    expect(after.items.map((item) => item.resource)).not.toContain("fake:/pushed");
  });

  it("stops the fast warm poll while the stream is healthy", async () => {
    const stream = controllableStream();
    let warmPolls = 0;
    harness = await startBridgeHarness(
      (hydra) => {
        const list = hydra.rest.listSessions;
        hydra.rest.listSessions = (async (query: { status?: string } = {}) => {
          if (query.status === "warm") {
            warmPolls += 1;
          }
          return list(query as never);
        }) as never;
      },
      { openStream: stream.open },
    );
    await stream.push({ sessions: [], removed: [], cursor: 1 });
    await sleep(60);
    const before = warmPolls;
    await sleep(250);
    expect(warmPolls).toBe(before);
  });

  it("keeps polling when the daemon has no stream", async () => {
    let warmPolls = 0;
    harness = await startBridgeHarness(
      (hydra) => {
        const list = hydra.rest.listSessions;
        hydra.rest.listSessions = (async (query: { status?: string } = {}) => {
          if (query.status === "warm") {
            warmPolls += 1;
          }
          return list(query as never);
        }) as never;
      },
      { openStream: async () => new Response(null, { status: 404 }) },
    );
    await sleep(250);
    expect(warmPolls).toBeGreaterThan(2);
  });
});
