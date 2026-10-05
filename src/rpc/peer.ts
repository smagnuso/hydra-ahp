import { logger } from "../util/log.js";

const log = logger("rpc");

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface PeerTransport {
  send(text: string): void;
  close(): void;
}

export type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
export type NotificationHandler = (params: unknown) => void | Promise<void>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// JSON-RPC 2.0 in both directions over a text transport.
export class JsonRpcPeer {
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private fallbackHandler: ((method: string, params: unknown) => unknown | Promise<unknown>) | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly transport: PeerTransport) {}

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onUnhandledRequest(handler: (method: string, params: unknown) => unknown | Promise<unknown>): void {
    this.fallbackHandler = handler;
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("peer closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  close(): void {
    this.transport.close();
  }

  handleClosed(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [id, pending] of this.pending) {
      pending.reject(new Error("peer closed"));
      this.pending.delete(id);
    }
  }

  handleText(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.respondError(null, ErrorCodes.ParseError, "parse error");
      return;
    }
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      this.respondError(null, ErrorCodes.InvalidRequest, "invalid request");
      return;
    }
    const hasId = "id" in message && message.id !== undefined && message.id !== null;
    if (typeof message.method === "string") {
      if (hasId) {
        void this.dispatchRequest(message.id as number | string, message.method, message.params);
      } else {
        void this.dispatchNotification(message.method, message.params);
      }
      return;
    }
    if (hasId && ("result" in message || "error" in message)) {
      this.settle(message);
      return;
    }
    this.respondError(hasId ? (message.id as number | string) : null, ErrorCodes.InvalidRequest, "invalid request");
  }

  private settle(message: Json): void {
    const pending = this.pending.get(message.id as number);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id as number);
    if (isObject(message.error)) {
      const { code, message: text, data } = message.error as {
        code?: number;
        message?: string;
        data?: unknown;
      };
      pending.reject(new RpcError(code ?? ErrorCodes.InternalError, text ?? "error", data));
      return;
    }
    pending.resolve(message.result);
  }

  private async dispatchRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const handler =
      this.requestHandlers.get(method) ??
      (this.fallbackHandler ? (p: unknown) => this.fallbackHandler?.(method, p) : undefined);
    if (!handler) {
      this.respondError(id, ErrorCodes.MethodNotFound, `method not found: ${method}`);
      return;
    }
    try {
      const result = await handler(params);
      this.write({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (err) {
      if (err instanceof RpcError) {
        this.respondError(id, err.code, err.message, err.data);
        return;
      }
      log.error(`request ${method} failed`, err);
      this.respondError(id, ErrorCodes.InternalError, "internal error");
    }
  }

  private async dispatchNotification(method: string, params: unknown): Promise<void> {
    const handler = this.notificationHandlers.get(method);
    if (!handler) {
      return;
    }
    try {
      await handler(params);
    } catch (err) {
      log.error(`notification ${method} failed`, err);
    }
  }

  private respondError(id: number | string | null, code: number, message: string, data?: unknown): void {
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  private write(message: Json): void {
    if (this.closed) {
      return;
    }
    this.transport.send(JSON.stringify(message));
  }
}
