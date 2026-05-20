// `units.test.ts`
import { describe, expect, it } from "vitest";

import {
  UNIT_ALIASES,
  UNIT_SPEC_LIST,
  UNIT_SPECS,
  addQuantities,
  applyOutputUnit,
  createQuantity,
  createQuantityFromData,
  getUnitSpec,
  toDisplayValue,
} from "../units";

describe("units", () => {
  it("converts compatible pressure units", () => {
    const pa = createQuantity(100, "Pa");
    const atm = createQuantity(1, "atm");

    expect(pa.ok).toBe(true);
    expect(atm.ok).toBe(true);

    if (!pa.ok || !atm.ok) {
      return;
    }

    const sum = addQuantities(pa.value, atm.value);

    expect(sum.ok).toBe(true);

    if (!sum.ok) {
      return;
    }

    const converted = applyOutputUnit(sum.value, "Pa");

    expect(converted.ok).toBe(true);

    if (!converted.ok) {
      return;
    }

    expect(converted.value.displayValue).toBeCloseTo(101425, 9);
  });

  it("rejects incompatible add operations", () => {
    const resistance = createQuantity(10, "Ohm");
    const voltage = createQuantity(5, "V");

    expect(resistance.ok).toBe(true);
    expect(voltage.ok).toBe(true);

    if (!resistance.ok || !voltage.ok) {
      return;
    }

    const result = addQuantities(resistance.value, voltage.value);

    expect(result.ok).toBe(false);
  });

  it("keeps data values in their declared display unit", () => {
    const current = createQuantityFromData(100, "mA");
    expect(current.ok).toBe(true);
    if (!current.ok) {
      return;
    }

    expect(current.value.valueSi).toBeCloseTo(0.1, 12);
    expect(toDisplayValue(current.value)).toBeCloseTo(100, 12);

    const celsius = createQuantityFromData(10000, "degc");
    expect(celsius.ok).toBe(true);
    if (!celsius.ok) {
      return;
    }

    expect(celsius.value.valueSi).toBeCloseTo(10273.15, 9);
    expect(toDisplayValue(celsius.value)).toBeCloseTo(10000, 9);
  });
});

// -----------------------------------------------------------------------------
// COLLISION TESTS
// -----------------------------------------------------------------------------

describe("unit registry consistency", () => {
  it("has no duplicate unit tokens", () => {
    const seen = new Set<string>();

    for (const spec of UNIT_SPEC_LIST) {
      expect(seen.has(spec.token)).toBe(false);
      seen.add(spec.token);
    }
  });

  it("has no duplicate canonical names", () => {
    const seen = new Set<string>();

    for (const spec of UNIT_SPEC_LIST) {
      expect(seen.has(spec.canonical)).toBe(false);
      seen.add(spec.canonical);
    }
  });

  it("has no duplicate aliases", () => {
    const seen = new Set<string>();

    for (const alias of UNIT_ALIASES.keys()) {
      expect(seen.has(alias)).toBe(false);
      seen.add(alias);
    }
  });

  it("all aliases resolve to valid units", () => {
    for (const [, token] of UNIT_ALIASES.entries()) {
      expect(UNIT_SPECS.has(token)).toBe(true);
    }
  });

  it("does not generate SI collisions", () => {
    const seen = new Set<string>();

    for (const spec of UNIT_SPEC_LIST) {
      expect(seen.has(spec.token)).toBe(false);
      seen.add(spec.token);
    }
  });
});

// -----------------------------------------------------------------------------
// SI PREFIX COVERAGE
// -----------------------------------------------------------------------------

describe("SI prefixes", () => {
  it("supports voltage prefixes", () => {
    const expected = ["uV", "mV", "V", "kV", "MV"];

    for (const token of expected) {
      expect(getUnitSpec(token)).toBeDefined();
    }
  });

  it("supports current prefixes", () => {
    const expected = ["pA", "nA", "uA", "mA", "A", "kA"];

    for (const token of expected) {
      expect(getUnitSpec(token)).toBeDefined();
    }
  });

  it("supports power prefixes", () => {
    const expected = ["uW", "mW", "W", "kW", "MW", "GW"];

    for (const token of expected) {
      expect(getUnitSpec(token)).toBeDefined();
    }
  });

  it("supports frequency prefixes", () => {
    const expected = ["mHz", "Hz", "kHz", "MHz", "GHz"];

    for (const token of expected) {
      expect(getUnitSpec(token)).toBeDefined();
    }
  });
});

// -----------------------------------------------------------------------------
// ENGINEERING QUANTITIES
// -----------------------------------------------------------------------------

describe("engineering quantities", () => {
  it("supports dB family", () => {
    expect(getUnitSpec("dB")).toBeDefined();
    expect(getUnitSpec("dBm")).toBeDefined();
    expect(getUnitSpec("dBV")).toBeDefined();
  });

  it("supports firmware units", () => {
    expect(getUnitSpec("bit")).toBeDefined();
    expect(getUnitSpec("byte")).toBeDefined();
    expect(getUnitSpec("baud")).toBeDefined();
  });

  it("supports energy storage units", () => {
    expect(getUnitSpec("Wh")).toBeDefined();
    expect(getUnitSpec("kWh")).toBeDefined();
    expect(getUnitSpec("Ah")).toBeDefined();
    expect(getUnitSpec("mAh")).toBeDefined();
  });
});
