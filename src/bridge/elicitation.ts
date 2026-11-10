import { HYDRA_META, bag, type Json } from "./turns.js";

type Kind = "text" | "number" | "integer" | "boolean" | "single-select" | "multi-select";

// One ACP form field and the AHP question it became.
export interface Field {
  key: string;
  kind: Kind;
  optionIds: string[];
  // The sibling text field that carries free-form input for a select, when the agent offered one.
  customKey?: string;
  required: boolean;
}

export interface FormPlan {
  request: Json;
  fields: Field[];
}

const CUSTOM_SUFFIX = "_custom";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionsOf(list: unknown): Json[] | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  const out: Json[] = [];
  for (const entry of list) {
    const id = str(bag(entry).const);
    if (!id) {
      return undefined;
    }
    const description = str(bag(entry).description);
    out.push({ id, label: str(bag(entry).title) ?? id, ...(description ? { description } : {}) });
  }
  return out;
}

function stringOptions(prop: Json): Json[] | undefined {
  if (Array.isArray(prop.oneOf)) {
    return optionsOf(prop.oneOf);
  }
  if (Array.isArray(prop.enum) && prop.enum.every((value) => typeof value === "string")) {
    const names = Array.isArray(prop.enumNames) ? prop.enumNames : [];
    return (prop.enum as string[]).map((id, index) => ({ id, label: str(names[index]) ?? id }));
  }
  return undefined;
}

function multiOptions(prop: Json): Json[] | undefined {
  const items = bag(prop.items);
  if (Array.isArray(items.anyOf)) {
    return optionsOf(items.anyOf);
  }
  if (Array.isArray(items.enum) && items.enum.every((value) => typeof value === "string")) {
    return (items.enum as string[]).map((id) => ({ id, label: id }));
  }
  return undefined;
}

function isFreeText(prop: Json | undefined): boolean {
  return prop !== undefined && prop.type === "string" && stringOptions(prop) === undefined;
}

// Turns an elicitation/create form into an AHP input request, or undefined when AHP has no way to ask it.
export function planForm(params: Json, requestId: string): FormPlan | undefined {
  if (params.mode !== undefined && params.mode !== "form") {
    return undefined;
  }
  const schema = bag(params.requestedSchema);
  const props = bag(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);
  const keys = Object.keys(props);
  if (keys.length === 0) {
    return undefined;
  }
  const folded = new Set<string>();
  for (const key of keys) {
    const prop = bag(props[key]);
    const custom = `${key}${CUSTOM_SUFFIX}`;
    const selects = prop.type === "array" ? multiOptions(prop) !== undefined : stringOptions(prop) !== undefined;
    if (selects && isFreeText(props[custom] as Json | undefined)) {
      folded.add(custom);
    }
  }
  const message = str(params.message);
  const standalone = keys.filter((key) => !folded.has(key));
  const questions: Json[] = [];
  const fields: Field[] = [];
  for (const key of standalone) {
    const prop = bag(props[key]);
    const custom = `${key}${CUSTOM_SUFFIX}`;
    const customKey = folded.has(custom) ? custom : undefined;
    const title = str(prop.title);
    const base: Json = {
      id: key,
      ...(title ? { title } : {}),
      message: str(prop.description) ?? (standalone.length === 1 ? message : undefined) ?? title ?? key,
      ...(required.has(key) || (customKey && required.has(customKey)) ? { required: true } : {}),
    };
    const field = (kind: Kind, optionIds: string[] = []): Field => ({
      key,
      kind,
      optionIds,
      ...(customKey ? { customKey } : {}),
      required: required.has(key) || (customKey !== undefined && required.has(customKey)),
    });
    if (prop.type === "array") {
      const options = multiOptions(prop);
      if (!options) {
        return undefined;
      }
      const min = num(prop.minItems);
      const max = num(prop.maxItems);
      questions.push({
        ...base,
        kind: "multi-select",
        options,
        ...(customKey ? { allowFreeformInput: true } : {}),
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
      });
      fields.push(field("multi-select", options.map((option) => option.id as string)));
    } else if (prop.type === "string") {
      const options = stringOptions(prop);
      if (options) {
        questions.push({ ...base, kind: "single-select", options, ...(customKey ? { allowFreeformInput: true } : {}) });
        fields.push(field("single-select", options.map((option) => option.id as string)));
      } else {
        const min = num(prop.minLength);
        const max = num(prop.maxLength);
        questions.push({
          ...base,
          kind: "text",
          ...(str(prop.format) ? { format: prop.format } : {}),
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
          ...(typeof prop.default === "string" ? { defaultValue: prop.default } : {}),
        });
        fields.push(field("text"));
      }
    } else if (prop.type === "number" || prop.type === "integer") {
      const min = num(prop.minimum);
      const max = num(prop.maximum);
      questions.push({
        ...base,
        kind: prop.type,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(num(prop.default) !== undefined ? { defaultValue: prop.default } : {}),
      });
      fields.push(field(prop.type));
    } else if (prop.type === "boolean") {
      questions.push({ ...base, kind: "boolean", ...(typeof prop.default === "boolean" ? { defaultValue: prop.default } : {}) });
      fields.push(field("boolean"));
    } else {
      return undefined;
    }
  }
  return {
    request: { id: requestId, ...(message && standalone.length !== 1 ? { message } : {}), questions },
    fields,
  };
}

export function elicitationIdOf(params: Json): string | undefined {
  return str(bag(bag(params._meta)[HYDRA_META]).elicitationId);
}

type Content = Record<string, string | number | boolean | string[]>;

// Folds AHP answers back into the ACP form content; a string is the name of a required field left unanswered.
export function contentFrom(fields: Field[], answers: Json): { content: Content } | { missing: string } {
  const content: Content = {};
  for (const field of fields) {
    const answer = bag(answers[field.key]);
    const answered = answer.state === "draft" || answer.state === "submitted" ? bag(answer.value) : undefined;
    const freeform = (Array.isArray(answered?.freeformValues) ? answered.freeformValues : Array.isArray(answer.freeformValues) ? answer.freeformValues : [])
      .filter((entry: unknown): entry is string => typeof entry === "string" && entry !== "");
    if (answered) {
      const value = answered.value;
      if (field.kind === "multi-select" && Array.isArray(value)) {
        const picked = value.filter((entry): entry is string => typeof entry === "string" && field.optionIds.includes(entry));
        if (picked.length > 0) {
          content[field.key] = picked;
        }
      } else if (field.kind === "single-select" && typeof value === "string" && field.optionIds.includes(value)) {
        content[field.key] = value;
      } else if (field.kind === "text" && typeof value === "string") {
        content[field.key] = value;
      } else if ((field.kind === "number" || field.kind === "integer") && typeof value === "number") {
        content[field.key] = value;
      } else if (field.kind === "boolean" && typeof value === "boolean") {
        content[field.key] = value;
      }
    }
    if (field.customKey && freeform.length > 0) {
      content[field.customKey] = freeform.join(", ");
    }
    if (field.required && content[field.key] === undefined && (!field.customKey || content[field.customKey] === undefined)) {
      return { missing: field.key };
    }
  }
  return { content };
}

export function actionOf(response: unknown): "accept" | "decline" | "cancel" {
  return response === "accept" || response === "decline" ? response : "cancel";
}
