import {
  chatReducer,
  rootReducer,
  sessionReducer,
  type ActionEnvelope,
  type Snapshot,
} from "@microsoft/agent-host-protocol";

type Reducer = (state: never, action: never) => unknown;

function reducerFor(channel: string): Reducer {
  if (channel === "ahp-root://") {
    return rootReducer as Reducer;
  }
  if (channel.startsWith("ahp-session:")) {
    return sessionReducer as Reducer;
  }
  return chatReducer as Reducer;
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
