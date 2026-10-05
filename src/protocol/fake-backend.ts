import type {
  ChatState,
  ListSessionsParams,
  ListSessionsResult,
  RootState,
  SessionState,
  SessionSummary,
  StateAction,
} from "@microsoft/agent-host-protocol";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import type { ActionDecision, ActionRequest, Backend } from "./backend.js";
import { ROOT_URI } from "./channels.js";
import type { ProtocolCore } from "./core.js";

const IDLE = 1;

export interface FakeSessionSpec {
  id: string;
  title: string;
}

export interface FakeBackendOptions {
  sessions?: FakeSessionSpec[];
  autoReply?: boolean;
}

export function sessionUri(id: string): string {
  return `ahp-session:/${id}`;
}

export function chatUri(id: string): string {
  return `ahp-chat:/${id}`;
}

const action = (value: Record<string, unknown>): StateAction => value as unknown as StateAction;

// In-memory stand-in for the Hydra bridge: one session per id, each with one chat "<id>-chat".
export class FakeBackend implements Backend {
  readonly serverInfo = { name: "hydra-ahp-fake", version: "0.0.0" };
  readonly defaultDirectory = "file:///tmp";
  readonly attached: string[] = [];
  readonly detached: string[] = [];
  readonly actions: ActionRequest[] = [];
  autoReply: boolean;
  core!: ProtocolCore;
  private readonly specs: FakeSessionSpec[];

  constructor(options: FakeBackendOptions = {}) {
    this.specs = options.sessions ?? [{ id: "s1", title: "First session" }];
    this.autoReply = options.autoReply ?? false;
  }

  start(core: ProtocolCore): void {
    this.core = core;
    const root: RootState = {
      agents: [
        { provider: "fake", displayName: "Fake agent", description: "In-memory test agent", models: [] },
      ],
      activeSessions: this.specs.length,
    };
    core.createChannel(ROOT_URI, root);
    for (const spec of this.specs) {
      this.addSession(spec, false);
    }
  }

  addSession(spec: FakeSessionSpec, announce: boolean): void {
    const now = new Date().toISOString();
    const chat = chatUri(`${spec.id}-chat`);
    const chatState: ChatState = {
      resource: chat,
      title: spec.title,
      status: IDLE,
      modifiedAt: now,
      turns: [],
    } as ChatState;
    const sessionState: SessionState = {
      provider: "fake",
      title: spec.title,
      status: IDLE,
      lifecycle: "ready",
      activeClients: [],
      chats: [{ resource: chat, title: spec.title, status: IDLE, modifiedAt: now }],
      defaultChat: chat,
    } as SessionState;
    this.core.createChannel(sessionUri(spec.id), sessionState);
    this.core.createChannel(chat, chatState);
    if (announce) {
      this.core.notify(ROOT_URI, "root/sessionAdded", { channel: ROOT_URI, summary: this.summary(spec.id) });
    }
  }

  removeSession(id: string): void {
    this.core.removeChannel(sessionUri(id));
    this.core.removeChannel(chatUri(`${id}-chat`));
    this.core.notify(ROOT_URI, "root/sessionRemoved", { channel: ROOT_URI, session: sessionUri(id) });
  }

  summary(id: string): SessionSummary {
    const uri = sessionUri(id);
    const state = this.core.store.state(uri) as SessionState;
    return {
      resource: uri,
      provider: state.provider,
      title: state.title,
      status: state.status,
      createdAt: new Date(0).toISOString(),
      modifiedAt: new Date().toISOString(),
      chats: state.chats.map((chat) => ({ resource: chat.resource, title: chat.title })),
      defaultChat: state.defaultChat,
    } as SessionSummary;
  }

  listSessions(_params: ListSessionsParams): ListSessionsResult {
    const ids = this.core.store
      .uris()
      .filter((uri) => uri.startsWith("ahp-session:"))
      .map((uri) => uri.slice("ahp-session:/".length));
    return { items: ids.map((id) => this.summary(id)) };
  }

  attach(uri: string): void {
    this.attached.push(uri);
  }

  detach(uri: string): void {
    this.detached.push(uri);
  }

  handleAction(request: ActionRequest): ActionDecision {
    this.actions.push(request);
    if (this.autoReply && request.action.type === "chat/turnStarted") {
      const { turnId } = request.action as unknown as { turnId: string };
      setTimeout(() => this.streamReply(request.channel, turnId, "Hello from the fake agent."), 0);
    }
    return { accept: true };
  }

  handleCommand(method: string, params: unknown): unknown {
    const channel = (params as { channel?: string }).channel ?? "";
    if (method === "createSession") {
      const id = channel.slice("ahp-session:/".length);
      if (!id || this.core.store.has(channel)) {
        throw new RpcError(-32003, "session already exists");
      }
      this.addSession({ id, title: "New session" }, true);
      return null;
    }
    if (method === "disposeSession") {
      if (!this.core.store.has(channel)) {
        throw new RpcError(-32001, "session not found");
      }
      this.removeSession(channel.slice("ahp-session:/".length));
      return null;
    }
    throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
  }

  streamReply(chat: string, turnId: string, text: string): void {
    const partId = `${turnId}-p1`;
    this.core.publish(chat, action({ type: "chat/responsePart", turnId, part: { kind: "markdown", id: partId, content: "" } }));
    for (const word of text.split(" ")) {
      this.core.publish(chat, action({ type: "chat/delta", turnId, partId, content: `${word} ` }));
    }
    this.core.publish(chat, action({ type: "chat/turnComplete", turnId, duration: 1 }));
  }

  askConfirmation(chat: string, turnId: string, toolCallId: string): void {
    this.core.publish(chat, action({ type: "chat/toolCallStart", turnId, toolCallId, toolName: "shell", displayName: "Shell" }));
    this.core.publish(chat, action({ type: "chat/toolCallReady", turnId, toolCallId, invocationMessage: "run ls" }));
  }
}
