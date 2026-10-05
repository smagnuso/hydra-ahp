// A throwaway Hydra extension that runs extension_state calls on request, so tests can ask what an extension token can reach.
import { readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";

const home = process.env.HYDRA_ACP_HOME;
const job = join(home, "probe-job.json");
const result = join(home, "probe-result.json");
const ws = new WebSocket(process.env.HYDRA_ACP_WS_URL, ["acp.v1", `hydra-acp-token.${process.env.HYDRA_ACP_TOKEN}`]);
let next = 0;
const pending = new Map();

const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++next;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });

ws.on("message", (data) => {
  const message = JSON.parse(data.toString());
  if (message.id !== undefined && pending.has(message.id) && message.method === undefined) {
    pending.get(message.id)(message.error ? { error: message.error } : { result: message.result });
    pending.delete(message.id);
  }
});

ws.on("open", async () => {
  await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "probe", version: "0" } });
  setInterval(async () => {
    if (!existsSync(job)) {
      return;
    }
    const { sessionId, readOnly } = JSON.parse(readFileSync(job, "utf8"));
    rmSync(job);
    const set = readOnly ? null : await request("hydra-acp/session/extension_state/set", { sessionId, key: "probe", value: { at: 1 } });
    const get = await request("hydra-acp/session/extension_state/get", { sessionId, key: "probe" });
    const list = await request("hydra-acp/session/extension_state/list", { sessionId });
    writeFileSync(result, JSON.stringify({ set, get, list }));
  }, 100);
});
