import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// VS Code opens an absolute file link through the agent host but shows a relative one as plain text, and links no path an
// agent merely names. Relative link targets and named files become file:// links; the browser's rules decide what counts.

// The browser's path-ish run (file-mentions.ts): loose, since the existence check is the real filter.
export const PATH_TOKEN = String.raw`[A-Za-z0-9_@./+#-]{2,}(?::\d+){0,2}`;
const LINE_SUFFIX = /^(.+?)(?::(\d+))(?::\d+)?$/;
const LINE_FRAGMENT = /^(.*?)#L(\d+)(?:-L?(\d+))?$/;
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MAX_PATH = 512;

export interface FileRef {
  path: string;
  line?: number;
  lineEnd?: number;
}

// A path separator or a dot-extension starting with a letter, which keeps versions and decimals out.
function pathShaped(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH || /^[./]+$/.test(path)) {
    return false;
  }
  return path.includes("/") || /\.[A-Za-z][A-Za-z0-9]*$/.test(path);
}

function withRange(path: string, line: string | undefined, end: string | undefined): FileRef {
  return {
    path,
    ...(line === undefined ? {} : { line: Number(line) }),
    ...(end === undefined ? {} : { lineEnd: Number(end) }),
  };
}

// A named file: `path`, `path:line[:col]` or `path#L<line>[-L<end>]`.
export function parseMention(token: string): FileRef | undefined {
  const fragment = LINE_FRAGMENT.exec(token);
  if (fragment) {
    return pathShaped(fragment[1]!) ? withRange(fragment[1]!, fragment[2], fragment[3]) : undefined;
  }
  if (token.includes("#")) {
    return undefined;
  }
  const suffix = LINE_SUFFIX.exec(token);
  const path = suffix ? suffix[1]! : token;
  return pathShaped(path) ? withRange(path, suffix?.[2], undefined) : undefined;
}

// A markdown link target naming a project file: scheme-less and relative, path-shaped or with a #L fragment.
export function parseRelativeTarget(target: string): FileRef | undefined {
  if (SCHEME.test(target) || target === "" || target.startsWith("/") || target.startsWith("#") || isAbsolute(target)) {
    return undefined;
  }
  const fragment = LINE_FRAGMENT.exec(target);
  if (!fragment && target.includes("#")) {
    return undefined;
  }
  const path = (fragment ? fragment[1]! : target).replace(/^\.\//, "");
  if (!path || (!fragment && !pathShaped(path))) {
    return undefined;
  }
  return withRange(path, fragment?.[2], fragment?.[3]);
}

// Splits a mention token from the sentence punctuation that follows it.
export function trimMention(token: string): string {
  return token.replace(TRAILING_PUNCT, "");
}

// A markdown link target ends at an unbalanced parenthesis, so those in the path are escaped.
function fileLink(path: string, ref: FileRef): string {
  const url = pathToFileURL(path).href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  if (ref.line === undefined) {
    return url;
  }
  return ref.lineEnd === undefined ? `${url}#L${ref.line}` : `${url}#L${ref.line}-L${ref.lineEnd}`;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// File links for one session's text, resolved against its cwd on this machine.
export class FileLinks {
  private root: string | undefined;
  private readonly found = new Map<string, string>();

  constructor(private cwd: string) {}

  // The session moved to another directory; what was found or resolved against the old one no longer holds.
  retarget(cwd: string): void {
    this.cwd = cwd;
    this.root = undefined;
    this.found.clear();
  }

  // A relative link target the agent wrote; it chose to link, so the file is not looked for.
  target(target: string): string | undefined {
    const ref = parseRelativeTarget(target);
    return ref ? fileLink(resolve(this.cwd, ref.path), ref) : undefined;
  }

  // A file the agent named: one inside the cwd, or anywhere for an absolute path, that exists now.
  mention(token: string): string | undefined {
    const ref = parseMention(token);
    if (!ref) {
      return undefined;
    }
    const path = this.locate(ref.path);
    return path ? fileLink(path, ref) : undefined;
  }

  // Only hits are kept: a file the agent names before creating it links once it exists.
  private locate(path: string): string | undefined {
    const known = this.found.get(path);
    if (known) {
      return known;
    }
    const located = isAbsolute(path) ? (isFile(path) ? path : undefined) : this.inside(path);
    if (located) {
      this.found.set(path, located);
    }
    return located;
  }

  private inside(path: string): string | undefined {
    try {
      this.root ??= realpathSync(this.cwd);
      const real = realpathSync(resolve(this.root, path));
      const rel = relative(this.root, real);
      return rel && !rel.startsWith("..") && !isAbsolute(rel) && isFile(real) ? resolve(this.cwd, path) : undefined;
    } catch {
      return undefined;
    }
  }
}
