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
- `src/files/`: `resource*` commands and `@` completions, gated by token level
- `src/hydra/`: `/acp` client, REST client, `extension_state`, version check
- `src/store/`: token registry (`tokens.json`), read/archive flags of
  federated sessions (`flags.json`), per-agent model lists (`models.json`) and config option
  sets (`configs.json`), all 0600 under `<hydra home>/extensions/ahp/`
- `src/terminals/`: `createTerminal` and terminal channels over node-pty
  (optional dependency)
- `src/changesets/`: the session and uncommitted changesets, from git plus
  Hydra's `/v1/sessions/:id/diff`
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
  They only limit direct access; `createResourceWatch` is `-32601` at every level and
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
  Properties are `acp.<optionId>`; `model` is excluded (own picker), Hydra's
  `agent` option is included.
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
- **Edit content is in memory only**: transcript `fileEdit` before/after
  bodies are registered as `<chat>/edit/...` URIs while a chat is mapped
  (`EditContentStore`, 32 MB, oldest out). After a restart they exist again
  once the chat is replayed; a read before that is not found.
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
