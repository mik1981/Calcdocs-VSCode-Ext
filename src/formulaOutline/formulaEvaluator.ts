/**
 * formulaEvaluator.ts
 *
 * Lightweight, dependency-free expression evaluator for formulas*.yaml.
 *
 * Symbol resolution priority (highest → lowest):
 *   1. formula.example   — explicit test inputs in the YAML block
 *   2. cross-formula     — other formula IDs resolved in the same document
 *   3. cSymbols          — state.symbolValues: C/C++ macros resolved by the analysis engine
 *   4. value: (fallback) — deprecated static field, used only when expression fails
 *
 * Supports all standard math functions/constants (sin, cos, sqrt, log, pi, …).
 * Returns null when the expression cannot be fully resolved.
 *
 * Unit scaling:
 *   The formula `unit:` field declares the physical unit of the expression result.
 *   The raw expression evaluates in SI base units (V, A, Hz, s, …).
 *   `scaleValueToUnit()` converts the raw result to the declared unit for display:
 *     e.g. rawValue=3.3 (V), unit='mV' → displayValue=3300
 */

import type { OutlineFormula } from './formulaParser';
import type { Quantity } from '../engine/units';
import { preprocessExpression } from '../engine/evaluator';
import { formatNumberToSigFigs } from '../utils/nformat';
import {
  UNIT_ALIASES,
  UNIT_SPECS,
  SCALABLE_UNIT_FAMILY,
  UNIT_SCALE_FACTORS,
  convertSiToUnit,
  createQuantity,
  createQuantityFromData,
  getUnitSpec,
  normalizeUnitToken,
  parseUnitToQuantity,
} from '../engine/units';
import { inferDimension, dimToString } from './dimensionEvaluator';

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  );

  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }

  return dp[a.length][b.length];
}

export function suggestUnits(unit: string): string[] {
  const u = unit.toLowerCase();

  return [...UNIT_SCALE_FACTORS.keys()]
    .map(k => ({ k, d: levenshtein(u, k) }))
    .filter(x => x.d <= 2)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(x => x.k);
}

// const DEG_TO_RAD = Math.PI / 180;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export const MATH_SCOPE: Record<string, unknown> = {
  // Standard Math passthrough
  abs:   Math.abs,
  acos:  Math.acos,
  acosh: Math.acosh,
  asin:  Math.asin,
  asinh: Math.asinh,
  atan:  Math.atan,
  atan2: Math.atan2,
  atanh: Math.atanh,
  cbrt:  Math.cbrt,
  ceil:  Math.ceil,
  cos:   Math.cos,
  cosh:  Math.cosh,
  exp:   Math.exp,
  floor: Math.floor,
  hypot: Math.hypot,
  ln:    Math.log,
  log:   Math.log,
  log10: Math.log10,
  log2:  Math.log2,
  max:   Math.max,
  min:   Math.min,
  pow:   Math.pow,
  round: Math.round,
  sign:  Math.sign,
  sin:   Math.sin,
  sinh:  Math.sinh,
  sqrt:  Math.sqrt,
  tan:   Math.tan,
  tanh:  Math.tanh,
  trunc: Math.trunc,
  fabs:  Math.abs,

  // Constants
  pi:  Math.PI,
  PI:  Math.PI,
  tau: Math.PI * 2,
  e:   Math.E,
  E:   Math.E,

  // Degree helpers
  deg2rad: (v: number) => v * DEG_TO_RAD,
  rad2deg: (v: number) => v * RAD_TO_DEG,
  sind:    (v: number) => Math.sin(v * DEG_TO_RAD),
  cosd:    (v: number) => Math.cos(v * DEG_TO_RAD),
  tand:    (v: number) => Math.tan(v * DEG_TO_RAD),
  asind:   (v: number) => Math.asin(v) * RAD_TO_DEG,
  acosd:   (v: number) => Math.acos(v) * RAD_TO_DEG,
  atand:   (v: number) => Math.atan(v) * RAD_TO_DEG,
};

// ---------------------------------------------------------------------------
// Unit system
//
// Mirrors the UNIT_SPECS / formatWithOutputUnit pattern from inlineCalc.ts.
//
// Each entry maps a lowercase unit token → its SI scale factor.
// Factor = (SI value of 1 unit):
//   1 mV = 1e-3 V → factor = 1e-3
//   1 kHz = 1e3 Hz → factor = 1e3
//
// Conversion formula (same as inlineCalc.ts line 969):
//   displayValue = rawValue_in_SI / factor
// ---------------------------------------------------------------------------

