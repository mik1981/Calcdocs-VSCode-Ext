# Interactive Formula Viewer

CalcDocs provides an **interactive webview panel** that lets you explore
formulas, tweak inputs, and see results **in real time** — without editing
source files.

Open it via:
- **CalcDocs: Open Interactive View** (⇧⌘P)
- The CalcDocs toolbar button (changes icon based on active file type)

> The viewer is available for `formula*.yaml` files and C/C++ files with
> inline `@var = ...` calculations.

---

## Supported file types

| File type | Behaviour |
|-----------|-----------|
| ✅ `formula*.yaml` | All named formulas, full dependency resolution, tolerance propagation |
| ✅ C/C++ with `// @var = ...` | Inline assignments become interactive parameters |
| ❌ Plain C/C++ | Viewer shows workspace-indexed formulas if available, otherwise empty |

---

## Panel layout

The panel is divided into:

1. **Formula list** (left sidebar) — all formulas in the current file, filterable
2. **Main area** — four tabs for the selected formula:
   - **Dependency Tree** — collapsible dependency graph with inline parameter editing
   - **Evaluation** — step-by-step expression resolution
   - **Distribution** — Monte Carlo histogram and tolerance statistics
   - **Source** — raw YAML block

---

## Dependency Tree tab

Shows the full dependency graph of the selected formula with:

- **Editable inputs** — numeric fields for each leaf constant
- **Cascading recompute** — changing any value instantly updates all dependent results
- **Tolerance bar** — min/max range shown inline on each node that has uncertainty
- **Visual states**:

| Indicator | Meaning |
|-----------|---------|
| Normal | Value computed successfully |
| Overridden | User changed value from default |
| ⚠️ Warning | Computed with diagnostic warning |
| ❌ Error | Invalid expression or unit mismatch |
| 🔄 Cycle | Circular dependency detected |
| ⬇️ Depth-limited | Tree deeper than 5 levels; further expansion suppressed |

---

## Evaluation tab

Shows step-by-step resolution of the formula expression with:
- Resolved values substituted for each identifier
- Depth indicators (color-coded by nesting level)
- Tolerance range on each intermediate step

---

## Distribution tab

Shows the **empirical Monte Carlo distribution** of the selected formula's output.

The Distribution tab is active only when:
1. The formula has `propagation:` declared
2. At least one dependency has `uncertainty:` + `distribution:` (or
   `parameter_tolerances:` covers a dependency)

### What is shown

**Output Distribution** (the selected formula's own output):
- Empirical histogram — 32 bins built directly from Monte Carlo samples
- Confidence bound markers (dashed lines) at the reported min/max
- Mean (μ) marker
- Statistics chips: μ, σ, P2.5, P97.5, N (sample count)
- Skewness (γ₁) and excess kurtosis (γ₂) badges

**Input Distributions** (leaf constants with `uncertainty:`):
- One histogram per input that has `uncertainty:` + `distribution:`
- Shows the root sample population before formula propagation

### Reading the histogram

The histogram is computed by the engine from N=10 000 Monte Carlo samples and
sent as pre-computed bin counts (`histogram.counts[]`). The webview renders
these directly — no CDF reconstruction, no synthetic approximation.

| Histogram shape | What it means |
|-----------------|---------------|
| Flat / rectangular | Uniform distribution input, linear formula |
| Bell-shaped | Normal distribution input, or sum of many inputs (CLT) |
| Right-skewed | Non-linear formula (e.g. X²) with uniform symmetric input |
| Asymmetric | Non-linear formula where upward and downward effects differ |
| Single spike | Zero tolerance, or all inputs are exact |

### The badge on the histogram

| Badge | `propagation` value | Bound shown |
|-------|--------------------|----|
| **MC — bound min/max** | `worst_case` | Absolute extremes of all samples |
| **MC — bound μ±3σ** | `rss` | Mean ± 3×stddev of output samples |
| **Monte Carlo** | `monte_carlo` | Confidence percentiles (default p2.5/p97.5) |

All three methods use the same underlying sample population. The badge
describes only how the reported bound is derived — not how sampling works.

### Propagation method explanation

The tab header shows a one-line explanation of the active propagation method:

- **Worst Case** — real MC samples; reported bound is the absolute min/max
  (100% coverage of simulated population).
- **RSS** — real MC samples; reported bound is mean ± 3σ of the output
  population (~99.7% coverage if the output is approximately Gaussian).
- **Monte Carlo** — real MC samples; reported bound is the confidence-level
  percentile interval (default 95% → p2.5 to p97.5).

### When the Distribution tab is empty

| Situation | Reason |
|-----------|--------|
| "No tolerance data available" | Formula has no `propagation:` declared |
| "No tolerance data available" | No dependency has `uncertainty:` + `distribution:` |
| Input histogram missing | Input has only top-level `min:`/`max:` (legacy style — migrate to `uncertainty:` block) |

---

## Live parameter editing

Every numeric constant that is a direct dependency of the selected formula has
an editable input field in the Dependency Tree tab.

When you change a value:
1. The engine re-runs the full dependency evaluation with the new value
2. All dependent formula results update immediately
3. If the changed constant has `uncertainty:`, the engine regenerates its
   sample population using the new value as the nominal, and re-propagates
   through the formula tree
4. The Distribution tab updates with a new histogram reflecting the changed nominal

This means: dragging a slider on a ±5% resistor from 100 Ω to 150 Ω updates
not just the nominal result but also the entire output distribution (now
centered around the new operating point).

---

## For `formula*.yaml` files

When you open a `formula*.yaml` file:
1. All named formulas are parsed into the sidebar list
2. Selecting one builds its dependency tree
3. Editing any leaf constant triggers instant re-evaluation
4. Formulas with `propagation:` show their Distribution tab

Dependency chains are resolved automatically. `A → B → C` is supported to
depth 5 (configurable). Beyond depth 5, child nodes are shown as "depth-limited"
but their contribution to the selected formula's output is still correctly
propagated.

---

## For C/C++ files with inline calculations

```c
// @vin = 24 V
// @current = 2 A
// @power = @vin * @current
// @efficiency = 0.85
// @power_out = @power * @efficiency -> W
```

Each `@name = value` assignment becomes an interactive parameter. Inline
calculations do not support `uncertainty:` / `distribution:` / `propagation:`;
the Distribution tab is not available for inline-only formulas.

---

## Comparison: Inline Ghost Values vs Interactive Viewer

| Aspect | Ghost values / Hover | Interactive Viewer |
|--------|---------------------|--------------------|
| Purpose | Quick read-only preview | Deep exploration and editing |
| Editing | ❌ | ✅ any constant |
| Dependency graph | ❌ linear | ✅ full tree |
| Cascade recompute | ❌ | ✅ |
| Unit conversion | ✅ | ✅ |
| Tolerance range | ✅ bar only | ✅ bar + histogram |
| Distribution tab | ❌ | ✅ MC histogram |

---

## See also

- `docs/tolerance-and-ranges.md` — tolerance propagation guide
- `docs/formulas-yaml.md` — YAML format reference
- `examples/formulas_model_modes_expected.yaml` — all propagation modes, annotated
- `examples/formulas_distribution_edge_cases.yaml` — edge cases and improper use
