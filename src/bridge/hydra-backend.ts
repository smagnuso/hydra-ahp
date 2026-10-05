import { homedir } from "node:os";
import { EditContentStore, isEditContentUri } from "./edit-content.js";
import type {
  ListSessionsParams,
  ListSessionsResult,
  SessionConfigState,
  SessionState,
} from "@microsoft/agent-host-protocol";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import type { ActionDecision, ActionRequest, Backend, ClientContext } from "../protocol/backend.js";
import type { ProtocolCore } from "../protocol/core.js";
import type { ExtensionState } from "../hydra/ext-state.js";
import type { FileService } from "../files/service.js";
import type { TerminalService } from "../terminals/service.js";
import type { ChangesetService } from "../changesets/service.js";
import { isChangesetChannelUri, isTerminalUri } from "../protocol/channels.js";
import { HydraHttpError, type HydraRest, type HydraSessionEntry } from "../hydra/rest.js";
import type { HydraSessions } from "../hydra/sessions.js";
import { logger } from "../util/log.js";
import { AHP_CHAT_KEY, AHP_URI_KEY, type Catalog, type SideOrigin } from "./catalog.js";
import { toConfigState } from "./config.js";
import { chatKey, cwdToUri, defaultChatUri, isChatUri, isSessionUri, sessionKey, uriToCwd } from "./ids.js";
import { emptyChat } from "./replay.js";
import { SessionBridge } from "./session-bridge.js";
import { STATUS_IDLE, UNTITLED, entryToSummary, summaryToSessionState } from "./summary.js";
import { randomUUID } from "node:crypto";

const log = logger("backend");

const SESSION_NOT_FOUND = -32001;
const NO_SUCH_PROVIDER = -32002;
const SESSION_EXISTS = -32003;

const FAILED_CHANNEL_LINGER_MS = 30_000;
const MAX_IDLE_BRIDGES = 16;
const INITIAL_WAIT_MS = 10 * 60_000;

const action = (value: Record<string, unknown>) => value as never;

export interface HydraBackendOptions {
  catalog: Catalog;
  rest: HydraRest;
  extState: ExtensionState;
  sessions: HydraSessions;
  version: string;
  files: FileService;
  terminals?: TerminalService;
  changesets?: ChangesetService;
  permissionDelayMs?: number;
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
  private readonly terminals: TerminalService | undefined;
  private readonly changesets: ChangesetService | undefined;
  private readonly edits = new EditContentStore();
  private readonly permissionDelayMs: number;

  constructor(options: HydraBackendOptions) {
    this.catalog = options.catalog;
    this.rest = options.rest;
    this.extState = options.extState;
    this.sessions = options.sessions;
    this.files = options.files;
    this.terminals = options.terminals;
    this.changesets = options.changesets;
    this.permissionDelayMs = options.permissionDelayMs ?? 0;
    this.serverInfo = { name: "hydra-ahp", version: options.version };
  }

  async start(core: ProtocolCore): Promise<void> {
    this.core = core;
    await this.terminals?.start(core);
    this.changesets?.start(core);
    this.catalog.onChange(() => this.onCatalogChange());
    this.catalog.onRevived((hydraId) => this.bridges.get(hydraId)?.showFlag("isArchived", false));
    await this.catalog.start(core);
  }

  async stop(): Promise<void> {
    this.catalog.stop();
    this.terminals?.stop();
    this.changesets?.stop();
    const bridges = [...this.bridges.values()];
    this.bridges.clear();
    await Promise.all(bridges.map((bridge) => bridge.dispose().catch(() => undefined)));
  }

  // The bridge for a session or chat channel, once the session exists in Hydra. A session channel is served by its default chat's bridge.
  bridgeFor(channel: string): SessionBridge | undefined {
    const hydraId = isChatUri(channel) ? this.catalog.resolveChat(channel) : this.catalog.resolve(channel);
    if (!hydraId) {
      return undefined;
    }
    let bridge = this.bridges.get(hydraId);
    if (!bridge) {
      bridge = new SessionBridge({
        hydraId,
        sessionUri: this.catalog.groupOf(hydraId),
        chatUri: this.catalog.chatOf(hydraId),
        core: this.core,
        catalog: this.catalog,
        rest: this.rest,
        sessions: this.sessions,
        permissionDelayMs: this.permissionDelayMs,
        edits: this.edits,
      });
      this.bridges.set(hydraId, bridge);
    }
    return bridge;
  }

