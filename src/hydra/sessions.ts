import type { Frame } from "../bridge/mapping.js";
import { frameFromNotification } from "../bridge/replay.js";
import { HYDRA_META, bag, text, type Json } from "../bridge/turns.js";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import { logger } from "../util/log.js";
import type { HydraClient } from "./client.js";

const log = logger("sessions");

export type QueueEvent = "added" | "updated" | "removed";

export interface SessionListener {
  update(frame: Frame): void;
  queue(event: QueueEvent, params: Json): void;
  closed(): void;
}

export interface AttachOptions {
  readonly: boolean;
  history: "full" | "pending_only";
}

export interface AttachResult {
  meta: Json;
}

// Routes the one /acp connection's per-session notifications to the bridge that attached each session.
export class HydraSessions {
  private readonly listeners = new Map<string, SessionListener>();

  constructor(
    private readonly client: HydraClient,
    private readonly clientInfo: { name: string; version: string },
  ) {
    const peer = client.peer;
    peer.onNotification("session/update", (params) => {
      const frame = frameFromNotification(params);
      const id = text(bag(params).sessionId);
      if (frame && id) {
        this.listeners.get(id)?.update(frame);
      }
    });
    for (const event of ["added", "updated", "removed"] as const) {
      peer.onNotification(`hydra-acp/prompt_queue/${event}`, (params) => {
        const id = text(bag(params).sessionId);
        if (id) {
          this.listeners.get(id)?.queue(event, bag(params));
        }
      });
    }
    peer.onNotification("hydra-acp/session/closed", (params) => {
      const id = text(bag(params).sessionId);
      if (id) {
        this.listeners.get(id)?.closed();
      }
    });
    // Abstain: an answer other than -32601 would settle Hydra's permission race for every client.
    const abstain = (): never => {
      throw new RpcError(ErrorCodes.MethodNotFound, "this client does not answer permission requests");
    };
    peer.onRequest("session/request_permission", abstain);
    peer.onRequest("hydra-acp/session/request_permission", abstain);
  }

  listen(hydraId: string, listener: SessionListener): () => void {
    this.listeners.set(hydraId, listener);
    return () => {
      if (this.listeners.get(hydraId) === listener) {
        this.listeners.delete(hydraId);
      }
    };
  }

  // Replay notifications reach the listener before this resolves, but live frames can arrive ahead of them.
  async attach(hydraId: string, options: AttachOptions): Promise<AttachResult> {
    const result = bag(
      await this.client.request("session/attach", {
        sessionId: hydraId,
        historyPolicy: options.history,
        clientInfo: this.clientInfo,
        ...(options.readonly ? { _meta: { [HYDRA_META]: { readonly: true } } } : {}),
      }),
    );
    return { meta: bag(bag(result._meta)[HYDRA_META]) };
  }

  async detach(hydraId: string): Promise<void> {
    try {
      await this.client.request("session/detach", { sessionId: hydraId });
    } catch (err) {
      log.debug(`detach ${hydraId} failed`, err instanceof Error ? err.message : err);
    }
  }
}
