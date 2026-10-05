import { WebSocket } from "ws";
import { JsonRpcPeer } from "../rpc/peer.js";
import { logger } from "../util/log.js";

const log = logger("hydra");

export interface HydraClientOptions {
  wsUrl: string;
  token: string;
  clientInfo: { name: string; version: string };
}

// The extension's /acp connection to the Hydra daemon.
export class HydraClient {
  readonly peer: JsonRpcPeer;
  private readonly closeListeners = new Set<() => void>();

  private constructor(private readonly ws: WebSocket) {
    this.peer = new JsonRpcPeer({
      send: (text) => {
        this.ws.send(text);
      },
      close: () => {
        this.ws.close();
      },
    });
    ws.on("message", (data) => {
      this.peer.handleText(data.toString());
    });
    ws.on("close", () => {
      this.peer.handleClosed();
      for (const listener of this.closeListeners) {
        listener();
      }
    });
    ws.on("error", (err) => {
      log.warn("acp socket error", err.message);
    });
  }

  static async connect(options: HydraClientOptions): Promise<HydraClient> {
    const ws = new WebSocket(options.wsUrl, ["acp.v1", `hydra-acp-token.${options.token}`]);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => {
        reject(new Error(`hydra refused the /acp connection (${res.statusCode})`));
      });
    });
    const client = new HydraClient(ws);
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: options.clientInfo,
    });
    return client;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.peer.request(method, params) as Promise<T>;
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  close(): void {
    this.ws.close();
  }
}
