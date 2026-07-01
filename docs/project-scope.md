# Project Scope

CalcDocs is designed to generate engineering documentation from numeric code.

Its purpose is to help engineers understand constants, formulas, dependencies and physical dimensions without requiring manual documentation.

## Primary Focus

CalcDocs is optimized for:

- Numeric constants
- Mathematical expressions
- Engineering formulas
- Dependency analysis
- Physical dimension propagation
- Unit inference
- Formula documentation
- Explainable evaluations

The extension is intended for embedded software, firmware and other engineering-oriented codebases where numeric logic represents a significant portion of the implementation.

---

## Deliberate Scope

CalcDocs intentionally focuses on numeric analysis rather than complete language understanding.

It is **not** intended to replace:

- C/C++ compilers
- Static analyzers
- Language servers
- Full semantic analysis engines

Instead, it extracts the information required to understand engineering calculations while remaining fast, deterministic and easy to inspect.

---

## Supported Workflows

CalcDocs works best when formulas are expressed through:

- constants
- macros
- numeric expressions
- engineering equations
- compile-time calculations

These patterns are common in embedded firmware, control systems, DSP algorithms and industrial software.

---

## Design Priorities

The project prioritizes:

1. Deterministic behavior
2. Fast analysis
3. Explainable results
4. Low memory usage
5. Incremental processing
6. Large project scalability
7. Non-invasive integration

Every feature is evaluated against these priorities before being introduced.

---

## What CalcDocs Does Not Aim To Be

CalcDocs is intentionally **not** a full C/C++ interpreter.

Supporting every language construct would significantly increase complexity while providing limited value for engineering documentation.

The project therefore concentrates on the subset of source code that carries engineering meaning rather than attempting complete language emulation.