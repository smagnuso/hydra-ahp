import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatState, ToolCallState } from "@microsoft/agent-host-protocol";
import { ChatView, markdown, runsPending } from "../support/chat-view.js";
import { connectAhp, Driver, ROOT, type AhpConnection } from "../support/driver.js";
import { ScratchDaemon, until } from "../support/scratch.js";

// WP6 scenarios, written ahead of T11; see runsPending.
describe.skipIf(!runsPending("T11"))("agent-initiated turns and attach mid-turn against a scratch daemon", () => {
  let daemon: ScratchDaemon;
  let driver: Driver;
  let ahp: AhpConnection;
  const views: ChatView[] = [];

  beforeAll(async () => {
    daemon = await ScratchDaemon.create({ name: "robustness" });
    driver = await Driver.open(daemon);
    ahp = await connectAhp(daemon, driver, await driver.newSession());
  });

  afterEach(async () => {
    for (const view of views.splice(0)) {
      await view.close().catch(() => undefined);
    }
    driver.permissionAnswer = "allow";
    driver.held.splice(0);
  });

  afterAll(async () => {
    await ahp.session.shutdown();
    driver.close();
    await daemon.destroy();
  });

  async function listed(id: string): Promise<boolean> {
    const result = (await ahp.session.client.request("listSessions", { channel: ROOT } as never)) as unknown as {
      items: Array<{ resource: string }>;
    };
    return result.items.some((item) => item.resource === `ahp-session:/${id}`);
  }

  async function prompted(): Promise<string> {
    const id = await driver.newSession();
    await driver.prompt(id, "ping");
    await until("session listed", () => listed(id));
    return id;
  }

  async function open(id: string): Promise<ChatView> {
    const view = await ChatView.open(ahp, id);
    views.push(view);
    return view;
  }

  const hydraTurnEnded = (id: string, reason: string): Promise<boolean> =>
    until(`_hydra_turn_ended ${reason}`, () =>
      driver.updates.some(
        (u) =>
          u.sessionId === id &&
          u.update.sessionUpdate === "_hydra_turn_ended" &&
          (u.update._meta as { "hydra-acp"?: { reason?: string } } | undefined)?.["hydra-acp"]?.reason === reason,
      ),
    );

  const agentTurn = (view: ChatView): Promise<string> =>
    view.until("agent-initiated turn", (chat) =>
      chat.activeTurn !== undefined && chat.activeTurn.message.origin.kind !== "user" ? chat.activeTurn.id : undefined,
    );

  it("shows a turn the agent started by itself, from start to finish", async () => {
    const view = await open(await prompted());
    await driver.prompt(view.id, "script:wake");
    const turnId = await agentTurn(view);
    const chat = await view.until("agent turn finished", (state) =>
      state.activeTurn === undefined && state.turns.some((turn) => turn.id === turnId) ? state : undefined,
    );
    expect(chat.turns.map((turn) => turn.message.text).slice(0, 2)).toEqual(["ping", "script:wake"]);
    const own = chat.turns.at(-1)!;
    expect(own).toMatchObject({ id: turnId, state: "complete" });
    expect(own.message.origin.kind).not.toBe("user");
    expect(markdown(own.responseParts)).toBe("woke done");
    expect(typeof own.duration).toBe("number");
  });

  it("cancels a turn the agent started by itself from AHP", async () => {
    const view = await open(await prompted());
    await driver.prompt(view.id, "script:wake-long");
    const turnId = await agentTurn(view);
    await view.dispatch({ type: "chat/turnCancelled", turnId, duration: 1 });
    const chat = await view.until("agent turn cancelled", (state) =>
      state.activeTurn === undefined && state.turns.some((turn) => turn.id === turnId) ? state : undefined,
    );
    expect(chat.turns.at(-1)).toMatchObject({ id: turnId, state: "cancelled" });
    await hydraTurnEnded(view.id, "cancelled");
    expect(await driver.agentLog(view.id)).toContain("cancel");
    expect((await daemon.admin.getSession(view.id)).busy).toBeFalsy();
  });

  it("cancels from AHP a turn that was already running when it subscribed", async () => {
    const id = await prompted();
    const turn = driver.client.request<{ stopReason: string }>("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "script:wait" }] });
    await until("agent waiting", () => driver.updates.some((u) => u.sessionId === id && u.update.content?.text === "waiting "));
    const view = await open(id);
    const active = view.chat().activeTurn;
    expect(active).toBeDefined();
    await view.dispatch({ type: "chat/turnCancelled", turnId: active!.id, duration: 1 });
    expect(await turn).toMatchObject({ stopReason: "cancelled" });
    const chat: ChatState = await view.until("turn cancelled", (state) => (state.activeTurn === undefined ? state : undefined));
    expect(chat.turns.at(-1)).toMatchObject({ id: active!.id, state: "cancelled" });
    expect(await driver.agentLog(id)).toContain("cancel");
  });

  it("offers a permission that was already pending when it subscribed", async () => {
    const id = await prompted();
    driver.permissionAnswer = "hold";
    const turn = driver.prompt(id, "script:ask");
    await until("driver holds the request", () => driver.held.length === 1);
    const view = await open(id);
    const pending = (): ToolCallState | undefined => view.toolCalls().find((call) => call.status === "pending-confirmation");
    const call = await view.until("replayed confirmation", () => pending());
    expect(call.toolCallId).toBe("ask-1");
    const turnId = view.chat().activeTurn!.id;
    await view.dispatch({ type: "chat/toolCallConfirmed", turnId, toolCallId: "ask-1", approved: false, reason: "denied" });
    expect(await turn).toContain("ask-1:reject");
    await view.until("turn finished", (state) => state.activeTurn === undefined);
    expect(view.toolCall("ask-1")?.status).not.toBe("pending-confirmation");
  });
});
