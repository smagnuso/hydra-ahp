import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SessionFlags {
  isRead: boolean;
  isArchived: boolean;
  // When the session was marked done, in ms; marks from before this was kept have none.
  archivedAt?: number;
}

export const NO_FLAGS: SessionFlags = { isRead: false, isArchived: false };

export function sameFlags(a: SessionFlags, b: SessionFlags): boolean {
  return a.isRead === b.isRead && a.isArchived === b.isArchived && a.archivedAt === b.archivedAt;
}

// Marking done stamps the time and clearing it drops the time, so a later turn can tell whether it came after.
export function patchedFlags(before: SessionFlags, patch: Partial<SessionFlags>, now = Date.now()): SessionFlags {
  const next = { ...before, ...patch };
  if (!next.isArchived) {
    delete next.archivedAt;
  } else if (!before.isArchived && patch.archivedAt === undefined) {
    next.archivedAt = now;
  }
  return next;
}

export function readFlags(value: unknown): SessionFlags {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof SessionFlags, unknown>>;
  const isArchived = raw.isArchived === true;
  return {
    isRead: raw.isRead === true,
    isArchived,
    ...(isArchived && typeof raw.archivedAt === "number" ? { archivedAt: raw.archivedAt } : {}),
  };
}

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
    const next = patchedFlags(before, patch);
    if (sameFlags(next, before)) {
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
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [id, value] of Object.entries(parsed)) {
        const flags = readFlags(value);
        if (flags.isRead || flags.isArchived) {
          this.flags.set(id, flags);
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
