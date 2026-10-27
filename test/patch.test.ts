import { describe, expect, it } from "vitest";
import { patchedFiles } from "../src/bridge/patch.js";

const update = (files: unknown[]) => ({ rawOutput: { metadata: { files } } });

describe("patchedFiles", () => {
  it("reads opencode's filePath entries", () => {
    expect(patchedFiles(update([{ filePath: "/r/a.ts", type: "add", patch: "@@ -0,0 +1 @@\n+x\n" }]))).toEqual([
      { path: "/r/a.ts", created: true, oldText: "", newText: "x\n" },
    ]);
  });

  it("reads the later shape's absolute file and status, and skips a relative one", () => {
    const files = patchedFiles(
      update([
        { file: "/r/a.ts", status: "added", patch: "@@ -0,0 +1 @@\n+x\n" },
        { file: "src/b.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b\n" },
      ]),
    );
    expect(files.map((file) => [file.path, file.created])).toEqual([["/r/a.ts", true]]);
  });
});
