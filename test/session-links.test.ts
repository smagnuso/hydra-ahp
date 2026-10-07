import { describe, expect, it } from "vitest";
import { ChatMapper, type Frame } from "../src/bridge/mapping.js";
import { holdFrom, LinkStream, rewriteSessionLinks, vscodeSessionLink } from "../src/bridge/session-links.js";
import { foldRecorded } from "./support/oracle.js";

const KNOWN: Record<string, string> = {
  hydra_session_TOh6XWtvXLQwMgVV: "agent-host-session://claude-personal/hydra_session_TOh6XWtvXLQwMgVV",
};
const resolve = (id: string): string | undefined => KNOWN[id];
const FORK = "\nForked to [`TOh6XWtvXLQwMgVV`](hydra://sessions/TOh6XWtvXLQwMgVV).\n";
const ID = "hydra_session_TOh6XWtvXLQwMgVV";
const LINK = KNOWN[ID]!;
const REWRITTEN ="\nForked to [`TOh6XWtvXLQwMgVV`](agent-host-session://claude-personal/hydra_session_TOh6XWtvXLQwMgVV).\n";

describe("session links", () => {
  it("builds VS Code's link from a session's AHP URI", () => {
    expect(vscodeSessionLink("opencode:/hydra_session_abc")).toBe("agent-host-session://opencode/hydra_session_abc");
    expect(vscodeSessionLink("ahp-session:/peer:hydra_session_abc")).toBe("agent-host-session://ahp-session/peer:hydra_session_abc");
    expect(vscodeSessionLink("opencode:/")).toBeUndefined();
  });

  it("rewrites a link target, a full id, a host and a turn anchor, and leaves unknown sessions alone", () => {
    expect(rewriteSessionLinks(FORK, resolve)).toBe(REWRITTEN);
    expect(rewriteSessionLinks("[x](hydra://sessions/hydra_session_TOh6XWtvXLQwMgVV)", resolve)).toBe(
      "[x](agent-host-session://claude-personal/hydra_session_TOh6XWtvXLQwMgVV)",
    );
    expect(rewriteSessionLinks("[x](hydra://box:8080/sessions/TOh6XWtvXLQwMgVV#turn-3)", resolve)).toBe(
      "[x](agent-host-session://claude-personal/hydra_session_TOh6XWtvXLQwMgVV)",
    );
    expect(rewriteSessionLinks("[x](hydra://sessions/unknownSession1)", resolve)).toBe("[x](hydra://sessions/unknownSession1)");
  });

  it("makes a bare link a markdown link named for the session", () => {
    expect(rewriteSessionLinks("see hydra://sessions/TOh6XWtvXLQwMgVV now", resolve)).toBe(
      "see [TOh6XWtvXLQwMgVV](agent-host-session://claude-personal/hydra_session_TOh6XWtvXLQwMgVV) now",
    );
  });

  it("holds back only what could still become a link", () => {
    expect(holdFrom("plain text")).toBe(10);
    expect(holdFrom("see hyd")).toBe(4);
    expect(holdFrom("see (hydra://sessions/TOh6")).toBe(5);
    expect(holdFrom("see (hydra://sessions/TOh6XWtvXLQwMgVV)")).toBe(39);
    expect(holdFrom(`hydra://${"x".repeat(400)}`)).toBe(408);
  });

  it("links a full session id, bare or in backticks, and leaves unknown ids alone", () => {
    expect(rewriteSessionLinks("ran in hydra_session_TOh6XWtvXLQwMgVV.", resolve)).toBe(`ran in [${ID}](${LINK}).`);
    expect(rewriteSessionLinks("ran in `hydra_session_TOh6XWtvXLQwMgVV`.", resolve)).toBe(`ran in [\`${ID}\`](${LINK}).`);
    expect(rewriteSessionLinks("ran in hydra_session_unknownSessionA.", resolve)).toBe("ran in hydra_session_unknownSessionA.");
  });

  it("leaves an id in code, in a link or in a longer token as written", () => {
    const untouched = [
      "```\nhydra_session_TOh6XWtvXLQwMgVV\n```",
      "~~~sh\nhydra-acp attach hydra_session_TOh6XWtvXLQwMgVV\n~~~",
      "`hydra-acp attach hydra_session_TOh6XWtvXLQwMgVV`",
      `[hydra_session_TOh6XWtvXLQwMgVV](${LINK})`,
      "[see](hydra_session_TOh6XWtvXLQwMgVV)",
      "peer:hydra_session_TOh6XWtvXLQwMgVV",
      "xhydra_session_TOh6XWtvXLQwMgVV",
      "hydra_session_TOh6XWtvXLQwMgVVx",
      "hydra_session_TOh6XWtvXLQwMgVV.jsonl",
    ];
    for (const text of untouched) {
      expect(rewriteSessionLinks(text, resolve)).toBe(text);
    }
    expect(rewriteSessionLinks("```\ncode\n```\nthen hydra_session_TOh6XWtvXLQwMgVV", resolve)).toBe(`\`\`\`\ncode\n\`\`\`\nthen [${ID}](${LINK})`);
  });

  it("rewrites links and ids however the stream splits them", () => {
    const text = `${FORK}See \`hydra_session_TOh6XWtvXLQwMgVV\` and hydra_session_TOh6XWtvXLQwMgVV\n\`\`\`\nhydra_session_TOh6XWtvXLQwMgVV\n\`\`\`\nhydra_session_TOh6XWtvXLQwMgVV`;
    const expected = rewriteSessionLinks(text, resolve);
    expect(expected).toBe(
      `${REWRITTEN}See [\`${ID}\`](${LINK}) and [${ID}](${LINK})\n\`\`\`\n${ID}\n\`\`\`\n[${ID}](${LINK})`,
    );
    for (let size = 1; size <= text.length; size += 1) {
      const stream = new LinkStream(resolve);
      let out = "";
      for (let at = 0; at < text.length; at += size) {
        out += stream.push(text.slice(at, at + size));
      }
      out += stream.flush();
      expect(out, `chunks of ${size}`).toBe(expected);
    }
  });
});

