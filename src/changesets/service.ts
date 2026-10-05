import { isAbsolute, relative } from "node:path";
import type { Changeset, ChangesetFile, ChangesetState } from "@microsoft/agent-host-protocol";
import { cwdToUri } from "../bridge/ids.js";
import type { ProtocolCore } from "../protocol/core.js";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import { logger } from "../util/log.js";
import { changesSince, commitAt, contentAt, repoRoot, workingChanges, type ChangedFile } from "./git.js";

const log = logger("changesets");

type ChangesetId = "session" | "uncommitted";

const SEGMENT = "/changeset/";
const AT_SEGMENT = "/at/";
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
  editsReadAt: number;
  base?: { commit: string | undefined };
}

const action = (value: Record<string, unknown>) => value as never;

// Serves each local session's changes as AHP changesets, recomputed from git while someone watches them.
export class ChangesetService {
  private core!: ProtocolCore;
  private readonly watched = new Map<string, Watched>();

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
    return typeof uri === "string" && uri.includes(SEGMENT) && uri.includes(AT_SEGMENT);
  }

  // A changed file's content at a revision; only plain paths inside the repository's tree are reachable through git show.
  async read(uri: string, encoding: unknown): Promise<unknown> {
    const at = uri.indexOf(AT_SEGMENT);
    const changeset = uri.slice(0, at);
    const match = CHANGESET_URI.exec(changeset);
    const [rev, ...segments] = uri.slice(at + AT_SEGMENT.length).split("/").map((segment) => decodeURIComponent(segment));
    if (!match || !rev || !REVISION.test(rev) || segments.length === 0 || segments.some(unsafeSegment)) {
      throw new RpcError(ErrorCodes.InvalidParams, "invalid changeset content uri");
    }
    const cwd = this.options.cwdOf(changeset.slice(0, match.index));
    const root = cwd ? await repoRoot(cwd) : undefined;
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
    const root = await repoRoot(cwd);
    if (!root) {
      return [];
    }
    if (!watched.base) {
      const started = this.options.startedAt(watched.sessionUri);
      watched.base = { commit: started ? await commitAt(root, started) : undefined };
    }
    await this.readEdits(watched);
    const paths = [...watched.edited]
      .map((path) => relative(root, path))
      .filter((path) => path !== "" && !path.startsWith("..") && !isAbsolute(path));
    const files = await changesSince(root, watched.base.commit, paths);
    return files.map((file) => toChangesetFile(uri, root, watched.base?.commit ?? "HEAD", file));
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

function toChangesetFile(changesetUri: string, root: string, rev: string, file: ChangedFile): ChangesetFile {
  const fileUri = cwdToUri(`${root}/${file.path}`);
  const beforeUri = `${changesetUri}${AT_SEGMENT}${rev}/${file.path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
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
