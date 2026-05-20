import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { collectDefinesAndConsts } from "../../src/core/cppParser";
import {
  buildCompositeExpressionPreview,
  createSymbolResolutionStats,
  resolveSymbol,
} from "../../src/core/expression";
import {
  applyOutputUnit,
  createQuantity,
  createQuantityFromData,
  normalizeUnit,
  toDisplayValue,
} from "../../src/engine/units";
import { evaluateYamlDocument } from "../../src/engine/yamlEngine";
import {
  buildFormulaSymbolTable,
  resolveFormulaValue,
  scaleValueToUnit,
} from "../../src/formulaOutline/formulaEvaluator";

async function withTempWorkspace<T>(
  run: (workspaceRoot: string) => Promise<T>
): Promise<T> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "calcdocs-cpp-conditionals-"));
  try {
    return await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

describe("conditional C/C++ symbol collection", () => {
  it("continues collecting symbols after include guards and active else branches", async () => {
    await withTempWorkspace(async (workspaceRoot) => {
      const srcDir = path.join(workspaceRoot, "src");
      const incDir = path.join(workspaceRoot, "inc");
      await mkdir(srcDir, { recursive: true });
      await mkdir(incDir, { recursive: true });

      await writeFile(
        path.join(incDir, "test.h"),
        [
          "#ifndef __TEST_H",
          "#define __TEST_H",
          "#define ADC_RES (0x0000400U)",
          "#define VEL (24)",
          "#endif",
          "",
        ].join("\n"),
        "utf8"
      );

      const sourcePath = path.join(srcDir, "test.c");
      await writeFile(
        sourcePath,
        [
          '#include "test.h"',
          "#if !defined(__TEST_H)",
          "#define SHOULD_SKIP 1",
          "#else",
          "#define MUL (2<<1)",
          "#define FINAL (VEL * MUL)",
          "#define MULTIPLE_CONDITION_TEST (4*ADC_RES)",
          "#define PT100_OHM_MIN (58.93)",
          "#define PT100_TOT_AMPL (0.000974 * 32.44192581 / 5.0)",
          "#define PT100_NUM16(R) (signed int)(0.5 + ( R - PT100_OHM_MIN ) * PT100_TOT_AMPL * 65536.0 )",
          "#define PT100_100OHM PT100_NUM16(100)",
          "#endif",
          "",
        ].join("\n"),
        "utf8"
      );

      const collected = await collectDefinesAndConsts(
        [sourcePath],
        workspaceRoot,
        { resolveIncludes: true }
      );
      const symbolValues = new Map<string, number>(collected.consts);
      const resolved = new Map<string, number>();
      const stats = createSymbolResolutionStats();

      for (const name of collected.defines.keys()) {
        resolveSymbol(
          name,
          collected.defines,
          collected.functionDefines,
          resolved,
          symbolValues,
          {},
          stats,
          new Set<string>(),
          collected.defineConditions
        );
      }

      expect(collected.defines.has("SHOULD_SKIP")).toBe(false);
      expect(symbolValues.get("MUL")).toBe(4);
      expect(symbolValues.get("FINAL")).toBe(96);
      expect(symbolValues.get("MULTIPLE_CONDITION_TEST")).toBe(4096);
      expect(symbolValues.get("PT100_100OHM")).toBe(17010);

      expect(
        buildCompositeExpressionPreview(
          "5 * MUL",
          symbolValues,
          collected.defines,
          collected.functionDefines,
          {},
          collected.defineConditions
        ).value
      ).toBe(20);
      expect(
        buildCompositeExpressionPreview(
          "PT100_NUM16(100)",
          symbolValues,
          collected.defines,
          collected.functionDefines,
          {},
          collected.defineConditions
        ).value
      ).toBe(17010);
    });
  });
});

describe("engine unit compatibility", () => {
  it("preserves legacy engineering normalization", () => {
    expect(normalizeUnit(1000, "g")).toEqual({ value: 1, unit: "kg" });
    expect(normalizeUnit(24000, "mA")).toEqual({ value: 24, unit: "A" });

    const length = normalizeUnit(0.00005, "m");
    expect(length.value).toBeCloseTo(50, 9);
    expect(length.unit).toBe("um");
  });

  it("converts affine temperature units with offsets", () => {
    const celsius = createQuantity(25, "degC");
    expect(celsius.ok).toBe(true);
    if (!celsius.ok) {
      return;
    }

    expect(celsius.value.valueSi).toBeCloseTo(298.15, 9);

    const fahrenheit = applyOutputUnit(celsius.value, "degF");
    expect(fahrenheit.ok).toBe(true);
    if (!fahrenheit.ok) {
      return;
    }

    expect(fahrenheit.value.displayValue).toBeCloseTo(77, 9);
  });

  it("keeps case-sensitive SI prefix collisions distinct", () => {
    const tonne = createQuantity(1, "t");
    const tesla = createQuantity(1, "T");
    const milliSecond = createQuantity(1, "ms");
    const milliSiemens = createQuantity(1, "mS");

    expect(tonne.ok && tonne.value.valueSi).toBe(1000);
    expect(tesla.ok && tesla.value.valueSi).toBe(1);
    expect(milliSecond.ok && milliSecond.value.displayUnit).toBe("ms");
    expect(milliSiemens.ok && milliSiemens.value.displayUnit).toBe("mS");
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

  it("does not subtract temperature offsets from csv, lookup, or table values", () => {
    const csvTables = new Map([
      [
        "table.csv",
        {
          fileName: "table.csv",
          rows: [
            ["temp", "value"],
            ["25", "10000"],
          ],
          headerIndex: new Map([
            ["temp", 0],
            ["value", 1],
          ]),
        },
      ],
    ]);

    const result = evaluateYamlDocument(
      {
        CSV_DECLARED_UNIT: {
          type: "expr",
          expr: 'csv("table.csv", "25", "temp", "value")',
          unit: "degc",
        },
        LOOKUP_UNIT_ARG: {
          type: "expr",
          expr: 'lookup("table.csv", "25", "temp", "value", "none", "degc")',
        },
        TABLE_UNIT_ARG: {
          type: "expr",
          expr: 'table("table.csv", "25", "temp", "value", "none", "degc")',
        },
      },
      {
        rawText: "",
        csvTables,
      }
    );

    for (const name of ["CSV_DECLARED_UNIT", "LOOKUP_UNIT_ARG", "TABLE_UNIT_ARG"]) {
      const symbol = result.symbols.get(name);
      expect(symbol).toBeTruthy();
      expect(symbol?.errors).toEqual([]);
      expect(symbol?.value).toBeCloseTo(10000, 9);
      expect(symbol?.outputUnit).toBe("degC");
    }
  });

  it("keeps formula-outline lookup values raw when unit is declared separately", () => {
    const formulas = [
      {
        id: "NTC_R",
        expr: 'csv("data/ntc_10k.csv", "25", "temperature", "resistance")',
        unit: "degc",
        lineStart: 0,
        lineEnd: 2,
      },
    ];
    const lookup = () => 10000;

    const symbolTable = buildFormulaSymbolTable(formulas, undefined, lookup);
    const resolved = resolveFormulaValue(formulas[0], symbolTable, undefined, lookup);
    expect(resolved.resolved).not.toBeNull();
    if (resolved.resolved === null) {
      return;
    }

    expect(scaleValueToUnit(resolved.resolved, formulas[0].unit)).toBeCloseTo(10000, 9);
  });
});
