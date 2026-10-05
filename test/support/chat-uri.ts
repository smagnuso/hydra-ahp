import { defaultChatUri } from "../../src/bridge/ids.js";

// A native session as VS Code addresses it: the scheme is the agent provider.
export function sessionOf(hydraId: string, agent = "fake"): string {
  return `${agent}:/${hydraId}`;
}

// The default chat of that session.
export function chatOf(hydraId: string, agent = "fake"): string {
  return defaultChatUri(sessionOf(hydraId, agent));
}
