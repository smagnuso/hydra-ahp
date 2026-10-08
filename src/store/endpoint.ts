import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Endpoint {
  address: string;
  scheme: "ws" | "wss";
  wildcard: boolean;
}

// The running extension records what it bound so the command line, which cannot see the daemon's settings, prints the right URL.
export function writeEndpoint(path: string, endpoint: Endpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(endpoint), { mode: 0o600 });
}

export function removeEndpoint(path: string): void {
  rmSync(path, { force: true });
}

export function readEndpoint(path: string): Endpoint | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Endpoint>;
    if (typeof parsed.address !== "string" || (parsed.scheme !== "ws" && parsed.scheme !== "wss")) {
      return undefined;
    }
    return { address: parsed.address, scheme: parsed.scheme, wildcard: parsed.wildcard === true };
  } catch {
    return undefined;
  }
}
