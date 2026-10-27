import { dirname, isAbsolute, join, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { Changeset, ChangesetFile, ChangesetState } from "@microsoft/agent-host-protocol";
import { cwdToUri } from "../bridge/ids.js";
import type { ProtocolCore } from "../protocol/core.js";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import { logger } from "../util/log.js";
import { contentAt, repoRoot, workingChanges, type ChangedFile } from "./git.js";

const log = logger("changesets");

type ChangesetId = "session" | "uncommitted" | "turn";

const SEGMENT = "/changeset/";
const REV_SCHEME = "ahp-rev:";
const EDIT_SCHEME = "ahp-changeset:";
const CHANGESET_URI = /\/changeset\/(session|uncommitted|turn\/[^/]+)$/;
const REVISION = /^(HEAD|[0-9a-f]{40}|[0-9a-f]{64})$/;
const POLL_MS = 2_000;
// A changeset that keeps failing, such as a turn of a chat nobody has open, is retried less and less often.
const MAX_BACKOFF_MS = 60_000;
// Hydra walks a session's history to list its edits, so new ones are picked up less often than the tree is checked.
const EDITS_EVERY_MS = 10_000;
const NOT_FOUND = -32008;
const MAX_CACHED_CHANNELS = 128;
const MAX_CACHED_REVISION_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_REVISION_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_REVISION_ENTRIES = 4096;
const MAX_RECORDED_DIFF_BYTES = 256 * 1024;
const MAX_RECORDED_DIFF_LINES = 1000;

export function changesetUri(sessionUri: string, id: "session" | "uncommitted"): string {
  return `${sessionUri}${SEGMENT}${id}`;
}

export function turnChangesetUri(sessionUri: string, turnId: string): string {
  return `${sessionUri}${SEGMENT}turn/${encodeURIComponent(turnId)}`;
}

export function isChangesetUri(uri: string): boolean {
  return CHANGESET_URI.test(uri);
}

export function changesetsFor(sessionUri: string): Changeset[] {
  return [
    {
      label: "Session Changes",
      description: "Recorded file edits made by the agent during this session",
      uriTemplate: changesetUri(sessionUri, "session"),
      changeKind: "session",
    },
    {
      label: "Uncommitted Changes",
      description: "Everything in the session's repository that differs from HEAD",
      uriTemplate: changesetUri(sessionUri, "uncommitted"),
      changeKind: "uncommitted",
    },
    {
      label: "Turn Changes",
      description: "File edits the agent made in a single turn",
      uriTemplate: `${sessionUri}${SEGMENT}turn/{turnId}`,
      changeKind: "turn",
    },
  ];
}

export interface ChangesetServiceOptions {
  // The working directory of a session on this machine; undefined for sessions whose files live elsewhere.
  cwdOf: (sessionUri: string) => string | undefined;
  // The Hydra sessions behind an AHP session.
  membersOf: (sessionUri: string) => string[];
  // Per-file edit hunks recorded in each Hydra session's history.
  sessionEdits: (hydraId: string) => Promise<SessionEdit[]>;
  // The file edits recorded in one turn of the session's chats; undefined when no chat holds that turn.
  turnEdits?: (sessionUri: string, turnId: string) => TurnFileEdit[] | undefined;
  isCold?: (sessionUri: string) => boolean;
  // Receives the session changeset's line and file totals each time it is computed.
  onSessionTotals?: (sessionUri: string, totals: { additions: number; deletions: number; files: number }) => void;
  // Receives directories outside the session cwd that contain recorded edits.
  onWorkdirs?: (sessionUri: string, directories: string[]) => void;
  pollMs?: number;
  editsEveryMs?: number;
}

// One fileEdit block from a turn's tool results.
export interface TurnFileEdit {
  fileUri: string;
  before?: { uri: string; content: unknown };
  after?: { uri: string; content: unknown };
  diff?: { added?: number; removed?: number };
}

export interface SessionEdit {
  path: string;
  // scope says whether the texts are the whole file or a snippet; older daemons leave it out.
  hunks: Array<{ oldText: string; newText: string; scope?: "file" | "snippet" }>;
  created?: boolean;
}

interface Watched {
  id: ChangesetId;
  sessionUri: string;
  turnId?: string;
  files: Map<string, ChangesetFile>;
  timer?: NodeJS.Timeout;
  computing: boolean;
  stopped: boolean;
  edited: Map<string, SessionEdit>;
  editsReadAt: number;
  failures: number;
}

interface CachedEditContent {
  sessionUri: string;
  text: string;
}

const action = (value: Record<string, unknown>) => value as never;

// Serves each local session's changes as AHP changesets, recomputed from git while someone watches them.
export class ChangesetService {
  private core!: ProtocolCore;
  private readonly watched = new Map<string, Watched>();
  private readonly snapshots = new Map<string, ChangesetFile[]>();
  private readonly revisionContents = new Map<string, Buffer>();
  private readonly editContents = new Map<string, CachedEditContent>();
  private revisionContentBytes = 0;
  private editContentBytes = 0;

  constructor(private readonly options: ChangesetServiceOptions) {}

  start(core: ProtocolCore): void {
    this.core = core;
  }

  attach(uri: string): void {
    const match = CHANGESET_URI.exec(uri);
    if (!match || this.watched.has(uri)) {
      return;
    }
    const sessionUri = uri.slice(0, match.index);
    if (!this.options.cwdOf(sessionUri)) {
      return;
    }
    const prior = this.snapshots.get(uri);
    const cached = this.options.isCold?.(sessionUri) ? undefined : prior;
    if (cached === undefined && prior !== undefined) {
      this.snapshots.delete(uri);
    }
    log.debug(`attaching ${uri} with ${cached === undefined ? "no cached snapshot" : `${cached.length} cached files`}`);
    if (cached !== undefined) {
      this.rememberSnapshot(uri, cached);
    }
    const kind = (match[1] as string).startsWith("turn/") ? "turn" : (match[1] as ChangesetId);
    const watched: Watched = {
      id: kind,
      sessionUri,
      ...(kind === "turn" ? { turnId: decodeTurnId((match[1] as string).slice("turn/".length)) } : {}),
      files: new Map((cached ?? []).map((file) => [file.id, file])),
      computing: false,
      stopped: false,
      edited: new Map(),
      editsReadAt: 0,
      failures: 0,
    };
    this.watched.set(uri, watched);
    this.core.createChannel(uri, {
      status: cached === undefined ? "computing" : "ready",
      files: cached ?? [],
    } as unknown as ChangesetState);
    void this.refresh(uri, watched);
  }

  detach(uri: string): void {
    const watched = this.watched.get(uri);
    if (!watched) {
      return;
    }
    log.debug(`detaching ${uri}; snapshot ${this.snapshots.has(uri) ? "retained" : "not ready yet"}`);
    watched.stopped = true;
    clearTimeout(watched.timer);
    this.watched.delete(uri);
    this.core.removeChannel(uri);
    if (this.options.isCold?.(watched.sessionUri) && ![...this.watched.values()].some((entry) => entry.sessionUri === watched.sessionUri)) {
      this.forgetRevisionContents(watched.sessionUri);
      this.forgetEditContents(watched.sessionUri);
      for (const snapshot of this.snapshots.keys()) {
        if (sessionUriOfChangeset(snapshot) === watched.sessionUri) {
          this.snapshots.delete(snapshot);
        }
      }
    }
  }

  stop(): void {
    for (const uri of [...this.watched.keys()]) {
      this.detach(uri);
    }
  }

  pruneColdSnapshots(): void {
    if (!this.options.isCold) {
      return;
    }
    const sessions = new Set<string>();
    for (const uri of this.snapshots.keys()) {
      const sessionUri = sessionUriOfChangeset(uri);
      if (sessionUri) {
        sessions.add(sessionUri);
      }
    }
    for (const watched of this.watched.values()) {
      sessions.add(watched.sessionUri);
    }
    for (const content of this.editContents.values()) {
      sessions.add(content.sessionUri);
    }
    for (const sessionUri of sessions) {
      if (!this.options.isCold(sessionUri)) {
        continue;
      }
      for (const uri of this.snapshots.keys()) {
        if (sessionUriOfChangeset(uri) === sessionUri) {
          this.snapshots.delete(uri);
        }
      }
      const isWatched = [...this.watched.values()].some((watched) => watched.sessionUri === sessionUri);
      this.forgetRevisionContents(sessionUri);
      if (!isWatched) {
        this.forgetEditContents(sessionUri);
      }
    }
  }

  ownsContent(uri: unknown): uri is string {
    return typeof uri === "string" && (uri.startsWith(REV_SCHEME) || uri.startsWith(EDIT_SCHEME));
  }

  // A changed file's content at a revision; only plain paths inside the repository's tree are reachable through git show.
  async read(uri: string, encoding: unknown): Promise<unknown> {
    if (uri.startsWith(EDIT_SCHEME)) {
      const cached = this.cachedEditContent(uri);
      if (!cached) {
        throw new RpcError(NOT_FOUND, "no such file or directory");
      }
      if (encoding === "base64") {
        return { data: Buffer.from(cached.text, "utf8").toString("base64"), encoding: "base64", contentType: "text/plain" };
      }
      return { data: cached.text, encoding: "utf-8", contentType: "text/plain" };
    }
    const query = revisionQuery(uri);
    const changeset = query.get("changeset") ?? "";
    const rev = query.get("rev");
    const segments = (query.get("file") ?? "").split("/");
    const match = CHANGESET_URI.exec(changeset);
    if (!match || !rev || !REVISION.test(rev) || segments.some((segment) => !segment) || segments.some(unsafeSegment)) {
      throw new RpcError(ErrorCodes.InvalidParams, "invalid changeset content uri");
    }
    const sessionUri = changeset.slice(0, match.index);
    const cwd = this.options.cwdOf(sessionUri);
    const cwdRoot = cwd ? await repoRoot(cwd) : undefined;
    const requestedRoot = query.get("root") ?? cwdRoot;
    const isAllowedRoot = requestedRoot === cwdRoot;
    const root = requestedRoot && isAbsolute(requestedRoot) && isAllowedRoot ? requestedRoot : undefined;
    if (!root) {
      throw new RpcError(NOT_FOUND, "no such file or directory");
    }
    const file = segments.join("/");
    const cacheKey = `${sessionUri}\0${JSON.stringify([root, rev, file])}`;
    let bytes = rev === "HEAD" ? undefined : this.cachedRevisionContent(cacheKey);
    try {
      bytes ??= await contentAt(root, rev, file);
      if (rev !== "HEAD") {
        this.rememberRevisionContent(sessionUri, cacheKey, bytes);
      }
    } catch {
      throw new RpcError(NOT_FOUND, "no such file or directory");
    }
    if (encoding === "base64") {
      return { data: bytes.toString("base64"), encoding: "base64", contentType: "text/plain" };
    }
    return { data: bytes.toString("utf8"), encoding: "utf-8", contentType: "text/plain" };
  }

  private async refresh(uri: string, watched: Watched): Promise<void> {
    if (watched.stopped || watched.computing) {
      return;
    }
    watched.computing = true;
    try {
      const files = await this.compute(uri, watched);
      watched.failures = 0;
      if (!watched.stopped) {
        this.apply(uri, watched, files);
      }
    } catch (err) {
      watched.failures += 1;
      if (watched.failures === 1) {
        log.debug(`computing ${uri} failed`, err instanceof Error ? err.message : err);
      }
      const held = this.core.store.state(uri) as ChangesetState | undefined;
      if (!watched.stopped && held?.status !== "error") {
        this.publishStatus(uri, {
          status: "error",
          error: { errorType: watched.id === "uncommitted" ? "git" : "history", message: err instanceof Error ? err.message : String(err) },
        });
      }
    } finally {
      watched.computing = false;
    }
    if (!watched.stopped) {
      const every = this.options.pollMs ?? POLL_MS;
      const delay = watched.failures === 0 ? every : Math.min(every * 2 ** watched.failures, Math.max(MAX_BACKOFF_MS, every));
      watched.timer = setTimeout(() => void this.refresh(uri, watched), delay);
      watched.timer.unref();
    }
  }

  private async compute(uri: string, watched: Watched): Promise<ChangesetFile[]> {
    const cwd = this.options.cwdOf(watched.sessionUri);
    if (!cwd) {
      return [];
    }
    if (watched.id === "turn") {
      const edits = this.options.turnEdits?.(watched.sessionUri, watched.turnId ?? "");
      if (!edits) {
        throw new Error("that turn is not loaded");
      }
      return mergeTurnEdits(edits);
    }
    if (watched.id === "uncommitted") {
      const changes = await workingChanges(cwd);
      return changes ? changes.files.map((file) => toChangesetFile(uri, changes.root, "HEAD", file)) : [];
    }
    await this.readEdits(watched, cwd);
    const directories = [...new Set([...watched.edited.keys()].map(dirname).filter((directory) => directory !== cwd))];
    this.options.onWorkdirs?.(watched.sessionUri, directories);
    return Promise.all([...watched.edited.values()].map((edit) => this.toSessionChangesetFile(uri, edit)));
  }

  private async readEdits(watched: Watched, cwd: string): Promise<void> {
    const now = Date.now();
    if (watched.editsReadAt !== 0 && now - watched.editsReadAt < (this.options.editsEveryMs ?? EDITS_EVERY_MS)) {
      return;
    }
    watched.editsReadAt = now;
    const edited = new Map<string, SessionEdit>();
    for (const hydraId of this.options.membersOf(watched.sessionUri)) {
      for (const file of await this.options.sessionEdits(hydraId)) {
        const path = isAbsolute(file.path) ? file.path : resolve(cwd, file.path);
        const prior = edited.get(path);
        edited.set(path, {
          path,
          hunks: [...(prior?.hunks ?? []), ...file.hunks],
          created: prior?.created ?? file.created,
        });
      }
    }
    watched.edited = edited;
  }

  private async toSessionChangesetFile(uri: string, file: SessionEdit): Promise<ChangesetFile> {
    const fileUri = cwdToUri(file.path);
    const created = file.created ?? file.hunks[0]?.oldText === "";
    const beforeUri = editContentUri(uri, fileUri, "before");
    let afterUri = fileUri;
    const recordedContent = recordedEditContent(file.hunks);
    const beforeText = recordedContent.before;
    const afterText = recordedContent.after;
    if (!created && recordedContent.usable) {
      this.rememberEditContent(watchedSessionUri(uri), beforeUri, beforeText);
    }
    try {
      const onDisk = await stat(file.path);
      if (!onDisk.isFile()) {
        afterUri = editContentUri(uri, fileUri, "after");
      } else if (!created && recordedContent.usable && onDisk.size === Buffer.byteLength(beforeText) && (await readFile(file.path, "utf8")) === beforeText) {
        // The edits are gone from disk (reset, checkout); show what the session wrote, not an empty diff.
        afterUri = editContentUri(uri, fileUri, "after");
      }
    } catch {
      afterUri = editContentUri(uri, fileUri, "after");
    }
    if (afterUri !== fileUri && recordedContent.usable) {
      this.rememberEditContent(watchedSessionUri(uri), afterUri, afterText);
    }
    const chain = snapshotChain(file.hunks);
    const { added, removed } = chain
      ? lineDiffCounts(chain.before, chain.after)
      : {
          added: file.hunks.reduce((total, hunk) => total + lineCount(hunk.newText), 0),
          removed: file.hunks.reduce((total, hunk) => total + lineCount(hunk.oldText), 0),
        };
    return {
      id: fileUri,
      edit: {
        ...(!created && recordedContent.usable ? { before: { uri: fileUri, content: { uri: beforeUri } } } : {}),
        after: { uri: fileUri, content: { uri: afterUri } },
        diff: { added, removed },
      },
    } as ChangesetFile;
  }

  private apply(uri: string, watched: Watched, files: ChangesetFile[]): void {
    const next = new Map(files.map((file) => [file.id, file]));
    for (const id of watched.files.keys()) {
      if (!next.has(id)) {
        this.core.publish(uri, action({ type: "changeset/fileRemoved", fileId: id }));
      }
    }
    for (const [id, file] of next) {
      if (JSON.stringify(watched.files.get(id)) !== JSON.stringify(file)) {
        this.core.publish(uri, action({ type: "changeset/fileSet", file }));
      }
    }
    watched.files = next;
    this.rememberSnapshot(uri, files);
    if (watched.id === "session") {
      this.options.onSessionTotals?.(watched.sessionUri, totalsOf(files));
    }
    const state = this.core.store.state(uri) as ChangesetState | undefined;
    if (state?.status !== "ready") {
      this.publishStatus(uri, { status: "ready" });
    }
  }

  private publishStatus(uri: string, status: Record<string, unknown>): void {
    this.core.publish(uri, action({ type: "changeset/statusChanged", ...status }));
  }

  private rememberSnapshot(uri: string, files: ChangesetFile[]): void {
    const sessionUri = sessionUriOfChangeset(uri);
    if (sessionUri && this.options.isCold?.(sessionUri)) {
      this.snapshots.delete(uri);
      return;
    }
    this.snapshots.delete(uri);
    this.snapshots.set(uri, files);
    while (this.snapshots.size > MAX_CACHED_CHANNELS) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.snapshots.delete(oldest);
    }
  }

  private cachedRevisionContent(key: string): Buffer | undefined {
    const bytes = this.revisionContents.get(key);
    if (!bytes) {
      return undefined;
    }
    this.revisionContents.delete(key);
    this.revisionContents.set(key, bytes);
    return bytes;
  }

  private cachedEditContent(uri: string): CachedEditContent | undefined {
    const key = editContentKey(uri);
    const content = this.editContents.get(key);
    if (!content) {
      return undefined;
    }
    this.editContents.delete(key);
    this.editContents.set(key, content);
    return content;
  }

  private rememberEditContent(sessionUri: string, uri: string, text: string): void {
    const key = editContentKey(uri);
    const previous = this.editContents.get(key);
    if (previous) {
      this.editContentBytes -= Buffer.byteLength(previous.text);
      this.editContents.delete(key);
    }
    this.editContents.set(key, { sessionUri, text });
    this.editContentBytes += Buffer.byteLength(text);
    while (this.editContentBytes > MAX_CACHED_REVISION_BYTES || this.editContents.size > MAX_CACHED_REVISION_ENTRIES) {
      const oldest = this.editContents.keys().next().value;
      if (oldest === undefined || oldest === key) {
        break;
      }
      const evicted = this.editContents.get(oldest);
      if (evicted) {
        this.editContentBytes -= Buffer.byteLength(evicted.text);
      }
      this.editContents.delete(oldest);
    }
  }

  private rememberRevisionContent(sessionUri: string, key: string, bytes: Buffer): void {
    if (this.options.isCold?.(sessionUri)) {
      return;
    }
    if (bytes.length > MAX_CACHED_REVISION_ENTRY_BYTES) {
      return;
    }
    const previous = this.revisionContents.get(key);
    if (previous) {
      this.revisionContentBytes -= previous.length;
      this.revisionContents.delete(key);
    }
    this.revisionContents.set(key, bytes);
    this.revisionContentBytes += bytes.length;
    while (this.revisionContentBytes > MAX_CACHED_REVISION_BYTES || this.revisionContents.size > MAX_CACHED_REVISION_ENTRIES) {
      const oldest = this.revisionContents.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      const evicted = this.revisionContents.get(oldest);
      if (evicted) {
        this.revisionContentBytes -= evicted.length;
      }
      this.revisionContents.delete(oldest);
    }
  }

  private forgetRevisionContents(sessionUri: string): void {
    const prefix = `${sessionUri}\0`;
    for (const [key, bytes] of this.revisionContents) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      this.revisionContents.delete(key);
      this.revisionContentBytes -= bytes.length;
    }
  }

  private forgetEditContents(sessionUri: string): void {
    for (const [uri, content] of this.editContents) {
      if (content.sessionUri !== sessionUri) {
        continue;
      }
      this.editContents.delete(uri);
      this.editContentBytes -= Buffer.byteLength(content.text);
    }
  }
}

