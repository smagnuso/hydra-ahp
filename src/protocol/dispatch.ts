import {
  isClientDispatchable,
  type ChatState,
  type StateAction,
} from "@microsoft/agent-host-protocol";
import { channelKind, type ChannelKind, type ChannelState } from "./channels.js";
import { isActionAllowed, isKnownActionType } from "./negotiate.js";

export type Validation = { ok: true } | { ok: false; reason: string };

const OK: Validation = { ok: true };

const PREFIX_KIND: Record<string, ChannelKind> = {
  root: "root",
  session: "session",
  chat: "chat",
};

function reject(reason: string): Validation {
  return { ok: false, reason };
}

const ACTIVE_TURN_ACTIONS = new Set([
  "chat/toolCallConfirmed",
  "chat/toolCallResultConfirmed",
  "chat/toolCallContentChanged",
  "chat/turnCancelled",
]);

// Some clients leave out the turnId these actions require; the only turn they can mean is the active one.
export function withActiveTurn(state: ChannelState | undefined, action: StateAction): StateAction {
  if (!ACTIVE_TURN_ACTIONS.has(action.type)) {
    return action;
  }
  const given = (action as { turnId?: unknown }).turnId;
  const active = (state as ChatState | undefined)?.activeTurn;
  if ((typeof given === "string" && given !== "") || !active) {
    return action;
  }
  return { ...action, turnId: active.id } as StateAction;
}

// Checks the spec's server validation rules and the per-version gate.
export function validateAction(
  channel: string,
  state: ChannelState,
  action: StateAction,
  version: string,
): Validation {
  if (typeof action.type !== "string" || !isKnownActionType(action.type)) {
    return reject(`unknown action type: ${String(action.type)}`);
  }
  if (!isActionAllowed(action, version)) {
    return reject(`action ${action.type} is not part of protocol ${version}`);
  }
  if (!isClientDispatchable(action as Parameters<typeof isClientDispatchable>[0])) {
    return reject(`action ${action.type} is not client-dispatchable`);
  }
  const prefix = action.type.split("/")[0] ?? "";
  if (PREFIX_KIND[prefix] !== channelKind(channel)) {
    return reject(`action ${action.type} does not apply to ${channel}`);
  }
  if (channelKind(channel) === "chat") {
    return validateChatAction(state as ChatState, action);
  }
  return OK;
}

function validateChatAction(state: ChatState, action: StateAction): Validation {
  switch (action.type) {
    case "chat/toolCallConfirmed": {
      const active = state.activeTurn;
      const part = active?.responseParts.find(
        (candidate) =>
          candidate.kind === "toolCall" && candidate.toolCall.toolCallId === action.toolCallId,
      );
      if (
        !active ||
        active.id !== action.turnId ||
        part?.kind !== "toolCall" ||
        part.toolCall.status !== "pending-confirmation"
      ) {
        return reject(`tool call ${action.toolCallId} is not pending confirmation`);
      }
      return OK;
    }
    case "chat/turnCancelled":
      if (!state.activeTurn || state.activeTurn.id !== action.turnId) {
        return reject("no active turn to cancel");
      }
      return OK;
    case "chat/turnResume": {
      const last = state.turns[state.turns.length - 1];
      const resumable = last?.responseParts.some(
        (part) => part.kind === "error" && part.resumable === true,
      );
      if (state.activeTurn || !last || last.id !== action.turnId || last.state !== "error" || !resumable) {
        return reject(`turn ${action.turnId} cannot be resumed`);
      }
      return OK;
    }
    case "chat/inputAnswerChanged":
    case "chat/inputCompleted": {
      const found = state.activeTurn?.responseParts.some(
        (part) => part.kind === "inputRequest" && part.request.id === action.requestId && !part.response,
      );
      if (!found) {
        return reject(`no open input request ${action.requestId}`);
      }
      return OK;
    }
    case "chat/pendingMessageRemoved": {
      const present =
        action.kind === "steering"
          ? state.steeringMessage?.id === action.id
          : (state.queuedMessages ?? []).some((pending) => pending.id === action.id);
      if (!present) {
        return reject(`no pending ${action.kind} message ${action.id}`);
      }
      return OK;
    }
    default:
      return OK;
  }
}
