import { createHash } from "node:crypto";
import { watch as fsWatch, type FSWatcher, type WatchEventType } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { ResourceChangeType, type ResourceChange, type ResourceWatchState } from "@microsoft/agent-host-protocol";
import { cwdToUri, uriToCwd } from "../bridge/ids.js";
import type { ClientContext } from "../protocol/backend.js";
import { isResourceWatchUri } from "../protocol/channels.js";
import type { ProtocolCore } from "../protocol/core.js";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import { logger } from "../util/log.js";
import { pathMatcher } from "./glob.js";
import type { FileService } from "./service.js";

const log = logger("watch");

const METHOD = "createResourceWatch";
const DEBOUNCE_MS = 50;
// A watch nobody subscribes to is dropped after this long.
const UNSUBSCRIBED_GRACE_MS = 30_000;
// Directories watched across all watches; a tree past this is only watched in part.
const MAX_DIRECTORIES = 8192;
// Never reported: VCS internals and installed packages, which VS Code asks for anyway and which would cost thousands of watches.
const DEFAULT_EXCLUDES = ["**/.git", "**/.hg", "**/.svn", "**/node_modules"];

type Json = Record<string, unknown>;

type Watch = (path: string, listener: (event: WatchEventType, name: string | Buffer | null) => void) => FSWatcher;

export interface ResourceWatchServiceOptions {
  files: Pick<FileService, "authorizeWatch">;
  // Tests inject a fake or tune the timings.
  watch?: Watch;
  debounceMs?: number;
  graceMs?: number;
  maxDirectories?: number;
}

interface Running {
  root: string;
  state: ResourceWatchState;
  isDirectory: boolean;
  excluded: (relativePath: string) => boolean;
  included: ((relativePath: string) => boolean) | undefined;
  watched: Map<string, DirectoryListener>;
  known: Set<string>;
  capWarned: boolean;
  pending: Set<string>;
  timer: NodeJS.Timeout | undefined;
  stopped: boolean;
}

type DirectoryListener = (name: string | Buffer | null) => void;

// One OS watcher per path, shared by every watch that covers it.
interface SharedWatcher {
  watcher: FSWatcher;
  listeners: Set<DirectoryListener>;
}

const action = (value: Record<string, unknown>) => value as never;

// Every URI here came from cwdToUri, so it always names a local path.
function localPath(uri: string): string {
  const path = uriToCwd(uri);
  if (path === undefined) {
    throw new Error(`not a local file URI: ${uri}`);
  }
  return path;
}

function patternsOf(value: unknown): string[] | undefined {
  const items = (value as { items?: unknown } | undefined)?.items;
  const list = Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];
  return list.length > 0 ? list : undefined;
}

// Reports file changes under a path to clients that subscribe to the watch channel, within what their token may read.
export class ResourceWatchService {
  private core!: ProtocolCore;
  private readonly files: Pick<FileService, "authorizeWatch">;
  private readonly watch: Watch;
  private readonly running = new Map<string, Running>();
  private readonly states = new Map<string, ResourceWatchState>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly shared = new Map<string, SharedWatcher>();

  constructor(private readonly options: ResourceWatchServiceOptions) {
    this.files = options.files;
    this.watch = options.watch ?? ((path, listener) => fsWatch(path, { persistent: false }, listener));
  }

  start(core: ProtocolCore): void {
    this.core = core;
  }

  stop(): void {
    for (const uri of [...this.running.keys()]) {
      this.release(uri);
    }
    for (const timer of this.graceTimers.values()) {
      clearTimeout(timer);
    }
    this.graceTimers.clear();
  }

  handles(method: string): boolean {
    return method === METHOD;
  }

