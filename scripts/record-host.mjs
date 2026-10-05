#!/usr/bin/env node
// Dev-only recon stub: a frame-logging AHP host. Not product code.
// Usage: node scripts/record-host.mjs [--port 8765] [--log frames.ndjson] [--version 0.9.0]
import { createWriteStream } from "node:fs";
import { WebSocketServer } from "ws";
import { negotiateProtocolVersion } from "@microsoft/agent-host-protocol";

const args = process.argv.slice(2);

function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) {
    return fallback;
  }
  return args[i + 1];
}

const port = Number(opt("port", "8765"));
const logPath = opt("log", `frames-${Date.now()}.ndjson`);
const forcedVersion = opt("version", "0.9.0");
const out = createWriteStream(logPath, { flags: "a" });

let connSeq = 0;

function log(conn, event, data) {
  const line = JSON.stringify({ t: new Date().toISOString(), conn, event, ...data });
  out.write(`${line}\n`);
  console.log(line.length > 400 ? `${line.slice(0, 400)}...` : line);
}

const rootState = { agents: [] };

function handle(msg, ctx) {
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize": {
      const offered = Array.isArray(params.protocolVersions) ? params.protocolVersions : [];
      ctx.offered = offered;
      const negotiated = negotiateProtocolVersion(offered) ?? forcedVersion;
      return {
        result: {
          protocolVersion: negotiated,
          serverSeq: 0,
          serverInfo: { name: "hydra-ahp-recorder", version: "0.0.0" },
          snapshots: [{ resource: "ahp-root://", state: rootState, fromSeq: 0 }],
        },
      };
    }
    case "ping":
      return { result: {} };
    case "subscribe":
      if (params.channel === "ahp-root://") {
        return { result: { snapshot: { resource: "ahp-root://", state: rootState, fromSeq: 0 } } };
      }
      return { result: {} };
    case "listSessions":
      return { result: { items: [] } };
    default:
      return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

const wss = new WebSocketServer({ host: "127.0.0.1", port });

wss.on("connection", (ws, req) => {
  const conn = ++connSeq;
  const ctx = {};
  log(conn, "upgrade", { url: req.url, headers: req.headers });

  ws.on("message", (data) => {
    const text = data.toString();
    log(conn, "in", { frame: text });
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg === null || typeof msg !== "object" || typeof msg.method !== "string") {
      return;
    }
    if (msg.id === undefined) {
      return;
    }
    const reply = { jsonrpc: "2.0", id: msg.id, ...handle(msg, ctx) };
    const frame = JSON.stringify(reply);
    log(conn, "out", { frame });
    ws.send(frame);
  });

  ws.on("close", (code, reason) => {
    log(conn, "close", { code, reason: reason.toString() });
  });
  ws.on("error", (err) => {
    log(conn, "error", { message: String(err) });
  });
});

wss.on("listening", () => {
  console.log(`recording on ws://127.0.0.1:${port}/?tkn=<any>, log: ${logPath}`);
});
