import type { AgentInfo, Changeset, RootState, SessionConfigState, SessionSummary } from "@microsoft/agent-host-protocol";
import { changesetsFor } from "../changesets/service.js";
import { ROOT_URI } from "../protocol/channels.js";
import type { ProtocolCore } from "../protocol/core.js";
import type { ExtensionState } from "../hydra/ext-state.js";
import type { HydraAgent, HydraRest, HydraSessionEntry, SessionPage } from "../hydra/rest.js";
import { logger } from "../util/log.js";
import type { FileSession } from "../files/service.js";
import { chatKey, defaultChatUri, isChatUri, isFederatedId, providerSessionUri, sessionOfDefaultChat, sessionUri } from "./ids.js";
import { NO_FLAGS, type FlagStore, type SessionFlags } from "../store/flags.js";
import type { ConfigStore } from "../store/configs.js";
import type { KnownModel, ModelStore } from "../store/models.js";
import { toConfigState, type ConfigOption } from "./config.js";
import { groupToSummary, type GroupMember } from "./summary.js";

const log = logger("catalog");

export const AHP_URI_KEY = "ahpUri";
export const AHP_CHAT_KEY = "ahpChat";
export const AHP_FLAGS_KEY = "flags";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const STAMP_LOOKUP_CONCURRENCY = 8;

export interface CatalogOptions {
  rest: HydraRest;
  extState: ExtensionState;
  flags?: FlagStore;
  models?: ModelStore;
  configs?: ConfigStore;
  pollMs?: number;
  warmPollMs?: number;
  agentsEveryPolls?: number;
  // Advertise each local session's uncommitted changes; the backend must serve them.
  changesets?: boolean;
  unpromptedGraceMs?: number;
}

type Json = Record<string, unknown>;

// Name of the machine that owns the session's files, when it is not this one (mirrors the browser's foreignCwdOwner).
function remoteOwner(entry: HydraSessionEntry): string | undefined {
  if (entry.remote !== undefined) {
    return entry.remote;
  }
  if (entry.importedFromMachine !== undefined && !entry.upstreamSessionId) {
    return entry.importedFromMachine;
  }
  return isFederatedId(entry.sessionId) ? entry.sessionId.slice(0, entry.sessionId.indexOf(":")) : undefined;
}

const action = (value: Json) => value as never;
const UNPROMPTED_GRACE_MS = 60_000;

// Mirrors Hydra's session list into the AHP root channel and answers listSessions from it.
export class Catalog {
  private core!: ProtocolCore;
  private readonly rest: HydraRest;
  private readonly extState: ExtensionState;
  private readonly entries = new Map<string, HydraSessionEntry>();
  private readonly stamps = new Map<string, string>();
  // The chat URI a Hydra session was added under and when; the session that started the AHP session has none and is the default chat.
  private readonly chatStamps = new Map<string, { chat: string; at: number; side?: SideOrigin }>();
  // The sessions and chats clients can address, rebuilt by every reconcile: a session URI maps to its member Hydra ids, oldest (the default chat) first.
  private readonly groups = new Map<string, string[]>();
  private readonly chatToId = new Map<string, string>();
  // Sessions and chats this extension is still creating, mapped to the session URI they belong to.
  private readonly pendingChats = new Map<string, string>();
  private readonly lookedUp = new Set<string>();
  // Read and archive marks of local sessions, which live in their extension_state so they travel with the session.
  private readonly sessionFlags = new Map<string, SessionFlags>();
  private readonly flagWrites = new Map<string, Promise<void>>();
  private readonly published = new Map<string, SessionSummary>();
  private readonly pendingCreations = new Set<string>();
  // When a client last had each unprompted session the extension created open; a restart counts as a sighting.
  private readonly watchedAt = new Map<string, number>();
  private readonly startedMs = Date.now();
  private readonly changeListeners = new Set<() => void>();
  private cursor: number | undefined;
  private polls = 0;
  private rawAgents: HydraAgent[] = [];
  private sessionDefaults: Record<string, Record<string, string>> = {};
  private agentList: AgentInfo[] = [];
  private pollTimer: NodeJS.Timeout | undefined;
  private warmTimer: NodeJS.Timeout | undefined;
  private polling = false;
  private warmPolling = false;
  private stopped = false;
  private ready = false;

