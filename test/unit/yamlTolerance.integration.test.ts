/**
 * yamlTolerance.integration.test.ts
 *
 * Test di integrazione per:
 *   - parseToleranceSpec() / convertLegacyToleranceToNew()
 *   - evaluateYamlDocument() con tolleranza
 *
 * Verifica il comportamento reale del motore su documenti YAML completi.
 * Ogni caso corrisponde a un simbolo nei file examples/formulas_model_modes_expected*.yaml
 */

import { describe, it, expect } from "vitest";
import {
  parseToleranceSpec,
  type FormulaToleranceSpec,
} from "../../src/core/formulaYaml";
import { evaluateYamlDocument } from "../../src/engine/yamlEngine";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SQRT3 = Math.sqrt(3);

function assertApprox(actual: number, expected: number, tol = 0.01): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

function assertDefined<T>(label: string, val: T | undefined | null): T {
  if (val === undefined || val === null)
    throw new Error(`[${label}] Expected defined, got ${val}`);
  return val;
}

// ─── parseToleranceSpec ──────────────────────────────────────────────────────

describe("parseToleranceSpec — nuovo formato", () => {
  it("uncertainty.percent + distribution.uniform → input spec corretta", () => {
    const spec = parseToleranceSpec({
      uncertainty: { type: "percent", value: 5 },
      distribution: { type: "uniform" },
    }, "X")!;
    assertDefined("spec", spec);
    const unc = assertDefined("input", spec.input!).uncertainty;
    expect(unc.type).toBe("percent");
    expect(unc.value).toBe(5);
    expect(spec.input!.distribution.type).toBe("uniform");
    expect(spec.input!.isLegacy).toBe(false);
  });

  it("uncertainty.range → input spec corretta", () => {
    const spec = parseToleranceSpec({
      uncertainty: { type: "range", min: 95, max: 105 },
      distribution: { type: "uniform" },
    }, "X")!;
    const unc = spec.input!.uncertainty;
    expect(unc.type).toBe("range");
    expect(unc.min).toBe(95);
    expect(unc.max).toBe(105);
  });

  it("propagation: worst_case → output.method=worst_case", () => {
    const spec = parseToleranceSpec({
      uncertainty: { type: "percent", value: 5 },
      distribution: { type: "uniform" },
      propagation: "worst_case",
    }, "Y")!;
    expect(spec.output?.method).toBe("worst_case");
  });

  it("propagation: rss → output.method=rss", () => {
    const spec = parseToleranceSpec({
      propagation: "rss",
    }, "Y")!;
    expect(spec.output?.method).toBe("rss");
  });

  it("propagation: monte_carlo + seed + confidence", () => {
    const spec = parseToleranceSpec({
      propagation: "monte_carlo",
      confidence: 95,
      seed: 42,
      samples: 10000,
    }, "Y")!;
    expect(spec.output?.method).toBe("monte_carlo");
    expect(spec.output?.confidence).toBe(95);
    expect(spec.output?.seed).toBe(42);
    expect(spec.output?.samples).toBe(10000);
  });

  it("campo 'mode: worst_case' — NON produce propagation method", () => {
    const spec = parseToleranceSpec({ mode: "worst_case" }, "Y");
    expect(spec?.output?.method).toBeUndefined();
  });
});

describe("parseToleranceSpec — formato legacy", () => {
  it("tol: 5 → legacy warning, uncertainty=percent(5), distribution=uniform", () => {
    const spec = parseToleranceSpec({ tol: 5 }, "X")!;
    assertDefined("spec", spec);
    const input = assertDefined("input", spec.input);
    expect(input.uncertainty.type).toBe("percent");
    expect(input.uncertainty.value).toBe(5);
    expect(input.distribution.type).toBe("uniform");
    expect(input.isLegacy).toBe(true);
    const hasWarn = spec.issues.some(i => i.field === "tol" && i.severity === "warning");
    expect(hasWarn).toBe(true);
  });

  it("tol:5 tol_mode:gaussian sigma:2 → distribution=normal(sigma_level=2)", () => {
    const spec = parseToleranceSpec({ tol: 5, tol_mode: "gaussian", sigma: 2 }, "X")!;
    const dist = spec.input!.distribution;
    expect(dist.type).toBe("normal");
    expect(dist.sigma_level).toBe(2);
  });

  it("tol:5 tol_mode:rss → distribution=uniform (rss non cambia distribuzione input)", () => {
    const spec = parseToleranceSpec({ tol: 5, tol_mode: "rss", sigma: 2 }, "X")!;
    expect(spec.input!.distribution.type).toBe("uniform");
  });

  it("uncertainty + tol (mix) → error issue", () => {
    const spec = parseToleranceSpec({
      uncertainty: { type: "percent", value: 5 },
      tol: 3,
    }, "X")!;
    const hasErr = spec.issues.some(i => i.severity === "error");
    expect(hasErr).toBe(true);
  });
});

