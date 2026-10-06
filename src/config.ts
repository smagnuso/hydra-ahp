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
  permissionDelayMs: number;
  debug: boolean;
  showImported: boolean;
  tokensPath: string;
  flagsPath: string;
  modelsPath: string;
  configsPath: string;
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

function booleanFrom(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) {
    return false;
  }
  throw new Error(`${key} must be a boolean, got ${raw}`);
}

export function hydraHome(env: NodeJS.ProcessEnv): string {
  return env.HYDRA_ACP_HOME ?? join(homedir(), ".hydra-acp");
}

export function tokensPath(env: NodeJS.ProcessEnv): string {
  return join(hydraHome(env), "extensions", "ahp", "tokens.json");
}

export function flagsPath(env: NodeJS.ProcessEnv): string {
  return join(hydraHome(env), "extensions", "ahp", "flags.json");
}

export function modelsPath(env: NodeJS.ProcessEnv): string {
  return join(hydraHome(env), "extensions", "ahp", "models.json");
}

export function configsPath(env: NodeJS.ProcessEnv): string {
  return join(hydraHome(env), "extensions", "ahp", "configs.json");
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
// Long enough for an auto-approver to answer first, so its requests never flash up in the client.
const DEFAULT_PERMISSION_DELAY_MS = 500;

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
    permissionDelayMs: numberFrom(env, "HYDRA_AHP_PERMISSION_DELAY_MS") ?? DEFAULT_PERMISSION_DELAY_MS,
    debug: env.HYDRA_AHP_LOG_LEVEL === "debug",
    // Sessions copied in from another machine are someone else's work and usually outnumber this machine's own.
    showImported: booleanFrom(env, "HYDRA_AHP_SHOW_IMPORTED", false),
    tokensPath: tokensPath(env),
    flagsPath: flagsPath(env),
    modelsPath: modelsPath(env),
    configsPath: configsPath(env),
    dirRoots: dirRoots(env),
  };
}
