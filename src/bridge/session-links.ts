// Hydra writes links to other sessions as hydra://[<host>/]sessions/<id>[#turn-<n>] (a fork's "Forked to …", for one), which
// the browser and terminal UI follow. VS Code strips links with schemes it does not know, but opens its own
// agent-host-session://<provider>/<id> links, matching them against each listed session's backend URI, so those are what it gets.

const HYDRA_LINK = /hydra:\/\/(?:[^/\s()<>[\]"'`]+\/)?sessions\/([A-Za-z0-9_-]+)(?:#turn-\d+)?/g;
const LINK_END = /[\s()<>[\]"'`]/;
const PREFIX = "hydra://";
// Past this a held run is not a link still arriving, just text, and is let through.
const MAX_HELD = 300;

export type SessionLinkResolver = (hydraId: string) => string | undefined;

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

// Rewrites the links in `text` that `resolve` knows, leaving the rest as written. A link that is already a markdown link's
// target keeps its text; a bare one becomes a markdown link named for the session. `before` is the text that preceded
// `text`, for telling the two apart across a chunk boundary.
export function rewriteSessionLinks(text: string, resolve: SessionLinkResolver, before = ""): string {
  if (!text.includes(PREFIX)) {
    return text;
  }
  const whole = before + text;
  const rewritten = whole.replace(HYDRA_LINK, (match: string, id: string, offset: number) => {
    if (offset < before.length) {
      return match;
    }
    const link = resolve(hydraIdOf(id));
    if (!link) {
      return match;
    }
    const isTarget = whole[offset - 1] === "(" && whole[offset - 2] === "]";
    return isTarget ? link : `[${id.replace(/^hydra_session_/, "")}](${link})`;
  });
  return rewritten.slice(before.length);
}

// Where to cut streamed text so a link still arriving is held back: the start of an unterminated hydra:// run, or of a
// trailing piece that could become one. text.length when nothing needs holding.
export function holdFrom(text: string): number {
  const start = text.lastIndexOf(PREFIX);
  if (start !== -1 && !LINK_END.test(text.slice(start)) && text.length - start <= MAX_HELD) {
    return start;
  }
  for (let size = Math.min(PREFIX.length - 1, text.length); size > 0; size -= 1) {
    if (text.endsWith(PREFIX.slice(0, size))) {
      return text.length - size;
    }
  }
  return text.length;
}

// One markdown part's text as it streams: links are rewritten whole, never split across the deltas that carry them.
export class LinkStream {
  private held = "";
  private before = "";

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
    const out = rewriteSessionLinks(text, this.resolve, this.before);
    this.before = (this.before + text).slice(-2);
    return out;
  }
}
