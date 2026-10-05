import { homedir } from "node:os";
import type {
  ListSessionsParams,
  ListSessionsResult,
  SessionState,
} from "@microsoft/agent-host-protocol";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import type { ActionDecision, ActionRequest, Backend, ClientContext } from "../protocol/backend.js";
import type { ProtocolCore } from "../protocol/core.js";
import type { ExtensionState } from "../hydra/ext-state.js";
import type { FileService } from "../files/service.js";
import type { HydraRest } from "../hydra/rest.js";
import type { HydraSessions } from "../hydra/sessions.js";
import { logger } from "../util/log.js";
import { AHP_URI_KEY, type Catalog } from "./catalog.js";
import { chatUri, cwdToUri, isChatUri, isSessionUri, sessionKey, uriToCwd } from "./ids.js";
import { emptyChat } from "./replay.js";
import { SessionBridge } from "./session-bridge.js";
import { STATUS_IDLE, UNTITLED, entryToSummary, summaryToSessionState } from "./summary.js";

const log = logger("backend");

const SESSION_NOT_FOUND = -32001;
const NO_SUCH_PROVIDER = -32002;
const SESSION_EXISTS = -32003;

const FAILED_CHANNEL_LINGER_MS = 30_000;
const MAX_IDLE_BRIDGES = 16;

const action = (value: Record<string, unknown>) => value as never;

export interface HydraBackendOptions {
  catalog: Catalog;
  rest: HydraRest;
  extState: ExtensionState;
  sessions: HydraSessions;
  version: string;
  files: FileService;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The catalog, createSession and disposeSession, plus one session bridge per session a client has opened a chat of.
export class HydraBackend implements Backend {
  readonly serverInfo: { name: string; version: string };
  readonly defaultDirectory = cwdToUri(homedir());
  readonly completionTriggerCharacters = ["@"];
  private core!: ProtocolCore;
  private readonly catalog: Catalog;
  private readonly rest: HydraRest;
  private readonly extState: ExtensionState;
  private readonly sessions: HydraSessions;
  private readonly bridges = new Map<string, SessionBridge>();
  private readonly creating = new Map<string, Promise<void>>();
  private readonly files: FileService;

  constructor(options: HydraBackendOptions) {
    this.catalog = options.catalog;
    this.rest = options.rest;
    this.extState = options.extState;
    this.sessions = options.sessions;
    this.files = options.files;
    this.serverInfo = { name: "hydra-ahp", version: options.version };
  }

  async start(core: ProtocolCore): Promise<void> {
    this.core = core;
    this.catalog.onChange(() => this.onCatalogChange());
    await this.catalog.start(core);
  }

  async stop(): Promise<void> {
    this.catalog.stop();
    const bridges = [...this.bridges.values()];
    this.bridges.clear();
    await Promise.all(bridges.map((bridge) => bridge.dispose().catch(() => undefined)));
  }

  // The bridge for a session or chat channel, once the session exists in Hydra.
  bridgeFor(channel: string): SessionBridge | undefined {
    const session = isChatUri(channel) ? this.catalog.sessionUriForChat(channel) : channel;
    const hydraId = this.catalog.resolve(session);
    if (!hydraId) {
      return undefined;
    }
    let bridge = this.bridges.get(hydraId);
    if (!bridge) {
      bridge = new SessionBridge({
        hydraId,
        sessionUri: session,
        chatUri: chatUri(sessionKey(session)),
        core: this.core,
        catalog: this.catalog,
        rest: this.rest,
        sessions: this.sessions,
      });
      this.bridges.set(hydraId, bridge);
    }
    return bridge;
  }

  private onCatalogChange(): void {
    for (const [hydraId, bridge] of [...this.bridges]) {
      if (!this.catalog.entry(hydraId)) {
        this.bridges.delete(hydraId);
        void bridge.dispose().catch(() => undefined);
        continue;
      }
      bridge.onCatalogChange();
    }
    this.syncTitles();
  }

  private syncTitles(): void {
    for (const uri of this.core.store.uris()) {
      if (!isSessionUri(uri)) {
        continue;
      }
      const summary = this.catalog.summaryFor(uri);
      const state = this.core.store.state(uri) as SessionState | undefined;
      if (summary && state && summary.title !== UNTITLED && state.title !== summary.title) {
        this.core.publish(uri, action({ type: "session/titleChanged", title: summary.title }));
      }
    }
  }

