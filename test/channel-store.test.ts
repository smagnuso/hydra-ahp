import { describe, expect, it } from "vitest";
import type { ChatState, SessionState } from "@microsoft/agent-host-protocol";
import { ChannelStore } from "../src/protocol/channels.js";
import { emptyChat } from "../src/bridge/replay.js";

const SESSION = "fake:/h1";
const CHAT = "ahp-chat://default/ZmFrZTovaDE";

function store(): ChannelStore {
  const channels = new ChannelStore({ startSeq: 100 });
  channels.create(SESSION, { title: "Old", chats: [{ resource: CHAT, title: "Old" }] } as unknown as SessionState);
  channels.create(CHAT, emptyChat(CHAT, "Old", "2026-10-05T00:00:00.000Z", 0));
  return channels;
}

const rename = (title: string) => ({ type: "session/chatUpdated", chat: CHAT, changes: { title } }) as never;

describe("a chat summary change announced on the session", () => {
  it("reaches the chat's own state", () => {
    const channels = store();
    channels.apply(SESSION, rename("New"));
    expect((channels.state(CHAT) as ChatState).title).toBe("New");
  });

  it("sends a client that last saw the chat before it to a snapshot, and one that saw it to a replay", () => {
    const channels = store();
    const before = channels.serverSeq;
    channels.apply(SESSION, rename("New"));
    expect(channels.replay(before, [CHAT]).type).toBe("snapshot");
    expect(channels.replay(channels.serverSeq, [CHAT]).type).toBe("replay");
  });

  it("leaves the replay baseline alone when nothing changed", () => {
    const channels = store();
    const before = channels.serverSeq;
    channels.apply(SESSION, rename("Old"));
    expect(channels.replay(before, [CHAT]).type).toBe("replay");
  });
});
