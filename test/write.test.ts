import { afterEach, describe, expect, it } from "vitest";
import type { ActionEnvelope, ChatState, Snapshot } from "@microsoft/agent-host-protocol";
import { MAX_IMAGE_BYTES, UnsupportedContent, chooseOption, confirmationOptions, toAcpPrompt } from "../src/bridge/prompt.js";
import { ReducerOracle } from "./support/oracle.js";
import { startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";
import { act, sleep, type Session } from "./support/harness.js";
import { chatOf } from "./support/chat-uri.js";

const CHAT = chatOf("h1");
const SESSION = "ahp-session:/h1";
const ROOT = "ahp-root://";

const NO_CAPS = { image: false, embeddedContext: false };
const IMAGES = { image: true, embeddedContext: false };
const PNG = Buffer.from("not really a png").toString("base64");

const picture = (data = PNG): Record<string, unknown> => ({ type: "embeddedResource", label: "shot.png", data, contentType: "image/png" });

describe("message content", () => {
  it("sends the text, and images only to agents that take them", () => {
    expect(toAcpPrompt({ text: "hi", origin: { kind: "user" } }, NO_CAPS)).toEqual([{ type: "text", text: "hi" }]);
    expect(toAcpPrompt({ text: "look", attachments: [picture()] }, IMAGES)).toEqual([
      { type: "text", text: "look" },
      { type: "image", mimeType: "image/png", data: PNG },
    ]);
    expect(() => toAcpPrompt({ text: "look", attachments: [picture()] }, NO_CAPS)).toThrow(UnsupportedContent);
  });

  it("refuses an image over the cap, and kinds this host does not serve", () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64");
    expect(() => toAcpPrompt({ text: "", attachments: [picture(big)] }, IMAGES)).toThrow(/larger than/);
    expect(() => toAcpPrompt({ text: "x", attachments: [{ type: "chat", label: "other", resource: "ahp-chat:/x" }] }, IMAGES)).toThrow(
      /not supported/,
    );
    expect(() => toAcpPrompt({ text: "" }, IMAGES)).toThrow(/empty/);
  });

  it("links resource attachments and inlines simple ones", () => {
    expect(
      toAcpPrompt(
        {
          text: "",
          attachments: [
            { type: "resource", label: "a.ts", uri: "file:///tmp/a.ts", contentType: "text/plain" },
            { type: "simple", label: "sel", modelRepresentation: "const x = 1" },
          ],
        },
        NO_CAPS,
      ),
    ).toEqual([
      { type: "resource_link", uri: "file:///tmp/a.ts", name: "a.ts", mimeType: "text/plain" },
      { type: "text", text: "const x = 1" },
    ]);
  });
});

