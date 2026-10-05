import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { cwdToUri } from "../bridge/ids.js";

const MAX_RESULTS = 50;
const MAX_VISITED = 20000;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const MENTION_RE = /(?:^|\s)@([^\s@]*)$/;

interface Match {
  rel: string;
  score: number;
}

function scoreOf(rel: string, query: string): number | undefined {
  if (query === "") {
    return 3;
  }
  const lower = rel.toLowerCase();
  const name = basename(lower);
  if (name.startsWith(query)) {
    return 0;
  }
  if (name.includes(query)) {
    return 1;
  }
  return lower.includes(query) ? 2 : undefined;
}

// Breadth-first so shallow files win ties; never follows symlinks, so the walk stays under root.
async function walk(root: string, query: string, hidden: boolean): Promise<Match[]> {
  const matches: Match[] = [];
  const queue: string[] = [""];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_VISITED) {
    const rel = queue.shift() as string;
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      visited += 1;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && (hidden || !entry.name.startsWith("."))) {
          queue.push(childRel);
        }
        continue;
      }
      if (!entry.isFile() || (!hidden && entry.name.startsWith("."))) {
        continue;
      }
      const score = scoreOf(childRel, query);
      if (score !== undefined) {
        matches.push({ rel: childRel, score });
      }
    }
  }
  return matches;
}

// Files under root matching the @token that ends at offset.
export async function completeFiles(root: string, text: string, offset: number): Promise<unknown[]> {
  const before = text.slice(0, offset);
  const found = MENTION_RE.exec(before);
  if (!found) {
    return [];
  }
  const query = (found[1] ?? "").toLowerCase();
  const rangeStart = offset - query.length - 1;
  const matches = await walk(root, query, query.startsWith(".") || query.includes("/."));
  matches.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel));
  return matches.slice(0, MAX_RESULTS).map((match) => ({
    insertText: `@${match.rel}`,
    rangeStart,
    rangeEnd: offset,
    attachment: {
      type: "resource",
      label: basename(match.rel),
      displayKind: "document",
      uri: cwdToUri(join(root, match.rel)),
    },
  }));
}