  private onCatalogChange(): void {
    for (const [hydraId, bridge] of [...this.bridges]) {
      // A session whose agent changed moves to the new agent's URI; its old channels are gone, so is its bridge.
      const moved = bridge.session !== this.catalog.groupOf(hydraId) || bridge.chat !== this.catalog.chatOf(hydraId);
      if (!this.catalog.entry(hydraId) || moved) {
        this.bridges.delete(hydraId);
        void bridge.dispose().catch(() => undefined);
        continue;
      }
      bridge.onCatalogChange();
    }
    this.syncTitles();
    this.syncChats();
  }

  // Keeps each open session channel's chat list in step with its members: chats added, removed or promoted to default.
  private syncChats(): void {
    for (const uri of this.core.store.uris()) {
      if (!isSessionUri(uri)) {
        continue;
      }
      const summary = this.catalog.summaryFor(uri);
      const state = this.core.store.state(uri) as SessionState | undefined;
      if (!summary || !state) {
        continue;
      }
      const wanted = summary.chats ?? [];
      const held = new Set(state.chats.map((chat) => chat.resource));
      const keep = new Set(wanted.map((chat) => chat.resource));
      for (const chat of wanted) {
        if (!held.has(chat.resource)) {
          this.core.publish(
            uri,
            action({
              type: "session/chatAdded",
              summary: {
                resource: chat.resource,
                title: chat.title,
                status: chat.status ?? STATUS_IDLE,
                modifiedAt: (chat as { modifiedAt?: string }).modifiedAt ?? summary.modifiedAt,
              },
            }),
          );
        }
      }
      for (const chat of held) {
        if (!keep.has(chat)) {
          this.core.publish(uri, action({ type: "session/chatRemoved", chat }));
          this.core.removeChannel(chat);
        }
      }
      if (summary.defaultChat !== undefined && state.defaultChat !== summary.defaultChat) {
        this.core.publish(uri, action({ type: "session/defaultChatChanged", defaultChat: summary.defaultChat }));
      }
    }
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
    if (isChangesetChannelUri(uri)) {
      this.changesets?.attach(uri);
      return;
    }
    await this.creating.get(uri);
    if (isChatUri(uri)) {
      if (this.core.store.has(uri) && !this.catalog.resolveChat(uri)) {
        return;
      }
      await this.bridgeFor(uri)?.attach();
      return;
    }
    if (!isSessionUri(uri) || this.core.store.has(uri)) {
      return;
    }
    // A live session's settings only come from attaching to it, and the channel can only get them when it is created.
    const lead = this.catalog.membersOf(uri)[0];
    if (lead && this.catalog.entry(lead)?.status !== "cold") {
      await this.bridgeFor(this.catalog.chatOf(lead))?.attach().catch((err) => {
        log.debug(`attach ${lead} for its settings failed`, message(err));
      });
    }
    const summary = this.catalog.summaryFor(uri);
    if (summary && !this.core.store.has(uri)) {
      this.core.createChannel(uri, summaryToSessionState(summary, "ready", this.catalog.configStateFor(uri), this.catalog.changesetsOf(uri)));
    }
  }

  async detach(uri: string): Promise<void> {
    if (isChangesetChannelUri(uri)) {
      this.changesets?.detach(uri);
      return;
    }
    if (isSessionUri(uri)) {
      for (const id of this.catalog.membersOf(uri)) {
        const chat = this.catalog.chatOf(id);
        if (!this.core.hasSubscribers(chat)) {
          await this.bridges.get(id)?.detach();
        }
      }
      this.dropIdleSession(uri);
      return;
    }
    if (!isChatUri(uri)) {
      return;
    }
    const bridge = this.bridgeFor(uri);
    await bridge?.detach();
    this.evictIdle();
    this.dropIdleSession(this.catalog.sessionUriForChat(uri));
  }