describe("permission options", () => {
  const acp = [
    { optionId: "yes", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ];

  it("maps ACP options to AHP confirmation options", () => {
    expect(confirmationOptions(acp)).toEqual([
      { id: "yes", label: "Allow", kind: "approve", group: 0 },
      { id: "always", label: "Always", kind: "approve", group: 0 },
      { id: "no", label: "Reject", kind: "deny", group: 1 },
    ]);
  });

  it("answers with the client's pick when it matches the verdict, otherwise the first option of that kind", () => {
    expect(chooseOption(acp, true, "always")).toBe("always");
    expect(chooseOption(acp, true, undefined)).toBe("yes");
    expect(chooseOption(acp, false, "yes")).toBe("no");
    expect(chooseOption(acp.slice(0, 2), false, undefined)).toBeUndefined();
  });
});

describe.each(["0.9.0", "1.0.0"])("write actions at %s", (version) => {
  let harness: BridgeHarness;

  afterEach(async () => {
    await harness.stop();
  });

  async function open(): Promise<{ session: Session; oracle: ReducerOracle }> {
    const session = await harness.connect();
    await session.client.initialize({ clientId: `c-${Math.random().toString(16).slice(2)}`, protocolVersions: [version], initialSubscriptions: [ROOT] });
    const oracle = new ReducerOracle();
    oracle.applySnapshot((await session.client.subscribe(SESSION)).result.snapshot as Snapshot);
    oracle.applySnapshot((await session.client.subscribe(CHAT)).result.snapshot as Snapshot);
    return { session, oracle };
  }

  async function dispatch(session: Session, channel: string, action: Record<string, unknown>): Promise<ActionEnvelope> {
    const { clientSeq } = session.client.dispatch(channel, act(action));
    return session.waitFor((envelope) => envelope.origin?.clientSeq === clientSeq);
  }

  function chat(session: Session, oracle: ReducerOracle): ChatState {
    for (const envelope of session.events.splice(0)) {
      oracle.applyEnvelope(envelope);
    }
    return oracle.state(CHAT) as ChatState;
  }

  const turn = (turnId: string, message: Record<string, unknown>) => ({
    type: "chat/turnStarted",
    turnId,
    startedAt: new Date().toISOString(),
    message: { origin: { kind: "user" }, ...message },
  });

  it("switches the model before the prompt and ends the client's turn from the prompt's answer", async () => {
    harness = await startBridgeHarness();
    const { session, oracle } = await open();
    const echo = await dispatch(session, CHAT, turn("t1", { text: "hello", model: { id: "fast" } }));
    expect(echo.rejectionReason).toBeUndefined();
    expect(harness.hydra.writes.map((write) => [write.method, write.params])).toEqual([
      ["session/set_model", "fast"],
      ["session/prompt", [{ type: "text", text: "hello" }]],
    ]);
    expect(chat(session, oracle).activeTurn?.id).toBe("t1");

    harness.hydra.prompts.shift()!.end("end_turn");
    await session.waitFor((envelope) => envelope.action.type === "chat/turnComplete");
    expect(chat(session, oracle).turns.map((entry) => [entry.id, entry.state])).toEqual([["t1", "complete"]]);

    await dispatch(session, CHAT, turn("t2", { text: "again", model: { id: "fast" } }));
    expect(harness.hydra.writes.filter((write) => write.method === "session/set_model")).toHaveLength(1);
  });

  it("rejects a turn whose model the agent refuses, without prompting", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.modelFailure = new Error("unknown model");
    });
    const { session } = await open();
    const echo = await dispatch(session, CHAT, turn("t1", { text: "hello", model: { id: "nope" } }));
    expect(echo.rejectionReason).toMatch(/unknown model/);
    expect(harness.hydra.writes.map((write) => write.method)).toEqual(["session/set_model"]);
  });

  it("rejects an image for an agent without image support and sends it to one that has it", async () => {
    harness = await startBridgeHarness();
    const { session } = await open();
    const refused = await dispatch(session, CHAT, turn("t1", { text: "see", attachments: [picture()] }));
    expect(refused.rejectionReason).toMatch(/does not accept images/);
    expect(harness.hydra.writes).toEqual([]);
    await harness.stop();

    harness = await startBridgeHarness((hydra) => {
      hydra.meta = { agentCapabilities: { promptCapabilities: { image: true } } };
    });
    const second = await open();
    const sent = await dispatch(second.session, CHAT, turn("t1", { text: "see", attachments: [picture()] }));
    expect(sent.rejectionReason).toBeUndefined();
    expect(harness.hydra.writes[0]?.params).toEqual([
      { type: "text", text: "see" },
      { type: "image", mimeType: "image/png", data: PNG },
    ]);
  });

  it("retitles through PATCH and refuses an empty title", async () => {
    harness = await startBridgeHarness();
    const { session } = await open();
    const echo = await dispatch(session, SESSION, { type: "session/titleChanged", title: "Renamed" });
    expect(echo.rejectionReason).toBeUndefined();
    expect(harness.hydra.writes).toEqual([{ method: "PATCH", id: "h1", params: { title: "Renamed" } }]);
    const empty = await dispatch(session, SESSION, { type: "session/titleChanged", title: " " });
    expect(empty.rejectionReason).toMatch(/empty/);
  });

  it("disposes a session with a REST delete", async () => {
    harness = await startBridgeHarness();
    const { session } = await open();
    await session.client.request("disposeSession", { channel: SESSION } as never);
    await sleep(10);
    expect(harness.hydra.writes).toEqual([{ method: "DELETE", id: "h1" }]);
  });
});
