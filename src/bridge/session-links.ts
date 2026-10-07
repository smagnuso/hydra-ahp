import { type FileLinks, PATH_TOKEN, trimMention } from "./file-links.js";

// Hydra writes links to other sessions as hydra://[<host>/]sessions/<id>[#turn-<n>] (a fork's "Forked to …", for one), which
// the browser and terminal UI follow, and agents name sessions by their full id. VS Code strips links with schemes it does not
// know, but opens its own agent-host-session://<provider>/<id> links, matching them against each listed session's backend URI,
// so both become those. Files are linked too (file-links.ts).

const ID = "hydra_session_[A-Za-z0-9]{16}";
const HYDRA_LINK = String.raw`hydra:\/\/(?:[^/\s()<>[\]"'\`]+\/)?sessions\/([A-Za-z0-9_-]+)(?:#turn-\d+)?`;
const WHOLE_ID = new RegExp(`^${ID}$`);
const WHOLE_HYDRA_LINK = new RegExp(`^${HYDRA_LINK}$`);
const TOKEN = new RegExp(
  [
    String.raw`(?<fence>(?:^|(?<=\n)) {0,3}(?:\`\`\`|~~~))`,
    "`(?<tick>[^`\\s]{1,512})`",
    "(?<ticks>`+)",
    String.raw`\]\((?<target>[^()\s]*)\)`,
    `(?<link>${HYDRA_LINK})`,
    String.raw`(?<url>[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>()[\]"'\`]*)`,
    String.raw`(?<open>\[)`,
    String.raw`(?<close>\])`,
    `(?<id>${ID})`,
    `(?<path>${PATH_TOKEN})`,
  ].join("|"),
  "g",
);
const LINK_END = /[\s()<>[\]"'`]/;
// A one-word code span still open or just closed (one opens after a space or bracket), or a word still being written.
const TRAILING_TOKEN = /(?:(?<=^|[\s([{"'*_>])`[^`\s]*`?|[A-Za-z0-9_@./+#:-]+)$/;
const SESSION_PREFIXES = ["hydra://", "hydra_session_"];
// Past this a held run is not a link still arriving, just text, and is let through.
const MAX_HELD = 512;

export type SessionLinkResolver = (hydraId: string) => string | undefined;

export interface Linkers {
  session?: SessionLinkResolver;
  files?: FileLinks;
}

// Whether the text so far is inside a fenced block, an inline code span or a link's text, and its last few characters.
export interface LinkScan {
  fence: boolean;
  code: boolean;
  bracket: boolean;
  before: string;
}

export const SCAN_START: LinkScan = { fence: false, code: false, bracket: false, before: "" };

export function hydraIdOf(id: string): string {
  return id.startsWith("hydra_session_") ? id : `hydra_session_${id}`;
}

// The VS Code link for a session's AHP URI (`<agent>:/<hydraId>`); undefined for a URI without a path.
export function vscodeSessionLink(sessionUri: string): string | undefined {
  const colon = sessionUri.indexOf(":");
  const path = sessionUri.slice(colon + 1).replace(/^\/+/, "");
  if (colon <= 0 || !path) {
    return undefined;
  }
  return `agent-host-session://${sessionUri.slice(0, colon)}/${path}`;
}

function hydraLinkTarget(link: string, linkers: Linkers): string | undefined {
  const id = new RegExp(HYDRA_LINK).exec(link)?.[1];
  return id === undefined ? undefined : linkers.session?.(hydraIdOf(id));
}

// A bare id that is part of something else (a longer token, a federated id) is left alone.
function standsAlone(whole: string, start: number, end: number): boolean {
  const prev = whole[start - 1] ?? "";
  const next = whole.slice(end, end + 2);
  return !/[A-Za-z0-9_\-/:]/.test(prev) && !/^(?:[A-Za-z0-9_-]|\.[A-Za-z0-9])/.test(next);
}

function rewrite(groups: Record<string, string | undefined>, whole: string, start: number, end: number, linkers: Linkers): string | undefined {
  if (groups.tick !== undefined) {
    const body = groups.tick;
    const link = WHOLE_ID.test(body) ? linkers.session?.(body) : linkers.files?.mention(body);
    return link ? `[\`${body}\`](${link})` : undefined;
  }
  if (groups.link !== undefined) {
    const link = hydraLinkTarget(groups.link, linkers);
    const id = /sessions\/([A-Za-z0-9_-]+)/.exec(groups.link)![1]!;
    return link ? `[${id.replace(/^hydra_session_/, "")}](${link})` : undefined;
  }
  if (groups.id !== undefined) {
    const link = standsAlone(whole, start, end) ? linkers.session?.(groups.id) : undefined;
    return link ? `[${groups.id}](${link})` : undefined;
  }
  if (groups.path !== undefined && whole[start - 1] !== "~") {
    const token = trimMention(groups.path);
    const link = token ? linkers.files?.mention(token) : undefined;
    return link ? `[${token}](${link})${groups.path.slice(token.length)}` : undefined;
  }
  return undefined;
}

// Rewrites the links, ids and file names in `text` that `linkers` know, leaving the rest and anything in code as written, and
// returns the scan state after it. A link target is rewritten in place; a bare link, id or file name becomes a markdown link.
export function scanLinks(text: string, linkers: Linkers, scan: LinkScan = SCAN_START): { text: string; scan: LinkScan } {
  const whole = scan.before + text;
  const skip = scan.before.length;
  let { fence, code, bracket } = scan;
  let out = "";
  let at = skip;
  let last = skip;
  const tokens = new RegExp(TOKEN);
  tokens.lastIndex = skip;
  for (let match = tokens.exec(whole); match; match = tokens.exec(whole)) {
    const groups = match.groups ?? {};
    const start = match.index;
    const end = start + match[0].length;
    if (groups.fence !== undefined) {
      fence = !fence;
      code = false;
      bracket = false;
      last = end;
      continue;
    }
    if (whole.slice(last, start).includes("\n")) {
      bracket = false;
    }
    last = end;
    if (fence) {
      continue;
    }
    if (groups.ticks !== undefined) {
      code = !code;
      continue;
    }
    if (code) {
      continue;
    }
    let replacement: string | undefined;
    if (groups.target !== undefined) {
      bracket = false;
      const target = groups.target;
      const link = WHOLE_HYDRA_LINK.test(target) ? hydraLinkTarget(target, linkers) : linkers.files?.target(target);
      replacement = link ? `](${link})` : undefined;
    } else if (groups.open !== undefined) {
      bracket = true;
    } else if (groups.close !== undefined) {
      bracket = false;
    } else if (!bracket && groups.url === undefined) {
      replacement = rewrite(groups, whole, start, end, linkers);
    }
    if (replacement !== undefined) {
      out += whole.slice(at, start) + replacement;
      at = end;
    }
  }
  out += whole.slice(at);
  return { text: out, scan: { fence, code, bracket, before: whole.slice(-6) } };
}

export function rewriteLinks(text: string, linkers: Linkers): string {
  return scanLinks(text, linkers).text;
}

// Whether a trailing word could still become a session id or link, for streams that link no files.
function maybeSession(token: string): boolean {
  const word = token.replace(/`/g, "");
  return word !== "" && SESSION_PREFIXES.some((prefix) => prefix.startsWith(word) || word.startsWith(prefix));
}

// Where to cut streamed text so whatever may still become a link is held back: the word or one-word code span being written
// (any word when files are linked, else one that may become a session id), an unterminated hydra:// run or link target, and
// a run of backticks or tildes that may open a fence. Past MAX_HELD a run is let through. text.length when nothing needs
// holding.
export function holdFrom(text: string, words = true): number {
  let cut = text.length;
  const hold = (index: number): void => {
    if (text.length - index <= MAX_HELD) {
      cut = Math.min(cut, index);
    }
  };
  const link = text.lastIndexOf("hydra://");
  if (link !== -1 && !LINK_END.test(text.slice(link))) {
    hold(link);
  }
  const target = text.lastIndexOf("](");
  if (target !== -1 && !/[()\s]/.test(text.slice(target + 2))) {
    hold(target);
  }
  if (text.endsWith("]")) {
    hold(text.length - 1);
  }
  const token = TRAILING_TOKEN.exec(text);
  if (token && (words || maybeSession(token[0]))) {
    hold(token.index);
  }
  const ticks = /[`~]+$/.exec(text);
  if (ticks) {
    hold(ticks.index);
  }
  return cut;
}

// One markdown part's text as it streams: links are rewritten whole, never split across the deltas that carry them.
export class LinkStream {
  private held = "";
  private scan: LinkScan = SCAN_START;

  constructor(private readonly linkers: Linkers) {}

  get holding(): boolean {
    return this.held !== "";
  }

  push(chunk: string): string {
    const all = this.held + chunk;
    const cut = holdFrom(all, this.linkers.files !== undefined);
    this.held = all.slice(cut);
    return this.emit(all.slice(0, cut));
  }

  flush(): string {
    const rest = this.held;
    this.held = "";
    return this.emit(rest);
  }

  private emit(text: string): string {
    if (text === "") {
      return "";
    }
    const scanned = scanLinks(text, this.linkers, this.scan);
    this.scan = scanned.scan;
    return scanned.text;
  }
}
