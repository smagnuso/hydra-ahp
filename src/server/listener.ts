import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { bindConnection } from "../protocol/connection.js";
import type { ProtocolCore } from "../protocol/core.js";
import { JsonRpcPeer } from "../rpc/peer.js";
import type { TokenInfo, TokenRegistry } from "../store/tokens.js";
import { logger } from "../util/log.js";

const log = logger("listener");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const REVOKED_CLOSE_CODE = 4001;

export interface ListenerOptions {
  core: ProtocolCore;
  tokens: TokenRegistry;
  port?: number;
  host?: string;
  tls?: { cert: string | Buffer; key: string | Buffer };
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
  maxBadAttempts?: number;
  badAttemptWindowMs?: number;
  watchTokensMs?: number;
  now?: () => number;
}

interface LiveConnection {
  socket: WebSocket;
  release: () => void;
}

function reply(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

// Native clients send no Origin and VS Code's shell uses vscode-* schemes; web pages are refused.
export function originAllowed(origin: string | undefined, extra: readonly string[]): boolean {
  if (origin === undefined) {
    return true;
  }
  return /^vscode-[a-z-]+:/i.test(origin) || extra.includes(origin);
}

// The Host header's name without port or IPv6 brackets, lowercased.
export function hostName(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^\[([^\]]+)\](?::\d+)?$/.exec(header) ?? /^([^:]+)(?::\d+)?$/.exec(header);
  return match?.[1]?.toLowerCase();
}

export function extractToken(req: IncomingMessage): string | undefined {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query = url.searchParams.get("tkn");
  if (query) {
    return query;
  }
  const header = req.headers.authorization;
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return match?.[1];
}

export class AhpListener {
  private readonly server: Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly live = new Map<string, Set<LiveConnection>>();
  private readonly failures = new Map<string, number[]>();
  private readonly host: string;
  private readonly checkHost: boolean;
  private readonly allowedHosts: Set<string>;
  private readonly now: () => number;
  private readonly unsubscribeRevoke: () => void;
  private readonly watchTimer: NodeJS.Timeout;

  constructor(private readonly options: ListenerOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.checkHost = !LOOPBACK_HOSTS.has(this.host);
    if (this.checkHost && !options.tls) {
      throw new Error(`refusing to listen on non-loopback host ${this.host} without a TLS cert and key`);
    }
    this.allowedHosts = new Set([this.host, ...(options.allowedHosts ?? [])].map((entry) => entry.toLowerCase()));
    this.now = options.now ?? Date.now;
    const handler = (_req: IncomingMessage, res: ServerResponse): void => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("hydra-ahp\n");
    };
    this.server = options.tls ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handler) : createHttpServer(handler);
    this.server.on("upgrade", (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
    this.unsubscribeRevoke = options.tokens.onRevoke((id) => {
      this.closeToken(id);
    });
    // A token revoked from the command line is another process's write; notice it without waiting for the next connection.
    this.watchTimer = setInterval(() => {
      try {
        options.tokens.refresh();
      } catch (err) {
        log.warn("token refresh failed", err);
      }
    }, options.watchTokensMs ?? 2000);
    this.watchTimer.unref();
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port ?? 0, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    clearInterval(this.watchTimer);
    this.unsubscribeRevoke();
    for (const connections of this.live.values()) {
      for (const connection of connections) {
        connection.socket.terminate();
      }
    }
    this.wss.close();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const address = req.socket.remoteAddress ?? "unknown";
    if (!originAllowed(req.headers.origin, this.options.allowedOrigins ?? [])) {
      log.warn(`rejected upgrade from origin ${req.headers.origin}`);
      reply(socket, "403 Forbidden");
      return;
    }
    if (this.checkHost) {
      const name = hostName(req.headers.host);
      if (name === undefined || !this.allowedHosts.has(name)) {
        log.warn(`rejected upgrade for host ${req.headers.host}`);
        reply(socket, "403 Forbidden");
        return;
      }
    }
    // Every client on loopback shares one address, so a valid token is never held back by someone else's bad ones.
    const token = extractToken(req);
    const info = token ? this.options.tokens.validate(token) : undefined;
    if (!info) {
      if (this.throttled(address)) {
        reply(socket, "429 Too Many Requests");
        return;
      }
      this.recordFailure(address);
      reply(socket, "401 Unauthorized");
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.attach(ws, info);
    });
  }

  private attach(socket: WebSocket, info: TokenInfo): void {
    const peer = new JsonRpcPeer({
      send: (text) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(text);
        }
      },
      close: () => {
        socket.close();
      },
    });
    const unbind = bindConnection(this.options.core, peer, info);
    let done = false;
    const entry: LiveConnection = {
      socket,
      release: () => {
        if (done) {
          return;
        }
        done = true;
        unbind();
        peer.handleClosed();
        this.live.get(info.id)?.delete(entry);
      },
    };
    let set = this.live.get(info.id);
    if (!set) {
      set = new Set();
      this.live.set(info.id, set);
    }
    set.add(entry);
    socket.on("message", (data) => {
      peer.handleText(data.toString());
    });
    socket.on("close", entry.release);
    socket.on("error", (err) => {
      log.warn(`socket error for token ${info.id}`, err);
      entry.release();
    });
  }

  private closeToken(id: string): void {
    for (const connection of [...(this.live.get(id) ?? [])]) {
      connection.release();
      connection.socket.close(REVOKED_CLOSE_CODE, "token revoked");
      setTimeout(() => connection.socket.terminate(), 1000).unref();
    }
    this.live.delete(id);
  }

  private throttled(address: string): boolean {
    const window = this.options.badAttemptWindowMs ?? 60_000;
    const recent = (this.failures.get(address) ?? []).filter((at) => this.now() - at < window);
    this.failures.set(address, recent);
    return recent.length >= (this.options.maxBadAttempts ?? 10);
  }

  private recordFailure(address: string): void {
    const list = this.failures.get(address) ?? [];
    list.push(this.now());
    this.failures.set(address, list);
  }
}
