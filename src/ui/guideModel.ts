import type {
  DistributionSpec,
  PropagationMethod,
  UncertaintySpec,
  UncertaintyType,
} from "../types/toleranceModel";
import {
  computeStdDev,
  normalizeUncertainty,
  type NormalizedUncertainty,
} from "../types/toleranceModel";
import { propagate, runMonteCarlo, type UnifiedInput } from "../engine/monteCarlo";
import type { PropagationResult, OutputDistribution, PropagationSpec } from "../types/toleranceModel";

export type GuideInputDistribution = "uniform" | "normal" | "triangular";

export type GuideUncertainty = {
  type: UncertaintyType;
  value: number; // for percent/absolute/sigma; ignored for range
  range?: { min: number; max: number };
};

export type GuideScenario = {
  nominal: number;
  uncertainty: GuideUncertainty;
  distribution: DistributionSpec;
  propagation: PropagationMethod;
  confidence: number;
  seed: number;
  samples?: number;
  formulaKind: "linear" | "square" | "sum" | "product";
};

function buildUncertaintySpec(u: GuideUncertainty): UncertaintySpec {
  switch (u.type) {
    case "percent":
      return { type: "percent", value: u.value };
    case "absolute":
      return { type: "absolute", absolute: u.value };
    case "sigma":
      return { type: "sigma", sigma: u.value };
    case "range":
      return {
        type: "range",
        min: u.range?.min,
        max: u.range?.max,
      };
  }
}

function normalizeInput(
  nominal: number,
  u: GuideUncertainty
): NormalizedUncertainty | undefined {
  const unc = buildUncertaintySpec(u);
  return normalizeUncertainty(unc, nominal);
}

function buildDistributionSpec(d: GuideInputDistribution, sigmaLevel: number): DistributionSpec {
  if (d === "normal") return { type: "normal", sigma_level: sigmaLevel };
  if (d === "triangular") return { type: "triangular" };
  return { type: "uniform" };
}

function pickOutputMethodLabel(method: PropagationMethod): string {
  if (method === "worst_case") return "worst_case";
  if (method === "rss") return "rss";
  return "monte_carlo";
}

export type GuideComputed = {
  nominal: number;
  range: { min: number; max: number };
  method: PropagationMethod;
  stddev?: number;
  distribution?: OutputDistribution;
  contributingInputs: string[];
  detectedMode: "uniform_only" | "mixed_mc_rss";
};

function shouldTreatAsUniformOnly(scenario: GuideScenario): boolean {
  // Riferimento: motore supporta: rss/worst_case/monte_carlo.
  // La rappresentazione “attuale” della guida (barre WC/RSS) è corretta solo quando la
  // propagazione può essere rappresentata come intervalli deterministici senza mostrare
  // forma della distribuzione finale derivata da MC.
  // Condizione conservativa: se la propagation è uniform-only e tutti gli input usano uniform.
  // Nella guida attuale consideriamo 2 input identici per sum/product.
  const distType = scenario.distribution.type;
  return scenario.propagation === "rss" || scenario.propagation === "worst_case" ? distType === "uniform" : false;
}

export function computeGuideScenario(s: GuideScenario): GuideComputed {
  const inputs: UnifiedInput[] = [];

  // La guida attuale disegna distribuzioni per una singola variabile X (dist-canvas)
  // e per formula interattiva con opzionalmente due variabili (sum/product).
  // Per coerenza col motore, mappiamo:
  // - linear/square: usa X
  // - sum/product: usa X1 e X2 (entrambi con stessi parametri)
  const buildUncAndDist = (): { uncertainty: UncertaintySpec; distribution: DistributionSpec } => {
    const uncertainty = buildUncertaintySpec(s.uncertainty);
    return { uncertainty, distribution: s.distribution };
  };

  const base = buildUncAndDist();

  const nominal = s.nominal;

  if (s.formulaKind === "linear" || s.formulaKind === "square") {
    inputs.push({ name: "X", nominal, uncertainty: base.uncertainty, distribution: base.distribution });
  } else {
    inputs.push({ name: "X1", nominal, uncertainty: base.uncertainty, distribution: base.distribution });
    inputs.push({ name: "X2", nominal, uncertainty: base.uncertainty, distribution: base.distribution });
  }

  const evalFn = (v: Record<string, number>): number => {
    const x = s.formulaKind === "linear" || s.formulaKind === "square" ? v["X"] : v["X1"];
    if (s.formulaKind === "linear") return x;
    if (s.formulaKind === "square") return x * x;
    if (s.formulaKind === "sum") return v["X1"] + v["X2"];
    return v["X1"] * v["X2"];
  };

  // nominalOutput: nominal della formula
  const nominalOutput = (() => {
    if (s.formulaKind === "linear") return nominal;
    if (s.formulaKind === "square") return nominal * nominal;
    if (s.formulaKind === "sum") return nominal + nominal;
    return nominal * nominal;
  })();

  const uniformOnly = shouldTreatAsUniformOnly(s);

  // “misto”: per altre distribuzioni o propagation=monte_carlo, ricorriamo a MC o a rss/worst_case ma i grafici
  // devono riflettere l’andamento derivato. In entrambi i casi il range è calcolato dal motore.
  if (uniformOnly) {
    const prop = propagate(inputs, evalFn, nominalOutput, s.propagation);
    return {
      nominal,
      range: { min: prop.min, max: prop.max },
      method: prop.method,
      stddev: prop.stddev,
      distribution: prop.distribution,
      contributingInputs: prop.contributingInputs,
      detectedMode: "uniform_only",
    };
  }

  // Forza MC quando propagation=monte_carlo; per rss/worst_case manteniamo metodo
  // ma i grafici devono essere costruiti usando campioni (se monte_carlo).
  const propSpec: PropagationSpec | undefined = s.propagation === "monte_carlo"
    ? { method: "monte_carlo", confidence: s.confidence, samples: s.samples, seed: s.seed }
    : { method: s.propagation, confidence: s.confidence, samples: s.samples, seed: s.seed };

  // Propagate dispatcher usa MC per monte_carlo con seed/confidence.
  const prop = propagate(inputs, evalFn, nominalOutput, s.propagation, {
    seed: s.seed,
    confidence: s.confidence,
    samples: s.samples,
  });

  return {
    nominal,
    range: { min: prop.min, max: prop.max },
    method: prop.method,
    stddev: prop.stddev,
    distribution: prop.distribution,
    contributingInputs: prop.contributingInputs,
    detectedMode: "mixed_mc_rss",
  };
}

