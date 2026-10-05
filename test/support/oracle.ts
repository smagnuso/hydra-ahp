import { channelKind } from "../../src/protocol/channels.js";
import {
  chatReducer,
  rootReducer,
  sessionReducer,
  type ActionEnvelope,
  type ChatState,
  type Snapshot,
} from "@microsoft/agent-host-protocol";
import { ChatMapper, type Frame } from "../../src/bridge/mapping.js";
import { emptyChat, frameFromEntry, frameFromNotification } from "../../src/bridge/replay.js";
import type { Json } from "../../src/bridge/turns.js";

type Reducer = (state: never, action: never) => unknown;

function reducerFor(channel: string): Reducer {
  if (channel === "ahp-root://") {
    return rootReducer as Reducer;
  }
  return channelKind(channel) === "session" ? (sessionReducer as Reducer) : (chatReducer as Reducer);
}

// Rebuilds channel state purely from snapshots and envelopes via the official reducers.
export class ReducerOracle {
  private readonly states = new Map<string, { state: unknown; fromSeq: number }>();

  applySnapshot(snapshot: Snapshot): void {
    this.states.set(snapshot.resource, { state: structuredClone(snapshot.state), fromSeq: snapshot.fromSeq });
  }

  applyEnvelope(envelope: ActionEnvelope): void {
    const entry = this.states.get(envelope.channel);
    if (!entry || envelope.rejectionReason !== undefined || envelope.serverSeq <= entry.fromSeq) {
      return;
    }
    entry.state = reducerFor(envelope.channel)(entry.state as never, envelope.action as never);
    entry.fromSeq = envelope.serverSeq;
  }

  state(channel: string): unknown {
    return this.states.get(channel)?.state;
  }

  channels(): string[] {
    return [...this.states.keys()];
  }
}

export interface RecordedFrame {
  sessionId?: string;
  update: Record<string, unknown>;
  _meta?: { "hydra-acp"?: { recordedAt?: number; seq?: number } };
}

export interface HistoryRow {
  method: string;
  params: RecordedFrame;
  recordedAt?: number;
  seq?: number;
}

export function framesFromNotifications(rows: readonly RecordedFrame[]): Frame[] {
  return rows.flatMap((row) => {
    const frame = frameFromNotification(row);
    return frame ? [frame] : [];
  });
}

export function framesFromHistory(rows: readonly HistoryRow[]): Frame[] {
  return rows.flatMap((row) => {
    const frame = frameFromEntry(row);
    return frame ? [frame] : [];
  });
}

export interface Folded {
  state: ChatState;
  actions: Json[];
  // Actions the official reducer accepted without changing anything: a "wrong screen, no error" signal.
  ignored: Json[];
}

export function blankChat(): ChatState {
  return emptyChat("ahp-chat:/oracle", "oracle", "1970-01-01T00:00:00.000Z", 1);
}

// Runs a recorded Hydra update sequence through the mapper and the official chat reducer, flagging no-op actions.
export function foldRecorded(frames: readonly Frame[], options: { closeOpen?: boolean } = {}): Folded {
  const mapper = new ChatMapper();
  let state = blankChat();
  const actions: Json[] = [];
  const ignored: Json[] = [];
  const apply = (batch: Json[]): void => {
    for (const next of batch) {
      const reduced = chatReducer(state, next as never);
      if (JSON.stringify(reduced) === JSON.stringify(state)) {
        ignored.push(next);
      }
      state = reduced;
      actions.push(next);
    }
  };
  for (const frame of frames) {
    apply(mapper.map(frame));
  }
  if (options.closeOpen) {
    apply(mapper.closeActive("cancelled"));
  }
  return { state, actions, ignored };
}
