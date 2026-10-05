import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IPty } from "node-pty";
import type { TerminalClaim, TerminalInfo, TerminalState } from "@microsoft/agent-host-protocol";
import { cwdToUri, uriToCwd } from "../bridge/ids.js";
import type { ActionDecision, ClientContext } from "../protocol/backend.js";
import { ROOT_URI, isTerminalUri } from "../protocol/channels.js";
import type { ProtocolCore } from "../protocol/core.js";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import { logger } from "../util/log.js";

const log = logger("terminals");

const METHODS = new Set(["createTerminal", "disposeTerminal"]);

// A client that drops for longer than this has its terminals killed; a reconnect inside it keeps them.
const ORPHAN_GRACE_MS = 30_000;

type Spawn = (shell: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => IPty;

export interface TerminalServiceOptions {
  // Tests inject a fake; production loads node-pty, an optional dependency.
  spawn?: Spawn;
  shell?: string;
  orphanGraceMs?: number;
}

interface Running {
  pty: IPty;
  info: TerminalInfo;
}

const action = (value: Record<string, unknown>) => value as never;

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe";
  }
  return process.env.SHELL ?? "/bin/sh";
}

// node-pty 1.1.0 ships its macOS spawn-helper without the execute bit, so every spawn fails with "posix_spawnp failed".
function makeSpawnHelperExecutable(): void {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    const root = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
    const helper = join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    if (!existsSync(helper)) {
      return;
    }
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      chmodSync(helper, 0o755);
    }
  } catch (err) {
    log.warn("could not make node-pty's spawn-helper executable", err instanceof Error ? err.message : err);
  }
}

// Shells on this machine for clients holding a full token: the Agents window opens one per session in its working directory.
export class TerminalService {
  private core!: ProtocolCore;
  private spawn: Spawn | undefined;
  private readonly terminals = new Map<string, Running>();
  private readonly orphanTimers = new Map<string, NodeJS.Timeout>();
  // Stand-ins for terminals this process never had, such as ones from before a restart.
  private readonly gone = new Set<string>();

  constructor(private readonly options: TerminalServiceOptions = {}) {}

  async start(core: ProtocolCore): Promise<void> {
    this.core = core;
    if (this.options.spawn) {
      this.spawn = this.options.spawn;
      return;
    }
    try {
      const pty = await import("node-pty");
      makeSpawnHelperExecutable();
      this.spawn = (shell, args, options) => pty.spawn(shell, args, options);
    } catch (err) {
      log.info("terminals are unavailable: node-pty did not load", err instanceof Error ? err.message : err);
    }
  }

  handles(method: string): boolean {
    return METHODS.has(method);
  }

  handle(method: string, params: unknown, client: ClientContext): null {
    if (!this.spawn || client.token.level !== "full") {
      throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
    }
    const body = (params ?? {}) as Record<string, unknown>;
    const channel = body.channel;
    if (typeof channel !== "string" || !isTerminalUri(channel)) {
      throw new RpcError(ErrorCodes.InvalidParams, "channel must be a terminal URI");
    }
    if (method === "disposeTerminal") {
      this.dispose(channel);
      return null;
    }
    this.create(channel, body, client);
    return null;
  }

  // Client actions on a terminal channel: input and size go to the shell, the rest only change state.
  handleAction(channel: string, next: { type: string } & Record<string, unknown>): ActionDecision {
    const running = this.terminals.get(channel);
    if (!running) {
      return { accept: false, reason: "no such terminal" };
    }
    switch (next.type) {
      case "terminal/input":
        if (typeof next.data !== "string") {
          return { accept: false, reason: "data must be a string" };
        }
        running.pty.write(next.data);
        return { accept: true };
      case "terminal/resized": {
        const cols = next.cols;
        const rows = next.rows;
        if (typeof cols !== "number" || typeof rows !== "number" || cols < 1 || rows < 1) {
          return { accept: false, reason: "cols and rows must be positive numbers" };
        }
        try {
          running.pty.resize(Math.floor(cols), Math.floor(rows));
        } catch {
          // The shell may already have exited; the size is still recorded.
        }
        return { accept: true };
      }
      case "terminal/claimed":
        running.info = { ...running.info, claim: next.claim as TerminalClaim };
        this.publishList();
        return { accept: true };
      case "terminal/titleChanged":
        running.info = { ...running.info, title: String(next.title ?? running.info.title) };
        this.publishList();
        return { accept: true };
      case "terminal/cleared":
        return { accept: true };
      default:
        return { accept: false, reason: "this host does not accept that action" };
    }
  }

