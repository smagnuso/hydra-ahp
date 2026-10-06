import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChatState } from "@microsoft/agent-host-protocol";
import {
  foldRecorded,
  framesFromHistory,
  framesFromNotifications,
  type HistoryRow,
  type RecordedFrame,
} from "./support/oracle.js";

// Real update sequences recorded from a scratch Hydra daemon driving the scripted fake agent (test/support/fake-acp.mjs).
const fixture = JSON.parse(readFileSync(new URL("./fixtures/scripted.json", import.meta.url), "utf8")) as {
  live: RecordedFrame[];
  history: HistoryRow[];
  replay: RecordedFrame[];
};

function tools(state: ChatState, turn: number): Array<Record<string, any>> {
  return state.turns[turn]!.responseParts.flatMap((part) => (part.kind === "toolCall" ? [part.toolCall as Record<string, any>] : []));
}

describe("recorded Hydra update sequences", () => {
  const live = foldRecorded(framesFromNotifications(fixture.live));
  const replayed = foldRecorded(framesFromNotifications(fixture.replay));
  const history = foldRecorded(framesFromHistory(fixture.history));

  it("never produces an action the official reducer ignores", () => {
    expect(live.ignored).toEqual([]);
    expect(replayed.ignored).toEqual([]);
    expect(history.ignored).toEqual([]);
  });

  it("builds the same chat from live frames, from a coalesced attach replay and from raw history", () => {
    // An attach replay carries no usage_update; the raw history file records usage snapshots at turn boundaries.
    const withoutUsage = live.state.turns.map((turn) => ({ ...turn, usage: undefined }));
    expect(replayed.state.turns).toEqual(withoutUsage);
    expect(history.state.turns.map((turn) => ({ ...turn, usage: undefined }))).toEqual(withoutUsage);
    expect(live.state.turns[0]!.usage).toEqual({ _meta: { context: { used: 1200, size: 200000 }, cost: { amount: 0.01, currency: "USD" } } });
    expect(live.state.activeTurn).toBeUndefined();
  });

  it("ends each turn the way Hydra reported it", () => {
    expect(live.state.turns.map((turn) => turn.state)).toEqual(["complete", "complete", "error", "cancelled"]);
    expect(live.state.turns.map((turn) => turn.message.text)).toEqual(["script:tools", "ping", "script:refuse", "script:hang"]);
    for (const turn of live.state.turns) {
      expect(typeof turn.duration).toBe("number");
    }
  });

  it("renders thinking, prose, tool calls and plans in order, dropping whitespace-only runs", () => {
    const kinds = live.state.turns[0]!.responseParts.map((part) => part.kind);
    expect(kinds).toEqual(["reasoning", "toolCall", "markdown", "toolCall", "toolCall", "toolCall", "markdown"]);
    const prose = live.state.turns[0]!.responseParts.flatMap((part) => (part.kind === "markdown" ? [part.content] : []));
    expect(prose).toEqual(["Two files. Now an edit.", "All done."]);
  });

  it("completes tool calls with their input, name and output", () => {
    const [ls, plan, edit, orphan] = tools(live.state, 0);
    expect(ls).toMatchObject({
      toolCallId: "t1",
      toolName: "Bash",
      displayName: "Run ls",
      status: "completed",
      success: true,
      toolInput: '{"command":"ls"}',
      content: [{ type: "text", text: "a.txt\nb.txt" }],
    });
    expect(edit).toMatchObject({ toolCallId: "t2", status: "completed", success: true });
    expect(edit!.content[0].text).toContain("-one");
    expect(edit!.content[0].text).toContain("+two");
    expect(orphan).toMatchObject({ toolCallId: "orphan", displayName: "Late", status: "completed" });
    expect(plan).toMatchObject({ status: "completed", content: [{ type: "text", text: "✓ edit it" }] });
  });

  it("closes an interrupted tool call as failed and the turn as cancelled", () => {
    const [held] = tools(live.state, 3);
    expect(held).toMatchObject({ toolCallId: "h1", status: "completed", success: false });
    expect(live.state.turns[3]!.state).toBe("cancelled");
  });

  it("stamps tool call times from the daemon's recorded clock", () => {
    const [ls] = tools(live.state, 0);
    expect(ls!._meta["hydra-acp"].startedAt).toMatch(/^\d{4}-/);
    expect(typeof ls!._meta["hydra-acp"].durationMs).toBe("number");
  });
});
