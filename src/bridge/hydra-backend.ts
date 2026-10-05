import { homedir } from "node:os";
import type {
  ChatState,
  ListSessionsParams,
  ListSessionsResult,
} from "@microsoft/agent-host-protocol";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import type { ActionDecision, ActionRequest, Backend } from "../protocol/backend.js";
import type { ProtocolCore } from "../protocol/core.js";
import type { ExtensionState } from "../hydra/ext-state.js";
import { HydraHttpError, type HydraRest } from "../hydra/rest.js";
import { logger } from "../util/log.js";
import { AHP_URI_KEY, type Catalog } from "./catalog.js";
import { chatKey, chatUri, cwdToUri, isChatUri, isSessionUri, sessionKey, sessionUri, uriToCwd } from "./ids.js";
import { STATUS_IDLE, entryToSummary, summaryToSessionState } from "./summary.js";

const log = logger("backend");

const SESSION_NOT_FOUND = -32001;
const NO_SUCH_PROVIDER = -32002;
const SESSION_EXISTS = -32003;

const FAILED_CHANNEL_LINGER_MS = 30_000;

const action = (value: Record<string, unknown>) => value as never;

export interface HydraBackendOptions {
  catalog: Catalog;
  rest: HydraRest;
  extState: ExtensionState;
  version: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyChat(uri: string, title: string, modifiedAt: string, status: number): ChatState {
  return { resource: uri, title, status, modifiedAt, turns: [] } as unknown as ChatState;
}

// Read-only for now: the catalog, createSession and disposeSession; chat content arrives with the session bridge.
export class HydraBackend implements Backend {
  readonly serverInfo: { name: string; version: string };
  readonly defaultDirectory = cwdToUri(homedir());
  private core!: ProtocolCore;
  private readonly catalog: Catalog;
  private readonly rest: HydraRest;
  private readonly extState: ExtensionState;

  constructor(options: HydraBackendOptions) {
    this.catalog = options.catalog;
    this.rest = options.rest;
    this.extState = options.extState;
    this.serverInfo = { name: "hydra-ahp", version: options.version };
  }

  async start(core: ProtocolCore): Promise<void> {
    this.core = core;
    await this.catalog.start(core);
  }

  stop(): void {
    this.catalog.stop();
  }

  listSessions(params: ListSessionsParams): ListSessionsResult {
    try {
      return this.catalog.list(params.limit, params.cursor);
    } catch {
      throw new RpcError(ErrorCodes.InvalidParams, "invalid cursor");
    }
  }

  // Serves a static view of a catalog row until the session bridge takes over attaching.
  attach(uri: string): void {
    if (this.core.store.has(uri)) {
      return;
    }
    let sessionChannel: string;
    if (isSessionUri(uri)) {
      sessionChannel = uri;
    } else if (isChatUri(uri)) {
      sessionChannel = sessionUri(chatKey(uri));
    } else {
      return;
    }
    const summary = this.catalog.summaryFor(sessionChannel);
    if (!summary) {
      return;
    }
    if (!this.core.store.has(sessionChannel)) {
      this.core.createChannel(sessionChannel, summaryToSessionState(summary, "ready"));
    }
    const chat = chatUri(sessionKey(sessionChannel));
    if (!this.core.store.has(chat)) {
      this.core.createChannel(chat, emptyChat(chat, summary.title, summary.modifiedAt, summary.status));
    }
  }

  handleAction(_request: ActionRequest): ActionDecision {
    return { accept: false, reason: "this host does not accept that action yet" };
  }

  async handleCommand(method: string, params: unknown): Promise<unknown> {
    const body = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "createSession":
        return this.createSession(body);
      case "disposeSession":
        return this.disposeSession(body);
      default:
        throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
    }
  }

  private createSession(params: Record<string, unknown>): null {
    const channel = params.channel;
    if (typeof channel !== "string" || !isSessionUri(channel)) {
      throw new RpcError(ErrorCodes.InvalidParams, "channel must be an ahp-session: URI");
    }
    const provider = typeof params.provider === "string" ? params.provider : undefined;
    if (provider !== undefined && !this.catalog.hasAgent(provider)) {
      throw new RpcError(NO_SUCH_PROVIDER, `No agent for provider ${provider}`);
    }
    const directories = Array.isArray(params.workingDirectories) ? (params.workingDirectories as unknown[]) : [];
    let cwd: string | undefined;
    if (directories.length > 0) {
      cwd = typeof directories[0] === "string" ? uriToCwd(directories[0]) : undefined;
      if (!cwd) {
        throw new RpcError(ErrorCodes.InvalidParams, "workingDirectories must be file: URIs");
      }
    }
    if (this.core.store.has(channel) || this.catalog.uriInUse(channel)) {
      throw new RpcError(SESSION_EXISTS, "Session already exists");
    }

    const now = new Date().toISOString();
    const summary = entryToSummary(
      {
        sessionId: sessionKey(channel),
        agentId: provider ?? this.catalog.agents()[0]?.provider ?? "unknown",
        ...(cwd ? { cwd } : {}),
        updatedAt: now,
        createdAt: now,
      },
      channel,
    );
    const chat = chatUri(sessionKey(channel));
    this.catalog.beginCreation(channel, summary);
    this.core.createChannel(channel, summaryToSessionState(summary, "creating"));
    this.core.createChannel(chat, emptyChat(chat, summary.title, now, STATUS_IDLE));
    void this.finishCreation(channel, provider, cwd);
    return null;
  }

  private async finishCreation(channel: string, provider: string | undefined, cwd: string | undefined): Promise<void> {
    let hydraId: string | undefined;
    try {
      const created = await this.rest.createSession({
        ...(provider ? { agentId: provider } : {}),
        ...(cwd ? { cwd } : {}),
      });
      hydraId = created.sessionId;
      await this.extState.set(hydraId, AHP_URI_KEY, channel);
      const entry = await this.rest.getSession(hydraId);
      this.catalog.claim(hydraId, channel, entry);
      this.core.publish(channel, action({ type: "session/ready" }));
    } catch (err) {
      log.warn(`createSession ${channel} failed`, message(err));
      if (hydraId) {
        await this.rest.deleteSession(hydraId).catch(() => undefined);
      }
      this.catalog.failCreation(channel);
      this.core.publish(
        channel,
        action({ type: "session/creationFailed", error: { errorType: "createSessionFailed", message: message(err) } }),
      );
      setTimeout(() => {
        this.core.removeChannel(channel);
        this.core.removeChannel(chatUri(sessionKey(channel)));
      }, FAILED_CHANNEL_LINGER_MS).unref();
    }
  }

  // Same as deleting from Hydra: the agent stops for every attached client and a tombstone remains.
  private async disposeSession(params: Record<string, unknown>): Promise<null> {
    const channel = params.channel;
    const hydraId = typeof channel === "string" ? this.catalog.resolve(channel) : undefined;
    if (!hydraId) {
      throw new RpcError(SESSION_NOT_FOUND, "Session not found");
    }
    try {
      await this.rest.deleteSession(hydraId);
    } catch (err) {
      if (err instanceof HydraHttpError && err.status === 404) {
        throw new RpcError(SESSION_NOT_FOUND, "Session not found");
      }
      if (err instanceof HydraHttpError && err.status === 502) {
        throw new RpcError(ErrorCodes.InternalError, `the remote host for this session is unreachable: ${err.message}`);
      }
      throw err;
    }
    this.catalog.remove(hydraId);
    return null;
  }
}