/**
 * Set of all recognised unit token strings (lowercase).
 * Used by formulaOutlineProvider to skip unit symbols when scanning for missing variables.
 *
 * Replaces the old hand-maintained UNIT_SYMBOLS constant.
 */
export const UNIT_SYMBOLS: ReadonlySet<string> = new Set([
  ...Array.from(UNIT_SCALE_FACTORS.keys()).flatMap((unit) => [
    unit,
    unit.toLowerCase(),
  ]),
  ...UNIT_ALIASES.keys(),
]);

/**
 * Returns the SI scale factor for a unit token (case-insensitive).
 * Returns 1 for unknown or undefined units (= no scaling applied).
 *
 * Examples:
 *   resolveUnitFactor('mV')  → 1e-3
 *   resolveUnitFactor('kHz') → 1e3
 *   resolveUnitFactor('ms')  → 1e-3
 *   resolveUnitFactor(undefined) → 1
 */
export function resolveUnitFactor(unit: string | undefined): number {
  if (!unit) return 1;
  const spec = getUnitSpec(unit);
  return spec?.factorToSi ?? UNIT_SCALE_FACTORS.get(normalizeUnitToken(unit)) ?? 1;
}

/**
 * Scales a raw formula value (assumed to be in SI base units) to the
 * display unit declared in the formula's `unit:` field.
 *
 * Mirrors `formatWithOutputUnit` in inlineCalc.ts: `converted = value / spec.factor`.
 *
 * Examples:
 *   scaleValueToUnit(3.3,    'mV')  → 3300      (3.3 V → 3300 mV)
 *   scaleValueToUnit(3300,   'V')   → 3300      (no change)
 *   scaleValueToUnit(50000,  'kHz') → 50        (50 000 Hz → 50 kHz)
 *   scaleValueToUnit(0.001,  'ms')  → 1         (0.001 s → 1 ms)
 *   scaleValueToUnit(3.3,    'kV')  → 0.0033    (3.3 V → 0.0033 kV)
 *   scaleValueToUnit(1.5,    undefined) → 1.5   (no unit → no scaling)
 *
 * @param rawValue  Result of formula expression evaluation (in SI base units)
 * @param unit      Formula `unit:` field, e.g. 'mV', 'kHz', 'ms'
 */
export function scaleValueToUnit(rawValue: number, unit: string | undefined): number {
  if (!unit) return rawValue;
  const converted = convertSiToUnit(rawValue, unit);
  return converted.ok ? converted.value : rawValue;
}

/**
 * Return is a unit is known or not
*/
export function isKnownUnit(unit: string | undefined): boolean {
  if (!unit) return true;
  return Boolean(getUnitSpec(unit));
}

function toDeclaredUnitInternalValue(value: number, unit: string | undefined): number {
  if (!unit) return value;
  const quantity = createQuantityFromData(value, unit);
  return quantity.ok ? quantity.value.valueSi : value;
}

function trimOuterParentheses(expression: string): string {
  let result = expression.trim();

  while (result.startsWith('(') && result.endsWith(')')) {
    let depth = 0;
    let inString: string | null = null;
    let wrapsWholeExpression = true;

    for (let i = 0; i < result.length; i += 1) {
      const char = result[i];

      if (inString) {
        if (char === '\\') {
          i += 1;
          continue;
        }
        if (char === inString) {
          inString = null;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        inString = char;
        continue;
      }

      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0 && i < result.length - 1) {
          wrapsWholeExpression = false;
          break;
        }
      }
    }

    if (!wrapsWholeExpression || depth !== 0) {
      break;
    }

    result = result.slice(1, -1).trim();
  }

  return result;
}

