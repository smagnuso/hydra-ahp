import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { mergeConf, readConf, withConf, writeConf } from "../src/setup/conf.js";

function confFile(text?: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "ahp-conf-")), "ahp.conf");
  if (text !== undefined) {
    writeFileSync(path, text);
  }
  return path;
}

describe("mergeConf", () => {
  it("updates keys in place, appends new ones and leaves the rest alone", () => {
    const merged = mergeConf("# note\nHYDRA_AHP_PORT=1\nHYDRA_AHP_HOST=0.0.0.0\n", {
      HYDRA_AHP_PORT: "2",
      HYDRA_AHP_HOST: undefined,
      HYDRA_AHP_PREFERRED_HOST: "box.ts.net",
    });
    expect(merged).toBe("# note\nHYDRA_AHP_PORT=2\nHYDRA_AHP_HOST=0.0.0.0\n\nHYDRA_AHP_PREFERRED_HOST=box.ts.net\n");
  });

  it("quotes values with spaces", () => {
    expect(mergeConf("", { HYDRA_AHP_DIR_ROOTS: "/a b" })).toContain('HYDRA_AHP_DIR_ROOTS="/a b"');
  });
});

describe("conf file", () => {
  it("is written 0600 and read back", () => {
    const path = confFile();
    writeConf(path, { HYDRA_AHP_HOST: "100.64.0.1" });
    expect(readConf(path).get("HYDRA_AHP_HOST")).toBe("100.64.0.1");
    expect(readFileSync(path, "utf8")).toContain("hydra-ahp config");
  });

  it("feeds loadConfig under the process env, HYDRA_AHP_* keys only", () => {
    const path = confFile("HYDRA_AHP_HOST=100.64.0.1\nHYDRA_AHP_PORT=7000\nHYDRA_ACP_TOKEN=stolen\nHYDRA_AHP_TLS_CERT=/c\nHYDRA_AHP_TLS_KEY=/k\n");
    const config = loadConfig(withConf({ HYDRA_ACP_TOKEN: "real", HYDRA_AHP_PORT: "7001" }, path));
    expect(config.token).toBe("real");
    expect(config.host).toBe("100.64.0.1");
    expect(config.hostExplicit).toBe(true);
    expect(config.port).toBe(7001);
    expect(config.tls).toEqual({ cert: "/c", key: "/k" });
  });

  it("is optional", () => {
    expect(withConf({ A: "1" }, join(tmpdir(), "no-such-ahp.conf"))).toEqual({ A: "1" });
  });
});
