import type {
  ActionEnvelope,
  ActionOrigin,
  StateAction,
} from "@microsoft/agent-host-protocol";
import { ErrorCodes, RpcError, type JsonRpcPeer } from "../rpc/peer.js";
import type { TokenInfo } from "../store/tokens.js";
import { logger } from "../util/log.js";
import type { Backend, ClientContext } from "./backend.js";
import { ChannelStore, channelKind, type ChannelState, type ChannelStoreOptions } from "./channels.js";
import { isActionAllowed, isNotificationAllowed, shapeSummary } from "./negotiate.js";

const log = logger("core");

const SESSION_NOT_FOUND = -32001;

export interface Connection {
  id: number;
  peer: JsonRpcPeer;
  token: TokenInfo;
  clientId?: string;
  version?: string;
  subscriptions: Set<string>;
  // Session channels where this client registered itself as an active client.
  activeIn: Set<string>;
  closed: boolean;
}

export interface CoreOptions {
  backend: Backend;
  store?: ChannelStoreOptions;
}

const MAX_REMEMBERED_CLIENTS = 1024;

// Owns the channel store, the subscriptions and the fan-out; backends publish through it.
export class ProtocolCore {
  readonly store: ChannelStore;
  readonly backend: Backend;
  private readonly connections = new Set<Connection>();
  private readonly subscribers = new Map<string, Set<Connection>>();
  private readonly attaching = new Map<string, Promise<void>>();
  private readonly clientVersions = new Map<string, string>();
  private nextConnectionId = 1;

  constructor(options: CoreOptions) {
    this.backend = options.backend;
    this.store = new ChannelStore(options.store);
  }

  async start(): Promise<void> {
    await this.backend.start(this);
  }

  addConnection(peer: JsonRpcPeer, token: TokenInfo): Connection {
    const connection: Connection = {
      id: this.nextConnectionId++,
      peer,
      token,
      subscriptions: new Set(),
      activeIn: new Set(),
      closed: false,
    };
    this.connections.add(connection);
    return connection;
  }

  removeConnection(connection: Connection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    this.connections.delete(connection);
    for (const uri of [...connection.activeIn]) {
      this.retireActiveClient(connection, uri);
    }
    for (const uri of [...connection.subscriptions]) {
      this.release(connection, uri);
    }
  }

  // The spec asks the host to remove a client's active entry when it leaves or disconnects.
  private retireActiveClient(connection: Connection, uri: string): void {
    connection.activeIn.delete(uri);
    if (connection.clientId && this.store.has(uri)) {
      this.publish(uri, { type: "session/activeClientRemoved", clientId: connection.clientId } as never);
    }
  }

  context(connection: Connection): ClientContext {
    return {
      clientId: connection.clientId ?? "",
      version: connection.version ?? "",
      token: connection.token,
    };
  }

  rememberVersion(clientId: string, version: string): void {
    this.clientVersions.delete(clientId);
    this.clientVersions.set(clientId, version);
    if (this.clientVersions.size > MAX_REMEMBERED_CLIENTS) {
      const oldest = this.clientVersions.keys().next().value;
      if (oldest !== undefined) {
        this.clientVersions.delete(oldest);
      }
    }
  }

  recallVersion(clientId: string): string | undefined {
    return this.clientVersions.get(clientId);
  }

  createChannel(uri: string, state: ChannelState): void {
    this.store.create(uri, state);
  }

  removeChannel(uri: string): void {
    this.store.remove(uri);
    this.subscribers.delete(uri);
    for (const connection of this.connections) {
      connection.subscriptions.delete(uri);
    }
  }

  publish(channel: string, action: StateAction, origin?: ActionOrigin): ActionEnvelope {
    const envelope = this.store.apply(channel, action, origin);
    for (const connection of this.subscribers.get(channel) ?? []) {
      this.sendEnvelope(connection, envelope);
    }
    return envelope;
  }

  notify(channel: string, method: string, params: Record<string, unknown>): void {
    for (const connection of this.subscribers.get(channel) ?? []) {
      const version = connection.version;
      if (!version || !isNotificationAllowed(method, version)) {
        continue;
      }
      connection.peer.notify(method, this.shapeNotification(method, params, version));
    }
  }

  sendRejection(
    connection: Connection,
    channel: string,
    action: StateAction,
    origin: ActionOrigin,
    reason: string,
  ): void {
    const envelope: ActionEnvelope = {
      channel,
      action,
      serverSeq: this.store.serverSeq,
      origin,
      rejectionReason: reason,
    };
    connection.peer.notify("action", envelope);
  }

  hasSubscribers(uri: string): boolean {
    return (this.subscribers.get(uri)?.size ?? 0) > 0;
  }

  // Makes the channel servable; the first subscriber triggers the backend's lazy attach.
  async ensureAttached(uri: string): Promise<void> {
    if (!channelKind(uri)) {
      throw new RpcError(ErrorCodes.InvalidParams, `unsupported channel: ${uri}`);
    }
    let pending = this.attaching.get(uri);
    if (!pending && (!this.store.has(uri) || !this.hasSubscribers(uri))) {
      pending = Promise.resolve(this.backend.attach?.(uri)).finally(() => {
        this.attaching.delete(uri);
      });
      this.attaching.set(uri, pending);
    }
    await pending;
    if (!this.store.has(uri)) {
      throw new RpcError(SESSION_NOT_FOUND, `channel not found: ${uri}`);
    }
  }

  // Adds the subscription synchronously so no action can fall between snapshot and delivery.
  join(connection: Connection, uri: string): void {
    let set = this.subscribers.get(uri);
    if (!set) {
      set = new Set();
      this.subscribers.set(uri, set);
    }
    set.add(connection);
    connection.subscriptions.add(uri);
  }

  release(connection: Connection, uri: string): void {
    connection.subscriptions.delete(uri);
    if (connection.activeIn.has(uri)) {
      this.retireActiveClient(connection, uri);
    }
    const set = this.subscribers.get(uri);
    if (!set?.delete(connection)) {
      return;
    }
    if (set.size === 0) {
      this.subscribers.delete(uri);
      this.detach(uri);
    }
  }

  // For a subscribe that finished attaching after its connection went away.
  detachIfIdle(uri: string): void {
    if (!this.hasSubscribers(uri) && !this.attaching.has(uri)) {
      this.detach(uri);
    }
  }

  private detach(uri: string): void {
    Promise.resolve(this.backend.detach?.(uri)).catch((err) => {
      log.error(`detach ${uri} failed`, err);
    });
  }

  private sendEnvelope(connection: Connection, envelope: ActionEnvelope): void {
    const version = connection.version;
    if (!version) {
      return;
    }
    if (!isActionAllowed(envelope.action, version)) {
      return;
    }
    connection.peer.notify("action", envelope);
  }

  private shapeNotification(method: string, params: Record<string, unknown>, version: string): Record<string, unknown> {
    if (method === "root/sessionAdded" && params.summary) {
      return { ...params, summary: shapeSummary(params.summary as object, version) };
    }
    if (method === "root/sessionSummaryChanged" && params.changes) {
      return { ...params, changes: shapeSummary(params.changes as object, version) };
    }
    return params;
  }
}
