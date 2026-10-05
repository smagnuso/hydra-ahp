import type { RootState } from "@microsoft/agent-host-protocol";
import type { HydraClient } from "../../src/hydra/client.js";
import { RpcError } from "../../src/rpc/peer.js";
import { openSession, type Session } from "./harness.js";
import type { ScratchDaemon } from "./scratch.js";

export interface SessionUpdate {
  sessionId: string;
  update: { sessionUpdate: string; content?: { text?: string }; [key: string]: unknown };
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string };
  options: Array<{ optionId: string; kind: string }>;
}

export interface HeldPermission {
  params: PermissionRequest;
  answer(optionId: string): void;
}

// A plain Hydra ACP client for scripting sessions on a scratch daemon.
export class Driver {
  readonly updates: SessionUpdate[] = [];
  readonly permissions: PermissionRequest[] = [];
  // Requests left open under "hold", for the test to answer whenever it likes.
  readonly held: HeldPermission[] = [];
  readonly notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  permissionAnswer: string | "abstain" | "hold" = "allow";

  constructor(readonly client: HydraClient) {
    client.peer.onNotification("session/update", (params) => {
      this.updates.push(params as SessionUpdate);
    });
    for (const method of ["added", "updated", "removed", "held", "released"].map((kind) => `hydra-acp/prompt_queue/${kind}`)) {
      client.peer.onNotification(method, (params) => {
        this.notifications.push({ method, params: params as Record<string, unknown> });
      });
    }
    const answer = (params: unknown): unknown => {
      this.permissions.push(params as PermissionRequest);
      if (this.permissionAnswer === "abstain") {
        throw new RpcError(-32601, "abstain");
      }
      if (this.permissionAnswer === "hold") {
        return new Promise((resolve) => {
          this.held.push({
            params: params as PermissionRequest,
            answer: (optionId) => resolve({ outcome: { outcome: "selected", optionId } }),
          });
        });
      }
      return { outcome: { outcome: "selected", optionId: this.permissionAnswer } };
    };
    client.peer.onRequest("session/request_permission", answer);
    // A federated session's requests arrive under the hydra-acp/ name.
    client.peer.onRequest("hydra-acp/session/request_permission", answer);
  }

  static async open(daemon: ScratchDaemon): Promise<Driver> {
    return new Driver(await daemon.client());
  }

  async newSession(cwd = "/tmp", agentId?: string): Promise<string> {
    const result = await this.client.request<{ sessionId: string }>("session/new", {
      cwd,
      mcpServers: [],
      ...(agentId ? { _meta: { "hydra-acp": { agentId } } } : {}),
    });
    return result.sessionId;
  }

  attach(sessionId: string, meta: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.client.request("session/attach", {
      sessionId,
      historyPolicy: "full",
      clientInfo: { name: "scratch-test" },
      ...(Object.keys(meta).length > 0 ? { _meta: { "hydra-acp": meta } } : {}),
    });
  }

  detach(sessionId: string): Promise<unknown> {
    return this.client.request("session/detach", { sessionId });
  }

  // Sends a prompt and returns the text the agent streamed back before the turn ended.
  async prompt(sessionId: string, text: string): Promise<string> {
    const from = this.updates.length;
    await this.client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    return this.textSince(sessionId, from);
  }

  // Everything this driver has seen of the session's kinds, in arrival order.
  kinds(sessionId: string): string[] {
    return this.updates.filter((u) => u.sessionId === sessionId).map((u) => u.update.sessionUpdate);
  }

  // The fake agent's own record of what reached it (prompts, steers, cancels, permission answers).
  async agentLog(sessionId: string): Promise<string[]> {
    return JSON.parse(await this.prompt(sessionId, "script:log")) as string[];
  }

  textSince(sessionId: string, from: number): string {
    return this.updates
      .slice(from)
      .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk")
      .map((u) => u.update.content?.text ?? "")
      .join("");
  }

  close(): void {
    this.client.close();
  }
}

export const ROOT = "ahp-root://";

export interface AhpConnection {
  session: Session;
  token: string;
  root: RootState;
}

// Mints a token through the /hydra ahp slash verb (as a user would) and connects to the AHP port with it.
export async function connectAhp(
  daemon: ScratchDaemon,
  driver: Driver,
  hostSession: string,
  options: { label?: string; files?: string; version?: string } = {},
): Promise<AhpConnection> {
  const text = await driver.prompt(
    hostSession,
    `/hydra ahp token mint ${options.label ?? "test"}${options.files ? ` --files ${options.files}` : ""}`,
  );
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) {
    throw new Error(`mint reply had no entry: ${text}`);
  }
  const entry = JSON.parse(match[0]) as { address: string; connectionToken: string };
  const session = await openSession(`ws://${entry.address}/?tkn=${encodeURIComponent(entry.connectionToken)}`);
  const offered = options.version === "1.0.0" ? ["1.0.0", "0.9.0"] : ["0.10.0", "0.9.0", "0.7.0"];
  const result = await session.client.initialize({
    clientId: `test-${Math.random().toString(16).slice(2)}`,
    protocolVersions: offered,
    initialSubscriptions: [ROOT],
  });
  const root = result.snapshots.find((s) => s.resource === ROOT)?.state as RootState;
  return { session, token: entry.connectionToken, root };
}
