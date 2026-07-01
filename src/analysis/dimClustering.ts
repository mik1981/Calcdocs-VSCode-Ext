/**
 * dimClustering.ts
 *
 * Physics-Aware Dependency Clustering.
 *
 * This module is a STRICTLY ADDITIVE layer on top of existing dependency groups.
 *
 * Algorithm:
 *   1. Start from existing Dependency Groups (sink-based grouping)
 *   2. For each Dependency Group, compute dimensional vector per formula
 *   3. Group formulas by identical CANONICAL_KEY inside each dependency group
 *   4. Attach SI unit matches to each cluster
 *   5. Preserve stable topological ordering within each cluster
 *
 * Constraints:
 * - Does NOT replace dependency grouping
 * - Does NOT modify existing grouping logic
 * - Only augments the display layer
 */

import type { OutlineFormula } from "../formulaOutline/formulaParser";
import type { DependencyGroup } from "../formulaOutline/dependencyGraph";
import { extractFormulaDependencies, detectCycles, stableTopologicalSort } from "../formulaOutline/dependencyGraph";
import { computeExpressionDim } from "./dimEngine";
import { toCanonicalKey } from "./dimCanonicalizer";
import { resolveSiUnits } from "./siResolver";
import type {
  DimResult,
  DimCacheEntry,
  CanonicalKey,
  SiUnitMatch,
  PhysicsAugmentedGroup,
  PhysicalCluster,
} from "./dimTypes";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Cache for computed dimensional results per formula.
 * Reused across clustering to avoid recomputation.
 */
export class DimCache {
  private cache = new Map<string, DimCacheEntry>();
  private formulaLookup = new Map<string, OutlineFormula>();

  /**
   * Initialize cache with formula list and optional pre-computed dimension map.
   */
  initialize(formulas: OutlineFormula[], existingDepMap?: Map<string, Set<string>>): void {
    this.cache.clear();
    this.formulaLookup.clear();

    for (const f of formulas) {
      this.formulaLookup.set(f.id, f);
    }

    // If a dependency map is provided, compute dimensions in topological order
    // (dependencies first) — this maximizes cache hits.
    if (existingDepMap) {
      const sorted = stableTopologicalSort(formulas, existingDepMap);
      for (const id of sorted) {
        this.computeDim(id);
      }
    } else {
      // Fallback: compute in source order (less optimal)
      for (const f of formulas) {
        this.computeDim(f.id);
      }
    }
  }

  /**
   * Retrieve cached dimension result for a formula.
   */
  get(id: string): DimCacheEntry | undefined {
    return this.cache.get(id);
  }

  /**
   * Force recompute for a specific formula.
   */
  invalidate(id: string): void {
    this.cache.delete(id);
  }

  /**
   * Compute or retrieve from cache.
   */
  private computeDim(id: string): DimResult {
    const cached = this.cache.get(id);
    if (cached) return cached.result;

    const formula = this.formulaLookup.get(id);
    if (!formula) {
      const unknown: DimResult = { status: "unknown", vector: { M: 0, L: 0, T: 0, I: 0, K: 0 } };
      return unknown;
    }

    const result = this.computeFormulaDim(formula);
    const canonicalKey = result.status === "ok" ? toCanonicalKey(result.vector) : undefined;
    
    this.cache.set(id, { result, canonicalKey });
    return result;
  }

