import { describe, expect, it } from "vitest";
import { optionIdOf, parseConfigOptions, propertyId, toConfigState } from "../src/bridge/config.js";

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
