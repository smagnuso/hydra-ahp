import type { ConfigSchema, SessionConfigState } from "@microsoft/agent-host-protocol";
import { bag, text, type Json } from "./turns.js";

export interface ConfigChoice {
  value: string;
  name: string;
  description?: string;
}

// One entry of the ACP configOptions Hydra exposes: its own agent selector plus whatever the underlying agent advertises.
export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  currentValue: string;
  options: ConfigChoice[];
}

// Models have their own picker (AHP carries the model on each message), and an agent is chosen when a chat is
// created (each agent is its own session type), so neither is a setting.
const OWN_PICKER_IDS = new Set(["model", "agent"]);

// Namespaced so Hydra's and the agents' ids never collide with the properties VS Code gives meaning to (mode, autoApprove, ...).
const PROPERTY_PREFIX = "acp.";

export function propertyId(optionId: string): string {
  return `${PROPERTY_PREFIX}${optionId}`;
}

export function optionIdOf(property: string): string | undefined {
  return property.startsWith(PROPERTY_PREFIX) ? property.slice(PROPERTY_PREFIX.length) : undefined;
}

function choicesOf(raw: unknown): ConfigChoice[] {
  const out: ConfigChoice[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = bag(item);
    if (Array.isArray(entry.options)) {
      out.push(...choicesOf(entry.options));
      continue;
    }
    const value = text(entry.value);
    if (value === undefined) {
      continue;
    }
    const description = text(entry.description);
    out.push({ value, name: text(entry.name) ?? value, ...(description ? { description } : {}) });
  }
  return out;
}

export function parseConfigOptions(raw: unknown): ConfigOption[] {
  const out: ConfigOption[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = bag(item);
    const id = text(entry.id);
    const currentValue = text(entry.currentValue);
    const options = choicesOf(entry.options);
    if (id === undefined || currentValue === undefined || options.length === 0) {
      continue;
    }
    const description = text(entry.description);
    out.push({ id, name: text(entry.name) ?? id, ...(description ? { description } : {}), currentValue, options });
  }
  return out;
}

// Effort-like options change their choices with the model, and a session's settings schema is fixed once built,
// so they travel with the model instead (AHP's per-model configSchema, answered through the message's model.config).
const MODEL_BOUND = /effort|thought|reasoning|thinking/i;

export function isModelBound(optionId: string): boolean {
  return MODEL_BOUND.test(optionId);
}

// The session mode rides with the model too: a window that draws no chips for session settings still draws the model's.
function isCarried(optionId: string): boolean {
  return isModelBound(optionId) || optionId === "mode";
}

export function modelBoundOf(options: readonly ConfigOption[]): ConfigOption[] {
  return options.filter((option) => isCarried(option.id));
}

// VS Code's model picker has two slots for a model's options and only reads these keys: tier, thinking and effort for the
// first, the context keys for the second. The mode takes the second slot; any other key is left out of the menu.
export function modelConfigKey(optionId: string): string {
  if (optionId === "mode") {
    return "contextTier";
  }
  return /thought|thinking/i.test(optionId) ? "thinkingLevel" : "reasoningEffort";
}

// The model-bound options by the key they travel under; when two share a key, the first wins.
function byModelKey(options: readonly ConfigOption[]): Map<string, ConfigOption> {
  const keyed = new Map<string, ConfigOption>();
  for (const option of modelBoundOf(options)) {
    const key = modelConfigKey(option.id);
    if (!keyed.has(key)) {
      keyed.set(key, option);
    }
  }
  return keyed;
}

// The Hydra option a model.config key from a client stands for.
export function optionOfModelKey(options: readonly ConfigOption[], key: string): ConfigOption | undefined {
  return byModelKey(options).get(key);
}

// The settings a client can show: everything but the model, the agent and what rides with the model.
export function settingsOf(options: readonly ConfigOption[]): ConfigOption[] {
  return options.filter((option) => !OWN_PICKER_IDS.has(option.id) && !isCarried(option.id));
}

// The configSchema of one model: its effort-like options and the mode, under the keys VS Code's model picker knows.
export function toModelConfigSchema(options: readonly ConfigOption[]): ConfigSchema | undefined {
  const bound = byModelKey(options);
  if (bound.size === 0) {
    return undefined;
  }
  const properties: Record<string, Json> = {};
  for (const [key, option] of bound) {
    const described = option.options.some((choice) => choice.description !== undefined);
    properties[key] = {
      type: "string",
      title: option.name,
      ...(option.description ? { description: option.description } : {}),
      enum: option.options.map((choice) => choice.value),
      enumLabels: option.options.map((choice) => choice.name),
      ...(described ? { enumDescriptions: option.options.map((choice) => choice.description ?? "") } : {}),
      default: option.currentValue,
    };
  }
  return { type: "object", properties } as unknown as ConfigSchema;
}

// What a message's model.config carries for a session: the current value of each effort-like option.
export function modelConfigOf(options: readonly ConfigOption[]): Record<string, string> {
  return Object.fromEntries([...byModelKey(options)].map(([key, option]) => [key, option.currentValue]));
}

export function toConfigState(options: readonly ConfigOption[]): SessionConfigState | undefined {
  const settings = settingsOf(options);
  if (settings.length === 0) {
    return undefined;
  }
  const properties: Record<string, Json> = {};
  const values: Record<string, unknown> = {};
  for (const option of settings) {
    const described = option.options.some((choice) => choice.description !== undefined);
    properties[propertyId(option.id)] = {
      type: "string",
      title: option.name,
      ...(option.description ? { description: option.description } : {}),
      enum: option.options.map((choice) => choice.value),
      enumLabels: option.options.map((choice) => choice.name),
      ...(described ? { enumDescriptions: option.options.map((choice) => choice.description ?? "") } : {}),
      default: option.currentValue,
      sessionMutable: true,
    };
    values[propertyId(option.id)] = option.currentValue;
  }
  return { schema: { type: "object", properties }, values } as unknown as SessionConfigState;
}

export function valuesOf(options: readonly ConfigOption[]): Record<string, unknown> {
  return toConfigState(options)?.values ?? {};
}
