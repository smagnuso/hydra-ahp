import {
  ACTION_INTRODUCED_IN,
  NOTIFICATION_INTRODUCED_IN,
  SUPPORTED_PROTOCOL_VERSIONS,
  compareProtocolVersions,
  negotiateProtocolVersion,
  type SessionSummary,
  type StateAction,
} from "@microsoft/agent-host-protocol";

export const SUPPORTED_VERSIONS: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;

export type NotificationMethod = keyof typeof NOTIFICATION_INTRODUCED_IN;

// Returns undefined when the offer is malformed or nothing is compatible.
export function negotiate(offered: readonly string[]): string | undefined {
  try {
    return negotiateProtocolVersion(offered);
  } catch {
    return undefined;
  }
}

export function isKnownActionType(type: string): type is StateAction["type"] {
  return Object.prototype.hasOwnProperty.call(ACTION_INTRODUCED_IN, type);
}

export function isActionAllowed(action: StateAction, version: string): boolean {
  const introduced = (ACTION_INTRODUCED_IN as Record<string, string | undefined>)[action.type];
  if (introduced === undefined) {
    return false;
  }
  return compareProtocolVersions(introduced, version) <= 0;
}

export function isNotificationAllowed(method: string, version: string): boolean {
  const introduced = (NOTIFICATION_INTRODUCED_IN as Record<string, string | undefined>)[method];
  if (introduced === undefined) {
    return false;
  }
  return compareProtocolVersions(introduced, version) <= 0;
}

export function isAtLeast(version: string, minimum: string): boolean {
  return compareProtocolVersions(version, minimum) >= 0;
}

// SessionSummary.chats and defaultChat arrived in 1.0.0 (spec changelog).
export function shapeSummary<T extends Partial<SessionSummary>>(summary: T, version: string): T {
  if (isAtLeast(version, "1.0.0")) {
    return summary;
  }
  const { chats: _chats, defaultChat: _defaultChat, ...rest } = summary;
  return rest as T;
}
