import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const MAX_BUFFER = 64 * 1024 * 1024;
// Untracked files are counted line by line; past this size they are shown without a count.
const MAX_COUNTED_BYTES = 1024 * 1024;

export interface ChangedFile {
  // Path relative to the repository root, as git prints it.
  path: string;
  inHead: boolean;
  onDisk: boolean;
  added?: number;
  removed?: number;
}

export interface WorkingChanges {
  root: string;
  files: ChangedFile[];
}

function git(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: MAX_BUFFER, encoding: "buffer" }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function fields(output: Buffer): string[] {
  return output.toString("utf8").split("\0").filter((entry) => entry !== "");
}

// Walks up from cwd rather than taking --show-toplevel, which resolves symlinks and would name files by a path the session does not use.
export async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    const prefix = (await git(cwd, ["rev-parse", "--show-prefix"])).toString("utf8").trim();
    const depth = prefix.split("/").filter((segment) => segment !== "").length;
    return resolve(cwd, ...Array<string>(depth).fill(".."));
  } catch {
    return undefined;
  }
}

async function hasHead(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

// What differs from HEAD in the working tree, staged or not, untracked files included; undefined outside a repository.
export async function workingChanges(cwd: string): Promise<WorkingChanges | undefined> {
  const root = await repoRoot(cwd);
  if (!root) {
    return undefined;
  }
  const headExists = await hasHead(root);
  const status = fields(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]));
  const counts = new Map<string, { added?: number; removed?: number }>();
  if (headExists) {
    const numstat = fields(await git(root, ["diff", "HEAD", "--numstat", "-z", "--no-renames"]));
    for (const line of numstat) {
      const [added, removed, path] = line.split("\t");
      if (path === undefined) {
        continue;
      }
      counts.set(path, {
        ...(added !== "-" ? { added: Number(added) } : {}),
        ...(removed !== "-" ? { removed: Number(removed) } : {}),
      });
    }
  }
  const files: ChangedFile[] = [];
  for (const entry of status) {
    const index = entry[0];
    const tree = entry[1];
    const path = entry.slice(3);
    const inHead = headExists && entry.slice(0, 2) !== "??" && index !== "A";
    const onDisk = index !== "D" && tree !== "D";
    if (!inHead && !onDisk) {
      continue;
    }
    const counted = counts.get(path) ?? (inHead ? {} : await countLines(join(root, path)));
    files.push({ path, inHead, onDisk, ...counted });
  }
  return { root, files };
}

async function countLines(file: string): Promise<{ added?: number }> {
  try {
    if ((await stat(file)).size > MAX_COUNTED_BYTES) {
      return {};
    }
    const bytes = await readFile(file);
    if (bytes.includes(0)) {
      return {};
    }
    const text = bytes.toString("utf8");
    if (text === "") {
      return { added: 0 };
    }
    return { added: text.split("\n").length - (text.endsWith("\n") ? 1 : 0) };
  } catch {
    return {};
  }
}

// A file's content at a revision, HEAD or a commit sha.
export async function contentAt(root: string, rev: string, path: string): Promise<Buffer> {
  return git(root, ["show", `${rev}:${path}`]);
}

// The commit HEAD's history was at by a given time, or undefined when there was none yet.
export async function commitAt(root: string, iso: string): Promise<string | undefined> {
  try {
    return (await git(root, ["rev-list", "-1", `--before=${iso}`, "HEAD"])).toString("utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

// How the given repository-relative paths differ now from a base commit; unchanged ones are left out.
export async function changesSince(root: string, base: string | undefined, paths: string[]): Promise<ChangedFile[]> {
  if (paths.length === 0) {
    return [];
  }
  const baseBlobs = new Map<string, string>();
  if (base) {
    for (const entry of fields(await git(root, ["ls-tree", "-r", "-z", base, "--", ...paths]))) {
      const tab = entry.indexOf("\t");
      const blob = entry.slice(0, tab).split(" ")[2];
      if (blob) {
        baseBlobs.set(entry.slice(tab + 1), blob);
      }
    }
  }
  const onDisk = (
    await Promise.all(
      paths.map(async (path) => {
        try {
          return (await stat(join(root, path))).isFile() ? path : undefined;
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((path): path is string => path !== undefined);
  const diskBlobs = new Map<string, string>();
  if (onDisk.length > 0) {
    const hashes = (await git(root, ["hash-object", "--", ...onDisk])).toString("utf8").trim().split("\n");
    onDisk.forEach((path, index) => diskBlobs.set(path, hashes[index] ?? ""));
  }
  const counts = new Map<string, { added?: number; removed?: number }>();
  if (base) {
    for (const line of fields(await git(root, ["diff", "--numstat", "-z", "--no-renames", base, "--", ...paths]))) {
      const [added, removed, path] = line.split("\t");
      if (path !== undefined) {
        counts.set(path, {
          ...(added !== "-" ? { added: Number(added) } : {}),
          ...(removed !== "-" ? { removed: Number(removed) } : {}),
        });
      }
    }
  }
  const files: ChangedFile[] = [];
  for (const path of paths) {
    const before = baseBlobs.get(path);
    const after = diskBlobs.get(path);
    if (before === after) {
      continue;
    }
    const counted = counts.get(path) ?? (before === undefined && after !== undefined ? await countLines(join(root, path)) : {});
    files.push({ path, inHead: before !== undefined, onDisk: after !== undefined, ...counted });
  }
  return files;
}