function sessionUriOfChangeset(uri: string): string | undefined {
  const match = CHANGESET_URI.exec(uri);
  return match ? uri.slice(0, match.index) : undefined;
}

function decodeTurnId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// A file edited more than once in a turn shows from its first before to its last after, with the line counts added up.
function mergeTurnEdits(edits: readonly TurnFileEdit[]): ChangesetFile[] {
  const merged = new Map<string, TurnFileEdit>();
  for (const edit of edits) {
    const prior = merged.get(edit.fileUri);
    if (!prior) {
      merged.set(edit.fileUri, { ...edit, ...(edit.diff ? { diff: { ...edit.diff } } : {}) });
      continue;
    }
    const added = (prior.diff?.added ?? 0) + (edit.diff?.added ?? 0);
    const removed = (prior.diff?.removed ?? 0) + (edit.diff?.removed ?? 0);
    merged.set(edit.fileUri, {
      fileUri: edit.fileUri,
      ...(prior.before ? { before: prior.before } : {}),
      ...(edit.after ? { after: edit.after } : {}),
      ...(prior.diff || edit.diff ? { diff: { added, removed } } : {}),
    });
  }
  return [...merged.values()].map((edit) => ({
    id: edit.fileUri,
    edit: {
      ...(edit.before ? { before: edit.before } : {}),
      ...(edit.after ? { after: edit.after } : {}),
      ...(edit.diff ? { diff: edit.diff } : {}),
    },
  })) as unknown as ChangesetFile[];
}

