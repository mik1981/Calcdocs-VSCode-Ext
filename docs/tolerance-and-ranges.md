# Tolerance propagation & distribution analysis

CalcDocs propagates **uncertainty** through your engineering formulas using real
Monte Carlo simulation. The Distribution tab of the Interactive Formula Viewer
shows the **empirical histogram** built directly from the sampled output population —
not a theoretical curve, not a CDF reconstruction.

---

## The three-level model

Every tolerance specification in a `formulas*.yaml` file is described at three
independent levels. They must not be mixed on the same field.

| Level | Field | What it describes | Values |
|-------|-------|-------------------|--------|
| 1 | `uncertainty` | How wide is the input variation band | `percent`, `range`, `absolute`, `sigma` |
| 2 | `distribution` | How the value is distributed inside that band | `uniform`, `normal`, `triangular` |
| 3 | `propagation` | Which bound is reported on the **output** formula | `worst_case`, `rss`, `monte_carlo` |

Level 3 (`propagation`) is declared on the **output formula**, never on the input
constant. The engine always samples every input according to its `distribution.type`,
runs N=10 000 simulations, and computes the real output histogram. `propagation`
only controls **which percentile is shown as min/max**:

| `propagation` | Reported min/max | Physical meaning |
|---------------|-----------------|-----------------|
| `worst_case`  | absolute min/max of all samples | 100% coverage guarantee |
| `rss`         | mean ± 3 × σ of the output samples | ~99.7% coverage assuming the output is roughly normal |
| `monte_carlo` | confidence-level percentiles (default 95 % → p2.5/p97.5) | probabilistic confidence interval |

> **Key insight**: all three methods produce the same underlying empirical
> distribution (same histogram). They differ only in what bound they report.
> If you need to see the full shape, the Distribution tab shows the real
> histogram regardless of which `propagation` is declared.

---

## Declaring uncertainty on an input

```yaml
# Minimal: percent tolerance, uniform distribution (most common)
R1:
  type: const
  value: 100
  unit: ohm
  uncertainty:
    type: percent
    value: 5          # ±5 % → samples drawn uniformly from [95, 105]
  distribution:
    type: uniform
```

```yaml
# Component with datasheet Gaussian tolerance at ±2σ
VREF:
  type: const
  value: 2.500
  unit: V
  uncertainty:
    type: percent
    value: 1          # ±1 %
  distribution:
    type: normal
    sigma_level: 2    # hw = 0.025 V, σ = 0.025/2 = 0.0125 V
```

```yaml
# Absolute range from a datasheet spec
CURRENT_SOURCE:
  type: const
  value: 0.500
  unit: A
  uncertainty:
    type: range
    min: 0.480
    max: 0.520
  distribution:
    type: uniform
```

```yaml
# Direct sigma: σ is known, derive the 3σ range automatically
SENSOR_NOISE:
  type: const
  value: 0.0
  unit: V
  uncertainty:
    type: sigma
    sigma: 0.002      # σ = 2 mV → 3σ range = ±6 mV
  distribution:
    type: normal
    sigma_level: 3
```

### Supported `uncertainty.type` values

| Type | Required fields | Meaning |
|------|----------------|---------|
| `percent` | `value` | ±N% of the nominal value |
| `range` | `min`, `max` | absolute interval [min, max] |
| `absolute` | `absolute` | ±absolute around nominal |
| `sigma` | `sigma` | 3σ band = nominal ± 3·sigma |

### Supported `distribution.type` values

| Type | Field | Sampling rule |
|------|-------|--------------|
| `uniform` | — | samples drawn uniformly in [lower, upper] |
| `normal` | `sigma_level` | Gaussian; σ = halfWidth / sigma_level |
| `triangular` | — | triangular peak at nominal; σ = halfWidth / √6 |

---

## Declaring propagation on an output formula

```yaml
POWER:
  type: expr
  formula: VIN * CURRENT
  unit: W
  propagation: worst_case   # or rss, or monte_carlo
```

`propagation` is optional. If omitted, the engine uses `worst_case` as default.

### Optional propagation parameters

```yaml
POWER_MC:
  type: expr
  formula: VIN * CURRENT
  unit: W
  propagation: monte_carlo
  confidence: 95    # default 95 → bounds at p2.5 / p97.5
  samples: 10000    # default 10 000
  seed: 42          # optional: fixed seed for reproducibility
```

