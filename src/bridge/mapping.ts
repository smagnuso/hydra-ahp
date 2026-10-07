import { isAbsolute } from "node:path";
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
import { editContentUri } from "./edit-content.js";
import { mimeFor } from "../files/service.js";
import { cwdToUri, uriToCwd } from "./ids.js";
import type { ImageReader } from "./images.js";
import { patchedFiles } from "./patch.js";
import { MAX_IMAGE_BYTES } from "./prompt.js";
import type { FileLinks } from "./file-links.js";
import { LinkStream, type SessionLinkResolver } from "./session-links.js";

export interface Frame {
  update: Json;
  recordedAt?: number;
  seq?: number;
}

export interface MapperOptions {
  clock?: () => number;
  // Where an edit's before and after text is kept for clients to diff; without it edits show as unified-diff text.
  edits?: { chatUri: string; put: (uri: string, text: string) => void };
  // The AHP session and chat of another Hydra session, for prompts it sent; undefined when it is not listed.
  sourceOf?: (hydraId: string) => { session: string; chat: string } | undefined;
  // The link a client follows to another Hydra session, for rewriting the hydra:// links in text; undefined when it is not listed.
  sessionLink?: SessionLinkResolver;
  // Links for the files message text names, against the session's cwd on this machine.
  fileLinks?: FileLinks;
  // Reads an image file a tool saved, so it shows inline; only for sessions whose files are on this machine.
  readImage?: ImageReader;
}

const MAX_OUTPUT_CHARS = 20_000;
const TERMINAL_STATUSES = new Set(["completed", "failed"]);
const CONTENT_KINDS = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan", "usage_update"]);
const END_KINDS = new Set(["turn_complete", "_hydra_turn_ended"]);

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
      default:
        break;
    }
  }
  return lines.join("\n");
}

export function withModel(message: Json, model: string | undefined): Json {
  return model && message.model === undefined ? { ...message, model: { id: model } } : message;
}

function messageOf(body: string, kind: string, meta?: Json, attachments: Json[] = []): Json {
  return { text: body, origin: { kind }, ...(attachments.length > 0 ? { attachments } : {}), ...(meta ? { _meta: meta } : {}) };
}

// The images a prompt carried, as the attachments a client sent them as.
function promptImages(prompt: unknown): Json[] {
  if (!Array.isArray(prompt)) {
    return [];
  }
  return prompt.flatMap((block) => {
    const entry = bag(block);
    const data = text(entry.data);
    const mimeType = text(entry.mimeType);
    if (entry.type !== "image" || !data || !mimeType?.startsWith("image/")) {
      return [];
    }
    return [{ type: "embeddedResource", label: "Image", displayKind: "image", data, contentType: mimeType }];
  });
}

function promptMessage(prompt: unknown, kind: string, meta?: Json): Json {
  return messageOf(promptText(prompt), kind, meta, promptImages(prompt));
}

function diffText(path: string, oldText: string, newText: string): string {
  const removed = oldText === "" ? [] : oldText.split("\n").map((line) => `-${line}`);
  const added = newText === "" ? [] : newText.split("\n").map((line) => `+${line}`);
  return [`--- ${path}`, `+++ ${path}`, ...removed, ...added].join("\n");
}

function countLines(value: string): number {
  return value === "" ? 0 : value.split("\n").length - (value.endsWith("\n") ? 1 : 0);
}

// The line counts the daemon recorded for each edit an update carries, in order.
function editStatsOf(update: Json): Array<{ path: string; added: number; removed: number }> {
  const stats = bag(bag(update._meta)[HYDRA_META]).editStats;
  return (Array.isArray(stats) ? stats : []).flatMap((raw) => {
    const s = bag(raw);
    return typeof s.path === "string" && typeof s.added === "number" && typeof s.removed === "number"
      ? [{ path: s.path, added: s.added, removed: s.removed }]
      : [];
  });
}

type EditBlock = (path: string, before: string | undefined, after: string, counts: { added: number; removed: number } | undefined) => Json;

// Without an edit handler, a diff without a before side is a creation pointing at the file and any other edit is unified-diff text.
function plainEdit(path: string, before: string | undefined, after: string): Json {
  if (before === undefined) {
    return {
      type: "fileEdit",
      after: { uri: cwdToUri(path), content: { uri: cwdToUri(path) } },
      diff: { added: countLines(after), removed: 0 },
    };
  }
  return { type: "text", text: diffText(path, before, after) };
}

