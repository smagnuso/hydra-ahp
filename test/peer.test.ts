import { describe, expect, it } from "vitest";
import { ErrorCodes, JsonRpcPeer, RpcError } from "../src/rpc/peer.js";

function pair() {
  const sent: unknown[] = [];
  const peer = new JsonRpcPeer({
    send: (text) => sent.push(JSON.parse(text)),
    close: () => undefined,
  });
  return { peer, sent };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("JsonRpcPeer", () => {
  it("answers requests and maps undefined results to null", async () => {
    const { peer, sent } = pair();
    peer.onRequest("ok", () => undefined);
    peer.handleText(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ok" }));
    await tick();
    expect(sent).toEqual([{ jsonrpc: "2.0", id: 1, result: null }]);
  });

  it("returns method-not-found, invalid-params and internal errors", async () => {
    const { peer, sent } = pair();
    peer.onRequest("bad", () => {
      throw new RpcError(ErrorCodes.InvalidParams, "nope", { why: 1 });
    });
    peer.onRequest("boom", () => {
      throw new Error("secret");
    });
    for (const [id, method] of [[1, "missing"], [2, "bad"], [3, "boom"]] as const) {
      peer.handleText(JSON.stringify({ jsonrpc: "2.0", id, method }));
    }
    await tick();
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found: missing" } },
      { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "nope", data: { why: 1 } } },
      { jsonrpc: "2.0", id: 3, error: { code: -32603, message: "internal error" } },
    ]);
  });

  it("reports parse errors and invalid requests", () => {
    const { peer, sent } = pair();
    peer.handleText("{");
    peer.handleText(JSON.stringify({ id: 1 }));
    expect(sent).toMatchObject([{ error: { code: -32700 } }, { error: { code: -32600 } }]);
  });

  it("correlates outbound requests and rejects them on close", async () => {
    const { peer, sent } = pair();
    const result = peer.request("ping", { a: 1 });
    const id = (sent[0] as { id: number }).id;
    peer.handleText(JSON.stringify({ jsonrpc: "2.0", id, result: 42 }));
    expect(await result).toBe(42);

    const failing = peer.request("ping");
    const failingId = (sent[1] as { id: number }).id;
    peer.handleText(JSON.stringify({ jsonrpc: "2.0", id: failingId, error: { code: -32009, message: "denied" } }));
    await expect(failing).rejects.toMatchObject({ code: -32009 });

    const pending = peer.request("never");
    peer.handleClosed();
    await expect(pending).rejects.toThrow("peer closed");
  });

  it("delivers notifications without answering", async () => {
    const { peer, sent } = pair();
    const seen: unknown[] = [];
    peer.onNotification("note", (params) => {
      seen.push(params);
    });
    peer.handleText(JSON.stringify({ jsonrpc: "2.0", method: "note", params: { x: 1 } }));
    peer.handleText(JSON.stringify({ jsonrpc: "2.0", method: "unknown" }));
    await tick();
    expect(seen).toEqual([{ x: 1 }]);
    expect(sent).toEqual([]);
  });
});
