# hydra-ahp

Serve [Hydra](https://github.com/smagnuso/hydra-acp) sessions to Agent Host
Protocol (AHP) clients, mainly VS Code's agent UI. You can list, watch and
drive Hydra sessions from VS Code, live and shared with Hydra's other clients.
Runs as a Hydra extension: AHP over WebSocket upstream, Hydra's `/acp` and
`/v1/*` downstream.

One AHP session is one Hydra session is one chat.

## Install and register

```
npm install -g @hydra-acp/ahp
hydra-acp extension add ahp --command hydra-ahp
hydra-acp extension restart ahp
```

The extension name must be `ahp`: Hydra's slash commands are
`/hydra <extension name> <verb>`, so the name gives you `/hydra ahp token mint`.
The equivalent `config.json` entry:

```json
{
  "extensions": {
    "ahp": { "command": ["hydra-ahp"], "enabled": true }
  }
}
```

Logs: `hydra-acp extension log ahp -f`.

### Configuration

Set these in the `env` block of the `ahp` entry in `config.json`.

| Variable | Default | Meaning |
|---|---|---|
| `HYDRA_AHP_PORT` | `55590` | Loopback port the AHP listener binds |
| `HYDRA_AHP_TOKEN_IDLE_DAYS` | `90` | Days unused before a token expires |
| `HYDRA_AHP_DIR_ROOTS` | home directory | Roots the new-session folder picker may browse (path-delimiter separated) |
| `HYDRA_AHP_POLL_MS`, `HYDRA_AHP_WARM_POLL_MS` | built in | Catalog poll intervals |
| `HYDRA_AHP_LOG_LEVEL` | info | Set to `debug` for verbose logs |

## Connect VS Code

1. Enable the setting `chat.remoteAgentHostsEnabled`.
2. From any Hydra client, mint a token:

   ```
   /hydra ahp token mint vscode
   ```

   The reply is shown once and contains the complete settings entry:

   ```json
   {
     "address": "127.0.0.1:55590",
     "name": "vscode",
     "connectionToken": "..."
   }
   ```

3. Add that object to the `chat.remoteAgentHosts` array in VS Code's
   `settings.json`.

The same verbs exist as `hydra-ahp token ...` on the command line, and
`token list` and `token revoke <id>` manage existing tokens. These tokens do
not appear in `hydra auth list`. Tokens renew themselves on use, so the VS Code
setting never needs re-pasting unless the token sits unused for the idle window
or you revoke it.

### Getting a connection URL

`hydra-ahp url [label] [--files scoped|read|full]` mints a token and prints
the URL to paste into an AHP client, the same idea as `hydra-acp-browser url`.
Each call mints a new token, because only hashes are stored.

```
hydra-ahp url laptop
ws://127.0.0.1:55590?tkn=...
```

`token mint` prints the same URL under the settings entry, and
`/hydra ahp token url` works from any Hydra client.

The listener binds loopback only. Clients authenticate with `?tkn=<token>` or
`Authorization: Bearer <token>`, and WebSocket upgrades from web page origins
are refused.

### Token levels

`token mint <label> [--files scoped|read|full]` sets how much of the
filesystem the token can reach through AHP's `resource*` commands and `@` file
completions.

| Level | Reads | Writes | Use it for |
|---|---|---|---|
| `scoped` (default) | Inside the cwds of local sessions and files those sessions edited | none | Normal VS Code use |
| `read` | Anywhere you can read | none | A client that must browse outside your session folders |
| `full` | Anywhere | Write, delete, mkdir, move and copy anywhere | Only a client that needs to write; it bypasses Hydra's history and permission prompts, so a `full` token is effectively a shell as you |

The new-session folder picker lists directories only, under
`HYDRA_AHP_DIR_ROOTS`, at the `scoped` level. To change a token's level, mint a
new one and revoke the old one.

### Settings Sync caveat

VS Code stores `connectionToken` in plain text in `settings.json`. If Settings
Sync includes that file, the token is copied to your other machines and into
the sync service. Exclude `chat.remoteAgentHosts` from Settings Sync (Settings
Sync: Configure, then ignore the setting), and prefer `scoped` tokens. If a
token leaks, `token revoke <id>` closes its connections immediately.

## Behavior worth knowing

- **Never-prompted sessions are garbage collected.** A session you create in
  VS Code and never send a prompt to is hidden from Hydra's own session lists,
  and Hydra's background GC deletes it after 2 days cold (`sessionGcMaxAgeDays`).
  Send a prompt and it becomes a normal session. Sessions that have been
  prompted are not affected.
- **Daemon restarts.** The listener lives and dies with the extension process,
  so VS Code disconnects while the daemon restarts and reconnects to fresh
  snapshots once the extension is relaunched.
- **Idle sessions.** Hydra closes idle sessions after
  `daemon.sessionIdleTimeoutSeconds` regardless of attached observers; they
  reload on demand.
- **Protocol versions.** VS Code currently negotiates AHP 0.9.0. The extension
  also serves 1.0.0 and uses no newer-version behavior on an older negotiated
  version.

## Limits of v1

- No terminals, changesets, automations or customizations.
- No file watches (`createResourceWatch` returns `-32601` at every level).
- No elicitation (`chat/inputRequested`); Hydra has no counterpart.
- Loopback only; no TLS and no remote access.
- New sessions are created on the local Hydra only, not on federated remotes
  (existing federated sessions are listed and driven, ids stay `name:localId`).
- No multi-chat grouping: each Hydra session is its own AHP session.
- 1.0-only features (such as chat summaries in `SessionSummary`) wait until
  VS Code negotiates 1.0.0.

## Development

```
npm install
npm run build
npm test
npm run lint
```

Integration tests run against a scratch Hydra daemon in a temp directory and
never touch `~/.hydra-acp`.

## License

MIT
