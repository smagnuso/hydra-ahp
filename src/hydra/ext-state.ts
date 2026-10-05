import type { HydraClient } from "./client.js";

// Hydra's per-(extension, session) durable bucket; the extension name comes from the bearer token.
export class ExtensionState {
  constructor(private readonly client: HydraClient) {}

  async get<T = unknown>(sessionId: string, key: string): Promise<T | null> {
    const result = await this.client.request<{ value: T | null }>("hydra-acp/session/extension_state/get", {
      sessionId,
      key,
    });
    return result?.value ?? null;
  }

  async list(sessionId: string): Promise<Record<string, unknown>> {
    const result = await this.client.request<{ state: Record<string, unknown> }>(
      "hydra-acp/session/extension_state/list",
      { sessionId },
    );
    return result?.state ?? {};
  }

  async set(sessionId: string, key: string, value: unknown): Promise<void> {
    await this.client.request("hydra-acp/session/extension_state/set", { sessionId, key, value });
  }

  async delete(sessionId: string, key: string): Promise<void> {
    await this.client.request("hydra-acp/session/extension_state/delete", { sessionId, key });
  }
}
