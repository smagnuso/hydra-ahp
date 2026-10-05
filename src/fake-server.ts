#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBackend } from "./protocol/fake-backend.js";
import { ProtocolCore } from "./protocol/core.js";
import { AhpListener } from "./server/listener.js";
import { TokenRegistry, isFileLevel } from "./store/tokens.js";

// Serves the in-memory fake backend so AHP clients (ahpc, VS Code) can be pointed at the protocol core.
async function main(): Promise<void> {
  const level = process.env.HYDRA_AHP_FILES ?? "scoped";
  if (!isFileLevel(level)) {
    throw new Error(`HYDRA_AHP_FILES must be scoped, read or full, got ${level}`);
  }
  const tokens = new TokenRegistry({ path: join(mkdtempSync(join(tmpdir(), "hydra-ahp-fake-")), "tokens.json") });
  const backend = new FakeBackend({
    autoReply: true,
    sessions: [
      { id: "s1", title: "First fake session" },
      { id: "s2", title: "Second fake session" },
    ],
  });
  const core = new ProtocolCore({ backend });
  await core.start();
  const listener = new AhpListener({ core, tokens, port: Number(process.env.HYDRA_AHP_PORT ?? 0) });
  const port = await listener.listen();
  const { token } = tokens.mint("fake", level);
  process.stdout.write(`listening on ws://127.0.0.1:${port}/?tkn=${token}\n`);
  process.stdout.write(`${JSON.stringify({ address: `127.0.0.1:${port}`, name: "fake", connectionToken: token })}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
