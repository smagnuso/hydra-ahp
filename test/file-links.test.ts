import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileLinks, parseMention, parseRelativeTarget } from "../src/bridge/file-links.js";
import { LinkStream, rewriteLinks } from "../src/bridge/session-links.js";

let root: string;
let cwd: string;
let outside: string;
const url = (path: string): string => pathToFileURL(path).href;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ahp-file-links-"));
  cwd = join(root, "project");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "a.ts"), "");
  writeFileSync(join(cwd, "README.md"), "");
  outside = join(root, "notes.md");
  writeFileSync(outside, "");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("file references", () => {
  it("reads a mention's path and line the way the browser does", () => {
    expect(parseMention("src/a.ts:12:4")).toEqual({ path: "src/a.ts", line: 12 });
    expect(parseMention("src/a.ts#L3-L9")).toEqual({ path: "src/a.ts", line: 3, lineEnd: 9 });
    expect(parseMention("README.md")).toEqual({ path: "README.md" });
    expect(parseMention("1.2.3")).toBeUndefined();
    expect(parseMention("src/a.ts#section")).toBeUndefined();
  });

  it("takes only relative link targets", () => {
    expect(parseRelativeTarget("./src/a.ts#L3")).toEqual({ path: "src/a.ts", line: 3 });
    expect(parseRelativeTarget("docs#L2")).toEqual({ path: "docs", line: 2 });
    expect(parseRelativeTarget("somewhere")).toBeUndefined();
    expect(parseRelativeTarget("/abs/a.ts")).toBeUndefined();
    expect(parseRelativeTarget("https://x.dev/a.ts")).toBeUndefined();
    expect(parseRelativeTarget("#heading")).toBeUndefined();
  });

  it("links a relative target without looking for the file", () => {
    const files = new FileLinks(cwd);
    expect(files.target("src/missing.ts#L3-L4")).toBe(`${url(join(cwd, "src", "missing.ts"))}#L3-L4`);
    expect(files.target("https://x.dev/a.ts")).toBeUndefined();
  });

  it("links a named file only when it exists inside the cwd", () => {
    const files = new FileLinks(cwd);
    expect(files.mention("src/a.ts:12")).toBe(`${url(join(cwd, "src", "a.ts"))}#L12`);
    expect(files.mention("README.md")).toBe(url(join(cwd, "README.md")));
    expect(files.mention("src/b.ts")).toBeUndefined();
    expect(files.mention("src")).toBeUndefined();
    expect(files.mention("../notes.md")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("links an absolute path that exists anywhere", () => {
    const files = new FileLinks(cwd);
    expect(files.mention(outside)).toBe(url(outside));
    expect(files.mention(join(root, "gone.md"))).toBeUndefined();
  });

  it("links a file named before it existed once it does", () => {
    const files = new FileLinks(cwd);
    expect(files.mention("src/later.ts")).toBeUndefined();
    writeFileSync(join(cwd, "src", "later.ts"), "");
    expect(files.mention("src/later.ts")).toBe(url(join(cwd, "src", "later.ts")));
  });
});

describe("file links in text", () => {
  const linkers = (): { files: FileLinks } => ({ files: new FileLinks(cwd) });
  const a = (): string => url(join(cwd, "src", "a.ts"));

  it("links files named in prose, in backticks and as relative link targets", () => {
    expect(rewriteLinks("see src/a.ts:12.", linkers())).toBe(`see [src/a.ts:12](${a()}#L12).`);
    expect(rewriteLinks("see `src/a.ts`, then", linkers())).toBe(`see [\`src/a.ts\`](${a()}), then`);
    expect(rewriteLinks("[a.ts](src/a.ts#L3)", linkers())).toBe(`[a.ts](${a()}#L3)`);
  });

  it("leaves files in code, link text, URLs and home paths as written", () => {
    const untouched = [
      "```\nsrc/a.ts\n```",
      "`cat src/a.ts`",
      "[see src/a.ts](https://x.dev)",
      "https://x.dev/src/a.ts",
      "~/src/a.ts",
      "src/b.ts",
    ];
    for (const text of untouched) {
      expect(rewriteLinks(text, linkers())).toBe(text);
    }
  });

  it("links files however the stream splits them", () => {
    const text = "Edit src/a.ts:12 and `README.md`, per [the doc](src/a.ts#L3).\n```\nsrc/a.ts\n```\ndone in src/a.ts";
    const expected = rewriteLinks(text, linkers());
    expect(expected).toBe(
      `Edit [src/a.ts:12](${a()}#L12) and [\`README.md\`](${url(join(cwd, "README.md"))}), per [the doc](${a()}#L3).\n\`\`\`\nsrc/a.ts\n\`\`\`\ndone in [src/a.ts](${a()})`,
    );
    for (let size = 1; size <= text.length; size += 1) {
      const stream = new LinkStream(linkers());
      let out = "";
      for (let at = 0; at < text.length; at += size) {
        out += stream.push(text.slice(at, at + size));
      }
      out += stream.flush();
      expect(out, `chunks of ${size}`).toBe(expected);
    }
  });
});
