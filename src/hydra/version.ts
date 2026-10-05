// 0.1.198 is the first release with createdAt on session rows (the session
// changeset's base commit), patch tools in the session diff, and hydra-<name>
// prefix elision (the /hydra ahp verbs).
export const MIN_HYDRA_VERSION = "0.1.198";

export function parseVersion(text: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    throw new Error(`cannot compare versions ${a} and ${b}`);
  }
  for (let i = 0; i < 3; i += 1) {
    const delta = (left[i] as number) - (right[i] as number);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

export function checkHydraVersion(actual: string | undefined, minimum = MIN_HYDRA_VERSION): void {
  if (!actual || !parseVersion(actual)) {
    throw new Error(
      `hydra-ahp could not determine the Hydra daemon version (got ${JSON.stringify(actual)}); it needs Hydra ${minimum} or newer`,
    );
  }
  if (compareVersions(actual, minimum) < 0) {
    throw new Error(
      `hydra-ahp needs Hydra ${minimum} or newer (session list createdAt, the hydra- prefix for its commands); the daemon is ${actual}. Upgrade Hydra and restart.`,
    );
  }
}
