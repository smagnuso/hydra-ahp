import {
  chatReducer,
  rootReducer,
  sessionReducer,
  type ActionEnvelope,
  type ActionOrigin,
  type ChatState,
  type RootState,
  type SessionState,
  type Snapshot,
  type StateAction,
} from "@microsoft/agent-host-protocol";

export const ROOT_URI = "ahp-root://";

export type ChannelKind = "root" | "session" | "chat";

export type ChannelState = RootState | SessionState | ChatState;

export function channelKind(uri: string): ChannelKind | undefined {
  if (uri === ROOT_URI) {
    return "root";
  }
  if (uri.startsWith("ahp-session:")) {
    return "session";
  }
  if (uri.startsWith("ahp-chat:")) {
    return "chat";
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
      return chatReducer(state as ChatState, action as Parameters<typeof chatReducer>[1]);
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
