/**
 * siResolver.ts
 *
 * Deterministic SI unit resolution from canonical dimensional vectors.
 *
 * Uses the existing unit table in engine/units.
 * Does NOT modify it.
 *
 * Resolution rules:
 * - Match canonical key to unit dimension table
 * - Return ALL matches (no ranking)
 * - If no match, return empty array
 */

import { UNIT_SPECS } from "../engine/units";
import type { CanonicalKey, SiUnitMatch } from "./dimTypes";

// ---------------------------------------------------------------------------
// Pre-built lookup: canonical key → list of SI units sharing that dimension
// ---------------------------------------------------------------------------

interface DimEntry {
  key: CanonicalKey;
  units: SiUnitMatch[];
}

/**
 * Build the lookup table from the unit specification array.
 * Only done once at module load.
 */
function buildDimToUnitMap(): DimEntry[] {
  const groups = new Map<string, SiUnitMatch[]>();

  for (const [token, spec] of UNIT_SPECS) {
    const key = canonicalKeyForVector(spec.dimension);
    
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    
    const name = deriveName(token, spec.family);
    
    groups.get(key)!.push({
      unit: spec.canonical || token,
      name,
      family: spec.family || "unknown",
    });
  }

  return Array.from(groups.entries()).map(([key, units]) => ({ key, units }));
}

function deriveName(token: string, family?: string): string {
  const names: Record<string, string> = {
    "N": "newton", "J": "joule", "W": "watt", "Pa": "pascal",
    "V": "volt", "A": "ampere", "C": "coulomb", "F": "farad",
    "H": "henry", "Ohm": "ohm", "S": "siemens", "Wb": "weber",
    "T": "tesla", "Hz": "hertz", "K": "kelvin", "kg": "kilogram",
    "m": "meter", "s": "second", "g": "gram",
  };
  if (names[token]) return names[token];
  if (family) return `${family}: ${token}`;
  return token;
}

function canonicalKeyForVector(v: { M: number; L: number; T: number; I: number; K?: number }): string {
  const m = Math.round(v.M);
  const l = Math.round(v.L);
  const t = Math.round(v.T);
  const i = Math.round(v.I);
  const k = Math.round(v.K ?? 0);
  return `M^${m}|L^${l}|T^${t}|I^${i}|K^${k}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DIM_UNIT_MAP = buildDimToUnitMap();

export function resolveSiUnits(key: CanonicalKey): SiUnitMatch[] {
  if (key.startsWith("UNKNOWN") || key.startsWith("INVALID")) {
    return [];
  }
  
  const entry = DIM_UNIT_MAP.find(e => e.key === key);
  return entry ? entry.units : [];
}

export function formatSiUnits(matches: SiUnitMatch[]): string {
  if (matches.length === 0) return "unknown";
  if (matches.length === 1) return matches[0].unit;
  return matches.map(m => m.unit).join(", ");
}

export function canonicalKeyFromVector(vector: { M: number; L: number; T: number; I: number; K?: number }): string {
  const m = Math.round(vector.M);
  const l = Math.round(vector.L);
  const t = Math.round(vector.T);
  const i = Math.round(vector.I);
  const k = Math.round(vector.K ?? 0);
  return `M^${m}|L^${l}|T^${t}|I^${i}|K^${k}`;
}

export type { SiUnitMatch };