import { fileURLToPath, pathToFileURL } from "node:url";

const SESSION_PREFIX = "ahp-session:/";
const CHAT_PREFIX = "ahp-chat:/";

export function sessionUri(id: string): string {
  return `${SESSION_PREFIX}${id}`;
}

export function chatUri(id: string): string {
  return `${CHAT_PREFIX}${id}`;
}

export function isSessionUri(uri: string): boolean {
  return uri.startsWith(SESSION_PREFIX) && uri.length > SESSION_PREFIX.length && !uri.includes("/", SESSION_PREFIX.length);
}

export function isChatUri(uri: string): boolean {
  return uri.startsWith(CHAT_PREFIX) && uri.length > CHAT_PREFIX.length;
}

export function sessionKey(uri: string): string {
  return uri.slice(SESSION_PREFIX.length);
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
