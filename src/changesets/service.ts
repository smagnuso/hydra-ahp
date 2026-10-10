import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Changeset, ChangesetFile, ChangesetState } from "@microsoft/agent-host-protocol";
import { cwdToUri } from "../bridge/ids.js";
import type { ProtocolCore } from "../protocol/core.js";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import { logger } from "../util/log.js";
import { contentAt, repoRoot, workingChanges, type ChangedFile } from "./git.js";

const log = logger("changesets");

type ChangesetId = "session" | "uncommitted";

const SEGMENT = "/changeset/";
const REV_SCHEME = "ahp-rev:";
const EDIT_SCHEME = "ahp-changeset:";
const CHANGESET_URI = /\/changeset\/(session|uncommitted)$/;
const REVISION = /^(HEAD|[0-9a-f]{40}|[0-9a-f]{64})$/;
const POLL_MS = 2_000;
// Hydra walks a session's history to list its edits, so new ones are picked up less often than the tree is checked.
const EDITS_EVERY_MS = 10_000;
const NOT_FOUND = -32008;
const MAX_CACHED_CHANNELS = 128;
const MAX_CACHED_REVISION_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_REVISION_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_REVISION_ENTRIES = 4096;

export function changesetUri(sessionUri: string, id: ChangesetId): string {
  return `${sessionUri}${SEGMENT}${id}`;
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
  ];
}

export interface ChangesetServiceOptions {
  // The working directory of a session on this machine; undefined for sessions whose files live elsewhere.
  cwdOf: (sessionUri: string) => string | undefined;
  // The Hydra sessions behind an AHP session.
  membersOf: (sessionUri: string) => string[];
  // Per-file edit hunks recorded in each Hydra session's history.
  sessionEdits: (hydraId: string) => Promise<SessionEdit[]>;
  isCold?: (sessionUri: string) => boolean;
  // Receives the session changeset's line and file totals each time it is computed.
  onSessionTotals?: (sessionUri: string, totals: { additions: number; deletions: number; files: number }) => void;
  // Receives directories outside the session cwd that contain recorded edits.
  onWorkdirs?: (sessionUri: string, directories: string[]) => void;
  pollMs?: number;
  editsEveryMs?: number;
}

export interface SessionEdit {
  path: string;
  hunks: Array<{ oldText: string; newText: string }>;
  created?: boolean;
}

interface Watched {
  id: ChangesetId;
  sessionUri: string;
  files: Map<string, ChangesetFile>;
  timer?: NodeJS.Timeout;
  computing: boolean;
  stopped: boolean;
  edited: Map<string, SessionEdit>;
  editsReadAt: number;
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
    const watched: Watched = {
      id: match[1] as ChangesetId,
      sessionUri,
      files: new Map((cached ?? []).map((file) => [file.id, file])),
      computing: false,
      stopped: false,
      edited: new Map(),
      editsReadAt: 0,
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
      if (!watched.stopped) {
        this.apply(uri, watched, files);
      }
    } catch (err) {
      log.debug(`computing ${uri} failed`, err instanceof Error ? err.message : err);
      if (!watched.stopped) {
        this.publishStatus(uri, {
          status: "error",
          error: { errorType: watched.id === "session" ? "history" : "git", message: err instanceof Error ? err.message : String(err) },
        });
      }
    } finally {
      watched.computing = false;
    }
    if (!watched.stopped) {
      watched.timer = setTimeout(() => void this.refresh(uri, watched), this.options.pollMs ?? POLL_MS);
      watched.timer.unref();
    }
  }

  private async compute(uri: string, watched: Watched): Promise<ChangesetFile[]> {
    const cwd = this.options.cwdOf(watched.sessionUri);
    if (!cwd) {
      return [];
    }
    if (watched.id === "uncommitted") {
      const changes = await workingChanges(cwd);
      return changes ? changes.files.map((file) => toChangesetFile(uri, changes.root, "HEAD", file)) : [];
    }
    await this.readEdits(watched, cwd);
    const directories = [...new Set([...watched.edited.keys()].map(dirname).filter((directory) => directory !== cwd))];
    this.options.onWorkdirs?.(watched.sessionUri, directories);
    return [...watched.edited.values()].flatMap((edit) =>
      edit.hunks.map((hunk, index) => this.toSessionChangesetFile(uri, edit, hunk, index)),
    );
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

  private toSessionChangesetFile(
    uri: string,
    file: SessionEdit,
    hunk: SessionEdit["hunks"][number],
    index: number,
  ): ChangesetFile {
    const fileUri = cwdToUri(file.path);
    const created = index === 0 && (file.created ?? hunk.oldText === "");
    const beforeUri = editContentUri(uri, fileUri, index, "before");
    const afterUri = editContentUri(uri, fileUri, index, "after");
    this.rememberEditContent(watchedSessionUri(uri), beforeUri, hunk.oldText);
    this.rememberEditContent(watchedSessionUri(uri), afterUri, hunk.newText);
    return {
      id: index === 0 ? fileUri : `${fileUri}#ahp-hunk-${index}`,
      edit: {
        ...(!created ? { before: { uri: fileUri, content: { uri: beforeUri } } } : {}),
        after: { uri: fileUri, content: { uri: afterUri } },
        diff: { added: lineCount(hunk.newText), removed: lineCount(hunk.oldText) },
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
    const content = this.editContents.get(uri);
    if (!content) {
      return undefined;
    }
    this.editContents.delete(uri);
    this.editContents.set(uri, content);
    return content;
  }

  private rememberEditContent(sessionUri: string, uri: string, text: string): void {
    const previous = this.editContents.get(uri);
    if (previous) {
      this.editContentBytes -= Buffer.byteLength(previous.text);
      this.editContents.delete(uri);
    }
    this.editContents.set(uri, { sessionUri, text });
    this.editContentBytes += Buffer.byteLength(text);
    while (this.editContentBytes > MAX_CACHED_REVISION_BYTES || this.editContents.size > MAX_CACHED_REVISION_ENTRIES) {
      const oldest = this.editContents.keys().next().value;
      if (oldest === undefined || oldest === uri) {
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

function unsafeSegment(segment: string): boolean {
  return segment === "" || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\");
}

function totalsOf(files: ChangesetFile[]): { additions: number; deletions: number; files: number } {
  let additions = 0;
  let deletions = 0;
  const fileIds = new Set<string>();
  for (const file of files) {
    fileIds.add(file.id.replace(/#ahp-hunk-\d+$/, ""));
    const diff = (file.edit as { diff?: { added?: number; removed?: number } }).diff;
    additions += diff?.added ?? 0;
    deletions += diff?.removed ?? 0;
  }
  return { additions, deletions, files: fileIds.size };
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

function editContentUri(changesetUri: string, fileUri: string, index: number, side: "before" | "after"): string {
  const id = Buffer.from(JSON.stringify([changesetUri, fileUri, index, side])).toString("base64url");
  return `${EDIT_SCHEME}${id}`;
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
