import { describe, expect, it } from "vitest";
import { pathMatcher } from "../src/files/glob.js";

describe("pathMatcher", () => {
  it("matches globs at any depth and excludes whole trees", () => {
    const match = pathMatcher(["**/node_modules/**", "**/*.log", "dist"]);
    expect(match("node_modules")).toBe(true);
    expect(match("a/b/node_modules/pkg/index.js")).toBe(true);
    expect(match("src/app.log")).toBe(true);
    expect(match("dist/out.js")).toBe(true);
    expect(match("src/app.ts")).toBe(false);
    expect(match("distant/file.txt")).toBe(false);
  });

  it("supports single-segment stars, question marks and alternatives", () => {
    const match = pathMatcher(["src/*.ts", "t?st.js", "**/*.{png,jpg}"]);
    expect(match("src/a.ts")).toBe(true);
    expect(match("src/deep/a.ts")).toBe(false);
    expect(match("test.js")).toBe(true);
    expect(match("tst.js")).toBe(false);
    expect(match("img/pic.png")).toBe(true);
    expect(match("img/pic.gif")).toBe(false);
  });

  it("matches nothing when there are no patterns", () => {
    expect(pathMatcher([])("anything")).toBe(false);
    expect(pathMatcher([" "])("anything")).toBe(false);
  });
});
