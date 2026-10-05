# hydra-ahp

Serves [hydra-acp](https://github.com/smagnuso/hydra-acp) sessions over the
[Agent Host Protocol](https://github.com/microsoft/agent-host-protocol) (AHP), so
VS Code's agent UI can list, watch and drive them. Runs as a hydra extension on
localhost: VS Code connects to it like any remote agent host, and every session
stays live and shared with hydra's other clients (the TUI, the browser, Slack).
Start a turn in the TUI and watch it stream in VS Code, answer its permission
prompt from either side, or start a new session in VS Code and pick it up later
from the terminal.

VS Code authenticates with a token this extension mints for it and Hydra's own
tokens never leave the daemon.

## Install

hydra-ahp is a client of the hydra daemon, so install both:

```sh
npm install -g @hydra-acp/cli @hydra-acp/ahp
```

This drops the `hydra-acp` (and `hydra`) CLI plus a `hydra-ahp` binary on your
PATH. If you have never run hydra before, its
[README](https://github.com/smagnuso/hydra-acp#running-it) covers the daemon; it
starts itself the first time anything needs it, or `hydra-acp daemon start`
brings it up ahead of time.

Register hydra-ahp as an extension:

```sh
hydra-acp extensions add hydra-ahp
```

`extensions add` is config-only. Either restart the daemon, or, if it is
already running, start the extension:

```sh
hydra-acp extensions start hydra-ahp
```

Slash commands for an extension are `/hydra <name> <verb>`, and hydra drops a
`hydra-` prefix, so this registration gives you `/hydra ahp token ...` in any
hydra client and `hydra-acp ahp ...` on the command line (both need a recent
hydra; on an older one register the extension as `ahp` with
`--command hydra-ahp` instead). The listener is on `127.0.0.1:55590`.

Logs: `hydra-acp extensions log hydra-ahp -f`.

### Choosing an agent

hydra-ahp is not a coding agent. Every session it shows is a real agent that
the hydra daemon runs, so which agents you can use, and how they log in, is
hydra's business: see
[Choosing an agent](https://github.com/smagnuso/hydra-acp#choosing-an-agent).
In short:

```sh
hydra-acp agent list          # what exists, and what you already have installed
hydra-acp agent set claude    # your default, then: hydra-acp daemon restart
```

VS Code lists every agent the daemon knows as a provider, and you pick one when
you start a session there. Agents download on first use. An agent's model list
fills in once a session of it has run on this host (hydra only learns models
from a live session), and the same goes for its settings (see
[Settings](#settings)).

## Connect VS Code

You need a recent VS Code (Insiders 1.141 or later) with the agent host
features on. `chat.remoteAgentHostsEnabled` is on by default.

Mint a token and get its URL:

```sh
hydra-ahp url vscode
```

```
ws://127.0.0.1:55590?tkn=...
```

The token is shown once (only its hash is stored), so each call mints a new
one. Then, in either window:

- **Agents window** (`code-insiders --agents`, or **Open Agents Window**):
  run **Add Remote Agent Host...** from the command palette, paste the URL and
  give the host a name.
- **Editor window**: add an entry to `chat.remoteAgentHosts` in `settings.json`
  and reload. `hydra-ahp token mint vscode` prints the entry ready to paste:

  ```json
  "chat.remoteAgentHosts": [
    { "address": "127.0.0.1:55590", "name": "vscode", "connectionToken": "..." }
  ]
  ```

Your hydra sessions then appear in VS Code's session list under the hydra
host. Sessions show once they have had a real prompt; hydra hides
never-prompted ones from every client.

The same verbs work from any hydra client as `/hydra ahp token ...`.
`token list` shows the tokens, and `token revoke <id>` revokes one and closes
its connections at once. VS Code keeps reconnecting with the token it connected with,
so after swapping the token in its settings, reload the window (or remove and
add the host again). Tokens renew themselves on use, so you only re-paste
after 90 idle days or a revoke. They do not appear in `hydra-acp auth list`.

### Token levels

Every token can drive sessions, which means prompting agents and answering
their permission requests, so any token can get a command run as you. The level
only limits what a client can do directly, without going through an agent:

| Level | Reads | Writes | Use it for |
|---|---|---|---|
| `full` (default) | Anywhere | Anywhere, plus [terminals](#terminals) | VS Code, with terminals and file edits |
| `read` | Anywhere you can read | none | A client that should not write or get a shell |
| `scoped` | Inside the cwds of local sessions and files those sessions edited | none | The tightest file access |

Pass `--files read` or `--files scoped` to `url` or `token mint` to mint a
lower level. Direct access skips hydra's history and permission prompts, which
is the difference `full` makes. At the `scoped` level the new-session folder
picker lists directories only, under `HYDRA_AHP_DIR_ROOTS`. To change a token's
level, mint a new one and revoke the old one.

### Settings Sync

VS Code keeps `connectionToken` in plain text in `settings.json`. If Settings
Sync includes that file, the token travels to your other machines and the sync
service. Exclude `chat.remoteAgentHosts` from Settings Sync (Settings Sync:
Configure, then ignore the setting).

## Using it

### Sessions and chats

An AHP session is a group of hydra sessions, each one a chat. A session nobody
added chats to is a group of one. Creating a chat in VS Code adds a hydra
session to the group; a fork copies the source chat's history up to a turn, and
a side chat gets that history as context but shows only its own turns. Deleting
a chat deletes its hydra session, and deleting the session deletes them all.

A session lives at `<agent>:/<hydra session id>`, because VS Code picks the
content provider by the URI's scheme.

A message sent while the agent is working steers the running turn. AHP has no
place for a message in the middle of a turn, so, as VS Code's own host does, the
running turn ends there and the steering message opens a new one. Steers sent
from the TUI or another client show up the same way.

Marking a chat read or done sticks: local sessions keep the mark in their own
hydra `extension_state` (so it goes away with the session), federated sessions
in this extension's `flags.json`. Hydra itself has no notion of done, so marking
a chat done also lets its agent stop: if the hydra session is idle, it goes
cold, keeping its record, and any client (the TUI, the browser) can resume it.
A busy session keeps running. A new prompt after that, from any client, clears
the done mark so the session shows up in VS Code again; just resuming or
viewing it does not. Pins are VS Code's own and never reach hydra.

### Settings

Every option the underlying agent advertises through hydra (effort, fast mode,
session mode, and so on) appears as a picker under the chat input, along with
hydra's own agent switch. The model has its own picker. Changing a setting goes
through hydra to the agent, and the picker then shows what the agent reports
(an agent may adjust other settings in response).

VS Code takes a chat's model from its turns and sends it with every prompt, so
hydra-ahp stamps the session's current model on its turns; otherwise VS Code
would fall back to the model it last used for that agent and switch the session
to it. For a new session VS Code picks the first model listed, so each agent's
default (hydra's `sessionDefaults`, through `extends`) is listed first.

Switching the agent moves the session to the new agent's URI, so VS Code shows
it removed and listed again under the new agent. A session's settings come from
attaching to it, so a cold session shows none until it has been opened live.

### Permissions

Hydra sends every permission request to all attached clients and the first
answer wins. A new request is held for half a second before VS Code sees it, so
one an auto-approver (such as
[hydra-acp-approver](https://github.com/smagnuso/hydra-acp-approver)) answers
never flashes up.

### Terminals

VS Code's Agents window opens a terminal for each session. For a `full` token,
hydra-ahp starts your `$SHELL` in the session's directory on this machine; a
terminal whose client stays away for 30 seconds is killed. `read` and `scoped`
tokens are refused, which VS Code reports as an error each time it opens a
session.
Terminals need `node-pty`, an optional dependency; without it they are
unavailable.

### Changes

The Changes tab shows two changesets for each local session whose working
directory is in a git repository:

- **Session Changes**: the files the agent edited in this session, as hydra
  aggregates them from its tool calls, each compared whole with the commit the
  branch was at when the session was created. Commits made since do not hide
  them. Your own edits to those files show too, and files changed only by shell
  commands do not.
- **Uncommitted Changes**: everything in the repository that differs from
  `HEAD`, staged, unstaged or untracked; a commit clears it.

Both refresh every couple of seconds while watched. They only read the
repository: there are no review checkboxes and no commit or discard buttons.
Federated and remote sessions get none, since their files are elsewhere. Session
Changes needs a hydra that reports when each session was created; on an older
one every edited file shows as new.

## How it works

```
   hydra REST        +-------------+   AHP over WebSocket
   /v1/sessions <--- |             | <--------------------> VS Code
                     |  hydra-ahp  |   127.0.0.1:55590
   hydra WSS    <--> |             |
   /acp              +-------------+
                           |
                 ~/.hydra-acp/extensions/ahp/
                   tokens.json flags.json models.json configs.json
```

hydra-ahp is a hydra client downstream: it lists sessions over REST and
attaches to each session VS Code opens over `/acp`, mapping ACP updates to AHP
chat actions through the official AHP reducers. Upstream it is an AHP host:
version negotiation, subscriptions with replay, and client actions validated
before they reach hydra. The agents' model lists and option sets, and the read
and done marks of federated sessions, are kept in its own files under
`~/.hydra-acp/extensions/ahp/`, all mode 0600; everything else it records lives
in each session's hydra `extension_state`.

## Configuration keys

Set these in the `env` block of the extension's entry in
`~/.hydra-acp/config.json` (hydra reads that block at startup):

```json
"hydra-ahp": { "env": { "HYDRA_AHP_LOG_LEVEL": "debug" } }
```

| Key | Default | Notes |
|---|---|---|
| `HYDRA_AHP_PORT` | `55590` | Loopback port the listener binds. |
| `HYDRA_AHP_TOKEN_IDLE_DAYS` | `90` | Days unused before a token expires. |
| `HYDRA_AHP_DIR_ROOTS` | home directory | Roots the new-session folder picker may browse (path-delimiter separated). |
| `HYDRA_AHP_PERMISSION_DELAY_MS` | `500` | How long a new permission request is held before clients see it; `0` shows them at once. |
| `HYDRA_AHP_POLL_MS`, `HYDRA_AHP_WARM_POLL_MS` | built in | Session list poll intervals. |
| `HYDRA_AHP_LOG_LEVEL` | info | `debug` logs one line per frame (method, channel, action type, never payloads). |

## Security

- **Loopback only.** The listener binds `127.0.0.1`; there is no TLS and no
  remote access.
- **Own tokens.** Clients authenticate with `?tkn=<token>` (VS Code's browser
  transport cannot send headers) or `Authorization: Bearer <token>`. Tokens
  come from this extension's own registry, stored as hashes; hydra's admin
  token is never used or exposed.
- **No web pages.** WebSocket upgrades from web page origins are refused.
- **Token levels gate files and terminals.** See [Token levels](#token-levels).
  File watches (`createResourceWatch`) are refused at every level.
- **Permission races.** hydra-ahp never answers a permission request on a
  client's behalf; with no AHP client asked, it abstains and leaves the request
  to hydra's other clients.

## Behavior worth knowing

- **Daemon restarts.** The listener lives and dies with the extension, so VS
  Code disconnects while the daemon restarts and reconnects to fresh state once
  the extension is back.
- **Idle and unused sessions.** Hydra closes idle sessions after
  `daemon.sessionIdleTimeoutSeconds` (they reload on demand) and garbage
  collects sessions that never had a prompt after 2 days cold.
- **Protocol versions.** VS Code currently negotiates AHP 0.9.0. hydra-ahp also
  serves 1.0.0 and uses no newer-version behavior on an older negotiated
  version.

## Building from source

```sh
git clone https://github.com/smagnuso/hydra-ahp.git ~/dev/hydra-ahp
cd ~/dev/hydra-ahp
npm install
npm run build
```

Point the extension at the build instead of the npm binary:

```sh
hydra-acp extensions add hydra-ahp \
  --command node \
  --args ~/dev/hydra-ahp/dist/index.js
```

After a rebuild, `restart` (not `start`) is the right call:

```sh
hydra-acp extensions restart hydra-ahp
```

Hydra starts the extension with `HYDRA_ACP_DAEMON_URL`, `HYDRA_ACP_TOKEN` and
`HYDRA_ACP_WS_URL` set; it does not run on its own.

## Tests

```sh
npm test
npm run lint
```

Integration tests run against a scratch hydra daemon in a temp directory, with
a fake agent, and never touch `~/.hydra-acp`.

## Status

Experimental. Covers session listing, live transcripts, prompting, steering,
queued messages, cancel, permissions, settings and model pickers, read and
archive marks, several chats per session (forks and side chats), file reads and
`@` completions, terminals, and session and uncommitted changesets. Out of
scope: per-turn and branch changesets, changeset review and operations,
automations, customizations, file watches, elicitation (`chat/inputRequested`,
which hydra has no counterpart for), moving chats between sessions, and creating
sessions on federated remotes (existing federated sessions are listed and
driven).

## License

MIT.
