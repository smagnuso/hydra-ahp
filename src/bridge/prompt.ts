import { bag, text, type Json } from "./turns.js";

// The browser extension's image cap.
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface PromptCapabilities {
  image: boolean;
  embeddedContext: boolean;
}

// A message this host cannot hand to the agent; the reason goes back to the client as the rejection.
export class UnsupportedContent extends Error {}

export function promptCapabilities(meta: Json): PromptCapabilities {
  const caps = bag(bag(meta.agentCapabilities).promptCapabilities);
  return { image: caps.image === true, embeddedContext: caps.embeddedContext === true };
}

// Whether the agent takes images, or undefined when Hydra did not say.
export function imageSupport(meta: Json): boolean | undefined {
  const caps = bag(bag(meta.agentCapabilities).promptCapabilities);
  return typeof caps.image === "boolean" ? caps.image : undefined;
}

function decodedSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function attachmentBlock(attachment: Json, caps: PromptCapabilities): Json[] {
  const label = text(attachment.label) ?? "attachment";
  switch (attachment.type) {
    case "simple": {
      const body = text(attachment.modelRepresentation);
      return body ? [{ type: "text", text: body }] : [];
    }
    case "resource": {
      const uri = text(attachment.uri);
      if (!uri) {
        throw new UnsupportedContent(`attachment ${label} has no uri`);
      }
      const mimeType = text(attachment.contentType);
      return [{ type: "resource_link", uri, name: label, ...(mimeType ? { mimeType } : {}) }];
    }
    case "embeddedResource": {
      const data = text(attachment.data) ?? "";
      const mimeType = text(attachment.contentType) ?? "application/octet-stream";
      if (mimeType.startsWith("image/")) {
        if (!caps.image) {
          throw new UnsupportedContent(`this session's agent does not accept images, so ${label} cannot be sent`);
        }
        if (decodedSize(data) > MAX_IMAGE_BYTES) {
          throw new UnsupportedContent(`image ${label} is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`);
        }
        return [{ type: "image", mimeType, data }];
      }
      if (!caps.embeddedContext) {
        throw new UnsupportedContent(`this session's agent does not accept embedded files, so ${label} cannot be sent`);
      }
      return [{ type: "resource", resource: { uri: `attachment:${encodeURIComponent(label)}`, mimeType, blob: data } }];
    }
    default:
      throw new UnsupportedContent(`${String(attachment.type)} attachments are not supported by this host yet`);
  }
}

// An AHP message as the ACP prompt Hydra forwards: its text, then one block per attachment.
export function toAcpPrompt(message: unknown, caps: PromptCapabilities): Json[] {
  const body = bag(message);
  const blocks: Json[] = [];
  const said = text(body.text) ?? "";
  if (said !== "") {
    blocks.push({ type: "text", text: said });
  }
  for (const attachment of Array.isArray(body.attachments) ? body.attachments : []) {
    blocks.push(...attachmentBlock(bag(attachment), caps));
  }
  if (blocks.length === 0) {
    throw new UnsupportedContent("the message is empty");
  }
  return blocks;
}

const ALLOW = new Set(["allow_once", "allow_always"]);
const REJECT = new Set(["reject_once", "reject_always"]);

// ACP permission options as AHP confirmation options; approvals and denials go in separate groups.
export function confirmationOptions(options: readonly Json[]): Json[] {
  const offered: Json[] = [];
  for (const option of options) {
    const id = text(option.optionId);
    const kind = text(option.kind) ?? "";
    if (!id || !(ALLOW.has(kind) || REJECT.has(kind))) {
      continue;
    }
    const approve = ALLOW.has(kind);
    offered.push({ id, label: text(option.name) ?? id, kind: approve ? "approve" : "deny", group: approve ? 0 : 1 });
  }
  return offered;
}

export function isApproval(options: readonly Json[], optionId: string | undefined): boolean {
  const kind = text(options.find((option) => option.optionId === optionId)?.kind);
  return kind !== undefined && ALLOW.has(kind);
}

// The ACP option to answer with: the client's pick when it is one of ours, otherwise the first of the right kind, once before always.
export function chooseOption(options: readonly Json[], approved: boolean, selected: string | undefined): string | undefined {
  const wanted = approved ? ALLOW : REJECT;
  const picked = options.find((option) => option.optionId === selected);
  if (picked && wanted.has(text(picked.kind) ?? "")) {
    return selected;
  }
  const order = approved ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const found = text(options.find((option) => option.kind === kind)?.optionId);
    if (found) {
      return found;
    }
  }
  return undefined;
}
