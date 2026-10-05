import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DAEMON_JS, REPO } from "./scratch.js";

// Integration tests run the built extension under a scratch daemon, so build once up front.
export default function setup(): void {
  if (!existsSync(DAEMON_JS)) {
    throw new Error(`Hydra daemon build not found at ${DAEMON_JS}; set HYDRA_CLI_DIST to a built cli/dist/daemon.js`);
  }
  execFileSync("npx", ["tsup", "--silent"], { cwd: REPO, stdio: "inherit" });
}
