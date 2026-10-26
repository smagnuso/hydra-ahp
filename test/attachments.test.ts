import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localizeAttachments } from "../src/bridge/attachments.js";
import { UnsupportedContent, toAcpPrompt } from "../src/bridge/prompt.js";
import { AttachmentStore } from "../src/store/attachments.js";

describe("localizeAttachments", () => {
  let root: string;
  let store: AttachmentStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ahp-attach-"));
    store = new AttachmentStore(join(root, "attachments"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const message = (uri: string, label = "output.log") => ({ text: "see this", attachments: [{ type: "resource", uri, label }] });
  const read = (body: string) => async () => ({ data: Buffer.from(body).toString("base64"), encoding: "base64" });

  it("replaces a client file with a private copy and keeps the label", async () => {
    const out = await localizeAttachments(message("file:///home/them/output.log"), { store, hydraId: "hydra_session_a", read: read("line one\n") });
    const [attachment] = out.attachments as Array<Record<string, string>>;
    expect(attachment.label).toBe("output.log");
    const path = fileURLToPath(attachment.uri);
    expect(store.owns(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("line one\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const prompt = toAcpPrompt(out, { image: false, embeddedContext: false });
    expect(prompt[1]).toMatchObject({ type: "resource_link", name: "output.log", uri: attachment.uri });
  });

  it("asks the client only once for a copy it already made", async () => {
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return { data: Buffer.from("x").toString("base64"), encoding: "base64" };
    };
    const first = await localizeAttachments(message("file:///a/b.txt"), { store, hydraId: "h", read: counting });
    await localizeAttachments(first, { store, hydraId: "h", read: counting });
    expect(calls).toBe(1);
  });

  it("leaves the message alone without a client to ask or for other kinds of attachment", async () => {
    const plain = message("file:///a/b.txt");
    expect(await localizeAttachments(plain, { store, hydraId: "h", read: undefined })).toEqual(plain);
    const other = { attachments: [{ type: "resource", uri: "https://example.com/x", label: "x" }, { type: "embeddedResource", label: "Image", data: "AAAA" }] };
    expect(await localizeAttachments(other, { store, hydraId: "h", read: read("nope") })).toEqual(other);
  });

  it("refuses the message when the client cannot serve the file", async () => {
    const failing = async () => {
      throw new Error("permission denied");
    };
    const attempt = localizeAttachments(message("file:///a/b.txt"), { store, hydraId: "h", read: failing });
    await expect(attempt).rejects.toBeInstanceOf(UnsupportedContent);
    await expect(attempt).rejects.toThrow(/output\.log could not be read from your client: permission denied/);
  });

  it("refuses a file over the size limit", async () => {
    const huge = async () => ({ data: Buffer.alloc(26 * 1024 * 1024).toString("base64"), encoding: "base64" });
    await expect(localizeAttachments(message("file:///a/b.bin", "b.bin"), { store, hydraId: "h", read: huge })).rejects.toThrow(/larger than 25 MB/);
  });

  it("keeps a hostile name inside the session folder", async () => {
    const out = await localizeAttachments(message("file:///a/b", "../../etc/passwd"), { store, hydraId: "h", read: read("x") });
    const path = fileURLToPath((out.attachments as Array<Record<string, string>>)[0].uri);
    expect(path.startsWith(join(store.root, "h") + "/")).toBe(true);
  });

  it("forgets a session's copies and sweeps stale folders", async () => {
    const out = await localizeAttachments(message("file:///a/b.txt"), { store, hydraId: "gone", read: read("x") });
    const path = fileURLToPath((out.attachments as Array<Record<string, string>>)[0].uri);
    store.forget("gone");
    expect(existsSync(path)).toBe(false);

    const kept = await localizeAttachments(message("file:///a/c.txt"), { store, hydraId: "old", read: read("y") });
    const keptPath = fileURLToPath((kept.attachments as Array<Record<string, string>>)[0].uri);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(join(store.root, "old"), old, old);
    store.sweep(7 * 24 * 60 * 60 * 1000);
    expect(existsSync(keptPath)).toBe(false);
  });
});
