import { mkdtempSync, rmSync } from "node:fs";
import { ChangesetService } from "../../src/changesets/service.js";
import { FlagStore } from "../../src/store/flags.js";
import { ModelStore } from "../../src/store/models.js";
import type { ConfigStore } from "../../src/store/configs.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../../src/bridge/catalog.js";
import { HydraBackend } from "../../src/bridge/hydra-backend.js";
import type { Frame } from "../../src/bridge/mapping.js";
import type { Json } from "../../src/bridge/turns.js";
import { FileService } from "../../src/files/service.js";
import { TerminalService } from "../../src/terminals/service.js";
import type { ExtensionState } from "../../src/hydra/ext-state.js";
import type { HistoryPage, HydraRest, HydraSessionEntry } from "../../src/hydra/rest.js";
import type { AttachOptions, AttachResult, HydraSessions, SessionListener, SteeringResult } from "../../src/hydra/sessions.js";
import type { SettleHandler } from "../../src/rpc/peer.js";
import { ProtocolCore } from "../../src/protocol/core.js";
import { AhpListener } from "../../src/server/listener.js";
import { TokenRegistry } from "../../src/store/tokens.js";
import { openSession, sleep, type Session } from "./harness.js";

export interface AttachCall extends AttachOptions {
  id: string;
}

export interface WriteCall {
  method: string;
  id: string;
  params?: unknown;
}

export interface PromptCall {
  id: string;
  prompt: unknown[];
  end(stopReason: string): void;
}

// Stands in for the daemon's side of session/attach so bridge behaviour can be scripted.
export class FakeHydra {
  listener: SessionListener | undefined;
  readonly attaches: AttachCall[] = [];
  readonly detaches: string[] = [];
  // Frames a viewer (cold) attach replays.
  replay: Frame[] = [];
  // Frames that reach the listener before the attach response, as a live broadcast racing the attach does.
  early: Frame[] = [];
  meta: Json = {};
  failure: Error | undefined;
  // What history/page returns for the newest page, and queued answers for any older page.
  newest: HistoryPage = { entries: [], hasMore: false };
  history: HistoryPage[] = [];
  configOptions: unknown;
  readonly pageCalls: Array<{ beforeSeq: number; turns?: number }> = [];
  rows: HydraSessionEntry[] = [];
  // Every write the bridge sent, in order, and the prompts still waiting for their answer.
  readonly writes: WriteCall[] = [];
  readonly prompts: PromptCall[] = [];
  modelFailure: Error | undefined;
  steering: SteeringResult = { outcome: "injected" };

  sessions = {
    listen: (_id: string, listener: SessionListener) => {
      this.listener = listener;
      return () => {
        if (this.listener === listener) {
          this.listener = undefined;
        }
      };
    },
    attach: async (id: string, options: AttachOptions): Promise<AttachResult> => {
      this.attaches.push({ id, ...options });
      if (this.failure) {
        throw this.failure;
      }
      for (const frame of this.early) {
        this.listener?.update(frame);
      }
      if (options.readonly) {
        for (const frame of this.replay) {
          this.listener?.update(frame);
        }
      }
      return { meta: this.meta, ...(this.configOptions !== undefined ? { configOptions: this.configOptions } : {}) };
    },
    detach: async (id: string): Promise<void> => {
      this.detaches.push(id);
    },
    prompt: (id: string, prompt: unknown[], onSettle: SettleHandler): Promise<unknown> => {
      this.writes.push({ method: "session/prompt", id, params: prompt });
      return new Promise((resolve) => {
        this.prompts.push({
          id,
          prompt,
          end: (stopReason) => {
            onSettle({ stopReason }, undefined);
            resolve({ stopReason });
          },
        });
      });
    },
    cancel: (id: string): void => {
      this.writes.push({ method: "session/cancel", id });
    },
    setModel: async (id: string, modelId: string): Promise<void> => {
      this.writes.push({ method: "session/set_model", id, params: modelId });
      if (this.modelFailure) {
        throw this.modelFailure;
      }
    },
    delete: async (id: string): Promise<void> => {
      this.writes.push({ method: "session/delete", id });
    },
    steer: async (id: string, prompt: unknown[]): Promise<SteeringResult> => {
      this.writes.push({ method: "_session/steering", id, params: prompt });
      return this.steering;
    },
  } as unknown as HydraSessions;

  rest = {
    listSessions: async () => ({ sessions: this.rows, removed: [], cursor: 1 }),
    agents: async () => ({ agents: [] }),
    config: async () => ({}),
    sessionDiff: async (id: string) => (this.edited.get(id) ?? []).map((file) => typeof file === "string"
      ? { path: file, hunks: [{ oldText: "before\n", newText: "after\n" }] }
      : file),
    historyPage: async (_id: string, beforeSeq: number, turns?: number) => {
      this.pageCalls.push({ beforeSeq, ...(turns !== undefined ? { turns } : {}) });
      if (beforeSeq === Number.MAX_SAFE_INTEGER) {
        return this.newest;
      }
      return this.history.shift() ?? { entries: [], hasMore: false };
    },
    patchSession: async (id: string, body: unknown) => {
      this.writes.push({ method: "PATCH", id, params: body });
    },
    deleteSession: async (id: string) => {
      this.writes.push({ method: "DELETE", id });
    },
    killSession: async (id: string) => {
      this.writes.push({ method: "KILL", id });
    },
    getSession: async (id: string) => ({ ...(this.rows.find((row) => row.sessionId === id) ?? {}), ...this.live }),
  } as unknown as HydraRest;

