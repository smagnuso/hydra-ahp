import { describe, expect, it } from "vitest";
import { defaultChatUri, sessionOfDefaultChat } from "../src/bridge/ids.js";

describe("default chat URIs", () => {
  it("match what VS Code derives for a session", () => {
    expect(defaultChatUri("ahp-session:/hydra_session_DbR9m4Gd4YN1Y64L")).toBe(
      "ahp-chat://default/YWhwLXNlc3Npb246L2h5ZHJhX3Nlc3Npb25fRGJSOW00R2Q0WU4xWTY0TA",
    );
  });

  it("round-trip, including federated and client-chosen session URIs", () => {
    for (const session of ["ahp-session:/peer:abc_123", "fake:/0b8e6c55-3c1e", "ahp-session:/h1"]) {
      expect(sessionOfDefaultChat(defaultChatUri(session))).toBe(session);
    }
  });

  it("leave other chat URIs alone", () => {
    expect(sessionOfDefaultChat("ahp-chat:/abc")).toBeUndefined();
    expect(sessionOfDefaultChat("ahp-chat://default/")).toBeUndefined();
  });
});