  constructor(private readonly options: CatalogOptions) {
    this.rest = options.rest;
    this.extState = options.extState;
  }

  async start(core: ProtocolCore): Promise<void> {
    this.core = core;
    this.agentList = await this.fetchAgents();
    const root: RootState = { agents: this.agentList, activeSessions: 0 };
    core.createChannel(ROOT_URI, root);
    await this.poll();
    this.ready = true;
    this.pollTimer = setInterval(() => {
      void this.poll().catch((err) => log.warn("poll failed", err instanceof Error ? err.message : err));
    }, this.options.pollMs ?? 5000);
    this.warmTimer = setInterval(() => {
      void this.pollWarm().catch((err) => log.warn("warm poll failed", err instanceof Error ? err.message : err));
    }, this.options.warmPollMs ?? 1500);
    this.pollTimer.unref();
    this.warmTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.warmTimer);
  }

  onChange(listener: () => void): void {
    this.changeListeners.add(listener);
  }

  agents(): AgentInfo[] {
    return this.agentList;
  }

  hasAgent(provider: string): boolean {
    return this.agentList.some((agent) => agent.provider === provider);
  }

  // The AHP session a Hydra session belongs to: its stamp, or "<agent>:/<id>" for one the extension did not create.
  groupOf(hydraId: string): string {
    return this.stamps.get(hydraId) ?? providerSessionUri(this.entries.get(hydraId)?.agentId, hydraId);
  }

  uriFor(hydraId: string): string {
    return this.groupOf(hydraId);
  }

  chatOf(hydraId: string): string {
    return this.chatStamps.get(hydraId)?.chat ?? defaultChatUri(this.groupOf(hydraId));
  }

  sideOf(hydraId: string): SideOrigin | undefined {
    return this.chatStamps.get(hydraId)?.side;
  }

  membersOf(sessionUri: string): string[] {
    return this.groups.get(sessionUri) ?? [];
  }

  // Where a session's files are on this machine; undefined when they live on a remote or federated host.
  localCwdOf(sessionUri: string): string | undefined {
    const lead = this.membersOf(sessionUri)[0];
    return lead && this.isLocal(lead) ? this.entries.get(lead)?.cwd : undefined;
  }

  // When the earliest of a session's Hydra sessions was created.
  startedAt(sessionUri: string): string | undefined {
    const times = this.membersOf(sessionUri)
      .map((id) => this.entries.get(id)?.createdAt)
      .filter((at): at is string => typeof at === "string")
      .sort();
    return times[0];
  }

  changesetsOf(sessionUri: string): Changeset[] | undefined {
    return this.options.changesets && this.localCwdOf(sessionUri) ? changesetsFor(sessionUri) : undefined;
  }

  isDefaultMember(hydraId: string): boolean {
    return this.membersOf(this.groupOf(hydraId))[0] === hydraId;
  }

  // The default chat's Hydra session, which speaks for the AHP session.
  resolve(uri: string): string | undefined {
    return this.groups.get(uri)?.[0];
  }

  resolveChat(chat: string): string | undefined {
    return this.chatToId.get(chat);
  }

  // The AHP session a chat channel belongs to, including a chat still being created.
  sessionUriForChat(chat: string): string {
    const id = this.chatToId.get(chat);
    if (id) {
      return this.groupOf(id);
    }
    return this.pendingChats.get(chat) ?? sessionOfDefaultChat(chat) ?? sessionUri(chatKey(chat));
  }

  flagsFor(hydraId: string): SessionFlags {
    if (this.isLocal(hydraId)) {
      return this.sessionFlags.get(hydraId) ?? NO_FLAGS;
    }
    return this.options.flags?.get(hydraId) ?? NO_FLAGS;
  }

  // Persists a read or archive change and tells root subscribers; returns whether anything changed.
  setFlags(hydraId: string, patch: Partial<SessionFlags>): boolean {
    const changed = this.isLocal(hydraId) ? this.setSessionFlags(hydraId, patch) : (this.options.flags?.set(hydraId, patch) ?? false);
    if (changed) {
      this.reconcile();
    }
    return changed;
  }

  // Federated sessions keep their marks in this host's own file: their extension_state is on the peer, out of this extension's reach.
  private isLocal(hydraId: string): boolean {
    const entry = this.entries.get(hydraId);
    return !isFederatedId(hydraId) && entry?.remote === undefined;
  }

  private setSessionFlags(hydraId: string, patch: Partial<SessionFlags>): boolean {
    const before = this.sessionFlags.get(hydraId) ?? NO_FLAGS;
    const next = { ...before, ...patch };
    if (next.isRead === before.isRead && next.isArchived === before.isArchived) {
      return false;
    }
    this.sessionFlags.set(hydraId, next);
    this.writeFlags(hydraId, next);
    return true;
  }

  // Writes for one session go out in order, so a quick read-then-unread cannot land reversed.
  private writeFlags(hydraId: string, flags: SessionFlags): void {
    const write = (): Promise<void> =>
      flags.isRead || flags.isArchived ? this.extState.set(hydraId, AHP_FLAGS_KEY, flags) : this.extState.delete(hydraId, AHP_FLAGS_KEY);
    const next = (this.flagWrites.get(hydraId) ?? Promise.resolve())
      .then(write)
      .catch((err: unknown) => {
        log.warn(`saving the marks of ${hydraId} failed`, err instanceof Error ? err.message : err);
      });
    this.flagWrites.set(hydraId, next);
    void next.finally(() => {
      if (this.flagWrites.get(hydraId) === next) {
        this.flagWrites.delete(hydraId);
      }
    });
  }

  summaryFor(uri: string): SessionSummary | undefined {
    return this.published.get(uri);
  }

  entry(hydraId: string): HydraSessionEntry | undefined {
    return this.entries.get(hydraId);
  }

  // Every session with a known cwd, for the file scope; remote marks sessions whose files live on a peer.
  fileSessions(): FileSession[] {
    const sessions: FileSession[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.cwd) {
        continue;
      }
      const remote = remoteOwner(entry);
      sessions.push({ id: entry.sessionId, cwd: entry.cwd, ...(remote !== undefined ? { remote } : {}) });
    }
    return sessions;
  }

  sessionForChat(chat: string): FileSession | undefined {
    if (!isChatUri(chat)) {
      return undefined;
    }
    const hydraId = this.resolveChat(chat);
    return hydraId ? this.fileSessions().find((session) => session.id === hydraId) : undefined;
  }

  uriInUse(uri: string): boolean {
    return this.pendingCreations.has(uri) || this.groups.has(uri) || this.published.has(uri);
  }

  chatInUse(chat: string): boolean {
    return this.pendingChats.has(chat) || this.chatToId.has(chat);
  }

  async poll(): Promise<void> {
    if (this.polling || this.stopped) {
      return;
    }
    this.polling = true;
    try {
      const page = await this.rest.listSessions({
        ...(this.cursor !== undefined ? { since: this.cursor } : {}),
        includeNonInteractive: true,
      });
      this.merge(page);
      this.polls += 1;
      if (this.ready && this.polls % (this.options.agentsEveryPolls ?? 12) === 0) {
        await this.refreshAgents();
      }
      await this.lookUpStamps();
      this.reconcile();
    } finally {
      this.polling = false;
    }
  }

  async pollWarm(): Promise<void> {
    if (this.warmPolling || this.polling || this.stopped || !this.ready) {
      return;
    }
    this.warmPolling = true;
    try {
      const page = await this.rest.listSessions({ status: "warm", includeNonInteractive: true });
      const warm = new Set<string>();
      for (const row of page.sessions) {
        if (row.status !== "warm") {
          continue;
        }
        warm.add(row.sessionId);
        this.setEntry(row);
      }
      this.markCold(warm);
      this.reconcile();
    } finally {
      this.warmPolling = false;
    }
  }

  // A session that has had a real turn stays interactive, so a poll response that was in flight before that turn cannot unlist it.
  private setEntry(row: HydraSessionEntry): void {
    const before = this.entries.get(row.sessionId);
    this.entries.set(row.sessionId, before?.interactive === true && row.interactive !== true ? { ...row, interactive: true } : row);
  }

  // Applies Hydra's merge rule; federated rows arrive whole on every response, never as a delta.
  private merge(page: SessionPage): void {
    const seen = new Set<string>();
    const warm = new Set<string>();
    for (const row of page.sessions) {
      seen.add(row.sessionId);
      if (row.status === "warm") {
        warm.add(row.sessionId);
      }
      this.setEntry(row);
    }
    for (const id of page.removed ?? []) {
      this.drop(id);
    }
    for (const [id, entry] of [...this.entries]) {
      if (entry.remote && !seen.has(id)) {
        this.drop(id);
      }
    }
    this.markCold(warm);
    if (typeof page.cursor === "number") {
      this.cursor = page.cursor;
    }
  }

  private markCold(warm: Set<string>): void {
    for (const [id, entry] of this.entries) {
      if (entry.status === "warm" && !entry.remote && !warm.has(id)) {
        this.entries.set(id, { ...entry, status: "cold", busy: false });
      }
    }
  }

  private drop(id: string): void {
    this.entries.delete(id);
    this.options.flags?.forget(id);
    this.sessionFlags.delete(id);
    this.stamps.delete(id);
    this.chatStamps.delete(id);
    this.liveConfigs.delete(id);
    this.lookedUp.delete(id);
    this.watchedAt.delete(id);
  }

  private async lookUpStamps(): Promise<void> {
    const todo = [...this.entries.values()]
      .filter((e) => !e.remote && !isFederatedId(e.sessionId))
      .filter((e) => e.interactive !== false && !this.stamps.has(e.sessionId) && !this.lookedUp.has(e.sessionId))
      .map((e) => e.sessionId);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < todo.length) {
        const id = todo[next++] as string;
        try {
          const state = await this.extState.list(id);
          const value = state[AHP_URI_KEY];
          if (typeof value === "string" && !this.stamps.has(id)) {
            this.stamps.set(id, value);
            const chat = state[AHP_CHAT_KEY] as { chat?: unknown; at?: unknown; side?: unknown } | undefined;
            if (chat && typeof chat.chat === "string") {
              const side = sideOrigin(chat.side);
              this.chatStamps.set(id, { chat: chat.chat, at: typeof chat.at === "number" ? chat.at : 0, ...(side ? { side } : {}) });
            }
          }
          this.loadFlags(id, state[AHP_FLAGS_KEY]);
          this.lookedUp.add(id);
        } catch (err) {
          log.warn(`stamp lookup for ${id} failed`, err instanceof Error ? err.message : err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(STAMP_LOOKUP_CONCURRENCY, todo.length) }, worker));
  }

  // A mark set here before the lookup finished is newer than what the bucket holds; marks from the old file move into the bucket.
  private loadFlags(hydraId: string, stored: unknown): void {
    if (this.sessionFlags.has(hydraId)) {
      return;
    }
    const legacy = this.options.flags?.get(hydraId);
    if (stored && typeof stored === "object") {
      const value = stored as { isRead?: unknown; isArchived?: unknown };
      this.sessionFlags.set(hydraId, { isRead: value.isRead === true, isArchived: value.isArchived === true });
    } else if (legacy && (legacy.isRead || legacy.isArchived)) {
      this.sessionFlags.set(hydraId, legacy);
      this.writeFlags(hydraId, legacy);
    }
    this.options.flags?.forget(hydraId);
  }

  // Hydra's default list shows interactive sessions; the extension adds the ones it created, listing one nobody has prompted
  // yet only while a client has it open.
  isListed(hydraId: string): boolean {
    const entry = this.entries.get(hydraId);
    if (!entry) {
      return false;
    }
    if (!this.stamps.has(hydraId)) {
      return entry.interactive === true && !entry.parentSessionId;
    }
    // Forks and side chats start out non-interactive in Hydra, so a stamped session counts once it has been prompted.
    return entry.interactive === true || this.recentlyWatched(hydraId);
  }

  // VS Code drops and retakes subscriptions in bursts, so an unprompted session outlives its last watcher by a grace.
  private recentlyWatched(hydraId: string): boolean {
    const now = Date.now();
    if (this.core?.hasSubscribers(this.groupOf(hydraId)) || this.core?.hasSubscribers(this.chatOf(hydraId))) {
      this.watchedAt.set(hydraId, now);
      return true;
    }
    return now - (this.watchedAt.get(hydraId) ?? this.startedMs) < (this.options.unpromptedGraceMs ?? UNPROMPTED_GRACE_MS);
  }

  summaries(): SessionSummary[] {
    return [...this.published.values()].sort(
      (a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.resource.localeCompare(b.resource),
    );
  }

  private addedAt(hydraId: string): number {
    return this.chatStamps.get(hydraId)?.at ?? 0;
  }

  private rebuildIndex(): void {
    this.groups.clear();
    this.chatToId.clear();
    const listed = [...this.entries.values()]
      .filter((entry) => this.isListed(entry.sessionId))
      .sort((a, b) => this.addedAt(a.sessionId) - this.addedAt(b.sessionId) || a.sessionId.localeCompare(b.sessionId));
    for (const entry of listed) {
      const uri = this.groupOf(entry.sessionId);
      const members = this.groups.get(uri);
      if (members) {
        members.push(entry.sessionId);
      } else {
        this.groups.set(uri, [entry.sessionId]);
      }
      this.chatToId.set(this.chatOf(entry.sessionId), entry.sessionId);
    }
  }

  // Diffs the listed set against what clients were last told and emits the root notifications.
  private reconcile(): void {
    this.rebuildIndex();
    const next = new Map<string, SessionSummary>();
    for (const [uri, ids] of this.groups) {
      const members: GroupMember[] = ids.map((id) => ({
        entry: this.entries.get(id) as HydraSessionEntry,
        chat: this.chatOf(id),
        flags: this.flagsFor(id),
        ...(this.sideOf(id) ? { origin: sideChatOrigin(this.sideOf(id) as SideOrigin) } : {}),
      }));
      next.set(uri, groupToSummary(members, uri));
    }
    for (const uri of this.pendingCreations) {
      const held = this.published.get(uri);
      if (held && !next.has(uri)) {
        next.set(uri, held);
      }
    }
    const previous = new Map(this.published);
    this.published.clear();
    for (const [uri, summary] of next) {
      this.published.set(uri, summary);
    }
    // Notify after the swap so a client that reacts with listSessions sees the change.
    const announce = this.ready;
    for (const [uri, summary] of next) {
      const before = previous.get(uri);
      if (!before) {
        if (announce) {
          this.core.notify(ROOT_URI, "root/sessionAdded", { channel: ROOT_URI, summary });
        }
        continue;
      }
      const changes = diffSummary(before, summary);
      if (changes && announce) {
        this.core.notify(ROOT_URI, "root/sessionSummaryChanged", { channel: ROOT_URI, session: uri, changes });
      }
    }
    for (const uri of previous.keys()) {
      if (next.has(uri)) {
        continue;
      }
      if (announce) {
        this.core.notify(ROOT_URI, "root/sessionRemoved", { channel: ROOT_URI, session: uri });
      }
      this.forgetChannels(uri, previous.get(uri));
    }
    this.syncRoot();
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  private forgetChannels(uri: string, summary: SessionSummary | undefined): void {
    this.core.removeChannel(uri);
    for (const chat of summary?.chats ?? []) {
      this.core.removeChannel(chat.resource);
    }
    this.core.removeChannel(defaultChatUri(uri));
  }

  private syncRoot(): void {
    const active = [...this.entries.values()].filter((e) => e.status === "warm").length;
    const root = this.core.store.state(ROOT_URI) as RootState | undefined;
    if (root && root.activeSessions !== active) {
      this.core.publish(ROOT_URI, action({ type: "root/activeSessionsChanged", activeSessions: active }));
    }
  }

  private async refreshAgents(): Promise<void> {
    await this.loadAgents();
    this.republishAgents();
  }

  private async fetchAgents(): Promise<AgentInfo[]> {
    await this.loadAgents();
    return this.buildAgents();
  }

  // Hydra reloads sessionDefaults while it runs, so they are read again with every agent refresh.
  private async loadAgents(): Promise<void> {
    const [agents, config] = await Promise.all([
      this.rest.agents(),
      this.rest.config().catch((err: unknown) => {
        log.debug("could not read Hydra's config", err instanceof Error ? err.message : err);
        return undefined;
      }),
    ]);
    this.rawAgents = agents.agents;
    if (config?.sessionDefaults) {
      this.sessionDefaults = config.sessionDefaults;
    }
  }

  private buildAgents(): AgentInfo[] {
    return this.rawAgents
      .filter((agent) => agent.installed !== "no")
      .map((agent) => toAgentInfo(agent, defaultFirst(this.options.models?.get(agent.id) ?? [], this.defaultModelOf(agent))));
  }

  // VS Code picks the first model for a new session, so the one Hydra would seed it with goes first.
  private defaultModelOf(agent: HydraAgent): string | undefined {
    for (const id of agent.extendsChain ?? [agent.id]) {
      const model = this.sessionDefaults[id]?.model;
      if (model) {
        return model;
      }
    }
    return undefined;
  }

  private republishAgents(): void {
    const agents = this.buildAgents();
    if (JSON.stringify(agents) === JSON.stringify(this.agentList)) {
      return;
    }
    this.agentList = agents;
    this.core.publish(ROOT_URI, action({ type: "root/agentsChanged", agents }));
  }

  // A session of an agent is the only place Hydra reveals its models; remember them for the model picker.
  noteModels(agentId: string | undefined, advertised: unknown): void {
    if (!agentId || !this.options.models || !Array.isArray(advertised)) {
      return;
    }
    const models: KnownModel[] = advertised.flatMap((item) => {
      const entry = item as { modelId?: unknown; name?: unknown };
      return typeof entry.modelId === "string"
        ? [{ id: entry.modelId, name: typeof entry.name === "string" && entry.name !== "" ? entry.name : entry.modelId }]
        : [];
    });
    if (this.options.models.set(agentId, models) && this.ready) {
      this.republishAgents();
    }
  }

  // The config options each attached Hydra session last reported; the session channel shows its default chat's.
  private readonly liveConfigs = new Map<string, ConfigOption[]>();

  // Returns whether this session's options changed; the agent's last-seen set is kept for sessions not yet created.
  noteConfig(hydraId: string, options: readonly ConfigOption[]): boolean {
    if (options.length === 0) {
      return false;
    }
    const agentId = this.entries.get(hydraId)?.agentId;
    if (agentId) {
      this.options.configs?.set(agentId, options);
    }
    if (JSON.stringify(this.liveConfigs.get(hydraId)) === JSON.stringify(options)) {
      return false;
    }
    this.liveConfigs.set(hydraId, [...options]);
    return true;
  }

  configOptionsFor(hydraId: string): ConfigOption[] {
    return this.liveConfigs.get(hydraId) ?? [];
  }

  knownConfigFor(agentId: string | undefined): ConfigOption[] {
    return agentId ? this.options.configs?.get(agentId) ?? [] : [];
  }

  // The settings of a session: its default chat's live options.
  configStateFor(sessionUri: string): SessionConfigState | undefined {
    const lead = this.membersOf(sessionUri)[0];
    return lead ? toConfigState(this.configOptionsFor(lead)) : undefined;
  }

  // Paging is keyset based (newest first) so a concurrent change never repeats or skips a row.
  list(limit: number | undefined, cursor: string | undefined): { items: SessionSummary[]; nextCursor?: string } {
    const size = Math.min(Math.max(Math.trunc(limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    let all = this.summaries();
    if (cursor) {
      const key = decodeCursor(cursor);
      all = all.filter((s) => s.modifiedAt < key.modifiedAt || (s.modifiedAt === key.modifiedAt && s.resource > key.resource));
    }
    const items = all.slice(0, size);
    const last = items[items.length - 1];
    if (all.length > size && last) {
      return { items, nextCursor: encodeCursor(last) };
    }
    return { items };
  }

  // Registers a session this extension is creating so the first poll cannot hide or duplicate it.
  beginCreation(uri: string, summary: SessionSummary): void {
    this.pendingCreations.add(uri);
    this.pendingChats.set(defaultChatUri(uri), uri);
    this.published.set(uri, summary);
    this.core.notify(ROOT_URI, "root/sessionAdded", { channel: ROOT_URI, summary });
  }

  failCreation(uri: string): void {
    this.pendingCreations.delete(uri);
    this.pendingChats.delete(defaultChatUri(uri));
    this.published.delete(uri);
    this.core.notify(ROOT_URI, "root/sessionRemoved", { channel: ROOT_URI, session: uri });
  }

  claim(hydraId: string, uri: string, entry: HydraSessionEntry): void {
    this.stamps.set(hydraId, uri);
    this.watchedAt.set(hydraId, Date.now());
    this.lookedUp.add(hydraId);
    this.entries.set(hydraId, entry);
    this.pendingCreations.delete(uri);
    this.pendingChats.delete(defaultChatUri(uri));
    this.reconcile();
  }

  beginChatCreation(chat: string, sessionUri: string): void {
    this.pendingChats.set(chat, sessionUri);
  }

  failChatCreation(chat: string): void {
    this.pendingChats.delete(chat);
  }

  // Adds a Hydra session to an existing AHP session as one more chat.
  claimChat(hydraId: string, sessionUri: string, chat: string, at: number, entry: HydraSessionEntry, side?: SideOrigin): void {
    this.stamps.set(hydraId, sessionUri);
    this.watchedAt.set(hydraId, Date.now());
    this.chatStamps.set(hydraId, { chat, at, ...(side ? { side } : {}) });
    this.lookedUp.add(hydraId);
    this.entries.set(hydraId, entry);
    this.pendingChats.delete(chat);
    this.reconcile();
  }

  remove(hydraId: string): void {
    this.drop(hydraId);
    this.reconcile();
  }
}

export interface SideOrigin {
  chat: string;
  turnId: string;
  selection?: { text: string; responsePartId?: string };
}

function sideOrigin(value: unknown): SideOrigin | undefined {
  const raw = value as Partial<SideOrigin> | null | undefined;
  if (!raw || typeof raw.chat !== "string" || typeof raw.turnId !== "string") {
    return undefined;
  }
  return { chat: raw.chat, turnId: raw.turnId, ...(raw.selection ? { selection: raw.selection } : {}) };
}

export function sideChatOrigin(side: SideOrigin): Record<string, unknown> {
  return { kind: "sideChat", chat: side.chat, turnId: side.turnId, ...(side.selection ? { selection: side.selection } : {}) };
}

function defaultFirst(models: readonly KnownModel[], model: string | undefined): readonly KnownModel[] {
  if (!model) {
    return models;
  }
  const known = models.find((entry) => entry.id === model) ?? { id: model, name: model };
  return [known, ...models.filter((entry) => entry.id !== model)];
}

function toAgentInfo(agent: HydraAgent, models: readonly KnownModel[]): AgentInfo {
  return {
    provider: agent.id,
    displayName: agent.name || agent.id,
    description: agent.description ?? "",
    models: models.map((model) => ({ id: model.id, provider: agent.id, name: model.name })),
    capabilities: { multipleChats: { fork: true, sideChat: true } },
  };
}

function diffSummary(before: SessionSummary, after: SessionSummary): Partial<SessionSummary> | undefined {
  const changes: Json = {};
  const a = after as unknown as Json;
  const b = before as unknown as Json;
  for (const key of Object.keys(a)) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      changes[key] = a[key];
    }
  }
  return Object.keys(changes).length > 0 ? (changes as Partial<SessionSummary>) : undefined;
}

function encodeCursor(summary: SessionSummary): string {
  return Buffer.from(JSON.stringify({ modifiedAt: summary.modifiedAt, resource: summary.resource })).toString("base64url");
}

function decodeCursor(cursor: string): { modifiedAt: string; resource: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { modifiedAt?: unknown; resource?: unknown };
    if (typeof parsed.modifiedAt === "string" && typeof parsed.resource === "string") {
      return { modifiedAt: parsed.modifiedAt, resource: parsed.resource };
    }
  } catch {
    void 0;
  }
  throw new Error("invalid cursor");
}