  /**
   * Compute dimensional result for a single formula.
   */
  private computeFormulaDim(formula: OutlineFormula): DimResult {
    // 1. If the formula has a declared unit, use it as the authoritative dimension
    if (formula.unit && formula.unit.trim().length > 0) {
      const unitDim = computeExpressionDim(formula.unit, () => ({
        status: "unknown",
        vector: { M: 0, L: 0, T: 0, I: 0, K: 0 },
      }));
      if (unitDim.status === "ok") {
        return unitDim;
      }
    }

    // 2. If the formula has a numeric value but no expression, it's dimensionless
    if (!formula.expr && formula.value !== undefined) {
      return { status: "ok", vector: { M: 0, L: 0, T: 0, I: 0, K: 0 } };
    }

    // 3. For expressions, use the unit dimension as identifier resolution base
    // All identifiers that are other formulas will be resolved from cache/declared units

    // Build identifier resolver that uses the cache
    const self = this;
    const resolveIdent = (name: string): DimResult => {
      if (!self.formulaLookup.has(name)) {
        // Unknown identifier → unknown dimension
        return { status: "unknown", vector: { M: 0, L: 0, T: 0, I: 0, K: 0 } };
      }
      return self.computeDim(name);
    };

    // If no expression, it's dimensionless
    if (!formula.expr || formula.expr.trim().length === 0) {
      return { status: "ok", vector: { M: 0, L: 0, T: 0, I: 0, K: 0 } };
    }

    return computeExpressionDim(formula.expr, resolveIdent);
  }
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/**
 * Cluster formulas within a single dependency group by physical dimension.
 *
 * @param group        The input dependency group
 * @param dimCache     Pre-populated dimension cache
 * @param depMap       Dependency map for stable topological sorting
 * @param allFormulas  Complete formula list (for sorting)
 * @returns            Physics-augmented group with sub-clusters
 */
export function clusterDependencyGroup(
  group: DependencyGroup,
  dimCache: DimCache,
  depMap: Map<string, Set<string>>,
  allFormulas: OutlineFormula[]
): PhysicsAugmentedGroup {
  // 1. Group formulas by their canonical dimensional key
  const keyGroups = new Map<CanonicalKey, string[]>();
  const keyStatuses = new Map<CanonicalKey, "ok" | "unknown" | "invalid">();

  for (const fid of group.formulaIds) {
    const entry = dimCache.get(fid);
    if (!entry) continue;

    const key = entry.canonicalKey ?? "UNKNOWN";
    if (!keyGroups.has(key)) {
      keyGroups.set(key, []);
      keyStatuses.set(key, 
        entry.result.status === "ok" ? "ok" :
        entry.result.status === "unknown" ? "unknown" : "invalid"
      );
    }
    keyGroups.get(key)!.push(fid);
  }

  // 2. Build a stable topological sort for the entire group
  //    We'll apply it to each cluster separately.
  const topoOrdered = stableTopologicalSort(allFormulas, depMap, new Set(group.formulaIds));
  const topoIndex = new Map<string, number>();
  for (let i = 0; i < topoOrdered.length; i++) {
    topoIndex.set(topoOrdered[i], i);
  }

  // 3. Sort clusters: errors first (unknown, then invalid), then alphabetic
  const sortedKeys = Array.from(keyGroups.keys()).sort((a, b) => {
    const statusOrder = (k: string) => {
      if (k === "UNKNOWN") return 0;
      if (k === "INVALID_DIMENSION") return 1;
      return 2;
    };
    const sa = statusOrder(a);
    const sb = statusOrder(b);
    if (sa !== sb) return sa - sb;
    // Same status: stable deterministic order by key string
    return a.localeCompare(b);
  });

  // 4. Build PhysicalCluster objects
  const clusters: PhysicalCluster[] = sortedKeys.map(key => {
    const formulaIds = keyGroups.get(key)!;
    
    // Sort within cluster by topological index (dependencies first)
    formulaIds.sort((a: string, b: string) => (topoIndex.get(a) ?? 0) - (topoIndex.get(b) ?? 0));

    // Resolve SI units only for valid OK keys
    let siUnits: SiUnitMatch[] = [];
    if (keyStatuses.get(key) === "ok" && !key.startsWith("UNKNOWN") && !key.startsWith("INVALID")) {
      siUnits = resolveSiUnits(key);
    }

    // Human-readable label
    const label = key === "UNKNOWN"
      ? "Unknown dimension"
      : key === "INVALID_DIMENSION"
        ? "Invalid dimension"
        : formatDimensionLabel(key);

    return {
      label,
      canonicalKey: key,
      siUnits,
      formulaIds,
    };
  });

  return {
    sink: group.sink,
    clusters,
  };
}

/**
 * Format a canonical key as a human-readable dimension label.
 * Example: "M^1|L^1|T^-2|I^0|K^0" → "M¹L¹T⁻²"
 */
function formatDimensionLabel(key: string): string {
  if (key === "M^0|L^0|T^0|I^0|K^0") return "dimensionless";
  
  const pairs = key.split("|");
  const parts: string[] = [];
  for (const pair of pairs) {
    const match = pair.match(/^([MLTIK])\^(-?\d+)$/);
    if (!match) continue;
    const [, base, expStr] = match;
    const exp = parseInt(expStr, 10);
    if (exp === 0) continue;
    // Use superscripts for better readability
    const superscripts: Record<string, string> = {
      "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
      "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻"
    };
    const formatted = String(exp).split("").map(d => superscripts[d] ?? d).join("");
    parts.push(`${base}${formatted}`);
  }
  
  return parts.length === 0 ? "dimensionless" : parts.join(" ");
}

/**
 * Compute dependency groups with physics-aware clustering.
 *
 * This is the main entry point for the Physics-Aware Dependency Clustering feature.
 * It:
 * 1. Computes dependency groups using the existing engine (no modification)
 * 2. Builds a dimension cache
 * 3. Clusters each group by physical dimension
 *
 * @param formulas    Parsed formula list (source order)
 * @returns           List of physics-augmented dependency groups
 */
export function computePhysicsClusters(
  formulas: OutlineFormula[]
): PhysicsAugmentedGroup[] {
  if (formulas.length === 0) return [];

  // 1. Reuse existing dependency group computation (no modification)
  const depMap = extractFormulaDependencies(formulas);
  const cycles = detectCycles(formulas, depMap);
  
  // Filter out cyclic formulas from groups (per spec: cycles are ignored)
  const cleanFormulas = formulas.filter(f => !cycles.has(f.id));
  
  if (cleanFormulas.length === 0) return [];

  // Recompute cleanGroups from clean formulas only
  const cleanDepMap = extractFormulaDependencies(cleanFormulas);

  // 2. Build skeleton of dependency groups (reuse the same algorithm)
  const groups = buildDependencyGroups(cleanFormulas, cleanDepMap);
  
  if (groups.length === 0) return [];

  // 3. Initialize dimension cache
  const cache = new DimCache();
  cache.initialize(cleanFormulas, cleanDepMap);

  // 4. Cluster each group
  return groups.map(g => clusterDependencyGroup(g, cache, cleanDepMap, cleanFormulas));
}

// ---------------------------------------------------------------------------
// Reimplementation of dependency group computation (for clean formulas)
// (same logic as in dependencyGraph, not modifying it)
// ---------------------------------------------------------------------------

function transitiveClosure(
  start: string,
  depMap: Map<string, Set<string>>,
  cycles: Set<string>
): Set<string> {
  const result = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    const refs = depMap.get(id);
    if (refs) {
      for (const ref of refs) {
        if (!result.has(ref) || cycles.has(ref)) {
          stack.push(ref);
        }
      }
    }
  }
  return result;
}