describe("parseToleranceSpec — parameter_tolerances", () => {
  it("parameter_tolerances override per parametro", () => {
    const spec = parseToleranceSpec({
      propagation: "worst_case",
      parameter_tolerances: {
        BASE_100: {
          uncertainty: { type: "percent", value: 5 },
          distribution: { type: "uniform" },
        },
      },
    }, "Y")!;
    assertDefined("parameterOverrides", spec.parameterOverrides);
    const override = spec.parameterOverrides!["BASE_100"];
    assertDefined("override", override);
    expect(override.uncertainty.type).toBe("percent");
    expect(override.uncertainty.value).toBe(5);
  });
});

// ─── evaluateYamlDocument — integrazione completa ───────────────────────────

describe("evaluateYamlDocument — worst_case", () => {
  const rawText = `
X_TOL:
  type: const
  value: 100
  unit: count
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: uniform

Y_linear:
  type: expr
  formula: X_TOL
  unit: count
  propagation: worst_case
`;

  it("Y=X, X uniform ±5%, WC → [95, 105]", () => {
    const root = require("js-yaml").load(rawText) as Record<string, unknown>;
    const result = evaluateYamlDocument(root, { rawText, yamlPath: "test.yaml" });
    const Y = result.symbols.get("Y_linear")!;
    assertDefined("Y_linear", Y);
    assertApprox(Y.value!, 100, 0.001);
    const range = assertDefined("range", Y.range);
    assertApprox(range.min, 95, 0.1);
    assertApprox(range.max, 105, 0.1);
    expect(range.method).toBe("worst_case");
    expect(range.source).toBe("propagated");
  });
});

describe("evaluateYamlDocument — rss", () => {
  const rawText = `
X_NORM:
  type: const
  value: 100
  unit: count
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: normal
    sigma_level: 3

Y_rss:
  type: expr
  formula: X_NORM
  unit: count
  propagation: rss
`;

  it("Y=X, X normal sl=3 ±5%, RSS → [95, 105]", () => {
    const root = require("js-yaml").load(rawText) as Record<string, unknown>;
    const result = evaluateYamlDocument(root, { rawText });
    const Y = result.symbols.get("Y_rss")!;
    const range = assertDefined("range", Y.range);
    assertApprox(range.min, 95, 0.1);
    assertApprox(range.max, 105, 0.1);
    expect(range.method).toBe("rss");
  });

  it("Y=X², X uniform ±5%, worst_case asimmetrico → [9025, 11025]", () => {
    const raw = `
X_N:
  type: const
  value: 100
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: uniform

Y_sq:
  type: expr
  formula: X_N * X_N
  propagation: worst_case
`;
    const root = require("js-yaml").load(raw) as Record<string, unknown>;
    const result = evaluateYamlDocument(root, { rawText: raw });
    const Y = result.symbols.get("Y_sq")!;
    const range = assertDefined("range", Y.range);
    // f(x)=x²: f(105)=11025, f(95)=9025, f(100)=10000
    // worst_case percentile 0/100 on uniform input -> [9025, 11025]
    assertApprox(range.min, 9025, 5);
    assertApprox(range.max, 11025, 5);
  });
});

describe("evaluateYamlDocument — monte_carlo", () => {
  it("Y=X, X uniform ±5%, MC confidence=95, seed=42 → approx [95, 105]", () => {
    const rawText = `
X_MC:
  type: const
  value: 100
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: uniform

Y_mc:
  type: expr
  formula: X_MC
  propagation: monte_carlo
  confidence: 95
  seed: 42
`;
    const root = require("js-yaml").load(rawText) as Record<string, unknown>;
    const result = evaluateYamlDocument(root, { rawText });
    const Y = result.symbols.get("Y_mc")!;
    const range = assertDefined("range", Y.range);
    assertApprox(range.min, 95, 0.5);
    assertApprox(range.max, 105, 0.5);
    expect(range.method).toBe("monte_carlo");
    expect(range.distribution).toBeDefined();
  });

  it("MC deterministico: stesso seed → stesse bounds", () => {
    const rawText = `
X_D:
  type: const
  value: 100
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: normal
    sigma_level: 3

Y_d:
  type: expr
  formula: X_D
  propagation: monte_carlo
  seed: 12345
`;
    const root = require("js-yaml").load(rawText) as Record<string, unknown>;
    const r1 = evaluateYamlDocument(root, { rawText });
    const r2 = evaluateYamlDocument(root, { rawText });
    const y1 = r1.symbols.get("Y_d")!.range!;
    const y2 = r2.symbols.get("Y_d")!.range!;
    assertApprox(y1.min, y2.min, 1e-10);
    assertApprox(y1.max, y2.max, 1e-10);
  });
});

