import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ConfUpdate {
  [key: string]: string | undefined;
}

interface ParsedLine {
  raw: string;
  key?: string;
  value?: string;
}

function parseLines(text: string): ParsedLine[] {
  return text.split(/\r?\n/).map((raw) => {
    const trimmed = raw.trim();
    const eq = raw.indexOf("=");
    if (!trimmed || trimmed.startsWith("#") || eq === -1) {
      return { raw };
    }
    let value = raw.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return { raw, key: raw.slice(0, eq).trim(), value };
  });
}

export function readConf(path: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(path)) {
    return map;
  }
  for (const line of parseLines(readFileSync(path, "utf8"))) {
    if (line.key !== undefined && line.value !== undefined) {
      map.set(line.key, line.value);
    }
  }
  return map;
}

// The conf file supplies HYDRA_AHP_* defaults under the process env, so `extension restart` picks up a change without Hydra re-reading its env block.
export function withConf(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  for (const [key, value] of readConf(path)) {
    if (key.startsWith("HYDRA_AHP_")) {
      merged[key] = value;
    }
  }
  return { ...merged, ...env };
}

const HEADER = "# hydra-ahp config, written by 'hydra-ahp tailscale setup'. Keys are the HYDRA_AHP_* variables; the process env wins.";

function quoteIfNeeded(value: string): string {
  return /[\s#'"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function mergeConf(existing: string, updates: ConfUpdate): string {
  const remaining = new Map<string, string>();
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      remaining.set(key, value);
    }
  }
  const out: string[] = [];
  for (const line of parseLines(existing)) {
    if (line.key && remaining.has(line.key)) {
      out.push(`${line.key}=${quoteIfNeeded(remaining.get(line.key)!)}`);
      remaining.delete(line.key);
    } else {
      out.push(line.raw);
    }
  }
  if (!existing) {
    out.length = 0;
    out.push(HEADER);
  }
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }
  if (remaining.size > 0) {
    out.push("");
    for (const [key, value] of remaining) {
      out.push(`${key}=${quoteIfNeeded(value)}`);
    }
  }
  return `${out.join("\n")}\n`;
}

// An undefined update value leaves the key as it is; removing a key is left to hand editing.
export function writeConf(path: string, updates: ConfUpdate): void {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, mergeConf(existing, updates), "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod isn't meaningful on Windows
  }
}
