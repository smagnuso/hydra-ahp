import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { confPath, DEFAULT_PORT, hydraHome } from "../config.js";
import { readConf, writeConf } from "./conf.js";
import {
  CERTS_UNAVAILABLE_MESSAGE,
  ensurePrivateDir,
  hasBin,
  mintTailscaleCert,
  tailscaleStatus,
} from "./tailscale.js";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const EXTENSION_NAME = "hydra-ahp";

function say(line: string): void {
  process.stdout.write(`      ${line}\n`);
}

function ok(line: string): void {
  say(`${GREEN}✓${RESET} ${line}`);
}

function warn(line: string): void {
  say(`${YELLOW}⚠${RESET} ${line}`);
}

function fail(line: string): never {
  process.stderr.write(`      ${RED}✗ ${line}${RESET}\n`);
  process.exit(1);
}

function header(num: number, title: string): void {
  process.stdout.write(`\n  ${BOLD}[${num}/4] ${title}${RESET}\n\n`);
}

async function confirm(label: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const reply: string = await new Promise((resolve) => {
      rl.question(`      ${label} ${defaultYes ? "[Y/n]" : "[y/N]"}: `, resolve);
    });
    const trimmed = reply.trim().toLowerCase();
    return trimmed ? trimmed.startsWith("y") : defaultYes;
  } finally {
    rl.close();
  }
}

export async function runTailscaleSetup(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  process.stdout.write(`\n  ${BOLD}hydra-ahp tailscale setup${RESET}\n`);

  header(1, "Checking Tailscale");
  const status = tailscaleStatus();
  if (status.kind === "not-installed") {
    fail("tailscale not found on PATH. Install it first: https://tailscale.com/download");
  }
  if (status.kind === "error") {
    fail(status.message);
  }
  ok(`Logged in as ${status.dnsName}`);
  ok(`Tailnet IP: ${status.ip}`);

  header(2, "Minting cert");
  const tlsDir = join(hydraHome(env), "extensions", "ahp", "tls");
  ensurePrivateDir(tlsDir);
  const certPath = join(tlsDir, "cert.pem");
  const keyPath = join(tlsDir, "key.pem");
  say("Requesting cert from Tailscale (network call, can take a few seconds)...");
  const minted = await mintTailscaleCert({
    dnsName: status.dnsName,
    certPath,
    keyPath,
    confirmSudo: async () => {
      warn("tailscale cert needs elevated access to the local tailscaled socket.");
      say("Fix this permanently: sudo tailscale set --operator=$(whoami)");
      return confirm("Retry cert generation with sudo now instead?", true);
    },
  });
  if (minted.kind === "certs-unavailable") {
    fail(CERTS_UNAVAILABLE_MESSAGE);
  }
  if (minted.kind === "declined-sudo") {
    fail("Run `sudo tailscale set --operator=$(whoami)`, then re-run this setup.");
  }
  if (minted.kind === "error") {
    fail(minted.message);
  }
  if (minted.chownFailed) {
    warn(`Couldn't chown the cert files. Fix manually: sudo chown $(whoami) ${certPath} ${keyPath}`);
  }
  try {
    chmodSync(certPath, 0o600);
    chmodSync(keyPath, 0o600);
  } catch (err) {
    warn(`Couldn't chmod cert files (${(err as Error).message}).`);
  }
  ok(`Wrote ${certPath}`);
  ok(`Wrote ${keyPath}`);
  say("Tailscale certs are valid ~90 days. Re-run this setup to renew before expiry.");

  header(3, "Writing config");
  const path = confPath(env);
  const existing = readConf(path);
  const port = Number.parseInt(existing.get("HYDRA_AHP_PORT") ?? env.HYDRA_AHP_PORT ?? "", 10) || DEFAULT_PORT;
  // A deliberate 0.0.0.0 already covers the tailnet interface; narrowing it would silently cut off LAN clients.
  const boundEverywhere = existing.get("HYDRA_AHP_HOST") === "0.0.0.0";
  writeConf(path, {
    HYDRA_AHP_TLS_CERT: certPath,
    HYDRA_AHP_TLS_KEY: keyPath,
    HYDRA_AHP_HOST: boundEverywhere ? undefined : status.ip,
    HYDRA_AHP_PREFERRED_HOST: status.dnsName,
  });
  ok(`Wrote ${path} (chmod 600)`);
  if (boundEverywhere) {
    say("HYDRA_AHP_HOST=0.0.0.0 left as-is: already reachable on the tailnet interface, and LAN clients keep working.");
  } else {
    say(`HYDRA_AHP_HOST=${status.ip}: bound to the tailnet interface only, not your LAN.`);
  }

  header(4, "Apply");
  if (!hasBin("hydra-acp")) {
    say(`hydra-acp not found on PATH. Restart ${EXTENSION_NAME} manually to apply.`);
  } else if (!(await confirm(`Restart the ${EXTENSION_NAME} extension now?`, true))) {
    say(`Skipped. Apply later with: hydra-acp extension restart ${EXTENSION_NAME}`);
  } else {
    const result = spawnSync("hydra-acp", ["extension", "restart", EXTENSION_NAME], { stdio: "inherit" });
    if (result.status === 0) {
      ok("Restarted.");
    } else {
      warn(`hydra-acp exited with code ${result.status ?? "?"}. Restart manually if needed.`);
    }
  }

  ok("Setup complete.");
  say(`Connect to: wss://${status.dnsName}:${port}`);
  say("Mint a token and get the full URL with: hydra ahp url");
}
