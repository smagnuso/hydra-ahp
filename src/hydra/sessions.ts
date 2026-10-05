import type { Frame } from "../bridge/mapping.js";
import { frameFromNotification } from "../bridge/replay.js";
import { HYDRA_META, bag, text, type Json } from "../bridge/turns.js";
import { ErrorCodes, RpcError, type SettleHandler } from "../rpc/peer.js";
import { logger } from "../util/log.js";
import type { HydraClient } from "./client.js";

const log = logger("sessions");

export type QueueEvent = "added" | "updated" | "removed";

export interface SessionListener {
  update(frame: Frame): void;
  queue(event: QueueEvent, params: Json): void;
  closed(): void;
  // Answers a permission request Hydra sent this client; throwing -32601 abstains.
  permission?(params: Json): Promise<unknown>;
}

export interface AttachOptions {
  readonly: boolean;
  history: "full" | "pending_only";
}

export interface AttachResult {
  meta: Json;
  clientId?: string;
  configOptions?: unknown;
}

export type SteeringOutcome = "injected" | "startedNewTurn" | "promptRequired" | "failed";

export interface SteeringResult {
  outcome: SteeringOutcome;
  detached?: boolean;
}

export interface QueueEditResult {
  ok: boolean;
  reason: string;
}

function abstain(): never {
  throw new RpcError(ErrorCodes.MethodNotFound, "this client does not answer that permission request");
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
    // Any answer other than -32601 settles Hydra's permission race for every client, so only a bridge that parks the request answers.
    const permission = (raw: unknown): Promise<unknown> => {
      const params = bag(raw);
      const id = text(params.sessionId);
      const listener = id ? this.listeners.get(id) : undefined;
      if (!listener?.permission) {
        abstain();
      }
      return listener.permission(params);
    };
    peer.onRequest("session/request_permission", permission);
    peer.onRequest("hydra-acp/session/request_permission", permission);
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
    const clientId = text(result.clientId);
    return {
      meta: bag(bag(result._meta)[HYDRA_META]),
      ...(clientId ? { clientId } : {}),
      ...(result.configOptions !== undefined ? { configOptions: result.configOptions } : {}),
    };
  }

  // Resolves when the turn ends; onSettle sees the outcome in wire order with the session's notifications.
  prompt(hydraId: string, prompt: Json[], onSettle: SettleHandler): Promise<unknown> {
    return this.client.peer.request("session/prompt", { sessionId: hydraId, prompt }, onSettle);
  }

  cancel(hydraId: string): void {
    this.client.peer.notify("session/cancel", { sessionId: hydraId });
  }

  async steer(hydraId: string, prompt: Json[]): Promise<SteeringResult> {
    const result = bag(
      await this.client.request("_session/steering", {
        sessionId: hydraId,
        prompt,
        _meta: { steering: { idleBehavior: "promptRequired" } },
      }),
    );
    const outcome = text(result.outcome);
    const known = outcome === "injected" || outcome === "startedNewTurn" || outcome === "promptRequired";
    return { outcome: known ? outcome : "failed", ...(result.detached === true ? { detached: true } : {}) };
  }

  async updateQueued(hydraId: string, messageId: string, prompt: Json[]): Promise<QueueEditResult> {
    const result = bag(await this.client.request("hydra-acp/prompt/update", { sessionId: hydraId, messageId, prompt }));
    return { ok: result.updated === true, reason: text(result.reason) ?? "unknown" };
  }

  async cancelQueued(hydraId: string, messageId: string): Promise<QueueEditResult> {
    const result = bag(await this.client.request("hydra-acp/prompt/cancel", { sessionId: hydraId, messageId }));
    return { ok: result.cancelled === true, reason: text(result.reason) ?? "unknown" };
  }

  async setModel(hydraId: string, modelId: string): Promise<void> {
    await this.client.request("session/set_model", { sessionId: hydraId, modelId });
  }

  // Resolves to the agent's whole option set after the change; Hydra forwards everything except its own agent selector.
  async setConfigOption(hydraId: string, configId: string, value: string): Promise<unknown> {
    const result = bag(await this.client.request("session/set_config_option", { sessionId: hydraId, configId, value }));
    return result.configOptions;
  }

  async delete(hydraId: string): Promise<void> {
    await this.client.request("session/delete", { sessionId: hydraId });
  }

  async detach(hydraId: string): Promise<void> {
    try {
      await this.client.request("session/detach", { sessionId: hydraId });
    } catch (err) {
      log.debug(`detach ${hydraId} failed`, err instanceof Error ? err.message : err);
    }
  }
}
