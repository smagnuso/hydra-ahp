import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_ATTACHMENT_BYTES, type AttachmentStore } from "../store/attachments.js";
import { UnsupportedContent } from "./prompt.js";
import { bag, text, type Json } from "./turns.js";

export interface ClientFile {
  data: string;
  encoding?: string;
}

export type ClientReader = (uri: string) => Promise<ClientFile>;

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function bytesOf(file: ClientFile): Buffer {
  return file.encoding === "utf-8" ? Buffer.from(file.data, "utf8") : Buffer.from(file.data, "base64");
}

// A file the client attached is a path on its machine, so the agent is given a copy fetched from the client instead.
export async function localizeAttachments(
  message: unknown,
  options: { store: AttachmentStore; hydraId: string; read: ClientReader | undefined },
): Promise<Json> {
  const body = bag(message);
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (!options.read || attachments.length === 0) {
    return body;
  }
  const localized: unknown[] = [];
  for (const raw of attachments) {
    const attachment = bag(raw);
    const uri = text(attachment.uri);
    if (attachment.type !== "resource" || !uri?.startsWith("file:")) {
      localized.push(raw);
      continue;
    }
    const label = text(attachment.label) ?? "attachment";
    let path: string;
    try {
      path = fileURLToPath(uri);
    } catch {
      localized.push(raw);
      continue;
    }
    if (options.store.owns(path)) {
      localized.push(raw);
      continue;
    }
    let bytes: Buffer;
    try {
      const file = await options.read(uri);
      if (typeof file.data !== "string") {
        throw new Error("it returned no content");
      }
      bytes = bytesOf(file);
    } catch (err) {
      throw new UnsupportedContent(`${label} could not be read from your client: ${reason(err)}`);
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new UnsupportedContent(`${label} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
    }
    localized.push({ ...attachment, uri: pathToFileURL(options.store.save(options.hydraId, label, bytes)).href });
  }
  return { ...body, attachments: localized };
}
