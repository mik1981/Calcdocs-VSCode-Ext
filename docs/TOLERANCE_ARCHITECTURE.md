# CalcDocs — Tolerance Architecture

## Overview

CalcDocs propagates uncertainty through formula dependency chains using **real
Monte Carlo simulation**. Every combination of `uncertainty:` + `distribution:`
on an input generates a `Float64Array` of N samples (default 10 000). Those
sample arrays flow through the formula tree, evaluated expression-by-expression,
producing an empirical output distribution with a pre-computed histogram.

The `propagation:` field on an output formula only selects **which bound to
report** as min/max — it does not change the sampling algorithm.

---

## Core separation: declaration vs result

| Concept | Field | Where it lives | Populated by |
|---------|-------|----------------|--------------|
| Input specification | `tolerance` | `CoreFormulaEntry.tolerance` | `formulaYaml.ts` → `parseToleranceSpec()` |
| Computed result | `toleranceResult` | `CoreFormulaEntry.toleranceResult` | `yamlEngine.ts` + `interactiveFormulaEngine.ts` |

`toleranceResult` always contains a complete `PropagationResult`, including:
- `method` — the bound-selection rule (`worst_case` / `rss` / `monte_carlo`)
- `min`, `max` — the selected bound
- `nominalValue`, `stddev` — statistics from the sample population
- `distribution` — full `OutputDistribution` with pre-computed `histogram.counts[]`

---

## Data flow (9 stages)

```
YAML file
  ↓ parseFormulaYamlText() / normalizeFormulaYamlNode()     [formulaYaml.ts]
ParsedFormulaYamlEntry { tolerance: FormulaToleranceSpec }
  ↓ evaluateYamlDocument()                                   [yamlEngine.ts]
EvaluatedYamlSymbol { range: PropagationResult & {source} }
  ↓ rebuildFormulaIndexWithEngine()                          [analysis.ts]
CoreFormulaEntry { toleranceResult: PropagationResult & {source} }
  ↓ buildInteractiveFormulaEntries() / createFormulaEntry()  [interactiveFormulaEngine.ts]
FormulaEntry (webview) { range: {..., distribution: OutputDistribution} }
  ↓ postMessage / JSON.stringify                             [interactiveView.ts]
  ↓ renderDistributionPanel() / renderDistHistogram()        [interactive_webview_class.html]
SVG histogram (from histogram.counts[], no reconstruction)
```

---

## Sample generation

### Root samples (input constants with `uncertainty` + `distribution`)

`yamlEngine.ts` → `getOrBuildSamples()` → `generateRootSamples()` in `monteCarlo.ts`:

```typescript
// For: uncertainty: { type: percent, value: 5 }, distribution: { type: normal, sigma_level: 2 }
// nominal = 100  → lower = 95, upper = 105, halfWidth = 5, σ = 5/2 = 2.5
generateRootSamples(uncertainty, distribution, nominal, N, prng)
// → Float64Array of N Gaussian samples μ=100, σ=2.5
```

The sample array is stored in `sampleCache` (keyed by symbol name) so that
formulas consuming the same input reuse the same population.

### Formula propagation

`propagateFromSamples()` evaluates the expression N times, using index `i` across
all input arrays simultaneously:

```typescript
for (let i = 0; i < N; i++) {
  for (const name of inputNames) scratch[name] = inputSamples[name][i];
  output[i] = evaluateOne(scratch);   // real AST evaluation
}
```

This correctly handles non-linear formulas, cascaded dependencies, and mixed
distributions — the output histogram emerges from the actual formula, not from
any analytical approximation.

### Histogram construction

`computeOutputDistribution(sorted: Float64Array)` in `monteCarlo.ts`:

```typescript
export const HISTOGRAM_BINS = 32;

// Counts are assigned in a single linear pass over the sorted sample array.
// counts[i] = number of samples in bin [lo + i*(hi-lo)/BINS, lo + (i+1)*(hi-lo)/BINS)
for (let i = 0; i < n; i++) {
  const bin = Math.min(BINS - 1, Math.floor((sorted[i] - lo) / range * BINS));
  counts[bin]++;
}
```

The `histogram: { counts, lo, hi }` field is part of every `OutputDistribution`
returned by the engine. The webview receives this pre-computed array and renders
it directly — no CDF interpolation, no synthetic sampling, no theoretical curves.

---

## Bound selection by `propagation` method

All three methods receive the **same sample array**. They differ only in computing
`min` and `max`:

```typescript
function resultFromSamples(rawOutput, method, inputs, confidence = 95) {
  const sorted = rawOutput.slice().sort();
  const dist   = computeOutputDistribution(sorted);

  let min: number, max: number;
  if (method === "worst_case") {
    min = dist.min;  max = dist.max;          // absolute extremes
  } else if (method === "rss") {
    const delta = 3 * dist.stddev;
    min = dist.mean - delta;  max = dist.mean + delta;  // mean ± 3σ on real samples
  } else {
    const tail = (100 - confidence) / 2;
    min = pct(sorted, tail);  max = pct(sorted, 100 - tail);  // confidence percentiles
  }
  return { method, min, max, nominalValue: dist.mean, stddev: dist.stddev, distribution: dist, ... };
}
```

---

## Key components

