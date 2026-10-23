// Turns a glob (`**`, `*`, `?`, `{a,b}`) or a plain relative path into a matcher over "/"-separated relative paths.
function globSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === "*" && pattern.charAt(i + 1) === "*") {
      const slash = pattern.charAt(i + 2) === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end < 0) {
        out += "\\{";
      } else {
        out += `(?:${pattern
          .slice(i + 1, end)
          .split(",")
          .map(globSource)
          .join("|")})`;
        i = end;
      }
    } else {
      out += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

export function compileGlob(pattern: string): RegExp {
  const trimmed = pattern.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  // "dir/**" covers the directory itself as well as what is in it.
  const tree = trimmed.endsWith("/**");
  const body = tree ? trimmed.slice(0, -3) : trimmed;
  return new RegExp(`^${globSource(body)}${tree ? "(?:/.*)?" : ""}$`);
}

// A path matches a pattern when the path itself or any directory above it does, so excluding a directory excludes its tree.
export function pathMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
  const compiled = patterns.filter((pattern) => pattern.trim() !== "").map(compileGlob);
  return (relativePath) => {
    if (compiled.length === 0) {
      return false;
    }
    const parts = relativePath.split("/").filter(Boolean);
    for (let end = parts.length; end > 0; end -= 1) {
      const prefix = parts.slice(0, end).join("/");
      if (compiled.some((regex) => regex.test(prefix))) {
        return true;
      }
    }
    return false;
  };
}
