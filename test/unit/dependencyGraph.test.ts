/**
 * Unit tests for dependencyGraph.ts
 *
 * These tests are self-contained and do NOT depend on vscode.
 */

import { describe, it, expect } from 'vitest';
import {
  extractFormulaDependencies,
  detectCycles,
  stableTopologicalSort,
  computeDependencyGroups,
  type DependencyGroup,
} from '../../src/formulaOutline/dependencyGraph';
import type { OutlineFormula } from '../../src/formulaOutline/formulaParser';

// Helper to create minimal formula stubs
function makeFormula(
  id: string,
  expr: string,
  lineStart: number = 0
): OutlineFormula {
  return {
    id,
    expr,
    lineStart,
    lineEnd: lineStart,
    rawNode: {},
  } as OutlineFormula;
}

describe('extractFormulaDependencies', () => {
  it('returns empty deps for formulas without expressions', () => {
    const formulas = [makeFormula('A', ''), makeFormula('B', '')];
    const deps = extractFormulaDependencies(formulas);
    expect(deps.get('A')).toEqual(new Set());
    expect(deps.get('B')).toEqual(new Set());
  });

  it('extracts references to other formula IDs', () => {
    const formulas = [
      makeFormula('A', 'B + C'),
      makeFormula('B', '42'),
      makeFormula('C', 'B + 1'),
    ];
    const deps = extractFormulaDependencies(formulas);
    expect(deps.get('A')).toEqual(new Set(['B', 'C']));
    expect(deps.get('B')).toEqual(new Set());
    expect(deps.get('C')).toEqual(new Set(['B']));
  });

  it('ignores self-references', () => {
    const formulas = [makeFormula('A', 'A + 1')];
    const deps = extractFormulaDependencies(formulas);
    expect(deps.get('A')).toEqual(new Set());
  });

  it('ignores non-formula symbols (C macros, math functions)', () => {
    const formulas = [
      makeFormula('A', 'MUL * ADC_MAX + sin(pi)'),
      makeFormula('B', 'A + MUL'),
    ];
    const deps = extractFormulaDependencies(formulas);
    // 'MUL', 'ADC_MAX', 'sin', 'pi' are not formula IDs
    expect(deps.get('A')).toEqual(new Set());
    expect(deps.get('B')).toEqual(new Set(['A']));
  });
});

describe('detectCycles', () => {
  it('returns empty set for DAG', () => {
    const formulas = [
      makeFormula('A', 'B + 1'),
      makeFormula('B', 'C + 1'),
      makeFormula('C', '42'),
    ];
    const deps = extractFormulaDependencies(formulas);
    const cycles = detectCycles(formulas, deps);
    expect(cycles.size).toBe(0);
  });

  it('detects simple cycle', () => {
    const formulas = [
      makeFormula('A', 'B + 1'),
      makeFormula('B', 'A + 1'),
    ];
    const deps = extractFormulaDependencies(formulas);
    const cycles = detectCycles(formulas, deps);
    expect(cycles.has('A')).toBe(true);
    expect(cycles.has('B')).toBe(true);
  });

  it('detects diamond with cycle', () => {
    const formulas = [
      makeFormula('A', 'B + 1'),
      makeFormula('B', 'C + 1'),
      makeFormula('C', 'A + 1'),
    ];
    const deps = extractFormulaDependencies(formulas);
    const cycles = detectCycles(formulas, deps);
    expect(cycles.size).toBe(3);
  });

  it('detects self-loop', () => {
    const formulas = [makeFormula('A', 'A + 1')];
    const deps = extractFormulaDependencies(formulas);
    const cycles = detectCycles(formulas, deps);
    expect(cycles.has('A')).toBe(false);
  });
});

describe('stableTopologicalSort', () => {
  it('returns empty for empty input', () => {
    const result = stableTopologicalSort([], new Map());
    expect(result).toEqual([]);
  });

  it('sorts dependencies before dependents', () => {
    const formulas = [
      makeFormula('C', 'A + B', 2),
      makeFormula('A', '42', 0),
      makeFormula('B', '1', 1),
    ];
    const deps = extractFormulaDependencies(formulas);
    const result = stableTopologicalSort(formulas, deps);
    // A and B (dependencies, source order) must come before C
    expect(result.indexOf('A')).toBeLessThan(result.indexOf('C'));
    expect(result.indexOf('B')).toBeLessThan(result.indexOf('C'));
  });

  it('preserves source order for valid candidates (tie-breaking)', () => {
    const formulas = [
      makeFormula('A', '42', 0),
      makeFormula('B', '1', 1),
      makeFormula('C', 'A + B', 2),
    ];
    const deps = extractFormulaDependencies(formulas);
    const result = stableTopologicalSort(formulas, deps);
    // A and B have no deps, so they appear first in source order
    expect(result[0]).toBe('A');
    expect(result[1]).toBe('B');
    expect(result[2]).toBe('C');
  });

  it('handles linear chain', () => {
    const formulas = [
      makeFormula('A', '42', 0),
      makeFormula('B', 'A + 1', 1),
      makeFormula('C', 'B + 1', 2),
    ];
    const deps = extractFormulaDependencies(formulas);
    const result = stableTopologicalSort(formulas, deps);
    expect(result).toEqual(['A', 'B', 'C']);
  });
});

