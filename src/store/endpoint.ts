import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Endpoint {
  address: string;
  scheme: "ws" | "wss";
  wildcard: boolean;
  // The extension that wrote it; a hard kill (Windows SIGTERM) skips removeEndpoint and leaves the file behind.
  pid?: number;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The running extension records what it bound so the command line, which cannot see the daemon's settings, prints the right URL.
export function writeEndpoint(path: string, endpoint: Endpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(endpoint), { mode: 0o600 });
}

export function removeEndpoint(path: string): void {
  rmSync(path, { force: true });
}

export function readEndpoint(path: string, alive: (pid: number) => boolean = pidAlive): Endpoint | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Endpoint>;
    if (typeof parsed.address !== "string" || (parsed.scheme !== "ws" && parsed.scheme !== "wss")) {
      return undefined;
    }
    const pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
    if (pid !== undefined && !alive(pid)) {
      return undefined;
    }
    return { address: parsed.address, scheme: parsed.scheme, wildcard: parsed.wildcard === true, ...(pid !== undefined ? { pid } : {}) };
  } catch {
    return undefined;
  }
}
