// Ports the update rules of ahpd's packages/agent-acp/src/mapping.ts (MIT): open a part before streaming into it,
// hold whitespace-only runs, synthesize a start for an orphan tool_call_update, re-ready on late arguments, and
// hold toolCallReady while a permission may still arrive.
import {
  HYDRA_META,
  bag,
  durationOf,
  iso,
  openTurn,
  planId,
  text,
  type Call,
  type Json,
  type TurnContext,
} from "./turns.js";

export interface Frame {
  update: Json;
  recordedAt?: number;
  seq?: number;
}

export interface MapperOptions {
  clock?: () => number;
}

const MAX_OUTPUT_CHARS = 20_000;
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

const NO_ACTIONS: Json[] = [];

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) {
    return "";
  }
  const lines: string[] = [];
  for (const block of prompt) {
    const entry = bag(block);
    switch (entry.type) {
      case "text":
        lines.push(text(entry.text) ?? "");
        break;
      case "resource_link":
        lines.push(text(entry.uri) ?? text(entry.name) ?? "");
        break;
      case "resource": {
        const resource = bag(entry.resource);
        lines.push(text(resource.text) ?? text(resource.uri) ?? "");
        break;
      }
      case "image":
        lines.push("[image]");
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}

function messageOf(body: string, kind: string, meta?: Json): Json {
  return { text: body, origin: { kind }, ...(meta ? { _meta: meta } : {}) };
}

function diffText(path: string, oldText: string, newText: string): string {
  const removed = oldText === "" ? [] : oldText.split("\n").map((line) => `-${line}`);
  const added = newText === "" ? [] : newText.split("\n").map((line) => `+${line}`);
  return [`--- ${path}`, `+++ ${path}`, ...removed, ...added].join("\n");
}

function countLines(value: string): number {
  return value === "" ? 0 : value.split("\n").length;
}

// A diff without a before side is a creation and can point at the file; any other edit is shown as a unified diff.
function contentBlocks(content: unknown): Json[] {
  const blocks: Json[] = [];
  if (!Array.isArray(content)) {
    return blocks;
  }
  for (const raw of content) {
    const entry = bag(raw);
    if (entry.type === "content") {
      const inner = bag(entry.content);
      if (inner.type === "text" && typeof inner.text === "string") {
        blocks.push({ type: "text", text: inner.text });
      }
    } else if (entry.type === "diff" && typeof entry.path === "string") {
      const path = entry.path;
      const before = typeof entry.oldText === "string" ? entry.oldText : undefined;
      const after = typeof entry.newText === "string" ? entry.newText : "";
      if (before === undefined) {
        blocks.push({
          type: "fileEdit",
          after: { uri: `file://${path}`, content: { uri: `file://${path}` } },
          diff: { added: countLines(after), removed: 0 },
        });
      } else {
        blocks.push({ type: "text", text: diffText(path, before, after) });
      }
    }
  }
  return blocks;
}

function outputText(rawOutput: unknown): string | undefined {
  let found: string | undefined;
  if (typeof rawOutput === "string") {
    found = rawOutput;
  } else {
    const output = bag(rawOutput).output;
    found = typeof output === "string" ? output : undefined;
  }
  if (found === undefined || found.trim() === "") {
    return undefined;
  }
  return found.length > MAX_OUTPUT_CHARS ? `${found.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : found;
}

function contentText(blocks: Json[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n");
}

function entryLine(entry: Json): string {
  const status = text(entry.status) ?? "pending";
  const done = status === "completed";
  const where = done || status === "pending" ? "" : ` (${status})`;
  return `- [${done ? "x" : " "}] ${text(entry.content) ?? ""}${where}`;
}

// Translates one chat's Hydra session/update stream into AHP chat actions, for replayed and live frames alike.
export class ChatMapper {
  private turn: TurnContext | undefined;
  private readonly queued = new Set<string>();
  private lastAt = 0;
  private readonly clock: () => number;
  steeringId: string | undefined;

  constructor(options: MapperOptions = {}) {
    this.clock = options.clock ?? Date.now;
  }

  get activeTurnId(): string | undefined {
    return this.turn?.id;
  }

  get activeStartedMs(): number | undefined {
    return this.turn?.startedMs;
  }

  get lastFrameAt(): number {
    return this.lastAt;
  }

  map(frame: Frame): Json[] {
    const at = frame.recordedAt ?? this.clock();
    if (frame.recordedAt !== undefined) {
      this.lastAt = Math.max(this.lastAt, frame.recordedAt);
    }
    const update = frame.update;
    const kind = text(update.sessionUpdate) ?? text(update.kind);
    switch (kind) {
      case "prompt_received":
        return this.promptReceived(update, at, frame);
      case "user_message_chunk":
        return this.userChunk(update, at, frame);
      case "agent_message_chunk":
        return this.agentChunk("markdown", update, at, frame);
      case "agent_thought_chunk":
        return this.agentChunk("reasoning", update, at, frame);
      case "tool_call":
      case "tool_call_update":
        return this.toolCall(update, at, frame);
      case "plan":
        return this.plan(update, at, frame);
      case "usage_update":
        return this.usage(update);
      case "turn_complete":
        return this.turnComplete(update, at);
      case "_hydra_turn_started":
        return this.hydraTurnStarted(update, at);
      case "_hydra_turn_ended":
        return this.hydraTurnEnded(update, at);
      default:
        return NO_ACTIONS;
    }
  }

  queueAdded(params: Json): Json[] {
    const id = text(params.messageId);
    const position = params.position;
    if (!id || typeof position !== "number" || position < 1) {
      return NO_ACTIONS;
    }
    this.queued.add(id);
    return [{ type: "chat/pendingMessageSet", kind: "queued", id, message: messageOf(promptText(params.prompt), "user") }];
  }

  queueUpdated(params: Json): Json[] {
    const id = text(params.messageId);
    if (!id || !this.queued.has(id)) {
      return NO_ACTIONS;
    }
    return [{ type: "chat/pendingMessageSet", kind: "queued", id, message: messageOf(promptText(params.prompt), "user") }];
  }

  queueRemoved(params: Json): Json[] {
    const id = text(params.messageId);
    if (!id || !this.queued.delete(id)) {
      return NO_ACTIONS;
    }
    return [{ type: "chat/pendingMessageRemoved", kind: "queued", id }];
  }

  // Reconciles the queued chips with the attach response's snapshot; position 0 is the in-flight head, not a chip.
  syncQueue(entries: unknown): Json[] {
    const actions: Json[] = [];
    const waiting = new Map<string, Json>();
    for (const raw of Array.isArray(entries) ? entries : []) {
      const entry = bag(raw);
      const id = text(entry.messageId);
      if (id && typeof entry.position === "number" && entry.position >= 1) {
        waiting.set(id, entry);
      }
    }
    for (const id of [...this.queued]) {
      if (!waiting.has(id)) {
        this.queued.delete(id);
        actions.push({ type: "chat/pendingMessageRemoved", kind: "queued", id });
      }
    }
    for (const [id, entry] of waiting) {
      this.queued.add(id);
      actions.push({ type: "chat/pendingMessageSet", kind: "queued", id, message: messageOf(promptText(entry.prompt), "user") });
    }
    return actions;
  }

  // The attach-mid-turn rule: a busy session with no start event seen still gets an active turn.
  openFromBusy(startedMs: number): Json[] {
    if (this.turn) {
      return NO_ACTIONS;
    }
    return this.start(`attach-${startedMs}`, startedMs, messageOf("", "agent"));
  }

  // Closes whatever the mapper believes is open, e.g. when the session closed or a replay stopped mid-turn.
  closeActive(stop: string, atMs?: number): Json[] {
    if (!this.turn) {
      return NO_ACTIONS;
    }
    return this.end(stop, atMs ?? (this.lastAt || this.clock()));
  }

  // Marks a call as awaiting a permission answer so a ready that says nobody is asked is not sent.
  noteAsked(toolCallId: string): void {
    const call = this.turn?.calls.get(toolCallId);
    if (call) {
      call.asked = true;
    }
  }

  private start(id: string, startedMs: number, message: Json, queuedMessageId?: string): Json[] {
    const actions = this.turn ? this.end("cancelled", startedMs) : [];
    this.turn = openTurn(id, startedMs);
    actions.push({
      type: "chat/turnStarted",
      turnId: id,
      startedAt: iso(startedMs),
      message,
      ...(queuedMessageId ? { queuedMessageId } : {}),
    });
    return actions;
  }

  // Content that arrives with no turn open belongs to a turn nobody announced, such as a replay cut mid-turn.
  private ensureTurn(actions: Json[], at: number, frame: Frame): TurnContext {
    if (!this.turn) {
      actions.push(...this.start(`orphan-${frame.seq ?? at}`, at, messageOf("", "agent")));
    }
    return this.turn as TurnContext;
  }

  private promptReceived(update: Json, at: number, frame: Frame): Json[] {
    const id = text(update.messageId) ?? `prompt-${frame.seq ?? at}`;
    const sentBy = bag(update.sentBy);
    const origin = sentBy.fromSession || sentBy.fromLabel ? "agent" : "user";
    const meta = Object.keys(sentBy).length > 0 ? { [HYDRA_META]: { sentBy } } : undefined;
    const queuedMessageId = this.queued.delete(id) ? id : undefined;
    return this.start(id, at, messageOf(promptText(update.prompt), origin, meta), queuedMessageId);
  }

  private userChunk(update: Json, at: number, frame: Frame): Json[] {
    const meta = bag(bag(update._meta)[HYDRA_META]);
    if (meta.compatFor === "prompt_received") {
      return NO_ACTIONS;
    }
    if (meta.steered === true) {
      if (!this.steeringId) {
        return NO_ACTIONS;
      }
      const id = this.steeringId;
      this.steeringId = undefined;
      return [{ type: "chat/pendingMessageRemoved", kind: "steering", id }];
    }
    if (this.turn) {
      return NO_ACTIONS;
    }
    const body = text(bag(update.content).text);
    if (!body) {
      return NO_ACTIONS;
    }
    return this.start(`user-${frame.seq ?? at}`, at, messageOf(body, "user"));
  }

  // A run of message chunks is held while it is only whitespace, so a message of nothing but whitespace opens no part.
  private agentChunk(kind: "markdown" | "reasoning", update: Json, at: number, frame: Frame): Json[] {
    const content = bag(update.content);
    const written = content.type === "text" ? text(content.text) : undefined;
    if (written === undefined) {
      return NO_ACTIONS;
    }
    const actions: Json[] = [];
    const turn = this.ensureTurn(actions, at, frame);
    const held = turn.waiting;
    delete turn.waiting;
    let body = written;
    const last = turn.parts.at(-1);
    if (kind === "markdown" && last?.kind !== "markdown") {
      body = `${held ?? ""}${written}`;
      if (body.trim() === "") {
        turn.waiting = body;
        return actions;
      }
    }
    let part = last;
    if (!(held === undefined && last !== undefined && last.kind === kind)) {
      part = { id: `${turn.id}:${turn.parts.length}`, kind };
      turn.parts.push(part);
      actions.push({
        type: "chat/responsePart",
        turnId: turn.id,
        part: { kind, id: part.id, content: "" },
      });
    }
    actions.push({
      type: kind === "markdown" ? "chat/delta" : "chat/reasoning",
      turnId: turn.id,
      partId: (part as { id: string }).id,
      content: body,
    });
    return actions;
  }

  private callOf(turn: TurnContext, update: Json): Call {
    const known = turn.calls.get(String(update.toolCallId));
    if (known) {
      return known;
    }
    const id = String(update.toolCallId);
    const title = text(update.title) ?? id;
    const claude = bag(bag(update._meta).claudeCode);
    const name = text(claude.toolName) ?? text(update.name) ?? title;
    const call: Call = { id, name, displayName: title, readied: false, asked: false, finished: false, content: [] };
    turn.calls.set(id, call);
    delete turn.waiting;
    turn.parts.push({ id, kind: "toolCall" });
    return call;
  }

  private callMeta(call: Call): Json {
    if (call.startedAt === undefined) {
      return {};
    }
    const times: Json = { startedAt: iso(call.startedAt) };
    if (call.endedAt !== undefined) {
      times.endedAt = iso(call.endedAt);
      times.durationMs = Math.max(0, call.endedAt - call.startedAt);
    }
    return { _meta: { [HYDRA_META]: times } };
  }

  private toolStart(turn: TurnContext, call: Call): Json {
    return {
      type: "chat/toolCallStart",
      turnId: turn.id,
      toolCallId: call.id,
      toolName: call.name,
      displayName: call.displayName,
      ...this.callMeta(call),
    };
  }

  private toolReady(turn: TurnContext, call: Call): Json {
    call.readied = true;
    return {
      type: "chat/toolCallReady",
      turnId: turn.id,
      toolCallId: call.id,
      invocationMessage: call.displayName,
      confirmed: "not-needed",
      ...(call.input === undefined ? {} : { toolInput: call.input }),
      ...this.callMeta(call),
    };
  }

  private toolContent(turn: TurnContext, call: Call): Json {
    return {
      type: "chat/toolCallContentChanged",
      turnId: turn.id,
      toolCallId: call.id,
      content: call.content,
      ...this.callMeta(call),
    };
  }

  private toolComplete(turn: TurnContext, call: Call, rawOutput?: unknown): Json {
    const success = call.status === "completed";
    let content = call.content;
    if (content.length === 0) {
      const output = outputText(rawOutput);
      content = output === undefined ? [] : [{ type: "text", text: output }];
    }
    const message = contentText(content);
    call.finished = true;
    return {
      type: "chat/toolCallComplete",
      turnId: turn.id,
      toolCallId: call.id,
      result: {
        success,
        pastTenseMessage: call.displayName,
        ...(content.length === 0 ? {} : { content }),
        ...(success ? {} : { error: { message: message === "" ? "The tool failed" : message } }),
      },
      ...this.callMeta(call),
    };
  }

  // pending is the agent's word for a call it has not started, and a ready of not-needed claims nobody will be asked.
  private mayReady(call: Call): boolean {
    return call.status !== undefined && call.status !== "pending" && !call.asked;
  }

  private toolCall(update: Json, at: number, frame: Frame): Json[] {
    if (typeof update.toolCallId !== "string") {
      return NO_ACTIONS;
    }
    const actions: Json[] = [];
    const turn = this.ensureTurn(actions, at, frame);
    const known = turn.calls.has(update.toolCallId);
    const call = this.callOf(turn, update);
    if (call.finished) {
      return actions;
    }
    if (typeof update.status === "string") {
      call.status = update.status;
    } else if (!known) {
      call.status = "pending";
    }
    if (call.startedAt === undefined) {
      call.startedAt = at;
    }
    if (!known) {
      actions.push(this.toolStart(turn, call));
    }
    const arrived = update.rawInput === undefined ? undefined : JSON.stringify(update.rawInput);
    if (arrived !== undefined) {
      call.input = arrived;
    }
    const blocks = contentBlocks(update.content);
    if (blocks.length > 0) {
      call.content = blocks;
    }
    const terminal = call.status !== undefined && TERMINAL_STATUSES.has(call.status);
    let readied = false;
    if (this.mayReady(call) && (!call.readied || arrived !== undefined)) {
      actions.push(this.toolReady(turn, call));
      readied = true;
    }
    if (terminal) {
      call.endedAt = at;
      actions.push(this.toolComplete(turn, call, update.rawOutput));
    } else if (call.readied && call.content.length > 0 && (blocks.length > 0 || readied)) {
      actions.push(this.toolContent(turn, call));
    }
    return actions;
  }

  // One synthetic call holds the turn's plan, rewritten by every plan update and completed when the turn ends.
  private plan(update: Json, at: number, frame: Frame): Json[] {
    const actions: Json[] = [];
    const turn = this.ensureTurn(actions, at, frame);
    const id = planId(turn.id);
    const first = !turn.calls.has(id);
    const call = this.callOf(turn, { toolCallId: id, title: "Plan", name: "plan" });
    if (first) {
      call.startedAt = at;
      actions.push(this.toolStart(turn, call));
      call.status = "in_progress";
      actions.push(this.toolReady(turn, call));
    }
    const entries = Array.isArray(update.entries) ? update.entries : [];
    call.content = entries.map((entry) => ({ type: "text", text: entryLine(bag(entry)) }));
    actions.push(this.toolContent(turn, call));
    return actions;
  }

  private usage(update: Json): Json[] {
    const turn = this.turn;
    if (!turn) {
      return NO_ACTIONS;
    }
    return [this.usageAction(turn.id, update)];
  }

  usageAction(turnId: string, update: Json): Json {
    const meta: Json = { context: { used: update.used, size: update.size } };
    const cost = bag(update.cost);
    if (typeof cost.amount === "number") {
      meta.cost = { amount: cost.amount, currency: cost.currency };
    }
    return { type: "chat/usage", turnId, usage: { _meta: meta } };
  }

  private turnComplete(update: Json, at: number): Json[] {
    return this.end(text(update.stopReason) ?? "end_turn", at);
  }

  private hydraTurnStarted(update: Json, at: number): Json[] {
    const id = text(update.messageId) ?? `hydra-${at}`;
    const meta = bag(bag(update._meta)[HYDRA_META]);
    const cause = bag(meta.cause);
    const label = text(cause.label);
    const message = label
      ? messageOf(label, "systemNotification", { [HYDRA_META]: { cause } })
      : messageOf("", "agent", Object.keys(cause).length > 0 ? { [HYDRA_META]: { cause } } : undefined);
    return this.start(id, at, message);
  }

  private hydraTurnEnded(update: Json, at: number): Json[] {
    const started = text(update.startedMessageId);
    if (started !== undefined && this.turn && this.turn.id !== started) {
      return NO_ACTIONS;
    }
    const reason = text(bag(bag(update._meta)[HYDRA_META]).reason) ?? "completed";
    const stop = reason === "completed" ? "end_turn" : "cancelled";
    const duration = typeof update.durationMs === "number" ? update.durationMs : undefined;
    return this.end(stop, at, duration);
  }

  private end(stop: string, at: number, reportedDuration?: number): Json[] {
    const turn = this.turn;
    if (!turn) {
      return NO_ACTIONS;
    }
    this.turn = undefined;
    const actions: Json[] = [];
    const plan = turn.calls.get(planId(turn.id));
    if (plan && !plan.finished) {
      plan.status = "completed";
      plan.endedAt = at;
      actions.push(this.toolComplete(turn, plan));
    }
    const duration = durationOf(turn, at, reportedDuration);
    if (stop === "cancelled" || stop === "interrupted") {
      actions.push({ type: "chat/turnCancelled", turnId: turn.id, duration });
    } else if (stop === "error" || stop === "refusal") {
      actions.push({
        type: "chat/error",
        turnId: turn.id,
        duration,
        part: { kind: "error", error: { errorType: stop, message: `The agent ended the turn: ${stop}` } },
      });
    } else {
      actions.push({ type: "chat/turnComplete", turnId: turn.id, duration });
    }
    return actions;
  }
}
