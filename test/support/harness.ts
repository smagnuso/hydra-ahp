import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  AhpClient,
  type AhpTransport,
  type JsonRpcMessage,
  type TransportFrame,
} from "@microsoft/agent-host-protocol/client";
import type { ActionEnvelope, StateAction } from "@microsoft/agent-host-protocol";
import { FakeBackend, type FakeBackendOptions } from "../../src/protocol/fake-backend.js";
import { ProtocolCore } from "../../src/protocol/core.js";
import type { ChannelStoreOptions } from "../../src/protocol/channels.js";
import { AhpListener } from "../../src/server/listener.js";
import { TokenRegistry, type FileLevel } from "../../src/store/tokens.js";

export class WsClientTransport implements AhpTransport {
  private readonly inbox: Array<TransportFrame | null> = [];
  private waiter: ((frame: TransportFrame | null) => void) | undefined;

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      this.push({ kind: "text", text: data.toString() });
    });
    ws.on("close", () => {
      this.push(null);
    });
    ws.on("error", () => {
      this.push(null);
    });
  }

  private push(frame: TransportFrame | null): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(frame);
      return;
    }
    this.inbox.push(frame);
  }

  send(message: JsonRpcMessage | string): void {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  recv(): Promise<TransportFrame | null> {
    if (this.inbox.length > 0) {
      return Promise.resolve(this.inbox.shift() ?? null);
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    this.ws.close();
  }
}

export function openSocket(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`status ${res.statusCode}`));
    });
  });
}

export interface Session {
  client: AhpClient;
  ws: WebSocket;
  events: ActionEnvelope[];
  notifications: Array<{ method: string; params: unknown }>;
  closed: Promise<number>;
  waitFor(predicate: (envelope: ActionEnvelope) => boolean, timeoutMs?: number): Promise<ActionEnvelope>;
  shutdown(): Promise<void>;
}

export async function openSession(url: string, headers: Record<string, string> = {}): Promise<Session> {
  const ws = await openSocket(url, headers);
  const closed = new Promise<number>((resolve) => {
    ws.once("close", (code) => resolve(code));
  });
  const client = new AhpClient(new WsClientTransport(ws), { requestTimeoutMs: 3000 });
  const events: ActionEnvelope[] = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { method?: string; params?: unknown };
    if (message.method === "action") {
      events.push(message.params as ActionEnvelope);
    } else if (message.method) {
      notifications.push({ method: message.method, params: message.params });
    }
    for (const waiter of waiters.splice(0)) {
      waiter();
    }
  });
  client.connect();
  return {
    client,
    ws,
    events,
    notifications,
    closed,
    async waitFor(predicate, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = events.find(predicate);
        if (hit) {
          return hit;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error("timed out waiting for envelope");
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, remaining);
        });
      }
    },
    async shutdown() {
      await client.shutdown();
    },
  };
}

export interface Harness {
  core: ProtocolCore;
  backend: FakeBackend;
  tokens: TokenRegistry;
  listener: AhpListener;
  port: number;
  mint(level?: FileLevel): { token: string; id: string };
  url(token: string): string;
  connect(token?: string, headers?: Record<string, string>): Promise<Session>;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  backend?: FakeBackendOptions;
  store?: ChannelStoreOptions;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "ahp-test-"));
  const tokens = new TokenRegistry({ path: join(dir, "tokens.json") });
  const backend = new FakeBackend(options.backend);
  const core = new ProtocolCore({ backend, store: options.store });
  await core.start();
  const listener = new AhpListener({ core, tokens });
  const port = await listener.listen();
  const sessions: Session[] = [];
  const url = (token: string): string => `ws://127.0.0.1:${port}/?tkn=${encodeURIComponent(token)}`;
  const mint = (level?: FileLevel): { token: string; id: string } => {
    const minted = tokens.mint("test", level);
    return { token: minted.token, id: minted.info.id };
  };
  const defaultToken = mint().token;
  return {
    core,
    backend,
    tokens,
    listener,
    port,
    mint,
    url,
    async connect(token = defaultToken, headers = {}) {
      const session = await openSession(url(token), headers);
      sessions.push(session);
      return session;
    },
    async stop() {
      for (const session of sessions) {
        await session.shutdown();
      }
      await listener.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const act = (value: Record<string, unknown>): StateAction => value as unknown as StateAction;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
