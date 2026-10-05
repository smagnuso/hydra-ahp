import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangesetState, SessionState } from "@microsoft/agent-host-protocol";
import { workingChanges } from "../src/changesets/git.js";
import { cwdToUri } from "../src/bridge/ids.js";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";
import { sleep } from "./support/harness.js";

const SESSION = "fake:/h1";
const CHANGESET = `${SESSION}/changeset/uncommitted`;

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ahp-changes-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "kept.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "gone.txt"), "bye\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  writeFileSync(join(dir, "kept.txt"), "one\ntwo\nthree\n");
  unlinkSync(join(dir, "gone.txt"));
  writeFileSync(join(dir, "new.txt"), "a\nb\n");
  return dir;
}

describe("uncommitted changes", () => {
  let harness: BridgeHarness | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("reads what differs from HEAD, with line counts", async () => {
    dir = repo();
    const changes = await workingChanges(dir);
    const byPath = Object.fromEntries((changes?.files ?? []).map((file) => [file.path, file]));
    expect(byPath["kept.txt"]).toMatchObject({ inHead: true, onDisk: true, added: 1, removed: 0 });
    expect(byPath["gone.txt"]).toMatchObject({ inHead: true, onDisk: false, added: 0, removed: 1 });
    expect(byPath["new.txt"]).toMatchObject({ inHead: false, onDisk: true, added: 2 });
    expect(await workingChanges(tmpdir())).toBeUndefined();
  });

  it("serves a local session's uncommitted changes as a changeset that follows the working tree", async () => {
    dir = repo();
    const cwd = dir;
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd })];
    }, { changesetPollMs: 50 });
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });

    const sub = await session.client.subscribe(SESSION);
    const changesets = (sub.result.snapshot?.state as SessionState).changesets;
    expect(changesets).toEqual([expect.objectContaining({ uriTemplate: CHANGESET, changeKind: "uncommitted" })]);

    await session.client.subscribe(CHANGESET);
    const state = (): ChangesetState => harness?.core.store.state(CHANGESET) as ChangesetState;
    for (let tries = 0; tries < 100 && state().status !== "ready"; tries += 1) {
      await sleep(20);
    }
    const kept = cwdToUri(join(cwd, "kept.txt"));
    expect(state().files.map((file) => file.id).sort()).toEqual([cwdToUri(join(cwd, "gone.txt")), kept, cwdToUri(join(cwd, "new.txt"))].sort());
    const edit = state().files.find((file) => file.id === kept)?.edit;
    expect(edit).toMatchObject({ before: { uri: kept }, after: { uri: kept, content: { uri: kept } }, diff: { added: 1, removed: 0 } });

    const before = (await session.client.request("resourceRead", { channel: "ahp-root://", uri: edit?.before?.content.uri } as never)) as unknown as { data: string };
    expect(before.data).toBe("one\ntwo\n");
    await expect(session.client.request("resourceRead", { channel: "ahp-root://", uri: `${CHANGESET}/head/..%2F..%2Fetc%2Fpasswd` } as never)).rejects.toBeDefined();

    execFileSync("git", ["checkout", "--", "kept.txt"], { cwd });
    await session.waitFor((envelope) => envelope.channel === CHANGESET && (envelope.action as { type: string }).type === "changeset/fileRemoved", 3000);
    expect(state().files.map((file) => file.id)).not.toContain(kept);
  });
});
