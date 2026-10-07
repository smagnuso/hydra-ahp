// Hydra writes links to other sessions as hydra://[<host>/]sessions/<id>[#turn-<n>] (a fork's "Forked to …", for one), which
// the browser and terminal UI follow, and agents name sessions by their full id. VS Code strips links with schemes it does not
// know, but opens its own agent-host-session://<provider>/<id> links, matching them against each listed session's backend URI,
// so both become those.

const ID = "hydra_session_[A-Za-z0-9]{16}";
const TOKEN = new RegExp(
  [
    String.raw`(?<fence>(?:^|\n) {0,3}(?:\`\`\`|~~~))`,
    `(?<wrapped>\`(?<wrappedId>${ID})\`)`,
    "(?<ticks>`+)",
    String.raw`(?<link>hydra:\/\/(?:[^/\s()<>[\]"'\`]+\/)?sessions\/(?<linkId>[A-Za-z0-9_-]+)(?:#turn-\d+)?)`,
    `(?<id>${ID})`,
  ].join("|"),
  "g",
);
const LINK_END = /[\s()<>[\]"'`]/;
const PREFIXES = ["hydra://", "hydra_session_"];
const ID_LENGTH = "hydra_session_".length + 16;
// Past this a held run is not a link still arriving, just text, and is let through.
const MAX_HELD = 300;

export type SessionLinkResolver = (hydraId: string) => string | undefined;

// Whether the text so far is inside a fenced block or an inline code span, and its last few characters.
export interface LinkScan {
  fence: boolean;
  code: boolean;
  before: string;
}

export const SCAN_START: LinkScan = { fence: false, code: false, before: "" };

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

// A bare id that is part of something else (a longer token, a federated id, a link's text or URL) is left alone.
function standsAlone(whole: string, start: number, end: number): boolean {
  const before = whole.slice(Math.max(0, start - 2), start);
  const next = whole.slice(end, end + 2);
  return !/(?:[A-Za-z0-9_\-/:[]|\]\()$/.test(before) && !/^(?:[A-Za-z0-9_\-\]]|\.[A-Za-z0-9])/.test(next);
}

// Rewrites the links and ids in `text` that `resolve` knows, leaving the rest and anything in code as written, and returns
// the scan state after it. A hydra:// link that is a markdown link's target keeps its text; a bare one, or a bare or
// backticked id, becomes a markdown link.
export function scanSessionLinks(text: string, resolve: SessionLinkResolver, scan: LinkScan = SCAN_START): { text: string; scan: LinkScan } {
  const whole = scan.before + text;
  const skip = scan.before.length;
  let { fence, code } = scan;
  let out = "";
  let at = skip;
  for (const match of whole.matchAll(TOKEN)) {
    const groups = match.groups ?? {};
    const start = match.index;
    const end = start + match[0].length;
    if (groups.fence !== undefined) {
      if (end - 3 >= skip) {
        fence = !fence;
        code = false;
      }
      continue;
    }
    if (start < skip || fence) {
      continue;
    }
    let replacement: string | undefined;
    if (groups.ticks !== undefined) {
      code = !code;
    } else if (code) {
      if (groups.wrapped !== undefined) {
        continue;
      }
    } else if (groups.wrapped !== undefined) {
      const link = resolve(groups.wrappedId as string);
      replacement = link ? `[\`${groups.wrappedId}\`](${link})` : undefined;
    } else if (groups.link !== undefined) {
      const id = groups.linkId as string;
      const link = resolve(hydraIdOf(id));
      if (link) {
        replacement = whole[start - 1] === "(" && whole[start - 2] === "]" ? link : `[${id.replace(/^hydra_session_/, "")}](${link})`;
      }
    } else if (groups.id !== undefined && standsAlone(whole, start, end)) {
      const link = resolve(groups.id);
      replacement = link ? `[${groups.id}](${link})` : undefined;
    }
    if (replacement !== undefined) {
      out += whole.slice(at, start) + replacement;
      at = end;
    }
  }
  out += whole.slice(at);
  return { text: out, scan: { fence, code, before: whole.slice(-6) } };
}

export function rewriteSessionLinks(text: string, resolve: SessionLinkResolver): string {
  return scanSessionLinks(text, resolve).text;
}

// Where to cut streamed text so a link or id still arriving is held back, with the backtick that may open it and a character
// or two past an id to see what follows: an unterminated hydra:// run, a trailing id, or a trailing piece that could become
// either. text.length when nothing needs holding.
export function holdFrom(text: string): number {
  const withTick = (index: number): number => (index > 0 && text[index - 1] === "`" ? index - 1 : index);
  let cut = text.length;
  const link = text.lastIndexOf("hydra://");
  if (link !== -1 && !LINK_END.test(text.slice(link)) && text.length - link <= MAX_HELD) {
    cut = Math.min(cut, link);
  }
  const id = text.lastIndexOf("hydra_session_");
  if (id !== -1 && text.length < id + ID_LENGTH + 2) {
    cut = Math.min(cut, withTick(id));
  }
  for (let size = Math.min(PREFIXES[1]!.length - 1, text.length); size > 0; size -= 1) {
    const tail = text.slice(text.length - size);
    if (PREFIXES.some((prefix) => prefix.startsWith(tail))) {
      cut = Math.min(cut, withTick(text.length - size));
      break;
    }
  }
  const ticks = /[`~]+$/.exec(text);
  if (ticks) {
    cut = Math.min(cut, ticks.index);
  }
  return cut;
}

// One markdown part's text as it streams: links and ids are rewritten whole, never split across the deltas that carry them.
export class LinkStream {
  private held = "";
  private scan: LinkScan = SCAN_START;

  constructor(private readonly resolve: SessionLinkResolver) {}

  push(chunk: string): string {
    const all = this.held + chunk;
    const cut = holdFrom(all);
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
    const scanned = scanSessionLinks(text, this.resolve, this.scan);
    this.scan = scanned.scan;
    return scanned.text;
  }
}
