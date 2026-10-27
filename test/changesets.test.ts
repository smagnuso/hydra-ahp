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
import { chatOf } from "./support/chat-uri.js";

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
      expect.objectContaining({ uriTemplate: `${SESSION}/changeset/turn/{turnId}`, changeKind: "turn" }),
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
    expect(reopenedState?.status).toBe("computing");
    for (let tries = 0; tries < 100 && state()?.status !== "ready"; tries += 1) {
      await sleep(20);
    }
    expect(state()?.status).toBe("ready");
    expect(state()?.files.map((file) => file.id)).toEqual([cwdToUri(join(cwd, "later.txt"))]);
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
    expect(before.data).toBe("before\n");
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
    expect(before.data).toBe("before\n");
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
    writeFileSync(path, "new line\n");
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd: dir })];
      hydra.edited.set("h1", [{
        path,
        hunks: [
          { oldText: "/core", newText: "/ore" },
          { oldText: "/xyz", newText: "/core" },
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
    expect(file?.edit.before).toBeUndefined();
    const after = await session.client.request("resourceRead", { channel: "ahp-root://", uri: file?.edit.after?.content.uri } as never) as unknown as { data: string };
    expect(after.data).toBe("new line\n");
    const listed = (await session.client.request("listSessions", {} as never)) as unknown as { items: { resource: string; changes?: unknown }[] };
    expect(listed.items.find((item) => item.resource === SESSION)?.changes).toEqual({ additions: 2, deletions: 2, files: 1 });
  });

  it("collapses a chain of whole-file snapshots into one before and after with real line counts", async () => {
    dir = mkdtempSync(join(tmpdir(), "ahp-no-git-"));
    const path = join(dir, "file.txt");
    const v0 = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const v1 = v0 + "extra\n";
    const v2 = v1.replace("line 5\n", "line five\n");
    writeFileSync(path, v2);
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd: dir })];
      hydra.edited.set("h1", [{
        path,
        hunks: [
          { oldText: v0, newText: v1 },
          { oldText: v1, newText: v2 },
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
    const file = state().files[0];
    expect(file?.edit.diff).toEqual({ added: 2, removed: 1 });
    const before = await session.client.request("resourceRead", { channel: "ahp-root://", uri: file?.edit.before?.content.uri } as never) as unknown as { data: string };
    expect(before.data).toBe(v0);
    expect(file?.edit.before?.content.uri).toContain(`${path}?`);
    const encoded = (file?.edit.before?.content.uri ?? "").replace("?key=", "?key%3D");
    const viaEncoded = await session.client.request("resourceRead", { channel: "ahp-root://", uri: encoded } as never) as unknown as { data: string };
    expect(viaEncoded.data).toBe(v0);
  });

  it("keeps the before side of one large whole-file hunk and counts only what changed", async () => {
    dir = mkdtempSync(join(tmpdir(), "ahp-no-git-"));
    const path = join(dir, "file.txt");
    const v0 = Array.from({ length: 700 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const v1 = v0.replace("line 3\n", "line three\nline 3b\n");
    writeFileSync(path, v1);
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd: dir })];
      hydra.edited.set("h1", [{ path, hunks: [{ oldText: v0, newText: v1, scope: "file" }] }]);
    }, { changesetPollMs: 50 });

    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    await session.client.subscribe(SESSION_CHANGES);
    const state = (): ChangesetState => harness?.core.store.state(SESSION_CHANGES) as ChangesetState;
    for (let tries = 0; tries < 100 && state().status !== "ready"; tries += 1) {
      await sleep(20);
    }
    const file = state().files[0];
    expect(file?.edit.diff).toEqual({ added: 2, removed: 1 });
    expect(file?.edit.before).toBeDefined();
  });

  it("serves a large whole-file edit with only the changed lines counted", async () => {
    dir = mkdtempSync(join(tmpdir(), "ahp-no-git-"));
    const path = join(dir, "file.txt");
    const pad = "x".repeat(90);
    const v0 = Array.from({ length: 3500 }, (_, i) => `line ${i} ${pad}`).join("\n") + "\n";
    const v1 = v0.replace("line 100 ", "line one hundred ").replace("line 3400 ", "line three thousand ");
    writeFileSync(path, v1);
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd: dir })];
      hydra.edited.set("h1", [{ path, hunks: [{ oldText: v0, newText: v1, scope: "file" }] }]);
    }, { changesetPollMs: 50 });

    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    await session.client.subscribe(SESSION_CHANGES);
    const state = (): ChangesetState => harness?.core.store.state(SESSION_CHANGES) as ChangesetState;
    for (let tries = 0; tries < 100 && state().status !== "ready"; tries += 1) {
      await sleep(20);
    }
    const file = state().files[0];
    expect(file?.edit.diff).toEqual({ added: 2, removed: 2 });
    expect(file?.edit.before).toBeDefined();
  });

  it("shows what the session wrote when its edits are no longer on disk", async () => {
    dir = mkdtempSync(join(tmpdir(), "ahp-no-git-"));
    const path = join(dir, "file.txt");
    const v0 = "one\ntwo\n";
    const v1 = "one\ntwo\nthree\n";
    writeFileSync(path, v0);
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd: dir })];
      hydra.edited.set("h1", [{ path, hunks: [{ oldText: v0, newText: v1, scope: "file" }] }]);
    }, { changesetPollMs: 50 });

    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    await session.client.subscribe(SESSION_CHANGES);
    const state = (): ChangesetState => harness?.core.store.state(SESSION_CHANGES) as ChangesetState;
    for (let tries = 0; tries < 100 && state().status !== "ready"; tries += 1) {
      await sleep(20);
    }
    const file = state().files[0];
    expect(file?.edit.diff).toEqual({ added: 1, removed: 0 });
    expect(file?.edit.after?.content.uri).not.toBe(cwdToUri(path));
    const after = await session.client.request("resourceRead", { channel: "ahp-root://", uri: file?.edit.after?.content.uri } as never) as unknown as { data: string };
    expect(after.data).toBe(v1);
  });

  it("does not collapse snippet hunks even when they chain", async () => {
    dir = mkdtempSync(join(tmpdir(), "ahp-no-git-"));
    const path = join(dir, "file.txt");
    writeFileSync(path, "c\n");
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd: dir })];
      hydra.edited.set("h1", [{
        path,
        hunks: [
          { oldText: "a", newText: "b", scope: "snippet" },
          { oldText: "b", newText: "c", scope: "snippet" },
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
    expect(state().files[0]?.edit.before).toBeUndefined();
  });

  it("collapses whole-file hunks that do not chain", async () => {
    dir = mkdtempSync(join(tmpdir(), "ahp-no-git-"));
    const path = join(dir, "file.txt");
    writeFileSync(path, "x\ny\nz\n");
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd: dir })];
      hydra.edited.set("h1", [{
        path,
        hunks: [
          { oldText: "x\n", newText: "x\ny\n", scope: "file" },
          { oldText: "unrelated\n", newText: "x\ny\nz\n", scope: "file" },
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
    const file = state().files[0];
    expect(file?.edit.diff).toEqual({ added: 2, removed: 0 });
    const before = await session.client.request("resourceRead", { channel: "ahp-root://", uri: file?.edit.before?.content.uri } as never) as unknown as { data: string };
    expect(before.data).toBe("x\n");
  });

  it("does not ask VS Code to diff synthetic content for oversized recorded hunks", async () => {
    dir = mkdtempSync(join(tmpdir(), "ahp-no-git-"));
    const path = join(dir, "missing.txt");
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd: dir })];
      hydra.edited.set("h1", [{
        path,
        hunks: [{ oldText: "old\n".repeat(2500), newText: "new\n".repeat(2500) }],
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

    const edit = state().files[0]?.edit;
    expect(edit).toMatchObject({ diff: { added: 2500, removed: 2500 } });
    expect(edit?.before).toBeUndefined();
    expect(edit?.after.content.uri).not.toBe(`file://${path}`);
    expect(edit?.before).toBeUndefined();
  });
  describe("per-turn changes", () => {
    const turn = (id: string) => `${SESSION}/changeset/turn/${id}`;
    let seq = 100;
    const frame = (update: Record<string, unknown>) => ({ update, recordedAt: (seq += 10), seq });

    async function openChat() {
      dir = mkdtempSync(join(tmpdir(), "ahp-turns-"));
      const cwd = dir;
      harness = await startBridgeHarness((hydra) => {
        hydra.rows = [ROW({ cwd })];
      }, { changesetPollMs: 50 });
      const session = await harness.connect();
      await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
      await session.client.subscribe(chatOf("h1"));
      return session;
    }

    function edit(toolCallId: string, path: string, oldText: string | null, newText: string): Record<string, unknown> {
      return { sessionUpdate: "tool_call", toolCallId, status: "completed", content: [{ type: "diff", path, oldText, newText }] };
    }

    async function ready(uri: string): Promise<ChangesetState> {
      const state = (): ChangesetState => harness?.core.store.state(uri) as ChangesetState;
      for (let tries = 0; tries < 150 && state().status !== "ready"; tries += 1) {
        await sleep(20);
      }
      return state();
    }

    it("lists the files one turn edited, and nothing from other turns", async () => {
      const session = await openChat();
      const send = (update: Record<string, unknown>) => harness?.hydra.listener?.update(frame(update));
      send({ sessionUpdate: "prompt_received", messageId: "t1", prompt: [{ type: "text", text: "first" }] });
      send(edit("c1", "/r/a.ts", "one\n", "one\ntwo\n"));
      send({ sessionUpdate: "turn_complete", stopReason: "end_turn" });
      send({ sessionUpdate: "prompt_received", messageId: "t2", prompt: [{ type: "text", text: "second" }] });
      send(edit("c2", "/r/b.ts", null, "new\n"));
      send({ sessionUpdate: "turn_complete", stopReason: "end_turn" });

      await session.client.subscribe(turn("t1"));
      const first = await ready(turn("t1"));
      expect(first.status).toBe("ready");
      expect(first.files.map((file) => file.id)).toEqual([cwdToUri("/r/a.ts")]);
      expect(first.files[0]?.edit).toMatchObject({ before: { uri: cwdToUri("/r/a.ts") }, after: { uri: cwdToUri("/r/a.ts") } });

      await session.client.subscribe(turn("t2"));
      const second = await ready(turn("t2"));
      expect(second.files.map((file) => file.id)).toEqual([cwdToUri("/r/b.ts")]);
      expect(second.files[0]?.edit.before).toBeUndefined();
      expect(second.files[0]?.edit.diff).toMatchObject({ added: 1 });
    });

    it("shows a file edited twice in a turn from its first before to its last after", async () => {
      const session = await openChat();
      const send = (update: Record<string, unknown>) => harness?.hydra.listener?.update(frame(update));
      send({ sessionUpdate: "prompt_received", messageId: "t1", prompt: [{ type: "text", text: "go" }] });
      send({ ...edit("c1", "/r/a.ts", "a\n", "a\nb\n"), _meta: { "hydra-acp": { editStats: [{ path: "/r/a.ts", added: 1, removed: 0 }] } } });
      send({ ...edit("c2", "/r/a.ts", "a\nb\n", "a\nb\nc\n"), _meta: { "hydra-acp": { editStats: [{ path: "/r/a.ts", added: 1, removed: 0 }] } } });
      send({ sessionUpdate: "turn_complete", stopReason: "end_turn" });
      await session.client.subscribe(turn("t1"));
      const state = await ready(turn("t1"));
      expect(state.files).toHaveLength(1);
      expect(state.files[0]?.edit.diff).toEqual({ added: 2, removed: 0 });
      const read = async (uri: string | undefined) =>
        ((await session.client.request("resourceRead", { channel: "ahp-root://", uri } as never)) as unknown as { data: string }).data;
      expect(await read(state.files[0]?.edit.before?.content.uri)).toBe("a\n");
      expect(await read(state.files[0]?.edit.after?.content.uri)).toBe("a\nb\nc\n");
    });

    it("reports a turn no chat holds as an error", async () => {
      const session = await openChat();
      await session.client.subscribe(turn("nope"));
      for (let tries = 0; tries < 100 && (harness?.core.store.state(turn("nope")) as ChangesetState).status === "computing"; tries += 1) {
        await sleep(20);
      }
      expect((harness?.core.store.state(turn("nope")) as ChangesetState).status).toBe("error");
    });
  });
});
