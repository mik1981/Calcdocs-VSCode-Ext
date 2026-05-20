import { describe, expect, it } from "vitest";

import { findDocumentSymbolDefinitions } from "../../src/core/documentSymbols";

describe("document symbol definitions", () => {
  it("marks runtime assignments so they are not treated as duplicate definitions", () => {
    const text = [
      "int main() {",
      "  int result = 0;",
      "  switch (MODE) {",
      "    case 1:",
      "      result = 10;",
      "      break;",
      "    default:",
      "      result = 0;",
      "      break;",
      "  }",
      "  return result;",
      "}",
      "",
    ].join("\n");

    const definitions = findDocumentSymbolDefinitions(text, "result");
    expect(definitions.map((definition) => definition.parsed.expr)).toEqual([
      "0",
      "10",
      "0",
    ]);

    const duplicateDefinitionCandidates = definitions.filter(
      (definition) => !definition.isAssignment
    );

    expect(duplicateDefinitionCandidates).toHaveLength(1);
    expect(duplicateDefinitionCandidates[0]?.line).toBe(1);
  });

  it("accepts member/dereference assignments like TIM1->CR2 = TIM_CR2_MMS_0 | TIM_CR2_MMS_1;", () => {
    const text = "TIM1->CR2 = TIM_CR2_MMS_0 | TIM_CR2_MMS_1;\n";
    const definitions = findDocumentSymbolDefinitions(text, "TIM1->CR2");

    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.isAssignment).toBe(true);
    expect(definitions[0]?.parsed.name).toBe("TIM1->CR2");
    expect(definitions[0]?.parsed.expr).toBe("TIM_CR2_MMS_0 | TIM_CR2_MMS_1");
  });
});
