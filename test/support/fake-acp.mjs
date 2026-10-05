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
