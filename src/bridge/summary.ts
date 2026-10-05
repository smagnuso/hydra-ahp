import type { Changeset, SessionConfigState, SessionState, SessionSummary } from "@microsoft/agent-host-protocol";
import type { HydraSessionEntry } from "../hydra/rest.js";
import { NO_FLAGS, type SessionFlags } from "../store/flags.js";
import { cwdToUri, defaultChatUri, isFederatedId } from "./ids.js";

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

export interface GroupMember {
  entry: HydraSessionEntry;
  chat: string;
  flags: SessionFlags;
  origin?: Record<string, unknown>;
}

export const UNTITLED_CHAT = "Untitled chat";

// The session's activity is the busiest of its chats: waiting on input over streaming over idle.
function groupActivity(members: readonly GroupMember[]): number {
  let activity = STATUS_IDLE;
  for (const member of members) {
    const bits = statusBits(member.entry);
    if (bits === STATUS_INPUT_NEEDED) {
      return STATUS_INPUT_NEEDED;
    }
    if (bits === STATUS_IN_PROGRESS) {
      activity = STATUS_IN_PROGRESS;
    }
  }
  return activity;
}

// One AHP session summary for a group of Hydra sessions; the first member is the default chat and speaks for the session.
// Federated rows are labelled with the remote's name through the project grouping.
export function groupToSummary(members: readonly GroupMember[], uri: string): SessionSummary {
  const lead = members[0] as GroupMember;
  const entry = lead.entry;
  const modifiedAt = members.reduce((latest, member) => {
    const at = member.entry.updatedAt ?? "";
    return at > latest ? at : latest;
  }, "") || new Date(0).toISOString();
  const title = entry.title || UNTITLED;
  const remote = entry.remote;
  const summary: Record<string, unknown> = {
    resource: uri,
    provider: entry.agentId ?? "unknown",
    title,
    status: withFlagBits(groupActivity(members), lead.flags),
    createdAt: entry.createdAt ?? modifiedAt,
    modifiedAt,
    chats: members.map((member) => ({
      resource: member.chat,
      title: member.entry.title || (member === lead ? title : UNTITLED_CHAT),
      status: withFlagBits(statusBits(member.entry), member.flags),
      modifiedAt: member.entry.updatedAt ?? modifiedAt,
      ...(member.origin ? { origin: member.origin } : {}),
    })),
    defaultChat: lead.chat,
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

export function entryToSummary(entry: HydraSessionEntry, uri: string, flags: SessionFlags = NO_FLAGS): SessionSummary {
  return groupToSummary([{ entry, chat: defaultChatUri(uri), flags }], uri);
}

export function summaryToSessionState(
  summary: SessionSummary,
  lifecycle: "creating" | "ready",
  config?: SessionConfigState,
  changesets?: Changeset[],
): SessionState {
  const chats = (summary.chats ?? []).map((chat) => ({
    resource: chat.resource,
    title: chat.title,
    status: chat.status ?? summary.status,
    modifiedAt: (chat as { modifiedAt?: string }).modifiedAt ?? summary.modifiedAt,
  }));
  const { createdAt: _createdAt, modifiedAt: _modifiedAt, chats: _chats, _meta, ...metadata } = summary;
  return {
    ...metadata,
    lifecycle,
    activeClients: [],
    chats,
    ...(summary.defaultChat ? { defaultChat: summary.defaultChat } : {}),
    ...(config ? { config } : {}),
    ...(changesets ? { changesets } : {}),
    ...(_meta ? { _meta } : {}),
  } as unknown as SessionState;
}
