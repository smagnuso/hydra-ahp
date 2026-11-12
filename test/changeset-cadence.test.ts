import { afterEach, describe, expect, it } from "vitest";
import { ChangesetService } from "../src/changesets/service.js";
import type { ProtocolCore } from "../src/protocol/core.js";

const SESSION = "fake:/h1";
const CHANGESET = `${SESSION}/changeset/session`;
const OTHER = "fake:/h2";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Just enough of the core for the service to publish into.
const fakeCore = {
  createChannel: () => undefined,
  publish: () => undefined,
  removeChannel: () => undefined,
  store: { state: () => undefined },
} as unknown as ProtocolCore;

interface Rig {
  service: ChangesetService;
  refreshes: () => number;
  edits: () => number;
  busy: { value: boolean };
}

let services: ChangesetService[] = [];

function rig(options: { idlePollMs?: number; busy?: boolean; withBusy?: boolean } = {}): Rig {
  const busy = { value: options.busy ?? false };
  let refreshes = 0;
  let edits = 0;
  const service = new ChangesetService({
    cwdOf: (uri) => (uri === SESSION ? "/work/one" : uri === OTHER ? "/work/two" : undefined),
    membersOf: () => ["h1"],
    sessionEdits: async () => {
      edits += 1;
      return [];
    },
    onWorkdirs: () => {
      refreshes += 1;
    },
    pollMs: 20,
    idlePollMs: options.idlePollMs ?? 2000,
    // Long, so only an explicit nudge re-reads the edits.
    editsEveryMs: 60_000,
    ...(options.withBusy === false ? {} : { isBusy: () => busy.value }),
  });
  service.start(fakeCore);
  services.push(service);
  return { service, refreshes: () => refreshes, edits: () => edits, busy };
}

afterEach(() => {
  for (const service of services) {
    service.stop();
  }
  services = [];
});

describe("changeset cadence", () => {
  it("polls at the fast rate while the session is busy", async () => {
    const r = rig({ busy: true });
    r.service.attach(CHANGESET);
    await sleep(200);
    expect(r.refreshes()).toBeGreaterThanOrEqual(4);
  });

  it("backs off to the idle rate when the session is not busy", async () => {
    const r = rig({ busy: false });
    r.service.attach(CHANGESET);
    await sleep(200);
    expect(r.refreshes()).toBeLessThanOrEqual(2);
  });

  it("keeps the old fast rate when it is not told whether the session is busy", async () => {
    const r = rig({ withBusy: false });
    r.service.attach(CHANGESET);
    await sleep(200);
    expect(r.refreshes()).toBeGreaterThanOrEqual(4);
  });

  it("a nudge refreshes an idle session soon, and a burst costs one refresh", async () => {
    const r = rig({ busy: false });
    r.service.attach(CHANGESET);
    await sleep(60);
    const before = r.refreshes();
    r.service.nudge(SESSION);
    r.service.nudge(SESSION);
    r.service.nudge(SESSION);
    await sleep(450);
    expect(r.refreshes() - before).toBe(1);
  });

  it("a turn boundary nudges and re-reads the recorded edits", async () => {
    const r = rig({ busy: true });
    r.service.attach(CHANGESET);
    r.service.checkBusy();
    await sleep(60);
    const editsBefore = r.edits();
    r.busy.value = false;
    r.service.checkBusy();
    await sleep(450);
    expect(r.edits()).toBeGreaterThan(editsBefore);
  });

  it("a file change nudges only the sessions whose directory contains it", async () => {
    const r = rig({ busy: false });
    r.service.attach(CHANGESET);
    r.service.attach(`${OTHER}/changeset/session`);
    await sleep(60);
    const before = r.refreshes();
    r.service.nudgePath("/work/one/src/a.ts");
    await sleep(450);
    // Only the first session refreshed: one refresh, not two.
    expect(r.refreshes() - before).toBe(1);

    const mid = r.refreshes();
    r.service.nudgePath("/elsewhere/file.ts");
    r.service.nudgePath("/work/onefoo/file.ts");
    await sleep(450);
    expect(r.refreshes() - mid).toBe(0);
  });
});
