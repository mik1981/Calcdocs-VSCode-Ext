import type { PropagationMethod, PropagationResult, OutputDistribution, DistributionSpec } from "../types/toleranceModel";
import { computeStdDev, normalizeUncertainty, recommendedSamples } from "../types/toleranceModel";
import type { McSampleSpec } from "./tolerance";


// ── PRNG: xoshiro128** ────────────────────────────────────────────────────────
type Prng = () => number;
export function buildPrng(seed?: number): Prng {
  let s = (seed ?? Date.now()) >>> 0;
  const sm = (): number => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = sm(), b = sm(), c = sm(), d = sm();
  const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
  return () => {
    const t = (b << 9) >>> 0;
    const result = Math.imul(rotl(Math.imul(b, 5) >>> 0, 7), 9) >>> 0;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotl(d, 11);
    return result / 0x100000000;
  };
}

// ── Box-Muller ────────────────────────────────────────────────────────────────
function gaussianPair(u1: number, u2: number): [number, number] {
  const r = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-15)));
  const theta = 2 * Math.PI * u2;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

// ── Sampling ──────────────────────────────────────────────────────────────────
function fillSamples(out: Float64Array, spec: McSampleSpec, prng: Prng): void {
  const n = out.length;
  const { lower, upper, nominal, distribution, stdDev } = spec;
  switch (distribution) {
    case "uniform":
      for (let i = 0; i < n; i++) out[i] = lower + prng() * (upper - lower);
      return;
    case "normal": {
      const mu = (lower + upper) / 2;
      for (let i = 0; i < n - 1; i += 2) {
        const [z0, z1] = gaussianPair(prng(), prng());
        out[i] = mu + z0 * stdDev; out[i + 1] = mu + z1 * stdDev;
      }
      if (n % 2 === 1) { const [z0] = gaussianPair(prng(), prng()); out[n-1] = mu + z0 * stdDev; }
      return;
    }
    case "triangular": {
      const range = upper - lower;
      if (range <= 0) { out.fill(nominal); return; }
      const fc = (nominal - lower) / range;
      for (let i = 0; i < n; i++) {
        const u = prng();
        out[i] = u < fc
          ? lower + Math.sqrt(u * range * (nominal - lower))
          : upper - Math.sqrt((1 - u) * range * (upper - nominal));
      }
      return;
    }
  }
}

// ── Statistiche ───────────────────────────────────────────────────────────────
function pct(sorted: Float64Array, p: number): number {
  if (!sorted.length) return NaN;
  const idx = Math.max(0, Math.min(sorted.length - 1, (p / 100) * (sorted.length - 1)));
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

/** Number of histogram bins. Fixed so the webview never needs to choose. */
export const HISTOGRAM_BINS = 32;

export function computeOutputDistribution(sorted: Float64Array): OutputDistribution {
  const n = sorted.length;
  if (n === 0) {
    const empty: OutputDistribution = {
      samples: 0, mean: NaN, median: NaN, stddev: NaN,
      min: NaN, max: NaN,
      p001: NaN, p010: NaN, p025: NaN, p500: NaN,
      p975: NaN, p990: NaN, p999: NaN,
      skewness: NaN, kurtosis: NaN,
      histogram: { counts: new Array(HISTOGRAM_BINS).fill(0), lo: NaN, hi: NaN },
    };
    return empty;
  }

  let sum = 0; for (let i = 0; i < n; i++) sum += sorted[i];
  const mean = sum / n;
  let v2 = 0, s3 = 0, k4 = 0;
  for (let i = 0; i < n; i++) { const d = sorted[i] - mean; v2 += d*d; s3 += d*d*d; k4 += d*d*d*d; }
  const stddev = Math.sqrt(v2 / n);

  const lo = sorted[0];
  const hi = sorted[n - 1];

  // Build histogram directly from the sorted sample array.
  // Using the sorted array lets us do a single linear pass with a pointer.
  const counts = new Array<number>(HISTOGRAM_BINS).fill(0);
  if (lo < hi) {
    const range = hi - lo;
    for (let i = 0; i < n; i++) {
      const bin = Math.min(HISTOGRAM_BINS - 1, Math.floor((sorted[i] - lo) / range * HISTOGRAM_BINS));
      counts[bin]++;
    }
  } else {
    // All samples identical → single spike in the middle bin
    counts[Math.floor(HISTOGRAM_BINS / 2)] = n;
  }

  return {
    samples: n, mean, median: pct(sorted, 50), stddev,
    min: lo, max: hi,
    p001: pct(sorted, 0.1), p010: pct(sorted, 1), p025: pct(sorted, 2.5),
    p500: pct(sorted, 50),
    p975: pct(sorted, 97.5), p990: pct(sorted, 99), p999: pct(sorted, 99.9),
    skewness: stddev > 0 ? (s3 / n) / stddev ** 3 : 0,
    kurtosis: stddev > 0 ? (k4 / n) / stddev ** 4 - 3 : 0,
    histogram: { counts, lo, hi },
  };
}

// ── Interfacce ────────────────────────────────────────────────────────────────
export interface McOptions { samples?: number; seed?: number; confidence?: number; }

export interface RssSensitivityInput { name: string; sensitivity: number; stdDev: number; }
export interface WcSensitivityInput  { name: string; sensitivity: number; upEffect: number; downEffect: number; }

export interface UnifiedInput {
  name: string;
  nominal: number;
  uncertainty: import("../types/toleranceModel").UncertaintySpec;
  distribution: DistributionSpec;
}

// ── Monte Carlo ───────────────────────────────────────────────────────────────
export function runMonteCarlo(
  inputs: McSampleSpec[],
  evaluate: (values: Record<string, number>) => number,
  options: McOptions = {},
): PropagationResult {
  const N          = options.samples  ?? recommendedSamples(inputs.length);
  const confidence = options.confidence ?? 95;
  const tail       = (100 - confidence) / 2;
  const prng       = buildPrng(options.seed);
  const arrays     = inputs.map(inp => { const a = new Float64Array(N); fillSamples(a, inp, prng); return a; });
  const output     = new Float64Array(N);
  const scratch: Record<string, number> = {};
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < inputs.length; j++) scratch[inputs[j].name] = arrays[j][i];
    output[i] = evaluate(scratch);
  }
  output.sort();
  const dist = computeOutputDistribution(output);
  return {
    method: "monte_carlo",
    min: pct(output, tail), max: pct(output, 100 - tail),
    nominalValue: dist.mean, stddev: dist.stddev,
    distribution: dist,
    contributingInputs: inputs.map(i => i.name),
  };
}

