import { describe, expect, it } from "vitest";
import { ChatMapper, type Frame } from "../src/bridge/mapping.js";

let tick = 1_000;
const frame = (update: Record<string, unknown>): Frame => ({ update, recordedAt: (tick += 10), seq: tick });

type Action = { type: string; invocationMessage?: unknown; result?: { pastTenseMessage?: unknown } };

function run(opened: Record<string, unknown>, later: Record<string, unknown>): Action[] {
  const mapper = new ChatMapper({});
  mapper.map(frame({ sessionUpdate: "prompt_received", messageId: "m1", prompt: [{ type: "text", text: "go" }] }));
  return [...mapper.map(frame(opened)), ...mapper.map(frame(later))] as Action[];
}

const markdownOf = (value: unknown): string => (value as { markdown: string }).markdown;

describe("tool call labels", () => {
  it("say what a bare grep searched, once its input arrives", () => {
    const actions = run(
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "grep", kind: "search", status: "pending", rawInput: {}, locations: [] },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawInput: { pattern: "instrument|trace", path: "/home/me/code/nrdp/src/platform/gibbon/bridge", include: "*Bridge*", limit: 55 },
        locations: [{ path: "/home/me/code/nrdp/src/platform/gibbon/bridge" }],
      },
    );
    const ready = actions.filter((a) => a.type === "chat/toolCallReady").at(-1);
    expect(markdownOf(ready?.invocationMessage)).toBe("grep `instrument|trace` in `…/platform/gibbon/bridge`");
    const done = actions.find((a) => a.type === "chat/toolCallComplete");
    expect(markdownOf(done?.result?.pastTenseMessage)).toBe("grep `instrument|trace` in `…/platform/gibbon/bridge`");
  });

  it("name the file a bare read opened, with its line range", () => {
    const actions = run(
      { sessionUpdate: "tool_call", toolCallId: "t2", title: "read", kind: "read", status: "pending", rawInput: {}, locations: [] },
      { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", rawInput: { path: "src/base/Instrumentation.cpp", offset: 385, limit: 85 } },
    );
    const done = actions.find((a) => a.type === "chat/toolCallComplete");
    expect(markdownOf(done?.result?.pastTenseMessage)).toBe("read `src/base/Instrumentation.cpp` (lines 385 to 470)");
  });

  it("fall back to the call's location when the input names no path", () => {
    const actions = run(
      { sessionUpdate: "tool_call", toolCallId: "t3", title: "glob", kind: "search", status: "pending", rawInput: {}, locations: [] },
      { sessionUpdate: "tool_call_update", toolCallId: "t3", status: "completed", rawInput: { pattern: "**/*.ts" }, locations: [{ path: "/a/b" }] },
    );
    const done = actions.find((a) => a.type === "chat/toolCallComplete");
    expect(markdownOf(done?.result?.pastTenseMessage)).toBe("glob `**/*.ts` in `/a/b`");
  });

  it("leave a title that already says more, and shell calls, as they are", () => {
    const titled = run(
      { sessionUpdate: "tool_call", toolCallId: "t4", title: "Read src/app.ts", kind: "read", status: "pending", rawInput: {} },
      { sessionUpdate: "tool_call_update", toolCallId: "t4", status: "completed", rawInput: { path: "src/app.ts" } },
    );
    expect(titled.find((a) => a.type === "chat/toolCallComplete")?.result?.pastTenseMessage).toBe("Read src/app.ts");
    const shell = run(
      { sessionUpdate: "tool_call", toolCallId: "t5", title: "bash", kind: "execute", status: "pending", rawInput: {} },
      { sessionUpdate: "tool_call_update", toolCallId: "t5", status: "completed", rawInput: { command: "ls" } },
    );
    expect(shell.find((a) => a.type === "chat/toolCallComplete")?.result?.pastTenseMessage).toBe("bash");
  });
});
