import { existsSync } from "node:fs";
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

// --steering advertises native _session/steering, as claude-agent-acp and codex-acp do.
const nativeSteering = process.argv.includes("--steering");
// What this agent process saw, in order; a script:log prompt reads it back.
const log = [];
// The running script:wait turn, if any: a steer or cancel settles it.
let waiter;
let cancelled = false;
let waking = false;

const cancellable = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const check = setInterval(() => {
      if (cancelled) {
        clearTimeout(timer);
        clearInterval(check);
        resolve(true);
      }
    }, 20);
  });

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
  // One tool call that needs permission; the outcome decides how the call and the turn end.
  async ask(sessionId) {
    const toolCallId = `ask-${++asked}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Run rm", kind: "execute", status: "pending", rawInput: { command: "rm x" } });
    const answer = await ask(sessionId, toolCallId);
    return settleAsk(sessionId, toolCallId, answer);
  },
  // Two tool calls asking at once, as parallel tools do.
  async ask2(sessionId) {
    const ids = [`ask-${++asked}`, `ask-${++asked}`];
    for (const toolCallId of ids) {
      update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `Run ${toolCallId}`, kind: "execute", status: "pending", rawInput: {} });
    }
    const answers = await Promise.all(ids.map((toolCallId) => ask(sessionId, toolCallId)));
    const stops = ids.map((toolCallId, i) => settleAsk(sessionId, toolCallId, answers[i]));
    return stops.includes("cancelled") ? "cancelled" : "end_turn";
  },
  // Runs until steered natively or cancelled.
  async wait(sessionId) {
    chunk(sessionId, "waiting ");
    const outcome = await new Promise((resolve) => {
      waiter = resolve;
      if (cancelled) {
        resolve({ cancelled: true });
      }
    });
    waiter = undefined;
    if (outcome.cancelled) {
      return "cancelled";
    }
    chunk(sessionId, `steered:${outcome.text}`);
    return "end_turn";
  },
  // Runs until the named file exists, so a test decides when the turn ends; "then-ask" asks permission after.
  async gate(sessionId, text) {
    const [, path, then] = text.split(/\s+/);
    chunk(sessionId, "gated ");
    while (!existsSync(path)) {
      if (await cancellable(50)) {
        return "cancelled";
      }
    }
    chunk(sessionId, "released");
    if (then === "then-ask") {
      return scripts.ask(sessionId);
    }
    return "end_turn";
  },
  // Ends the turn, then starts one of its own and reports its end the way claude-acp does.
  async wake(sessionId) {
    chunk(sessionId, "sleeping");
    setTimeout(async () => {
      chunk(sessionId, "woke ");
      await sleep(300);
      chunk(sessionId, "done");
      update(sessionId, { sessionUpdate: "usage_update", used: 10, size: 1000, _meta: { "_claude/origin": { kind: "task-notification" } } });
    }, 400);
    return "end_turn";
  },
  // Ends the turn, then keeps talking on its own until cancelled, never reporting an end.
  async "wake-long"(sessionId) {
    chunk(sessionId, "sleeping");
    setTimeout(async () => {
      waking = true;
      cancelled = false;
      for (let i = 0; waking && !cancelled; i += 1) {
        chunk(sessionId, `tick${i} `);
        await sleep(200);
      }
      waking = false;
    }, 400);
    return "end_turn";
  },
  async log(sessionId) {
    chunk(sessionId, JSON.stringify(log));
    return "end_turn";
  },
};

let asked = 0;

function settleAsk(sessionId, toolCallId, answer) {
  const outcome = answer?.outcome?.outcome === "selected" ? answer.outcome.optionId : answer?.outcome?.outcome ?? "none";
  chunk(sessionId, `${toolCallId}:${outcome} `);
  if (outcome === "allow") {
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
    return "end_turn";
  }
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
  return outcome === "cancelled" ? "cancelled" : "end_turn";
}

const ask = (sessionId, toolCallId) =>
  new Promise((resolve) => {
    const id = `perm-${++outgoing}`;
    waiting.set(id, (answer) => {
      log.push(`permission:${toolCallId ?? `tool-${outgoing}`}:${answer?.outcome?.optionId ?? answer?.outcome?.outcome ?? "error"}`);
      resolve(answer);
    });
    send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: toolCallId ?? `tool-${outgoing}`, title: "run ls", kind: "execute", status: "pending" },
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
  log.push(`prompt:${text}`);
  cancelled = false;
  const script = Object.keys(scripts)
    .sort((a, b) => b.length - a.length)
    .find((name) => text.startsWith(`script:${name}`));
  if (script) {
    const stopReason = await scripts[script](sessionId, text);
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
    waiting.get(message.id)(message.result ?? (message.error ? { error: message.error } : undefined));
    waiting.delete(message.id);
    return;
  }
  if (message.method === "session/cancel") {
    log.push("cancel");
    cancelled = true;
    waking = false;
    cancelHang?.();
    waiter?.({ cancelled: true });
    return;
  }
  if (message.method === "_session/steering") {
    const text = (message.params?.prompt ?? []).map((block) => block.text ?? "").join(" ");
    log.push(`steer:${text}`);
    if (waiter) {
      waiter({ text });
      send({ jsonrpc: "2.0", id: message.id, result: { outcome: "injected" } });
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: { outcome: "promptRequired", reason: "noRunningTurn" } });
    }
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
        authMethods: [],
        ...(nativeSteering ? { _meta: { steering: { supported: true } } } : {}),
      },
    });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: `fake-${process.pid}-${++counter}` } });
  } else if (message.method === "session/prompt") {
    void prompt(message);
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