function unsafeSegment(segment: string): boolean {
  return segment === "" || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\");
}

function totalsOf(files: ChangesetFile[]): { additions: number; deletions: number; files: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    const diff = (file.edit as { diff?: { added?: number; removed?: number } }).diff;
    additions += diff?.added ?? 0;
    deletions += diff?.removed ?? 0;
  }
  return { additions, deletions, files: files.length };
}

// VS Code labels a diff side by its content URI's path, so that is the file's own path; what git needs rides in the query.
function revisionUri(fileUri: string, changesetUri: string, root: string, rev: string, path: string): string {
  const query = new URLSearchParams({ changeset: changesetUri, root, rev, file: path });
  return `${REV_SCHEME}${new URL(fileUri).pathname}?${query.toString()}`;
}

// VS Code hands the query back percent-encoded as a whole, '=' and '&' included.
function revisionQuery(uri: string): URLSearchParams {
  const raw = uri.slice(uri.indexOf("?") + 1);
  const query = new URLSearchParams(raw);
  if (query.has("changeset")) {
    return query;
  }
  try {
    return new URLSearchParams(decodeURIComponent(raw));
  } catch {
    return query;
  }
}

// The path is only a label for the client; the key in the query is what identifies the content.
function editContentUri(changesetUri: string, fileUri: string, side: "before" | "after"): string {
  const id = Buffer.from(JSON.stringify([changesetUri, fileUri, side])).toString("base64url");
  return `${EDIT_SCHEME}${new URL(fileUri).pathname}?key=${id}`;
}