  connectionClosed(clientId: string): void {
    if (!clientId || this.orphanTimers.has(clientId) || !this.ownedBy(clientId).length) {
      return;
    }
    const timer = setTimeout(() => {
      this.orphanTimers.delete(clientId);
      if (this.core.isConnected(clientId)) {
        return;
      }
      for (const channel of this.ownedBy(clientId)) {
        this.dispose(channel);
      }
    }, this.options.orphanGraceMs ?? ORPHAN_GRACE_MS);
    timer.unref();
    this.orphanTimers.set(clientId, timer);
  }

  stop(): void {
    for (const timer of this.orphanTimers.values()) {
      clearTimeout(timer);
    }
    this.orphanTimers.clear();
    for (const channel of [...this.terminals.keys()]) {
      this.dispose(channel);
    }
  }

  private create(channel: string, body: Record<string, unknown>, client: ClientContext): void {
    this.detachGone(channel);
    if (this.terminals.has(channel) || this.core.store.has(channel)) {
      throw new RpcError(ErrorCodes.InvalidParams, "terminal already exists");
    }
    const cwdUri = typeof body.cwd === "string" ? body.cwd : undefined;
    const cwd = (cwdUri && uriToCwd(cwdUri)) || homedir();
    const cols = positive(body.cols) ?? 80;
    const rows = positive(body.rows) ?? 24;
    const title = typeof body.name === "string" && body.name !== "" ? body.name : "Terminal";
    const claim = isClaim(body.claim) ? body.claim : ({ kind: "client", clientId: client.clientId } as TerminalClaim);
    const shell = this.options.shell ?? defaultShell();
    let pty: IPty;
    try {
      pty = (this.spawn as Spawn)(shell, [], { name: "xterm-256color", cols, rows, cwd, env: process.env });
    } catch (err) {
      throw new RpcError(ErrorCodes.InternalError, `could not start a shell: ${err instanceof Error ? err.message : String(err)}`);
    }
    const state: TerminalState = {
      title,
      cwd: cwdUri ?? cwdToUri(cwd),
      cols,
      rows,
      content: [],
      lifecycle: { status: "running" },
      claim,
      supportsCommandDetection: false,
      isPty: true,
    } as TerminalState;
    this.core.createChannel(channel, state);
    const running: Running = { pty, info: { resource: channel, title, claim, lifecycle: { status: "running" } } as TerminalInfo };
    this.terminals.set(channel, running);
    pty.onData((data) => {
      if (this.terminals.get(channel) === running) {
        this.core.publish(channel, action({ type: "terminal/data", data }));
      }
    });
    pty.onExit(({ exitCode }) => {
      if (this.terminals.get(channel) !== running) {
        return;
      }
      this.core.publish(channel, action({ type: "terminal/exited", exitCode }));
      running.info = { ...running.info, lifecycle: { status: "exited", exitCode } } as TerminalInfo;
      this.publishList();
    });
    this.publishList();
    log.info(`started ${shell} in ${cwd} for ${client.clientId}`);
  }

  // A client still holding a terminal from before a restart gets a stand-in that exits at once, so it closes the tab
  // instead of typing into nothing.
  attachGone(channel: string): void {
    if (!isTerminalUri(channel) || this.terminals.has(channel) || this.core.store.has(channel)) {
      return;
    }
    this.gone.add(channel);
    this.core.createChannel(channel, {
      title: "Terminal",
      cwd: cwdToUri(homedir()),
      cols: 80,
      rows: 24,
      content: [],
      lifecycle: { status: "running" },
      claim: { kind: "client", clientId: "" },
      supportsCommandDetection: false,
      isPty: true,
    } as TerminalState);
    setImmediate(() => {
      if (this.gone.has(channel) && this.core.store.has(channel)) {
        this.core.publish(channel, action({ type: "terminal/exited" }));
      }
    });
  }

  detachGone(channel: string): void {
    if (this.gone.delete(channel)) {
      this.core.removeChannel(channel);
    }
  }

  private dispose(channel: string): void {
    const running = this.terminals.get(channel);
    if (!running) {
      return;
    }
    this.terminals.delete(channel);
    try {
      running.pty.kill();
    } catch {
      // Already gone.
    }
    this.core.removeChannel(channel);
    this.publishList();
  }

  private ownedBy(clientId: string): string[] {
    return [...this.terminals.entries()]
      .filter(([, running]) => running.info.claim.kind === "client" && running.info.claim.clientId === clientId)
      .map(([channel]) => channel);
  }

  private publishList(): void {
    const terminals = [...this.terminals.values()].map((running) => running.info);
    this.core.publish(ROOT_URI, action({ type: "root/terminalsChanged", terminals }));
  }
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

function isClaim(value: unknown): value is TerminalClaim {
  const claim = value as { kind?: unknown; clientId?: unknown; session?: unknown } | undefined;
  return (claim?.kind === "client" && typeof claim.clientId === "string") || (claim?.kind === "session" && typeof claim.session === "string");
}
