import type { ChatState, SessionState, StateAction, ToolCallState } from "@microsoft/agent-host-protocol";
import { isFederatedId } from "./ids.js";
import type { EditContentStore } from "./edit-content.js";
import type { HydraSessionEntry, HydraRest } from "../hydra/rest.js";
import type { HydraSessions, QueueEvent, SessionListener, SteeringResult } from "../hydra/sessions.js";
import type { ActionDecision } from "../protocol/backend.js";
import type { ProtocolCore } from "../protocol/core.js";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import { logger } from "../util/log.js";
import { sideChatOrigin, type Catalog } from "./catalog.js";
import { ChatMapper, withModel, type Frame } from "./mapping.js";
import { UnsupportedContent, chooseOption, confirmationOptions, isApproval, promptCapabilities, toAcpPrompt } from "./prompt.js";
import { optionIdOf, parseConfigOptions, type ConfigOption } from "./config.js";
import { emptyChat, frameFromEntry, oldestSeq, reduceChat, turnsFromFrames } from "./replay.js";
import { STATUS_IDLE, STATUS_IS_ARCHIVED, STATUS_IS_READ, summaryToSessionState, withFlagBits } from "./summary.js";
import { HYDRA_META, bag, text, type Json } from "./turns.js";

const log = logger("bridge");

const SESSION_NOT_FOUND = -32001;
const PAGE_TURNS = 10;
const INITIAL_TURNS = 20;
// How long a cancel waits for the agent to act on the permissions it answered before stopping the turn.
const SETTLE_WAIT_MS = 500;
const ECHO_WAIT_MS = 5_000;
const STEER_RETRY_MS = 500;
// Events held while a steer is in flight are let through after this even if Hydra never answers it.
const STEER_HOLD_MS = 5_000;

// A prompt this bridge sent to Hydra. Hydra never echoes its own prompt_received or turn_complete to the sender.
interface OwnEntry {
  kind: "turn" | "queued" | "steer";
  message: Json;
  prompt: Json[];
  // The AHP turn id once the entry runs.
  turnId?: string;
  // The AHP queued or steering message id the entry stands for.
  pendingId?: string;
  messageId?: string;
  started: boolean;
  cancelling: boolean;
  named: Promise<string>;
  name(messageId: string): void;
}

interface Parked {
  turnId: string;
  options: Json[];
  answer(result: unknown): void;
  abstain(): void;
  // Set while a fresh request waits out the delay before clients see it.
  held?: NodeJS.Timeout;
}

interface HeldSteer {
  id: string;
  message: Json;
  prompt: Json[];
  inFlight: boolean;
  triedTurn?: string;
  triedAt?: number;
}

type Pending =
  | { kind: "frame"; frame: Frame }
  | { kind: "queue"; event: QueueEvent; params: Json }
  | { kind: "closed" }
  | { kind: "permission"; params: Json; resolve(result: unknown): void; reject(err: Error): void }
  | { kind: "settled"; entry: OwnEntry; result: unknown; error: Error | undefined };

const ACCEPT: ActionDecision = { accept: true };

function refuse(reason: string): ActionDecision {
  return { accept: false, reason };
}

function abstention(): RpcError {
  return new RpcError(ErrorCodes.MethodNotFound, "no AHP client is answering this permission request");
}

function ownEntry(fields: Pick<OwnEntry, "kind" | "message" | "prompt"> & Partial<OwnEntry>): OwnEntry {
  let name: (messageId: string) => void = () => undefined;
  const named = new Promise<string>((resolve) => {
    name = resolve;
  });
  return { started: false, cancelling: false, ...fields, named, name };
}

