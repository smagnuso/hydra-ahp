import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SessionFlags {
  isRead: boolean;
  isArchived: boolean;
}

export const NO_FLAGS: SessionFlags = { isRead: false, isArchived: false };

// Read and archive marks of federated sessions, keyed by Hydra session id; local sessions keep theirs in extension_state.
export class FlagStore {
  private readonly flags = new Map<string, SessionFlags>();

  constructor(private readonly path: string) {
    this.load();
  }

  get(hydraId: string): SessionFlags {
    return this.flags.get(hydraId) ?? NO_FLAGS;
  }

  // Returns whether anything changed.
  set(hydraId: string, patch: Partial<SessionFlags>): boolean {
    const before = this.get(hydraId);
    const next = { ...before, ...patch };
    if (next.isRead === before.isRead && next.isArchived === before.isArchived) {
      return false;
    }
    if (!next.isRead && !next.isArchived) {
      this.flags.delete(hydraId);
    } else {
      this.flags.set(hydraId, next);
    }
    this.save();
    return true;
  }

  forget(hydraId: string): void {
    if (this.flags.delete(hydraId)) {
      this.save();
    }
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<SessionFlags>>;
      for (const [id, value] of Object.entries(parsed)) {
        const isRead = value.isRead === true;
        const isArchived = value.isArchived === true;
        if (isRead || isArchived) {
          this.flags.set(id, { isRead, isArchived });
        }
      }
    } catch {
      // A corrupt file only loses read and archive marks.
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.flags), null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
