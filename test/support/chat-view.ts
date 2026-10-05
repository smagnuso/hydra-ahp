import { expect } from "vitest";
import type {
  ActionEnvelope,
  ChatState,
  ResponsePart,
  SessionState,
  Snapshot,
  ToolCallState,
} from "@microsoft/agent-host-protocol";
import type { AhpConnection } from "./driver.js";
import { act } from "./harness.js";
import { ReducerOracle } from "./oracle.js";
import { until } from "./scratch.js";

// Scenario tests land before the code they cover; HYDRA_AHP_RUN_PENDING=T10,T11 (or "all") runs them anyway.
export function runsPending(task: string): boolean {
  const wanted = (process.env.HYDRA_AHP_RUN_PENDING ?? "").split(",").map((entry) => entry.trim());
  return wanted.includes(task) || wanted.includes("all");
}

export const user = (text: string): { text: string; origin: { kind: string } } => ({ text, origin: { kind: "user" } });

export function markdown(parts: readonly ResponsePart[]): string {
  return parts.flatMap((part) => (part.kind === "markdown" ? [part.content] : [])).join("");
}

// One AHP client's view of a Hydra session, rebuilt through the official reducers from what the server sent.
export class ChatView {
  private constructor(
    readonly ahp: AhpConnection,
    readonly id: string,
    private readonly oracle: ReducerOracle,
  ) {
  }

  static async open(ahp: AhpConnection, id: string): Promise<ChatView> {
    const oracle = new ReducerOracle();
    const session = await ahp.session.client.subscribe(`ahp-session:/${id}`);
    oracle.applySnapshot(session.result.snapshot as Snapshot);
    const chat = await ahp.session.client.subscribe(`ahp-chat:/${id}`);
    oracle.applySnapshot(chat.result.snapshot as Snapshot);
    return new ChatView(ahp, id, oracle);
  }

  get chatUri(): string {
    return `ahp-chat:/${this.id}`;
  }

  get sessionUri(): string {
    return `ahp-session:/${this.id}`;
  }

  chat(): ChatState {
    for (const envelope of this.ahp.session.events) {
      this.oracle.applyEnvelope(envelope);
    }
    return this.oracle.state(this.chatUri) as ChatState;
  }

  session(): SessionState {
    this.chat();
    return this.oracle.state(this.sessionUri) as SessionState;
  }

  toolCalls(): ToolCallState[] {
    const chat = this.chat();
    const parts = [...chat.turns.flatMap((turn) => turn.responseParts), ...(chat.activeTurn?.responseParts ?? [])];
    return parts.flatMap((part) => (part.kind === "toolCall" ? [part.toolCall] : []));
  }

  toolCall(id: string): ToolCallState | undefined {
    return this.toolCalls().find((call) => call.toolCallId === id);
  }

  until<T>(what: string, probe: (chat: ChatState) => T | undefined | false, timeoutMs = 15000): Promise<T> {
    return until(what, () => probe(this.chat()), timeoutMs, 50);
  }

  // Envelopes on this chat channel the server sent since the given index into the connection's events.
  envelopes(type: string, from = 0): ActionEnvelope[] {
    return this.ahp.session.events.slice(from).filter((e) => e.channel === this.chatUri && e.action.type === type);
  }

  async dispatch(action: Record<string, unknown>, channel = this.chatUri): Promise<ActionEnvelope> {
    const { clientSeq } = this.ahp.session.client.dispatch(channel, act(action));
    const echo = await this.ahp.session.waitFor((e) => e.origin?.clientSeq === clientSeq, 5000);
    expect(echo.rejectionReason, `${String(action.type)} rejected`).toBeUndefined();
    return echo;
  }

  async startTurn(turnId: string, text: string): Promise<ActionEnvelope> {
    return this.dispatch({ type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message: user(text) });
  }

  async close(): Promise<void> {
    await this.ahp.session.client.unsubscribe(this.chatUri);
    await this.ahp.session.client.unsubscribe(this.sessionUri);
  }
}