  // Session state only follows flags and input needs, so an unwatched channel is rebuilt from the current summary on the next subscribe.
  private dropIdleSession(uri: string): void {
    if (!this.core.store.has(uri) || this.core.hasSubscribers(uri)) {
      return;
    }
    const busy = this.catalog.membersOf(uri).some((id) => this.core.hasSubscribers(this.catalog.chatOf(id)) || this.bridges.get(id)?.isAttached);
    if (!busy) {
      this.core.removeChannel(uri);
    }
  }

  connectionClosed(clientId: string): void {
    this.terminals?.connectionClosed(clientId);
  }

  async handleAction(request: ActionRequest): Promise<ActionDecision> {
    const { channel } = request;
    if (this.terminals && isTerminalUri(channel)) {
      return this.terminals.handleAction(channel, request.action as never);
    }
    if (!isChatUri(channel) && !isSessionUri(channel)) {
      return { accept: false, reason: "this host does not accept that action" };
    }
    // Clients may act on a session they just created before it is ready; hold the action until it is.
    await this.creating.get(channel);
    await this.creating.get(isChatUri(channel) ? this.catalog.sessionUriForChat(channel) : channel);
    const bridge = this.bridgeFor(channel);
    if (!bridge) {
      return { accept: false, reason: "the session is not ready yet" };
    }
    return bridge.handleAction(channel, request.action);
  }

