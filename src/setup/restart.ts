import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { resolveSpawnTarget, type ResolveDeps } from "../util/windows-command.js";

export type SpawnSyncFn = (command: string, args: string[], options: SpawnSyncOptions) => Pick<SpawnSyncReturns<Buffer>, "status">;

export type RestartResult =
  | { kind: "restarted" }
  | { kind: "exited"; status: number | null }
  | { kind: "unquotable"; message: string };

export function restartExtension(
  name: string,
  spawn: SpawnSyncFn = spawnSync,
  deps: ResolveDeps = {},
): RestartResult {
  let target;
  try {
    target = resolveSpawnTarget("hydra-acp", ["extension", "restart", name], deps);
  } catch (err) {
    return { kind: "unquotable", message: (err as Error).message };
  }
  const result = spawn(target.command, target.args, { stdio: "inherit", shell: target.shell });
  return result.status === 0 ? { kind: "restarted" } : { kind: "exited", status: result.status };
}
