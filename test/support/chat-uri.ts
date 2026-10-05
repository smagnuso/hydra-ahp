import { defaultChatUri } from "../../src/bridge/ids.js";

// The default chat of a native session, addressed the way VS Code does.
export function chatOf(hydraId: string): string {
  return defaultChatUri(`ahp-session:/${hydraId}`);
}
