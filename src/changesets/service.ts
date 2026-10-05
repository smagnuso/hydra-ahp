import type { Changeset, ChangesetFile, ChangesetState } from "@microsoft/agent-host-protocol";
import { cwdToUri } from "../bridge/ids.js";
import type { ProtocolCore } from "../protocol/core.js";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import { logger } from "../util/log.js";
import { headContent, workingChanges, type ChangedFile } from "./git.js";

const log = logger("changesets");

const UNCOMMITTED = "/changeset/uncommitted";
const HEAD_SEGMENT = "/head/";
const POLL_MS = 2_000;
const NOT_FOUND = -32008;

export function uncommittedUri(sessionUri: string): string {
  return `${sessionUri}${UNCOMMITTED}`;
}

export function isChangesetUri(uri: string): boolean {
  return uri.endsWith(UNCOMMITTED) && uri.length > UNCOMMITTED.length;
}

export function changesetsFor(sessionUri: string): Changeset[] {
  return [
    {
      label: "Uncommitted Changes",
      description: "Everything in the session's repository that differs from HEAD",
      uriTemplate: uncommittedUri(sessionUri),
      changeKind: "uncommitted",
    },
  ];
}

export interface ChangesetServiceOptions {
  // The working directory of a session on this machine; undefined for sessions whose files live elsewhere.
  cwdOf: (sessionUri: string) => string | undefined;
  pollMs?: number;
}

interface Watched {
  sessionUri: string;
  files: Map<string, ChangesetFile>;
  timer?: NodeJS.Timeout;
  computing: boolean;
  stopped: boolean;
}

const action = (value: Record<string, unknown>) => value as never;

// Serves each local session's uncommitted git changes as an AHP changeset, recomputed while someone watches it.
export class ChangesetService {
  private core!: ProtocolCore;
  private readonly watched = new Map<string, Watched>();

  constructor(private readonly options: ChangesetServiceOptions) {}

  start(core: ProtocolCore): void {
    this.core = core;
  }

  attach(uri: string): void {
    if (this.watched.has(uri)) {
      return;
    }
    const sessionUri = uri.slice(0, -UNCOMMITTED.length);
    if (!this.options.cwdOf(sessionUri)) {
      return;
    }
    const watched: Watched = { sessionUri, files: new Map(), computing: false, stopped: false };
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
    return typeof uri === "string" && uri.includes(`${UNCOMMITTED}${HEAD_SEGMENT}`);
  }

  // The HEAD side of a changed file; only paths inside the repository's tree are reachable through git show.
  async read(uri: string, encoding: unknown): Promise<unknown> {
    const at = uri.indexOf(`${UNCOMMITTED}${HEAD_SEGMENT}`);
    const sessionUri = uri.slice(0, at);
    const segments = uri.slice(at + UNCOMMITTED.length + HEAD_SEGMENT.length).split("/").map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))) {
      throw new RpcError(ErrorCodes.InvalidParams, "invalid changeset content path");
    }
    const cwd = this.options.cwdOf(sessionUri);
    const changes = cwd ? await workingChanges(cwd) : undefined;
    if (!changes) {
      throw new RpcError(NOT_FOUND, "no such file or directory");
    }
    let bytes: Buffer;
    try {
      bytes = await headContent(changes.root, segments.join("/"));
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
      const cwd = this.options.cwdOf(watched.sessionUri);
      const changes = cwd ? await workingChanges(cwd) : undefined;
      if (!watched.stopped) {
        this.apply(uri, watched, changes ? changes.files.map((file) => toChangesetFile(uri, changes.root, file)) : []);
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

function toChangesetFile(changesetUri: string, root: string, file: ChangedFile): ChangesetFile {
  const fileUri = cwdToUri(`${root}/${file.path}`);
  const headUri = `${changesetUri}${HEAD_SEGMENT}${file.path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
  const diff = file.added !== undefined || file.removed !== undefined ? { diff: { ...(file.added !== undefined ? { added: file.added } : {}), ...(file.removed !== undefined ? { removed: file.removed } : {}) } } : {};
  return {
    id: fileUri,
    edit: {
      ...(file.inHead ? { before: { uri: fileUri, content: { uri: headUri } } } : {}),
      ...(file.onDisk ? { after: { uri: fileUri, content: { uri: fileUri } } } : {}),
      ...diff,
    },
  } as ChangesetFile;
}
