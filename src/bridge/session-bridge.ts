import type { ChatState, SessionState } from "@microsoft/agent-host-protocol";
import type { HydraSessionEntry, HydraRest } from "../hydra/rest.js";
import type { HydraSessions, QueueEvent, SessionListener } from "../hydra/sessions.js";
import type { ProtocolCore } from "../protocol/core.js";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import { logger } from "../util/log.js";
import type { Catalog } from "./catalog.js";
import { ChatMapper, type Frame } from "./mapping.js";
import { emptyChat, frameFromEntry, oldestSeq, reduceChat, turnsFromFrames } from "./replay.js";
import { STATUS_IDLE, summaryToSessionState } from "./summary.js";
import { bag, text, type Json } from "./turns.js";

const log = logger("bridge");

const SESSION_NOT_FOUND = -32001;
const PAGE_TURNS = 10;
const INITIAL_TURNS = 20;

type Pending =
  | { kind: "frame"; frame: Frame }
  | { kind: "queue"; event: QueueEvent; params: Json }
  | { kind: "closed" };

export interface BridgeDeps {
  hydraId: string;
  sessionUri: string;
  chatUri: string;
  core: ProtocolCore;
  catalog: Catalog;
  rest: HydraRest;
  sessions: HydraSessions;
}

const action = (value: Json) => value as never;

function toRpc(err: unknown): RpcError {
  if (err instanceof RpcError) {
    return err;
  }
  return new RpcError(ErrorCodes.InternalError, err instanceof Error ? err.message : String(err));
}

function maxSeq(frames: readonly Frame[]): number | undefined {
  let highest: number | undefined;
  for (const frame of frames) {
    if (frame.seq !== undefined && (highest === undefined || frame.seq > highest)) {
      highest = frame.seq;
    }
  }
  return highest;
}

// One per subscribed session: attaches to Hydra lazily, keeps the chat channel in step and detaches explicitly.
//
// A warm session is attached with historyPolicy pending_only and its history read through history/page. Hydra's own
// replay can interleave live frames ahead of the replayed ones (seen when attaching mid-stream), and its coalescing
// reorders seq values, so neither order nor seq can tell a late replay frame from a fresh live one. The page read is
// ordered and its highest seq is a sound line between "already read" and "live".
export class SessionBridge implements SessionListener {
  private mapper = new ChatMapper();
  private attached = false;
  private mode: "live" | "viewer" | undefined;
  private unlisten: (() => void) | undefined;
  private buffering: Pending[] | undefined;
  private highWater: number | undefined;
  private sawClosed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private fetching: Promise<void> | undefined;
  private disposed = false;
  commands: unknown;

  constructor(private readonly deps: BridgeDeps) {}

  get hydraId(): string {
    return this.deps.hydraId;
  }

