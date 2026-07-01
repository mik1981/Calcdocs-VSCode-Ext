/**
 * dependencyGraph.ts
 *
 * Pure data module for computing dependency groups from parsed formulas.
 *
 * Parser, AST, tokenizer, formula model remain unchanged.
 * Only operates on the already-parsed OutlineFormula[] array.
 *
 * Algorithm (from specification):
 *   1. Build dependency DAG from formula expressions
 *   2. Identify sinks (formulas with zero dependents)
 *   3. Compute transitive dependency closure of every sink
 *   4. Sort sinks by decreasing closure size
 *   5. Generate one Dependency Group per sink
 *   6. Formulas may appear in multiple groups (no deduplication)
 *
 * Ordering inside a group: stable topological sort (source order for ties).
 */

import type { OutlineFormula } from './formulaParser';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single dependency group rooted at a sink formula.
 * `sink` is the root formula ID.
 * `formulaIds` lists every formula in the closure, ordered by
 * stable topological sort (dependencies before dependents; source order for ties).
 */
export interface DependencyGroup {
  sink: string;
  formulaIds: string[];
}

// ---------------------------------------------------------------------------
// Dependency extraction
// ---------------------------------------------------------------------------

/**
 * Maps each formula ID to the set of other formula IDs it directly references
 * in its expression. Only formula-to-formula references are included;
 * C/C++ macros, math functions, unit symbols, and numeric literals are ignored.
 */
export function extractFormulaDependencies(
  formulas: OutlineFormula[]
): Map<string, Set<string>> {
  const formulaIdSet = new Set(formulas.map((f) => f.id));
  const deps = new Map<string, Set<string>>();

  for (const formula of formulas) {
    const refs = new Set<string>();
    const expr = formula.expr || '';
    if (expr.length > 0) {
      // Extract all potential symbol references
      const symbols = expr.match(/[A-Z_][A-Z0-9_]*/gi) || [];
      for (const sym of symbols) {
        if (formulaIdSet.has(sym) && sym !== formula.id) {
          refs.add(sym);
        }
      }
    }
    deps.set(formula.id, refs);
  }

  return deps;
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

/**
 * Returns the set of formula IDs that participate in cycles.
 * Uses Kahn's algorithm variant: nodes remaining after removing
 * all nodes with in-degree 0 are the cyclic ones.
 */
export function detectCycles(
  formulas: OutlineFormula[],
  deps: Map<string, Set<string>>
): Set<string> {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, Set<string>>();

  for (const f of formulas) {
    inDegree.set(f.id, 0);
    adj.set(f.id, new Set());
  }

  for (const [id, refs] of deps) {
    for (const ref of refs) {
      const set = adj.get(ref);
      if (set) {
        set.add(id);
        inDegree.set(id, (inDegree.get(id) || 0) + 1);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const removed = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    removed.add(node);
    const successors = adj.get(node);
    if (successors) {
      for (const succ of successors) {
        const newDeg = (inDegree.get(succ) || 1) - 1;
        inDegree.set(succ, newDeg);
        if (newDeg === 0) queue.push(succ);
      }
    }
  }

  const cycles = new Set<string>();
  for (const f of formulas) {
    if (!removed.has(f.id)) {
      cycles.add(f.id);
    }
  }
  return cycles;
}

// ---------------------------------------------------------------------------
// Stable topological sort
// ---------------------------------------------------------------------------

/**
 * Stable topological sort of formula IDs.
 *
 * Rules (from specification):
 *   1. Dependencies always appear before dependents.
 *   2. When multiple formulas are valid next candidates,
 *      preserve their original source order (the order in `formulas`).
 *   3. Never use alphabetical ordering.
 *
 * @param formulas  Full formula list (source order defines tie-breaking)
 * @param depMap    Dependency map (formula ID → IDs it references)
 * @param subset    Optional subset of IDs to sort; if omitted, sorts all.
 * @returns         Sorted formula IDs
 */
export function stableTopologicalSort(
  formulas: OutlineFormula[],
  depMap: Map<string, Set<string>>,
  subset?: Set<string>
): string[] {
  // Source order index for stable tie-breaking
  const sourceIndex = new Map<string, number>();
  formulas.forEach((f, i) => sourceIndex.set(f.id, i));

  // Filter to subset if provided
  const ids = subset
    ? formulas.filter((f) => subset.has(f.id))
    : [...formulas];

  // Compute in-degree within the subset
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const f of ids) {
    inDegree.set(f.id, 0);
    adj.set(f.id, []);
  }

  for (const f of ids) {
    const refs = depMap.get(f.id);
    if (!refs) continue;
    for (const ref of refs) {
      if (!inDegree.has(ref)) continue; // outside subset
      adj.get(ref)!.push(f.id);
      inDegree.set(f.id, (inDegree.get(f.id) || 0) + 1);
    }
  }

  // Kahn with stable queue: maintain candidate order by source index
  const result: string[] = [];
  const candidates = ids
    .filter((f) => (inDegree.get(f.id) || 0) === 0)
    .sort((a, b) => (sourceIndex.get(a.id) ?? 0) - (sourceIndex.get(b.id) ?? 0))
    .map((f) => f.id);

  // Use a priority queue approach: always pick earliest source order
  const visited = new Set<string>();
  while (candidates.length > 0) {
    const node = candidates.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    result.push(node);

    const successors = adj.get(node);
    if (successors) {
      for (const succ of successors) {
        const newDeg = (inDegree.get(succ) || 1) - 1;
        inDegree.set(succ, newDeg);
        if (newDeg === 0) {
          // Insert in source-order position
          const idx = candidates.findIndex(
            (c) => (sourceIndex.get(c) ?? Infinity) > (sourceIndex.get(succ) ?? 0)
          );
          if (idx === -1) candidates.push(succ);
          else candidates.splice(idx, 0, succ);
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dependency group generation
// ---------------------------------------------------------------------------

/**
 * Compute transitive closure of a formula: all formulas it depends on
 * (directly and indirectly), including the formula itself.
 *
 * @param start    Starting formula ID
 * @param depMap   Dependency map (formula ID → IDs it references)
 * @param cycles   Set of cyclic formula IDs (to avoid infinite recursion)
 * @returns        Set of all formula IDs in the closure, including start
 */
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

/**
 * Compute dependency groups from parsed formulas.
 *
 * Steps (from specification):
 *   1. Extract dependencies
 *   2. Identify sinks (formulas with zero dependents)
 *   3. Compute transitive dependency closure of each sink
 *   4. Sort sinks by decreasing closure size
 *   5. Generate one Dependency Group per sink
 *
 * @param formulas  Parsed formulas in source order
 * @returns         Dependency groups, ordered by decreasing closure size
 */
export function computeDependencyGroups(
  formulas: OutlineFormula[]
): DependencyGroup[] {
  if (formulas.length === 0) return [];

  const depMap = extractFormulaDependencies(formulas);
  const cycles = detectCycles(formulas, depMap);

  // Build reverse map: for each formula, which formulas depend on it
  const dependents = new Map<string, Set<string>>();
  for (const [id, refs] of depMap) {
    if (!dependents.has(id)) dependents.set(id, new Set());
    for (const ref of refs) {
      if (!dependents.has(ref)) dependents.set(ref, new Set());
      dependents.get(ref)!.add(id);
    }
  }

  // Identify sinks: formulas with zero dependents
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
    const closure = transitiveClosure(sink, depMap, cycles);
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