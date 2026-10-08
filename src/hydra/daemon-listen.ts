import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Config } from "../config.js";
import type { HydraRest } from "./rest.js";

export interface DaemonListen {
  host: string;
  port: number;
  publicHost?: string;
  tls?: { cert: string; key: string };
}

const EXPIRY_WARN_DAYS = 14;

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "[::1]";
}

// Undefined on any failure, including a daemon that predates the field: the caller then keeps its own settings.
export async function fetchDaemonListen(rest: HydraRest): Promise<DaemonListen | undefined> {
  try {
    const body = await rest.request<{ listen?: DaemonListen }>("GET", "/v1/config");
    if (!body?.listen || typeof body.listen.host !== "string") {
      return undefined;
    }
    return body.listen;
  } catch {
    return undefined;
  }
}

// Same rules as hydra-acp-browser: explicit settings win, and the daemon's host is only taken together with its cert.
export function applyDaemonListen(config: Config, listen: DaemonListen | undefined): Config {
  if (!listen?.tls || config.tls) {
    return config;
  }
  const next: Config = { ...config, tls: { ...listen.tls } };
  if (!config.hostExplicit && !isLoopbackHost(listen.host)) {
    next.host = listen.host;
  }
  if (!config.preferredHost && listen.publicHost) {
    next.preferredHost = listen.publicHost;
  }
  return next;
}

export function shadowedCertNotice(config: Config, listen: DaemonListen | undefined): string | undefined {
  if (!config.tls || !listen?.tls || config.tls.cert === listen.tls.cert) {
    return undefined;
  }
  return `serving with HYDRA_AHP_TLS_CERT (${config.tls.cert}); the daemon has its own (${listen.tls.cert}). Unset HYDRA_AHP_TLS_CERT and HYDRA_AHP_TLS_KEY to use the daemon's.`;
}

export function certExpiryNotice(certPath: string, now: Date = new Date()): string | undefined {
  let validTo: Date;
  try {
    validTo = new Date(new X509Certificate(readFileSync(certPath)).validTo);
  } catch {
    return undefined;
  }
  const days = Math.floor((validTo.getTime() - now.getTime()) / 86_400_000);
  if (days >= EXPIRY_WARN_DAYS) {
    return undefined;
  }
  return days < 0 ? `TLS cert ${certPath} expired ${-days} day(s) ago` : `TLS cert ${certPath} expires in ${days} day(s)`;
}
