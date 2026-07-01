/**
 * dimCanonicalizer.ts
 *
 * Canonical form normalization for dimensional vectors.
 *
 * All formulas sharing the same dimension equivalence class
 * collapse to the same canonical key.
 */

import type { DimensionVector } from "../engine/units";
import { UNIT_SPECS } from "../engine/units";
import type { CanonicalKey, DimResult } from "./dimTypes";

// ---------------------------------------------------------------------------
// GCD / reduction helpers
// ---------------------------------------------------------------------------

/** Greatest common divisor of two positive integers */
function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/** Greatest common divisor of an array */
function gcdArray(values: number[]): number {
  if (values.length === 0) return 1;
  let result = Math.abs(Math.round(values[0]));
  for (let i = 1; i < values.length; i++) {
    result = gcd(result, values[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Round a number to avoid floating-point noise for small denominators.
 * For dimension propagation results we expect simple rational fractions.
 */
function smartRound(value: number): number {
  if (Number.isInteger(value)) return value;
  // Check for close-to-integer
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 1e-10) return rounded;
  // Check for close-to-half
  const half = Math.round(value * 2) / 2;
  if (Math.abs(value - half) < 1e-10) return half;
  // Check for simple fractions (denominator <= 10)
  for (let denom = 2; denom <= 10; denom++) {
    const num = Math.round(value * denom);
    if (Math.abs(value - num / denom) < 1e-10) {
      return num / denom;
    }
  }
  return value;
}

/**
 * Reduce a dimension vector to its minimal integer ratio form.
 *
 * Rules:
 * - All components are converted to smallest integer-equivalent ratio
 * - Negative zero is canonicalized to zero
 * - Order is fixed: M, L, T, I, K
 *
 * Example:
 *   [2, 2, -2, 0, 0] → {M:2,L:2,T:-2,I:0,K:0} → "M^2|L^2|T^-2|I^0|K^0"
 *   [1, 1, -2, 0, 0] → {M:1,L:1,T:-2,I:0,K:0} → "M^1|L^1|T^-2|I^0|K^0"
 *   Same physical dimension but different exponents until gcd reduction.
 */
export function toCanonicalKey(vector: DimensionVector): CanonicalKey {
  // Round to avoid floating point noise
  const rawM = smartRound(vector.M);
  const rawL = smartRound(vector.L);
  const rawT = smartRound(vector.T);
  const rawI = smartRound(vector.I);
  const rawK = smartRound(vector.K);

  // Find LCM of denominators if any are fractional
  const fractionalValues = [rawM, rawL, rawT, rawI, rawK].filter(v => !Number.isInteger(v));
  if (fractionalValues.length > 0) {
    // Compute denominator needed to clear all fractions
    const denom = fractionalValues.reduce((d, v) => {
      // Find smallest d such that v*d is close to integer
      let dCurrent = 1;
      while (Math.abs(v * dCurrent - Math.round(v * dCurrent)) > 1e-10 && dCurrent < 100) {
        dCurrent++;
      }
      return lcm(d, dCurrent);
    }, 1);
    
    const denomInt = Math.round(denom);
    if (Math.abs(denom - denomInt) < 1e-10 && denomInt <= 100) {
      const m = Math.round(rawM * denomInt);
      const l = Math.round(rawL * denomInt);
      const t = Math.round(rawT * denomInt);
      const i = Math.round(rawI * denomInt);
      const k = Math.round(rawK * denomInt);
      // Reduce by GCD
      const g = gcdArray([Math.abs(m), Math.abs(l), Math.abs(t), Math.abs(i), Math.abs(k)].filter(v => v !== 0));
      if (g > 1) {
        return `M^${m / g}|L^${l / g}|T^${t / g}|I^${i / g}|K^${k / g}`;
      }
      return `M^${m}|L^${l}|T^${t}|I^${i}|K^${k}`;
    }
  }

  // Find GCD of all non-zero integer components
  const nonZero = [rawM, rawL, rawT, rawI, rawK].filter(v => v !== 0);
  
  if (nonZero.length === 0) {
    return "M^0|L^0|T^0|I^0|K^0";
  }

  // If all components are integers, reduce by GCD
  const allInt = nonZero.every(v => Number.isInteger(v));
  if (allInt) {
    const g = gcdArray(nonZero.map(v => Math.abs(Math.round(v))));
    if (g > 1) {
      return `M^${Math.round(rawM) / g}|L^${Math.round(rawL) / g}|T^${Math.round(rawT) / g}|I^${Math.round(rawI) / g}|K^${Math.round(rawK) / g}`;
    }
  }

  // Format with fixed precision if fractional
  const fmt = (v: number): number => {
    if (Number.isInteger(v)) return v;
    // Format as reduced fraction up to 2 decimal places
    const rounded = Math.round(v * 100) / 100;
    if (Math.abs(rounded - v) < 1e-10) return rounded;
    return v;
  };

  return `M^${fmt(rawM)}|L^${fmt(rawL)}|T^${fmt(rawT)}|I^${fmt(rawI)}|K^${fmt(rawK)}`;
}

/** Least common multiple */
function lcm(a: number, b: number): number {
  return Math.abs(a * b) / gcd(a, b);
}

export { gcdArray as _gcdArray };

/**
 * Compute a canonical key from a DimResult.
 */
export function canonicalKeyFromResult(result: DimResult): CanonicalKey {
  if (result.status === "unknown") {
    return "UNKNOWN";
  }
  if (result.status === "invalid_dimension") {
    return "INVALID_DIMENSION";
  }
  return toCanonicalKey(result.vector);
}