  // What GET /v1/sessions/:id adds to a row: Hydra's live view of who is attached and whether it is working.
  live: Partial<HydraSessionEntry> = { status: "warm", attachedClients: 1 };
  readonly buckets = new Map<string, Record<string, unknown>>();
  readonly edited = new Map<string, Array<string | { path: string; hunks: Array<{ oldText: string; newText: string }>; created?: boolean }>>();
  extState = {
    get: async (id: string, key: string) => this.buckets.get(id)?.[key] ?? null,
    list: async (id: string) => ({ ...this.buckets.get(id) }),
    set: async (id: string, key: string, value: unknown) => {
      this.buckets.set(id, { ...this.buckets.get(id), [key]: value });
    },
    delete: async (id: string, key: string) => {
      const { [key]: _gone, ...rest } = this.buckets.get(id) ?? {};
      this.buckets.set(id, rest);
    },
  } as unknown as ExtensionState;
}

export interface BridgeHarness {
  hydra: FakeHydra;
  core: ProtocolCore;
  backend: HydraBackend;
  catalog: Catalog;
  connect(version?: string): Promise<Session>;
  connectFull(): Promise<Session>;
  stop(): Promise<void>;
}

export const ROW = (overrides: Partial<HydraSessionEntry> = {}): HydraSessionEntry => ({
  sessionId: "h1",
  agentId: "fake",
  cwd: "/tmp",
  title: "Hello",
  status: "warm",
  interactive: true,
  updatedAt: "2026-10-05T00:00:00.000Z",
  createdAt: "2026-10-05T00:00:00.000Z",
  ...overrides,
});

export async function startBridgeHarness(
  setup: (hydra: FakeHydra) => void = () => undefined,
  options: { permissionDelayMs?: number; models?: ModelStore; flags?: FlagStore; configs?: ConfigStore; changesetPollMs?: number; showImported?: boolean } = {},
): Promise<BridgeHarness> {
  const hydra = new FakeHydra();
  hydra.rows = [ROW()];
  setup(hydra);
  const dir = mkdtempSync(join(tmpdir(), "ahp-bridge-"));
  const tokens = new TokenRegistry({ path: join(dir, "tokens.json") });
  const { models, flags, configs, changesetPollMs, showImported, ...backendOptions } = options;
  const withChangesets = changesetPollMs !== undefined;
  const catalog = new Catalog({ rest: hydra.rest, extState: hydra.extState, pollMs: 40, warmPollMs: 40, ...(models ? { models } : {}), ...(flags ? { flags } : {}), ...(configs ? { configs } : {}), ...(showImported !== undefined ? { showImported } : {}), changesets: withChangesets });
  const changesets = withChangesets
    ? new ChangesetService({
        cwdOf: (uri) => catalog.localCwdOf(uri),
        isCold: (uri) => catalog.isCold(uri),
        membersOf: (uri) => catalog.membersOf(uri),
        sessionEdits: (id) => hydra.rest.sessionDiff(id),
        onSessionTotals: (uri, totals) => catalog.noteChanges(uri, totals),
        onWorkdirs: (uri, directories) => catalog.noteWorkdirs(uri, directories),
        pollMs: changesetPollMs,
        editsEveryMs: changesetPollMs,
      })
    : undefined;
  const backend = new HydraBackend({ catalog, rest: hydra.rest, extState: hydra.extState, sessions: hydra.sessions, version: "0", files: new FileService({ sessions: catalog, dirRoots: [] }), terminals: new TerminalService({ ...(process.platform === "win32" ? {} : { shell: "/bin/sh" }), orphanGraceMs: 200 }), ...(changesets ? { changesets } : {}), ...backendOptions });
  const core = new ProtocolCore({ backend });
  await core.start();
  const listener = new AhpListener({ core, tokens });
  const port = await listener.listen();
  const token = tokens.mint("test", "scoped").token;
  const fullToken = tokens.mint("full", "full").token;
  const opened: Session[] = [];
  return {
    hydra,
    core,
    backend,
    catalog,
    async connect() {
      const session = await openSession(`ws://127.0.0.1:${port}/?tkn=${encodeURIComponent(token)}`);
      opened.push(session);
      return session;
    },
    async connectFull() {
      const session = await openSession(`ws://127.0.0.1:${port}/?tkn=${encodeURIComponent(fullToken)}`);
      opened.push(session);
      return session;
    },
    async stop() {
      for (const session of opened) {
        await session.shutdown().catch(() => undefined);
      }
      await sleep(20);
      await listener.close();
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
