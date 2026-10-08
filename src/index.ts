#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { startApp } from "./app.js";
import { isWildcardHost, runTokenCommand, WILDCARD_WARNING } from "./commands/tokens.js";
import { DEFAULT_PORT, loadConfig, tokensPath } from "./config.js";
import { TokenRegistry } from "./store/tokens.js";
import { logger } from "./util/log.js";

const log = logger("main");

const { version: VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

function runCli(argv: string[]): void {
  const tokens = new TokenRegistry({ path: tokensPath(process.env) });
  const port = process.env.HYDRA_AHP_PORT ?? String(DEFAULT_PORT);
  // Outside the daemon only the env is known; settings adopted from the daemon show up in `/hydra ahp token`.
  const host = process.env.HYDRA_AHP_PREFERRED_HOST || process.env.HYDRA_AHP_HOST || "127.0.0.1";
  const scheme = process.env.HYDRA_AHP_TLS_CERT && process.env.HYDRA_AHP_TLS_KEY ? "wss" : "ws";
  if (isWildcardHost(process.env.HYDRA_AHP_HOST ?? "") && ["mint", "url"].includes(argv[0] ?? "")) {
    process.stderr.write(`${WILDCARD_WARNING}\n`);
  }
  process.stdout.write(`${runTokenCommand({ tokens, address: () => `${host}:${port}`, scheme: () => scheme }, argv.join(" "))}\n`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "token") {
    runCli(argv.slice(1));
    return;
  }
  if (argv[0] === "url") {
    runCli(["url", ...argv.slice(1)]);
    return;
  }
  const app = await startApp(loadConfig(), VERSION);
  const shutdown = (): void => {
    void app.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
