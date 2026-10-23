# AGENTS.md

Brief for AI agents working in this repo.

## What this is

`hydra-ahp` (npm `@hydra-acp/ahp`) is an **extension** for Hydra that serves
the [Agent Host Protocol (AHP)](https://github.com/microsoft/agent-host-protocol)
so AHP clients can list, watch and drive Hydra sessions, live and shared with
Hydra's other clients. The main target is VS Code's agent UI; the official
AHP SDK clients are secondary.

The repo and bin are named `hydra-ahp`, deliberately not `hydra-acp-ahp`
(which reads like a typo). It registers with Hydra as `hydra-ahp`, and Hydra
elides the `hydra-` prefix, so slash commands are `/hydra ahp <verb>`.

The design lives in `plan-ahp-extension.md` one directory up
(`~/dev/hydra-acp/`). Its Decisions table (D1 to D11) is settled.

Scope for v1: an AHP session is a group of Hydra sessions, each one a chat;
a session nobody added chats to is a group of one. Hydra sessions share an AHP
session when `extension_state` stamps them with the same `ahpUri`. Terminals
are served to `full` tokens only. Changesets are session (agent-edited files
against the session's starting commit) and uncommitted (against `HEAD`), read
only. No automations, customizations or non-loopback access.

## How it fits into Hydra

Hydra is a multi-client ACP session daemon; wire docs are in
`../cli/PROTOCOL.md`. This extension serves AHP over WebSocket upstream and
is a Hydra client downstream: `/acp` with the per-process extension token in
`HYDRA_ACP_TOKEN`, plus REST `/v1/*`. v1 needs no daemon changes.

- Bind to loopback. Accept the AHP token as `?tkn=` (VS Code's browser
  transport cannot send headers) or `Authorization: Bearer`. Tokens come from
  this extension's own AHP-only registry, never Hydra's admin token.
- The only runtime protocol dependency is `@microsoft/agent-host-protocol`
  (types, reducers, version negotiation).
- Federated sessions are first-class: ids stay `name:localId`.

## Layout

- `src/index.ts`: entry point (`hydra-ahp` bin); `src/app.ts` wires everything
- `src/config.ts`: env and path config (`HYDRA_AHP_*`)
- `src/server/`: loopback listener, token and Origin checks
- `src/rpc/`: JSON-RPC peer
- `src/protocol/`: negotiation, channel store and replay ring, connection,
  dispatch validation and echo, fake backend for tests
- `src/bridge/`: catalog poller, session bridges, update mapping, turn
  tracking, prompt conversion, the backend tying them together
- `src/files/`: `resource*` commands, `@` completions and `createResourceWatch`
  (`watch.ts`, `glob.ts`), gated by token level
- `src/hydra/`: `/acp` client, REST client, `extension_state`, version check
- `src/store/`: token registry (`tokens.json`), read/archive flags of
  federated sessions (`flags.json`), per-agent model lists (`models.json`),
  config option sets (`configs.json`) and per-model effort option sets
  (`model-options.json`), all 0600 under `<hydra home>/extensions/ahp/`
- `src/terminals/`: `createTerminal` and terminal channels over node-pty
  (optional dependency)
- `src/changesets/`: the session and uncommitted changesets, from git plus
  Hydra's `/v1/sessions/:id/diff`, and per-turn changesets from the `fileEdit`
  results in the chat state
- `src/commands/`: the `/hydra ahp token ...` verbs
- `scripts/record-host.mjs`: frame-logging stub host for recon
- `test/`: unit tests plus `test/integration/` against scratch daemons

## Build & test

```
npm install
npm run build     # tsup → dist/
npm test          # vitest
npm run lint      # tsc --noEmit
```

Ships as `hydra-ahp` on PATH. Registered with Hydra as `hydra-ahp`; Hydra
elides the `hydra-` prefix, so slash commands are `/hydra ahp <verb>`.

## Conventions

- TypeScript, ESM, tsup (`bundle: false`, target node20), vitest, npm with
  `package-lock.json` (no pnpm lockfile).
- Never touch the real `~/.hydra-acp` or daemon in tests; use a scratch daemon
  with `HYDRA_ACP_HOME` and its own port.
- Every attach needs a matching explicit detach; a raw WebSocket close does
  not trigger Hydra's reaping path.
- `.npmrc` is a symlink to `../.npmrc` (npm reads it only next to the nearest
  `package.json`).

## Seeing VS Code's UI (headless)

To check what VS Code actually draws, run a second Insiders instance on a
virtual display with its own profile; it never touches the user's windows.

1. Mint a throwaway token: `hydra ahp token mint ui-probe --files scoped`
   (the secret is printed once; revoke it afterwards with `token revoke <id>`).
   A scoped token makes `createTerminal` fail with `-32601`, which shows as a
   toast and is expected.
2. In `<tmp>/user/User/settings.json` set `chat.remoteAgentHosts` to
   `[{ "address": "wss://<host:port>", "name": "ahp-probe", "connectionToken": "<token>" }]`,
   taking `<host:port>` from `<hydra home>/extensions/ahp/endpoint.json` (the
   listener may be bound to the tailnet address only, so not `127.0.0.1`).
3. Launch the Electron binary directly, in the background:
   `xvfb-run -a -s "-screen 0 1600x1000x24" /usr/share/code-insiders/code-insiders --user-data-dir <tmp>/user --extensions-dir <tmp>/ext --remote-debugging-port=9333 --no-sandbox --disable-gpu --disable-updates --agents`.
   Do not use the `code-insiders` CLI wrapper: it spawns the app detached and
   exits, so `xvfb-run` tears the display down.
4. Drive it over the Chrome DevTools Protocol (`GET http://127.0.0.1:9333/json/list`,
   then the page's `webSocketDebuggerUrl`): `Page.captureScreenshot`,
   `Input.dispatchMouseEvent`, `Input.insertText`, `Runtime.evaluate`. The
   `ws` package in `node_modules` is enough; no Playwright needed. Cancel the
   folder-trust dialog that appears.
5. Clean up: kill the scratch processes by PID (the user's own `--agents`
   instance has no `--user-data-dir`; never `pkill -f` a pattern that is in
   your own command line), revoke the token, delete `<tmp>` (screenshots
   hold session titles).

In the Agents window a session's remaining settings (any option that is not
the model, agent, mode or an effort) are small text chips in the row under the
prompt (`.chat-secondary-generic-chips`, a responsive container); a model's
effort and mode are one chip beside the model name. In a clean profile they show on a fresh
open, after an extension restart, with the experimental composer layout
(`sessions.chat.unifiedWorkspacePicker.enabled` and
`sessions.chat.experimental.newSessionComposerLayout` both true) and in a wide
pane; a window that lacks them (it also lacked VS Code's own "Agent" pill)
differs in client state, not in what the extension sends.

Without any UI, VS Code writes every AHP frame it sends and receives to
`~/.config/Code - Insiders/logs/<run>/ahp/*.jsonl`; that is often enough to
tell whether a problem is the server's data or the client's drawing. The
client code is minified under `/usr/share/code-insiders/resources/app/out/vs/`
(`workbench/workbench.desktop.main.js`, `sessions/sessions.desktop.main.js`);
read it with a small script, not `grep -o` with long contexts.

## Gotchas

- **Permission races**: Hydra broadcasts permission requests to every
  attached client and the first response wins. Answering `-32601` is
  abstention; any other answer settles the race for everyone. Never answer a
  request this client is not entitled to answer.
- **Negotiate with the official helper**: VS Code offers no 1.0.0, so a
  conformant host lands on 0.9.0. Must work at 0.9.0 and also serve 1.0.0,
  and must not use newer-version behavior on an older negotiated version.
- **`ahpUri` stamps and read/archive marks live in Hydra `extension_state`**,
  which cannot reach federated sessions; their marks go in `flags.json`. The
  bucket is named after the extension's registration name (`hydra-ahp`), so
  registering it under another name orphans every stamp and mark.
- **Hydra hides never-prompted sessions** from default lists and GC removes
  cold non-interactive ones; `PATCH /v1/sessions/:id` bumps `updatedAt`.
- **`usage_update` is broadcast but never recorded** in Hydra history; attach
  a live observer to see it.
- **Hydra idle-closes sessions with attached observers**: a watched,
  never-prompted session can be GC'd while subscribed; the bridge disposes
  the chat and clients get `root/sessionRemoved`.
- **`connection.ts` re-validates client actions after the backend accepts**:
  slow decide work can get a client's own action rejected if state moves
  underneath (this is why `turnCancelled` is accepted at once and
  `session/cancel` runs afterwards as a followUp on the write chain).
- **Cancel is asynchronous**: Hydra is not idle right after a cancel; tests
  must poll. `session/cancel` is skipped if a new turn became active during
  the permission settle wait.
- **Steering chip removal is deferred** (`setImmediate`): the injected or
  detached reply can arrive before the client's `pendingMessageSet` lands.
- **Daemon restart**: the extension exits on losing Hydra and the new daemon
  relaunches it; the wall-clock `serverSeq` base forces snapshots over
  replay. There is no in-process reconnect.
- **Token levels gate `resource*` and terminals**: `full` (default),
  `read`, `scoped`. Levels are not a security boundary against a hostile
  client: any token can prompt an agent and approve its permission requests.
  They only limit direct access; `createResourceWatch` follows the same read
  scope as `resourceRead` (never the directory-only picker roots), and
  `createTerminal` is `-32601` below `full`. Orphaned terminals die after a
  30 s grace.
- **VS Code session URIs must use the agent id as scheme**
  (`<agent>:/<hydraId>`): VS Code picks the content provider by scheme, and
  any other scheme ("No harness descriptor found") gives empty transcripts.
  `providerSessionUri` falls back to `ahp-session:/` only for ids that are
  not valid schemes. Switching agent moves the session to a new URI.
- **VS Code derives the default chat URI** as
  `ahp-chat://default/<base64url(sessionUri)>` and never asks for it; the
  catalog must use exactly that (`defaultChatUri`).
- **Session config schema cannot change live**: `session/configChanged`
  merges values only, so the schema is fixed when the session channel is
  built (after attach, from live `configOptions` or the per-agent cache).
  Properties are `acp.<optionId>`. `model` (own picker), `agent` (chosen when
  a chat is created, each agent being its own session type) and the
  effort-like options (below) are not settings. VS Code's Agents window draws
  any string-enum property marked `sessionMutable` as a chip, for running
  sessions too.
- **Effort-like options and the mode ride on the model**: they are each
  model's `configSchema` in the root list, not session settings. VS Code's
  model picker has two slots and only reads these keys: `tier`, `autoTier`,
  `thinkingLevel`, `reasoningEffort` for the first, `contextSize` and
  `contextTier` for the second; any other key is ignored. Effort takes the
  first slot and the mode (`mode` option) the second, as `contextTier`, so
  the chip reads like "Default Build" and the popup has an "Effort" and a
  "Session Mode" section. `modelConfigKey` maps Hydra's option ids onto the
  keys, a prompt's `model.config` maps back (applied before the prompt, like
  the model), and `model-options.json` remembers each model's choices (unseen
  models use the agent's last set). A window that draws no chips for session
  settings still draws this. VS Code keeps the value per model and may show its
  own "resets the prompt cache" note on it.
- **Agents are labelled "Hydra · <name>"** in the picker so the chat
  placeholder still starts with Hydra. VS Code reads a session's agent from
  its URI scheme and builds the backend URI as `<provider>:/<id>` itself, so
  when another client switches a session's agent the catalog moves its stamp
  to the new scheme (`followAgents`).
- **Hydra's own notices open an orphan turn**: an agent-switch notice arrives
  as a bare agent message outside any turn, the mapper opens an `orphan-`
  turn for it and Hydra never ends it, so the bridge closes it once Hydra is
  idle (`armOrphanSettle`); otherwise the chat spins and the next prompt
  becomes a steer.
- **Resource watches skip heavy trees and share OS watchers**: VS Code asks
  for recursive watches of the workspace and of nested folders at once, with
  only `.git/objects` style excludes. `node_modules`, `.git`, `.hg` and `.svn`
  are always excluded, one OS watcher serves every watch covering a
  directory (cap 8192), and `.git` is never reported. The machine's inotify
  budget is shared with every other process; "Unable to watch for file
  changes" in VS Code usually means that limit, not this extension.
- **Turn changesets come from the chat state**: `<session>/changeset/turn/{turnId}`
  is built from the turn's `fileEdit` results, so it only exists while a chat
  holds that turn; VS Code asks for turns of chats it is not showing, which
  answer an error and are retried with a backoff.
- **New permission requests are held** (`HYDRA_AHP_PERMISSION_DELAY_MS`,
  default 500 ms) so one an auto-approver answers is never shown.
- **Steers split turns**: AHP has no user message mid-turn, so a steer ends
  the running turn and opens one carrying it (`ChatMapper.steer`), which
  remembers Hydra's turn id (`activeOriginId`) so Hydra's end events still
  close it. Hydra does not echo an injected steer to its sender, so the bridge
  splits its own on the `injected` reply, at once: deferring it lets the
  agent's answer land in the old turn. A split waits while a confirmation is
  pending in the turn.
- **VS Code's model picker follows the turns**: it restores a chat's model
  from `message.model` and sends it with every prompt, so turns are stamped
  with the session's current model; an unstamped chat makes VS Code switch the
  session to whatever it last used. A new session takes the first listed
  model, so the agent's default is listed first.
- **Unwatched chats detach after a grace** (5 s, `detachGraceMs`): VS Code
  drops and retakes chat subscriptions in bursts, and each reattach would
  replay history. Session channels still detach at once; an unwatched one goes
  stale and must be rebuilt.
- **Session Changes needs `createdAt` on Hydra's session rows** (added to the
  daemon alongside it); without it there is no base commit and every edited
  file reads as new.
- **Done lets a session go cold**: setting `isArchived` kills (`POST
  /v1/sessions/:id/kill`) the chat's Hydra session when it is live and idle,
  even with other clients attached (any of them can warm it again); a busy
  session keeps running.
- **Done marks carry `archivedAt`**: a turn starting after it, from any
  client, clears the mark so the session reappears. The catalog checks
  `turnStartedAt` on every poll and an attached bridge checks the turns it
  maps; resuming or viewing a session leaves it done. Marks from before the
  timestamp have none, so any later turn clears them.
- **Edit content is in memory only**: transcript `fileEdit` before/after
  bodies are registered as `<chat>/edit/...` URIs while a chat is mapped
  (`EditContentStore`, 32 MB, oldest out). After a restart they exist again
  once the chat is replayed; a read before that is not found.
- **Tool titles change after the call opens**: agents open a call with a
  placeholder ("Preparing file…") and name it in later updates, so the
  mapper refreshes `displayName` on every update. A confirmation carries the
  pending edits (`edits` on `toolCallReady`) so VS Code shows the diff before
  approval. opencode titles a call with just its tool ("grep", "read") and
  sends the pattern and path only in a later update, so `describeCall` builds
  the row's message from `rawInput` and `locations` (for example
  ``grep `foo` in `.../bridge` ``); a title that already says more is kept.
- **opencode's `apply_patch` has no diff blocks**: each file's unified diff
  is in `rawOutput.metadata.files[]`, unfolded by `src/bridge/patch.ts` into
  hunk-only before and after text (a copy of the daemon's and the browser's
  `parseUnifiedPatch`).
- **Hydra snapshots extension config at boot**: changing an extension's
  `env` needs `extension remove` + `add --env` then `start` (or a daemon
  restart); `extension restart` keeps the old env.

## Updating this file

If you discover a durable, non-obvious invariant while working here, the
kind of thing you wish had been in this file when you started: flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.
