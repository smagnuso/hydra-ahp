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
const SESSION_CHANGES = `${SESSION}/changeset/session`;

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

describe("changesets", () => {
  let harness: BridgeHarness | undefined;
  let dir: string | undefined;
  let otherDir: string | undefined;

  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
      } catch (err) {
        // A git run the poller started can still have the directory as its cwd, which Windows will not delete; leave it to the OS.
        if (process.platform !== "win32") {
          throw err;
        }
      }
      dir = undefined;
    }
    if (otherDir) {
      try {
        rmSync(otherDir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
      } catch (err) {
        if (process.platform !== "win32") {
          throw err;
        }
      }
      otherDir = undefined;
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
    expect(changesets).toEqual([
      expect.objectContaining({ uriTemplate: SESSION_CHANGES, changeKind: "session" }),
      expect.objectContaining({ uriTemplate: CHANGESET, changeKind: "uncommitted" }),
    ]);

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
    const encoded = encodeURIComponent(new URLSearchParams({ changeset: CHANGESET, rev: "HEAD", file: "kept.txt" }).toString());
    const reencoded = (await session.client.request("resourceRead", { channel: "ahp-root://", uri: `ahp-rev:/kept.txt?${encoded}` } as never)) as unknown as { data: string };
    expect(reencoded.data).toBe("one\ntwo\n");
    await expect(session.client.request("resourceRead", { channel: "ahp-root://", uri: `ahp-rev:/etc/passwd?${new URLSearchParams({ changeset: CHANGESET, rev: "HEAD", file: "../../etc/passwd" })}` } as never)).rejects.toBeDefined();

    execFileSync("git", ["checkout", "--", "kept.txt"], { cwd });
    await session.waitFor((envelope) => envelope.channel === CHANGESET && (envelope.action as { type: string }).type === "changeset/fileRemoved", 3000);
    expect(state().files.map((file) => file.id)).not.toContain(kept);
  });

  it("serves the previous session changes while refreshing a reattached changeset", async () => {
    dir = repo();
    const cwd = dir;
    const startedAt = new Date(Date.now() + 1_000).toISOString();
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd, createdAt: startedAt })];
      hydra.edited.set("h1", [join(cwd, "kept.txt")]);
    }, { changesetPollMs: 50 });

    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    await session.client.subscribe(SESSION_CHANGES);
    const state = (): ChangesetState | undefined => harness?.core.store.state(SESSION_CHANGES) as ChangesetState | undefined;
    for (let tries = 0; tries < 100 && state()?.status !== "ready"; tries += 1) {
      await sleep(20);
    }
    const kept = cwdToUri(join(cwd, "kept.txt"));
    expect(state()?.files.map((file) => file.id)).toEqual([kept]);

    await session.client.unsubscribe(SESSION_CHANGES);
    for (let tries = 0; tries < 100 && harness.core.store.has(SESSION_CHANGES); tries += 1) {
      await sleep(10);
    }
    expect(harness.core.store.has(SESSION_CHANGES)).toBe(false);

    const later = cwdToUri(join(cwd, "later.txt"));
    writeFileSync(join(cwd, "later.txt"), "a later agent edit\n");
    harness.hydra.edited.set("h1", [join(cwd, "kept.txt"), join(cwd, "later.txt")]);
    const resumed = await session.client.subscribe(SESSION_CHANGES);
    const resumedState = resumed.result.snapshot?.state as ChangesetState | undefined;
    expect(resumedState?.status).toBe("ready");
    expect(resumedState?.files.map((file) => file.id)).toContain(kept);

    for (let tries = 0; tries < 100 && !state()?.files.some((file) => file.id === later); tries += 1) {
      await sleep(20);
    }
    expect(state()?.files.map((file) => file.id).sort()).toEqual([kept, later].sort());
  });

  it("releases cached changesets when a session goes cold", async () => {
    dir = repo();
    const cwd = dir;
    const startedAt = new Date(Date.now() + 1_000).toISOString();
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd, createdAt: startedAt })];
      hydra.edited.set("h1", [join(cwd, "kept.txt")]);
    }, { changesetPollMs: 50 });

    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    await session.client.subscribe(SESSION_CHANGES);
    const state = (): ChangesetState | undefined => harness?.core.store.state(SESSION_CHANGES) as ChangesetState | undefined;
    for (let tries = 0; tries < 100 && state()?.status !== "ready"; tries += 1) {
      await sleep(20);
    }
    expect(state()?.status).toBe("ready");

    await session.client.unsubscribe(SESSION_CHANGES);
    for (let tries = 0; tries < 100 && harness.core.store.has(SESSION_CHANGES); tries += 1) {
      await sleep(10);
    }
    harness.hydra.rows = [ROW({ cwd, createdAt: startedAt, status: "cold" })];
    harness.hydra.edited.set("h1", [join(cwd, "later.txt")]);
    writeFileSync(join(cwd, "later.txt"), "a later edit\n");
    await sleep(120);

    const reopened = await session.client.subscribe(SESSION_CHANGES);
    const reopenedState = reopened.result.snapshot?.state as ChangesetState | undefined;
    expect(reopenedState?.status).toBe("ready");
    expect(reopenedState?.files.map((file) => file.id)).toEqual([cwdToUri(join(cwd, "later.txt"))]);
  });

  it("uses the recorded edits even after their files are committed", async () => {
    dir = repo();
    const cwd = dir;
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() + 3_600_000).toISOString() } });
    const startedAt = new Date(Date.now() + 1_000).toISOString();
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd, createdAt: startedAt })];
      hydra.edited.set("h1", [
        join(cwd, "kept.txt"),
        { path: join(cwd, "new.txt"), hunks: [{ oldText: "", newText: "new content\n" }], created: true },
        join(cwd, "gone.txt"),
      ]);
    }, { changesetPollMs: 50 });
    writeFileSync(join(cwd, "other.txt"), "not the agent's\n");
    git("add", "-A");
    git("commit", "-q", "-m", "later");

    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    await session.client.subscribe(SESSION_CHANGES);
    const state = (): ChangesetState => harness?.core.store.state(SESSION_CHANGES) as ChangesetState;
    for (let tries = 0; tries < 100 && state().status !== "ready"; tries += 1) {
      await sleep(20);
    }
    const ids = state().files.map((file) => file.id).sort();
    expect(ids).toEqual([cwdToUri(join(cwd, "gone.txt")), cwdToUri(join(cwd, "kept.txt")), cwdToUri(join(cwd, "new.txt"))].sort());
    const kept = state().files.find((file) => file.id === cwdToUri(join(cwd, "kept.txt")))?.edit;
    expect(kept?.diff).toEqual({ added: 1, removed: 1 });
    const before = (await session.client.request("resourceRead", { channel: "ahp-root://", uri: kept?.before?.content.uri } as never)) as unknown as { data: string };
    expect(before.data).toBe("// Recorded edit 1\nbefore\n");
    expect(state().files.find((file) => file.id === cwdToUri(join(cwd, "new.txt")))?.edit.before).toBeUndefined();

    const diffs = state().files.map((file) => (file.edit as { diff?: { added?: number; removed?: number } }).diff ?? {});
    const totals = {
      additions: diffs.reduce((sum, diff) => sum + (diff.added ?? 0), 0),
      deletions: diffs.reduce((sum, diff) => sum + (diff.removed ?? 0), 0),
      files: 3,
    };
    const listed = (await session.client.request("listSessions", {} as never)) as unknown as { items: { resource: string; changes?: unknown }[] };
    expect(listed.items.find((item) => item.resource === SESSION)?.changes).toEqual(totals);
  });

  it("includes recorded session edits from other directories as working directories", async () => {
    dir = repo();
    otherDir = repo();
    const cwd = dir;
    const startedAt = new Date(Date.now() + 1_000).toISOString();
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd, createdAt: startedAt })];
      hydra.edited.set("h1", [join(cwd, "kept.txt"), join(otherDir as string, "kept.txt")]);
    }, { changesetPollMs: 50 });

    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    await session.client.subscribe(SESSION_CHANGES);
    const state = (): ChangesetState => harness?.core.store.state(SESSION_CHANGES) as ChangesetState;
    for (let tries = 0; tries < 100 && state().status !== "ready"; tries += 1) {
      await sleep(20);
    }
    const otherFile = cwdToUri(join(otherDir, "kept.txt"));
    expect(state().files.map((file) => file.id)).toContain(otherFile);
    const otherEdit = state().files.find((file) => file.id === otherFile)?.edit;
    const before = (await session.client.request("resourceRead", { channel: "ahp-root://", uri: otherEdit?.before?.content.uri } as never)) as unknown as { data: string };
    expect(before.data).toBe("// Recorded edit 1\nbefore\n");
    expect(otherEdit?.diff).toEqual({ added: 1, removed: 1 });
    const sessionState = (): SessionState => harness?.core.store.state(SESSION) as SessionState;
    for (let tries = 0; tries < 100 && !sessionState().workingDirectories?.includes(cwdToUri(otherDir)); tries += 1) {
      await sleep(20);
    }
    expect(sessionState().workingDirectories).toContain(cwdToUri(otherDir));
  });

  it("serves recorded session hunks outside a Git repository", async () => {
    dir = mkdtempSync(join(tmpdir(), "ahp-no-git-"));
    const path = join(dir, "file.txt");
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd: dir })];
      hydra.edited.set("h1", [{
        path,
        hunks: [
          { oldText: "/core", newText: "/ore" },
          { oldText: "/ore", newText: "/core" },
        ],
      }]);
    }, { changesetPollMs: 50 });

    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    await session.client.subscribe(SESSION_CHANGES);
    const state = (): ChangesetState => harness?.core.store.state(SESSION_CHANGES) as ChangesetState;
    for (let tries = 0; tries < 100 && state().status !== "ready"; tries += 1) {
      await sleep(20);
    }
    const fileUri = cwdToUri(path);
    expect(state().files.map((file) => file.id)).toEqual([fileUri]);
    const file = state().files[0];
    expect(file?.edit.diff).toEqual({ added: 2, removed: 2 });
    const before = await session.client.request("resourceRead", { channel: "ahp-root://", uri: file?.edit.before?.content.uri } as never) as unknown as { data: string };
    const after = await session.client.request("resourceRead", { channel: "ahp-root://", uri: file?.edit.after?.content.uri } as never) as unknown as { data: string };
    expect(before.data).toBe("// Recorded edit 1\n/core\n// Recorded edit 2\n/ore");
    expect(after.data).toBe("// Recorded edit 1\n/ore\n// Recorded edit 2\n/core");
    const listed = (await session.client.request("listSessions", {} as never)) as unknown as { items: { resource: string; changes?: unknown }[] };
    expect(listed.items.find((item) => item.resource === SESSION)?.changes).toEqual({ additions: 2, deletions: 2, files: 1 });
  });
});
