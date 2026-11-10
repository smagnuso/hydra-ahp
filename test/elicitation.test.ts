import { describe, expect, it } from "vitest";
import { contentFrom, planForm } from "../src/bridge/elicitation.js";
import type { Json } from "../src/bridge/turns.js";

function form(properties: Json, required: string[] = []): Json {
  return { mode: "form", message: "Q", requestedSchema: { type: "object", properties, required }, _meta: { "hydra-acp": { elicitationId: "e" } } };
}

function check(properties: Json, key: string, value: Json): ReturnType<typeof contentFrom> {
  const plan = planForm(form(properties), "e")!;
  return contentFrom(plan.fields, { [key]: { state: "submitted", value } });
}

describe("elicitation defaults and limits", () => {
  it("carries defaults and limits into the AHP questions", () => {
    const plan = planForm(
      form({
        t: { type: "string", default: "hi", minLength: 2, maxLength: 9, format: "email" },
        n: { type: "integer", default: 3, minimum: 1, maximum: 5 },
        b: { type: "boolean", default: true },
        s: { type: "string", default: "b", oneOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] },
        m: { type: "array", default: ["a"], minItems: 1, maxItems: 2, items: { enum: ["a", "b"] } },
      }),
      "e",
    )!;
    const [t, n, b, s, m] = plan.request.questions as Json[];
    expect(t).toMatchObject({ defaultValue: "hi", min: 2, max: 9, format: "email" });
    expect(n).toMatchObject({ defaultValue: 3, min: 1, max: 5 });
    expect(b).toMatchObject({ defaultValue: true });
    expect((s!.options as Json[]).map((o) => o.recommended)).toEqual([undefined, true]);
    expect(m).toMatchObject({ min: 1, max: 2 });
    expect((m!.options as Json[]).map((o) => o.recommended)).toEqual([true, undefined]);
  });

  it("enforces string length, pattern and format", () => {
    expect(check({ t: { type: "string", minLength: 3 } }, "t", { kind: "text", value: "ab" })).toHaveProperty("invalid");
    expect(check({ t: { type: "string", maxLength: 3 } }, "t", { kind: "text", value: "abcd" })).toHaveProperty("invalid");
    expect(check({ t: { type: "string", pattern: "^a+$" } }, "t", { kind: "text", value: "ab" })).toHaveProperty("invalid");
    expect(check({ t: { type: "string", pattern: "^a+$" } }, "t", { kind: "text", value: "aa" })).toHaveProperty("content");
    expect(check({ t: { type: "string", pattern: "(" } }, "t", { kind: "text", value: "x" })).toHaveProperty("content");
    expect(check({ t: { type: "string", pattern: "a".repeat(300) } }, "t", { kind: "text", value: "x" })).toHaveProperty("content");
    expect(check({ t: { type: "string", format: "email" } }, "t", { kind: "text", value: "nope" })).toHaveProperty("invalid");
    expect(check({ t: { type: "string", format: "email" } }, "t", { kind: "text", value: "a@b.co" })).toHaveProperty("content");
    expect(check({ t: { type: "string", format: "date" } }, "t", { kind: "text", value: "2026-02-30" })).toHaveProperty("invalid");
    expect(check({ t: { type: "string", format: "date" } }, "t", { kind: "text", value: "2026-02-28" })).toHaveProperty("content");
    expect(check({ t: { type: "string", format: "date-time" } }, "t", { kind: "text", value: "2026-02-28T10:00:00Z" })).toHaveProperty("content");
    expect(check({ t: { type: "string", format: "date-time" } }, "t", { kind: "text", value: "yesterday" })).toHaveProperty("invalid");
    expect(check({ t: { type: "string", format: "uri" } }, "t", { kind: "text", value: "not a uri" })).toHaveProperty("invalid");
    expect(check({ t: { type: "string", format: "whatever" } }, "t", { kind: "text", value: "x" })).toHaveProperty("content");
  });

  it("enforces number bounds and multi-select counts", () => {
    expect(check({ n: { type: "number", minimum: 2 } }, "n", { kind: "number", value: 1 })).toHaveProperty("invalid");
    expect(check({ n: { type: "number", maximum: 2 } }, "n", { kind: "number", value: 3 })).toHaveProperty("invalid");
    expect(check({ n: { type: "integer" } }, "n", { kind: "number", value: 1.5 })).toHaveProperty("invalid");
    expect(check({ n: { type: "number", minimum: 2, maximum: 4 } }, "n", { kind: "number", value: 3 })).toHaveProperty("content");
    const multi = { m: { type: "array", minItems: 2, maxItems: 2, items: { enum: ["a", "b", "c"] } } };
    expect(check(multi, "m", { kind: "selected-many", value: ["a"] })).toHaveProperty("invalid");
    expect(check(multi, "m", { kind: "selected-many", value: ["a", "b", "c"] })).toHaveProperty("invalid");
    expect(check(multi, "m", { kind: "selected-many", value: ["a", "b"] })).toHaveProperty("content");
  });
});