---

## Per-parameter tolerance overrides

A formula can assign a tolerance to a dependency that has none declared, or
override the dependency's own tolerance for this specific propagation path:

```yaml
BASE_R:
  type: const
  value: 1000
  unit: ohm
  # no uncertainty declared here

BRIDGE_OUT:
  type: expr
  formula: SUPPLY * BASE_R / (BASE_R + 1000)
  unit: V
  propagation: worst_case
  parameter_tolerances:
    BASE_R:
      uncertainty:
        type: percent
        value: 1          # 1 % override for this formula only
      distribution:
        type: uniform
```

---

## Distribution tab in the Interactive Formula Viewer

When a formula has `propagation:` declared (or an input has `uncertainty:` +
`distribution:`), the **Distribution** tab shows:

- **For output formulas**: the empirical histogram of the N output samples, with
  confidence bounds, mean (μ), standard deviation (σ), P2.5, P97.5, sample count.
- **For input constants**: the root sample histogram (how the input itself is
  distributed before flowing into any formula).

The histogram is computed entirely by the engine before being sent to the webview.
The webview only renders the pre-computed `histogram.counts[]` array — no
theoretical approximation, no synthetic samples, no CDF interpolation.

### What the badge means

| Badge | `propagation` value | Meaning |
|-------|--------------------|---------| 
| **MC — bound min/max** | `worst_case` | Real MC samples; bound = absolute extremes |
| **MC — bound μ±3σ** | `rss` | Real MC samples; bound = mean ± 3·stddev on samples |
| **Monte Carlo** | `monte_carlo` | Real MC samples; bound = confidence percentiles |

All three show the **same underlying distribution shape**. The badge describes
only the bound selection rule, not the sampling method (which is always real MC).

---

## Legacy format (still accepted, emit warnings)

The old `tol`, `tol_mode`, `sigma` fields are still parsed and internally
converted to the three-level model. They emit `WARN` diagnostics.

```yaml
# Legacy — accepted with warnings
X_OLD:
  type: const
  value: 100
  tol: 5                # WARN → uncertainty: { type: percent, value: 5 }
  tol_mode: gaussian    # WARN → distribution: { type: normal }
  sigma: 2              # WARN → distribution: { sigma_level: 2 }
```

Prefer the explicit three-level format for new work. See
[examples/formulas_model_modes_expected.yaml] for the modern equivalent.

---

## What does NOT trigger the Distribution tab

These patterns produce a tolerance **range widget** (the bar in the header and
Dependency Tree) but **no histogram**, because no sampling population exists:

- A constant with `min`/`max` declared directly at the top level (old style):
  ```yaml
  VREF: { value: 2.5, min: 2.48, max: 2.52 }   # range shown, no histogram
  ```
- A formula with no `propagation:` and no dependency with `uncertainty:`:
  ```yaml
  GAIN: { formula: R2 / R1 }                     # no range at all
  ```
- A formula whose dependencies have no declared `uncertainty:` or
  `parameter_tolerances:`.

---

## Practical tips

- Always pair `uncertainty:` with `distribution:` on every input that varies.
  Missing `distribution:` → engine defaults to `uniform` and emits a warning.
- Use `seed:` during development for reproducible bounds; remove it for final
  analysis so the confidence interval reflects true variability.
- For non-linear formulas (`X²`, divisions, `csv()` lookups), `worst_case` and
  `rss` may disagree significantly. Use `monte_carlo` to see the true shape.
- `rss` makes sense when the output distribution is approximately Gaussian
  (linear formulas, many inputs). For single-input non-linear cases, prefer
  `worst_case` or `monte_carlo`.
- Deep dependency chains (A → B → C → formula) propagate correctly: each
  intermediate formula's sample population flows into the next level.

---

## See also

- `docs/TOLERANCE_ARCHITECTURE.md` — engine internals and data flow
- `examples/formulas_model_modes_expected.yaml` — all propagation modes, annotated
- `examples/formulas_distribution_edge_cases.yaml` — edge cases and improper use
- `examples/cases/15_tolerance_propagation/` — realistic component chain example
