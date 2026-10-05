import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../../src/bridge/catalog.js";
import { HydraBackend } from "../../src/bridge/hydra-backend.js";
import type { Frame } from "../../src/bridge/mapping.js";
import type { Json } from "../../src/bridge/turns.js";
import type { ExtensionState } from "../../src/hydra/ext-state.js";
import type { HistoryPage, HydraRest, HydraSessionEntry } from "../../src/hydra/rest.js";
import type { AttachOptions, AttachResult, HydraSessions, SessionListener } from "../../src/hydra/sessions.js";
import { ProtocolCore } from "../../src/protocol/core.js";
import { AhpListener } from "../../src/server/listener.js";
import { TokenRegistry } from "../../src/store/tokens.js";
import { openSession, sleep, type Session } from "./harness.js";

export interface AttachCall extends AttachOptions {
  id: string;
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
  readonly pageCalls: Array<{ beforeSeq: number; turns?: number }> = [];
  rows: HydraSessionEntry[] = [];

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
      return { meta: this.meta };
    },
    detach: async (id: string): Promise<void> => {
      this.detaches.push(id);
    },
  } as unknown as HydraSessions;

  rest = {
    listSessions: async () => ({ sessions: this.rows, removed: [], cursor: 1 }),
    agents: async () => ({ agents: [] }),
    historyPage: async (_id: string, beforeSeq: number, turns?: number) => {
      this.pageCalls.push({ beforeSeq, ...(turns !== undefined ? { turns } : {}) });
      if (beforeSeq === Number.MAX_SAFE_INTEGER) {
        return this.newest;
      }
      return this.history.shift() ?? { entries: [], hasMore: false };
    },
  } as unknown as HydraRest;

  extState = { get: async () => null } as unknown as ExtensionState;
}

export interface BridgeHarness {
  hydra: FakeHydra;
  core: ProtocolCore;
  backend: HydraBackend;
  catalog: Catalog;
  connect(version?: string): Promise<Session>;
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

export async function startBridgeHarness(setup: (hydra: FakeHydra) => void = () => undefined): Promise<BridgeHarness> {
  const hydra = new FakeHydra();
  hydra.rows = [ROW()];
  setup(hydra);
  const dir = mkdtempSync(join(tmpdir(), "ahp-bridge-"));
  const tokens = new TokenRegistry({ path: join(dir, "tokens.json") });
  const catalog = new Catalog({ rest: hydra.rest, extState: hydra.extState, pollMs: 40, warmPollMs: 40 });
  const backend = new HydraBackend({ catalog, rest: hydra.rest, extState: hydra.extState, sessions: hydra.sessions, version: "0" });
  const core = new ProtocolCore({ backend });
  await core.start();
  const listener = new AhpListener({ core, tokens });
  const port = await listener.listen();
  const token = tokens.mint("test").token;
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
