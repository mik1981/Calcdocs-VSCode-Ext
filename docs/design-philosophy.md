# Design Philosophy

CalcDocs is built around a simple principle:

> Maximize engineering insight while minimizing implementation complexity.

Every architectural decision follows this objective.

---

## Engineering First

The project focuses on helping engineers understand:

- what a formula computes
- where values originate
- how quantities propagate
- whether dimensions remain consistent
- how calculations depend on each other

The goal is understanding, not compilation.

---

## Deterministic Results

Whenever possible, CalcDocs favors deterministic algorithms over heuristic or probabilistic approaches.

Deterministic analysis provides:

- repeatable outputs
- predictable behavior
- easier debugging
- easier maintenance
- higher confidence in generated documentation

---

## Explainability

Every computed result should be explainable.

Users should be able to inspect:

- expression structure
- resolved symbols
- intermediate values
- dependency chains
- inferred dimensions
- inferred units (when available)

The extension should never behave as a black box.

---

## Incremental Architecture

New capabilities are added as independent analysis layers whenever possible.

Examples include:

- dependency analysis
- dimensional analysis
- unit inference
- explain mode

Each layer consumes existing information without modifying the core evaluation engine.

This approach minimizes regressions and keeps the architecture maintainable.

---

## Performance

CalcDocs is intended to remain responsive even on large embedded projects.

To achieve this, the project emphasizes:

- incremental computation
- bounded algorithms
- linear or near-linear complexity
- limited memory allocations
- avoidance of unnecessary workspace scans

Performance improvements should never sacrifice correctness or explainability.

---

## Simplicity Over Cleverness

The project prefers solutions that are:

- easy to inspect
- easy to debug
- deterministic
- maintainable

Additional abstractions are introduced only when they provide clear engineering value.

---

## Long-Term Maintainability

CalcDocs is expected to evolve over many years.

Features should therefore be:

- modular
- testable
- backward compatible whenever practical
- additive rather than disruptive

Whenever possible, existing functionality is extended instead of rewritten.

---

## Guiding Principle

If a feature makes the architecture more complex, it should provide a proportional increase in engineering value.

Otherwise, the simpler solution is preferred.