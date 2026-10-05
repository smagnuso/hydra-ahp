# AGENTS.md

Brief for AI agents working in this repo.

## What this is

`hydra-ahp` (npm `@hydra-acp/ahp`) is an **extension** for Hydra that serves
the [Agent Host Protocol (AHP)](https://github.com/microsoft/agent-host-protocol)
so AHP clients can list, watch and drive Hydra sessions, live and shared with
Hydra's other clients. The main target is VS Code's agent UI; ahpc and the
official AHP SDK clients are secondary.

The repo and bin are named `hydra-ahp`, deliberately not `hydra-acp-ahp`
(which reads like a typo). The Hydra extension name is `ahp`, so slash
commands are `/hydra ahp <verb>`.

The design lives in `plan-ahp-extension.md` one directory up
(`~/dev/hydra-acp/`). Its Decisions table (D1 to D11) is settled.

Scope for v1: one AHP session is one Hydra session is one chat. No
terminals, changesets, automations, customizations or non-loopback access.

## How it fits into Hydra

Hydra is a multi-client ACP session daemon; wire docs are in
`../cli/PROTOCOL.md`. This extension serves AHP over WebSocket upstream and
is a Hydra client downstream: `/acp` with the per-process extension token in
`HYDRA_ACP_TOKEN`, plus REST `/v1/*`. v1 needs no daemon changes.

- Bind to loopback. Accept the AHP token as `?tkn=` (VS Code's browser
  transport cannot send headers) or `Authorization: Bearer`. Tokens come from
  this extension's own AHP-only registry, never Hydra's admin token.
- The only runtime protocol dependency is `@microsoft/agent-host-protocol`
  (types, reducers, version negotiation). ahpd is reference reading only;
  credit it in a comment wherever logic is ported.
- Federated sessions are first-class: ids stay `name:localId`.

## Layout

- `src/index.ts`: entry point (`hydra-ahp` bin)

Planned (see the plan, section 4): `server/` listener and auth, `rpc/` JSON-RPC
peer, `protocol/` negotiation, channel store and replay, `bridge/` session
mapping, `files/` resource commands, `hydra/` ACP and REST clients,
`store/` token registry and flags.

## Build & test

```
npm install
npm run build     # tsup → dist/
npm test          # vitest
npm run lint      # tsc --noEmit
```

Ships as `hydra-ahp` on PATH. Registered with Hydra under the name `ahp`
with command `hydra-ahp`.

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
- **`ahpUri` stamps live in Hydra `extension_state`**; read and archive flags
  live in this extension's own file keyed by session id, because
  `extension_state` probably cannot reach federated sessions.
- **Hydra hides never-prompted sessions** from default lists and GC removes
  cold non-interactive ones; `PATCH /v1/sessions/:id` bumps `updatedAt`.
- **`usage_update` is broadcast but never recorded** in Hydra history; attach
  a live observer to see it.

## Updating this file

If you discover a durable, non-obvious invariant while working here, the
kind of thing you wish had been in this file when you started: flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.
