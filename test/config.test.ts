import { afterEach, describe, expect, it } from "vitest";
import type { ConfigStore } from "../src/store/configs.js";
import type { SessionState } from "@microsoft/agent-host-protocol";
import { optionIdOf, parseConfigOptions, propertyId, toConfigState } from "../src/bridge/config.js";
import { ROW, startBridgeHarness, type BridgeHarness } from "./support/bridge-harness.js";
import { sessionOf } from "./support/chat-uri.js";

const effort = {
  id: "effort",
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
      { id: "tone", name: "Tone", currentValue: "dry", options: [{ group: "g", name: "G", options: [{ value: "dry" }, { value: "wet", name: "Wet" }] }] },
    ]);
    expect(parsed.map((option) => option.id)).toEqual(["effort", "tone"]);
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
    expect(state?.values).toEqual({ "acp.effort": "high" });
    expect(state?.schema.properties["acp.effort"]).toEqual({
      type: "string",
      title: "Effort",
      enum: ["low", "high"],
      enumLabels: ["Low", "High"],
      enumDescriptions: ["", "Slow"],
      default: "high",
      sessionMutable: true,
    });
  });

  it("leaves out the model, keeps Hydra's agent switch, and is absent when nothing is left", () => {
    const model = { ...effort, id: "model" };
    const agent = { ...effort, id: "agent" };
    expect(toConfigState(parseConfigOptions([model]))).toBeUndefined();
    expect(Object.keys(toConfigState(parseConfigOptions([model, agent, effort]))?.schema.properties ?? {})).toEqual(["acp.agent", "acp.effort"]);
  });

  it("maps property ids back to Hydra's option ids", () => {
    expect(optionIdOf(propertyId("effort"))).toBe("effort");
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
    expect(state().config?.values).toEqual({ "acp.mode": "default", "acp.agent": "claude-personal", "acp.effort": "low" });

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
    expect(state().config?.values).toEqual({ "acp.mode": "plan", "acp.agent": "claude-personal", "acp.effort": "high" });
  });
});