function buildDependencyGroups(
  formulas: OutlineFormula[],
  depMap: Map<string, Set<string>>
): DependencyGroup[] {
  if (formulas.length === 0) return [];

  // Build reverse map: for each formula, which formulas depend on it
  const dependents = new Map<string, Set<string>>();
  for (const [id, refs] of depMap) {
    if (!dependents.has(id)) dependents.set(id, new Set());
    for (const ref of refs) {
      if (!dependents.has(ref)) dependents.set(ref, new Set());
      dependents.get(ref)!.add(id);
    }
  }

  // Identify sinks
  const sinks: string[] = [];
  for (const f of formulas) {
    const deps = dependents.get(f.id);
    if (!deps || deps.size === 0) {
      sinks.push(f.id);
    }
  }

  if (sinks.length === 0) return [];

  // Compute closure for each sink, sort by decreasing closure size
  const groups: { sink: string; closure: Set<string>; size: number }[] = [];
  for (const sink of sinks) {
    const closure = transitiveClosure(sink, depMap, new Set());
    groups.push({ sink, closure, size: closure.size });
  }
  groups.sort((a, b) => b.size - a.size);

  // Generate DependencyGroup for each sink with stable topological sort
  const result: DependencyGroup[] = [];
  for (const group of groups) {
    const sorted = stableTopologicalSort(formulas, depMap, group.closure);
    result.push({ sink: group.sink, formulaIds: sorted });
  }

  return result;
}