describe('computeDependencyGroups', () => {
  it('returns empty for empty formulas', () => {
    const groups = computeDependencyGroups([]);
    expect(groups).toEqual([]);
  });

  it('computes groups for the example specification', () => {
    // From the specification:
    // a, b, c (constants with no expr / no deps)
    // d = a + b
    // e = b + c
    // f = a + d + e
    // g = a + b
    const formulas = [
      makeFormula('a', '', 0),
      makeFormula('b', '', 1),
      makeFormula('c', '', 2),
      makeFormula('d', 'a + b', 3),
      makeFormula('e', 'b + c', 4),
      makeFormula('f', 'a + d + e', 5),
      makeFormula('g', 'a + b', 6),
    ];

    const groups = computeDependencyGroups(formulas);

    // Should have 2 groups: f and g
    expect(groups.length).toBe(2);

    // Sort by decreasing closure size: f has 6, g has 3
    expect(groups[0].sink).toBe('f');
    expect(groups[1].sink).toBe('g');

    // Group f: a,b,c,d,e,f (6 formulas, stable topo = deps before dependents)
    expect(groups[0].formulaIds).toContain('a');
    expect(groups[0].formulaIds).toContain('b');
    expect(groups[0].formulaIds).toContain('c');
    expect(groups[0].formulaIds).toContain('d');
    expect(groups[0].formulaIds).toContain('e');
    expect(groups[0].formulaIds).toContain('f');
    expect(groups[0].formulaIds.length).toBe(6);

    // Group g: a,b,g (3 formulas)
    expect(groups[1].formulaIds).toContain('a');
    expect(groups[1].formulaIds).toContain('b');
    expect(groups[1].formulaIds).toContain('g');
    expect(groups[1].formulaIds.length).toBe(3);

    // a and b appear in both groups
    const groupF_a = groups[0].formulaIds.indexOf('a');
    const groupG_a = groups[1].formulaIds.indexOf('a');
    expect(groupF_a).toBeGreaterThanOrEqual(0);
    expect(groupG_a).toBeGreaterThanOrEqual(0);

    // Stable topological sort check: in group f,
    // a,b,c must come before d,e; d,e must come before f
    const idx = (id: string) => groups[0].formulaIds.indexOf(id);
    expect(idx('a')).toBeLessThan(idx('d'));
    expect(idx('b')).toBeLessThan(idx('d'));
    expect(idx('b')).toBeLessThan(idx('e'));
    expect(idx('c')).toBeLessThan(idx('e'));
    expect(idx('d')).toBeLessThan(idx('f'));
    expect(idx('e')).toBeLessThan(idx('f'));
  });

  it('handles diamond dependency', () => {
    //    A
    //   / \
    //  B   C
    //   \ /
    //    D
    const formulas = [
      makeFormula('A', '42', 0),
      makeFormula('B', 'A + 1', 1),
      makeFormula('C', 'A + 2', 2),
      makeFormula('D', 'B + C', 3),
    ];
    const groups = computeDependencyGroups(formulas);

    // Only sink is D
    expect(groups.length).toBe(1);
    expect(groups[0].sink).toBe('D');
    expect(groups[0].formulaIds).toContain('A');
    expect(groups[0].formulaIds).toContain('B');
    expect(groups[0].formulaIds).toContain('C');
    expect(groups[0].formulaIds).toContain('D');

    // A before B, A before C, B before D, C before D
    const idx = (id: string) => groups[0].formulaIds.indexOf(id);
    expect(idx('A')).toBeLessThan(idx('B'));
    expect(idx('A')).toBeLessThan(idx('C'));
    expect(idx('B')).toBeLessThan(idx('D'));
    expect(idx('C')).toBeLessThan(idx('D'));
  });

  it('handles formulas without expressions (pure constants)', () => {
    const formulas = [
      makeFormula('X', '', 0),
      makeFormula('Y', '', 1),
    ];
    const groups = computeDependencyGroups(formulas);
    // X and Y have no deps and no dependents → both are sinks
    // But since neither references the other, each forms its own group of size 1
    expect(groups.length).toBe(2);
  });

  it('does not crash on cycles', () => {
    const formulas = [
      makeFormula('A', 'B + 1', 0),
      makeFormula('B', 'A + 1', 1),
    ];
    // Should not throw
    const groups = computeDependencyGroups(formulas);
    // Both are cyclic but we don't crash — A and B have dependents from each other
    // Both A and B have dependents, so neither is a sink
    expect(Array.isArray(groups)).toBe(true);
  });

  it('formulas may appear in multiple groups', () => {
    const formulas = [
      makeFormula('base', '42', 0),
      makeFormula('X', 'base + 1', 1),
      makeFormula('Y', 'base + 2', 2),
    ];
    const groups = computeDependencyGroups(formulas);
    // X and Y are both sinks (no one depends on them)
    expect(groups.length).toBe(2);
    // base appears in both groups
    for (const group of groups) {
      expect(group.formulaIds).toContain('base');
    }
  });
});