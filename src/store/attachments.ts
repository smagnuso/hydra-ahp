import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function safeName(name: string): string {
  const cleaned = basename(name).replace(/[^\w.-]/g, "_").replace(/^\.+/, "").slice(0, 100);
  return cleaned === "" ? "attachment" : cleaned;
}

// Copies of files a client attached; its own path means nothing on this host, and a link to a copy lets the agent read it in parts.
export class AttachmentStore {
  private seq = 0;

  constructor(readonly root: string) {}

  save(hydraId: string, name: string, bytes: Buffer): string {
    const dir = join(this.root, hydraId.replace(/[^\w.-]/g, "_"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${Date.now().toString(36)}-${this.seq++}-${safeName(name)}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    return path;
  }

  owns(path: string): boolean {
    return path.startsWith(this.root + sep);
  }

  forget(hydraId: string): void {
    rmSync(join(this.root, hydraId.replace(/[^\w.-]/g, "_")), { recursive: true, force: true });
  }

  // Removes session folders nothing has touched for maxAgeMs.
  sweep(maxAgeMs: number): void {
    let folders: string[];
    try {
      folders = readdirSync(this.root);
    } catch {
      return;
    }
    const cutoff = Date.now() - maxAgeMs;
    for (const folder of folders) {
      const path = join(this.root, folder);
      try {
        if (statSync(path).mtimeMs < cutoff) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {
        // Gone already.
      }
    }
  }
}