// VS Code hands the query back percent-encoded as a whole, '=' included, so content is keyed by the id alone.
function editContentKey(uri: string): string {
  const raw = uri.slice(uri.indexOf("?") + 1);
  let query = raw;
  if (!raw.startsWith("key=")) {
    try {
      query = decodeURIComponent(raw);
    } catch {
      return uri;
    }
  }
  return query.startsWith("key=") ? query.slice("key=".length) : uri;
}

function recordedEditContent(hunks: SessionEdit["hunks"]): { before: string; after: string; usable: boolean; bounded: boolean } {
  if (hunks.length === 0) {
    return { before: "", after: "", usable: false, bounded: false };
  }
  if (hunks.some((hunk) => hunk.oldText.includes("\0") || hunk.newText.includes("\0"))) {
    return { before: "", after: "", usable: false, bounded: false };
  }
  const snapshots = snapshotChain(hunks);
  if (snapshots) {
    const biggest = Math.max(Buffer.byteLength(snapshots.before), Buffer.byteLength(snapshots.after));
    return { ...snapshots, usable: biggest <= MAX_CACHED_REVISION_ENTRY_BYTES, bounded: true };
  }
  const before = hunks.map((hunk) => hunk.oldText).join("");
  const after = hunks.map((hunk) => hunk.newText).join("");
  const lines = lineCount(before) + lineCount(after);
  const bytes = Buffer.byteLength(before) + Buffer.byteLength(after);
  const completeSnapshot = hunks.length === 1;
  const bounded = lines <= MAX_RECORDED_DIFF_LINES && bytes <= MAX_RECORDED_DIFF_BYTES;
  return {
    before: completeSnapshot ? before : bounded ? addHunkSeparators(hunks, "oldText") : "",
    after: completeSnapshot ? after : bounded ? addHunkSeparators(hunks, "newText") : "",
    usable: completeSnapshot && bounded,
    bounded,
  };
}

