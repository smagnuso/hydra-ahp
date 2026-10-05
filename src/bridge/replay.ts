import { chatReducer, type ChatState, type Turn } from "@microsoft/agent-host-protocol";
import { ChatMapper, type Frame } from "./mapping.js";
import { HYDRA_META, bag, type Json } from "./turns.js";

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// A live or replayed session/update notification: recordedAt and seq ride in params._meta["hydra-acp"].
export function frameFromNotification(params: unknown): Frame | undefined {
  const body = bag(params);
  const update = bag(body.update);
  if (typeof update.sessionUpdate !== "string" && typeof update.kind !== "string") {
    return undefined;
  }
  const meta = bag(bag(body._meta)[HYDRA_META]);
  return withStamps({ update }, numberOf(meta.recordedAt), numberOf(meta.seq));
}

// A history/page entry: recordedAt and seq sit beside the recorded notification.
export function frameFromEntry(entry: unknown): Frame | undefined {
  const row = bag(entry);
  if (row.method !== "session/update") {
    return undefined;
  }
  const frame = frameFromNotification(row.params);
  if (!frame) {
    return undefined;
  }
  return withStamps(frame, numberOf(row.recordedAt) ?? frame.recordedAt, numberOf(row.seq) ?? frame.seq);
}

function withStamps(frame: Frame, recordedAt: number | undefined, seq: number | undefined): Frame {
  return {
    update: frame.update,
    ...(recordedAt !== undefined ? { recordedAt } : {}),
    ...(seq !== undefined ? { seq } : {}),
  };
}

export function emptyChat(uri: string, title: string, modifiedAt: string, status: number): ChatState {
  return { resource: uri, title, status, modifiedAt, turns: [] } as unknown as ChatState;
}

export function reduceChat(state: ChatState, actions: readonly Json[]): ChatState {
  let next = state;
  for (const action of actions) {
    next = chatReducer(next, action as never);
  }
  return next;
}

// Runs recorded frames through a fresh mapper and returns the completed turns they describe.
export function turnsFromFrames(frames: readonly Frame[], blank: ChatState): Turn[] {
  const mapper = new ChatMapper();
  let state = blank;
  for (const frame of frames) {
    state = reduceChat(state, mapper.map(frame));
  }
  state = reduceChat(state, mapper.closeActive("cancelled"));
  return state.turns;
}

export function oldestSeq(frames: readonly Frame[]): number | undefined {
  let oldest: number | undefined;
  for (const frame of frames) {
    if (frame.seq !== undefined && (oldest === undefined || frame.seq < oldest)) {
      oldest = frame.seq;
    }
  }
  return oldest;
}