  async handleCommand(method: string, params: unknown, client: ClientContext): Promise<unknown> {
    const target = (params as { uri?: unknown } | undefined)?.uri;
    if (method === "resourceRead" && this.changesets?.ownsContent(target)) {
      return this.changesets.read(target, (params as { encoding?: unknown }).encoding);
    }
    if (method === "resourceRead" && isEditContentUri(target)) {
      return this.edits.read(target, (params as { encoding?: unknown }).encoding);
    }
    if (this.files.handles(method)) {
      return this.files.handle(method, params, client);
    }
    if (this.terminals?.handles(method)) {
      return this.terminals.handle(method, params, client);
    }
    const body = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "createSession":
        return this.createSession(body);
      case "disposeSession":
        return this.disposeSession(body);
      case "createChat":
        return this.createChat(body);
      case "disposeChat":
        return this.disposeChat(body);
      case "resolveSessionConfig":
        return this.resolveSessionConfig(body);
      case "fetchTurns":
        return this.fetchTurns(body);
      default:
        throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
    }
  }

  // The settings a new session of this agent will offer: the set last seen from a session of it, with the client's picks applied.
  private resolveSessionConfig(params: Record<string, unknown>): { schema: object; values: Record<string, unknown> } {
    const provider = typeof params.provider === "string" ? params.provider : this.catalog.agents()[0]?.provider;
    const state = toConfigState(this.catalog.knownConfigFor(provider));
    if (!state) {
      return { schema: { type: "object", properties: {} }, values: {} };
    }
    const picks = (params.config ?? {}) as Record<string, unknown>;
    const values: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(state.schema.properties)) {
      const pick = picks[key];
      values[key] = typeof pick === "string" && schema.enum?.includes(pick) ? pick : state.values[key];
    }
    return { schema: state.schema, values };
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
    const chat = defaultChatUri(channel);
    const offered = this.resolveSessionConfig({ provider, config: params.config });
    const picks = Object.fromEntries(
      Object.entries(offered.values).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
    );
    const config = Object.keys(offered.values).length > 0 ? ({ schema: offered.schema, values: offered.values } as SessionConfigState) : undefined;
    this.catalog.beginCreation(channel, summary);
    this.core.createChannel(channel, summaryToSessionState(summary, "creating", config));
    this.core.createChannel(chat, emptyChat(chat, summary.title, now, STATUS_IDLE));
    const finishing = this.finishCreation(channel, provider, cwd, picks).finally(() => {
      this.creating.delete(channel);
    });
    this.creating.set(channel, finishing);
    return null;
  }

  private async finishCreation(channel: string, provider: string | undefined, cwd: string | undefined, picks: Record<string, string>): Promise<void> {
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
      const changesets = this.catalog.changesetsOf(channel);
      if (changesets) {
        this.core.publish(channel, action({ type: "session/changesetsChanged", changesets }));
      }
      // A client may have subscribed to the chat while the session was being created.
      const chat = defaultChatUri(channel);
      if (this.core.hasSubscribers(chat) || Object.keys(picks).length > 0) {
        await this.bridgeFor(chat)?.attach().catch((err) => {
          log.warn(`attach after creating ${channel} failed`, message(err));
        });
      }
      if (Object.keys(picks).length > 0) {
        await this.bridgeFor(chat)?.applyInitialConfig(picks);
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
        this.core.removeChannel(defaultChatUri(channel));
      }, FAILED_CHANNEL_LINGER_MS).unref();
    }
  }

  // REST rather than ACP session/delete: daemons up to 0.1.197 register that verb for transformer connections only, so other clients reach the agent instead.
  private async deleteHydraSession(hydraId: string): Promise<void> {
    try {
      await this.rest.deleteSession(hydraId);
    } catch (err) {
      if (err instanceof HydraHttpError && err.status === 404) {
        throw new RpcError(SESSION_NOT_FOUND, "Session not found");
      }
      throw new RpcError(ErrorCodes.InternalError, `Hydra could not delete the session: ${message(err)}`);
    }
    this.catalog.remove(hydraId);
  }

  // Same as deleting from Hydra: the agent stops for every attached client and a tombstone remains. Every chat of the session goes.
  private async disposeSession(params: Record<string, unknown>): Promise<null> {
    const channel = params.channel;
    const members = typeof channel === "string" ? this.catalog.membersOf(channel) : [];
    if (members.length === 0) {
      throw new RpcError(SESSION_NOT_FOUND, "Session not found");
    }
    for (const hydraId of [...members].reverse()) {
      await this.deleteHydraSession(hydraId);
    }
    return null;
  }

  // Deleting a session's last chat deletes the session.
  private async disposeChat(params: Record<string, unknown>): Promise<null> {
    const channel = params.channel;
    const hydraId = typeof channel === "string" ? this.catalog.resolveChat(channel) : undefined;
    if (!hydraId) {
      throw new RpcError(SESSION_NOT_FOUND, "Chat not found");
    }
    const session = this.catalog.groupOf(hydraId);
    if (this.catalog.membersOf(session).length <= 1) {
      return this.disposeSession({ channel: session });
    }
    await this.deleteHydraSession(hydraId);
    return null;
  }

  // One more chat in an existing session is one more Hydra session stamped with the same AHP session URI.
  private async createChat(params: Record<string, unknown>): Promise<null> {
    const session = params.channel;
    const chat = params.chat;
    if (typeof session !== "string" || !isSessionUri(session)) {
      throw new RpcError(ErrorCodes.InvalidParams, "channel must be a session URI");
    }
    if (typeof chat !== "string" || !isChatUri(chat) || chatKey(chat) === "") {
      throw new RpcError(ErrorCodes.InvalidParams, "chat must be an ahp-chat: URI");
    }
    const leadId = this.catalog.resolve(session);
    const lead = leadId ? this.catalog.entry(leadId) : undefined;
    if (!leadId || !lead) {
      throw new RpcError(SESSION_NOT_FOUND, "Session not found");
    }
    if (lead.remote !== undefined || leadId.includes(":")) {
      throw new RpcError(ErrorCodes.InvalidParams, "chats cannot be added to a session on a federated remote");
    }
    if (this.catalog.chatInUse(chat) || this.core.store.has(chat)) {
      throw new RpcError(SESSION_EXISTS, "Chat already exists");
    }
    const source = params.source as { kind?: unknown; chat?: unknown; turnId?: unknown; selection?: unknown } | undefined;
    let forkFrom: { hydraId: string; at: string | undefined } | undefined;
    let side: SideOrigin | undefined;
    if (source !== undefined) {
      if (source.kind !== "fork" && source.kind !== "sideChat") {
        throw new RpcError(ErrorCodes.InvalidParams, "only fork and sideChat sources are supported");
      }
      const sourceId = typeof source.chat === "string" ? this.catalog.resolveChat(source.chat) : undefined;
      if (!sourceId || this.catalog.groupOf(sourceId) !== session) {
        throw new RpcError(ErrorCodes.InvalidParams, "the source chat must belong to this session");
      }
      const turnId = typeof source.turnId === "string" ? source.turnId : undefined;
      forkFrom = { hydraId: sourceId, at: turnId === undefined ? undefined : (this.bridgeFor(source.chat as string)?.messageIdFor(turnId) ?? turnId) };
      if (source.kind === "sideChat") {
        const selection = source.selection as { text?: unknown; responsePartId?: unknown } | undefined;
        if (selection !== undefined && (typeof selection.text !== "string" || selection.text === "")) {
          throw new RpcError(ErrorCodes.InvalidParams, "selection.text must be non-empty");
        }
        side = {
          chat: source.chat as string,
          turnId: turnId ?? "",
          ...(selection ? { selection: { text: selection.text as string, ...(typeof selection.responsePartId === "string" ? { responsePartId: selection.responsePartId } : {}) } } : {}),
        };
      }
    }
    const initial = params.initialMessage;
    this.catalog.beginChatCreation(chat, session);
    const finishing = this.finishChat(session, chat, lead, forkFrom, side);
    this.creating.set(chat, finishing);
    try {
      await finishing;
    } finally {
      this.creating.delete(chat);
    }
    if (initial !== undefined && initial !== null) {
      void this.runInitial(chat, initial as Record<string, unknown>);
    }
    return null;
  }

  private async finishChat(
    session: string,
    chat: string,
    lead: HydraSessionEntry,
    forkFrom: { hydraId: string; at: string | undefined } | undefined,
    side: SideOrigin | undefined,
  ): Promise<void> {
    let hydraId: string | undefined;
    try {
      const forkAt = forkFrom?.at ? { forkAt: forkFrom.at } : {};
      const created = forkFrom
        ? side
          ? await this.rest.sideSession(forkFrom.hydraId, { ...forkAt, ...(side.selection ? { selection: side.selection } : {}) })
          : await this.rest.forkSession(forkFrom.hydraId, { mode: "verbatim", ...forkAt })
        : await this.rest.createSession({
            ...(lead.agentId ? { agentId: lead.agentId } : {}),
            ...(lead.cwd ? { cwd: lead.cwd } : {}),
          });
      hydraId = created.sessionId;
      await this.extState.set(hydraId, AHP_URI_KEY, session);
      const at = Date.now();
      await this.extState.set(hydraId, AHP_CHAT_KEY, { chat, at, ...(side ? { side } : {}) });
      const entry = await this.rest.getSession(hydraId);
      this.catalog.claimChat(hydraId, session, chat, at, entry, side);
    } catch (err) {
      log.warn(`createChat ${chat} failed`, message(err));
      if (hydraId) {
        await this.rest.deleteSession(hydraId).catch(() => undefined);
      }
      this.catalog.failChatCreation(chat);
      throw new RpcError(ErrorCodes.InternalError, `Hydra could not create the chat: ${message(err)}`);
    }
  }

  // The first message of a new chat becomes its first turn, with or without a client watching; the attachment is dropped once it ends unwatched.
  private async runInitial(chat: string, first: Record<string, unknown>): Promise<void> {
    const bridge = this.bridgeFor(chat);
    try {
      await bridge?.startInitial(randomUUID(), first);
      for (let waited = 0; bridge?.running && waited < INITIAL_WAIT_MS; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (err) {
      log.warn(`initial message for ${chat} failed`, message(err));
    }
    if (bridge && !this.core.hasSubscribers(chat)) {
      await bridge.detach().catch(() => undefined);
    }
  }
}
