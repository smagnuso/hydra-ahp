export class HydraHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "HydraHttpError";
  }
}

export interface HydraSessionEntry {
  sessionId: string;
  agentId?: string;
  cwd?: string;
  // Present while the session runs in an isolated workspace, whose path is then the cwd.
  workspace?: { path: string; sourceCwd: string; label?: string };
  title?: string;
  status?: "warm" | "cold";
  busy?: boolean;
  awaitingInput?: boolean;
  attachedClients?: number;
  updatedAt?: string;
  createdAt?: string;
  interactive?: boolean;
  remote?: string;
  currentModel?: string;
  turnStartedAt?: number;
  // Daemon read state: a turn ended that no client has marked read since.
  unread?: boolean;
  lastTurnEndedAt?: number;
  importedFromMachine?: string;
  upstreamSessionId?: string;
  parentSessionId?: string;
  [key: string]: unknown;
}

export interface SessionPage {
  sessions: HydraSessionEntry[];
  removed: string[];
  cursor?: number;
}

export interface ListQuery {
  since?: number;
  status?: "warm" | "cold";
  includeNonInteractive?: boolean;
}

export interface HydraAgent {
  id: string;
  name: string;
  version?: string;
  description?: string;
  installed?: "yes" | "no" | "lazy";
  // Most specific first: the agent's own id, then each id it extends.
  extendsChain?: string[];
}

export interface HydraConfig {
  sessionDefaults?: Record<string, Record<string, string>>;
}

export interface HistoryPage {
  entries: unknown[];
  hasMore: boolean;
}

export interface SystemInfo {
  machine?: string;
  hydraVersion?: string;
}

export class HydraRest {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      const detail = typeof parsed === "object" && parsed !== null ? (parsed as { error?: unknown }).error : undefined;
      throw new HydraHttpError(
        response.status,
        parsed,
        `${method} ${path} failed with ${response.status}${detail ? `: ${String(detail)}` : ""}`,
      );
    }
    return parsed as T;
  }

  health(): Promise<{ status: string; version: string }> {
    return fetch(`${this.baseUrl}/v1/health`).then((r) => r.json() as Promise<{ status: string; version: string }>);
  }

  system(): Promise<SystemInfo> {
    return this.request("GET", "/v1/system");
  }

  listSessions(query: ListQuery = {}): Promise<SessionPage> {
    const params = new URLSearchParams();
    if (query.since !== undefined) {
      params.set("since", String(query.since));
    }
    if (query.status) {
      params.set("status", query.status);
    }
    if (query.includeNonInteractive) {
      params.set("includeNonInteractive", "1");
    }
    const suffix = params.size > 0 ? `?${params}` : "";
    return this.request("GET", `/v1/sessions${suffix}`);
  }

  getSession(id: string): Promise<HydraSessionEntry> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}`);
  }

  createSession(body: { cwd?: string; agentId?: string; remote?: string }): Promise<{
    sessionId: string;
    agentId?: string;
    cwd?: string;
  }> {
    return this.request("POST", "/v1/sessions", body);
  }

  forkSession(id: string, body: { forkAt?: string; mode?: "verbatim" | "synthesis" } = {}): Promise<{ sessionId: string }> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(id)}/fork`, body);
  }

  sideSession(id: string, body: { forkAt?: string; selection?: { text: string; responsePartId?: string } } = {}): Promise<{ sessionId: string }> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(id)}/side`, body);
  }

  // Edit-and-resend in place: drops every turn after the one holding keepThrough (null: all of them), keeping the session id.
  rewindSession(id: string, keepThrough: string | null): Promise<{ sessionId: string; removed: number }> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(id)}/rewind`, { keepThrough });
  }

  // Demotes a live session to cold: the agent exits, the record stays and the session resumes on demand.
  killSession(id: string): Promise<void> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(id)}/kill`);
  }

  deleteSession(id: string): Promise<void> {
    return this.request("DELETE", `/v1/sessions/${encodeURIComponent(id)}`);
  }

  patchSession(id: string, body: { title?: string; read?: boolean }): Promise<unknown> {
    return this.request("PATCH", `/v1/sessions/${encodeURIComponent(id)}`, body);
  }

  agents(): Promise<{ agents: HydraAgent[] }> {
    return this.request("GET", "/v1/agents");
  }

  config(): Promise<HydraConfig> {
    return this.request("GET", "/v1/config");
  }

  // Hydra's per-file aggregation of the edits a session's tool calls recorded.
  sessionDiff(id: string): Promise<Array<{ path: string; created?: boolean }>> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}/diff`);
  }

  historyPage(id: string, beforeSeq: number, turns?: number): Promise<HistoryPage> {
    const params = new URLSearchParams({ beforeSeq: String(beforeSeq) });
    if (turns !== undefined) {
      params.set("turns", String(turns));
    }
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}/history/page?${params}`);
  }
}
