import { describe, it, expect } from "vitest";
import { evaluateExpressionDimensions, getUnitDim } from "../../src/formulaOutline/dimensionEvaluator";

describe("quantity literal units in dimension checking", () => {
  it("treats a bare number as dimensionless (baseline, unchanged)", () => {
    const result = evaluateExpressionDimensions("1.25", new Map());
    expect(result.error).toBeUndefined();
    expect(result.dimension).toEqual({ M: 0, L: 0, T: 0, I: 0, K: 0 });
  });

  it("does NOT throw a false mismatch when a quantity-literal number is combined with a dimensioned symbol", () => {
    const dimMap = new Map([["V_ref", getUnitDim("V")!]]);
    // Previously: "1.25 V" -> __unit(1.25, "V") -> treated as ZERO_DIM ->
    // ADD_MISMATCH against V_ref's Voltage dimension. Now it should carry V.
    const result = evaluateExpressionDimensions("V_ref - 1.25 V", dimMap);
    expect(result.error).toBeUndefined();
    expect(result.dimension).toEqual(getUnitDim("V"));
  });

  it("still throws a real mismatch for a genuinely dimensionless literal vs a dimensioned symbol", () => {
    const dimMap = new Map([["V_ref", getUnitDim("V")!]]);
    const result = evaluateExpressionDimensions("V_ref - 1.25", dimMap);
    expect(result.error).toBe("ADD_MISMATCH");
  });
});
