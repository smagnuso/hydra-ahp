import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type FileLevel = "scoped" | "read" | "full";

export const FILE_LEVELS: readonly FileLevel[] = ["scoped", "read", "full"];

export const DEFAULT_IDLE_MS = 90 * 24 * 60 * 60 * 1000;

export interface TokenEntry {
  id: string;
  label: string;
  level: FileLevel;
  hash: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export type TokenInfo = Omit<TokenEntry, "hash">;

export interface MintedToken {
  token: string;
  info: TokenInfo;
}

export interface TokenRegistryOptions {
  path: string;
  idleMs?: number;
  now?: () => number;
}

export function defaultStorePath(): string {
  const home = process.env.HYDRA_ACP_HOME ?? join(homedir(), ".hydra-acp");
  return join(home, "extensions", "ahp", "tokens.json");
}

export function isFileLevel(value: unknown): value is FileLevel {
  return typeof value === "string" && (FILE_LEVELS as readonly string[]).includes(value);
}

function sha256(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function toInfo(entry: TokenEntry): TokenInfo {
  const { hash: _hash, ...info } = entry;
  return info;
}

// Tokens are stored only as sha256 digests, in the style of Hydra's session-tokens.json.
export class TokenRegistry {
  private entries: TokenEntry[] = [];
  private readonly path: string;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly revokeListeners = new Set<(id: string) => void>();
  private signature = "";

  constructor(options: TokenRegistryOptions) {
    this.path = options.path;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.now = options.now ?? Date.now;
    this.load();
  }

  mint(label: string, level: FileLevel = "scoped"): MintedToken {
    if (!isFileLevel(level)) {
      throw new Error(`invalid file level: ${String(level)}`);
    }
    this.refresh();
    const token = randomBytes(32).toString("base64url");
    const at = this.now();
    const entry: TokenEntry = {
      id: randomUUID().slice(0, 8),
      label,
      level,
      hash: sha256(token).toString("hex"),
      createdAt: new Date(at).toISOString(),
      lastUsedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + this.idleMs).toISOString(),
    };
    this.entries.push(entry);
    this.save();
    return { token, info: toInfo(entry) };
  }

  // Compares against every entry so timing does not reveal which one matched.
  validate(token: string): TokenInfo | undefined {
    if (!token) {
      return undefined;
    }
    this.refresh();
    return this.match(token);
  }

  // Picks up mints and revokes made by another process (the CLI) and closes connections for revoked ids.
  refresh(): boolean {
    const before = this.signature;
    if (this.fileSignature() === before) {
      return false;
    }
    const known = new Set(this.entries.map((entry) => entry.id));
    this.load();
    const current = new Set(this.entries.map((entry) => entry.id));
    for (const id of known) {
      if (!current.has(id)) {
        for (const listener of this.revokeListeners) {
          listener(id);
        }
      }
    }
    return true;
  }

  private match(token: string): TokenInfo | undefined {
    const digest = sha256(token);
    let match: TokenEntry | undefined;
    for (const entry of this.entries) {
      if (timingSafeEqual(digest, Buffer.from(entry.hash, "hex"))) {
        match = entry;
      }
    }
    if (!match) {
      return undefined;
    }
    const at = this.now();
    if (Date.parse(match.expiresAt) <= at) {
      return undefined;
    }
    match.lastUsedAt = new Date(at).toISOString();
    match.expiresAt = new Date(at + this.idleMs).toISOString();
    this.save();
    return toInfo(match);
  }

  list(): TokenInfo[] {
    return this.entries.map(toInfo);
  }

  revoke(id: string): boolean {
    this.refresh();
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) {
      return false;
    }
    this.entries.splice(index, 1);
    this.save();
    for (const listener of this.revokeListeners) {
      listener(id);
    }
    return true;
  }

  onRevoke(listener: (id: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => {
      this.revokeListeners.delete(listener);
    };
  }

  private fileSignature(): string {
    try {
      const stat = statSync(this.path);
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return "";
    }
  }

  private load(): void {
    this.signature = this.fileSignature();
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.entries = [];
        return;
      }
      throw err;
    }
    const parsed = JSON.parse(text) as { tokens?: TokenEntry[] };
    this.entries = Array.isArray(parsed.tokens) ? parsed.tokens : [];
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ tokens: this.entries }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tmp, this.path);
    this.signature = this.fileSignature();
  }
}
