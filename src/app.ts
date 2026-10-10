import { ProtocolCore } from "./protocol/core.js";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { applyDaemonListen, certExpiryNotice, certNames, fetchDaemonListen, isLoopbackHost, pickDisplayName, shadowedCertNotice } from "./hydra/daemon-listen.js";
import { AhpListener } from "./server/listener.js";
import { ChangesetService } from "./changesets/service.js";
import { FlagStore } from "./store/flags.js";
import { TerminalService } from "./terminals/service.js";
import { removeEndpoint, writeEndpoint } from "./store/endpoint.js";
import { ConfigStore } from "./store/configs.js";
import { ModelStore } from "./store/models.js";
import { TokenRegistry } from "./store/tokens.js";
import { FileService } from "./files/service.js";
import { Catalog } from "./bridge/catalog.js";
import { HydraBackend } from "./bridge/hydra-backend.js";
import { COMMAND_SPEC, COMMAND_VERB, isWildcardHost, runTokenCommand, WILDCARD_WARNING } from "./commands/tokens.js";
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

export function connectAddress(config: Config, port: number, certDnsNames: readonly string[] = []): string {
  const wildcard = isWildcardHost(config.host);
  const certName = isLoopbackHost(config.host) ? undefined : pickDisplayName(certDnsNames, hostname());
  const host = config.preferredHost ?? certName ?? (wildcard ? hostname() : config.host);
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export async function startApp(initial: Config, version: string): Promise<App> {
  const rest = new HydraRest(initial.daemonUrl, initial.token);
  const daemonListen = await fetchDaemonListen(rest);
  const config = applyDaemonListen(initial, daemonListen);
  setDebug(config.debug);
  const notice = shadowedCertNotice(config, daemonListen);
  if (notice) {
    log.info(notice);
  }
  const expiry = config.tls ? certExpiryNotice(config.tls.cert) : undefined;
  if (expiry) {
    log.warn(expiry);
  }
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
    onSessionTotals: (uri, totals) => catalog.noteChanges(uri, totals),
    onWorkdirs: (uri, directories) => catalog.noteWorkdirs(uri, directories),
  });
  const backend = new HydraBackend({ catalog, rest, extState, sessions, version, files, terminals, changesets, permissionDelayMs: config.permissionDelayMs });
  const core = new ProtocolCore({ backend, detachGraceMs: DETACH_GRACE_MS });
  await core.start();

  const names = config.tls ? certNames(config.tls.cert) : { dns: [], ips: [] };
  const listener = new AhpListener({
    core,
    tokens,
    port: config.port,
    host: config.host,
    allowedHosts: [...config.allowedHosts, ...(config.preferredHost ? [config.preferredHost] : []), ...names.dns, ...names.ips, "localhost", "127.0.0.1", "::1"],
    ...(config.tls ? { tls: { cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) } } : {}),
  });
  const port = await listener.listen();
  if (isWildcardHost(config.host)) {
    log.warn(WILDCARD_WARNING);
  }
  const scheme = config.tls ? "wss" : "ws";
  const address = (): string => connectAddress(config, port, names.dns);
  writeEndpoint(config.endpointPath, { address: address(), scheme, wildcard: isWildcardHost(config.host) });

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
    return { text: runTokenCommand({ tokens, address, scheme: () => scheme, ...(isWildcardHost(config.host) ? { warning: WILDCARD_WARNING } : {}) }, params.args ?? "") };
  });
  await client.request("hydra-acp/commands/register", { commands: [COMMAND_SPEC] });

  const refreshTimer = setInterval(() => {
    tokens.refresh();
  }, TOKEN_REFRESH_MS);
  refreshTimer.unref();

  log.info(`serving AHP on ${scheme}://${config.host}:${port} for Hydra ${config.daemonUrl}`);
  return {
    port,
    async stop() {
      stopping = true;
      clearInterval(refreshTimer);
      removeEndpoint(config.endpointPath);
      await listener.close();
      await backend.stop();
      client.close();
    },
  };
}