describe("session links in a chat", () => {
  let tick = 2_000_000;
  const frame = (update: Record<string, unknown>): Frame => ({ update, recordedAt: (tick += 10), seq: tick });
  const prompt = frame({ sessionUpdate: "prompt_received", messageId: "m1", prompt: [{ type: "text", text: "/hydra fork" }], sentBy: { clientId: "c" } });
  const say = (text: string): Frame => frame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const done = frame({ sessionUpdate: "turn_complete", stopReason: "end_turn" });
  const markdown = (frames: Frame[], options = { sessionLink: resolve }): string => {
    const folded = foldRecorded(frames, { mapper: options });
    const turn = folded.state.turns.at(-1) ?? folded.state.activeTurn;
    return (turn!.responseParts as Array<{ kind: string; content?: string }>)
      .filter((part) => part.kind === "markdown")
      .map((part) => part.content)
      .join("|");
  };

  it("rewrites a fork link split across chunks, flushing what was held when the turn ends", () => {
    expect(markdown([prompt, say("\nForked to [`TOh6XWtvXLQwMgVV`](hyd"), say("ra://sessions/TOh6XW"), say("tvXLQwMgVV)"), done])).toBe(
      "\nForked to [`TOh6XWtvXLQwMgVV`](agent-host-session://claude-personal/hydra_session_TOh6XWtvXLQwMgVV)",
    );
  });

  it("flushes held text into its own part before a tool call opens the next one", () => {
    const call = frame({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Run", status: "in_progress" });
    expect(markdown([prompt, say("look at hydra://sessions/TOh6XWtvXLQwMgVV"), call, say("after"), done])).toBe(
      "look at [TOh6XWtvXLQwMgVV](agent-host-session://claude-personal/hydra_session_TOh6XWtvXLQwMgVV)|after",
    );
  });

  it("passes text through untouched without a resolver", () => {
    const mapper = new ChatMapper();
    const actions = [...mapper.map(prompt), ...mapper.map(say("x hydra://sessions/TOh6XWtvXLQwMgVV"))];
    expect(actions.at(-1)).toMatchObject({ type: "chat/delta", content: "x hydra://sessions/TOh6XWtvXLQwMgVV" });
  });
});
