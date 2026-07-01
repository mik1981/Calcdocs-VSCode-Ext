/**
 * dimTypes.ts
 *
 * Public types for the physics-aware dimensional analysis layer.
 * All types are pure data structures — no parser or AST dependency.
 */

import type { DimensionVector } from "../engine/units";

// ---------------------------------------------------------------------------
// Dimension vector results
// ---------------------------------------------------------------------------

/** Status of dimensional inference */
export type DimStatus = "ok" | "unknown" | "invalid_dimension";

/**
 * Result of propagating dimensions through a formula expression.
 */
export type DimResult =
  | { status: "ok"; vector: DimensionVector }
  | { status: "unknown"; vector: DimensionVector }
  | { status: "invalid_dimension"; error: string };

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

/**
 * Canonical key string format: "M^a|L^b|T^c|I^d|K^e"
 * Exponents are in their minimal reduced integer ratio form.
 */
export type CanonicalKey = string;

// ---------------------------------------------------------------------------
// SI resolution
// ---------------------------------------------------------------------------

/**
 * Matched SI derived unit. If multiple units share the same dimension,
 * all valid candidates are returned (no ranking).
 */
export interface SiUnitMatch {
  /** SI unit symbol, e.g. "N", "J", "W" */
  unit: string;
  /** Descriptive name, e.g. "newton", "joule", "watt" */
  name: string;
  /** Physical quantity family, e.g. "force", "energy", "power" */
  family: string;
}

// ---------------------------------------------------------------------------
// Physical cluster (inside a dependency group)
// ---------------------------------------------------------------------------

/**
 * A PhysicalCluster is a sub-grouping inside a DependencyGroup.
 * Formulas with the same canonical dimensional vector are grouped together.
 */
export interface PhysicalCluster {
  /** Human-readable label for the cluster, e.g. "M L T⁻²" */
  label: string;
  /** Canonical key identifying the dimension */
  canonicalKey: CanonicalKey;
  /** Matched SI units (may be empty if unknown) */
  siUnits: SiUnitMatch[];
  /** Formula IDs in this cluster, ordered by stable topological sort */
  formulaIds: string[];
}

/**
 * A dependency group extended with physics clusters.
 */
export interface PhysicsAugmentedGroup {
  sink: string;
  clusters: PhysicalCluster[];
}

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

/**
 * Cached dimensional information per formula ID.
 * Stored to avoid recomputation during clustering.
 */
export interface DimCacheEntry {
  result: DimResult;
  canonicalKey?: CanonicalKey;
}