# Migration Guide — Legacy tolerance format → Three-level model

This document maps every legacy tolerance field to its modern equivalent in the
CalcDocs three-level model (`uncertainty` / `distribution` / `propagation`).

Legacy fields are still accepted (with `WARN` diagnostics). Migrating removes
the warnings and makes the intent explicit.

---

## Quick conversion table

| Legacy field | Converted to | Notes |
|---|---|---|
| `tol: N` | `uncertainty: {type: percent, value: N}` + `distribution: {type: uniform}` | Default distribution is uniform |
| `tol: N` + `tol_mode: gaussian` + `sigma: K` | `uncertainty: {type: percent, value: N}` + `distribution: {type: normal, sigma_level: K}` | |
| `min: A` + `max: B` (top-level) | `uncertainty: {type: range, min: A, max: B}` + `distribution: {type: uniform}` | Move into `uncertainty` block |
| `tol_mode: worst_case` (on output) | `propagation: worst_case` | Move to the output formula |
| `tol_mode: rss` (on output) | `propagation: rss` | |
| `tol_mode: gaussian` (on input) | `distribution: {type: normal, sigma_level: K}` | `gaussian` was an input distribution name, not a propagation method |
| `tol_mode: monte_carlo` | `propagation: monte_carlo` | Move to the output formula |
| `ranges: {dep: {tol: N}}` | `parameter_tolerances: {dep: {uncertainty: {type: percent, value: N}, distribution: {type: uniform}}}` | |
| `probabilistic: {mode: X, sigma: K}` | `propagation: X` on the output formula | The `probabilistic` block is removed entirely |

---

## Pattern-by-pattern examples

### Pattern 1 — Simple percent tolerance on a constant

```yaml
# BEFORE (legacy)
R1:
  value: 100
  unit: ohm
  tol: 5
```

```yaml
# AFTER (three-level)
R1:
  type: const
  value: 100
  unit: ohm
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: uniform     # explicit; was implicit before
```

**Distribution tab**: flat histogram over [95, 105]. No change in computed bounds.

---

### Pattern 2 — Gaussian tolerance on a constant

```yaml
# BEFORE (legacy)
VREF:
  value: 2.500
  unit: V
  tol: 1
  tol_mode: gaussian
  sigma: 3
```

```yaml
# AFTER (three-level)
VREF:
  type: const
  value: 2.500
  unit: V
  uncertainty:
    type: percent
    value: 1
  distribution:
    type: normal
    sigma_level: 3
```

**Distribution tab**: bell-shaped histogram. Bounds unchanged: halfWidth=0.025V,
σ=0.025/3≈0.00833V.

---

### Pattern 3 — Absolute min/max on a constant

```yaml
# BEFORE (legacy)
CURRENT_SOURCE:
  value: 0.500
  unit: A
  min: 0.480
  max: 0.520
```

```yaml
# AFTER (three-level)
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

**Distribution tab**: flat histogram over [0.480, 0.520]. No change in bounds.

---

### Pattern 4 — Propagation method on an output formula

```yaml
# BEFORE (legacy) — mode on the formula node itself
V_OUT:
  formula: VIN * R2 / (R1 + R2)
  unit: V
  tol_mode: rss
  sigma: 3
```

```yaml
# AFTER (three-level)
V_OUT:
  type: expr
  formula: VIN * R2 / (R1 + R2)
  unit: V
  propagation: rss
  # sigma_level is now irrelevant at the output level:
  # rss always reports mean ± 3σ of the real MC output samples
```

---

### Pattern 5 — `ranges:` override (legacy)

```yaml
# BEFORE (legacy)
V_DIVIDER:
  formula: SUPPLY_V * R3 / (R1 + R3)
  unit: V
  ranges:
    R1:
      tol: 1
    R3:
      min: 320
      max: 340
```

```yaml
# AFTER (three-level)
V_DIVIDER:
  type: expr
  formula: SUPPLY_V * R3 / (R1 + R3)
  unit: V
  propagation: worst_case
  parameter_tolerances:
    R1:
      uncertainty:
        type: percent
        value: 1
      distribution:
        type: uniform
    R3:
      uncertainty:
        type: range
        min: 320
        max: 340
      distribution:
        type: uniform
```

---

### Pattern 6 — `probabilistic` block (legacy)

```yaml
# BEFORE (legacy probabilistic block)
POWER:
  formula: VIN * CURRENT
  unit: W
  probabilistic:
    mode: monte_carlo
    sigma: 3
```

```yaml
# AFTER (three-level)
POWER:
  type: expr
  formula: VIN * CURRENT
  unit: W
  propagation: monte_carlo
  confidence: 95     # replaces implicit sigma-based bound
  seed: 42           # optional
```

The `probabilistic.sigma` field had no well-defined meaning for Monte Carlo
(which uses percentiles, not σ-multiples for bounds). Specify `confidence`
instead.

---

### Pattern 7 — `tolerance.parameters` (parameterized formula, legacy)

```yaml
# BEFORE (legacy)
DIVIDER:
  formula: V * R2 / (R1 + R2)
  parameters: [V, R1, R2]
  tolerance:
    parameters:
      V:  { tol: 2 }
      R1: { tol: 1 }
      R2: { tol: 5 }
```

```yaml
# AFTER (three-level) — move tolerances to the call-site formula
DIVIDER:
  formula: V * R2 / (R1 + R2)
  parameters: [V, R1, R2]
  # no tolerance here — the formula is generic

DIVIDER_OUT:
  formula: DIVIDER(SUPPLY_V, 1000, 2000)
  unit: V
  propagation: worst_case
  parameter_tolerances:
    SUPPLY_V:
      uncertainty: { type: percent, value: 2 }
      distribution: { type: uniform }
    # Note: literal arguments 1000 and 2000 are treated as exact constants
    # and cannot receive parameter_tolerances directly in this syntax.
    # If R1 and R2 need tolerances, declare them as named symbols first.
```

**Alternative** — declare named constants with tolerance:

```yaml
R1_TOL:
  type: const
  value: 1000
  unit: ohm
  uncertainty: { type: percent, value: 1 }
  distribution: { type: uniform }

R2_TOL:
  type: const
  value: 2000
  unit: ohm
  uncertainty: { type: percent, value: 5 }
  distribution: { type: uniform }

DIVIDER_OUT:
  formula: DIVIDER(SUPPLY_V, R1_TOL, R2_TOL)
  unit: V
  propagation: worst_case
```

---

## What does NOT need migration

| Field | Status |
|-------|--------|
| `value` | Unchanged |
| `formula` / `expr` | Unchanged |
| `unit` | Unchanged |
| `parameters` | Unchanged |
| `steps`, `labels`, `revision` | Unchanged |
| `type: const \| expr \| lookup` | Unchanged |
| `csv()` expressions | Unchanged |

---

## Checking for remaining legacy fields

After migration, open any `formulas*.yaml` in VS Code and check the Problems
panel (⇧⌘M). Remaining legacy fields produce:

```
WARN  [symbol]  Legacy field "tol" – use uncertainty: { type: percent, value: N } instead.
WARN  [symbol]  Legacy field "tol_mode"/"mode" – use distribution: { type: ... } instead.
WARN  [symbol]  Legacy fields "min"/"max" – use uncertainty: { type: range, ... } instead.
```

Zero warnings = complete migration.