  async handle(_method: string, rawParams: unknown, client: ClientContext): Promise<{ channel: string }> {
    const params = (rawParams ?? {}) as Json;
    log.debug(`createResourceWatch ${JSON.stringify({ uri: params.uri, recursive: params.recursive, excludes: params.excludes, includes: params.includes })}`);
    const root = await this.files.authorizeWatch(client.token.level, params);
    const excludes = patternsOf(params.excludes);
    const includes = patternsOf(params.includes);
    const state: ResourceWatchState = {
      root: cwdToUri(root),
      recursive: params.recursive === true,
      ...(excludes ? { excludes: { items: excludes } } : {}),
      ...(includes ? { includes: { items: includes } } : {}),
    };
    // The same request from several clients shares one watch.
    const id = createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 24);
    const channel = `ahp-resource-watch:/${id}`;
    if (!this.core.store.has(channel)) {
      this.core.createChannel(channel, state);
      this.states.set(channel, state);
      this.armGrace(channel);
    }
    return { channel };
  }

  async attach(uri: string): Promise<void> {
    clearTimeout(this.graceTimers.get(uri));
    this.graceTimers.delete(uri);
    const state = this.states.get(uri);
    if (!state || this.running.has(uri)) {
      return;
    }
    await this.begin(uri, state);
  }

  detach(uri: string): void {
    this.release(uri);
    this.core.removeChannel(uri);
    this.states.delete(uri);
  }

  isWatch(uri: string): boolean {
    return isResourceWatchUri(uri);
  }

  private armGrace(channel: string): void {
    const timer = setTimeout(() => {
      this.graceTimers.delete(channel);
      if (!this.core.hasSubscribers(channel)) {
        this.detach(channel);
      }
    }, this.options.graceMs ?? UNSUBSCRIBED_GRACE_MS);
    timer.unref();
    this.graceTimers.set(channel, timer);
  }

  private async begin(uri: string, state: ResourceWatchState): Promise<void> {
    const root = localPath(state.root);
    let isDirectory: boolean;
    try {
      isDirectory = (await lstat(root)).isDirectory();
    } catch {
      return;
    }
    const excludes = state.excludes?.items ?? [];
    const includes = state.includes?.items;
    const run: Running = {
      root,
      state,
      isDirectory,
      excluded: pathMatcher([...DEFAULT_EXCLUDES, ...excludes]),
      included: includes ? pathMatcher(includes) : undefined,
      watched: new Map(),
      capWarned: false,
      known: new Set([root]),
      pending: new Set(),
      timer: undefined,
      stopped: false,
    };
    this.running.set(uri, run);
    if (isDirectory) {
      await this.addDirectory(uri, run, root, state.recursive);
    } else {
      this.attachWatcher(uri, run, root);
    }
  }

  private relativeOf(run: Running, path: string): string {
    return relative(run.root, path).split(sep).join("/");
  }

  // Watches one directory, and its subdirectories when the watch is recursive, skipping excluded trees.
  private async addDirectory(uri: string, run: Running, dir: string, recursive: boolean): Promise<void> {
    const queue = [dir];
    while (queue.length > 0 && !run.stopped) {
      const current = queue.pop() as string;
      if (!this.attachWatcher(uri, run, current)) {
        return;
      }
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const path = join(current, entry.name);
        if (run.excluded(this.relativeOf(run, path))) {
          continue;
        }
        run.known.add(path);
        if (recursive && entry.isDirectory()) {
          queue.push(path);
        }
      }
    }
  }

  private attachWatcher(uri: string, run: Running, path: string): boolean {
    if (run.watched.has(path)) {
      return true;
    }
    let entry = this.shared.get(path);
    if (!entry) {
      const cap = this.options.maxDirectories ?? MAX_DIRECTORIES;
      if (this.shared.size >= cap) {
        if (!run.capWarned) {
          run.capWarned = true;
          log.warn(`watch limit of ${cap} directories reached; ${path} and more below ${run.root} will not be watched`);
        }
        return false;
      }
      try {
        const listeners = new Set<DirectoryListener>();
        const watcher = this.watch(path, (_event, name) => {
          for (const listener of [...listeners]) {
            listener(name);
          }
        });
        watcher.on("error", () => undefined);
        entry = { watcher, listeners };
        this.shared.set(path, entry);
      } catch (err) {
        log.debug(`cannot watch ${path}`, err instanceof Error ? err.message : err);
        return true;
      }
    }
    const listener: DirectoryListener = (name) => this.onEvent(uri, run, path, name);
    entry.listeners.add(listener);
    run.watched.set(path, listener);
    return true;
  }

  private unwatch(run: Running, path: string): void {
    const listener = run.watched.get(path);
    run.watched.delete(path);
    const entry = this.shared.get(path);
    if (!entry || !listener) {
      return;
    }
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      entry.watcher.close();
      this.shared.delete(path);
    }
  }

  private onEvent(uri: string, run: Running, base: string, name: string | Buffer | null): void {
    if (run.stopped) {
      return;
    }
    const path = !run.isDirectory || name === null || name === "" ? base : join(base, String(name));
    const relativePath = this.relativeOf(run, path);
    if (path !== run.root && run.excluded(relativePath)) {
      return;
    }
    run.pending.add(path);
    clearTimeout(run.timer);
    run.timer = setTimeout(() => {
      run.timer = undefined;
      void this.flush(uri, run);
    }, this.options.debounceMs ?? DEBOUNCE_MS);
    run.timer.unref();
  }

  private async flush(uri: string, run: Running): Promise<void> {
    const paths = [...run.pending];
    run.pending.clear();
    const changes: ResourceChange[] = [];
    for (const path of paths) {
      if (run.stopped) {
        return;
      }
      await this.classify(uri, run, path, changes);
    }
    if (run.stopped || changes.length === 0 || !this.core.store.has(uri)) {
      return;
    }
    const items = changes.filter((change) => this.wanted(run, change));
    if (items.length > 0) {
      this.core.publish(uri, action({ type: "resourceWatch/changed", changes: { items } }));
    }
  }

  private wanted(run: Running, change: ResourceChange): boolean {
    if (!run.included) {
      return true;
    }
    return run.included(this.relativeOf(run, localPath(change.uri)));
  }

  private async classify(uri: string, run: Running, path: string, changes: ResourceChange[]): Promise<void> {
    let info;
    try {
      info = await lstat(path);
    } catch {
      this.forget(run, path, changes);
      return;
    }
    const existed = run.known.has(path);
    run.known.add(path);
    changes.push({ uri: cwdToUri(path), type: existed ? ResourceChangeType.Updated : ResourceChangeType.Added });
    if (!existed && info.isDirectory() && run.state.recursive) {
      await this.addDirectory(uri, run, path, true);
      for (const found of [...run.known]) {
        if (found !== path && found.startsWith(path + sep) && !changes.some((change) => change.uri === cwdToUri(found))) {
          changes.push({ uri: cwdToUri(found), type: ResourceChangeType.Added });
        }
      }
    }
  }

  // A path that is gone takes its watchers, and whatever was known below it, with it.
  private forget(run: Running, path: string, changes: ResourceChange[]): void {
    if (!run.known.delete(path) && !run.watched.has(path)) {
      return;
    }
    changes.push({ uri: cwdToUri(path), type: ResourceChangeType.Deleted });
    const below = path + sep;
    for (const known of [...run.known]) {
      if (known.startsWith(below)) {
        run.known.delete(known);
        changes.push({ uri: cwdToUri(known), type: ResourceChangeType.Deleted });
      }
    }
    for (const dir of [...run.watched.keys()]) {
      if (dir === path || dir.startsWith(below)) {
        this.unwatch(run, dir);
      }
    }
  }

  private release(uri: string): void {
    const run = this.running.get(uri);
    if (!run) {
      return;
    }
    run.stopped = true;
    clearTimeout(run.timer);
    for (const dir of [...run.watched.keys()]) {
      this.unwatch(run, dir);
    }
    this.running.delete(uri);
    clearTimeout(this.graceTimers.get(uri));
    this.graceTimers.delete(uri);
  }
}