describe("evaluateYamlDocument — parameter_tolerances override", () => {
  it("Y=X*X con override ±5% per X → WC asimmetrico [9025, 11025]", () => {
    // f(x)=x², BASE=100, hw=5, f(100)=10000
    // upEffect = f(105) - f(100) = 11025 - 10000 = 1025
    // downEffect = f(95) - f(100) = 9025 - 10000 = -975
    // → [10000-975, 10000+1025] = [9025, 11025]
    const rawText = `
BASE_100:
  type: const
  value: 100

Y_override:
  type: expr
  formula: BASE_100 * BASE_100
  propagation: worst_case
  parameter_tolerances:
    BASE_100:
      uncertainty:
        type: percent
        value: 5
      distribution:
        type: uniform
`;
    const root = require("js-yaml").load(rawText) as Record<string, unknown>;
    const result = evaluateYamlDocument(root, { rawText });
    const Y = result.symbols.get("Y_override")!;
    const range = assertDefined("range", Y.range);
    assertApprox(range.min, 9025, 10);
    assertApprox(range.max, 11025, 10);
  });
});

describe("evaluateYamlDocument — legacy tol", () => {
  it("tol:5 tol_mode:gaussian sigma:3, Y=X, RSS → [95, 105] + legacy warning", () => {
    const rawText = `
X_LEG:
  type: const
  value: 100
  tol: 5
  tol_mode: gaussian
  sigma: 3

Y_leg:
  type: expr
  formula: X_LEG
  propagation: rss
`;
    const root = require("js-yaml").load(rawText) as Record<string, unknown>;
    const result = evaluateYamlDocument(root, { rawText });
    const Y = result.symbols.get("Y_leg")!;
    const range = assertDefined("range", Y.range);
    // tol=5, gaussian sl=3: sigma=5/3, delta=3×5/3=5
    assertApprox(range.min, 95, 0.1);
    assertApprox(range.max, 105, 0.1);
    // WARN: presenza di issue legacy propagati dallo spec al simbolo
    const X = result.symbols.get("X_LEG")!;
    expect(X.warnings.length).toBeGreaterThan(0);
  });
});

describe("evaluateYamlDocument — range senza tolleranza", () => {
  it("simbolo const senza tolleranza → range undefined", () => {
    const rawText = `
X_PLAIN:
  type: const
  value: 100
`;
    const root = require("js-yaml").load(rawText) as Record<string, unknown>;
    const result = evaluateYamlDocument(root, { rawText });
    const X = result.symbols.get("X_PLAIN")!;
    expect(X.range).toBeUndefined();
  });

  it("formula senza input con tolleranza → range undefined", () => {
    const rawText = `
A:
  type: const
  value: 10
B:
  type: const
  value: 20
Y:
  type: expr
  formula: A + B
  propagation: worst_case
`;
    const root = require("js-yaml").load(rawText) as Record<string, unknown>;
    const result = evaluateYamlDocument(root, { rawText });
    const Y = result.symbols.get("Y")!;
    expect(Y.range).toBeUndefined();
  });
});

describe("evaluateYamlDocument — diagnostiche", () => {
  it("dipendenza mancante → info diagnostic", () => {
    const rawText = `
Y_param:
  type: expr
  formula: EXTERNAL_VAR + 10
`;
    const root = require("js-yaml").load(rawText) as Record<string, unknown>;
    const result = evaluateYamlDocument(root, { rawText });
    const hasInfo = result.diagnostics.some(d => d.severity === "info" && d.symbol === "Y_param");
    expect(hasInfo).toBe(true);
  });

  it("ciclo → error diagnostic + evaluation skipped", () => {
    const rawText = `
A:
  type: expr
  formula: B + 1
B:
  type: expr
  formula: A + 1
`;
    const root = require("js-yaml").load(rawText) as Record<string, unknown>;
    const result = evaluateYamlDocument(root, { rawText });
    expect(result.cycles.length).toBeGreaterThan(0);
    const hasErr = result.diagnostics.some(d => d.severity === "error");
    expect(hasErr).toBe(true);
  });
});