// Whole-file hunks compose into one: the first before and the last after are the session's change. A daemon
// that does not tag scope leaves a chain (each edit starts from the previous result, or from the original
// again after an outside reset) as the only sign of whole-file snapshots.
function snapshotChain(hunks: SessionEdit["hunks"]): { before: string; after: string } | undefined {
  const first = hunks[0];
  const last = hunks[hunks.length - 1];
  if (!first || !last || hunks.some((hunk) => hunk.scope === "snippet")) {
    return undefined;
  }
  const tagged = hunks.every((hunk) => hunk.scope === "file");
  if (hunks.length < 2 && !tagged) {
    return undefined;
  }
  const chained = hunks.every((hunk, index) => index === 0 || hunk.oldText === hunks[index - 1]?.newText || hunk.oldText === first.oldText);
  return tagged || chained ? { before: first.oldText, after: last.newText } : undefined;
}

// Past this many changed lines a diff is reported as a rewrite rather than computed.
const MAX_DIFF_EDITS = 5_000;

function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

// Added and removed line counts between two texts. The shortest edit script (Myers) is as long as the lines
// that changed, so a few edits scattered through a large file cost little.
function lineDiffCounts(before: string, after: string): { added: number; removed: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const edits = shortestEditLength(x, y, Math.min(x.length + y.length, MAX_DIFF_EDITS));
  if (edits === undefined) {
    return { added: y.length, removed: x.length };
  }
  const delta = y.length - x.length;
  return { added: (edits + delta) / 2, removed: (edits - delta) / 2 };
}

