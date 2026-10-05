import type { SessionState, SessionSummary } from "@microsoft/agent-host-protocol";
import type { HydraSessionEntry } from "../hydra/rest.js";
import { NO_FLAGS, type SessionFlags } from "../store/flags.js";
import { chatUri, cwdToUri, isFederatedId, sessionKey } from "./ids.js";

export const STATUS_IDLE = 1;
export const STATUS_IN_PROGRESS = 8;
export const STATUS_INPUT_NEEDED = 24;
export const STATUS_IS_READ = 32;
export const STATUS_IS_ARCHIVED = 64;

export const UNTITLED = "Untitled session";

export function statusBits(entry: Pick<HydraSessionEntry, "busy" | "awaitingInput">): number {
  if (entry.awaitingInput) {
    return STATUS_INPUT_NEEDED;
  }
  return entry.busy ? STATUS_IN_PROGRESS : STATUS_IDLE;
}

export function withFlagBits(status: number, flags: SessionFlags): number {
  let next = status & ~(STATUS_IS_READ | STATUS_IS_ARCHIVED);
  if (flags.isRead) {
    next |= STATUS_IS_READ;
  }
  if (flags.isArchived) {
    next |= STATUS_IS_ARCHIVED;
  }
  return next;
}

// Federated rows are labelled with the remote's name through the project grouping.
export function entryToSummary(entry: HydraSessionEntry, uri: string, flags: SessionFlags = NO_FLAGS): SessionSummary {
  const modifiedAt = entry.updatedAt ?? new Date(0).toISOString();
  const title = entry.title || UNTITLED;
  const chat = chatUri(sessionKey(uri));
  const remote = entry.remote;
  const summary: Record<string, unknown> = {
    resource: uri,
    provider: entry.agentId ?? "unknown",
    title,
    status: withFlagBits(statusBits(entry), flags),
    createdAt: entry.createdAt ?? modifiedAt,
    modifiedAt,
    chats: [{ resource: chat, title }],
    defaultChat: chat,
  };
  if (entry.cwd && !remote && !isFederatedId(entry.sessionId)) {
    summary.workingDirectories = [cwdToUri(entry.cwd)];
  }
  if (remote) {
    summary.project = { uri: `hydra-remote:/${encodeURIComponent(remote)}`, displayName: remote };
    summary._meta = { "hydra-acp": { remote } };
  }
  return summary as unknown as SessionSummary;
}

export function summaryToSessionState(
  summary: SessionSummary,
  lifecycle: "creating" | "ready",
): SessionState {
  const chats = (summary.chats ?? []).map((chat) => ({
    resource: chat.resource,
    title: chat.title,
    status: summary.status,
    modifiedAt: summary.modifiedAt,
  }));
  const { createdAt: _createdAt, modifiedAt: _modifiedAt, chats: _chats, _meta, ...metadata } = summary;
  return {
    ...metadata,
    lifecycle,
    activeClients: [],
    chats,
    ...(summary.defaultChat ? { defaultChat: summary.defaultChat } : {}),
    ...(_meta ? { _meta } : {}),
  } as unknown as SessionState;
}
