import { describe, expect, it } from "vitest";
import { drainSseData, runSessionStream } from "../src/hydra/session-stream.js";
import type { SessionPage } from "../src/hydra/rest.js";

const sse = (body: unknown): string => `event: sessions\ndata: ${JSON.stringify(body)}\n\n`;

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

describe("drainSseData", () => {
  it("returns whole payloads and keeps a partial frame", () => {
    const out = drainSseData('event: sessions\ndata: {"a":1}\n\ndata: {"b"');
    expect(out.payloads).toEqual(['{"a":1}']);
    expect(out.rest).toBe('data: {"b"');
  });

  it("skips comment-only blocks", () => {
    expect(drainSseData(": ping\n\n").payloads).toEqual([]);
  });
});

describe("runSessionStream", () => {
  it("delivers a frame split across chunks", async () => {
    const abort = new AbortController();
    const frames: SessionPage[] = [];
    const whole = sse({ sessions: [{ sessionId: "a" }], removed: [], cursor: 5 });
    await runSessionStream({
      open: async () => streamResponse([whole.slice(0, 15), whole.slice(15)]),
      signal: abort.signal,
      onFrame: (frame) => {
        frames.push(frame);
        abort.abort();
      },
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.cursor).toBe(5);
  });

  it("resumes from initialCursor and then from the last frame", async () => {
    const abort = new AbortController();
    const sinces: (number | undefined)[] = [];
    let call = 0;
    let seen = 0;
    const disconnects: number[] = [];
    await runSessionStream({
      open: async (since) => {
        sinces.push(since);
        call += 1;
        return streamResponse([sse({ sessions: [], removed: [], cursor: call === 1 ? 7 : 9 })]);
      },
      signal: abort.signal,
      initialCursor: 5,
      sleep: async () => undefined,
      onDisconnect: () => disconnects.push(1),
      onFrame: () => {
        seen += 1;
        if (seen === 2) {
          abort.abort();
        }
      },
    });
    expect(sinces).toEqual([5, 7]);
    expect(disconnects).toHaveLength(1);
  });

  it("backs off after failures", async () => {
    const abort = new AbortController();
    const waits: number[] = [];
    let call = 0;
    await runSessionStream({
      open: async () => {
        call += 1;
        if (call < 3) {
          throw new Error("down");
        }
        return streamResponse([sse({ sessions: [], removed: [], cursor: 1 })]);
      },
      signal: abort.signal,
      sleep: async (ms) => {
        waits.push(ms);
      },
      onFrame: () => abort.abort(),
    });
    expect(waits).toEqual([1000, 2000]);
  });

  it("reports an older daemon (404) as unsupported without retrying", async () => {
    let calls = 0;
    const outcome = await runSessionStream({
      open: async () => {
        calls += 1;
        return new Response(null, { status: 404 });
      },
      signal: new AbortController().signal,
      sleep: async () => undefined,
      onFrame: () => undefined,
    });
    expect(outcome).toBe("unsupported");
    expect(calls).toBe(1);
  });

  it("ignores a malformed payload and keeps reading", async () => {
    const abort = new AbortController();
    const frames: SessionPage[] = [];
    await runSessionStream({
      open: async () => streamResponse(["data: {not json\n\n", sse({ sessions: [], removed: [], cursor: 2 })]),
      signal: abort.signal,
      onFrame: (frame) => {
        frames.push(frame);
        abort.abort();
      },
    });
    expect(frames).toHaveLength(1);
  });
});
