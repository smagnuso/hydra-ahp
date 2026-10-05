import type { AgentInfo, RootState, SessionSummary } from "@microsoft/agent-host-protocol";
import { ROOT_URI } from "../protocol/channels.js";
import type { ProtocolCore } from "../protocol/core.js";
import type { ExtensionState } from "../hydra/ext-state.js";
import type { HydraAgent, HydraRest, HydraSessionEntry, SessionPage } from "../hydra/rest.js";
import { logger } from "../util/log.js";
import type { FileSession } from "../files/service.js";
import { chatKey, chatUri, isChatUri, isFederatedId, sessionKey, sessionUri } from "./ids.js";
import { entryToSummary } from "./summary.js";

const log = logger("catalog");

export const AHP_URI_KEY = "ahpUri";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const STAMP_LOOKUP_CONCURRENCY = 8;

export interface CatalogOptions {
  rest: HydraRest;
  extState: ExtensionState;
  pollMs?: number;
  warmPollMs?: number;
  agentsEveryPolls?: number;
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

// Mirrors Hydra's session list into the AHP root channel and answers listSessions from it.
export class Catalog {
  private core!: ProtocolCore;
  private readonly rest: HydraRest;
  private readonly extState: ExtensionState;
  private readonly entries = new Map<string, HydraSessionEntry>();
  private readonly stamps = new Map<string, string>();
  private readonly uriToId = new Map<string, string>();
  private readonly lookedUp = new Set<string>();
  private readonly published = new Map<string, SessionSummary>();
  private readonly pendingCreations = new Set<string>();
  private cursor: number | undefined;
  private polls = 0;
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

  agents(): AgentInfo[] {
    return this.agentList;
  }

  hasAgent(provider: string): boolean {
    return this.agentList.some((agent) => agent.provider === provider);
  }

  uriFor(hydraId: string): string {
    return this.stamps.get(hydraId) ?? sessionUri(hydraId);
  }

  resolve(uri: string): string | undefined {
    const stamped = this.uriToId.get(uri);
    if (stamped) {
      return stamped;
    }
    const id = sessionKey(uri);
    if (this.stamps.has(id)) {
      return undefined;
    }
    return this.isListed(id) ? id : undefined;
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
    const hydraId = this.resolve(sessionUri(chatKey(chat)));
    return hydraId ? this.fileSessions().find((session) => session.id === hydraId) : undefined;
  }

  uriInUse(uri: string): boolean {
    return this.pendingCreations.has(uri) || this.uriToId.has(uri) || this.published.has(uri);
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
        this.entries.set(row.sessionId, row);
      }
      this.markCold(warm);
      this.reconcile();
    } finally {
      this.warmPolling = false;
    }
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
      this.entries.set(row.sessionId, row);
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
    const uri = this.stamps.get(id);
    this.stamps.delete(id);
    this.lookedUp.delete(id);
    if (uri) {
      this.uriToId.delete(uri);
    }
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
          const value = await this.extState.get<string>(id, AHP_URI_KEY);
          if (typeof value === "string" && !this.stamps.has(id)) {
            this.stamps.set(id, value);
            this.uriToId.set(value, id);
          }
          this.lookedUp.add(id);
        } catch (err) {
          log.warn(`stamp lookup for ${id} failed`, err instanceof Error ? err.message : err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(STAMP_LOOKUP_CONCURRENCY, todo.length) }, worker));
  }

  // Hydra's default list shows interactive sessions; the extension adds the ones it created.
  isListed(hydraId: string): boolean {
    const entry = this.entries.get(hydraId);
    if (!entry) {
      return false;
    }
    if (this.stamps.has(hydraId)) {
      return true;
    }
    return entry.interactive === true && !entry.parentSessionId;
  }

  summaries(): SessionSummary[] {
    return [...this.published.values()].sort(
      (a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.resource.localeCompare(b.resource),
    );
  }

  // Diffs the listed set against what clients were last told and emits the root notifications.
  private reconcile(): void {
    const next = new Map<string, SessionSummary>();
    const owners = new Map<string, string>();
    for (const [id, entry] of this.entries) {
      if (!this.isListed(id)) {
        continue;
      }
      const uri = this.uriFor(id);
      next.set(uri, entryToSummary(entry, uri));
      owners.set(uri, id);
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
      this.forgetChannels(uri);
    }
    this.syncRoot();
  }

  private forgetChannels(uri: string): void {
    this.core.removeChannel(uri);
    this.core.removeChannel(chatUri(sessionKey(uri)));
  }

  private syncRoot(): void {
    const active = [...this.entries.values()].filter((e) => e.status === "warm").length;
    const root = this.core.store.state(ROOT_URI) as RootState | undefined;
    if (root && root.activeSessions !== active) {
      this.core.publish(ROOT_URI, action({ type: "root/activeSessionsChanged", activeSessions: active }));
    }
  }

  private async refreshAgents(): Promise<void> {
    const agents = await this.fetchAgents();
    if (JSON.stringify(agents) === JSON.stringify(this.agentList)) {
      return;
    }
    this.agentList = agents;
    this.core.publish(ROOT_URI, action({ type: "root/agentsChanged", agents }));
  }

  private async fetchAgents(): Promise<AgentInfo[]> {
    const { agents } = await this.rest.agents();
    return agents.filter((agent) => agent.installed !== "no").map(toAgentInfo);
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
    this.published.set(uri, summary);
    this.core.notify(ROOT_URI, "root/sessionAdded", { channel: ROOT_URI, summary });
  }

  failCreation(uri: string): void {
    this.pendingCreations.delete(uri);
    this.published.delete(uri);
    this.core.notify(ROOT_URI, "root/sessionRemoved", { channel: ROOT_URI, session: uri });
  }

  claim(hydraId: string, uri: string, entry: HydraSessionEntry): void {
    this.stamps.set(hydraId, uri);
    this.uriToId.set(uri, hydraId);
    this.lookedUp.add(hydraId);
    this.entries.set(hydraId, entry);
    this.pendingCreations.delete(uri);
    this.reconcile();
  }

  remove(hydraId: string): void {
    this.drop(hydraId);
    this.reconcile();
  }
}

function toAgentInfo(agent: HydraAgent): AgentInfo {
  return {
    provider: agent.id,
    displayName: agent.name || agent.id,
    description: agent.description ?? "",
    models: [],
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
