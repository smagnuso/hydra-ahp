import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RootState, TerminalState } from "@microsoft/agent-host-protocol";
import { startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";
import { act } from "./support/harness.js";
import { cwdToUri } from "../src/bridge/ids.js";

const TERMINAL = "agenthost-terminal:/t1";
const WINDOWS = process.platform === "win32";
// The same steps in the shell each platform starts: print a computed value and the working directory, then exit with a code.
const SHOW = WINDOWS ? "set N=4& echo hi-%N%2& cd\r\n" : "echo hi-$((40+2)); pwd\n";
const EXIT = WINDOWS ? "exit 7\r\n" : "exit 7\n";
const output = (state: TerminalState): string => state.content.map((part) => (part.type === "command" ? part.output : part.value)).join("");

describe("terminals", () => {
  let harness: BridgeHarness;

  afterEach(async () => {
    await harness.stop();
  });

  async function connected(full: boolean) {
    const session = full ? await harness.connectFull() : await harness.connect();
    await session.client.initialize({ clientId: full ? "vscode" : "other", protocolVersions: ["0.9.0"], initialSubscriptions: ["ahp-root://"] });
    return session;
  }

  it("runs a shell for a full token: output streams, input and resize reach it, dispose kills it", async () => {
    harness = await startBridgeHarness();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ahp-term-")));
    const session = await connected(true);
    await session.client.request("createTerminal", {
      channel: TERMINAL,
      claim: { kind: "client", clientId: "vscode" },
      name: "Agent Host Terminal",
      cwd: cwdToUri(dir),
      cols: 80,
      rows: 30,
    } as never);
    const listed = await session.waitFor((e) => e.channel === "ahp-root://" && e.action.type === "root/terminalsChanged", 2000);
    expect((listed.action as unknown as { terminals: RootState["terminals"] }).terminals?.map((t) => t.resource)).toEqual([TERMINAL]);
    const sub = await session.client.subscribe(TERMINAL);
    expect((sub.result.snapshot?.state as TerminalState)).toMatchObject({ title: "Agent Host Terminal", cols: 80, rows: 30, isPty: true, lifecycle: { status: "running" } });

    session.client.dispatch(TERMINAL, act({ type: "terminal/resized", cols: 100, rows: 40 }));
    session.client.dispatch(TERMINAL, act({ type: "terminal/input", data: SHOW }));
    await session.waitFor(() => output(harness.core.store.state(TERMINAL) as TerminalState).includes("hi-42"), 5000);
    const state = harness.core.store.state(TERMINAL) as TerminalState;
    expect(output(state)).toContain(basename(dir));
    expect(state.cols).toBe(100);

    session.client.dispatch(TERMINAL, act({ type: "terminal/input", data: EXIT }));
    await session.waitFor((e) => e.channel === TERMINAL && e.action.type === "terminal/exited", 5000);
    expect((harness.core.store.state(TERMINAL) as TerminalState).lifecycle).toEqual({ status: "exited", exitCode: 7 });

    await session.client.request("disposeTerminal", { channel: TERMINAL } as never);
    expect(harness.core.store.has(TERMINAL)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses terminals to a token below full", async () => {
    harness = await startBridgeHarness();
    const session = await connected(false);
    await expect(
      session.client.request("createTerminal", { channel: TERMINAL, claim: { kind: "client", clientId: "other" } } as never),
    ).rejects.toMatchObject({ code: -32601 });
    expect(harness.core.store.has(TERMINAL)).toBe(false);
  });

  it("kills a terminal whose client went away and did not come back", async () => {
    harness = await startBridgeHarness();
    const session = await connected(true);
    await session.client.request("createTerminal", { channel: TERMINAL, claim: { kind: "client", clientId: "vscode" } } as never);
    expect(harness.core.store.has(TERMINAL)).toBe(true);
    await session.shutdown();
    for (let waited = 0; harness.core.store.has(TERMINAL) && waited < 3000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(harness.core.store.has(TERMINAL)).toBe(false);
  });

  it("rejects a malformed terminal URI and a duplicate", async () => {
    harness = await startBridgeHarness();
    const session = await connected(true);
    await expect(session.client.request("createTerminal", { channel: "ahp-chat:/x" } as never)).rejects.toMatchObject({ code: -32602 });
    await session.client.request("createTerminal", { channel: TERMINAL } as never);
    await expect(session.client.request("createTerminal", { channel: TERMINAL } as never)).rejects.toMatchObject({ code: -32602 });
    await session.client.request("disposeTerminal", { channel: TERMINAL } as never);
  });
});