  get chat(): string {
    return this.deps.chatUri;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  get isLive(): boolean {
    return this.attached && this.mode === "live";
  }

  get chatMapper(): ChatMapper {
    return this.mapper;
  }

  attach(): Promise<void> {
    return this.serial(() => this.doAttach(false));
  }

  // Switches a read-only viewer attach (cold session) to a live one before anything writes.
  ensureLive(): Promise<void> {
    return this.serial(() => this.doAttach(true));
  }

  detach(): Promise<void> {
    return this.serial(() => this.doDetach());
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.serial(async () => {
      await this.release();
      this.deps.core.removeChannel(this.deps.chatUri);
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  update(frame: Frame): void {
    this.deliver({ kind: "frame", frame });
  }

  queue(event: QueueEvent, params: Json): void {
    this.deliver({ kind: "queue", event, params });
  }

  closed(): void {
    this.deliver({ kind: "closed" });
  }

  private deliver(event: Pending): void {
    if (this.buffering) {
      this.buffering.push(event);
      return;
    }
    this.handle(event, (actions) => this.publish(actions));
  }

  private entry(): HydraSessionEntry | undefined {
    return this.deps.catalog.entry(this.deps.hydraId);
  }

  private ensureSessionChannel(): void {
    const { core, catalog, sessionUri } = this.deps;
    if (core.store.has(sessionUri)) {
      return;
    }
    const summary = catalog.summaryFor(sessionUri);
    if (!summary) {
      throw new RpcError(SESSION_NOT_FOUND, "Session not found");
    }
    core.createChannel(sessionUri, summaryToSessionState(summary, "ready"));
  }

  private async doAttach(forceLive: boolean): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.attached && !(forceLive && this.mode === "viewer")) {
      return;
    }
    if (this.attached) {
      await this.release();
    }
    const { core, rest, sessions, hydraId, chatUri } = this.deps;
    this.ensureSessionChannel();
    const viewer = !forceLive && this.entry()?.status === "cold";
    const pending: Pending[] = [];
    this.buffering = pending;
    this.sawClosed = false;
    this.unlisten = sessions.listen(hydraId, this);
    let history: Frame[];
    let cursor: string | undefined;
    let meta: Json;
    try {
      if (viewer) {
        const result = await sessions.attach(hydraId, { readonly: true, history: "full" });
        meta = result.meta;
        history = pending.splice(0).flatMap((event) => (event.kind === "frame" ? [event.frame] : []));
        const first = oldestSeq(history);
        cursor = first === undefined ? undefined : await this.olderThan(first);
        this.highWater = undefined;
      } else {
        const result = await sessions.attach(hydraId, { readonly: false, history: "pending_only" });
        meta = result.meta;
        const page = await rest.historyPage(hydraId, Number.MAX_SAFE_INTEGER, INITIAL_TURNS);
        history = page.entries.map(frameFromEntry).filter((frame): frame is Frame => frame !== undefined);
        const first = oldestSeq(history);
        cursor = page.hasMore && first !== undefined ? String(first) : undefined;
        this.highWater = maxSeq(history);
      }
    } catch (err) {
      this.unlisten?.();
      this.unlisten = undefined;
      this.buffering = undefined;
      throw toRpc(err);
    }

    // Everything from here to the end of the method is synchronous, so no live frame can slip between the history and the join.
    const held = core.store.state(chatUri) as ChatState | undefined;
    const subscribed = core.hasSubscribers(chatUri) && held !== undefined;
    this.mapper = new ChatMapper();
    const produced: Json[] = [];
    const collect = (actions: Json[]): void => {
      produced.push(...actions);
    };
    for (const frame of history) {
      collect(this.mapper.map(frame));
    }
    this.buffering = undefined;
    for (const event of pending) {
      this.handle(event, collect);
    }
    this.highWater = undefined;
    collect(this.mapper.syncQueue(meta.queue));
    this.midTurn(meta, collect);

    const summary = this.deps.catalog.summaryFor(this.deps.sessionUri);
    const base = held ?? emptyChat(chatUri, summary?.title ?? "", summary?.modifiedAt ?? new Date(0).toISOString(), STATUS_IDLE);
    const plan = this.reconcilePlan(base, produced, cursor);
    if (subscribed) {
      this.publish(plan);
    } else {
      core.createChannel(chatUri, reduceChat(base, plan));
    }
    this.attached = !this.sawClosed;
    this.mode = viewer ? "viewer" : "live";
    this.syncChatSummary();
  }

  // The attach-mid-turn rule: a busy session with no start event seen still gets an active turn.
  private midTurn(meta: Json, sink: (actions: Json[]) => void): void {
    const busy = meta.busy === true;
    if (busy && !this.mapper.activeTurnId) {
      const startedAt = typeof meta.turnStartedAt === "number" ? meta.turnStartedAt : undefined;
      sink(this.mapper.openFromBusy(startedAt ?? (this.mapper.lastFrameAt || Date.now())));
    } else if (!busy && this.mapper.activeTurnId) {
      sink(this.mapper.closeActive("cancelled"));
    }
    const turnId = this.mapper.activeTurnId;
    const usage = bag(meta.currentUsage);
    if (turnId && (usage.used !== undefined || usage.costAmount !== undefined)) {
      sink([
        this.mapper.usageAction(turnId, {
          used: usage.used,
          size: usage.size,
          ...(typeof usage.costAmount === "number" ? { cost: { amount: usage.costAmount, currency: usage.costCurrency } } : {}),
        }),
      ]);
    }
  }

  // Turns the freshly mapped history into the actions that bring the held chat state to it, keeping older turns the client already has.
  private reconcilePlan(held: ChatState, produced: Json[], cursor: string | undefined): Json[] {
    const plan: Json[] = [];
    for (const queued of held.queuedMessages ?? []) {
      plan.push({ type: "chat/pendingMessageRemoved", kind: "queued", id: queued.id });
    }
    if (held.steeringMessage) {
      plan.push({ type: "chat/pendingMessageRemoved", kind: "steering", id: held.steeringMessage.id });
    }
    const heldIds = [...held.turns.map((turn) => turn.id), ...(held.activeTurn ? [held.activeTurn.id] : [])];
    const startIndex = new Map<string, number>();
    produced.forEach((next, index) => {
      if (next.type === "chat/turnStarted" && typeof next.turnId === "string" && !startIndex.has(next.turnId)) {
        startIndex.set(next.turnId, index);
      }
    });
    const overlap = heldIds.findIndex((id) => startIndex.has(id));
    let keptOlder = 0;
    let from = 0;
    if (heldIds.length > 0) {
      if (overlap < 0) {
        plan.push({ type: "chat/truncated" });
      } else {
        keptOlder = overlap;
        from = startIndex.get(heldIds[overlap] as string) ?? 0;
        plan.push(overlap === 0 ? { type: "chat/truncated" } : { type: "chat/truncated", turnId: heldIds[overlap - 1] });
      }
    }
    plan.push(...produced.slice(from));
    const nextCursor = keptOlder > 0 ? held.turnsNextCursor : cursor;
    if (nextCursor !== undefined && (keptOlder === 0 || nextCursor !== held.turnsNextCursor)) {
      plan.push({ type: "chat/turnsLoaded", turns: [], turnsNextCursor: nextCursor });
    }
    return plan;
  }

  private olderThan(seq: number): Promise<string | undefined> {
    return this.deps.rest
      .historyPage(this.deps.hydraId, seq, 1)
      .then((page) => (page.entries.length > 0 ? String(seq) : undefined))
      .catch(() => undefined);
  }

  private handle(event: Pending, sink: (actions: Json[]) => void): void {
    if (event.kind === "queue") {
      const actions =
        event.event === "added"
          ? this.mapper.queueAdded(event.params)
          : event.event === "updated"
            ? this.mapper.queueUpdated(event.params)
            : this.mapper.queueRemoved(event.params);
      sink(actions);
      return;
    }
    if (event.kind === "closed") {
      this.attached = false;
      this.sawClosed = true;
      this.unlisten?.();
      this.unlisten = undefined;
      sink(this.mapper.closeActive("cancelled"));
      return;
    }
    const { frame } = event;
    if (frame.seq !== undefined && this.highWater !== undefined && frame.seq <= this.highWater) {
      return;
    }
    const kind = text(frame.update.sessionUpdate);
    if (kind === "session_info_update") {
      this.applyTitle(text(frame.update.title));
      return;
    }
    if (kind === "available_commands_update") {
      this.commands = frame.update.availableCommands;
      return;
    }
    sink(this.mapper.map(frame));
  }

  private applyTitle(title: string | undefined): void {
    const { core, sessionUri } = this.deps;
    const state = core.store.state(sessionUri) as SessionState | undefined;
    if (!title || !state || state.title === title) {
      return;
    }
    core.publish(sessionUri, action({ type: "session/titleChanged", title }));
  }

  private publish(actions: Json[]): void {
    if (actions.length === 0) {
      return;
    }
    const { core, chatUri } = this.deps;
    if (!core.store.has(chatUri)) {
      return;
    }
    for (const next of actions) {
      core.publish(chatUri, action(next));
    }
    this.syncChatSummary();
  }

  // Mirrors the chat's status and modification time into the session's chat catalog entry.
  private syncChatSummary(): void {
    const { core, chatUri, sessionUri } = this.deps;
    const chat = core.store.state(chatUri) as ChatState | undefined;
    const session = core.store.state(sessionUri) as SessionState | undefined;
    const held = session?.chats.find((entry) => entry.resource === chatUri);
    if (!chat || !held) {
      return;
    }
    const changes: Json = {};
    if (held.status !== chat.status) {
      changes.status = chat.status;
    }
    if (held.modifiedAt !== chat.modifiedAt) {
      changes.modifiedAt = chat.modifiedAt;
    }
    if (Object.keys(changes).length > 0) {
      core.publish(sessionUri, action({ type: "session/chatUpdated", chat: chatUri, changes }));
    }
  }

  private async doDetach(): Promise<void> {
    if (!this.attached || this.deps.core.hasSubscribers(this.deps.chatUri)) {
      return;
    }
    await this.release();
  }

  // Explicit detach: closing the socket would not trigger Hydra's reaping path.
  private async release(): Promise<void> {
    this.unlisten?.();
    this.unlisten = undefined;
    if (this.attached) {
      this.attached = false;
      await this.deps.sessions.detach(this.deps.hydraId);
    }
  }

  // Re-attaches a dormant bridge when its session came back, and upgrades a viewer once the session is warm.
  onCatalogChange(): void {
    if (this.disposed || this.buffering) {
      return;
    }
    const { core, chatUri } = this.deps;
    if (!core.hasSubscribers(chatUri)) {
      return;
    }
    const warm = this.entry()?.status === "warm";
    if (warm && (!this.attached || this.mode === "viewer")) {
      this.ensureLive().catch((err) => log.warn(`re-attach ${this.deps.hydraId} failed`, toRpc(err).message));
    }
  }

  // Serves fetchTurns: pages older turns in through chat/turnsLoaded.
  fetchTurns(cursor: string | undefined): Promise<void> {
    const state = this.deps.core.store.state(this.deps.chatUri) as ChatState | undefined;
    if (!state) {
      throw new RpcError(SESSION_NOT_FOUND, "Chat not found");
    }
    const held = state.turnsNextCursor;
    if (cursor !== undefined && cursor !== held) {
      throw new RpcError(ErrorCodes.InvalidParams, "unrecognised cursor");
    }
    if (held === undefined) {
      return Promise.resolve();
    }
    if (!this.fetching) {
      this.fetching = this.loadPage(held).finally(() => {
        this.fetching = undefined;
      });
    }
    return this.fetching;
  }

  private async loadPage(held: string): Promise<void> {
    const { core, rest, hydraId, chatUri } = this.deps;
    let page;
    try {
      page = await rest.historyPage(hydraId, Number(held), PAGE_TURNS);
    } catch (err) {
      throw toRpc(err);
    }
    const state = core.store.state(chatUri) as ChatState | undefined;
    if (!state || state.turnsNextCursor !== held) {
      return;
    }
    const frames = page.entries.map(frameFromEntry).filter((frame): frame is Frame => frame !== undefined);
    const blank = emptyChat(chatUri, state.title, state.modifiedAt, STATUS_IDLE);
    const turns = turnsFromFrames(frames, blank);
    const oldest = oldestSeq(frames);
    const next = page.hasMore && oldest !== undefined ? String(oldest) : undefined;
    core.publish(chatUri, action({ type: "chat/turnsLoaded", turns, ...(next !== undefined ? { turnsNextCursor: next } : {}) }));
  }
}
