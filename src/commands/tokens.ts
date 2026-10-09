import qrcode from "qrcode-terminal";
import { FILE_LEVELS, isFileLevel, type FileLevel, type TokenRegistry } from "../store/tokens.js";

export const COMMAND_VERB = "token";

export const COMMAND_SPEC = {
  verb: COMMAND_VERB,
  argsHint: "mint <label> [--files full|read|scoped] | url [label] | list | revoke <id>",
  description: "Manage the AHP connection tokens (VS Code chat.remoteAgentHosts)",
};

const USAGE = `usage: token mint <label> [--files ${FILE_LEVELS.join("|")}] | token url [label] [--files ...] | token list | token revoke <id>`;

export interface TokenCommandContext {
  tokens: TokenRegistry;
  address: () => string;
  scheme?: () => "ws" | "wss";
  warning?: string;
}

export const WILDCARD_WARNING =
  "Bound to all interfaces: a token gives shell-equivalent access to anyone who can reach this port. `hydra-acp daemon listen local` (or a narrower scope) limits it.";

export function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function withWarning(context: TokenCommandContext, text: string): string {
  return context.warning ? `${text}\n\n${context.warning}` : text;
}

function parseMint(words: string[], defaultLabel?: string): { label: string; level: FileLevel } | string {
  const label: string[] = [];
  let level: FileLevel = "full";
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as string;
    let value: string | undefined;
    if (word === "--files") {
      value = words[++i];
    } else if (word.startsWith("--files=")) {
      value = word.slice("--files=".length);
    } else if (word.startsWith("--")) {
      return `unknown option ${word}\n${USAGE}`;
    } else {
      label.push(word);
      continue;
    }
    if (!isFileLevel(value)) {
      return `--files must be one of ${FILE_LEVELS.join(", ")}`;
    }
    level = value;
  }
  if (label.length === 0 && defaultLabel !== undefined) {
    label.push(defaultLabel);
  }
  if (label.length === 0) {
    return `a label is required\n${USAGE}`;
  }
  return { label: label.join(" "), level };
}

// The URL form carries the token as ?tkn=, like VS Code's transport.
function connectUrl(address: string, token: string, scheme: string): string {
  return `${scheme}://${address}?tkn=${encodeURIComponent(token)}`;
}

function qrText(url: string): string {
  let out = "";
  qrcode.generate(url, { small: true }, (code) => {
    out = code;
  });
  return out.trimEnd();
}

// Runs one "token ..." invocation and returns the reply text.
export function runTokenCommand(context: TokenCommandContext, args: string): string {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const action = words.shift();
  switch (action) {
    case "mint": {
      const parsed = parseMint(words);
      if (typeof parsed === "string") {
        return parsed;
      }
      const { token, info } = context.tokens.mint(parsed.label, parsed.level);
      const scheme = context.scheme?.() ?? "ws";
      const entry = { address: scheme === "wss" ? `wss://${context.address()}` : context.address(), name: parsed.label, connectionToken: token };
      return withWarning(context, [
        `Minted token ${info.id} (${info.label}, files: ${info.level}). It is shown once. Add this to chat.remoteAgentHosts in VS Code and enable chat.remoteAgentHostsEnabled:`,
        "",
        JSON.stringify(entry, null, 2),
        "",
        "Or, as a URL for any AHP client:",
        connectUrl(context.address(), token, scheme),
      ].join("\n"));
    }
    case "url": {
      const parsed = parseMint(words, "url");
      if (typeof parsed === "string") {
        return parsed;
      }
      const { token } = context.tokens.mint(parsed.label, parsed.level);
      const url = connectUrl(context.address(), token, context.scheme?.() ?? "ws");
      return withWarning(context, `${url}\n\n${qrText(url)}`);
    }
    case "list": {
      const rows = context.tokens.list();
      if (rows.length === 0) {
        return "No tokens. Mint one with: token mint <label>";
      }
      return rows
        .map((t) => `${t.id}  ${t.label}  files: ${t.level}  last used: ${t.lastUsedAt}  expires: ${t.expiresAt}`)
        .join("\n");
    }
    case "revoke": {
      const id = words[0];
      if (!id) {
        return `a token id is required\n${USAGE}`;
      }
      return context.tokens.revoke(id) ? `Revoked token ${id}; its connections were closed.` : `No token with id ${id}.`;
    }
    default:
      return USAGE;
  }
}
