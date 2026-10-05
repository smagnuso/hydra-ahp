import { delimiter, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_PORT = 55590;

export interface Config {
  daemonUrl: string;
  wsUrl: string;
  token: string;
  home: string;
  port: number;
  idleMs: number | undefined;
  pollMs: number | undefined;
  warmPollMs: number | undefined;
  debug: boolean;
  tokensPath: string;
  dirRoots: string[];
}

function numberFrom(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative number, got ${raw}`);
  }
  return value;
}

export function hydraHome(env: NodeJS.ProcessEnv): string {
  return env.HYDRA_ACP_HOME ?? join(homedir(), ".hydra-acp");
}

export function tokensPath(env: NodeJS.ProcessEnv): string {
  return join(hydraHome(env), "extensions", "ahp", "tokens.json");
}

// Directories the folder picker may browse (directories only) at the scoped level; defaults to the home directory.
export function dirRoots(env: NodeJS.ProcessEnv): string[] {
  const raw = env.HYDRA_AHP_DIR_ROOTS;
  if (raw === undefined) {
    return [homedir()];
  }
  return raw.split(delimiter).filter((entry) => entry !== "");
}

// Hydra injects the daemon coordinates and the extension token; the HYDRA_AHP_* variables come from the config.json env block.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.HYDRA_ACP_TOKEN;
  if (!token) {
    throw new Error("HYDRA_ACP_TOKEN is not set: hydra-ahp runs as a Hydra extension (register it as 'ahp' in config.json)");
  }
  const daemonUrl = env.HYDRA_ACP_DAEMON_URL ?? `http://127.0.0.1:${env.HYDRA_ACP_DAEMON_PORT ?? "55514"}`;
  const wsUrl = env.HYDRA_ACP_WS_URL ?? `${daemonUrl.replace(/^http/, "ws")}/acp`;
  const idleDays = numberFrom(env, "HYDRA_AHP_TOKEN_IDLE_DAYS");
  return {
    daemonUrl,
    wsUrl,
    token,
    home: hydraHome(env),
    port: numberFrom(env, "HYDRA_AHP_PORT") ?? DEFAULT_PORT,
    idleMs: idleDays === undefined ? undefined : idleDays * 24 * 60 * 60 * 1000,
    pollMs: numberFrom(env, "HYDRA_AHP_POLL_MS"),
    warmPollMs: numberFrom(env, "HYDRA_AHP_WARM_POLL_MS"),
    debug: env.HYDRA_AHP_LOG_LEVEL === "debug",
    tokensPath: tokensPath(env),
    dirRoots: dirRoots(env),
  };
}
