import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// Ported from the browser extension's file-window.ts.
export const DEFAULT_WINDOW_LINES = 500;
export const MAX_WINDOW_LINES = 4000;
const LOCATE_CONTEXT_LINES = 200;

export interface FileWindow {
  // 1-based line of the first line in content.
  fromLine: number;
  content: string;
  hasMore: boolean;
  matchedLine?: number;
}

export interface WindowRequest {
  fromLine?: number;
  lineCount?: number;
  // Full-line text to centre the window on; fromLine is ignored when it matches.
  locate?: string;
}

// Streams the file so only the requested window is held in memory.
export async function readFileWindow(path: string, req: WindowRequest = {}): Promise<FileWindow> {
  const lineCount = Math.min(Math.max(1, Math.floor(req.lineCount ?? DEFAULT_WINDOW_LINES)), MAX_WINDOW_LINES);
  if (req.locate !== undefined && req.locate.length > 0) {
    return readAroundAnchor(path, req.locate, lineCount);
  }
  const fromLine = Math.max(1, Math.floor(req.fromLine ?? 1));
  return readRange(path, fromLine, lineCount);
}

async function readRange(path: string, fromLine: number, lineCount: number): Promise<FileWindow> {
  const until = fromLine + lineCount - 1;
  const kept: string[] = [];
  let lineNo = 0;
  let hasMore = false;
  const { rl, stream } = lines(path);
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < fromLine) {
        continue;
      }
      if (lineNo > until) {
        hasMore = true;
        break;
      }
      kept.push(line);
    }
  } finally {
    await closeLines(rl, stream);
  }
  return { fromLine, content: kept.join("\n"), hasMore };
}

async function readAroundAnchor(path: string, anchor: string, lineCount: number): Promise<FileWindow> {
  const before = Math.min(LOCATE_CONTEXT_LINES, Math.floor(lineCount / 2));
  const lead: string[] = [];
  let lineNo = 0;
  let matchedLine: number | null = null;
  const kept: string[] = [];
  let hasMore = false;
  const { rl, stream } = lines(path);
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (matchedLine === null) {
        if (line === anchor) {
          matchedLine = lineNo;
          kept.push(...lead, line);
          continue;
        }
        lead.push(line);
        if (lead.length > before) {
          lead.shift();
        }
        continue;
      }
      if (kept.length >= lineCount) {
        hasMore = true;
        break;
      }
      kept.push(line);
    }
  } finally {
    await closeLines(rl, stream);
  }
  if (matchedLine === null) {
    return readRange(path, 1, lineCount);
  }
  const fromLine = Math.max(1, matchedLine - Math.min(before, lead.length));
  return { fromLine, content: kept.join("\n"), hasMore, matchedLine };
}

function lines(path: string): {
  rl: ReturnType<typeof createInterface>;
  stream: ReturnType<typeof createReadStream>;
} {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  return { rl, stream };
}

// rl.close() leaves the fd open until the stream settles, so wait for it.
async function closeLines(
  rl: ReturnType<typeof createInterface>,
  stream: ReturnType<typeof createReadStream>,
): Promise<void> {
  rl.close();
  if (stream.destroyed || stream.closed) {
    return;
  }
  await new Promise<void>((resolve) => {
    stream.once("close", () => resolve());
    stream.destroy();
  });
}
