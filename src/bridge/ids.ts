import { fileURLToPath, pathToFileURL } from "node:url";
import { isSessionChannelUri } from "../protocol/channels.js";

const SESSION_PREFIX = "ahp-session:/";
const CHAT_PREFIX = "ahp-chat:/";

export function sessionUri(id: string): string {
  return `${SESSION_PREFIX}${id}`;
}

export function chatUri(id: string): string {
  return `${CHAT_PREFIX}${id}`;
}

const SCHEME_NAME = /^[a-z][a-z0-9+.-]*$/i;

// VS Code takes a session URI's scheme to be the agent provider, and finds no content provider for any other, so a session lives at <agent>:/<id>.
export function providerSessionUri(provider: string | undefined, id: string): string {
  return provider && SCHEME_NAME.test(provider) ? `${provider}:/${id}` : sessionUri(id);
}

const DEFAULT_CHAT_PREFIX = "ahp-chat://default/";

// VS Code addresses a session's default chat as ahp-chat://default/<base64url of the session URI>, whatever the session state lists.
export function defaultChatUri(session: string): string {
  return `${DEFAULT_CHAT_PREFIX}${Buffer.from(session, "utf8").toString("base64url")}`;
}

export function sessionOfDefaultChat(chat: string): string | undefined {
  if (!chat.startsWith(DEFAULT_CHAT_PREFIX)) {
    return undefined;
  }
  const decoded = Buffer.from(chat.slice(DEFAULT_CHAT_PREFIX.length), "base64url").toString("utf8");
  return decoded === "" ? undefined : decoded;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\//i;

export function isSessionUri(uri: string): boolean {
  return isSessionChannelUri(uri);
}

export function isNativeSessionUri(uri: string): boolean {
  return uri.startsWith(SESSION_PREFIX);
}

export function isChatUri(uri: string): boolean {
  return uri.startsWith(CHAT_PREFIX) && uri.length > CHAT_PREFIX.length;
}

export function sessionKey(uri: string): string {
  return uri.replace(SCHEME, "");
}

export function chatKey(uri: string): string {
  return uri.slice(CHAT_PREFIX.length);
}

export function cwdToUri(cwd: string): string {
  return pathToFileURL(cwd).href;
}

export function uriToCwd(uri: string): string | undefined {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
  } catch {
    return undefined;
  }
}

export function isFederatedId(hydraId: string): boolean {
  return hydraId.includes(":");
}
