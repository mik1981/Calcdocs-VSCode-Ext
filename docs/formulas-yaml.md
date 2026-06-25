# Formula YAML Files Guide

`formulas*.yaml` files are the core of CalcDocs' synchronization between
firmware specifications and C/C++ code. They define named formulas with values,
expressions, CSV lookups, units, and — crucially — **tolerance specifications**
that drive the Monte Carlo uncertainty propagation shown in the Interactive
Formula Viewer.

Place `formulas.yaml` (or `formulas-*.yaml`) anywhere in the workspace;
CalcDocs discovers it automatically.

---

## File structure

The YAML root is a map where **keys** are symbol IDs and **values** are objects:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `const` \| `expr` \| `lookup` | No | Inferred if omitted |
| `value` | number \| number[] | For `const` | Nominal value or array |
| `formula` / `expr` | string | For `expr` | Expression. Supports math, `csv()`, other symbol references |
| `unit` | string | No | Physical unit for display and dimension checks |
| `parameters` | string[] | No | Makes the formula callable: `F(a, b)` |
| `steps` | string[] | No | Documentation steps shown in the viewer |
| `labels` | string[] | No | Tags: `complex_expression`, `table_lookup` |
| `revision` | string | No | Version string |
| `uncertainty` | object | No | Level 1: input variation band — see below |
| `distribution` | object | No | Level 2: shape of input distribution — see below |
| `propagation` | string | No | Level 3: bound-selection rule on output formulas — see below |
| `parameter_tolerances` | object | No | Per-dependency tolerance overrides |
| `confidence` | number | No | Confidence level for `monte_carlo` (default 95) |
| `samples` | number | No | Sample count (default 10 000) |
| `seed` | number | No | Fixed PRNG seed for reproducible bounds |

---

## The three-level tolerance model

Uncertainty specification is split across three independent levels that must
not be mixed on the same field:

```
Level 1  uncertainty   →  how wide is the input variation band
Level 2  distribution  →  how the value is distributed inside that band
Level 3  propagation   →  which bound is reported on the output formula
```

`propagation` belongs on **output formulas** (`type: expr`), never on input
constants. All three methods use the same real Monte Carlo simulation; they
differ only in which bound they report.

### Level 1 — `uncertainty`

```yaml
uncertainty:
  type: percent     # ±N% of the nominal value
  value: 5
```

| `type` | Required fields | Effect |
|--------|----------------|--------|
| `percent` | `value` | halfWidth = abs(nominal) × value/100 |
| `range` | `min`, `max` | halfWidth = (max−min)/2 |
| `absolute` | `absolute` | halfWidth = absolute |
| `sigma` | `sigma` | halfWidth = 3×sigma (3σ band) |

### Level 2 — `distribution`

```yaml
distribution:
  type: normal
  sigma_level: 3    # σ = halfWidth / sigma_level
```

| `type` | Optional field | σ used by engine |
|--------|---------------|-----------------|
| `uniform` | — | halfWidth / √3 |
| `normal` | `sigma_level` (default 3) | halfWidth / sigma_level |
| `triangular` | — | halfWidth / √6 |

If `distribution:` is omitted, the engine defaults to `uniform` and emits a
`WARN` diagnostic.

### Level 3 — `propagation` (on output formulas only)

```yaml
propagation: worst_case   # or: rss | monte_carlo
```

| Value | Reported min/max | Coverage |
|-------|-----------------|---------|
| `worst_case` | absolute min/max of all MC samples | 100% |
| `rss` | mean ± 3σ of the output samples | ~99.7% if output ≈ normal |
| `monte_carlo` | confidence percentiles (default 95%) | configurable |

All three produce **the same underlying histogram** in the Distribution tab.
The choice of `propagation` only affects the bound markers shown on the chart.

---

## Minimal working example

```yaml
# Input with declared uncertainty
VIN:
  type: const
  value: 24
  unit: V
  uncertainty:
    type: percent
    value: 5           # ±5% → samples in [22.8, 25.2]
  distribution:
    type: uniform

CURRENT:
  type: const
  value: 2
  unit: A
  uncertainty:
    type: absolute
    absolute: 0.1      # ±100 mA
  distribution:
    type: normal
    sigma_level: 3     # σ = 0.1/3 ≈ 33 mA

# Output formula with propagation
POWER:
  type: expr
  formula: VIN * CURRENT
  unit: W
  propagation: worst_case
  # Distribution tab: shows real MC histogram of power distribution
  # Reported bounds: absolute min/max of 10 000 simulated samples
```

---

## Full feature reference

### Expressions

```yaml
POWER:
  formula: VIN * CURRENT
  unit: W

EFFICIENCY:
  formula: POWER / 72          # dimensionless ratio

FREQ_KHZ:
  formula: 1 / (2 * pi * R * C)
  unit: Hz

LOOKUP_R:
  formula: csv("ntc_10k.csv", "25", "temperature", "resistance")
  unit: ohm
```

