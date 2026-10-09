import { afterEach, describe, expect, it } from "vitest";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";
import { sleep } from "./support/harness.js";
import { sessionOf } from "./support/chat-uri.js";
import { cwdToUri } from "../src/bridge/ids.js";

const SESSION = sessionOf("h1");
const SOURCE = "/tmp/proj";
const WORKSPACE = "/tmp/workspaces/ab12/feature";

type Held = { workingDirectories?: string[]; project?: { uri: string; displayName: string } };

describe("a session in a workspace", () => {
  let harness: BridgeHarness;

  afterEach(async () => {
    await harness.stop();
  });

  it("works in the workspace and groups under the tree it came from", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd: WORKSPACE, workspace: { path: WORKSPACE, sourceCwd: SOURCE, label: "feature" } })];
    });
    const summary = harness.catalog.summaryFor(SESSION) as Held | undefined;
    expect(summary?.workingDirectories).toEqual([cwdToUri(WORKSPACE)]);
    expect(summary?.project).toEqual({ uri: cwdToUri(SOURCE), displayName: "proj" });
  });

  it("follows the session into a workspace and back out", async () => {
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ cwd: SOURCE })];
    });
    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(SESSION);
    const held = () => harness.core.store.state(SESSION) as Held;
    expect(held().workingDirectories).toEqual([cwdToUri(SOURCE)]);

    harness.hydra.rows = [ROW({ cwd: WORKSPACE, workspace: { path: WORKSPACE, sourceCwd: SOURCE } })];
    await sleep(200);
    expect(held().workingDirectories).toEqual([cwdToUri(WORKSPACE)]);
    expect(harness.catalog.summaryFor(SESSION)?.project).toEqual({ uri: cwdToUri(SOURCE), displayName: "proj" });

    harness.hydra.rows = [ROW({ cwd: SOURCE })];
    await sleep(200);
    expect(held().workingDirectories).toEqual([cwdToUri(SOURCE)]);
  });
});
