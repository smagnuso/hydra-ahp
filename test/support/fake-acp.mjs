import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const waiting = new Map();
let counter = 0;
let outgoing = 0;

const chunk = (sessionId, text) =>
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });

const update = (sessionId, body) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let cancelHang;

const scripts = {
  async tools(sessionId) {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me look." } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n" } });
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Run ls",
      kind: "execute",
      status: "pending",
      rawInput: {},
      _meta: { claudeCode: { toolName: "Bash" } },
    });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", rawInput: { command: "ls" } });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "a.txt\nb.txt" } }],
    });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Two files." } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " Now an edit." } });
    update(sessionId, {
      sessionUpdate: "plan",
      entries: [{ content: "edit it", priority: "medium", status: "pending" }],
    });
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "Edit a.txt",
      kind: "edit",
      status: "in_progress",
      rawInput: { path: "/tmp/a.txt" },
      content: [{ type: "diff", path: "/tmp/a.txt", oldText: "one", newText: "two" }],
    });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "orphan", title: "Late", status: "completed" });
    update(sessionId, {
      sessionUpdate: "plan",
      entries: [{ content: "edit it", priority: "medium", status: "completed" }],
    });
    update(sessionId, { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.01, currency: "USD" } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "All done." } });
    return "end_turn";
  },
  async slow(sessionId) {
    chunk(sessionId, "start ");
    await sleep(1500);
    chunk(sessionId, "finish");
    return "end_turn";
  },
  async flood(sessionId) {
    for (let i = 0; i < 1500; i += 1) {
      chunk(sessionId, `c${i} `);
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: `f${i}`, title: "t", status: "completed" });
      await sleep(1);
    }
    return "end_turn";
  },
  async hang(sessionId) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "h1", title: "Wait", kind: "other", status: "in_progress" });
    await new Promise((resolve) => {
      cancelHang = resolve;
    });
    return "cancelled";
  },
  async refuse(sessionId) {
    chunk(sessionId, "no");
    return "refusal";
  },
};

const ask = (sessionId) =>
  new Promise((resolve) => {
    const id = `perm-${++outgoing}`;
    waiting.set(id, resolve);
    send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: `tool-${outgoing}`, title: "run ls", kind: "execute", status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  });

async function prompt(message) {
  const { sessionId } = message.params;
  const text = (message.params.prompt ?? []).map((block) => block.text ?? "").join(" ");
  const script = Object.keys(scripts).find((name) => text.startsWith(`script:${name}`));
  if (script) {
    const stopReason = await scripts[script](sessionId);
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason } });
    return;
  }
  chunk(sessionId, "pong");
  if (text.includes("permission")) {
    const answer = await ask(sessionId);
    chunk(sessionId, `permission:${answer?.outcome?.optionId ?? answer?.outcome?.outcome ?? "none"}`);
  }
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
}

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined && message.id !== undefined && waiting.has(message.id)) {
    waiting.get(message.id)(message.result);
    waiting.delete(message.id);
    return;
  }
  if (message.method === "session/cancel") {
    cancelHang?.();
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: {} }, authMethods: [] },
    });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: `fake-${process.pid}-${++counter}` } });
  } else if (message.method === "session/prompt") {
    void prompt(message);
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
