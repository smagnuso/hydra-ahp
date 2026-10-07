import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface KnownModel {
  id: string;
  name: string;
  // Whether the agent takes images with this model; ACP reports it per agent, so all of an agent's models agree.
  vision?: boolean;
}

// Hydra only learns an agent's models once a session of it exists, so the lists seen so far are kept per agent.
export class ModelStore {
  private readonly models = new Map<string, KnownModel[]>();

  constructor(private readonly path: string) {
    this.load();
  }

  get(agentId: string): KnownModel[] {
    return this.models.get(agentId) ?? [];
  }

  // Returns whether the stored list changed; an empty list never replaces a known one.
  set(agentId: string, models: readonly KnownModel[]): boolean {
    if (models.length === 0 || JSON.stringify(this.get(agentId)) === JSON.stringify(models)) {
      return false;
    }
    this.models.set(agentId, [...models]);
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
      const parsed = JSON.parse(raw) as Record<string, Array<{ id?: unknown; name?: unknown; vision?: unknown }>>;
      for (const [agentId, list] of Object.entries(parsed)) {
        const models = (Array.isArray(list) ? list : []).flatMap((item) =>
          typeof item.id === "string"
            ? [
                {
                  id: item.id,
                  name: typeof item.name === "string" ? item.name : item.id,
                  ...(typeof item.vision === "boolean" ? { vision: item.vision } : {}),
                },
              ]
            : [],
        );
        if (models.length > 0) {
          this.models.set(agentId, models);
        }
      }
    } catch {
      // A corrupt file only loses the cached model lists.
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.models), null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
