#!/usr/bin/env node
import { startApp } from "./app.js";
import { runTokenCommand } from "./commands/tokens.js";
import { DEFAULT_PORT, loadConfig, tokensPath } from "./config.js";
import { TokenRegistry } from "./store/tokens.js";
import { logger } from "./util/log.js";

const log = logger("main");

const VERSION = "0.1.0";

function runCli(argv: string[]): void {
  const tokens = new TokenRegistry({ path: tokensPath(process.env) });
  const port = process.env.HYDRA_AHP_PORT ?? String(DEFAULT_PORT);
  process.stdout.write(`${runTokenCommand({ tokens, address: () => `127.0.0.1:${port}` }, argv.join(" "))}\n`);
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