function shortestEditLength(a: string[], b: string[], limit: number): number | undefined {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return n + m;
  }
  const offset = limit + 1;
  const reach = new Int32Array(2 * limit + 3);
  for (let d = 0; d <= limit; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && (reach[offset + k - 1] as number) < (reach[offset + k + 1] as number)) ? (reach[offset + k + 1] as number) : (reach[offset + k - 1] as number) + 1;
      let j = i - k;
      while (i < n && j < m && a[i] === b[j]) {
        i += 1;
        j += 1;
      }
      reach[offset + k] = i;
      if (i >= n && j >= m) {
        return d;
      }
    }
  }
  return undefined;
}

function addHunkSeparators(hunks: SessionEdit["hunks"], side: "oldText" | "newText"): string {
  return hunks.map((hunk, index) => `// Recorded edit ${index + 1}\n${hunk[side]}`).join("\n");
}

function watchedSessionUri(uri: string): string {
  return sessionUriOfChangeset(uri) ?? "";
}

function lineCount(text: string): number {
  if (text === "") {
    return 0;
  }
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function toChangesetFile(changesetUri: string, root: string, rev: string, file: ChangedFile): ChangesetFile {
  const fileUri = cwdToUri(join(root, file.path));
  const beforeUri = revisionUri(fileUri, changesetUri, root, rev, file.path);
  const counts = { ...(file.added !== undefined ? { added: file.added } : {}), ...(file.removed !== undefined ? { removed: file.removed } : {}) };
  return {
    id: fileUri,
    edit: {
      ...(file.inHead ? { before: { uri: fileUri, content: { uri: beforeUri } } } : {}),
      ...(file.onDisk ? { after: { uri: fileUri, content: { uri: fileUri } } } : {}),
      ...(Object.keys(counts).length > 0 ? { diff: counts } : {}),
    },
  } as ChangesetFile;
}
