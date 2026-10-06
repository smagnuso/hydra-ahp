import { ProtocolCore } from "./protocol/core.js";
import { AhpListener } from "./server/listener.js";
import { ChangesetService } from "./changesets/service.js";
import { FlagStore } from "./store/flags.js";
import { TerminalService } from "./terminals/service.js";
import { ConfigStore } from "./store/configs.js";
import { ModelStore } from "./store/models.js";
import { TokenRegistry } from "./store/tokens.js";
import { FileService } from "./files/service.js";
import { Catalog } from "./bridge/catalog.js";
import { HydraBackend } from "./bridge/hydra-backend.js";
import { COMMAND_SPEC, COMMAND_VERB, runTokenCommand } from "./commands/tokens.js";
import type { Config } from "./config.js";
import { HydraClient } from "./hydra/client.js";
import { ExtensionState } from "./hydra/ext-state.js";
import { HydraRest } from "./hydra/rest.js";
import { HydraSessions } from "./hydra/sessions.js";
import { checkHydraVersion } from "./hydra/version.js";
import { ErrorCodes, RpcError } from "./rpc/peer.js";

// VS Code drops and retakes chat subscriptions in bursts; detaching on each would replay the chat's history every time.
const DETACH_GRACE_MS = 5_000;
import { logger, setDebug } from "./util/log.js";

const log = logger("app");

const TOKEN_REFRESH_MS = 5000;

export interface App {
  port: number;
  stop(): Promise<void>;
}

export async function discoverHydraVersion(rest: HydraRest): Promise<string | undefined> {
  try {
    return (await rest.system()).hydraVersion;
  } catch {
    return (await rest.health()).version;
  }
}

export async function startApp(config: Config, version: string): Promise<App> {
  setDebug(config.debug);
  const rest = new HydraRest(config.daemonUrl, config.token);
  checkHydraVersion(await discoverHydraVersion(rest));

  const client = await HydraClient.connect({
    wsUrl: config.wsUrl,
    token: config.token,
    clientInfo: { name: "hydra-ahp", version },
  });
  let stopping = false;
  client.onClose(() => {
    if (!stopping) {
      log.error("lost the connection to the Hydra daemon; exiting so it can restart the extension");
      process.exit(1);
    }
  });
  const tokens = new TokenRegistry({
    path: config.tokensPath,
    ...(config.idleMs !== undefined ? { idleMs: config.idleMs } : {}),
  });
  const extState = new ExtensionState(client);
  const catalog = new Catalog({
    rest,
    extState,
    flags: new FlagStore(config.flagsPath),
    models: new ModelStore(config.modelsPath),
    configs: new ConfigStore(config.configsPath),
    ...(config.pollMs !== undefined ? { pollMs: config.pollMs } : {}),
    ...(config.warmPollMs !== undefined ? { warmPollMs: config.warmPollMs } : {}),
    showImported: config.showImported,
    changesets: true,
  });
  const sessions = new HydraSessions(client, { name: "hydra-ahp", version });
  const files = new FileService({ sessions: catalog, dirRoots: config.dirRoots });
  const terminals = new TerminalService();
  const changesets = new ChangesetService({
    cwdOf: (uri) => catalog.localCwdOf(uri),
    membersOf: (uri) => catalog.membersOf(uri),
    startedAt: (uri) => catalog.startedAt(uri),
    editedPaths: async (id) => (await rest.sessionDiff(id)).map((file) => file.path),
  });
  const backend = new HydraBackend({ catalog, rest, extState, sessions, version, files, terminals, changesets, permissionDelayMs: config.permissionDelayMs });
  const core = new ProtocolCore({ backend, detachGraceMs: DETACH_GRACE_MS });
  await core.start();

  const listener = new AhpListener({ core, tokens, port: config.port });
  const port = await listener.listen();

  // The bridge advertises no fs capability; refuse any agent file request that arrives anyway.
  for (const method of ["fs/read_text_file", "fs/write_text_file"]) {
    client.peer.onRequest(method, () => {
      throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
    });
  }

  client.peer.onRequest("hydra-acp/commands/invoke", (raw) => {
    const params = (raw ?? {}) as { verb?: string; args?: string };
    if (params.verb !== COMMAND_VERB) {
      return {};
    }
    return { text: runTokenCommand({ tokens, address: () => `127.0.0.1:${port}` }, params.args ?? "") };
  });
  await client.request("hydra-acp/commands/register", { commands: [COMMAND_SPEC] });

  const refreshTimer = setInterval(() => {
    tokens.refresh();
  }, TOKEN_REFRESH_MS);
  refreshTimer.unref();

  log.info(`serving AHP on 127.0.0.1:${port} for Hydra ${config.daemonUrl}`);
  return {
    port,
    async stop() {
      stopping = true;
      clearInterval(refreshTimer);
      await listener.close();
      await backend.stop();
      client.close();
    },
  };
}
