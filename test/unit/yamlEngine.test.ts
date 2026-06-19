import { describe, expect, it } from "vitest";

import { evaluateYamlDocument } from "../../src/engine/yamlEngine";

function evaluate(root: Record<string, unknown>) {
  const rawText = Object.keys(root)
    .map((key) => `${key}:`)
    .join("\n");

    return evaluateYamlDocument(root, { rawText });
}

describe("yaml formula engine", () => {
  it("evaluates value tables, indexing, int(), mod(), and ass()", () => {
    const result = evaluate({
      TABLE: { value: [1, 2, 3.2] },
      IDX: { value: 2 },
      PICK: { formula: "TABLE[IDX] + mod(5, 2) + int(3.9) + ass(-4)" },
    });

    expect(result.symbols.get("PICK")?.value).toBeCloseTo(11.2);
    expect(result.symbols.get("PICK")?.errors).toEqual([]);
  });

  it("requires exact arguments for parameterized formula calls", () => {
    const result = evaluate({
      BASE: { value: 3 },
      GAIN: { parameters: ["x", "offset"], formula: "x * 2 + offset" },
      OUT: { formula: "GAIN(BASE, 1)" },
      BAD_OUT: { formula: "GAIN(BASE)" },
    });

    expect(result.symbols.get("OUT")?.value).toBeCloseTo(7);
    expect(result.symbols.get("BAD_OUT")?.errors.join("\n")).toContain(
      "expects 2 parameter(s), got 1"
    );
  });

  it("propagates declared min/max/tol ranges through formula outputs with explicit worst_case", () => {
    const result = evaluate({
      VIN: { value: 10, unit: "V", tol: 10 },
      CURRENT: { value: 2, unit: "A", min: 1, max: 3 },
      POWER: { formula: "VIN * CURRENT", unit: "W", propagation: "worst_case" },
    });

    expect(result.symbols.get("VIN")?.range).toMatchObject({
      min: 9,
      max: 11,
      source: "declared",
    });
    expect(result.symbols.get("CURRENT")?.range).toMatchObject({
      min: 1,
      max: 3,
      source: "declared",
    });

    const power = result.symbols.get("POWER");
    expect(power?.range).toBeDefined();
    expect(power?.range?.source).toBe("propagated");
    // Per Y = Vin * Iout, worst_case (percentile 0/100 of MC samples):
    //   VIN: nominal=10, range = [9, 11]
    //   CURRENT: nominal=2, range = [1, 3]
    //   true bounds = [9 * 1, 11 * 3] = [9, 33]
    expect(power?.range?.min).toBeCloseTo(9, 0);
    expect(power?.range?.max).toBeCloseTo(33, 0);
  });

  it("keeps affine units attached to raw YAML values without offset conversion", () => {
    const result = evaluate({
      MEASURED_TEMP: { value: 25.0, unit: "degc", tol: 2 },
      COMPENSATED_OUTPUT: {
        formula: "MEASURED_TEMP * 1.05 + 0.5",
        unit: "degc",
      },
    });

    const measured = result.symbols.get("MEASURED_TEMP");
    expect(measured?.errors).toEqual([]);
    expect(measured?.value).toBeCloseTo(25, 9);
    expect(measured?.outputUnit).toBe("degC");

    const compensated = result.symbols.get("COMPENSATED_OUTPUT");
    expect(compensated?.errors).toEqual([]);
    expect(compensated?.value).toBeCloseTo(26.75, 9);
    expect(compensated?.outputUnit).toBe("degC");
  });
});
