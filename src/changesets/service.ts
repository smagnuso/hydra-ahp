import { dirname, isAbsolute, join, relative } from "node:path";
import { stat } from "node:fs/promises";
import type { Changeset, ChangesetFile, ChangesetState } from "@microsoft/agent-host-protocol";
import { cwdToUri } from "../bridge/ids.js";
import type { ProtocolCore } from "../protocol/core.js";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import { logger } from "../util/log.js";
import { changesSince, commitAt, contentAt, repoRoot, workingChanges, type ChangedFile } from "./git.js";

const log = logger("changesets");

type ChangesetId = "session" | "uncommitted";

const SEGMENT = "/changeset/";
const REV_SCHEME = "ahp-rev:";
const CHANGESET_URI = /\/changeset\/(session|uncommitted)$/;
const REVISION = /^(HEAD|[0-9a-f]{40}|[0-9a-f]{64})$/;
const POLL_MS = 2_000;
// Hydra walks a session's history to list its edits, so new ones are picked up less often than the tree is checked.
const EDITS_EVERY_MS = 10_000;
const NOT_FOUND = -32008;

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
      description: "Files the agent edited in this session, compared with where the branch was when it started",
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
  // The Hydra sessions behind an AHP session, and when the first of them was created.
  membersOf: (sessionUri: string) => string[];
  startedAt: (sessionUri: string) => string | undefined;
  // Absolute paths a Hydra session's tool calls edited, as Hydra aggregates them from its history.
  editedPaths: (hydraId: string) => Promise<string[]>;
  // Receives the session changeset's line and file totals each time it is computed.
  onSessionTotals?: (sessionUri: string, totals: { additions: number; deletions: number; files: number }) => void;
  // Receives Git roots outside the session's initial repository that its edits reached.
  onWorkdirs?: (sessionUri: string, directories: string[]) => void;
  pollMs?: number;
  editsEveryMs?: number;
}

interface Watched {
  id: ChangesetId;
  sessionUri: string;
  files: Map<string, ChangesetFile>;
  timer?: NodeJS.Timeout;
  computing: boolean;
  stopped: boolean;
  edited: Set<string>;
  rootsByDirectory: Map<string, string>;
  editsReadAt: number;
  bases?: Map<string, string | undefined>;
}

const action = (value: Record<string, unknown>) => value as never;

// Serves each local session's changes as AHP changesets, recomputed from git while someone watches them.
export class ChangesetService {
  private core!: ProtocolCore;
  private readonly watched = new Map<string, Watched>();
  private readonly repoRoots = new Map<string, Set<string>>();

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
    const watched: Watched = {
      id: match[1] as ChangesetId,
      sessionUri,
      files: new Map(),
      computing: false,
      stopped: false,
      edited: new Set(),
      rootsByDirectory: new Map(),
      editsReadAt: 0,
    };
    this.watched.set(uri, watched);
    this.core.createChannel(uri, { status: "computing", files: [] } as unknown as ChangesetState);
    void this.refresh(uri, watched);
  }

  detach(uri: string): void {
    const watched = this.watched.get(uri);
    if (!watched) {
      return;
    }
    watched.stopped = true;
    clearTimeout(watched.timer);
    this.watched.delete(uri);
    this.core.removeChannel(uri);
  }

  stop(): void {
    for (const uri of [...this.watched.keys()]) {
      this.detach(uri);
    }
  }

  ownsContent(uri: unknown): uri is string {
    return typeof uri === "string" && uri.startsWith(REV_SCHEME);
  }

  // A changed file's content at a revision; only plain paths inside the repository's tree are reachable through git show.
  async read(uri: string, encoding: unknown): Promise<unknown> {
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
    const isAllowedRoot = requestedRoot === cwdRoot || this.repoRoots.get(sessionUri)?.has(requestedRoot ?? "");
    const root = requestedRoot && isAbsolute(requestedRoot) && isAllowedRoot ? requestedRoot : undefined;
    if (!root) {
      throw new RpcError(NOT_FOUND, "no such file or directory");
    }
    let bytes: Buffer;
    try {
      bytes = await contentAt(root, rev, segments.join("/"));
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
        this.publishStatus(uri, { status: "error", error: { errorType: "git", message: err instanceof Error ? err.message : String(err) } });
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
    await this.readEdits(watched);
    const byRoot = new Map<string, Set<string>>();
    for (const path of watched.edited) {
      const root = await repoRootForPath(path, watched.rootsByDirectory);
      if (!root) {
        continue;
      }
      const relativePath = relative(root, path);
      if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
        continue;
      }
      const paths = byRoot.get(root) ?? new Set<string>();
      paths.add(relativePath);
      byRoot.set(root, paths);
    }
    const roots = new Set(byRoot.keys());
    this.repoRoots.set(watched.sessionUri, roots);
    const initialRoot = await repoRoot(cwd);
    const additionalRoots = [...roots].filter((root) => root !== initialRoot);
    this.options.onWorkdirs?.(watched.sessionUri, additionalRoots);
    const started = this.options.startedAt(watched.sessionUri);
    const files = await Promise.all([...byRoot].map(async ([root, paths]) => {
      watched.bases ??= new Map();
      if (!watched.bases.has(root)) {
        watched.bases.set(root, started ? await commitAt(root, started) : undefined);
      }
      const base = watched.bases.get(root);
      const changed = await changesSince(root, base, [...paths]);
      return changed.map((file) => toChangesetFile(uri, root, base ?? "HEAD", file));
    }));
    return files.flat();
  }

  private async readEdits(watched: Watched): Promise<void> {
    const now = Date.now();
    if (watched.editsReadAt !== 0 && now - watched.editsReadAt < (this.options.editsEveryMs ?? EDITS_EVERY_MS)) {
      return;
    }
    watched.editsReadAt = now;
    for (const hydraId of this.options.membersOf(watched.sessionUri)) {
      for (const path of await this.options.editedPaths(hydraId)) {
        if (isAbsolute(path)) {
          watched.edited.add(path);
        }
      }
    }
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

async function repoRootForPath(path: string, cache: Map<string, string>): Promise<string | undefined> {
  let directory = dirname(path);
  const visited: string[] = [];
  while (true) {
    if (cache.has(directory)) {
      const root = cache.get(directory) as string;
      return root;
    }
    visited.push(directory);
    try {
      if ((await stat(directory)).isDirectory()) {
        const root = await repoRoot(directory);
        if (root) {
          for (const candidate of visited) {
            cache.set(candidate, root);
          }
          return root;
        }
      }
    } catch {
      // Deleted paths may have missing parent directories, so keep walking upward.
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}
