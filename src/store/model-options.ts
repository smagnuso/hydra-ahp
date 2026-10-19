import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseConfigOptions, type ConfigOption } from "../bridge/config.js";

// The effort-like options an agent offered while a given model was selected; their choices differ by model.
export class ModelOptionStore {
  private readonly options = new Map<string, Map<string, ConfigOption[]>>();

  constructor(private readonly path: string) {
    this.load();
  }

  get(agentId: string, modelId: string): ConfigOption[] | undefined {
    return this.options.get(agentId)?.get(modelId);
  }

  // Returns whether the stored set changed; an empty set never replaces a known one.
  set(agentId: string, modelId: string, options: readonly ConfigOption[]): boolean {
    if (options.length === 0 || JSON.stringify(this.get(agentId, modelId)) === JSON.stringify(options)) {
      return false;
    }
    const models = this.options.get(agentId) ?? new Map<string, ConfigOption[]>();
    models.set(modelId, [...options]);
    this.options.set(agentId, models);
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
      const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      for (const [agentId, models] of Object.entries(parsed)) {
        for (const [modelId, list] of Object.entries(models)) {
          const options = parseConfigOptions(list);
          if (options.length > 0) {
            const held = this.options.get(agentId) ?? new Map<string, ConfigOption[]>();
            held.set(modelId, options);
            this.options.set(agentId, held);
          }
        }
      }
    } catch {
      // A corrupt file only loses the cached option sets.
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    const out = Object.fromEntries([...this.options].map(([agentId, models]) => [agentId, Object.fromEntries(models)]));
    writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