function findMatchingParen(expression: string, openIndex: number): number {
  let depth = 0;
  let inString: string | null = null;

  for (let i = openIndex; i < expression.length; i += 1) {
    const char = expression[i];

    if (inString) {
      if (char === '\\') {
        i += 1;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }

    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function splitTopLevelArguments(argsText: string): string[] {
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  let inString: string | null = null;

  for (let i = 0; i < argsText.length; i += 1) {
    const char = argsText[i];

    if (inString) {
      if (char === '\\') {
        i += 1;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }

    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      args.push(argsText.slice(start, i).trim());
      start = i + 1;
    }
  }

  const tail = argsText.slice(start).trim();
  if (tail) {
    args.push(tail);
  }

  return args;
}

function stringLiteralValue(raw: string): string | undefined {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) {
    return undefined;
  }

  return trimmed.slice(1, -1).trim();
}

function isKnownUnitLiteral(raw: string): boolean {
  const value = stringLiteralValue(raw);
  if (!value) {
    return false;
  }

  return getUnitSpec(value) !== undefined || parseUnitToQuantity(value).ok;
}

function parsePureLookupCall(expression: string): { args: string[] } | undefined {
  const trimmed = trimOuterParentheses(expression);
  const match = trimmed.match(/^(csv|lookup|table)\s*\(/i);
  if (!match) {
    return undefined;
  }

  const openIndex = trimmed.indexOf('(', match[0].length - 1);
  const closeIndex = findMatchingParen(trimmed, openIndex);
  if (openIndex < 0 || closeIndex < 0 || trimmed.slice(closeIndex + 1).trim()) {
    return undefined;
  }

  return {
    args: splitTopLevelArguments(trimmed.slice(openIndex + 1, closeIndex)),
  };
}

function shouldTagLookupResultWithDeclaredUnit(formula: OutlineFormula): boolean {
  if (!formula.unit || !formula.expr) {
    return false;
  }

  const call = parsePureLookupCall(formula.expr);
  if (!call) {
    return false;
  }

  const lastArg = call.args[call.args.length - 1];
  return lastArg ? !isKnownUnitLiteral(lastArg) : true;
}

// ---------------------------------------------------------------------------
// Core evaluator
// ---------------------------------------------------------------------------

export type LookupResolver = (
  functionName: string, 
  args: Array<string | number>, 
  yamlPath?: string
) => number | Quantity;


// ---------------------------------------------------------------------------
// Unit helper for engine-level `preprocessExpression` wrappers.
// The engine rewrites quantity literals and suffixes into __unit(value, unit).
// ---------------------------------------------------------------------------

function toUnitAwareSiValue(value: unknown, unit: unknown): number {
  let numericValue = value;

  if (
    typeof numericValue === 'object' &&
    numericValue !== null &&
    'valueSi' in numericValue &&
    typeof (numericValue as Quantity).valueSi === 'number'
  ) {
    numericValue = (numericValue as Quantity).valueSi;
  }

  if (typeof numericValue !== 'number' || !Number.isFinite(numericValue)) {
    throw new Error('__unit() requires numeric value as first argument');
  }

  if (typeof unit !== 'string') {
    throw new Error('__unit() requires unit string as second argument');
  }

  const quantity = createQuantity(numericValue, unit);
  if (!quantity.ok) {
    throw new Error(quantity.error);
  }

  return quantity.value.valueSi;
}

/**
 * Evaluates a single expression given a flat variable scope.
 *
 * @param expr   Expression string, e.g. "V * V / R" or "ADC_MAX * NTC_R / (R_PULLUP + NTC_R)"
 * @param vars   All resolved variables (math scope is always included as baseline)
 * @param lookupResolver Optional resolver for csv(), table(), lookup()
 * @param yamlPath Optional path for relative lookups
 * @returns      Finite numeric result, or null if unresolvable / invalid
 */
export function evaluateFormulaExpression(
  expr: string,
  vars: Record<string, number>,
  lookupResolver?: LookupResolver,
  yamlPath?: string
): number | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;

  // Reuse the engine preprocessor so diagnostics and ghost values
  // share the same unit syntax semantics.
  const preprocessed = preprocessExpression(trimmed);

  // Caller variables take precedence over math scope
  const scope: Record<string, unknown> = { ...MATH_SCOPE, ...vars };
  scope.__unit = (value: unknown, unit: unknown) => toUnitAwareSiValue(value, unit);

  if (lookupResolver) {
    scope.csv = (...args: Array<string | number>) => lookupResolver('csv', args, yamlPath);
    scope.table = (...args: Array<string | number>) => lookupResolver('table', args, yamlPath);
    scope.lookup = (...args: Array<string | number>) => lookupResolver('lookup', args, yamlPath);
  }

  const keys = Object.keys(scope);
  const vals = Object.values(scope);

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...keys, `"use strict"; return (${preprocessed});`);
    const result: unknown = fn(...vals);

    if (typeof result === 'number' && Number.isFinite(result)) {
      return result;
    }

    if (typeof result === 'object' && result !== null && 'valueSi' in result) {
      const q = result as Quantity;
      if (Number.isFinite(q.valueSi)) {
        return q.valueSi; 
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cross-formula symbol table builder
// ---------------------------------------------------------------------------

/**
 * Builds a map of formulaId → resolvedValue for the whole document.
 *
 * Variable layer order (lowest → highest priority per formula):
 *   cSymbols (C macros)  →  previously-resolved formula IDs  →  formula.example
 *
 * Two forward passes cover linear chains and most diamond dependency patterns.
 * Formulas that reference still-unknown symbols (csv() lookups, missing vars…)
 * are silently skipped — they will show "?" in the ghost text.
 *
 * Note: values in the symbol table are stored in raw SI units (pre-scaling).
 * Unit scaling is applied at display time via scaleValueToUnit().
 *
 * @param formulas   All parsed formulas from the document
 * @param cSymbols   state.symbolValues — C/C++ macros already resolved by the analysis engine
 * @param lookupResolver Optional resolver for csv(), table(), lookup()
 */
export function buildFormulaSymbolTable(
  formulas: OutlineFormula[],
  cSymbols?: Map<string, number>,
  lookupResolver?: LookupResolver
): Map<string, number> {
  const table = new Map<string, number>();

  // Seed with deprecated `value:` fields (lowest-priority static constants)
  for (const formula of formulas) {
    if (typeof formula.value === 'number') {
      table.set(formula.id, toDeclaredUnitInternalValue(formula.value, formula.unit));
    }
  }

  // Two forward passes: first resolves top-level formulas,
  // second catches formulas that depend on results from pass 1.
  for (let pass = 0; pass < 2; pass++) {
    for (const formula of formulas) {
      if (table.has(formula.id)) continue; // already resolved
      if (!formula.expr) continue;

      const vars: Record<string, number> = {
        // Layer 1 (lowest): C/C++ macros from state.symbolValues
        ...Object.fromEntries(cSymbols ?? []),
        // Layer 2: other formula IDs already resolved in this document
        ...Object.fromEntries(table),
        // Layer 3 (highest): explicit example values for this formula
        ...(formula.example ?? {}),
      };

      const result = evaluateFormulaExpression(formula.expr, vars, lookupResolver, formula._filePath);
      
      if (typeof result === 'number' && Number.isFinite(result)) {
        table.set(
          formula.id,
          shouldTagLookupResultWithDeclaredUnit(formula)
            ? toDeclaredUnitInternalValue(result, formula.unit)
            : result
        );
      }
    }
  }

  return table;
}

// ---------------------------------------------------------------------------
// Per-formula resolved value (with precedence logic)
// ---------------------------------------------------------------------------

/**
 * Returns the best available numeric value for a single formula.
 *
 * Priority:
 *   1. Real-time evaluation:  example  >  cross-formula IDs  >  C/C++ macros
 *   2. Deprecated `value:` field (only used when expression is absent or fails)
 *
 * The returned `resolved` value is in raw SI units.
 * Apply `scaleValueToUnit(resolved, formula.unit)` before display.
 *
 * @param formula      Parsed formula entry
 * @param symbolTable  Cross-formula resolved values (from buildFormulaSymbolTable)
 * @param cSymbols     state.symbolValues — C/C++ macros (pass undefined when not available)
 * @param lookupResolver Optional resolver for csv(), table(), lookup()
 */
export function resolveFormulaValue(
  formula: OutlineFormula,
  symbolTable: Map<string, number>,
  cSymbols?: Map<string, number>,
  lookupResolver?: LookupResolver
): { resolved: number | null; source: 'expr' | 'value' | 'none' } {

  if (formula.expr) {
    const vars: Record<string, number> = {
      // Layer 1 (lowest): C/C++ macros
      ...Object.fromEntries(cSymbols ?? []),
      // Layer 2: other resolved formula IDs
      ...Object.fromEntries(symbolTable),
      // Layer 3 (highest): this formula's own example values
      ...(formula.example ?? {}),
    };

    const result = evaluateFormulaExpression(formula.expr, vars, lookupResolver, formula._filePath);

    if (result !== null) {
      return {
        resolved: shouldTagLookupResultWithDeclaredUnit(formula)
          ? toDeclaredUnitInternalValue(result, formula.unit)
          : result,
        source: 'expr',
      };
    }
  }

  // Fallback: deprecated `value:` field
  if (typeof formula.value === 'number') {
    return {
      resolved: toDeclaredUnitInternalValue(formula.value, formula.unit),
      source: 'value',
    };
  }

  return { resolved: null, source: 'none' };
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/**
 * Formats a number for ghost text display.
 * Uses 6 significant figures.
 *
 * Examples:
 *   1.44000     → "1.44"
 *   3.14159265  → "3.14159"
 *   1000        → "1000"
 *   0.000123456 → "0.000123457"
 *   1234567     → "1234570"
 */
export function formatGhostNumber(value: number): string {
  if (!Number.isFinite(value)) return '?';
  return formatNumberToSigFigs(value, 6);
}
