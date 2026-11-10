import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { HydraClient } from "../src/hydra/client.js";

describe("hydra initialize", () => {
  let server: WebSocketServer | undefined;

  afterEach(() => {
    server?.close();
  });

  it("advertises form elicitation so the daemon sends this client forms", async () => {
    server = new WebSocketServer({ port: 0, handleProtocols: (protocols) => [...protocols][0] ?? false });
    const seen = new Promise<Record<string, unknown>>((resolve) => {
      server!.on("connection", (socket) => {
        socket.on("message", (data) => {
          const message = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> };
          resolve(message.params);
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } }));
        });
      });
    });
    const { port } = server.address() as AddressInfo;
    const client = await HydraClient.connect({ wsUrl: `ws://127.0.0.1:${port}`, token: "t", clientInfo: { name: "x", version: "0" } } as never);
    expect((await seen).clientCapabilities).toEqual({ elicitation: { form: {} } });
    client.close();
  });
});