function waitFor<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface BridgeDeps {
  hydraId: string;
  sessionUri: string;
  chatUri: string;
  core: ProtocolCore;
  catalog: Catalog;
  rest: HydraRest;
  sessions: HydraSessions;
  permissionDelayMs?: number;
  edits?: EditContentStore;
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
  private mapper: ChatMapper;
  private attached = false;
  private mode: "live" | "viewer" | undefined;
  private unlisten: (() => void) | undefined;
  private buffering: Pending[] | undefined;
  // Hydra's events while our own steer is in flight: the agent's answer can come before Hydra's reply, so it waits for the split.
  private steerHold: { events: Pending[]; timer: NodeJS.Timeout } | undefined;
  private highWater: number | undefined;
  private sawClosed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private fetching: Promise<void> | undefined;
  private disposed = false;
  private clientId: string | undefined;
  private meta: Json = {};
  private model: string | undefined;
  private readonly sends: OwnEntry[] = [];
  private readonly own = new Map<string, OwnEntry>();
  private readonly queuedEntries = new Map<string, OwnEntry>();
  private readonly parked = new Map<string, Parked>();
  private readonly settling = new Map<string, () => void>();
  // Resolved by another client with no verdict on the wire; the call's next update tells which way it went.
  private readonly unresolved = new Map<string, Parked>();
  private steer: HeldSteer | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  // Work an accepted write still owes Hydra; later writes wait for it.
  private followUp: Promise<void> | undefined;
  // Set while the host itself starts a turn, which needs no subscribed client.
  private headless = false;
  commands: unknown;

  constructor(private readonly deps: BridgeDeps) {
    this.mapper = this.newMapper();
  }

  private newMapper(): ChatMapper {
    const store = this.deps.edits;
    return new ChatMapper(store ? { edits: { chatUri: this.deps.chatUri, put: (uri, text) => store.put(uri, text) } } : {});
  }

  get hydraId(): string {
    return this.deps.hydraId;
  }

  get chat(): string {
    return this.deps.chatUri;
  }

  get session(): string {
    return this.deps.sessionUri;
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
    this.releaseSteerHold();
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

  permission(params: Json): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.deliver({ kind: "permission", params, resolve, reject });
    });
  }

  private deliver(event: Pending): void {
    if (this.buffering) {
      this.buffering.push(event);
      return;
    }
    if (this.steerHold) {
      this.steerHold.events.push(event);
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
    core.createChannel(sessionUri, summaryToSessionState(summary, "ready", catalog.configStateFor(sessionUri), catalog.changesetsOf(sessionUri)));
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
    if (!core.store.has(this.deps.sessionUri) && !this.deps.catalog.summaryFor(this.deps.sessionUri)) {
      throw new RpcError(SESSION_NOT_FOUND, "Session not found");
    }
    const own = this.entry();
    // A fork nobody has attached yet only gets its history when its agent loads it, which a read-only viewer never triggers.
    const pristineFork = own?.forkedFromSessionId !== undefined && !own.upstreamSessionId;
    const viewer = !forceLive && own?.status === "cold" && !pristineFork;
    const pending: Pending[] = [];
    this.buffering = pending;
    this.sawClosed = false;
    this.unlisten = sessions.listen(hydraId, this);
    let history: Frame[];
    let cursor: string | undefined;
    let meta: Json;
    let configOptions: unknown;
    let joined = false;
    try {
      if (viewer) {
        const result = await sessions.attach(hydraId, { readonly: true, history: "full" });
        joined = true;
        meta = result.meta;
        configOptions = result.configOptions;
        this.clientId = undefined;
        history = pending.splice(0).flatMap((event) => (event.kind === "frame" ? [event.frame] : []));
        const first = oldestSeq(history);
        cursor = first === undefined ? undefined : await this.olderThan(first);
        this.highWater = undefined;
      } else {
        const result = await sessions.attach(hydraId, { readonly: false, history: "pending_only" });
        joined = true;
        meta = result.meta;
        configOptions = result.configOptions;
        this.meta = meta;
        this.clientId = result.clientId;
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
      for (const event of pending) {
        if (event.kind === "permission") {
          event.reject(abstention());
        }
      }
      if (joined) {
        await sessions.detach(hydraId);
      }
      throw toRpc(err);
    }

    this.deps.catalog.noteModels(this.entry()?.agentId, meta.availableModels);
    this.deps.catalog.noteConfig(hydraId, parseConfigOptions(configOptions));
    this.ensureSessionChannel();

    const side = this.deps.catalog.sideOf(hydraId);

    // Everything from here to the end of the method is synchronous, so no live frame can slip between the history and the join.
    const held = core.store.state(chatUri) as ChatState | undefined;
    const subscribed = core.hasSubscribers(chatUri) && held !== undefined;
    const aliases = this.mapper.aliases;
    this.mapper = this.newMapper();
    for (const [messageId, turnId] of aliases) {
      this.mapper.aliases.set(messageId, turnId);
    }
    const produced: Json[] = [];
    const collect = (actions: Json[]): void => {
      produced.push(...actions);
    };
    for (const frame of history) {
      collect(this.mapper.map(frame));
    }
    // History does not record model switches, so only the latest replayed turn is stamped with the model in use now.
    this.noteModel(text(meta.currentModel) ?? parseConfigOptions(configOptions).find((option) => option.id === "model")?.currentValue);
    stampLatestTurn(produced, this.model);
    this.buffering = undefined;
    for (const event of pending) {
      if (event.kind !== "permission") {
        this.handle(event, collect);
      }
    }
    this.highWater = undefined;
    collect(this.mapper.syncQueue(this.foreignQueue(meta.queue)));
    this.midTurn(meta, collect);
    // Hydra replays still-open permissions during the attach, before the subscriber that caused it has joined.
    for (const event of pending) {
      if (event.kind === "permission") {
        this.park(event, collect, !viewer);
      }
    }

    const summary = this.deps.catalog.summaryFor(this.deps.sessionUri);
    const chatTitle = summary?.chats?.find((entry) => entry.resource === chatUri)?.title;
    const fresh = emptyChat(chatUri, own?.title || chatTitle || "", own?.updatedAt ?? summary?.modifiedAt ?? new Date(0).toISOString(), withFlagBits(STATUS_IDLE, this.deps.catalog.flagsFor(this.deps.hydraId)));
    const base = held ?? (side ? ({ ...fresh, origin: sideChatOrigin(side) } as ChatState) : fresh);
    const plan = this.reconcilePlan(base, produced, cursor);
    // Replaying turns clears the read bit in the official reducers; the stored mark survives a replay.
    if (this.deps.catalog.flagsFor(this.deps.hydraId).isRead) {
      plan.push({ type: "chat/isReadChanged", isRead: true });
    }
    if (subscribed) {
      this.publish(plan);
    } else {
      core.createChannel(chatUri, reduceChat(base, plan));
    }
    this.attached = !this.sawClosed;
    this.mode = viewer ? "viewer" : "live";
    this.syncChatSummary();
    this.syncInputNeeded();
  }

  // The queue snapshot without this client's own entries, which already stand as AHP chips or turns.
  private foreignQueue(entries: unknown): unknown[] {
    return (Array.isArray(entries) ? entries : []).filter((raw) => {
      const id = text(bag(raw).messageId);
      return !(id && this.own.has(id)) && !this.isOwnOriginator(bag(raw));
    });
  }

  private isOwnOriginator(params: Json): boolean {
    return this.clientId !== undefined && text(bag(params.originator).clientId) === this.clientId;
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
    if (event.kind === "permission") {
      this.park(event, sink);
      return;
    }
    if (event.kind === "settled") {
      this.settled(event.entry, event.result, event.error, sink);
      return;
    }
    if (event.kind === "queue") {
      if (this.ownQueue(event.event, event.params, sink)) {
        return;
      }
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
      this.abstainAll();
      sink(this.mapper.closeActive("cancelled"));
      return;
    }
    const { frame } = event;
    if (frame.seq !== undefined && this.highWater !== undefined && frame.seq <= this.highWater) {
      return;
    }
    const kind = text(frame.update.sessionUpdate);
    const toolCallId = text(frame.update.toolCallId);
    if (toolCallId) {
      this.settling.get(toolCallId)?.();
      this.inferVerdict(toolCallId, frame.update, sink);
    }
    if (kind === "permission_resolved") {
      this.permissionResolved(frame.update, sink);
      return;
    }
    if (kind === "session_info_update") {
      this.applyTitle(text(frame.update.title));
      return;
    }
    if (kind === "available_commands_update") {
      this.commands = frame.update.availableCommands;
      return;
    }
    if (kind === "config_option_update") {
      const options = parseConfigOptions(frame.update.configOptions);
      this.noteModel(options.find((option) => option.id === "model")?.currentValue);
      this.applyConfig(options);
      return;
    }
    if (kind === "_hydra_current_model_update") {
      this.noteModel(text(frame.update.currentModel));
      return;
    }
    sink(this.mapper.map(frame));
    this.maybeSteer();
  }

  // Keeps the session's settings in step with what Hydra reports; only the default chat speaks for the session.
  private applyConfig(options: ConfigOption[]): void {
    if (this.deps.catalog.noteConfig(this.deps.hydraId, options)) {
      this.syncConfigValues();
    }
  }

  private syncConfigValues(): void {
    const { core, catalog, sessionUri, hydraId } = this.deps;
    const held = (core.store.state(sessionUri) as SessionState | undefined)?.config;
    const current = catalog.configStateFor(sessionUri)?.values;
    if (!held || !current || !catalog.isDefaultMember(hydraId)) {
      return;
    }
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(held.schema.properties)) {
      next[key] = current[key] ?? held.values[key];
    }
    if (JSON.stringify(next) !== JSON.stringify(held.values)) {
      core.publish(sessionUri, action({ type: "session/configChanged", config: next, replace: true }));
    }
  }

  // Settings a client chose while creating the session are applied once the agent is up, then the channel shows what Hydra reports.
  async applyInitialConfig(picks: Record<string, string>): Promise<void> {
    const { sessions, catalog, hydraId } = this.deps;
    await this.ensureLive();
    for (const [property, value] of Object.entries(picks)) {
      const optionId = optionIdOf(property);
      const known = catalog.configOptionsFor(hydraId).find((option) => option.id === optionId);
      if (optionId === undefined || !known || known.currentValue === value) {
        continue;
      }
      try {
        catalog.noteConfig(hydraId, parseConfigOptions(await sessions.setConfigOption(hydraId, optionId, value)));
      } catch (err) {
        log.warn(`initial setting ${optionId}=${value} for ${hydraId} failed`, message(err));
      }
    }
    this.syncConfigValues();
  }

  // A client picks a setting: Hydra applies it (agents may clamp or reshape the others), then the session shows what Hydra now reports.
  private async setConfig(body: Json): Promise<ActionDecision> {
    const { core, sessions, catalog, sessionUri, hydraId } = this.deps;
    const config = (core.store.state(sessionUri) as SessionState | undefined)?.config;
    if (!config) {
      return refuse("this session has no settings");
    }
    if (body.replace === true) {
      return refuse("settings are changed one at a time");
    }
    const changes: Array<[string, string]> = [];
    for (const [property, value] of Object.entries(bag(body.config))) {
      const schema = config.schema.properties[property];
      const optionId = optionIdOf(property);
      if (!schema || optionId === undefined) {
        return refuse(`unknown setting ${property}`);
      }
      if (!schema.sessionMutable) {
        return refuse(`${property} cannot be changed`);
      }
      if (typeof value !== "string" || !schema.enum?.includes(value)) {
        return refuse(`${String(value)} is not a valid value for ${property}`);
      }
      if (config.values[property] !== value) {
        changes.push([optionId, value]);
      }
    }
    try {
      await this.ensureLive();
      for (const [optionId, value] of changes) {
        catalog.noteConfig(hydraId, parseConfigOptions(await sessions.setConfigOption(hydraId, optionId, value)));
      }
    } catch (err) {
      return refuse(message(err));
    }
    setImmediate(() => this.syncConfigValues());
    return ACCEPT;
  }

  // Read and archive marks are one pair per session; the session and chat channels mirror each other.
  private setFlag(origin: string, flag: "isRead" | "isArchived", body: Json): ActionDecision {
    if (typeof body[flag] !== "boolean") {
      return refuse(`${flag} must be a boolean`);
    }
    const value = body[flag] as boolean;
    const { catalog, hydraId } = this.deps;
    catalog.setFlags(hydraId, { [flag]: value });
    if (flag === "isArchived" && value) {
      void this.retireIfIdle().catch((err) => log.debug(`letting ${hydraId} go cold failed`, message(err)));
    }
    this.showFlag(flag, value, origin);
    return ACCEPT;
  }

  // Brings the open session and chat channels in line with a mark; origin already carries it as the client's own action.
  showFlag(flag: "isRead" | "isArchived", value: boolean, origin?: string): void {
    const { core, catalog, hydraId, sessionUri, chatUri } = this.deps;
    const bit = flag === "isRead" ? STATUS_IS_READ : STATUS_IS_ARCHIVED;
    // Only the default chat shares its marks with the session.
    const shared = catalog.isDefaultMember(hydraId);
    for (const [channel, kind] of [[sessionUri, "session"], [chatUri, "chat"]] as const) {
      if (kind === "session" && !shared) {
        continue;
      }
      const state = core.store.state(channel) as { status?: number } | undefined;
      if (channel !== origin && state && (((state.status ?? 0) & bit) !== 0) !== value) {
        core.publish(channel, action({ type: `${kind}/${flag}Changed`, [flag]: value }));
      }
    }
  }

  // Done means the agent can stop: a live session that is not working goes cold, keeping its record; any client can warm it again.
  private async retireIfIdle(): Promise<void> {
    const { rest, hydraId } = this.deps;
    if (isFederatedId(hydraId)) {
      return;
    }
    const entry = await rest.getSession(hydraId);
    if (entry.status !== "warm" || entry.busy || entry.awaitingInput || entry.remote !== undefined) {
      return;
    }
    await rest.killSession(hydraId);
  }

  // The default chat names the session; any other chat only names itself.
  private applyTitle(title: string | undefined): void {
    const { core, catalog, hydraId, sessionUri, chatUri } = this.deps;
    const state = core.store.state(sessionUri) as SessionState | undefined;
    if (!title || !state) {
      return;
    }
    if (!catalog.isDefaultMember(hydraId)) {
      const held = state.chats.find((entry) => entry.resource === chatUri);
      if (held && held.title !== title) {
        core.publish(sessionUri, action({ type: "session/chatUpdated", chat: chatUri, changes: { title } }));
      }
      return;
    }
    if (state.title !== title) {
      core.publish(sessionUri, action({ type: "session/titleChanged", title }));
    }
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
      if (next.type === "chat/turnStarted" && typeof next.startedAt === "string") {
        this.deps.catalog.noteTurn(this.deps.hydraId, Date.parse(next.startedAt));
      }
    }
    this.settleRead();
    this.sweepParked();
    this.syncChatSummary();
    this.syncInputNeeded();
  }

  // New activity clears the chat's read bit in the official reducers, so the stored mark follows it.
  private settleRead(): void {
    const { core, catalog, hydraId, sessionUri, chatUri } = this.deps;
    const chat = core.store.state(chatUri) as ChatState | undefined;
    if (!chat || (chat.status & STATUS_IS_READ) !== 0 || !catalog.flagsFor(hydraId).isRead) {
      return;
    }
    catalog.setFlags(hydraId, { isRead: false });
    const session = core.store.state(sessionUri) as SessionState | undefined;
    if (session && catalog.isDefaultMember(hydraId) && (session.status & STATUS_IS_READ) !== 0) {
      core.publish(sessionUri, action({ type: "session/isReadChanged", isRead: false }));
    }
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
    this.abstainAll();
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

  // The Hydra message id behind an AHP turn id; turns Hydra started carry the same id on both sides.
  messageIdFor(turnId: string): string {
    for (const [messageId, id] of this.mapper.aliases) {
      if (id === turnId) {
        return messageId;
      }
    }
    return turnId;
  }

  get running(): boolean {
    return this.chatState()?.activeTurn !== undefined;
  }

  // The first turn of a chat created with an initial message: announced to the chat's subscribers, then sent to Hydra.
  async startInitial(turnId: string, message: Json): Promise<void> {
    const startedAt = new Date().toISOString();
    await this.ensureLive();
    this.headless = true;
    let decision: ActionDecision;
    try {
      decision = await this.handleAction(this.deps.chatUri, { type: "chat/turnStarted", turnId, startedAt, message } as never);
    } finally {
      this.headless = false;
    }
    if (!decision.accept) {
      throw new Error(decision.reason);
    }
    this.deps.core.publish(this.deps.chatUri, action({ type: "chat/turnStarted", turnId, startedAt, message }));
  }

  // Client actions on this session's channels, one at a time so writes reach Hydra in the order they were accepted.
  handleAction(channel: string, next: StateAction): Promise<ActionDecision> {
    const work = this.writes.then(() => this.decide(channel, next));
    const after = (): Promise<void> | undefined => {
      const pending = this.followUp;
      this.followUp = undefined;
      return pending;
    };
    this.writes = work.then(after, after).catch(() => undefined);
    return work;
  }

  private async decide(channel: string, next: StateAction): Promise<ActionDecision> {
    const body = next as unknown as Json;
    if (channel === this.deps.sessionUri) {
      if (next.type === "session/titleChanged") {
        return this.retitle(text(body.title) ?? "");
      }
      if (next.type === "session/isReadChanged" || next.type === "session/isArchivedChanged") {
        return this.setFlag(channel, next.type.endsWith("isReadChanged") ? "isRead" : "isArchived", body);
      }
      if (next.type === "session/activeClientSet" || next.type === "session/activeClientRemoved") {
        return ACCEPT;
      }
      if (next.type === "session/configChanged") {
        return this.setConfig(body);
      }
      return refuse("this host does not accept that action");
    }
    switch (next.type) {
      case "chat/isReadChanged":
      case "chat/isArchivedChanged":
        return this.setFlag(channel, next.type.endsWith("isReadChanged") ? "isRead" : "isArchived", body);
      case "chat/draftChanged":
        return ACCEPT;
      case "chat/turnStarted": {
        const decision = await this.startTurn(body);
        if (decision.accept) {
          this.deps.catalog.noteTurn(this.deps.hydraId, Date.now());
        }
        return decision;
      }
      case "chat/turnCancelled":
        return this.cancelTurn(text(body.turnId) ?? "");
      case "chat/toolCallConfirmed":
        return this.confirm(body);
      case "chat/pendingMessageSet":
        return body.kind === "steering" ? this.setSteering(body) : this.setQueued(body);
      case "chat/pendingMessageRemoved":
        return body.kind === "steering" ? this.removeSteering(text(body.id) ?? "") : this.removeQueued(text(body.id) ?? "");
      default:
        return refuse("this host does not accept that action");
    }
  }

  private chatState(): ChatState | undefined {
    return this.deps.core.store.state(this.deps.chatUri) as ChatState | undefined;
  }

  private async retitle(title: string): Promise<ActionDecision> {
    if (title.trim() === "") {
      return refuse("the title is empty");
    }
    try {
      await this.deps.rest.patchSession(this.deps.hydraId, { title });
    } catch (err) {
      return refuse(`Hydra did not take the title: ${message(err)}`);
    }
    return ACCEPT;
  }

  // Writes need a live attachment: a cold session is held through a read-only viewer, which Hydra refuses writes on.
  private async writable(): Promise<string | undefined> {
    if (!this.headless && !this.deps.core.hasSubscribers(this.deps.chatUri)) {
      return "subscribe to the chat before writing to it";
    }
    try {
      await this.ensureLive();
    } catch (err) {
      return `the session could not be opened: ${message(err)}`;
    }
    if (!this.isLive) {
      return "the session is not available";
    }
    return undefined;
  }

  private promptFor(content: unknown): Json[] | string {
    try {
      return toAcpPrompt(content, promptCapabilities(this.meta));
    } catch (err) {
      if (err instanceof UnsupportedContent) {
        return err.message;
      }
      throw err;
    }
  }

  // The model on a turn's message is applied with session/set_model before the prompt goes out.
  private async applyModel(content: unknown): Promise<string | undefined> {
    const wanted = text(bag(bag(content).model).id);
    if (!wanted || wanted === this.model) {
      return undefined;
    }
    try {
      await this.deps.sessions.setModel(this.deps.hydraId, wanted);
    } catch (err) {
      return `the agent did not switch to model ${wanted}: ${message(err)}`;
    }
    this.noteModel(wanted);
    return undefined;
  }

  private noteModel(model: string | undefined): void {
    if (model) {
      this.model = model;
      this.mapper.model = model;
    }
  }

  private send(entry: OwnEntry): void {
    this.sends.push(entry);
    void this.deps.sessions
      .prompt(this.deps.hydraId, entry.prompt, (result, error) => {
        this.deliver({ kind: "settled", entry, result, error });
      })
      .catch(() => undefined);
  }

  private async startTurn(body: Json): Promise<ActionDecision> {
    const turnId = text(body.turnId);
    if (!turnId) {
      return refuse("the turn has no id");
    }
    if (this.chatState()?.activeTurn) {
      return refuse("a turn is already running; queue the message instead");
    }
    const blocked = await this.writable();
    if (blocked) {
      return refuse(blocked);
    }
    const prompt = this.promptFor(body.message);
    if (typeof prompt === "string") {
      return refuse(prompt);
    }
    const unswitched = await this.applyModel(body.message);
    if (unswitched) {
      return refuse(unswitched);
    }
    if (this.chatState()?.activeTurn) {
      return refuse("a turn is already running; queue the message instead");
    }
    this.publish(this.mapper.beginLocal(turnId, Date.now()));
    this.send(ownEntry({ kind: "turn", turnId, started: true, message: bag(body.message), prompt }));
    return ACCEPT;
  }

  // Parked permissions are answered cancelled first: Hydra's session/cancel does not answer them for us.
  private async cancelTurn(turnId: string): Promise<ActionDecision> {
    if (!this.isLive) {
      return refuse("the session is not available");
    }
    if (this.chatState()?.activeTurn?.id !== turnId || this.mapper.activeTurnId !== turnId) {
      return refuse("that turn is not running");
    }
    const answered: string[] = [];
    for (const [toolCallId, parked] of this.parked) {
      if (parked.turnId === turnId) {
        this.parked.delete(toolCallId);
        parked.answer({ outcome: { outcome: "cancelled" } });
        answered.push(toolCallId);
      }
    }
    this.publish(this.mapper.endLocal(turnId, Date.now()));
    // Accepted now so the client's turnCancelled lands before any turn that starts during the wait.
    this.followUp = (answered.length > 0 ? this.awaitAgent(answered) : Promise.resolve()).then(() => {
      // A turn that started during the wait (a queued entry, say) is not the one the client cancelled.
      if (!this.mapper.activeTurnId) {
        this.deps.sessions.cancel(this.deps.hydraId);
      }
    });
    return ACCEPT;
  }

  // Waits until the agent has acted on each answered permission, so the answers reach it ahead of the cancel.
  private async awaitAgent(toolCallIds: string[]): Promise<void> {
    const waits = toolCallIds.map(
      (toolCallId) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(done, SETTLE_WAIT_MS);
          const settling = this.settling;
          function done(): void {
            clearTimeout(timer);
            settling.delete(toolCallId);
            resolve();
          }
          settling.set(toolCallId, done);
        }),
    );
    await Promise.all(waits);
  }

  private confirm(body: Json): ActionDecision {
    const toolCallId = text(body.toolCallId) ?? "";
    const parked = this.parked.get(toolCallId);
    if (!parked || parked.turnId !== text(body.turnId)) {
      return refuse("this permission request is no longer open");
    }
    const approved = body.approved === true;
    const optionId = chooseOption(parked.options, approved, text(body.selectedOptionId));
    if (approved && !optionId) {
      return refuse("the agent offered no option that approves this tool call");
    }
    this.parked.delete(toolCallId);
    parked.answer(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
    this.mapper.noteConfirmed(toolCallId);
    this.syncInputNeeded();
    return ACCEPT;
  }

  private async setQueued(body: Json): Promise<ActionDecision> {
    const id = text(body.id);
    if (!id) {
      return refuse("the queued message has no id");
    }
    const blocked = await this.writable();
    if (blocked) {
      return refuse(blocked);
    }
    const prompt = this.promptFor(body.message);
    if (typeof prompt === "string") {
      return refuse(prompt);
    }
    const known = this.queuedEntries.get(id);
    if (!known) {
      if ((this.chatState()?.queuedMessages ?? []).some((entry) => entry.id === id)) {
        return refuse(`queued message ${id} is not one this host can edit`);
      }
      const entry = ownEntry({ kind: "queued", pendingId: id, message: bag(body.message), prompt });
      this.queuedEntries.set(id, entry);
      this.send(entry);
      return ACCEPT;
    }
    if (known.started) {
      return refuse(`queued message ${id} is already running`);
    }
    let result;
    try {
      const messageId = await waitFor(known.named, ECHO_WAIT_MS, "Hydra to queue the message");
      result = await this.deps.sessions.updateQueued(this.deps.hydraId, messageId, prompt);
    } catch (err) {
      return refuse(message(err));
    }
    if (!result.ok) {
      return refuse(`Hydra did not update the queued message: ${result.reason}`);
    }
    known.message = bag(body.message);
    known.prompt = prompt;
    return ACCEPT;
  }

  private async removeQueued(id: string): Promise<ActionDecision> {
    const entry = this.queuedEntries.get(id);
    if (!entry) {
      return ACCEPT;
    }
    if (entry.started) {
      return refuse(`queued message ${id} is already running`);
    }
    entry.cancelling = true;
    let result;
    try {
      const messageId = await waitFor(entry.named, ECHO_WAIT_MS, "Hydra to queue the message");
      result = await this.deps.sessions.cancelQueued(this.deps.hydraId, messageId);
    } catch (err) {
      entry.cancelling = false;
      return refuse(message(err));
    }
    if (!result.ok && result.reason === "already_running") {
      entry.cancelling = false;
      return refuse(`queued message ${id} is already running`);
    }
    this.queuedEntries.delete(id);
    return ACCEPT;
  }

  // Steering goes to Hydra only while a turn runs; sent idle it is held and delivered once the next turn is under way.
  private async setSteering(body: Json): Promise<ActionDecision> {
    const id = text(body.id);
    if (!id) {
      return refuse("the steering message has no id");
    }
    if (this.steer?.inFlight) {
      return refuse("a steering message is already being delivered");
    }
    const blocked = await this.writable();
    if (blocked) {
      return refuse(blocked);
    }
    const prompt = this.promptFor(body.message);
    if (typeof prompt === "string") {
      return refuse(prompt);
    }
    if (this.steer?.inFlight) {
      return refuse("a steering message is already being delivered");
    }
    this.steer = { id, message: bag(body.message), prompt, inFlight: false };
    this.maybeSteer();
    return ACCEPT;
  }

  private removeSteering(id: string): ActionDecision {
    if (this.steer?.id === id) {
      if (this.steer.inFlight) {
        return refuse("the steering message is already being delivered");
      }
      this.steer = undefined;
    }
    return ACCEPT;
  }

  private maybeSteer(): void {
    const steer = this.steer;
    const turnId = this.mapper.activeTurnId;
    if (!steer || steer.inFlight || !turnId || !this.isLive) {
      return;
    }
    if (steer.triedTurn === turnId && Date.now() - (steer.triedAt ?? 0) < STEER_RETRY_MS) {
      return;
    }
    steer.inFlight = true;
    steer.triedTurn = turnId;
    steer.triedAt = Date.now();
    const entry = ownEntry({ kind: "steer", pendingId: steer.id, message: steer.message, prompt: steer.prompt });
    this.sends.push(entry);
    this.holdForSteer();
    this.deps.sessions.steer(this.deps.hydraId, steer.prompt).then(
      (result) => this.steered(steer, entry, result),
      (err) => {
        log.warn(`steering ${this.deps.hydraId} failed`, message(err));
        this.steered(steer, entry, { outcome: "failed" });
      },
    );
  }

  // Per PROTOCOL.md: startedNewTurn without detached is an entry Hydra queued for us, whose start consumes the chip;
  // detached is already covered by _hydra_turn_started; injected is never echoed to the steering client.
  private holdForSteer(): void {
    this.releaseSteerHold();
    this.steerHold = { events: [], timer: setTimeout(() => this.releaseSteerHold(), STEER_HOLD_MS) };
    this.steerHold.timer.unref();
  }

  private releaseSteerHold(): void {
    const hold = this.steerHold;
    if (!hold) {
      return;
    }
    this.steerHold = undefined;
    clearTimeout(hold.timer);
    for (const event of hold.events) {
      this.deliver(event);
    }
  }

  private steered(steer: HeldSteer, entry: OwnEntry, result: SteeringResult): void {
    try {
      this.settleSteer(steer, entry, result);
    } finally {
      this.releaseSteerHold();
    }
  }

  private settleSteer(steer: HeldSteer, entry: OwnEntry, result: SteeringResult): void {
    steer.inFlight = false;
    if (result.outcome === "promptRequired") {
      this.dropSend(entry);
      return;
    }
    if (this.steer === steer) {
      this.steer = undefined;
    }
    if (result.outcome === "startedNewTurn" && result.detached !== true) {
      return;
    }
    this.dropSend(entry);
    // Hydra does not echo an injected steer to the client that sent it, so the turn carrying it is announced here,
    // before the held answer to it is let through.
    if (result.outcome === "injected") {
      this.publish(this.mapper.steer(`steer-${steer.id}`, Date.now(), steer.message, steer.id));
    }
    // The reply can beat the client's own pendingMessageSet into the chat, so look for the chip once that has landed.
    setImmediate(() => {
      if (this.chatState()?.steeringMessage?.id === steer.id) {
        this.publish([{ type: "chat/pendingMessageRemoved", kind: "steering", id: steer.id }]);
      }
    });
  }

  private dropSend(entry: OwnEntry): void {
    const index = this.sends.indexOf(entry);
    if (index >= 0) {
      this.sends.splice(index, 1);
    }
  }

  // Hydra's queue notifications about this client's own prompts; true when the event was one of those.
  private ownQueue(event: QueueEvent, params: Json, sink: (actions: Json[]) => void): boolean {
    const messageId = text(params.messageId);
    if (!messageId) {
      return false;
    }
    if (event === "added") {
      if (!this.isOwnOriginator(params)) {
        return false;
      }
      const amending = text(bag(bag(params._meta)[HYDRA_META]).amending) !== undefined;
      const entry = this.sends.find((candidate) => (candidate.kind === "steer") === amending);
      if (!entry) {
        return false;
      }
      this.dropSend(entry);
      entry.messageId = messageId;
      this.own.set(messageId, entry);
      if (entry.turnId) {
        this.mapper.aliases.set(messageId, entry.turnId);
      }
      entry.name(messageId);
      return true;
    }
    const entry = this.own.get(messageId);
    if (!entry) {
      return false;
    }
    if (event === "updated") {
      return true;
    }
    if (text(params.reason) === "started") {
      if (!entry.started) {
        entry.started = true;
        entry.turnId = messageId;
        sink(this.mapper.startOwn(messageId, Date.now(), entry.message, entry.pendingId));
      }
      if (entry.kind === "steer") {
        this.own.delete(messageId);
      }
      return true;
    }
    this.own.delete(messageId);
    if (entry.kind === "queued" && entry.pendingId) {
      this.queuedEntries.delete(entry.pendingId);
    }
    if (entry.pendingId && !entry.cancelling) {
      sink(this.pendingRemoval(entry));
    }
    return true;
  }

  private pendingRemoval(entry: OwnEntry): Json[] {
    const chat = this.chatState();
    const id = entry.pendingId;
    if (!chat || !id) {
      return [];
    }
    if (entry.kind === "queued" && (chat.queuedMessages ?? []).some((queued) => queued.id === id)) {
      return [{ type: "chat/pendingMessageRemoved", kind: "queued", id }];
    }
    if (entry.kind === "steer" && chat.steeringMessage?.id === id) {
      return [{ type: "chat/pendingMessageRemoved", kind: "steering", id }];
    }
    return [];
  }

  // The session/prompt answer is the only end this client hears of its own turn; Hydra leaves it out of turn_complete.
  private settled(entry: OwnEntry, result: unknown, error: Error | undefined, sink: (actions: Json[]) => void): void {
    this.dropSend(entry);
    if (entry.messageId) {
      this.own.delete(entry.messageId);
    }
    if (entry.kind === "queued" && entry.pendingId && this.queuedEntries.get(entry.pendingId) === entry) {
      this.queuedEntries.delete(entry.pendingId);
    }
    const turnId = entry.turnId;
    if (!entry.started || !turnId) {
      if (!entry.cancelling) {
        sink(this.pendingRemoval(entry));
      }
      return;
    }
    if (this.mapper.activeOriginId !== turnId) {
      if (!this.mapper.activeTurnId) {
        this.mapper.unsilence();
      }
      return;
    }
    if (error) {
      sink(this.mapper.closeActive("error", Date.now(), `Hydra could not run the prompt: ${error.message}`));
      return;
    }
    sink(this.mapper.closeActive(text(bag(result).stopReason) ?? "end_turn", Date.now()));
  }

  private park(event: Extract<Pending, { kind: "permission" }>, sink: (actions: Json[]) => void, joining = false): void {
    const toolCall = bag(event.params.toolCall);
    const toolCallId = text(toolCall.toolCallId);
    const turnId = this.mapper.activeTurnId;
    const asking = joining || (this.isLive && this.deps.core.hasSubscribers(this.deps.chatUri));
    // No AHP client to ask means abstaining; anything else would settle the race for the TUI and Slack too.
    if (!toolCallId || !turnId || !asking) {
      event.reject(abstention());
      return;
    }
    this.dropParked(this.parked.get(toolCallId));
    const options = (Array.isArray(event.params.options) ? event.params.options : []).map(bag);
    const parked: Parked = {
      turnId,
      options,
      answer: event.resolve,
      abstain: () => event.reject(abstention()),
    };
    this.parked.set(toolCallId, parked);
    const show = (into: (actions: Json[]) => void): void => into(this.mapper.confirmationReady(toolCall, confirmationOptions(options)));
    const delay = this.deps.permissionDelayMs ?? 0;
    // A request already open when a client joins has had its chance; a fresh one waits so an auto-approver's answer never shows.
    if (joining || delay <= 0) {
      show(sink);
      return;
    }
    parked.held = setTimeout(() => {
      parked.held = undefined;
      if (this.parked.get(toolCallId) === parked) {
        show((actions) => this.publish(actions));
      }
    }, delay);
  }

  private dropParked(parked: Parked | undefined): void {
    if (!parked) {
      return;
    }
    clearTimeout(parked.held);
    parked.abstain();
  }

  // Another Hydra client answered first: clear the AHP prompt the way that client's answer went.
  private permissionResolved(update: Json, sink: (actions: Json[]) => void): void {
    const toolCallId = text(update.toolCallId);
    const parked = toolCallId ? this.parked.get(toolCallId) : undefined;
    if (!toolCallId || !parked) {
      return;
    }
    this.parked.delete(toolCallId);
    const unseen = parked.held !== undefined;
    this.dropParked(parked);
    // Answered while still held: no client ever saw it, so there is nothing to clear.
    if (unseen) {
      return;
    }
    this.mapper.noteConfirmed(toolCallId);
    // Hydra reads the outcome's kind field while ACP answers name it outcome, so a spec-shaped answer arrives with no verdict.
    const outcome = bag(update.outcome);
    const chosen = text(update.chosenOptionId) ?? text(outcome.optionId);
    const kind = text(outcome.kind) ?? text(outcome.outcome);
    if (!chosen && kind !== "cancelled") {
      this.unresolved.set(toolCallId, parked);
      return;
    }
    sink([this.verdict(parked, toolCallId, isApproval(parked.options, chosen), chosen)]);
  }

  private verdict(parked: Parked, toolCallId: string, approved: boolean, chosen?: string): Json {
    return {
      type: "chat/toolCallConfirmed",
      turnId: parked.turnId,
      toolCallId,
      ...(approved ? { approved: true, confirmed: "user-action" } : { approved: false, reason: "denied" }),
      ...(chosen ? { selectedOptionId: chosen } : {}),
    };
  }

  // A call that goes on to fail was denied; any other progress means it was approved.
  private inferVerdict(toolCallId: string, update: Json, sink: (actions: Json[]) => void): void {
    const parked = this.unresolved.get(toolCallId);
    const status = text(update.status);
    if (!parked || !status || status === "pending") {
      return;
    }
    this.unresolved.delete(toolCallId);
    if (parked.turnId === this.mapper.activeTurnId) {
      sink([this.verdict(parked, toolCallId, status !== "failed")]);
    }
  }

  // A permission whose turn is over can no longer be answered by an AHP client.
  private sweepParked(): void {
    const turnId = this.mapper.activeTurnId;
    for (const [toolCallId, parked] of this.unresolved) {
      if (parked.turnId !== turnId) {
        this.unresolved.delete(toolCallId);
      }
    }
    for (const [toolCallId, parked] of this.parked) {
      if (parked.turnId !== turnId) {
        this.parked.delete(toolCallId);
        parked.abstain();
      }
    }
  }

  private abstainAll(): void {
    for (const parked of this.parked.values()) {
      this.dropParked(parked);
    }
    this.parked.clear();
    this.syncInputNeeded();
  }

  private inputId(toolCallId: string): string {
    return `${this.deps.chatUri}#${toolCallId}`;
  }

  // Mirrors the parked confirmations into the session's inputNeeded list.
  private syncInputNeeded(): void {
    const { core, chatUri, sessionUri } = this.deps;
    const session = core.store.state(sessionUri) as SessionState | undefined;
    const chat = this.chatState();
    if (!session || !chat) {
      return;
    }
    const stale = new Set((session.inputNeeded ?? []).filter((entry) => entry.chat === chatUri).map((entry) => entry.id));
    for (const [toolCallId, parked] of this.parked) {
      const id = this.inputId(toolCallId);
      if (stale.delete(id)) {
        continue;
      }
      const part = chat.activeTurn?.responseParts.find(
        (candidate) => candidate.kind === "toolCall" && candidate.toolCall.toolCallId === toolCallId,
      );
      const call = part?.kind === "toolCall" ? (part.toolCall as ToolCallState) : undefined;
      if (call?.status !== "pending-confirmation") {
        continue;
      }
      core.publish(
        sessionUri,
        action({ type: "session/inputNeededSet", request: { id, chat: chatUri, kind: "toolConfirmation", turnId: parked.turnId, toolCall: call } }),
      );
    }
    for (const id of stale) {
      core.publish(sessionUri, action({ type: "session/inputNeededRemoved", id }));
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
    const blank = emptyChat(chatUri, state.title, state.modifiedAt, state.status);
    const turns = turnsFromFrames(frames, blank);
    const oldest = oldestSeq(frames);
    const next = page.hasMore && oldest !== undefined ? String(oldest) : undefined;
    core.publish(chatUri, action({ type: "chat/turnsLoaded", turns, ...(next !== undefined ? { turnsNextCursor: next } : {}) }));
  }
}

function stampLatestTurn(actions: Json[], model: string | undefined): void {
  const index = actions.findLastIndex((next) => next.type === "chat/turnStarted");
  if (index >= 0) {
    const started = actions[index] as Json;
    actions[index] = { ...started, message: withModel(bag(started.message), model) };
  }
}