  private evictIdle(): void {
    const idle = [...this.bridges].filter(
      ([, bridge]) => !bridge.isAttached && !this.core.hasSubscribers(bridge.chat),
    );
    for (const [hydraId, bridge] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_BRIDGES))) {
      this.bridges.delete(hydraId);
      void bridge.dispose().catch(() => undefined);
    }
  }

  listSessions(params: ListSessionsParams): ListSessionsResult {
    try {
      return this.catalog.list(params.limit, params.cursor);
    } catch {
      throw new RpcError(ErrorCodes.InvalidParams, "invalid cursor");
    }
  }

  // A session channel is a view of the catalog row; the chat channel is built by the bridge from Hydra's history.
  async attach(uri: string): Promise<void> {
    if (isChatUri(uri)) {
      if (this.core.store.has(uri) && !this.catalog.resolve(this.catalog.sessionUriForChat(uri))) {
        return;
      }
      await this.bridgeFor(uri)?.attach();
      return;
    }
    if (!isSessionUri(uri) || this.core.store.has(uri)) {
      return;
    }
    const summary = this.catalog.summaryFor(uri);
    if (summary) {
      this.core.createChannel(uri, summaryToSessionState(summary, "ready"));
    }
  }

  async detach(uri: string): Promise<void> {
    if (!isChatUri(uri)) {
      return;
    }
    const bridge = this.bridgeFor(uri);
    await bridge?.detach();
    this.evictIdle();
  }

  async handleAction(request: ActionRequest): Promise<ActionDecision> {
    const { channel } = request;
    if (!isChatUri(channel) && !isSessionUri(channel)) {
      return { accept: false, reason: "this host does not accept that action" };
    }
    // Clients may act on a session they just created before it is ready; hold the action until it is.
    const session = isChatUri(channel) ? this.catalog.sessionUriForChat(channel) : channel;
    await this.creating.get(session);
    const bridge = this.bridgeFor(channel);
    if (!bridge) {
      return { accept: false, reason: "the session is not ready yet" };
    }
    return bridge.handleAction(channel, request.action);
  }

  async handleCommand(method: string, params: unknown, client: ClientContext): Promise<unknown> {
    if (this.files.handles(method)) {
      return this.files.handle(method, params, client);
    }
    const body = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "createSession":
        return this.createSession(body);
      case "disposeSession":
        return this.disposeSession(body);
      case "fetchTurns":
        return this.fetchTurns(body);
      default:
        throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
    }
  }

  private async fetchTurns(params: Record<string, unknown>): Promise<Record<string, never>> {
    const channel = params.channel;
    if (typeof channel !== "string" || !isChatUri(channel) || !this.core.store.has(channel)) {
      throw new RpcError(SESSION_NOT_FOUND, "Chat not found");
    }
    const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
    const bridge = this.bridgeFor(channel);
    if (!bridge) {
      throw new RpcError(SESSION_NOT_FOUND, "Chat not found");
    }
    await bridge.fetchTurns(cursor);
    return {};
  }

  private createSession(params: Record<string, unknown>): null {
    const channel = params.channel;
    if (typeof channel !== "string" || !isSessionUri(channel)) {
      throw new RpcError(ErrorCodes.InvalidParams, "channel must be a session URI such as <provider>:/<id>");
    }
    const provider = typeof params.provider === "string" ? params.provider : undefined;
    if (provider !== undefined && !this.catalog.hasAgent(provider)) {
      throw new RpcError(NO_SUCH_PROVIDER, `No agent for provider ${provider}`);
    }
    const directories = Array.isArray(params.workingDirectories) ? (params.workingDirectories as unknown[]) : [];
    let cwd: string | undefined;
    if (directories.length > 0) {
      cwd = typeof directories[0] === "string" ? uriToCwd(directories[0]) : undefined;
      if (!cwd) {
        throw new RpcError(ErrorCodes.InvalidParams, "workingDirectories must be file: URIs");
      }
    }
    if (this.core.store.has(channel) || this.catalog.uriInUse(channel)) {
      throw new RpcError(SESSION_EXISTS, "Session already exists");
    }

    const now = new Date().toISOString();
    const summary = entryToSummary(
      {
        sessionId: sessionKey(channel),
        agentId: provider ?? this.catalog.agents()[0]?.provider ?? "unknown",
        ...(cwd ? { cwd } : {}),
        updatedAt: now,
        createdAt: now,
      },
      channel,
    );
    const chat = chatUri(sessionKey(channel));
    this.catalog.beginCreation(channel, summary);
    this.core.createChannel(channel, summaryToSessionState(summary, "creating"));
    this.core.createChannel(chat, emptyChat(chat, summary.title, now, STATUS_IDLE));
    const finishing = this.finishCreation(channel, provider, cwd).finally(() => {
      this.creating.delete(channel);
    });
    this.creating.set(channel, finishing);
    return null;
  }

  private async finishCreation(channel: string, provider: string | undefined, cwd: string | undefined): Promise<void> {
    let hydraId: string | undefined;
    try {
      const created = await this.rest.createSession({
        ...(provider ? { agentId: provider } : {}),
        ...(cwd ? { cwd } : {}),
      });
      hydraId = created.sessionId;
      await this.extState.set(hydraId, AHP_URI_KEY, channel);
      const entry = await this.rest.getSession(hydraId);
      this.catalog.claim(hydraId, channel, entry);
      this.core.publish(channel, action({ type: "session/ready" }));
      // A client may have subscribed to the chat while the session was being created.
      const chat = chatUri(sessionKey(channel));
      if (this.core.hasSubscribers(chat)) {
        await this.bridgeFor(chat)?.attach().catch((err) => {
          log.warn(`attach after creating ${channel} failed`, message(err));
        });
      }
    } catch (err) {
      log.warn(`createSession ${channel} failed`, message(err));
      if (hydraId) {
        await this.rest.deleteSession(hydraId).catch(() => undefined);
      }
      this.catalog.failCreation(channel);
      this.core.publish(
        channel,
        action({ type: "session/creationFailed", error: { errorType: "createSessionFailed", message: message(err) } }),
      );
      setTimeout(() => {
        this.core.removeChannel(channel);
        this.core.removeChannel(chatUri(sessionKey(channel)));
      }, FAILED_CHANNEL_LINGER_MS).unref();
    }
  }

  // Same as deleting from Hydra: the agent stops for every attached client and a tombstone remains.
  private async disposeSession(params: Record<string, unknown>): Promise<null> {
    const channel = params.channel;
    const hydraId = typeof channel === "string" ? this.catalog.resolve(channel) : undefined;
    if (!hydraId) {
      throw new RpcError(SESSION_NOT_FOUND, "Session not found");
    }
    try {
      await this.sessions.delete(hydraId);
    } catch (err) {
      if (err instanceof RpcError && err.code === SESSION_NOT_FOUND) {
        throw new RpcError(SESSION_NOT_FOUND, "Session not found");
      }
      throw new RpcError(ErrorCodes.InternalError, `Hydra could not delete the session: ${message(err)}`);
    }
    this.catalog.remove(hydraId);
    return null;
  }
}
