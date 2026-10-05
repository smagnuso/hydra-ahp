import { RpcError } from "../rpc/peer.js";

const SEGMENT = "/edit/";
const NOT_FOUND = -32008;
// Edits of every chat mapped since start; the oldest go first past this.
const MAX_BYTES = 32 * 1024 * 1024;

export function isEditContentUri(uri: unknown): uri is string {
  return typeof uri === "string" && uri.startsWith("ahp-chat:") && uri.includes(SEGMENT);
}

export function editContentUri(chatUri: string, toolCallId: string, index: number, side: "old" | "new"): string {
  return `${chatUri}${SEGMENT}${encodeURIComponent(toolCallId)}/${index}/${side}`;
}

// The before and after text of the edits in mapped tool calls, served to resourceRead so a client can diff them.
export class EditContentStore {
  private readonly texts = new Map<string, string>();
  private bytes = 0;

  put(uri: string, text: string): void {
    const previous = this.texts.get(uri);
    if (previous !== undefined) {
      this.bytes -= previous.length;
      this.texts.delete(uri);
    }
    this.texts.set(uri, text);
    this.bytes += text.length;
    for (const [oldest, value] of this.texts) {
      if (this.bytes <= MAX_BYTES || oldest === uri) {
        break;
      }
      this.texts.delete(oldest);
      this.bytes -= value.length;
    }
  }

  read(uri: string, encoding: unknown): unknown {
    const text = this.texts.get(uri);
    if (text === undefined) {
      throw new RpcError(NOT_FOUND, "no such file or directory");
    }
    if (encoding === "base64") {
      return { data: Buffer.from(text, "utf8").toString("base64"), encoding: "base64", contentType: "text/plain" };
    }
    return { data: text, encoding: "utf-8", contentType: "text/plain" };
  }
}
