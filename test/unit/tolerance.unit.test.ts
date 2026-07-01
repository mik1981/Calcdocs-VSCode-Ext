/**
 * tolerance.unit.test.ts
 *
 * Test unitari per:
 *   - normalizeUncertainty()
 *   - computeStdDev()
 *   - runWorstCase() / runRss() / runMonteCarlo()
 *   - propagate()
 *   - buildMcSampleSpec()
 *
 * Ogni test verifica esclusivamente il comportamento osservato nel codice sorgente,
 * senza assumere requisiti non esplicitati.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeUncertainty,
  computeStdDev,
  recommendedSamples,
} from "../../src/types/toleranceModel";
import type {
  UncertaintySpec,
  DistributionSpec,
  NormalizedUncertainty,
} from "../../src/types/toleranceModel";
import {
  runWorstCase,
  runRss,
  runMonteCarlo,
  propagate,
  type UnifiedInput,
  type RssSensitivityInput,
  type WcSensitivityInput,
  type McOptions,
} from "../../src/engine/monteCarlo";
import { buildMcSampleSpec } from "../../src/engine/tolerance";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SQRT3 = Math.sqrt(3);
const SQRT6 = Math.sqrt(6);

function assertApprox(actual: number, expected: number, tol = 0.0001): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

// ─── normalizeUncertainty ─────────────────────────────────────────────────────

describe("normalizeUncertainty — type: percent", () => {
  it("nominal=100, value=5 → lower=95, upper=105, hw=5", () => {
    const r = normalizeUncertainty({ type: "percent", value: 5 }, 100)!;
    assertApprox(r.lower, 95);
    assertApprox(r.upper, 105);
    assertApprox(r.halfWidth, 5);
    assertApprox(r.nominal, 100);
  });

  it("nominal=200, value=10 → lower=180, upper=220, hw=20", () => {
    const r = normalizeUncertainty({ type: "percent", value: 10 }, 200)!;
    assertApprox(r.lower, 180);
    assertApprox(r.upper, 220);
    assertApprox(r.halfWidth, 20);
  });

  it("nominal=0, value=5 → lower=0, upper=0 (delta=|0|*5/100=0)", () => {
    const r = normalizeUncertainty({ type: "percent", value: 5 }, 0)!;
    assertApprox(r.lower, 0);
    assertApprox(r.upper, 0);
  });

  it("value undefined → returns undefined", () => {
    expect(normalizeUncertainty({ type: "percent" }, 100)).toBeUndefined();
  });
});

describe("normalizeUncertainty — type: range", () => {
  it("min=95, max=105 → lower=95, upper=105, hw=5", () => {
    const r = normalizeUncertainty({ type: "range", min: 95, max: 105 }, 100)!;
    assertApprox(r.lower, 95);
    assertApprox(r.upper, 105);
    assertApprox(r.halfWidth, 5);
  });

  it("min/max inverted → normalizes correctly", () => {
    const r = normalizeUncertainty({ type: "range", min: 105, max: 95 }, 100)!;
    assertApprox(r.lower, 95);
    assertApprox(r.upper, 105);
  });

  it("min undefined → returns undefined", () => {
    expect(normalizeUncertainty({ type: "range", max: 105 }, 100)).toBeUndefined();
  });
});

describe("normalizeUncertainty — type: absolute", () => {
  it("nominal=100, absolute=3 → lower=97, upper=103, hw=3", () => {
    const r = normalizeUncertainty({ type: "absolute", absolute: 3 }, 100)!;
    assertApprox(r.lower, 97);
    assertApprox(r.upper, 103);
    assertApprox(r.halfWidth, 3);
  });

  it("absolute undefined → returns undefined", () => {
    expect(normalizeUncertainty({ type: "absolute" }, 100)).toBeUndefined();
  });
});

describe("normalizeUncertainty — type: sigma", () => {
  it("nominal=100, sigma=1.5 → lower=95.5, upper=104.5 (3σ)", () => {
    const r = normalizeUncertainty({ type: "sigma", sigma: 1.5 }, 100)!;
    assertApprox(r.lower, 100 - 3 * 1.5);   // 95.5
    assertApprox(r.upper, 100 + 3 * 1.5);   // 104.5
    assertApprox(r.halfWidth, 3 * 1.5);      // 4.5
  });

  it("sigma undefined → returns undefined", () => {
    expect(normalizeUncertainty({ type: "sigma" }, 100)).toBeUndefined();
  });
});

// ─── computeStdDev ───────────────────────────────────────────────────────────

describe("computeStdDev", () => {
  const norm = (hw: number): NormalizedUncertainty => ({
    nominal: 100, lower: 100 - hw, upper: 100 + hw, halfWidth: hw,
  });

  it("uniform, hw=5 → sigma = 5/√3", () => {
    assertApprox(computeStdDev(norm(5), { type: "uniform" }), 5 / SQRT3);
  });

  it("normal sigma_level=3, hw=5 → sigma = 5/3", () => {
    assertApprox(computeStdDev(norm(5), { type: "normal", sigma_level: 3 }), 5 / 3);
  });

  it("normal sigma_level=2, hw=5 → sigma = 5/2 = 2.5", () => {
    assertApprox(computeStdDev(norm(5), { type: "normal", sigma_level: 2 }), 2.5);
  });

  it("normal default sigma_level (undefined→3), hw=6 → sigma = 2", () => {
    assertApprox(computeStdDev(norm(6), { type: "normal" }), 2);
  });

  it("triangular, hw=5 → sigma = 5/√6", () => {
    assertApprox(computeStdDev(norm(5), { type: "triangular" }), 5 / SQRT6);
  });

  it("type:sigma, sigma=1.5 → hw=4.5, dist=normal sl=3 → sigma=1.5", () => {
    const r = normalizeUncertainty({ type: "sigma", sigma: 1.5 }, 100)!;
    assertApprox(computeStdDev(r, { type: "normal", sigma_level: 3 }), 1.5);
  });
});

// ─── recommendedSamples ──────────────────────────────────────────────────────

describe("recommendedSamples", () => {
  it("≤5 inputs → 100000", () => {
    for (const n of [1, 3, 5]) {
      expect(recommendedSamples(n)).toBe(100_000);
    }
  });
  it("6..20 inputs → 50000", () => {
    for (const n of [6, 10, 20]) {
      expect(recommendedSamples(n)).toBe(50_000);
    }
  });
  it(">20 inputs → 10000", () => {
    expect(recommendedSamples(21)).toBe(10_000);
  });
});

// ─── runWorstCase ─────────────────────────────────────────────────────────────

describe("runWorstCase", () => {
  it("identity f(x)=x, up=5, down=-5 → [95, 105]", () => {
    const inputs: WcSensitivityInput[] = [{ name: "X", sensitivity: 5, upEffect: 5, downEffect: -5 }];
    const r = runWorstCase(inputs, 100);
    assertApprox(r.min, 95);
    assertApprox(r.max, 105);
    assertApprox(r.nominalValue!, 100);
    expect(r.method).toBe("worst_case");
  });

  it("two inputs: A up=3/down=-3, B up=-7/down=7 → [190, 210]", () => {
    const r = runWorstCase([
      { name: "A", sensitivity: 3, upEffect: 3, downEffect: -3 },
      { name: "B", sensitivity: -7, upEffect: -7, downEffect: 7 },
    ], 200);
    assertApprox(r.min, 190);
    assertApprox(r.max, 210);
  });

  it("zero effect: output unchanged", () => {
    const r = runWorstCase([{ name: "X", sensitivity: 0, upEffect: 0, downEffect: 0 }], 100);
    assertApprox(r.min, 100);
    assertApprox(r.max, 100);
  });
});

// ─── runRss ──────────────────────────────────────────────────────────────────

describe("runRss", () => {
  it("single input: sensitivity=5/3, stddev=5/3 → stddev_out=5/3, delta=3×5/3=5", () => {
    const sigma = 5 / 3;
    const inputs: RssSensitivityInput[] = [{ name: "X", sensitivity: sigma, stdDev: sigma }];
    const r = runRss(inputs, 100, 3);
    assertApprox(r.min, 95);
    assertApprox(r.max, 105);
    assertApprox(r.stddev!, sigma);
  });

  it("two inputs: stddev = sqrt(s1²+s2²)", () => {
    const s1 = 3, s2 = 4;
    const inputs: RssSensitivityInput[] = [
      { name: "A", sensitivity: s1, stdDev: s1 },
      { name: "B", sensitivity: s2, stdDev: s2 },
    ];
    const r = runRss(inputs, 100, 3);
    assertApprox(r.stddev!, 5);
    assertApprox(r.min, 100 - 3 * 5);
    assertApprox(r.max, 100 + 3 * 5);
  });

  it("sigmaOut=2: delta = 2×stddev", () => {
    const r = runRss([{ name: "X", sensitivity: 5, stdDev: 5 }], 100, 2);
    assertApprox(r.min, 90);
    assertApprox(r.max, 110);
  });
});

// ─── propagate() — worst_case ────────────────────────────────────────────────────

describe("propagate() — worst_case", () => {
  const X_uniform: UnifiedInput = {
    name: "X",
    nominal: 100,
    uncertainty: { type: "percent", value: 5 },
    distribution: { type: "uniform" },
  };

  const evalFn = (v: Record<string, number>) => v["X"];

  it("Y=X, X uniform ±5% → WC [95, 105]", () => {
    const r = propagate([X_uniform], evalFn, 100, "worst_case");
    assertApprox(r.min, 95);
    assertApprox(r.max, 105);
  });

  it("Y=2X, X uniform ±5% → WC sensitivity=10, [190, 210]", () => {
    // f(x)=2x, X in [95,105], nom=100, f(nom)=200
    // sensitivity = (f(105)-f(95))/2 = (210-190)/2 = 10
    // delta = 10 → output = [200-10, 200+10] = [190, 210]
    const r = propagate([X_uniform], (v) => 2 * v["X"], 200, "worst_case");
    assertApprox(r.min, 190);
    assertApprox(r.max, 210);
  });

  it("no inputs → output unchanged", () => {
    const r = propagate([], evalFn, 100, "worst_case");
    assertApprox(r.min, 100);
    assertApprox(r.max, 100);
  });
});

// ─── propagate() — rss ───────────────────────────────────────────────────────

describe("propagate() — rss", () => {
  it("Y=X, X normal sl=3 ±5% → RSS: sigma=5/3, delta=3×5/3=5 → [95, 105]", () => {
    const inp: UnifiedInput = {
      name: "X", nominal: 100,
      uncertainty: { type: "percent", value: 5 },
      distribution: { type: "normal", sigma_level: 3 },
    };
    const r = propagate([inp], (v) => v["X"], 100, "rss");
    assertApprox(r.min, 95);
    assertApprox(r.max, 105);
  });

  it("Y=X, X uniform ±5% → RSS: sigma=5/√3, delta=3×5/√3≈8.66", () => {
    const inp: UnifiedInput = {
      name: "X", nominal: 100,
      uncertainty: { type: "percent", value: 5 },
      distribution: { type: "uniform" },
    };
    const r = propagate([inp], (v) => v["X"], 100, "rss");
    assertApprox(r.min, 100 - 3 * 5 / SQRT3, 0.01);
    assertApprox(r.max, 100 + 3 * 5 / SQRT3, 0.01);
  });

  it("Y=X, X normal sl=2 ±5% → RSS: sigma=2.5, delta=7.5 → [92.5, 107.5]", () => {
    const inp: UnifiedInput = {
      name: "X", nominal: 100,
      uncertainty: { type: "percent", value: 5 },
      distribution: { type: "normal", sigma_level: 2 },
    };
    const r = propagate([inp], (v) => v["X"], 100, "rss");
    assertApprox(r.min, 92.5, 0.01);
    assertApprox(r.max, 107.5, 0.01);
  });

  it("Y=X², X normal sl=3 ±5% → WC asimmetrico: up=1025, down=-975 → [9025, 11025]", () => {
    // Worst case asimmetrico: f(105)=11025, f(95)=9025, f(100)=10000
    // upEffect=1025, downEffect=-975 → [10000-975, 10000+1025] = [9025, 11025]
    const inp: UnifiedInput = {
      name: "X", nominal: 100,
      uncertainty: { type: "percent", value: 5 },
      distribution: { type: "normal", sigma_level: 3 },
    };
    const r = propagate([inp], (v) => v["X"] * v["X"], 10000, "worst_case");
    assertApprox(r.min, 9025, 1);
    assertApprox(r.max, 11025, 1);
  });

  it("Y=A+B: two inputs, RSS quadrature", () => {
    const sigma_A = 5 / 3, sigma_B = 2.5;
    const expected_stddev = Math.sqrt(sigma_A ** 2 + sigma_B ** 2);
    const inps: UnifiedInput[] = [
      { name: "A", nominal: 100, uncertainty: { type: "percent", value: 5 }, distribution: { type: "normal", sigma_level: 3 } },
      { name: "B", nominal: 100, uncertainty: { type: "percent", value: 5 }, distribution: { type: "normal", sigma_level: 2 } },
    ];
    const r = propagate(inps, (v) => v["A"] + v["B"], 200, "rss");
    assertApprox(r.min, 200 - 3 * expected_stddev, 0.05);
    assertApprox(r.max, 200 + 3 * expected_stddev, 0.05);
  });
});

// ─── propagate() — monte_carlo ───────────────────────────────────────────────

describe("propagate() — monte_carlo", () => {
  it("Y=X, X uniform [95,105], seed=42, confidence=95 → approx [95, 105]", () => {
    const inp: UnifiedInput = {
      name: "X", nominal: 100,
      uncertainty: { type: "percent", value: 5 },
      distribution: { type: "uniform" },
    };
    const opts: McOptions = { seed: 42, confidence: 95 };
    const r = propagate([inp], (v) => v["X"], 100, "monte_carlo", opts);
    assertApprox(r.min, 95, 0.5);
    assertApprox(r.max, 105, 0.5);
    expect(r.method).toBe("monte_carlo");
    expect(r.distribution).toBeDefined();
  });

  it("Y=X, X normal sl=3 ±5%, seed=42, confidence=95 → approx [96.7, 103.3]", () => {
    const inp: UnifiedInput = {
      name: "X", nominal: 100,
      uncertainty: { type: "percent", value: 5 },
      distribution: { type: "normal", sigma_level: 3 },
    };
    const opts: McOptions = { seed: 42, confidence: 95 };
    const r = propagate([inp], (v) => v["X"], 100, "monte_carlo", opts);
    assertApprox(r.min, 96.73, 0.5);
    assertApprox(r.max, 103.27, 0.5);
  });

  it("Y=X², X uniform [95,105], seed=42 → asimmetrico, approx [9025, 11025]", () => {
    const inp: UnifiedInput = {
      name: "X", nominal: 100,
      uncertainty: { type: "percent", value: 5 },
      distribution: { type: "uniform" },
    };
    const opts: McOptions = { seed: 42, confidence: 95 };
    const r = propagate([inp], (v) => v["X"] * v["X"], 10000, "monte_carlo", opts);
    assertApprox(r.min, 9025, 200);
    assertApprox(r.max, 11025, 200);
    assertApprox(r.distribution!.mean, 10008, 100);
  });

  it("distribution fields present: samples, mean, stddev, percentiles", () => {
    const inp: UnifiedInput = {
      name: "X", nominal: 100,
      uncertainty: { type: "percent", value: 5 },
      distribution: { type: "uniform" },
    };
    const r = propagate([inp], (v) => v["X"], 100, "monte_carlo", { seed: 1 });
    const d = r.distribution!;
    expect(Number.isFinite(d.mean)).toBe(true);
    expect(Number.isFinite(d.stddev)).toBe(true);
    expect(Number.isFinite(d.p025)).toBe(true);
    expect(Number.isFinite(d.p975)).toBe(true);
    expect(d.samples).toBeGreaterThan(0);
  });

  it("deterministic: same seed → same result", () => {
    const inp: UnifiedInput = {
      name: "X", nominal: 100,
      uncertainty: { type: "percent", value: 5 },
      distribution: { type: "normal", sigma_level: 3 },
    };
    const evalF = (v: Record<string, number>) => v["X"];
    const r1 = propagate([inp], evalF, 100, "monte_carlo", { seed: 999 });
    const r2 = propagate([inp], evalF, 100, "monte_carlo", { seed: 999 });
    assertApprox(r1.min, r2.min, 1e-10);
    assertApprox(r1.max, r2.max, 1e-10);
  });
});

// ─── buildMcSampleSpec ────────────────────────────────────────────────────────

describe("buildMcSampleSpec", () => {
  it("percent+normal sl=3 → stdDev=hw/3", () => {
    const spec = buildMcSampleSpec("X", 100,
      { type: "percent", value: 5 },
      { type: "normal", sigma_level: 3 }
    )!;
    assertApprox(spec.lower, 95);
    assertApprox(spec.upper, 105);
    assertApprox(spec.stdDev, 5 / 3);
    expect(spec.distribution).toBe("normal");
    expect(spec.sigmaLevel).toBe(3);
  });

  it("range+uniform → stdDev=hw/√3", () => {
    const spec = buildMcSampleSpec("X", 100,
      { type: "range", min: 95, max: 105 },
      { type: "uniform" }
    )!;
    assertApprox(spec.stdDev, 5 / SQRT3);
    expect(spec.distribution).toBe("uniform");
  });

  it("invalid uncertainty → returns undefined", () => {
    const spec = buildMcSampleSpec("X", 100,
      { type: "percent" },  // value mancante
      { type: "uniform" }
    );
    expect(spec).toBeUndefined();
  });
});

// ─── Verifica matematica combinata (formulas_model_modes_expected_2.yaml) ────

describe("Verifica expected formulas_model_modes_expected_2.yaml", () => {
  it("Y_total_rss: 6 input, stddev=5.563, delta≈16.69 → [583.31, 616.69]", () => {
    const inps: UnifiedInput[] = [
      { name: "X_UNIFORM",   nominal: 100, uncertainty: { type: "percent", value: 5 }, distribution: { type: "uniform" } },
      { name: "X_NORMAL_3S", nominal: 100, uncertainty: { type: "percent", value: 5 }, distribution: { type: "normal", sigma_level: 3 } },
      { name: "X_NORMAL_2S", nominal: 100, uncertainty: { type: "percent", value: 5 }, distribution: { type: "normal", sigma_level: 2 } },
      { name: "X_RANGE",     nominal: 100, uncertainty: { type: "range", min: 95, max: 105 }, distribution: { type: "uniform" } },
      { name: "X_ABS",       nominal: 100, uncertainty: { type: "absolute", absolute: 3 }, distribution: { type: "uniform" } },
      { name: "X_SIGMA",     nominal: 100, uncertainty: { type: "sigma", sigma: 1.5 }, distribution: { type: "normal", sigma_level: 3 } },
    ];
    const evalF = (v: Record<string, number>) =>
      v["X_UNIFORM"] + v["X_NORMAL_3S"] + v["X_NORMAL_2S"] + v["X_RANGE"] + v["X_ABS"] + v["X_SIGMA"];
    const r = propagate(inps, evalF, 600, "rss");
    assertApprox(r.min, 583, 1);
    assertApprox(r.max, 617, 1);
  });

  it("Y_total_wc: delta=27.5 → [572.5, 627.5]", () => {
    const inps: UnifiedInput[] = [
      { name: "X_UNIFORM",   nominal: 100, uncertainty: { type: "percent", value: 5 }, distribution: { type: "uniform" } },
      { name: "X_NORMAL_3S", nominal: 100, uncertainty: { type: "percent", value: 5 }, distribution: { type: "normal", sigma_level: 3 } },
      { name: "X_NORMAL_2S", nominal: 100, uncertainty: { type: "percent", value: 5 }, distribution: { type: "normal", sigma_level: 2 } },
      { name: "X_RANGE",     nominal: 100, uncertainty: { type: "range", min: 95, max: 105 }, distribution: { type: "uniform" } },
      { name: "X_ABS",       nominal: 100, uncertainty: { type: "absolute", absolute: 3 }, distribution: { type: "uniform" } },
      { name: "X_SIGMA",     nominal: 100, uncertainty: { type: "sigma", sigma: 1.5 }, distribution: { type: "normal", sigma_level: 3 } },
    ];
    const evalF = (v: Record<string, number>) =>
      v["X_UNIFORM"] + v["X_NORMAL_3S"] + v["X_NORMAL_2S"] + v["X_RANGE"] + v["X_ABS"] + v["X_SIGMA"];
    const r = propagate(inps, evalF, 600, "worst_case");
    assertApprox(r.min, 572.5, 0.1);
    assertApprox(r.max, 627.5, 0.1);
  });
});