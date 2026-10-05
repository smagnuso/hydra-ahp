import {
  changesetReducer,
  chatReducer,
  rootReducer,
  sessionReducer,
  terminalReducer,
  type ActionEnvelope,
  type ActionOrigin,
  type ChangesetState,
  type ChatState,
  type RootState,
  type SessionState,
  type Snapshot,
  type StateAction,
  type TerminalState,
} from "@microsoft/agent-host-protocol";

export const ROOT_URI = "ahp-root://";

export type ChannelKind = "root" | "session" | "chat" | "terminal" | "changeset";

export type ChannelState = RootState | SessionState | ChatState | TerminalState | ChangesetState;

// Clients pick terminal URIs too; the spec uses ahp-terminal: and VS Code agenthost-terminal:.
const TERMINAL_URI = /^[a-z][a-z0-9+.-]*terminal:\/[^/]+$/i;

export function isTerminalUri(uri: string): boolean {
  return TERMINAL_URI.test(uri);
}

// Clients that create a session pick its URI, usually "<provider>:/<id>", so any such shape is a session channel.
const SESSION_URI = /^(?!ahp-chat:|ahp-root:|[a-z0-9+.-]*terminal:)[a-z][a-z0-9+.-]*:\/[^/]+$/i;

export function isSessionChannelUri(uri: string): boolean {
  return SESSION_URI.test(uri);
}

// A session's changesets hang off its URI, as VS Code's own host addresses them: "<session>/changeset/<id>".
const CHANGESET_URI = /^(?!ahp-chat:|ahp-root:|[a-z0-9+.-]*terminal:)[a-z][a-z0-9+.-]*:\/[^/]+\/changeset\/[^/]+$/i;

export function isChangesetChannelUri(uri: string): boolean {
  return CHANGESET_URI.test(uri);
}

export function channelKind(uri: string): ChannelKind | undefined {
  if (uri === ROOT_URI) {
    return "root";
  }
  if (uri.startsWith("ahp-chat:")) {
    return "chat";
  }
  if (isTerminalUri(uri)) {
    return "terminal";
  }
  if (isChangesetChannelUri(uri)) {
    return "changeset";
  }
  if (isSessionChannelUri(uri)) {
    return "session";
  }
  return undefined;
}

export interface ChannelStoreOptions {
  ringSize?: number;
  startSeq?: number;
}

interface Channel {
  kind: ChannelKind;
  state: ChannelState;
  createdSeq: number;
}

export type ReplayResult =
  | { type: "replay"; actions: ActionEnvelope[]; missing: string[] }
  | { type: "snapshot" };

const DEFAULT_RING_SIZE = 4096;

function reduce(kind: ChannelKind, state: ChannelState, action: StateAction): ChannelState {
  switch (kind) {
    case "root":
      return rootReducer(state as RootState, action as Parameters<typeof rootReducer>[1]);
    case "session":
      return sessionReducer(state as SessionState, action as Parameters<typeof sessionReducer>[1]);
    case "chat":
      // A chat rename (see isChatRename) changes the title through Hydra; the chat's own state is unchanged.
      if (action.type === "session/titleChanged") {
        return state;
      }
      return chatReducer(state as ChatState, action as Parameters<typeof chatReducer>[1]);
    case "terminal":
      return terminalReducer(state as TerminalState, action as Parameters<typeof terminalReducer>[1]);
    case "changeset":
      return changesetReducer(state as ChangesetState, action as Parameters<typeof changesetReducer>[1]);
  }
}

// Every state change goes through the official reducers and gets one global serverSeq.
export class ChannelStore {
  private readonly channels = new Map<string, Channel>();
  private readonly ring: ActionEnvelope[] = [];
  private readonly ringSize: number;
  private seq: number;
  private floor: number;

  constructor(options: ChannelStoreOptions = {}) {
    this.ringSize = options.ringSize ?? DEFAULT_RING_SIZE;
    // Wall-clock base keeps a restarted host from looking resumable to an old client.
    this.seq = options.startSeq ?? Date.now();
    this.floor = this.seq;
  }

  get serverSeq(): number {
    return this.seq;
  }

  has(uri: string): boolean {
    return this.channels.has(uri);
  }

  uris(): string[] {
    return [...this.channels.keys()];
  }

  state(uri: string): ChannelState | undefined {
    return this.channels.get(uri)?.state;
  }

  create(uri: string, state: ChannelState): void {
    const kind = channelKind(uri);
    if (!kind) {
      throw new Error(`unsupported channel: ${uri}`);
    }
    this.channels.set(uri, { kind, state, createdSeq: this.seq });
  }

  remove(uri: string): void {
    this.channels.delete(uri);
  }

  snapshot(uri: string): Snapshot | undefined {
    const channel = this.channels.get(uri);
    if (!channel) {
      return undefined;
    }
    return {
      resource: uri,
      state: structuredClone(channel.state),
      fromSeq: this.seq,
    } as Snapshot;
  }

  apply(uri: string, action: StateAction, origin?: ActionOrigin): ActionEnvelope {
    const channel = this.channels.get(uri);
    if (!channel) {
      throw new Error(`unknown channel: ${uri}`);
    }
    channel.state = reduce(channel.kind, channel.state, action);
    this.mirrorChatSummary(action);
    this.seq += 1;
    const envelope: ActionEnvelope = { channel: uri, action, serverSeq: this.seq, origin };
    this.ring.push(envelope);
    while (this.ring.length > this.ringSize) {
      const dropped = this.ring.shift();
      if (dropped) {
        this.floor = dropped.serverSeq;
      }
    }
    return envelope;
  }

  // A chat's state repeats its summary's fields, so a summary change announced on the session reaches the chat's snapshot too.
  private mirrorChatSummary(action: StateAction): void {
    if (action.type !== "session/chatUpdated") {
      return;
    }
    const chat = this.channels.get(action.chat);
    if (chat?.kind !== "chat") {
      return;
    }
    const { resource: _resource, ...changes } = action.changes as { resource?: string };
    chat.state = { ...(chat.state as ChatState), ...changes };
  }

  // Replays only when the ring still covers the gap and no channel was recreated since.
  replay(lastSeen: number, subscriptions: readonly string[]): ReplayResult {
    const missing = subscriptions.filter((uri) => !this.channels.has(uri));
    const live = subscriptions.filter((uri) => this.channels.has(uri));
    const covered = lastSeen >= this.floor && lastSeen <= this.seq;
    const recreated = live.some((uri) => (this.channels.get(uri)?.createdSeq ?? 0) > lastSeen);
    if (!covered || recreated) {
      return { type: "snapshot" };
    }
    const wanted = new Set(live);
    const actions = this.ring.filter(
      (envelope) => envelope.serverSeq > lastSeen && wanted.has(envelope.channel),
    );
    return { type: "replay", actions, missing };
  }
}
