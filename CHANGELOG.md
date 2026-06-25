# Changelog

## [0.3.5] - 06/25/2026

- Evaluated YAML formulas in integration tests (CSV-driven) to validate `formula*.yaml` symbols (e.g. case_14_complex_formulas)
- Fixed redundant CodeLens comment for inline calculation assignments
- Added Monte Carlo recursive sampling engine for end-to-end propagation through formula chains
- Added support for 16-bin output distribution histograms in the interactive formula viewer
- Extended OutputDistribution to expose bins16 for accurate histogram rendering
- Added fallback rendering using CDF interpolation and synthetic sampling when histogram bins are unavailable
- Updated propagation semantics: mode selection now reports bounds separately from the sampling algorithm

### Upcoming Features:

- Visual dependency graph
- Fixed-point Analyzer (Q15/Q31)
- Improve webview for tolerance model propagation
- Interactive WebView-based formula builder to guide non-technical users without requiring raw text editing
- Table formula support

## [0.3.4] - 06/09/2026

- Fixed flicker on the last CodeLens value viewed.
- Fixed useless CodeLens showing on pure assignments with inline calculations.
- Fixed test engine errors in specific edge cases.
- Improved rendering performance.
- Fixed #undef not always being computed correctly (see example case 20).
- Correctly handled double minus "-" conditions (see example case 14).

## [0.3.3] - 06/04/2026

- Added `cppCodeLens.maxItemsPerViewport` and `inlineCodeLens.maxItemsPerViewport` settings (defaulting to 40 and 30 - respectively).
- Fixed ghost value range limit, applying it only to the actual editor view.

## [0.3.2] - 06/03/2026

- Added tolerance propagation in the interactive formula viewer
- Updated documentation to include new formula file fields for managing component and formula tolerances
- Added support for table arrays in formula files
- Removed line decorations in the CalcDocs Formulas Explorer to improve clarity; lines are still visible on hover
- Fixed an error occurring when adding a unit to a raw value

## [0.3.1] - 05/27/2026

- Extended inline calculations to support structures composed of @var = ... forms
- Fixed issues in the interactive formula viewer constant/formula evaluator
- Fixed bitfield fallback decoder handling across all entries
- Added ghost values support for .h files
- Added enum ghost values resolution support

## [0.3.0] - 05/26/2026

- Added sponsor badge
- Rounded computed values to 6 meaningful digits
- Added interactive formula viewer for formula*.yaml
- Added interactive formula viewer for c files with inline calculation
- Improved and fixed example snippets

## [0.2.8] - 05/20/2026

- Added 13_bitfield_decoder example case
- Added bitfield decoder support (currently validated with ST register-definition structs)
- Added copy-to-clipboard icon in hover tooltips for computed expression and label values
- Refactored unit handling system to automatically support metric multipliers and submultipliers (e.g. mV, µV, nV, kV, MV, …)
- Added interactive webview formula evaluator with Excel-like realtime evaluation mode for advanced testing
- Fixed false-positive ghost values on enum types
- Extended `CalcDocs: Formulas` explorer view in VSCode for formula navigation and inspection
- Fixed prevent partial temperature conversion on lookup table load

## [0.2.7] - 05/12/2026

- Fixed detection of multiline C constructs
- Added example case 12_inline_units
- Removed generate compile_commands.json from the quick menu
- Added support for direct unit conversion; examples:
  - @p1 = 1 atm
  - @p1 -> mbar displays <- 1013.25 mbar at the end of the line
  - @p1 -> Pa displays <- 101325 Pa at the end of the line
- Added ghost values for inline calculations

## [0.2.6] - 05/05/2026

- Add preview support for the switch/case keyword
- Improve accuracy of multiple definition warnings
- Improve conditional stack handling (#if/#elif/#else/endif) in cppParser
- Parser accuracy for advanced C types and preprocessor conditions
- Enum member extraction and auto-increment handling
- Auto-detect hex or binary view formats
- Added example case 11_advanced_types_operators

## [0.2.5] - 04/28/2026

- Removed unused parameters and commands
- Extended calcdocs.generateFormulaHeader to all formula*.yaml files in the workspace
- Fixed license badge in README.md
- Added example case 10_c_operators
- Support to c operator like sizeof, _Alignas, _Alignof, _Static_assert, _Bool, _Complex, _Imaginary e #undef

## [0.2.4] - 04/23/2026

- Auto-detect hex or binary view format
- Added example case 09_function_calls

## [0.2.3] - 04/22/2026

- Added enum support
- Fixed unit handling in the formula*.yaml evaluator
- Fixed case-sensitive path in not Windows enviroment
- Fixed README.md quick menu table

## [0.2.2] - 04/21/2026

- Added more structured example under `examples` dir.
- Switch `calcdocs.openTestFolder` to open `examples` dir

## [0.2.1] - 04/21/2026

- Fix README.md

## [0.2.0] - 04/16/2026

### Added

- Unified macro-functional architecture around:
  - dimensional calculations
  - real-time calculations
  - cache-aware symbol analysis
- Hybrid backend strategy:
  - clangd wrapper with AST request support (`textDocument/ast`)
  - IntelliSense (cpptools) additive hover wrapper
  - parser fallback when external providers are unavailable
- Ghost value coverage for local declarations in `.c` files (including inline comments).
- Macro expansion support improvements:
  - token pasting (`##`)
  - stringizing (`#`)

### Changed

- Hover wrapper now contributes only CalcDocs-specific extra data when external providers are active.
- `calcdocs.useClangd` reconfiguration now updates backend at runtime.
- Documentation refreshed for Marketplace presentation.
- Test system consolidated under Vitest with stable `test/unit` + `src/**/__tests__` suites.

### Fixed

- Ghost values no longer suppressed on lines containing trailing comments.
- Local declaration extraction now supports cases needed by `test/src/test.c`.
- Legacy node-test suites converted to Vitest to avoid false "no suite" failures.

## [0.1.12] - 04/07/2026

- Resolve write-back issue affecting specific cases.
- Expanded test files with additional cases to improve coverage.
- README updates.

## [0.1.11] - 04/03/2026

- Fix false "multiple conditional definitions" warnings across source files.
- Add semantic deduplication of define variants.
- Add parser regression tests for cross-file deduplication.

## [0.1.10] - 03/31/2026

- Active-file analysis improvements and runtime stability updates.

## [0.1.9] - 03/24/2026

- `openTestFolder` command improvements.
- CodeLens cast overflow and mismatch refinements.

## [0.1.8] - 03/17/2026

- Recursive preprocessor condition resolution and improved hover/CodeLens behavior.

## [0.1.7] - 03/11/2026

- Hover macro evaluation and hexadecimal value display.

## [0.1.6]

- Conditional ambiguity tracking and stack-safety protections.

## [0.1.5]

- Extended CSV lookup signatures and interpolation modes.

## [0.1.4]

- CodeLens support extended to all C files.

## [0.1.3]

- VS Code 1.109 compatibility update.

## [0.1.0] - 02/27/2026

- First public release.

