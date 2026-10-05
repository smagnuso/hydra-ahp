import type {
  ActionOrigin,
  InitializeResult,
  ReconnectResult,
  Snapshot,
  StateAction,
} from "@microsoft/agent-host-protocol";
import { ErrorCodes, RpcError, type JsonRpcPeer } from "../rpc/peer.js";
import type { TokenInfo } from "../store/tokens.js";
import { logger } from "../util/log.js";
import type { ProtocolCore } from "./core.js";
import type { ActionDecision } from "./backend.js";
import { validateAction } from "./dispatch.js";
import { SUPPORTED_VERSIONS, isActionAllowed, negotiate, shapeSummary } from "./negotiate.js";

const log = logger("connection");

const UNSUPPORTED_PROTOCOL_VERSION = -32005;

// Without a remembered version the oldest baseline is the only safe assumption.
const FALLBACK_VERSION = SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1] ?? "0.9.0";

type Json = Record<string, unknown>;

function asObject(params: unknown): Json {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new RpcError(ErrorCodes.InvalidParams, "params must be an object");
  }
  return params as Json;
}

function requireString(params: Json, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "") {
    throw new RpcError(ErrorCodes.InvalidParams, `${key} must be a non-empty string`);
  }
  return value;
}

function stringList(params: Json, key: string, required: boolean): string[] {
  const value = params[key];
  if (value === undefined && !required) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new RpcError(ErrorCodes.InvalidParams, `${key} must be a list of strings`);
  }
  return value as string[];
}