// ── RSS ───────────────────────────────────────────────────────────────────────
export function runRss(inputs: RssSensitivityInput[], nominal: number, sigmaOut = 3): PropagationResult {
  let sumSq = 0;
  for (const inp of inputs) sumSq += inp.sensitivity ** 2;
  const stddev = Math.sqrt(sumSq);
  const delta  = sigmaOut * stddev;
  return { method: "rss", min: nominal - delta, max: nominal + delta, nominalValue: nominal, stddev, contributingInputs: inputs.map(i => i.name) };
}








export function runWorstCase(inputs: WcSensitivityInput[], nominal: number): PropagationResult {
  let totUp = 0;
  let totDown = 0;

  for (const inp of inputs) {
    // Trova il reale contributo minimo (più basso) e massimo (più alto) tra i due scenari
    totDown += Math.min(inp.upEffect, inp.downEffect);
    totUp   += Math.max(inp.upEffect, inp.downEffect);
  }

  return { 
    method: "worst_case", 
    min: nominal + totDown, 
    max: nominal + totUp, 
    nominalValue: nominal, 
    contributingInputs: inputs.map(i => i.name), 
    stddev: (totUp - totDown) / 6 
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
export function propagate(
  inputs: UnifiedInput[],
  evaluate: (values: Record<string, number>) => number,
  nominalOutput: number,
  method: PropagationMethod,
  options: McOptions = {},
): PropagationResult {
  if (inputs.length === 0) return { method, min: nominalOutput, max: nominalOutput, nominalValue: nominalOutput, contributingInputs: [] };

  if (method === "monte_carlo") {
    const specs: McSampleSpec[] = [];
    for (const inp of inputs) {
      const norm = normalizeUncertainty(inp.uncertainty, inp.nominal);
      if (!norm) continue;
      const dk = inp.distribution.type === "normal" ? "normal" : inp.distribution.type === "triangular" ? "triangular" : "uniform";
      specs.push({ name: inp.name, nominal: inp.nominal, lower: norm.lower, upper: norm.upper, distribution: dk, sigmaLevel: inp.distribution.type === "normal" ? (inp.distribution.sigma_level ?? 3) : 1, stdDev: computeStdDev(norm, inp.distribution) });
    }
    return runMonteCarlo(specs, evaluate, options);
  }

  const nominals: Record<string, number> = {};
  const hws:  Record<string, number> = {};
  const sds:  Record<string, number> = {};
  for (const inp of inputs) {
    nominals[inp.name] = inp.nominal;
    const norm = normalizeUncertainty(inp.uncertainty, inp.nominal);
    hws[inp.name] = norm?.halfWidth ?? 0;
    sds[inp.name] = norm ? computeStdDev(norm, inp.distribution) : 0;
  }

  if (method === "rss") {
    const rssInputs = inputs.map(inp => {
      const hw = hws[inp.name];
      if (hw <= 0) return { name: inp.name, sensitivity: 0, stdDev: 0 };
      const vP = { ...nominals, [inp.name]: inp.nominal + hw };
      const vM = { ...nominals, [inp.name]: inp.nominal - hw };
      const dfdx = (evaluate(vP) - evaluate(vM)) / (2 * hw);
      return { name: inp.name, sensitivity: dfdx * sds[inp.name], stdDev: sds[inp.name] };
    });
    return runRss(rssInputs, nominalOutput, 3);
  }

  const wcInputs = inputs.map(inp => {
    const hw = hws[inp.name];
    if (hw <= 0) return { name: inp.name, sensitivity: 0, upEffect: 0, downEffect: 0 };
    const vP = { ...nominals, [inp.name]: inp.nominal + hw };
    const vM = { ...nominals, [inp.name]: inp.nominal - hw };
    const effectUp   = evaluate(vP) - nominalOutput;
    const effectDown = evaluate(vM) - nominalOutput;
    const sensitivity = (effectUp - effectDown) / 2;
    return { name: inp.name, sensitivity, upEffect: effectUp, downEffect: effectDown };
  });
  return runWorstCase(wcInputs, nominalOutput);
}

export type { McSampleSpec as McInput };


/* ════════════════════════════════════════════════════════════════════════
 * RECURSIVE SAMPLING PROPAGATION
 *
 * Model: "worst_case" / "rss" / "monte_carlo" are NOT alternative
 * propagation algorithms. They only select which percentile bound is
 * reported for a given node. The actual population is ALWAYS generated
 * by real sampling (root inputs sampled per their distribution.type,
 * then every formula in the dependency chain is evaluated sample-by-
 * sample). This guarantees that a formula consuming another formula's
 * output inherits its true empirical shape instead of being flattened
 * to a synthetic uniform approximation.
 * ════════════════════════════════════════════════════════════════════════ */

export const DEFAULT_MC_SAMPLES = 10_000;

/** Generates the root sample population for a single input with declared uncertainty + distribution. */
export function generateRootSamples(
  uncertainty: import("../types/toleranceModel").UncertaintySpec,
  distribution: DistributionSpec,
  nominal: number,
  n: number,
  prng: Prng
): Float64Array | undefined {
  const norm = normalizeUncertainty(uncertainty, nominal);
  if (!norm) return undefined;
  const dk: McSampleSpec["distribution"] =
    distribution.type === "normal" ? "normal" :
    distribution.type === "triangular" ? "triangular" : "uniform";
  const spec: McSampleSpec = {
    name: "", nominal,
    lower: norm.lower, upper: norm.upper,
    distribution: dk,
    sigmaLevel: distribution.type === "normal" ? (distribution.sigma_level ?? 3) : 1,
    stdDev: computeStdDev(norm, distribution),
  };
  const out = new Float64Array(n);
  fillSamples(out, spec, prng);
  return out;
}

/**
 * Evaluates a formula sample-by-sample using already-generated sample arrays
 * for each dependency (which may themselves be root samples OR the output
 * samples of another already-propagated formula — the function does not
 * care which, it only consumes Float64Array populations).
 *
 * `evaluateOne(sampleValues)` must evaluate the formula for a single set of
 * scalar dependency values (index i across all input arrays) and return a
 * number, or NaN if evaluation failed for that sample.
 */
export function propagateFromSamples(
  inputSamples: Record<string, Float64Array>,
  evaluateOne: (values: Record<string, number>) => number,
  n: number
): Float64Array {
  const names = Object.keys(inputSamples);
  const output = new Float64Array(n);
  const scratch: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    for (const name of names) scratch[name] = inputSamples[name][i];
    const v = evaluateOne(scratch);
    output[i] = Number.isFinite(v) ? v : NaN;
  }
  return output;
}

/**
 * Builds a PropagationResult from a real output sample population.
 * `method` only selects which bound is reported as min/max:
 *  - worst_case  -> absolute extremes of the sampled population (percentile 0/100)
 *  - rss         -> mean ± 3*stddev computed on the REAL samples (not analytic)
 *  - monte_carlo -> confidence-level percentiles (default 95% -> 2.5/97.5)
 * In every case `distribution` carries the full empirical OutputDistribution,
 * so downstream consumers (UI, or a parent formula re-sampling this node)
 * always have the true shape available.
 */
export function resultFromSamples(
  rawOutput: Float64Array,
  method: PropagationMethod,
  contributingInputs: string[],
  confidence = 95
): PropagationResult {
  
  let validCount = 0;
  for (let i = 0; i < rawOutput.length; i++) if (Number.isFinite(rawOutput[i])) validCount++;
  let clean: Float64Array;
  if (validCount === rawOutput.length) {
    clean = rawOutput;
  } else {
    clean = new Float64Array(validCount);
    let j = 0;
    for (let i = 0; i < rawOutput.length; i++) if (Number.isFinite(rawOutput[i])) clean[j++] = rawOutput[i];
  }
  const sorted = clean.slice().sort();
  const dist = computeOutputDistribution(sorted);

  let min: number, max: number;
  if (method === "worst_case") {
    min = dist.min;
    max = dist.max;
  } else if (method === "rss") {
    const delta = 3 * dist.stddev;
    min = dist.mean - delta;
    max = dist.mean + delta;
  } else {
    const tail = (100 - confidence) / 2;
    min = pct(sorted, tail);
    max = pct(sorted, 100 - tail);
  } // worst_case uses dist.min and dist.max

  return {
    method,
    min, max,
    nominalValue: dist.mean,
    stddev: dist.stddev,
    distribution: dist,
    contributingInputs,
  };
}