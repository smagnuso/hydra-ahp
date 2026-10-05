import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HydraClient } from "../../src/hydra/client.js";
import { HydraRest } from "../../src/hydra/rest.js";

const here = dirname(fileURLToPath(import.meta.url));

export const REPO = resolve(here, "../..");
// Worktrees sit elsewhere than the main checkout, so fall back to the sibling cli repo's absolute location.
export const DAEMON_JS = [
  process.env.HYDRA_CLI_DIST,
  resolve(REPO, "../cli/dist/daemon.js"),
  join(homedir(), "dev/hydra-acp/cli/dist/daemon.js"),
].find((candidate) => candidate && existsSync(candidate)) ?? "cli/dist/daemon.js";
export const EXTENSION_JS = join(REPO, "dist", "index.js");
export const FAKE_AGENT = join(here, "fake-acp.mjs");
export const PROBE_EXTENSION = join(here, "probe-extension.mjs");

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

export async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 15000,
  stepMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value) {
        return value;
      }
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    }
    await sleep(stepMs);
  }
}

export interface ScratchOptions {
  name: string;
  ahp?: boolean;
  probe?: boolean;
  password?: string;
  ahpEnv?: Record<string, string>;
  // Extra keys for the daemon block, e.g. a short idle timeout or a fast session GC.
  daemon?: Record<string, unknown>;
}

// A throwaway Hydra daemon with a fake ACP agent, its own HYDRA_ACP_HOME and port, and this extension registered as "ahp".
export class ScratchDaemon {
  private child: ChildProcess | undefined;

  private constructor(
    readonly name: string,
    readonly home: string,
    readonly port: number,
    readonly ahpPort: number,
    readonly adminToken: () => string,
    private readonly options: ScratchOptions,
  ) {
  }

  static async create(options: ScratchOptions): Promise<ScratchDaemon> {
    const home = mkdtempSync(join(tmpdir(), `hydra-ahp-${options.name}-`));
    const port = await freePort();
    const ahpPort = await freePort();
    const extensions: Record<string, unknown> = {};
    if (options.ahp !== false) {
      extensions.ahp = {
        command: ["node", EXTENSION_JS],
        env: {
          HYDRA_AHP_PORT: String(ahpPort),
          HYDRA_AHP_POLL_MS: "300",
          HYDRA_AHP_WARM_POLL_MS: "200",
          ...options.ahpEnv,
        },
      };
    }
    if (options.probe) {
      extensions.probe = { command: ["node", PROBE_EXTENSION], env: { NODE_PATH: join(REPO, "node_modules") } };
    }
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        daemon: { port, ...options.daemon },
        registry: { pinned: true },
        defaultAgent: "fake",
        agents: {
          fake: { command: "node", args: [FAKE_AGENT] },
          "fake-steering": { command: "node", args: [FAKE_AGENT, "--steering"] },
          "fake-models": { command: "node", args: [FAKE_AGENT, "--models"] },
          "fake-config": { command: "node", args: [FAKE_AGENT, "--config"] },
        },
        extensions,
      }),
    );
    if (options.password) {
      const salt = randomBytes(16);
      const key = scryptSync(options.password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
      writeFileSync(join(home, "password-hash"), `scrypt$${1 << 15}$8$1$${salt.toString("hex")}$${key.toString("hex")}\n`, { mode: 0o600 });
    }
    const daemon = new ScratchDaemon(options.name, home, port, ahpPort, () => readFileSync(join(home, "auth-token"), "utf8").trim(), options);
    await daemon.start();
    return daemon;
  }

  get daemonUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get admin(): HydraRest {
    return new HydraRest(this.daemonUrl, this.adminToken());
  }

  async start(): Promise<void> {
    mkdirSync(this.home, { recursive: true });
    this.child = spawn("node", [DAEMON_JS], {
      env: { ...process.env, HYDRA_ACP_HOME: this.home },
      stdio: ["ignore", "ignore", "ignore"],
    });
    await until("daemon health", async () => {
      const response = await fetch(`${this.daemonUrl}/v1/health`).catch(() => undefined);
      return response?.ok ? true : undefined;
    });
    if (this.options.ahp !== false) {
      await until("ahp extension", async () => {
        const info = await this.admin.request<{ status: string }>("GET", "/v1/extensions/ahp").catch(() => undefined);
        return info?.status === "running" && (await this.ahpListening()) ? true : undefined;
      });
    }
  }

  private async ahpListening(): Promise<boolean> {
    return new Promise((resolveListening) => {
      const probe = createServer();
      probe.once("error", () => resolveListening(true));
      probe.listen(this.ahpPort, "127.0.0.1", () => {
        probe.close(() => resolveListening(false));
      });
    });
  }

  async client(): Promise<HydraClient> {
    return HydraClient.connect({
      wsUrl: `ws://127.0.0.1:${this.port}/acp`,
      token: this.adminToken(),
      clientInfo: { name: "scratch-test", version: "0" },
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(5000)]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
  }

  async destroy(): Promise<void> {
    await this.stop();
    if (existsSync(this.home)) {
      rmSync(this.home, { recursive: true, force: true });
    }
  }
}
