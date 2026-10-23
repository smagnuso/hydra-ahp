import { afterEach, describe, expect, it } from "vitest";
import type { ConfigStore } from "../src/store/configs.js";
import type { SessionState } from "@microsoft/agent-host-protocol";
import { isModelBound, modelConfigKey, optionIdOf, optionOfModelKey, parseConfigOptions, propertyId, settingsOf, toConfigState, toModelConfigSchema } from "../src/bridge/config.js";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";
import { sessionOf } from "./support/chat-uri.js";

const effort = {
  id: "tone",
  name: "Effort",
  type: "select",
  currentValue: "high",
  options: [
    { value: "low", name: "Low" },
    { value: "high", name: "High", description: "Slow" },
  ],
};

describe("parseConfigOptions", () => {
  it("reads select options and flattens grouped ones", () => {
    const parsed = parseConfigOptions([
      effort,
      { id: "style", name: "Style", currentValue: "dry", options: [{ group: "g", name: "G", options: [{ value: "dry" }, { value: "wet", name: "Wet" }] }] },
    ]);
    expect(parsed.map((option) => option.id)).toEqual(["tone", "style"]);
    expect(parsed[1]?.options).toEqual([{ value: "dry", name: "dry" }, { value: "wet", name: "Wet" }]);
  });

  it("drops entries it cannot show", () => {
    expect(parseConfigOptions([{ id: "x" }, { id: "y", currentValue: "a", options: [] }, "nope", null])).toEqual([]);
    expect(parseConfigOptions(undefined)).toEqual([]);
  });
});

describe("toConfigState", () => {
  it("namespaces the ids and describes each option as a mutable string setting", () => {
    const state = toConfigState(parseConfigOptions([effort]));
    expect(state?.values).toEqual({ "acp.tone": "high" });
    expect(state?.schema.properties["acp.tone"]).toEqual({
      type: "string",
      title: "Effort",
      enum: ["low", "high"],
      enumLabels: ["Low", "High"],
      enumDescriptions: ["", "Slow"],
      default: "high",
      sessionMutable: true,
    });
  });

  it("leaves out the model and the agent, and is absent when nothing is left", () => {
    const model = { ...effort, id: "model" };
    const agent = { ...effort, id: "agent" };
    expect(toConfigState(parseConfigOptions([model, agent]))).toBeUndefined();
    expect(Object.keys(toConfigState(parseConfigOptions([model, agent, effort]))?.schema.properties ?? {})).toEqual(["acp.tone"]);
  });

  it("maps property ids back to Hydra's option ids", () => {
    expect(optionIdOf(propertyId("tone"))).toBe("tone");
    expect(optionIdOf("mode")).toBeUndefined();
  });
});

describe("cached session config", () => {
  let harness: BridgeHarness | undefined;

  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
  });

  it("seeds from the per-agent cache and forwards later config option updates", async () => {
    const sessionUri = sessionOf("claude-1", "claude-personal");
    const cached = parseConfigOptions([
      { id: "mode", name: "Session Mode", currentValue: "default", options: [{ value: "default" }, { value: "plan" }] },
      { id: "agent", name: "Agent", currentValue: "claude-personal", options: [{ value: "claude-personal" }] },
      { ...effort, currentValue: "low" },
    ]);
    const configs = {
      get: (agentId: string) => agentId === "claude-personal" ? cached : [],
      set: () => false,
    } as unknown as ConfigStore;
    harness = await startBridgeHarness((hydra) => {
      hydra.rows = [ROW({ sessionId: "claude-1", agentId: "claude-personal" })];
    }, { configs });

    const session = await harness.connect();
    await session.client.initialize({ clientId: "c1", protocolVersions: ["0.9.0"] });
    await session.client.subscribe(sessionUri);
    const state = (): SessionState => harness?.core.store.state(sessionUri) as SessionState;
    expect(state().config?.values).toEqual({ "acp.tone": "low" });

    harness.hydra.listener?.update({
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [
          { id: "mode", name: "Session Mode", currentValue: "plan", options: [{ value: "default" }, { value: "plan" }] },
          { id: "agent", name: "Agent", currentValue: "claude-personal", options: [{ value: "claude-personal" }] },
          { ...effort, currentValue: "high" },
        ],
      },
    });
    expect(state().config?.values).toEqual({ "acp.tone": "high" });
  });
});

describe("model-bound options", () => {
  const options = parseConfigOptions([
    { id: "model", name: "Model", currentValue: "a", options: [{ value: "a" }] },
    { id: "mode", name: "Mode", currentValue: "build", options: [{ value: "build" }] },
    { id: "reasoning_effort", name: "Reasoning", currentValue: "low", options: [{ value: "low" }, { value: "high", name: "High" }] },
    { id: "thought_level", name: "Thought", currentValue: "off", options: [{ value: "off" }] },
  ]);

  it("names each option by the key VS Code's model picker understands", () => {
    expect(modelConfigKey("effort")).toBe("reasoningEffort");
    expect(modelConfigKey("reasoning_effort")).toBe("reasoningEffort");
    expect(modelConfigKey("thought_level")).toBe("thinkingLevel");
    expect(optionOfModelKey(options, "thinkingLevel")?.id).toBe("thought_level");
    expect(modelConfigKey("mode")).toBe("contextTier");
    expect(optionOfModelKey(options, "contextTier")?.id).toBe("mode");
    expect(optionOfModelKey(options, "effort")).toBeUndefined();
  });

  it("recognises effort-like ids", () => {
    expect(["effort", "thought_level", "reasoning_effort", "thinking"].every(isModelBound)).toBe(true);
    expect(["mode", "agent", "model", "fast-mode"].some(isModelBound)).toBe(false);
  });

  it("keeps them out of the session's settings and puts them on the model's schema", () => {
    expect(settingsOf(options)).toEqual([]);
    const schema = toModelConfigSchema(options) as { properties: Record<string, { enum: string[]; default: string }> };
    expect(Object.keys(schema.properties).sort()).toEqual(["contextTier", "reasoningEffort", "thinkingLevel"]);
    expect(schema.properties.contextTier).toMatchObject({ enum: ["build"], default: "build" });
    expect(schema.properties.reasoningEffort).toMatchObject({ enum: ["low", "high"], default: "low" });
    expect(toModelConfigSchema(parseConfigOptions([{ id: "tone", name: "Tone", currentValue: "dry", options: [{ value: "dry" }] }]))).toBeUndefined();
  });
});
