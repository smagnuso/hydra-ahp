import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { shortPath } from "../src/bridge/mapping.js";
import { editContentUri } from "../src/bridge/edit-content.js";
import { loadConfig } from "../src/config.js";

const CHAT = "ahp-chat://default/abc";

describe("shortPath", () => {
  it("pins POSIX output", () => {
    expect(shortPath("/home/u/proj/src/a.ts")).toBe("…/proj/src/a.ts");
    expect(shortPath("/a/b/c")).toBe("/a/b/c");
    expect(shortPath("rel/dir/with/many/parts.ts")).toBe("rel/dir/with/many/parts.ts");
    expect(shortPath("src/a.ts")).toBe("src/a.ts");
  });

  it("shortens Windows paths", () => {
    expect(shortPath("C:\\Users\\x\\proj\\src\\a.ts")).toBe("…/proj/src/a.ts");
    expect(shortPath("C:/Users/x/proj/src/a.ts")).toBe("…/proj/src/a.ts");
    expect(shortPath("\\\\server\\share\\proj\\src\\a.ts")).toBe("…/proj/src/a.ts");
    expect(shortPath("C:\\a\\b")).toBe("C:\\a\\b");
  });
});

describe("editContentUri", () => {
  it("pins the POSIX label", () => {
    expect(editContentUri(CHAT, "tc1", 0, "old", "/r/a b.ts")).toBe(`${CHAT}/edit/tc1/0/old/r/a%20b.ts`);
  });

  it("splits Windows paths into segments instead of encoding separators", () => {
    const uri = editContentUri(CHAT, "tc1", 0, "new", "C:\\Users\\x\\proj\\a.ts");
    expect(uri).toBe(`${CHAT}/edit/tc1/0/new/C%3A/Users/x/proj/a.ts`);
    expect(uri).not.toContain("%5C");
  });
});

describe("home expansion", () => {
  const tls = (cert: string) => loadConfig({ HYDRA_ACP_TOKEN: "t", HYDRA_AHP_TLS_CERT: cert, HYDRA_AHP_TLS_KEY: "/k.pem" }).tls?.cert ?? "";

  it("expands ~, ~/ and ~\\", () => {
    expect(tls("~/c.pem").startsWith(homedir())).toBe(true);
    expect(tls("~\\c.pem").startsWith(homedir())).toBe(true);
    expect(tls("~\\c.pem")).not.toContain("~");
  });

  it("leaves other paths alone", () => {
    expect(tls("/abs/c.pem")).toBe("/abs/c.pem");
    expect(tls("~other/c.pem")).toBe("~other/c.pem");
  });
});
