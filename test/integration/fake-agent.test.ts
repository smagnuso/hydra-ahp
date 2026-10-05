import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Driver } from "../support/driver.js";
import { ScratchDaemon, until, WORK_DIR } from "../support/scratch.js";

// Pins down how the fake agent's write-path scripts behave under a real daemon, with no AHP in the way.
describe("fake agent write-path scripts", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let dir: string;

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({ name: "fakeagent", ahp: false });
    driver = await Driver.open(daemon);
    dir = mkdtempSync(join(tmpdir(), "ahp-gates-"));
  });

  afterAll(async () => {
    driver.close();
    await daemon.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  const started = (id: string): Promise<{ stopReason: string }> =>
    driver.client.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "script:wait" }] });

  const said = (id: string, text: string): Promise<boolean> =>
    until(`"${text}"`, () => driver.updates.some((u) => u.sessionId === id && u.update.content?.text === text));

  const ended = (id: string, reason: string): Promise<boolean> =>
    until(`_hydra_turn_ended ${reason}`, () =>
      driver.updates.some(
        (u) =>
          u.sessionId === id &&
          u.update.sessionUpdate === "_hydra_turn_ended" &&
          (u.update._meta as { "hydra-acp"?: { reason?: string } } | undefined)?.["hydra-acp"]?.reason === reason,
      ),
    );

  it("asks permission for a tool call it announced, and logs the answer", async () => {
    const id = await driver.newSession();
    driver.permissionAnswer = "hold";
    const turn = driver.prompt(id, "script:ask");
    await until("held permission", () => driver.held.length === 1);
    expect(driver.held[0]!.params.toolCall.toolCallId).toBe("ask-1");
    expect(driver.kinds(id)).toContain("tool_call");
    driver.held.shift()!.answer("reject");
    expect(await turn).toContain("ask-1:reject");
    driver.permissionAnswer = "allow";
    expect(await driver.agentLog(id)).toContain("permission:ask-1:reject");
  });

  it("asks twice at once with ask2", async () => {
    const id = await driver.newSession();
    driver.permissionAnswer = "hold";
    const turn = driver.prompt(id, "script:ask2");
    await until("two held permissions", () => driver.held.length === 2);
    const [a, b] = driver.held.splice(0);
    b!.answer("allow");
    a!.answer("reject");
    const text = await turn;
    expect(text).toContain("ask-1:reject");
    expect(text).toContain("ask-2:allow");
    driver.permissionAnswer = "allow";
  });

  it("takes a steer natively into the running turn on the fake-steering agent", async () => {
    const id = await driver.newSession(WORK_DIR, "fake-steering");
    const watcher = await Driver.open(daemon);
    await watcher.attach(id);
    const turn = started(id);
    await said(id, "waiting ");
    const result = await driver.client.request<{ outcome: string }>("_session/steering", { sessionId: id, prompt: [{ type: "text", text: "go left" }] });
    expect(result.outcome).toBe("injected");
    expect(await turn).toMatchObject({ stopReason: "end_turn" });
    await said(id, "steered:go left");
    // Hydra echoes the steer to everyone but the steering client.
    await until("steer echo", () => watcher.updates.some((u) => u.update.sessionUpdate === "user_message_chunk" && u.update.content?.text === "go left"));
    await watcher.detach(id);
    watcher.close();

    const idle = await driver.client.request<{ outcome: string }>("_session/steering", {
      sessionId: id,
      prompt: [{ type: "text", text: "later" }],
      _meta: { steering: { idleBehavior: "promptRequired" } },
    });
    expect(idle.outcome).toBe("promptRequired");
    expect(await driver.agentLog(id)).toEqual(["prompt:script:wait", "steer:go left", "prompt:script:log"]);
  });

  it("has Hydra cancel and resubmit a steer when the agent has no native steering", async () => {
    const id = await driver.newSession();
    const turn = started(id);
    await said(id, "waiting ");
    const result = await driver.client.request<{ outcome: string }>("_session/steering", { sessionId: id, prompt: [{ type: "text", text: "go right" }] });
    expect(result.outcome).toBe("startedNewTurn");
    expect(await turn).toMatchObject({ stopReason: "cancelled" });
    await until("steered turn ran", async () => (await driver.agentLog(id)).includes("prompt:go right"));
    const log = await driver.agentLog(id);
    expect(log.slice(0, 3)).toEqual(["prompt:script:wait", "cancel", "prompt:go right"]);
  });

  it("starts and finishes a turn of its own with wake", async () => {
    const id = await driver.newSession();
    expect(await driver.prompt(id, "script:wake")).toBe("sleeping");
    await ended(id, "completed");
    const kinds = driver.kinds(id);
    expect(kinds.indexOf("_hydra_turn_started")).toBeGreaterThan(kinds.indexOf("turn_complete"));
  });

  it("keeps an agent-started turn open with wake-long until a cancel closes it", async () => {
    const id = await driver.newSession();
    await driver.prompt(id, "script:wake-long");
    await until("unsolicited turn", () => driver.kinds(id).includes("_hydra_turn_started"));
    await driver.client.peer.notify("session/cancel", { sessionId: id });
    await ended(id, "cancelled");
    expect(await driver.agentLog(id)).toContain("cancel");
  });

  it("holds a gate turn until its file exists, with prompts queued behind it", async () => {
    const id = await driver.newSession();
    const gate = join(dir, "gate-1");
    const turn = driver.prompt(id, `script:gate ${gate}`);
    await said(id, "gated ");
    const queued = driver.prompt(id, "after");
    await until("queued entry", () => driver.notifications.some((n) => n.method === "hydra-acp/prompt_queue/added" && n.params.sessionId === id && n.params.position === 1));
    writeFileSync(gate, "");
    expect(await turn).toBe("gated released");
    expect(await queued).toContain("pong");
  });
});
