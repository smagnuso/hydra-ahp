import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

// Ported from the browser extension's routes-files.ts (resolveScopedPath) and session-files.ts.

export class PathScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathScopeError";
  }
}

// Realpath that tolerates a missing tail: resolves the deepest existing ancestor and re-appends the rest.
export async function realpathLoose(path: string): Promise<string> {
  const target = resolve(path);
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw err;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return target;
    }
    tail.push(basename(current));
    current = parent;
  }
}

export function isInside(root: string, path: string): boolean {
  if (path === root) {
    return true;
  }
  const prefix = root.endsWith(sep) ? root : root + sep;
  return path.startsWith(prefix);
}

const MAX_PATHS_PER_SESSION = 500;

// Per-session allowlist of individual files the agent was seen editing, so files outside the cwd stay reachable.
export class EditedPaths {
  private readonly sets = new Map<string, Set<string>>();

  // Federated sessions are skipped: remote edits must not authorise a local read of the same path.
  record(sessionId: string, path: string): void {
    if (sessionId.includes(":") || !isAbsolute(path)) {
      return;
    }
    let set = this.sets.get(sessionId);
    if (!set) {
      set = new Set();
      this.sets.set(sessionId, set);
    }
    set.delete(path);
    set.add(path);
    while (set.size > MAX_PATHS_PER_SESSION) {
      const oldest = set.values().next().value;
      if (oldest === undefined) {
        break;
      }
      set.delete(oldest);
    }
  }

  // Feed each session/update from Hydra (live and replayed) through here.
  observe(sessionId: string, update: unknown): void {
    const paths = [...extractEditedPaths(update)];
    const content = (update as { content?: unknown } | null)?.content;
    if (content !== undefined) {
      paths.push(...extractResourceLinkImagePaths(content));
    }
    for (const path of paths) {
      this.record(sessionId, path);
    }
  }

  forget(sessionId: string): void {
    this.sets.delete(sessionId);
  }

  // Compares realpaths, never the requested string, so a "x/../../.ssh/id_rsa" request cannot match.
  async has(realTarget: string): Promise<boolean> {
    for (const set of this.sets.values()) {
      for (const candidate of set) {
        if (resolve(candidate) === realTarget) {
          return true;
        }
        if ((await realpathLoose(candidate).catch(() => undefined)) === realTarget) {
          return true;
        }
      }
    }
    return false;
  }
}

// Only calls that carry a diff block or write-shaped input count; a Read that names a path must not.
export function extractEditedPaths(update: unknown): string[] {
  if (!update || typeof update !== "object") {
    return [];
  }
  const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
  if (kind !== "tool_call" && kind !== "tool_call_update") {
    return [];
  }
  const u = update as Record<string, unknown>;
  const out: string[] = [];
  if (Array.isArray(u.content)) {
    for (const block of u.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      if (b.type === "diff" && typeof b.path === "string" && b.path) {
        out.push(b.path);
      }
    }
  }
  const rawOutput = u.rawOutput;
  if (rawOutput && typeof rawOutput === "object") {
    const metadata = (rawOutput as Record<string, unknown>).metadata;
    const files = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).files : undefined;
    if (Array.isArray(files)) {
      for (const f of files) {
        if (!f || typeof f !== "object") {
          continue;
        }
        const e = f as Record<string, unknown>;
        if (typeof e.filePath === "string" && e.filePath && e.patch !== undefined) {
          out.push(e.filePath);
        }
      }
    }
  }
  const rawInput = u.rawInput;
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const r = rawInput as Record<string, unknown>;
    const isWrite =
      typeof r.old_string === "string" || typeof r.oldString === "string" || typeof r.content === "string";
    if (isWrite) {
      for (const key of ["file_path", "filePath", "path"]) {
        const v = r[key];
        if (typeof v === "string" && v) {
          out.push(v);
        }
      }
    }
  }
  return out;
}

function fileUriToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

// Image resource_links an agent saved outside the cwd (a /tmp scratch dir is typical).
export function extractResourceLinkImagePaths(content: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    const n = node as Record<string, unknown>;
    if (n.type === "resource_link") {
      const raw = typeof n.uri === "string" ? n.uri : typeof n.name === "string" ? n.name : undefined;
      const path = raw?.startsWith("file:") ? fileUriToPath(raw) : raw;
      if (path && IMAGE_EXT_RE.test(path)) {
        out.push(path);
      }
    }
    if (n.content !== undefined) {
      walk(n.content);
    }
  };
  walk(content);
  return out;
}