// An image a tool returned: inline data, or a saved file read in when it is on this machine, as embedded content (which VS Code
// shows inline); any other saved file as a reference, which VS Code shows as a link it opens through resource*.
function imageBlock(inner: Json, readImage?: ImageReader): Json | undefined {
  if (inner.type === "image") {
    const data = text(inner.data);
    const mimeType = text(inner.mimeType);
    if (!data || !mimeType?.startsWith("image/") || (data.length * 3) / 4 > MAX_IMAGE_BYTES) {
      return undefined;
    }
    return { type: "embeddedResource", data, contentType: mimeType };
  }
  if (inner.type === "resource_link") {
    const raw = text(inner.uri) ?? text(inner.name);
    const uri = raw?.startsWith("file:") ? raw : raw && isAbsolute(raw) ? cwdToUri(raw) : undefined;
    const mimeType = text(inner.mimeType) ?? (raw ? mimeFor(raw) : undefined);
    if (!uri || !mimeType?.startsWith("image/")) {
      return undefined;
    }
    const path = uriToCwd(uri);
    const data = path ? readImage?.(path) : undefined;
    return data ? { type: "embeddedResource", data, contentType: mimeType } : { type: "resource", uri, contentType: mimeType };
  }
  return undefined;
}

function contentBlocks(update: Json, edit?: EditBlock, readImage?: ImageReader): Json[] {
  const blocks: Json[] = [];
  const stats = editStatsOf(update);
  const seen = new Map<string, number>();
  const counted = (path: string): { added: number; removed: number } | undefined => {
    const occurrence = seen.get(path) ?? 0;
    seen.set(path, occurrence + 1);
    const counts = stats.filter((s) => s.path === path)[occurrence];
    return counts && { added: counts.added, removed: counts.removed };
  };
  const content = Array.isArray(update.content) ? update.content : [];
  if (!content.some((raw) => bag(raw).type === "diff")) {
    for (const file of patchedFiles(update)) {
      const before = file.created ? undefined : file.oldText;
      blocks.push(edit ? edit(file.path, before, file.newText, counted(file.path)) : plainEdit(file.path, before, file.newText));
    }
  }
  for (const raw of content) {
    const entry = bag(raw);
    if (entry.type === "content") {
      const inner = bag(entry.content);
      if (inner.type === "text" && typeof inner.text === "string") {
        blocks.push({ type: "text", text: inner.text });
      }
      const image = imageBlock(inner, readImage);
      if (image) {
        blocks.push(image);
      }
    } else if (entry.type === "diff" && typeof entry.path === "string") {
      const path = entry.path;
      const before = typeof entry.oldText === "string" ? entry.oldText : undefined;
      const after = typeof entry.newText === "string" ? entry.newText : "";
      blocks.push(edit ? edit(path, before, after, counted(path)) : plainEdit(path, before, after));
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

// opencode keeps its plan with a todowrite tool rather than ACP plan updates (some sessions send both): the list is in
// rawInput.todos while it runs and rawOutput.metadata.todos once it completes, in the plan entry shape.
function todosOf(update: Json): Json[] | undefined {
  const todos = bag(update.rawInput).todos ?? bag(bag(update.rawOutput).metadata).todos;
  return Array.isArray(todos) ? todos : undefined;
}

const UNSOLICITED_LABEL = "The agent continued on its own";

const PLAN_MARKS: Record<string, string> = { completed: "✓", in_progress: "▶", pending: "○" };

// The markdown form bolds the step in progress, the only heavy line in the list, so it stands out in the row.
// Agents that describe a call (Claude's shell and task tools) put it in the input; VS Code shows it beside the command.
function intentionOf(call: Call): Json {
  if (call.input === undefined) {
    return {};
  }
  try {
    const description = text(bag(JSON.parse(call.input)).description);
    return description ? { intention: description } : {};
  } catch {
    return {};
  }
}

// VS Code renders a terminal call from its input's command, so one whose command is not a single string stays a plain tool.
function isShellCommand(call: Call): boolean {
  if (call.kind !== "execute") {
    return false;
  }
  if (call.input === undefined) {
    return true;
  }
  try {
    const command = bag(JSON.parse(call.input)).command;
    return command === undefined || typeof command === "string";
  } catch {
    return false;
  }
}

function entryLine(entry: Json, markdown = false): string {
  const status = text(entry.status) ?? "pending";
  const where = PLAN_MARKS[status] === undefined ? ` (${status})` : "";
  const line = `${PLAN_MARKS[status] ?? "○"} ${text(entry.content) ?? ""}${where}`;
  if (!markdown) {
    return line;
  }
  return status === "in_progress" ? `- **${line}**` : `- ${line}`;
}

// Translates one chat's Hydra session/update stream into AHP chat actions, for replayed and live frames alike.
export class ChatMapper {
  private turn: TurnContext | undefined;
  private readonly queued = new Set<string>();
  private readonly todoCalls = new Set<string>();
  private lastAt = 0;
  private readonly clock: () => number;
  // Set once a turn was ended here ahead of Hydra, so its trailing frames do not open an orphan turn.
  private silenced = false;
  private links: { turnId: string; partId: string; stream: LinkStream } | undefined;
  // Which tool call carries each image file inline; a later call showing the same file links it instead of repeating it.
  private readonly inlined = new Map<string, string>();
  private deferredSteer: { turnId: string; message: Json; pendingId?: string } | undefined;
  // The session's current model, stamped on the turns opened here so a client's model picker restores to it.
  model: string | undefined;
  // Hydra messageIds of turns AHP clients started, mapped to the client's turnId.
  readonly aliases = new Map<string, string>();

  constructor(private readonly options: MapperOptions = {}) {
    this.clock = options.clock ?? Date.now;
  }

  get activeTurnId(): string | undefined {
    return this.turn?.id;
  }

  // The turn Hydra knows the active one as, which a steer split leaves behind.
  get activeOriginId(): string | undefined {
    return this.turn?.origin ?? this.turn?.id;
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
    const actions = this.mapUpdate(frame, at);
    const deferred = this.deferredSteer;
    if (!deferred || (this.turn && this.awaitingAnswer())) {
      return actions;
    }
    this.deferredSteer = undefined;
    return [...actions, ...this.steer(deferred.turnId, at, deferred.message, deferred.pendingId)];
  }

  private mapUpdate(frame: Frame, at: number): Json[] {
    const update = frame.update;
    const kind = text(update.sessionUpdate) ?? text(update.kind);
    if (this.silenced && !this.turn) {
      if (END_KINDS.has(kind ?? "")) {
        this.silenced = false;
        return NO_ACTIONS;
      }
      if (CONTENT_KINDS.has(kind ?? "")) {
        return NO_ACTIONS;
      }
    }
    const flushed = kind === "agent_message_chunk" ? NO_ACTIONS : this.flushLinks();
    const actions = this.mapKind(kind, update, at, frame);
    return flushed.length > 0 ? [...flushed, ...actions] : actions;
  }

  private mapKind(kind: string | undefined, update: Json, at: number, frame: Frame): Json[] {
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
        return this.todoWrite(update, at, frame) ?? this.toolCall(update, at, frame);
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
    return [{ type: "chat/pendingMessageSet", kind: "queued", id, message: promptMessage(params.prompt, "user") }];
  }

  queueUpdated(params: Json): Json[] {
    const id = text(params.messageId);
    if (!id || !this.queued.has(id)) {
      return NO_ACTIONS;
    }
    return [{ type: "chat/pendingMessageSet", kind: "queued", id, message: promptMessage(params.prompt, "user") }];
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
      actions.push({ type: "chat/pendingMessageSet", kind: "queued", id, message: promptMessage(entry.prompt, "user") });
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
  closeActive(stop: string, atMs?: number, errorMessage?: string): Json[] {
    if (!this.turn) {
      return NO_ACTIONS;
    }
    return this.end(stop, atMs ?? (this.lastAt || this.clock()), undefined, errorMessage);
  }

  // Marks a call as awaiting a permission answer so a ready that says nobody is asked is not sent.
  noteAsked(toolCallId: string): void {
    const call = this.turn?.calls.get(toolCallId);
    if (call) {
      call.asked = true;
    }
  }

  // The confirmation was answered, so later content updates may flow into the call again.
  noteConfirmed(toolCallId: string): void {
    const call = this.turn?.calls.get(toolCallId);
    if (call) {
      call.readied = true;
    }
  }

  // Puts the call in pending-confirmation with the offered options, starting it first if no frame named it yet.
  confirmationReady(toolCall: Json, options: Json[]): Json[] {
    const turn = this.turn;
    const toolCallId = text(toolCall.toolCallId);
    if (!turn || !toolCallId) {
      return NO_ACTIONS;
    }
    const actions: Json[] = [];
    const known = turn.calls.has(toolCallId);
    const call = this.callOf(turn, toolCall);
    if (!known) {
      call.status = "pending";
      call.startedAt = this.clock();
      actions.push(this.toolStart(turn, call));
    }
    if (call.input === undefined && toolCall.rawInput !== undefined) {
      call.input = JSON.stringify(toolCall.rawInput);
    }
    call.asked = true;
    const title = text(toolCall.title);
    const editBlock = this.editBlock(toolCallId);
    const edits = editBlock
      ? contentBlocks(toolCall, editBlock)
          .filter((block) => block.type === "fileEdit")
          .map(({ type: _type, ...edit }) => edit)
      : [];
    actions.push({
      type: "chat/toolCallReady",
      turnId: turn.id,
      toolCallId,
      invocationMessage: call.displayName,
      ...(title ? { confirmationTitle: title } : {}),
      ...(call.input === undefined ? {} : { toolInput: call.input }),
      ...intentionOf(call),
      ...(edits.length > 0 ? { edits: { items: edits } } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...this.callMeta(call),
    });
    return actions;
  }

  // A turn an AHP client started: the client's own turnStarted is the announcement, so only the context opens here.
  beginLocal(turnId: string, startedMs: number): Json[] {
    const actions = this.turn ? this.end("cancelled", startedMs) : [];
    this.turn = openTurn(turnId, startedMs);
    this.silenced = false;
    return actions;
  }

  // Announces a turn Hydra started for this client, which Hydra does not echo back to it.
  startOwn(turnId: string, startedMs: number, message: Json, queuedMessageId?: string): Json[] {
    return this.start(turnId, startedMs, message, queuedMessageId);
  }

  // AHP has no place for a message inside a turn, so a steer completes the running turn and opens one carrying it,
  // as VS Code's own host does; pendingId is the steering chip the new turn consumes.
  steer(turnId: string, at: number, message: Json, pendingId?: string): Json[] {
    // Ending the turn now would strand a confirmation in it, so the split waits for the answer.
    if (this.awaitingAnswer()) {
      this.deferredSteer = { turnId, message, pendingId };
      return NO_ACTIONS;
    }
    const previous = this.turn;
    const actions = previous ? this.end("end_turn", at) : [];
    actions.push(...this.start(turnId, at, message, pendingId));
    if (previous) {
      (this.turn as TurnContext).origin = previous.origin ?? previous.id;
      return actions;
    }
    return [...actions, ...this.end("end_turn", at)];
  }

  private awaitingAnswer(): boolean {
    return [...(this.turn?.calls.values() ?? [])].some((call) => call.asked && !call.readied && !call.finished);
  }

  // A client's chat/turnCancelled ends the turn in AHP; closes the plan and drops what Hydra still sends for it.
  endLocal(turnId: string, atMs: number): Json[] {
    if (this.turn?.id !== turnId) {
      return NO_ACTIONS;
    }
    const actions = this.end("cancelled", atMs).filter((next) => next.type !== "chat/turnCancelled");
    this.silenced = true;
    return actions;
  }

  // Hydra settled the turn the client ended, so later frames belong to whatever runs next.
  unsilence(): void {
    this.silenced = false;
  }

  private start(id: string, startedMs: number, message: Json, queuedMessageId?: string): Json[] {
    this.silenced = false;
    const actions = this.turn ? this.end("cancelled", startedMs) : [];
    const deferred = this.deferredSteer;
    this.deferredSteer = undefined;
    if (deferred) {
      actions.push(...this.steer(deferred.turnId, startedMs, deferred.message, deferred.pendingId));
    }
    this.turn = openTurn(id, startedMs);
    actions.push({
      type: "chat/turnStarted",
      turnId: id,
      startedAt: iso(startedMs),
      message: withModel(message, this.model),
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
    const messageId = text(update.messageId);
    const id = (messageId && this.aliases.get(messageId)) ?? messageId ?? `prompt-${frame.seq ?? at}`;
    const sentBy = bag(update.sentBy);
    const origin = sentBy.fromSession || sentBy.fromLabel ? "agent" : "user";
    const fromSession = text(sentBy.fromSession);
    const source = fromSession ? this.options.sourceOf?.(fromSession) : undefined;
    const meta: Json = {
      ...(Object.keys(sentBy).length > 0 ? { [HYDRA_META]: { sentBy } } : {}),
      // VS Code shows such a request as delegated from the sending session, with a link to it.
      ...(source ? { "vscode.chat.delegation": { sourceSession: source.session, sourceChat: source.chat } } : {}),
    };
    const queuedMessageId = messageId && this.queued.delete(messageId) ? messageId : undefined;
    return this.start(id, at, promptMessage(update.prompt, origin, Object.keys(meta).length > 0 ? meta : undefined), queuedMessageId);
  }

  private userChunk(update: Json, at: number, frame: Frame): Json[] {
    const meta = bag(bag(update._meta)[HYDRA_META]);
    if (meta.compatFor === "prompt_received") {
      return NO_ACTIONS;
    }
    const body = text(bag(update.content).text);
    if (meta.steered === true) {
      return body ? this.steer(`steer-${frame.seq ?? at}`, at, messageOf(body, "user")) : NO_ACTIONS;
    }
    if (this.turn || !body) {
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
    const partId = (part as { id: string }).id;
    if (kind === "markdown") {
      body = this.linked(turn.id, partId, body);
      if (body === "") {
        return actions;
      }
    }
    actions.push({
      type: kind === "markdown" ? "chat/delta" : "chat/reasoning",
      turnId: turn.id,
      partId,
      content: body,
    });
    return actions;
  }

  // Message text passes through a LinkStream per part, so a link, session id or file name split across chunks is rewritten whole.
  private linked(turnId: string, partId: string, body: string): string {
    const { sessionLink, fileLinks } = this.options;
    if (!sessionLink && !fileLinks) {
      return body;
    }
    if (this.links?.partId !== partId) {
      this.links = {
        turnId,
        partId,
        stream: new LinkStream({ ...(sessionLink ? { session: sessionLink } : {}), ...(fileLinks ? { files: fileLinks } : {}) }),
      };
    }
    return this.links.stream.push(body);
  }

  private imageReader(toolCallId: string): ImageReader | undefined {
    const read = this.options.readImage;
    if (!read) {
      return undefined;
    }
    return (path) => {
      const owner = this.inlined.get(path);
      if (owner !== undefined && owner !== toolCallId) {
        return undefined;
      }
      const data = read(path);
      if (data !== undefined) {
        this.inlined.set(path, toolCallId);
      }
      return data;
    };
  }

  get holding(): boolean {
    return this.links?.stream.holding ?? false;
  }

  // Lets out text held back as a possible link when the agent pauses; the part stays open for more.
  releaseHeld(): Json[] {
    const links = this.links;
    const rest = links?.stream.flush();
    return links && rest ? [{ type: "chat/delta", turnId: links.turnId, partId: links.partId, content: rest }] : NO_ACTIONS;
  }

  // Lets out text held back as a possible link once the part it belongs to can get no more.
  private flushLinks(): Json[] {
    const links = this.links;
    this.links = undefined;
    const rest = links?.stream.flush();
    return links && rest ? [{ type: "chat/delta", turnId: links.turnId, partId: links.partId, content: rest }] : NO_ACTIONS;
  }

  private callOf(turn: TurnContext, update: Json): Call {
    const known = turn.calls.get(String(update.toolCallId));
    if (known) {
      // Agents often open a call with a placeholder title ("Preparing file…") and name it once the input is known.
      known.displayName = text(update.title) ?? known.displayName;
      known.kind = text(update.kind) ?? known.kind;
      return known;
    }
    const id = String(update.toolCallId);
    const title = text(update.title) ?? id;
    const claude = bag(bag(update._meta).claudeCode);
    const name = text(claude.toolName) ?? text(update.name) ?? title;
    const kind = text(update.kind);
    const call: Call = { id, name, displayName: title, ...(kind ? { kind } : {}), readied: false, asked: false, finished: false, content: [] };
    turn.calls.set(id, call);
    delete turn.waiting;
    turn.parts.push({ id, kind: "toolCall" });
    return call;
  }

  // A call's _meta replaces the one it had, so every lifecycle action carries all of it.
  private callMeta(call: Call): Json {
    const meta: Json = isShellCommand(call) ? { toolKind: "terminal", language: "shellscript" } : {};
    if (call.startedAt !== undefined) {
      const times: Json = { startedAt: iso(call.startedAt) };
      if (call.endedAt !== undefined) {
        times.endedAt = iso(call.endedAt);
        times.durationMs = Math.max(0, call.endedAt - call.startedAt);
      }
      meta[HYDRA_META] = times;
    }
    return Object.keys(meta).length > 0 ? { _meta: meta } : {};
  }

  // A fileEdit whose before and after are kept in the edit store, so a client diffs them in its own viewer.
  private editBlock(toolCallId: string): EditBlock | undefined {
    const edits = this.options.edits;
    if (!edits) {
      return undefined;
    }
    let index = 0;
    return (path, before, after, counts) => {
      const n = index++;
      const fileUri = cwdToUri(path);
      const side = (name: "old" | "new", body: string): Json => {
        const uri = editContentUri(edits.chatUri, toolCallId, n, name);
        edits.put(uri, body);
        return { uri: fileUri, content: { uri } };
      };
      const diff = counts ?? (before === undefined ? { added: countLines(after), removed: 0 } : undefined);
      return {
        type: "fileEdit",
        ...(before === undefined ? {} : { before: side("old", before) }),
        after: side("new", after),
        ...(diff ? { diff } : {}),
      };
    };
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
      invocationMessage: call.message ?? call.displayName,
      confirmed: "not-needed",
      ...(call.input === undefined ? {} : { toolInput: call.input }),
      ...intentionOf(call),
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
        pastTenseMessage: call.message ?? call.displayName,
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
    const blocks = contentBlocks(update, this.editBlock(update.toolCallId as string), this.imageReader(update.toolCallId as string));
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

  // A todowrite call becomes the turn's plan; its own updates are dropped, as they only repeat the list as JSON.
  // Only its opening update carries the name, so the call is remembered by id.
  private todoWrite(update: Json, at: number, frame: Frame): Json[] | undefined {
    const id = text(update.toolCallId);
    const todos = todosOf(update);
    if (!id || (todos === undefined && text(update.title)?.toLowerCase() !== "todowrite" && !this.todoCalls.has(id))) {
      return undefined;
    }
    this.todoCalls.add(id);
    return todos === undefined ? NO_ACTIONS : this.plan({ entries: todos }, at, frame);
  }

  // One synthetic call holds the turn's plan, rewritten by every plan update and completed when the turn ends.
  private plan(update: Json, at: number, frame: Frame): Json[] {
    const actions: Json[] = [];
    const turn = this.ensureTurn(actions, at, frame);
    const id = planId(turn.id);
    const first = !turn.calls.has(id);
    const call = this.callOf(turn, { toolCallId: id, title: "Plan", name: "plan" });
    const entries = Array.isArray(update.entries) ? update.entries : [];
    // VS Code shows a running call's output only through a channel of its own, so the list goes in the row itself.
    call.message = { markdown: ["**Plan**", "", ...entries.map((entry) => entryLine(bag(entry), true))].join("\n") };
    if (first) {
      call.startedAt = at;
      actions.push(this.toolStart(turn, call));
      call.status = "in_progress";
    }
    actions.push(this.toolReady(turn, call));
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
    // An agent-kind message renders in VS Code as a request with no text, so an unlabelled wake-up is a notification too.
    const message = messageOf(label ?? UNSOLICITED_LABEL, "systemNotification", Object.keys(cause).length > 0 ? { [HYDRA_META]: { cause } } : undefined);
    return this.start(id, at, message);
  }

  private hydraTurnEnded(update: Json, at: number): Json[] {
    const started = text(update.startedMessageId);
    if (started !== undefined && this.turn && this.activeOriginId !== started) {
      return NO_ACTIONS;
    }
    const reason = text(bag(bag(update._meta)[HYDRA_META]).reason) ?? "completed";
    const stop = reason === "completed" ? "end_turn" : "cancelled";
    const duration = typeof update.durationMs === "number" ? update.durationMs : undefined;
    return this.end(stop, at, duration);
  }

  private end(stop: string, at: number, reportedDuration?: number, errorMessage?: string): Json[] {
    const turn = this.turn;
    if (!turn) {
      return NO_ACTIONS;
    }
    this.turn = undefined;
    const actions: Json[] = [...this.flushLinks()];
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
        part: { kind: "error", error: { errorType: stop, message: errorMessage ?? `The agent ended the turn: ${stop}` } },
      });
    } else {
      actions.push({ type: "chat/turnComplete", turnId: turn.id, duration });
    }
    return actions;
  }
}
