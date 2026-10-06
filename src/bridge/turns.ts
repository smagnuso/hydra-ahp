export type Json = Record<string, unknown>;

export const HYDRA_META = "hydra-acp";

export interface Call {
  id: string;
  name: string;
  displayName: string;
  status?: string;
  // ACP's tool kind (execute, read, edit, ...).
  kind?: string;
  input?: string;
  // Shown in the call's row in place of displayName.
  message?: { markdown: string };
  readied: boolean;
  asked: boolean;
  finished: boolean;
  startedAt?: number;
  endedAt?: number;
  content: Json[];
}

export interface PartRef {
  id: string;
  kind: "markdown" | "reasoning" | "toolCall";
}

// What the mapper knows about the turn it believes is open; the chat state itself lives in the channel store.
export interface TurnContext {
  id: string;
  startedMs: number;
  parts: PartRef[];
  calls: Map<string, Call>;
  waiting?: string;
  // The turn Hydra is still running when this one was split off it by a steer.
  origin?: string;
}

export function bag(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function openTurn(id: string, startedMs: number): TurnContext {
  return { id, startedMs, parts: [], calls: new Map() };
}

export function planId(turnId: string): string {
  return `${turnId}:plan`;
}

// The durations on every turn ending come from the daemon's own recorded clock when frames carry it.
export function durationOf(turn: TurnContext, endMs: number, reported?: number): number {
  if (typeof reported === "number" && Number.isFinite(reported)) {
    return Math.max(0, reported);
  }
  return Math.max(0, endMs - turn.startedMs);
}
