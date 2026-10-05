import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FakeBackend } from "../src/protocol/fake-backend.js";
import type { ClientContext } from "../src/protocol/backend.js";
import { ProtocolCore } from "../src/protocol/core.js";
import { AhpListener } from "../src/server/listener.js";
import { TokenRegistry, type FileLevel } from "../src/store/tokens.js";
import { FileService, type FileSession } from "../src/files/service.js";
import { EditedPaths, extractEditedPaths, extractResourceLinkImagePaths } from "../src/files/scope.js";
import { openSession, type Session } from "./support/harness.js";

const DENIED = -32009;
const NOT_FOUND = -32008;
const EXISTS = -32010;
const CONFLICT = -32011;
const INVALID = -32602;
const METHOD_NOT_FOUND = -32601;

class FileBackend extends FakeBackend {
  constructor(private readonly files: FileService) {
    super();
  }

  override handleCommand(method: string, params: unknown, client: ClientContext): unknown {
    if (this.files.handles(method)) {
      return this.files.handle(method, params, client);
    }
    return super.handleCommand(method, params);
  }
}

const u = (path: string): string => pathToFileURL(path).href;

async function code(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: number }).code;
  }
}

async function failure(promise: Promise<unknown>): Promise<{ code?: number; message: string }> {
  try {
    await promise;
  } catch (err) {
    return { code: (err as { code?: number }).code, message: (err as Error).message };
  }
  throw new Error("expected the call to fail");
}

