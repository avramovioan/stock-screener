import { describe, expect, it } from "vitest";
import { isPrimaryModel, modelDisplayName } from "./model-names";

describe("modelDisplayName", () => {
  it("uses the table for the known models", () => {
    expect(modelDisplayName("gemini-3.5-flash")).toBe("Gemini 3.5 Flash");
    expect(modelDisplayName("mistral-large-latest")).toBe("Mistral Large");
    expect(modelDisplayName("openai/gpt-oss-120b")).toBe("GPT-OSS 120B");
  });
  it("title-cases an unknown id and drops -latest", () => {
    expect(modelDisplayName("mistral-large-2411")).toBe("Mistral Large 2411");
    expect(modelDisplayName("some-new-model-latest")).toBe("Some New Model");
    expect(modelDisplayName("gemini-4-ultra")).toBe("Gemini 4 Ultra");
  });
  it("is case-insensitive for the table", () => {
    expect(modelDisplayName("Gemini-3.5-Flash")).toBe("Gemini 3.5 Flash");
  });
});

describe("isPrimaryModel", () => {
  it("Gemini is the primary, anything else the backup", () => {
    expect(isPrimaryModel("gemini-3.5-flash")).toBe(true);
    expect(isPrimaryModel("mistral-large-latest")).toBe(false);
    expect(isPrimaryModel("openai/gpt-oss-120b")).toBe(false);
  });
});
