import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { buildCompositeExpressionPreview } from "../../src/core/expression";

/**
 * Copre il bug originale di questa conversazione: BITWISE_OP_DETECT_RX
 * usava la classe di caratteri [&|^~], che intercetta anche i caratteri
 * SINGOLI '&' e '|' dentro '&&'/'||' — trattando quindi QUALUNQUE
 * espressione con AND/OR logico come "bitwise", bloccando il
 * constant-folding (simplifyNumericFragments) e sbagliando il
 * numericFormat (hex invece di boolean).
 *
 * Caso reale che ha innescato la scoperta:
 *   z1 = fT_to_Timer(10.0);                              -> ghost: 40 (corretto)
 *   if (... && (EvPTOTimer >= fT_to_Timer(10.0))) { ... } -> ghost: ((uint8)((10.0)/(0.25)))  (BUG: non ridotto)
 */

function makeFunctionDefines() {
  const functionDefines = new Map();
  functionDefines.set("fT_to_Timer", { params: ["t"], body: "((uint8)((t) / (0.25)))" });
  return functionDefines;
}

describe("expression.ts — bitwise regex regression (&&/|| non sono bitwise)", () => {
  it("un'espressione con && continua a ridurre una function-macro interna a un numero", () => {
    const symbolValues = new Map<string, number>();
    const allDefines = new Map<string, string>();
    allDefines.set("N_EVPTORETRY_MAX", "5");
    const functionDefines = makeFunctionDefines();

    const result = buildCompositeExpressionPreview(
      "(EvPTORetry < N_EVPTORETRY_MAX) && (EvPTOTimer >= fT_to_Timer(10.0))",
      symbolValues,
      allDefines,
      functionDefines
    );

    // fT_to_Timer(10.0) DEVE ridursi a 40 anche se il resto della
    // condizione (EvPTORetry/EvPTOTimer, variabili runtime) resta
    // simbolico e l'espressione totale non è interamente valutabile.
    assert.match(
      result.expanded,
      /\b40\b/,
      `atteso che "40" compaia nell'espressione ridotta, ottenuto: "${result.expanded}"`
    );
    assert.doesNotMatch(
      result.expanded,
      /10\.0\s*\/\s*0\.25/,
      "la divisione grezza non deve più comparire non ridotta"
    );
  });

  it("un'espressione con && viene classificata come 'boolean', non 'hex'", () => {
    const symbolValues = new Map<string, number>();
    const allDefines = new Map<string, string>();
    const functionDefines = makeFunctionDefines();

    const result = buildCompositeExpressionPreview(
      "(a < 5) && (b >= 3)",
      symbolValues,
      allDefines,
      functionDefines
    );

    assert.equal(result.numericFormat, "boolean");
  });

  it("un'espressione con || si comporta come quella con &&", () => {
    const symbolValues = new Map<string, number>();
    const allDefines = new Map<string, string>();
    const functionDefines = makeFunctionDefines();

    const result = buildCompositeExpressionPreview(
      "(a < 5) || fT_to_Timer(10.0)",
      symbolValues,
      allDefines,
      functionDefines
    );

    assert.match(result.expanded, /\b40\b/);
    assert.equal(result.numericFormat, "boolean");
  });

  it("l'espressione isolata (senza &&/||) continua a valutarsi a un numero pieno", () => {
    const symbolValues = new Map<string, number>();
    const allDefines = new Map<string, string>();
    const functionDefines = makeFunctionDefines();

    const result = buildCompositeExpressionPreview(
      "fT_to_Timer(10.0)",
      symbolValues,
      allDefines,
      functionDefines
    );

    assert.equal(result.value, 40);
  });

  it("un vero AND bitwise (singolo &) NON viene toccato/corrotto dal fix", () => {
    const symbolValues = new Map<string, number>();
    const allDefines = new Map<string, string>();
    const functionDefines = new Map();

    const result = buildCompositeExpressionPreview(
      "reg_val & 0x0F",
      symbolValues,
      allDefines,
      functionDefines
    );

    // reg_val è una variabile runtime non risolvibile: l'espressione non
    // deve essere semplificata/valutata a un numero, e la & singola deve
    // restare riconosciuta come bitwise (formato hex, non boolean).
    assert.equal(result.value, null);
    assert.equal(result.numericFormat, "hex");
  });

  it("un vero OR bitwise (singolo |) resta protetto", () => {
    const symbolValues = new Map<string, number>();
    const allDefines = new Map<string, string>();
    const functionDefines = new Map();

    const result = buildCompositeExpressionPreview("flags | 0x01", symbolValues, allDefines, functionDefines);
    assert.equal(result.numericFormat, "hex");
  });

  it("espressione mista (bitwise singolo + logico doppio) resta protetta come bitwise", () => {
    const symbolValues = new Map<string, number>();
    const allDefines = new Map<string, string>();
    const functionDefines = new Map();

    // "a & b && c" contiene sia un '&' singolo (bitwise) sia un '&&'
    // (logico): la presenza del bitwise deve comunque bloccare la
    // semplificazione aggressiva, indipendentemente dal resto.
    const result = buildCompositeExpressionPreview("(a & b) && c", symbolValues, allDefines, functionDefines);
    assert.equal(result.numericFormat, "hex");
  });

  it("nessuna eccezione su input patologici (stringa vuota, solo operatori)", () => {
    const symbolValues = new Map<string, number>();
    const allDefines = new Map<string, string>();
    const functionDefines = new Map();

    assert.doesNotThrow(() => buildCompositeExpressionPreview("", symbolValues, allDefines, functionDefines));
    assert.doesNotThrow(() =>
      buildCompositeExpressionPreview("&&&&", symbolValues, allDefines, functionDefines)
    );
    assert.doesNotThrow(() =>
      buildCompositeExpressionPreview("a &&& b", symbolValues, allDefines, functionDefines)
    );
  });
});