### `src/core/formulaYaml.ts`
Parses the three-level tolerance declaration. Converts legacy fields (`tol`,
`tol_mode`, `sigma`) to the structured model with warnings. Exports
`parseToleranceSpec()`, `normalizeFormulaYamlNode()`.

### `src/engine/yamlEngine.ts`
Static evaluation: runs `getOrBuildSamples()` for all symbols in dependency
order, computes `EvaluatedYamlSymbol.range` with full `distribution` including
`histogram`. The `sampleCache` (keyed by symbol name within one document
evaluation) prevents redundant sample generation.

### `src/engine/monteCarlo.ts`
Core sampling engine. Public API:
- `buildPrng(seed?)` — xoshiro128** PRNG
- `generateRootSamples(uncertainty, distribution, nominal, N, prng)` → `Float64Array`
- `fillSamples(out, spec, prng)` — uniform / normal (Box-Muller) / triangular
- `propagateFromSamples(inputSamples, evalFn, N)` → `Float64Array`
- `computeOutputDistribution(sorted)` → `OutputDistribution` with `histogram`
- `resultFromSamples(raw, method, inputs, confidence?)` → `PropagationResult`
- `HISTOGRAM_BINS = 32` — fixed bin count for consistent payload size (~128 bytes)
- `DEFAULT_MC_SAMPLES = 10_000`

### `src/ui/interactiveFormulaEngine.ts`
Live evaluation for the webview. `getOrBuildSamples()` is a private recursive
method of `InteractiveFormulaEngine` that mirrors the static engine's logic,
using a per-`evaluate()` `sampleCache` that is reset on every slider move so
that updated nominal values produce updated populations.

The `liveRanges` map (built inside `evaluate()`) covers both formula nodes
(full recursive MC) and const nodes with `uncertainty:` (root samples computed
with the current slider value).

### `src/ui/interactiveView.ts`
Bridges the engine and the webview. `buildTransientYamlEntries()` uses
`...spread` (not manual field copy) when assigning `toleranceResult`, so that
`method` and `distribution.histogram` are never dropped.

### `resources/interactive_webview_class.html`
Pure rendering. `renderDistHistogram(range, nominal, isOutput)`:
1. Checks `range.distribution.histogram.counts` — if present, renders directly.
2. If absent (static range without sampling, e.g. old-style `min`/`max` on a
   constant), shows a placeholder — never synthesizes samples or reconstructs
   from percentiles.

---

## Three-level model validation rules

| Situation | Engine behaviour |
|-----------|-----------------|
| `uncertainty:` without `distribution:` | Defaults to `uniform`, emits WARN |
| `propagation:` without any input having `uncertainty:` | Range is undefined; Distribution tab is empty |
| `distribution:` without `uncertainty:` | Ignored; no range computed |
| `uncertainty.type: percent` + `sigma:` field | Validation error: `sigma` not allowed for `percent` type |
| `uncertainty.type: range` + `value:` field | Validation error: `value` not allowed for `range` type |
| Legacy `tol:` | Converted to `uncertainty: {type: percent, value: N}` + `distribution: {type: uniform}` |
| Legacy `tol_mode: gaussian` + `sigma: K` | Converted to `distribution: {type: normal, sigma_level: K}` |

---

## Common pitfalls

### 1. `parameter_tolerances` on a formula used without `propagation:`
The overrides are parsed and stored, but no range is computed because the output
has no propagation method. Add `propagation: worst_case` (or another method) to
the formula.

### 2. Deep chain with intermediate formula having no `propagation:`
```yaml
A: { value: 100, uncertainty: {type: percent, value: 5}, distribution: {type: uniform} }
B: { formula: A * 2 }       # ← no propagation: → no range on B
C: { formula: B + 10, propagation: worst_case }  # ← no samples from B
```
B's sample population is not computed (it has no `propagation:`), so C sees B
as a fixed scalar. **Fix**: add `propagation:` to B, or merge into a single
formula `C: { formula: A * 2 + 10, propagation: worst_case }`.

### 3. Constant with `min`/`max` at the top level (no `uncertainty:` block)
```yaml
VREF: { value: 2.5, min: 2.48, max: 2.52 }   # old style
```
This is a legacy range declaration. It produces a range widget in the UI but no
sample population, so no histogram appears. Migrate to:
```yaml
VREF:
  value: 2.5
  uncertainty: { type: range, min: 2.48, max: 2.52 }
  distribution: { type: uniform }
```

### 4. `propagation: rss` on a highly non-linear formula
`rss` reports `mean ± 3σ` of the **real samples**. For non-linear formulas
(e.g., `X²`), the output distribution is skewed and `mean ± 3σ` may not
represent the actual coverage well. The Distribution tab histogram will show
the true asymmetric shape regardless; only the reported bounds differ.
Use `worst_case` for guaranteed coverage or `monte_carlo` for a
confidence-interval-based bound.

---

## Testing

- `examples/formulas_model_modes_expected.yaml` — annotated reference for all
  propagation modes with expected values
- `examples/formulas_distribution_edge_cases.yaml` — edge cases, improper use,
  validation errors
- `src/engine/__tests__/mcPipeline.test.ts` — end-to-end pipeline tests
  (42 cases including histogram shape, bound selection, regression for the
  `buildTransientYamlEntries` spread bug)
