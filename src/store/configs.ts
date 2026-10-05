import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseConfigOptions, type ConfigOption } from "../bridge/config.js";

// Like model lists, an agent's config options only show up once a session of it exists, so the last set seen is kept per agent.
export class ConfigStore {
  private readonly configs = new Map<string, ConfigOption[]>();

  constructor(private readonly path: string) {
    this.load();
  }

  get(agentId: string): ConfigOption[] {
    return this.configs.get(agentId) ?? [];
  }

  // Returns whether the stored set changed; an empty set never replaces a known one.
  set(agentId: string, options: readonly ConfigOption[]): boolean {
    if (options.length === 0 || JSON.stringify(this.get(agentId)) === JSON.stringify(options)) {
      return false;
    }
    this.configs.set(agentId, [...options]);
    this.save();
    return true;
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [agentId, list] of Object.entries(parsed)) {
        const options = parseConfigOptions(list);
        if (options.length > 0) {
          this.configs.set(agentId, options);
        }
      }
    } catch {
      // A corrupt file only loses the cached option sets.
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.configs), null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
