import { describe, expect, it } from "vitest";
import { ChatMapper, type Frame } from "../src/bridge/mapping.js";
import { EditContentStore, editContentUri } from "../src/bridge/edit-content.js";

const CHAT = "ahp-chat://default/abc";
let tick = 1_000;
const frame = (update: Record<string, unknown>): Frame => ({ update, recordedAt: (tick += 10), seq: tick });

function mapped(update: Record<string, unknown>) {
  const store = new EditContentStore();
  const mapper = new ChatMapper({ edits: { chatUri: CHAT, put: (uri, text) => store.put(uri, text) } });
  mapper.map(frame({ sessionUpdate: "prompt_received", messageId: "m1", prompt: [{ type: "text", text: "go" }] }));
  const actions = mapper.map(frame(update));
  const complete = actions.find((a) => a.type === "chat/toolCallComplete") as { result: { content: Array<Record<string, unknown>> } };
  return { store, content: complete.result.content };
}

describe("edits in tool results", () => {
  it("become a fileEdit whose before and after are served for the client to diff, with the daemon's counts", () => {
    const { store, content } = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      status: "completed",
      content: [{ type: "diff", path: "/r/a.ts", oldText: "one\n", newText: "one\ntwo\n" }],
      _meta: { "hydra-acp": { editStats: [{ path: "/r/a.ts", added: 1, removed: 0 }] } },
    });
    const before = editContentUri(CHAT, "tc1", 0, "old");
    const after = editContentUri(CHAT, "tc1", 0, "new");
    expect(content).toEqual([
      {
        type: "fileEdit",
        before: { uri: "file:///r/a.ts", content: { uri: before } },
        after: { uri: "file:///r/a.ts", content: { uri: after } },
        diff: { added: 1, removed: 0 },
      },
    ]);
    expect(store.read(before, undefined)).toMatchObject({ data: "one\n" });
    expect(store.read(after, "base64")).toMatchObject({ data: Buffer.from("one\ntwo\n").toString("base64"), encoding: "base64" });
  });

  it("count a creation's lines when the daemon recorded none, and leave an edit's counts unknown", () => {
    const created = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "tc2",
      status: "completed",
      content: [{ type: "diff", path: "/r/new.ts", oldText: null, newText: "a\nb" }],
    }).content[0];
    expect(created).toMatchObject({ after: { uri: "file:///r/new.ts" }, diff: { added: 2, removed: 0 } });
    expect(created?.before).toBeUndefined();
    const edited = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "tc3",
      status: "completed",
      content: [{ type: "diff", path: "/r/a.ts", oldText: "x", newText: "y" }],
    }).content[0];
    expect(edited?.diff).toBeUndefined();
  });
});

describe("edits awaiting confirmation", () => {
  it("are previewed on the ready, under the title the agent settled on", () => {
    const store = new EditContentStore();
    const mapper = new ChatMapper({ edits: { chatUri: CHAT, put: (uri, text) => store.put(uri, text) } });
    mapper.map(frame({ sessionUpdate: "prompt_received", messageId: "m1", prompt: [{ type: "text", text: "go" }] }));
    mapper.map(frame({ sessionUpdate: "tool_call", toolCallId: "tc4", status: "pending", title: "Preparing file…" }));
    const actions = mapper.confirmationReady(
      {
        toolCallId: "tc4",
        title: "Write new.ts",
        rawInput: { file_path: "/r/new.ts", content: "a\nb" },
        content: [{ type: "diff", path: "/r/new.ts", oldText: null, newText: "a\nb" }],
      },
      [],
    );
    const after = editContentUri(CHAT, "tc4", 0, "new");
    expect(actions.find((a) => a.type === "chat/toolCallReady")).toMatchObject({
      invocationMessage: "Write new.ts",
      edits: { items: [{ after: { uri: "file:///r/new.ts", content: { uri: after } }, diff: { added: 2, removed: 0 } }] },
    });
    expect(store.read(after, undefined)).toMatchObject({ data: "a\nb" });
  });
});

describe("EditContentStore", () => {
  it("refuses content it does not hold", () => {
    expect(() => new EditContentStore().read(editContentUri(CHAT, "nope", 0, "old"), undefined)).toThrow();
  });
});
