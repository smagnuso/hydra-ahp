import type {
  ActionOrigin,
  Implementation,
  ListSessionsParams,
  ListSessionsResult,
  StateAction,
} from "@microsoft/agent-host-protocol";
import type { TokenInfo } from "../store/tokens.js";
import type { ProtocolCore } from "./core.js";

export interface ClientContext {
  clientId: string;
  version: string;
  token: TokenInfo;
}

export interface ActionRequest {
  channel: string;
  action: StateAction;
  origin: ActionOrigin;
  client: ClientContext;
}

export type ActionDecision = { accept: true } | { accept: false; reason: string };

// What the protocol core needs from whatever sits behind it (Hydra, or a fake in tests).
export interface Backend {
  serverInfo?: Implementation;
  defaultDirectory?: string;
  completionTriggerCharacters?: string[];

  start(core: ProtocolCore): void | Promise<void>;

  listSessions(params: ListSessionsParams, client: ClientContext): ListSessionsResult | Promise<ListSessionsResult>;

  // Called before a channel's first subscriber is served; may create the channel.
  attach?(uri: string): void | Promise<void>;

  // Called when a channel's last subscriber leaves.
  detach?(uri: string): void | Promise<void>;

  // Called when a client's connection goes away, whether or not it comes back.
  connectionClosed?(clientId: string): void;

  // Validated client actions land here; accepting echoes the action to subscribers.
  handleAction(request: ActionRequest): ActionDecision | Promise<ActionDecision>;

  // Any other request method; throw RpcError for failures, omit for -32601.
  handleCommand?(method: string, params: unknown, client: ClientContext): unknown | Promise<unknown>;
}