describe("file access", () => {
  let dir: string;
  let proj: string;
  let secret: string;
  let outside: string;
  let remoteCwd: string;
  let picker: string;
  let listener: AhpListener;
  let port: number;
  let tokens: TokenRegistry;
  const sessions: Session[] = [];
  const edited = new EditedPaths();

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "ahp-files-")));
    proj = join(dir, "proj");
    secret = join(dir, "secret");
    outside = join(dir, "outside");
    remoteCwd = join(dir, "remote-cwd");
    picker = join(dir, "picker");
    for (const path of [join(proj, "src"), secret, outside, remoteCwd, join(picker, "sub"), join(picker, "other")]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(join(proj, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(proj, "readme.md"), "# hi\n");
    writeFileSync(join(proj, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    writeFileSync(join(proj, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
    writeFileSync(join(proj, "big.txt"), `${"line of text\n".repeat(250_000)}`);
    writeFileSync(join(secret, "key.txt"), "TOP SECRET");
    writeFileSync(join(outside, "edited.txt"), "edited elsewhere");
    writeFileSync(join(outside, "other.txt"), "not edited");
    writeFileSync(join(remoteCwd, "r.txt"), "remote file");
    writeFileSync(join(picker, "note.txt"), "picker file");
    symlinkSync(secret, join(proj, "link-out"));
    symlinkSync(join(secret, "key.txt"), join(proj, "link-file"));

    const list: FileSession[] = [
      { id: "s1", cwd: proj },
      { id: "peer:x", cwd: remoteCwd, remote: "peer" },
    ];
    edited.record("s1", join(outside, "edited.txt"));
    const service = new FileService({
      sessions: {
        fileSessions: () => list,
        sessionForChat: (chat) => list.find((session) => `ahp-chat:/${session.id}` === chat),
      },
      edited,
      dirRoots: [picker],
    });
    tokens = new TokenRegistry({ path: join(dir, "tokens.json") });
    const core = new ProtocolCore({ backend: new FileBackend(service) });
    await core.start();
    listener = new AhpListener({ core, tokens });
    port = await listener.listen();
  });

  afterAll(async () => {
    for (const session of sessions) {
      await session.shutdown();
    }
    await listener.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect(level: FileLevel): Promise<Session["client"]> {
    const { token } = tokens.mint(`t-${level}`, level);
    const session = await openSession(`ws://127.0.0.1:${port}/?tkn=${token}`);
    sessions.push(session);
    await session.client.initialize({ clientId: `c-${level}`, protocolVersions: ["0.9.0"] });
    return session.client;
  }

  describe("scoped", () => {
    let client: Session["client"];

    beforeAll(async () => {
      client = await connect("scoped");
    });

    it("lists, resolves and reads inside a session cwd", async () => {
      const listing = await client.resourceList({ uri: u(proj) });
      expect(listing.entries).toContainEqual({ name: "src", type: "directory" });
      expect(listing.entries).toContainEqual({ name: "readme.md", type: "file" });
      const read = await client.resourceRead({ uri: u(join(proj, "src", "a.ts")) });
      expect(read).toMatchObject({ data: "export const a = 1;\n", encoding: "utf-8" });
      const resolved = await client.resourceResolve({ uri: u(join(proj, "src", "a.ts")) });
      expect(resolved).toMatchObject({ type: "file", size: 20, uri: u(join(proj, "src", "a.ts")) });
      expect(resolved.etag).toBeTruthy();
    });

    it("answers NotFound for a missing path inside scope", async () => {
      expect(await code(client.resourceRead({ uri: u(join(proj, "nope.txt")) }))).toBe(NOT_FOUND);
    });

    it("refuses .. traversal, plain and percent-encoded", async () => {
      const dotted = `${u(proj)}/../secret/key.txt`;
      const encoded = `${u(proj)}/%2e%2e/secret/key.txt`;
      const doubled = `${u(proj)}/src/%2e%2e/%2e%2e/secret/key.txt`;
      for (const uri of [dotted, encoded, doubled]) {
        expect(await code(client.resourceRead({ uri }))).toBe(DENIED);
        expect(await code(client.resourceResolve({ uri }))).toBe(DENIED);
      }
      expect(await code(client.resourceList({ uri: `${u(proj)}/../secret` }))).toBe(DENIED);
    });

    it("refuses an encoded slash instead of treating it as a separator", async () => {
      const uri = `${u(proj)}%2f..%2fsecret%2fkey.txt`;
      expect(await code(client.resourceRead({ uri }))).toBeDefined();
    });

    it("refuses symlinks that point out of the cwd", async () => {
      expect(await code(client.resourceRead({ uri: u(join(proj, "link-out", "key.txt")) }))).toBe(DENIED);
      expect(await code(client.resourceRead({ uri: u(join(proj, "link-file")) }))).toBe(DENIED);
      expect(await code(client.resourceList({ uri: u(join(proj, "link-out")) }))).toBe(DENIED);
      expect(await code(client.resourceResolve({ uri: u(join(proj, "link-file")) }))).toBe(DENIED);
    });

    it("allows stat of the link itself without following it", async () => {
      const resolved = await client.resourceResolve({ uri: u(join(proj, "link-file")), followSymlinks: false });
      expect(resolved.type).toBe("symlink");
    });

    it("refuses a file outside every scope", async () => {
      expect(await code(client.resourceRead({ uri: u(join(secret, "key.txt")) }))).toBe(DENIED);
      expect(await code(client.resourceList({ uri: u(secret) }))).toBe(DENIED);
      expect(await code(client.resourceRead({ uri: u(join(outside, "other.txt")) }))).toBe(DENIED);
      expect(await code(client.resourceRead({ uri: "file:///etc/passwd" }))).toBe(DENIED);
    });

    it("does not reveal whether an out-of-scope path exists", async () => {
      expect(await code(client.resourceRead({ uri: u(join(secret, "missing.txt")) }))).toBe(DENIED);
    });

    it("serves an edited file outside the cwd but not its neighbours", async () => {
      const read = await client.resourceRead({ uri: u(join(outside, "edited.txt")) });
      expect(read.data).toBe("edited elsewhere");
      expect(await code(client.resourceRead({ uri: u(join(outside, "other.txt")) }))).toBe(DENIED);
      expect(await code(client.resourceList({ uri: u(outside) }))).toBe(DENIED);
      expect(await code(client.resourceRead({ uri: `${u(join(outside, "edited.txt"))}/../other.txt` }))).toBe(DENIED);
    });

    it("refuses non-file and relative URIs", async () => {
      expect(await code(client.resourceRead({ uri: "http://example.com/x" }))).toBe(INVALID);
      expect(await code(client.resourceRead({ uri: "file://otherhost/etc/passwd" }))).toBe(INVALID);
      expect(await code(client.resourceRead({ uri: "relative/path" }))).toBe(INVALID);
    });

    it("refuses binary files other than images", async () => {
      expect(await code(client.resourceRead({ uri: u(join(proj, "bin.dat")) }))).toBe(INVALID);
      const image = await client.resourceRead({ uri: u(join(proj, "pic.png")) });
      expect(image).toMatchObject({ encoding: "base64", contentType: "image/png" });
      expect(Buffer.from(image.data, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
    });

    it("refuses an oversized text file and serves a window of it", async () => {
      const failed = await failure(client.resourceRead({ uri: u(join(proj, "big.txt")) }));
      expect(failed.code).toBe(INVALID);
      expect(failed.message).toContain("too large");
      const windowed = (await client.resourceRead({
        uri: u(join(proj, "big.txt")),
        fromLine: 10,
        lineCount: 3,
      } as never)) as unknown as { data: string; window: { fromLine: number; hasMore: boolean } };
      expect(windowed.data).toBe("line of text\nline of text\nline of text");
      expect(windowed.window).toMatchObject({ fromLine: 10, hasMore: true });
    });

    it("refuses a federated session's path with a files-live-on error", async () => {
      const failed = await failure(client.resourceRead({ uri: u(join(remoteCwd, "r.txt")) }));
      expect(failed.code).toBe(DENIED);
      expect(failed.message).toContain('files live on "peer"');
      expect((await failure(client.resourceList({ uri: u(remoteCwd) }))).message).toContain("peer");
    });

    it("lists directories only under a directory root", async () => {
      const listing = await client.resourceList({ uri: u(picker) });
      expect(listing.entries).toEqual([
        { name: "other", type: "directory" },
        { name: "sub", type: "directory" },
      ]);
      expect((await client.resourceList({ uri: u(join(picker, "sub")) })).entries).toEqual([]);
      expect(await code(client.resourceRead({ uri: u(join(picker, "note.txt")) }))).toBe(DENIED);
      expect(await code(client.resourceResolve({ uri: u(join(picker, "note.txt")) }))).toBe(DENIED);
      expect((await client.resourceResolve({ uri: u(join(picker, "sub")) })).type).toBe("directory");
    });

    it("completes @ mentions from the session cwd", async () => {
      const text = "look at @a.t";
      const result = await client.completions({
        kind: "userMessage" as never,
        channel: "ahp-chat:/s1",
        text,
        offset: text.length,
      });
      expect(result.items[0]).toMatchObject({
        insertText: "@src/a.ts",
        rangeStart: 8,
        rangeEnd: 12,
        attachment: { type: "resource", label: "a.ts", uri: u(join(proj, "src", "a.ts")) },
      });
      expect(result.items.map((item) => item.insertText)).not.toContain("@link-file");
    });

    it("completes nothing for a federated session or without a mention", async () => {
      const text = "@r";
      const fed = await client.completions({
        kind: "userMessage" as never,
        channel: "ahp-chat:/peer:x",
        text,
        offset: text.length,
      });
      expect(fed.items).toEqual([]);
      const plain = await client.completions({
        kind: "userMessage" as never,
        channel: "ahp-chat:/s1",
        text: "no mention",
        offset: 10,
      });
      expect(plain.items).toEqual([]);
    });
  });

  describe("level matrix", () => {
    it("answers -32601 for every write command and the watch below full", async () => {
      for (const level of ["scoped", "read"] as const) {
        const client = await connect(level);
        const target = u(join(proj, "new.txt"));
        expect(await code(client.resourceWrite({ uri: target, data: "x", encoding: "utf-8" as never }))).toBe(METHOD_NOT_FOUND);
        expect(await code(client.resourceDelete({ uri: u(join(proj, "readme.md")) }))).toBe(METHOD_NOT_FOUND);
        expect(await code(client.resourceMkdir({ uri: u(join(proj, "d")) }))).toBe(METHOD_NOT_FOUND);
        expect(await code(client.resourceMove({ source: u(join(proj, "readme.md")), destination: target }))).toBe(METHOD_NOT_FOUND);
        expect(await code(client.resourceCopy({ source: u(join(proj, "readme.md")), destination: target }))).toBe(METHOD_NOT_FOUND);
        expect(await code(client.createResourceWatch({ uri: u(proj) } as never))).toBe(METHOD_NOT_FOUND);
        expect(existsSync(join(proj, "new.txt"))).toBe(false);
        expect(existsSync(join(proj, "d"))).toBe(false);
      }
    });

    it("ignores the scope at read but still refuses writes", async () => {
      const client = await connect("read");
      expect((await client.resourceRead({ uri: u(join(secret, "key.txt")) })).data).toBe("TOP SECRET");
      expect((await client.resourceRead({ uri: u(join(proj, "link-out", "key.txt")) })).data).toBe("TOP SECRET");
      expect((await client.resourceRead({ uri: u(join(remoteCwd, "r.txt")) })).data).toBe("remote file");
      const listing = await client.resourceList({ uri: u(picker) });
      expect(listing.entries).toContainEqual({ name: "note.txt", type: "file" });
      expect((await client.resourceRead({ uri: u(join(proj, "bin.dat")) })).encoding).toBe("base64");
      expect((await client.resourceResolve({ uri: u(join(secret, "key.txt")) })).type).toBe("file");
      expect(await code(client.resourceRead({ uri: u(join(secret, "missing")) }))).toBe(NOT_FOUND);
    });

    it("lets full read anywhere and keeps createResourceWatch refused", async () => {
      const client = await connect("full");
      expect((await client.resourceRead({ uri: u(join(secret, "key.txt")) })).data).toBe("TOP SECRET");
      expect(await code(client.createResourceWatch({ uri: u(proj) } as never))).toBe(METHOD_NOT_FOUND);
    });
  });

  describe("full writes", () => {
    let client: Session["client"];
    let work: string;

    beforeAll(async () => {
      client = await connect("full");
      work = join(dir, "work");
      mkdirSync(work);
    });

    const text = (data: string) => ({ data, encoding: "utf-8" as never });

    it("writes, overwrites, appends and inserts", async () => {
      const file = join(work, "w.txt");
      await client.resourceWrite({ uri: u(file), ...text("hello") });
      await client.resourceWrite({ uri: u(file), ...text("HELLO") });
      expect(readFileSync(file, "utf8")).toBe("HELLO");
      await client.resourceWrite({ uri: u(file), ...text("!"), mode: "append" as never });
      expect(readFileSync(file, "utf8")).toBe("HELLO!");
      await client.resourceWrite({ uri: u(file), ...text("-"), mode: "append" as never, position: 1 });
      expect(readFileSync(file, "utf8")).toBe("HELLO-!");
      await client.resourceWrite({ uri: u(file), ...text("_"), mode: "insert" as never, position: 2 });
      expect(readFileSync(file, "utf8")).toBe("HE_LLO-!");
      await client.resourceWrite({ uri: u(file), ...text("x"), position: 2 });
      expect(readFileSync(file, "utf8")).toBe("HEx");
    });

    it("writes base64 content", async () => {
      const file = join(work, "b.bin");
      await client.resourceWrite({ uri: u(file), data: Buffer.from([0, 1, 2]).toString("base64"), encoding: "base64" as never });
      expect(readFileSync(file)).toEqual(Buffer.from([0, 1, 2]));
    });

    it("honours createOnly and ifMatch", async () => {
      const file = join(work, "c.txt");
      await client.resourceWrite({ uri: u(file), ...text("one"), createOnly: true });
      expect(await code(client.resourceWrite({ uri: u(file), ...text("two"), createOnly: true }))).toBe(EXISTS);
      const { etag } = await client.resourceResolve({ uri: u(file) });
      await client.resourceWrite({ uri: u(file), ...text("three"), ifMatch: etag });
      expect(await code(client.resourceWrite({ uri: u(file), ...text("four"), ifMatch: etag }))).toBe(CONFLICT);
      expect(readFileSync(file, "utf8")).toBe("three");
    });

    it("answers NotFound when the parent directory is missing", async () => {
      expect(await code(client.resourceWrite({ uri: u(join(work, "no", "dir", "f.txt")), ...text("x") }))).toBe(NOT_FOUND);
    });

    it("creates directories with mkdir -p semantics", async () => {
      await client.resourceMkdir({ uri: u(join(work, "a", "b", "c")) });
      await client.resourceMkdir({ uri: u(join(work, "a", "b", "c")) });
      expect(existsSync(join(work, "a", "b", "c"))).toBe(true);
      expect(await code(client.resourceMkdir({ uri: u(join(work, "w.txt")) }))).toBe(EXISTS);
    });

    it("copies and moves", async () => {
      await client.resourceWrite({ uri: u(join(work, "m.txt")), ...text("move me") });
      await client.resourceCopy({ source: u(join(work, "m.txt")), destination: u(join(work, "m2.txt")) });
      expect(readFileSync(join(work, "m2.txt"), "utf8")).toBe("move me");
      expect(await code(client.resourceCopy({ source: u(join(work, "m.txt")), destination: u(join(work, "m2.txt")), failIfExists: true }))).toBe(EXISTS);
      await client.resourceMove({ source: u(join(work, "m2.txt")), destination: u(join(work, "m3.txt")) });
      expect(existsSync(join(work, "m2.txt"))).toBe(false);
      expect(readFileSync(join(work, "m3.txt"), "utf8")).toBe("move me");
      expect(await code(client.resourceMove({ source: u(join(work, "m.txt")), destination: u(join(work, "m3.txt")), failIfExists: true }))).toBe(EXISTS);
      expect(await code(client.resourceMove({ source: u(join(work, "gone")), destination: u(join(work, "x")) }))).toBe(NOT_FOUND);
    });

    it("deletes files, refuses non-empty directories without recursive, and unlinks symlinks without following", async () => {
      await client.resourceDelete({ uri: u(join(work, "m3.txt")) });
      expect(existsSync(join(work, "m3.txt"))).toBe(false);
      expect(await code(client.resourceDelete({ uri: u(join(work, "a")) }))).toBe(INVALID);
      await client.resourceDelete({ uri: u(join(work, "a")), recursive: true });
      expect(existsSync(join(work, "a"))).toBe(false);
      symlinkSync(join(secret, "key.txt"), join(work, "lnk"));
      await client.resourceDelete({ uri: u(join(work, "lnk")) });
      expect(existsSync(join(work, "lnk"))).toBe(false);
      expect(existsSync(join(secret, "key.txt"))).toBe(true);
      expect(await code(client.resourceDelete({ uri: u(join(work, "gone")) }))).toBe(NOT_FOUND);
    });
  });
});

describe("edited path extraction", () => {
  it("takes diff blocks, patch metadata and write-shaped input", () => {
    expect(
      extractEditedPaths({
        sessionUpdate: "tool_call",
        content: [{ type: "diff", path: "/a/b.ts" }, { type: "content" }],
      }),
    ).toEqual(["/a/b.ts"]);
    expect(
      extractEditedPaths({
        sessionUpdate: "tool_call_update",
        rawOutput: { metadata: { files: [{ filePath: "/p.ts", patch: "x" }, { filePath: "/q.ts" }] } },
      }),
    ).toEqual(["/p.ts"]);
    expect(
      extractEditedPaths({ sessionUpdate: "tool_call", rawInput: { file_path: "/w.ts", content: "x" } }),
    ).toEqual(["/w.ts"]);
  });

  it("ignores reads and other update kinds", () => {
    expect(extractEditedPaths({ sessionUpdate: "tool_call", rawInput: { file_path: "/r.ts" } })).toEqual([]);
    expect(extractEditedPaths({ sessionUpdate: "agent_message_chunk", content: [{ type: "diff", path: "/x" }] })).toEqual([]);
  });

  it("collects image resource links as file URIs or paths", () => {
    expect(
      extractResourceLinkImagePaths([
        { type: "resource_link", uri: "file:///tmp/shot.png" },
        { type: "resource_link", uri: "/tmp/b.jpg" },
        { type: "resource_link", uri: "/tmp/notes.txt" },
      ]),
    ).toEqual(["/tmp/shot.png", "/tmp/b.jpg"]);
  });

  it("never records edits from federated sessions or relative paths", async () => {
    const paths = new EditedPaths();
    paths.record("peer:abc", "/tmp/remote-edit");
    paths.record("local", "relative/file");
    expect(await paths.has("/tmp/remote-edit")).toBe(false);
    paths.observe("local", { sessionUpdate: "tool_call", content: [{ type: "diff", path: "/tmp/local-edit" }] });
    expect(await paths.has("/tmp/local-edit")).toBe(true);
  });
});
