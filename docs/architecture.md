# Architecture

CalcDocs is organized around 3 macro-functional areas.

## 1) Symbol Intelligence Layer

- `clangd` backend wrapper:
  - Uses hover/definition/document symbols.
  - Requests real clang AST (`textDocument/ast`) when available.
- IntelliSense wrapper:
  - Detects active cpptools integration.
  - Injects only additional CalcDocs data (no duplicate provider output).
- Internal parser fallback:
  - Extracts defines/const/local declarations.
  - Resolves function-like macros and conditional branches.

## 2) Calculation Layer

- Expression engine for C-style macro expansion and safe evaluation.
- YAML formula engine (`yamlParser.ts`): Parses `formulas*.yaml` → deps/graph/diagnostics. See [Formula YAML Guide](../formulas-yaml.md).
- Dimensional/unit engine for consistency checks and output conversion.
- Realtime inline calculations in comments.
- Header generator module: YAML/C → `#define` macros.

## 3) Runtime & Delivery Layer

- LRU cache for expensive preprocessing/mega translation units.
- Workspace analysis scheduler + file watchers.
- UI surfaces: ghost values, CodeLens, hover, diagnostics, definition links.

## Runtime Decision Flow

1. Discover active external providers (`clangd`, cpptools).
2. Build hybrid symbols with confidence and field provenance.
3. Prefer external data when available.
4. Add CalcDocs-only context via wrappers.
5. Fall back to internal parser when external providers are unavailable.