**Supported math** (case-insensitive): `sin cos tan asin acos atan atan2 sqrt
abs int mod min max pow floor ceil round trunc log log10 log2 exp hypot pi e
deg2rad rad2deg`

**CSV lookups**: `csv(table, key, out_col [, in_col [, mode]])`
Modes: `none` (exact), `linear` (interpolate), `nearest`

### Arrays

```yaml
RES_ARRAY:
  value: [100, 220, 330, 470]
  unit: ohm
  # Elements accessed as RES_ARRAY[0], RES_ARRAY[1], ...

ARRAY_SUM:
  formula: RES_ARRAY[0] + RES_ARRAY[1] + RES_ARRAY[2]
  unit: ohm
```

### Parameterized formulas

```yaml
DIVIDER:
  formula: V * R2 / (R1 + R2)
  parameters: [V, R1, R2]

VOUT:
  formula: DIVIDER(VIN, 1000, 2000)
  unit: V
```

### Per-dependency tolerance overrides

Use `parameter_tolerances:` to assign or override the tolerance of a specific
dependency for this formula's propagation, without changing the dependency's
own declaration:

```yaml
BASE_R:
  type: const
  value: 1000
  unit: ohm
  # no uncertainty declared here

BRIDGE:
  type: expr
  formula: VIN * BASE_R / (BASE_R + 2000)
  unit: V
  propagation: monte_carlo
  confidence: 95
  parameter_tolerances:
    BASE_R:
      uncertainty:
        type: percent
        value: 1          # 1% tolerance injected only for this formula
      distribution:
        type: normal
        sigma_level: 3
```

### Monte Carlo options

```yaml
RESULT_MC:
  type: expr
  formula: VIN * CURRENT
  unit: W
  propagation: monte_carlo
  confidence: 95     # optional, default 95 → p2.5 / p97.5
  samples: 10000     # optional, default 10 000
  seed: 42           # optional: fixed seed for reproducible output
```

---

## What triggers the Distribution tab

The Distribution tab in the Interactive Formula Viewer shows an empirical
histogram only when **both** conditions are met:

1. At least one input in the formula's dependency chain has `uncertainty:` +
   `distribution:` (or `parameter_tolerances:` covering a dependency).
2. The formula itself has `propagation:` declared.

The histogram is pre-computed by the engine from real Monte Carlo samples and
sent as `histogram.counts[]` (32 bins). The webview renders it directly —
no reconstruction, no approximation.

**Does NOT trigger the Distribution tab:**
- Formulas with no `propagation:` (even if inputs have `uncertainty:`)
- Constants with only top-level `min:`/`max:` (old style, no `uncertainty:` block)
- Parameterized formulas called with literal arguments and no overrides

---

## Effect on C/C++ files

YAML changes are reflected immediately in the editor:

- **Hover** `#define POWER_W ...` → shows `48.0 // [W] ±5.2%`
- **CodeLens** → `// CalcDocs: POWER = 48.0 W  [45.6, 50.4]`
- **Ghost values** → inline `← 48.0 W` annotations

Value mismatches between YAML and C `#define` values produce diagnostic
warnings in the Problems panel.

---

## Legacy compatibility

The old `tol`, `tol_mode`, `sigma`, `min`/`max`, and `ranges:` fields are
still accepted. They are converted internally to the three-level model and emit
`WARN` diagnostics:

```yaml
# Legacy (accepted with warnings):
R1:
  value: 100
  tol: 5              # WARN → uncertainty: {type: percent, value: 5}
  tol_mode: gaussian  # WARN → distribution: {type: normal}
  sigma: 2            # WARN → distribution: {sigma_level: 2}
```

```yaml
# Modern equivalent (no warnings):
R1:
  type: const
  value: 100
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: normal
    sigma_level: 2
```

See `docs/MIGRATION_GUIDE.md` for a complete conversion table.

---

## Header generation

Run **CalcDocs: Generate Formula Header** (⇧⌘P) to produce a `.h` file:

```c
// Auto-generated by CalcDocs
#pragma once

// Constant: VIN [V]
#define VIN   (24)      // [V]

// Formula: POWER = VIN * CURRENT
#define POWER (48)      // [W]
```

---

## See also

- `docs/tolerance-and-ranges.md` — tolerance propagation guide with examples
- `docs/TOLERANCE_ARCHITECTURE.md` — engine internals and data flow
- `docs/MIGRATION_GUIDE.md` — converting legacy tolerance fields
- `examples/formulas_model_modes_expected.yaml` — all propagation modes
- `examples/formulas_distribution_edge_cases.yaml` — edge cases and improper use
