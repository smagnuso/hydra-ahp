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

// Models have their own picker (AHP carries the model on each message), so the model is not a setting.
const OWN_PICKER_IDS = new Set(["model"]);

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

export function modelBoundOf(options: readonly ConfigOption[]): ConfigOption[] {
  return options.filter((option) => isModelBound(option.id));
}

// The settings a client can show: everything but the model and what rides with it, including Hydra's agent switch.
export function settingsOf(options: readonly ConfigOption[]): ConfigOption[] {
  return options.filter((option) => !OWN_PICKER_IDS.has(option.id) && !isModelBound(option.id));
}

// The configSchema of one model: its effort-like options, keyed by Hydra's option id.
export function toModelConfigSchema(options: readonly ConfigOption[]): ConfigSchema | undefined {
  const bound = modelBoundOf(options);
  if (bound.length === 0) {
    return undefined;
  }
  const properties: Record<string, Json> = {};
  for (const option of bound) {
    const described = option.options.some((choice) => choice.description !== undefined);
    properties[option.id] = {
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
  return Object.fromEntries(modelBoundOf(options).map((option) => [option.id, option.currentValue]));
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