// Wires one JSON-RPC peer to the protocol core; returns a hook for transport close.
export function bindConnection(core: ProtocolCore, peer: JsonRpcPeer, token: TokenInfo): () => void {
  const connection = core.addConnection(peer, token);
  let dispatchQueue: Promise<void> = Promise.resolve();

  const ready = (): string => {
    if (!connection.version || !connection.clientId) {
      throw new RpcError(ErrorCodes.InvalidRequest, "connection is not initialized");
    }
    return connection.version;
  };

  const adopt = (clientId: string, version: string): void => {
    if (connection.clientId) {
      throw new RpcError(ErrorCodes.InvalidRequest, "connection is already initialized");
    }
    connection.clientId = clientId;
    connection.version = version;
    core.rememberVersion(clientId, version);
  };

  peer.onRequest("initialize", async (raw) => {
    const params = asObject(raw);
    const clientId = requireString(params, "clientId");
    const offered = stringList(params, "protocolVersions", true);
    const initial = stringList(params, "initialSubscriptions", false);
    const version = negotiate(offered);
    if (!version) {
      setTimeout(() => peer.close(), 0);
      throw new RpcError(UNSUPPORTED_PROTOCOL_VERSION, "unsupported protocol version", {
        supportedVersions: [...SUPPORTED_VERSIONS],
      });
    }
    adopt(clientId, version);
    const snapshots = await subscribeAll(initial);
    const result: InitializeResult = {
      protocolVersion: version,
      serverSeq: core.store.serverSeq,
      snapshots,
      ...(core.backend.serverInfo ? { serverInfo: core.backend.serverInfo } : {}),
      ...(core.backend.completionTriggerCharacters
        ? { completionTriggerCharacters: core.backend.completionTriggerCharacters }
        : {}),
      ...(core.backend.defaultDirectory ? { defaultDirectory: core.backend.defaultDirectory } : {}),
    };
    return result;
  });

  peer.onRequest("reconnect", async (raw) => {
    const params = asObject(raw);
    const clientId = requireString(params, "clientId");
    const lastSeen = params.lastSeenServerSeq;
    if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen)) {
      throw new RpcError(ErrorCodes.InvalidParams, "lastSeenServerSeq must be a number");
    }
    const requested = stringList(params, "subscriptions", true);
    const version = core.recallVersion(clientId) ?? FALLBACK_VERSION;
    adopt(clientId, version);

    const uris = [...new Set(requested)];
    const unavailable = new Set<string>();
    await Promise.all(
      uris.map(async (uri) => {
        try {
          await core.ensureAttached(uri);
        } catch {
          unavailable.add(uri);
        }
      }),
    );
    if (connection.closed) {
      for (const uri of uris) {
        core.detachIfIdle(uri);
      }
      throw new RpcError(ErrorCodes.InternalError, "connection closed");
    }
    const live = uris.filter((uri) => !unavailable.has(uri));
    const outcome = core.store.replay(lastSeen, live);
    const result =
      outcome.type === "replay"
        ? {
            type: "replay",
            actions: outcome.actions.filter((envelope) => isActionAllowed(envelope.action, version)),
            missing: uris.filter((uri) => !live.includes(uri)).concat(outcome.missing),
          }
        : { type: "snapshot", snapshots: live.map((uri) => core.store.snapshot(uri)).filter(isSnapshot) };
    for (const uri of live) {
      if (core.store.has(uri)) {
        core.join(connection, uri);
      }
    }
    return result as ReconnectResult;
  });

  async function subscribeAll(uris: string[]): Promise<Snapshot[]> {
    const snapshots: Snapshot[] = [];
    for (const uri of new Set(uris)) {
      try {
        const snapshot = await subscribeOne(uri);
        if (snapshot) {
          snapshots.push(snapshot);
        }
      } catch (err) {
        log.warn(`initial subscription to ${uri} skipped`, err);
      }
    }
    return snapshots;
  }

  async function subscribeOne(uri: string): Promise<Snapshot | undefined> {
    await core.ensureAttached(uri);
    if (connection.closed) {
      core.detachIfIdle(uri);
      throw new RpcError(ErrorCodes.InternalError, "connection closed");
    }
    const snapshot = core.store.snapshot(uri);
    core.join(connection, uri);
    return snapshot;
  }

  peer.onRequest("subscribe", async (raw) => {
    ready();
    const params = asObject(raw);
    const snapshot = await subscribeOne(requireString(params, "channel"));
    return snapshot ? { snapshot } : {};
  });

  peer.onNotification("unsubscribe", (raw) => {
    const params = asObject(raw);
    const channel = requireString(params, "channel");
    core.release(connection, channel);
  });

  peer.onRequest("ping", () => {
    ready();
    return null;
  });

  peer.onRequest("listSessions", async (raw) => {
    const version = ready();
    const params = asObject(raw) as never;
    const result = await core.backend.listSessions(params, core.context(connection));
    return { ...result, items: result.items.map((item) => shapeSummary(item, version)) };
  });

  peer.onNotification("dispatchAction", (raw) => {
    dispatchQueue = dispatchQueue.then(() => dispatchAction(raw)).catch((err) => {
      log.error("dispatchAction failed", err);
    });
  });

  async function dispatchAction(raw: unknown): Promise<void> {
    if (!connection.version || !connection.clientId || typeof raw !== "object" || raw === null) {
      return;
    }
    const { channel, clientSeq, action } = raw as {
      channel?: unknown;
      clientSeq?: unknown;
      action?: unknown;
    };
    if (typeof channel !== "string" || typeof clientSeq !== "number" || typeof action !== "object" || !action) {
      return;
    }
    const origin: ActionOrigin = { clientId: connection.clientId, clientSeq };
    const typed = action as StateAction;
    const refuse = (reason: string): void => {
      core.sendRejection(connection, channel, typed, origin, reason);
    };

    const check = (): string | undefined => {
      const state = core.store.state(channel);
      if (!state) {
        return undefined;
      }
      const verdict = validateAction(channel, state, typed, connection.version as string);
      return verdict.ok ? undefined : verdict.reason;
    };

    if (!core.store.has(channel)) {
      return;
    }
    const first = check();
    if (first) {
      refuse(first);
      return;
    }
    let decision: ActionDecision;
    try {
      decision = await core.backend.handleAction({
        channel,
        action: typed,
        origin,
        client: core.context(connection),
      });
    } catch (err) {
      log.error(`backend rejected ${typed.type} with an error`, err);
      refuse("internal error");
      return;
    }
    if (!decision.accept) {
      refuse(decision.reason);
      return;
    }
    if (!core.store.has(channel)) {
      return;
    }
    const second = check();
    if (second) {
      refuse(second);
      return;
    }
    core.publish(channel, typed, origin);
    trackActiveClient(channel, typed);
  }

  function trackActiveClient(channel: string, next: StateAction): void {
    if (next.type === "session/activeClientSet" && next.activeClient.clientId === connection.clientId) {
      connection.activeIn.add(channel);
    } else if (next.type === "session/activeClientRemoved" && next.clientId === connection.clientId) {
      connection.activeIn.delete(channel);
    }
  }

  peer.onUnhandledRequest(async (method, raw) => {
    ready();
    const handle = core.backend.handleCommand;
    if (!handle) {
      throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
    }
    return handle.call(core.backend, method, raw, core.context(connection));
  });

  return () => {
    core.removeConnection(connection);
  };
}

function isSnapshot(value: Snapshot | undefined): value is Snapshot {
  return value !== undefined;
}
