import { describe, expect, it } from 'vitest';
import { computePhysicsClusters, DimCache } from '../../src/analysis/dimClustering';
import { computeDependencyGroups } from '../../src/formulaOutline/dependencyGraph';
import type { OutlineFormula } from '../../src/formulaOutline/formulaParser';

function makeFormula(id: string, expr: string, unit?: string, lineStart = 0): OutlineFormula {
  return { id, expr, unit, lineStart, lineEnd: lineStart, rawNode: {} } as OutlineFormula;
}

describe('computePhysicsClusters', () => {
  it('returns empty for empty input', () => {
    expect(computePhysicsClusters([])).toEqual([]);
  });

  it('clusters formulas with same dimension', () => {
    const formulas = [
      makeFormula('MASS', '10', 'kg'),
      makeFormula('ACCEL', '9.81', 'm/s2'),
      makeFormula('FORCE', 'MASS * ACCEL', 'N'),
    ];
    const groups = computePhysicsClusters(formulas);
    expect(groups.length).toBeGreaterThanOrEqual(1);
  });

  it('returns UNKNOWN for unknown variables', () => {
    const formulas = [makeFormula('X', 'UNKNOWN_VAR + 1')];
    const groups = computePhysicsClusters(formulas);
    const keys = groups.flatMap(g => g.clusters.map(c => c.canonicalKey));
    expect(keys).toContain('UNKNOWN');
  });

  it('groups dimensionless constants', () => {
    const formulas = [makeFormula('PI', '3.14', '')];
    const groups = computePhysicsClusters(formulas);
    const labels = groups.flatMap(g => g.clusters.map(c => c.label));
    expect(labels).toContain('dimensionless');
  });

  it('preserves topological order within clusters', () => {
    const formulas = [
      makeFormula('A', '1', 'm', 0),
      makeFormula('B', 'A * 2', 'm', 1),
      makeFormula('C', 'B * 3', 'm', 2),
    ];
    const groups = computePhysicsClusters(formulas);
    const cluster = groups.flatMap(g => g.clusters).find(c => c.formulaIds.length === 3);
    expect(cluster).toBeDefined();
    const ids = cluster!.formulaIds;
    expect(ids.indexOf('A')).toBeLessThan(ids.indexOf('B'));
    expect(ids.indexOf('B')).toBeLessThan(ids.indexOf('C'));
  });

  it('does not throw on cycles', () => {
    const formulas = [makeFormula('A', 'B + 1'), makeFormula('B', 'A + 1')];
    expect(() => computePhysicsClusters(formulas)).not.toThrow();
  });
});

describe('DimCache', () => {
  it('caches dimension results', () => {
    const formulas = [makeFormula('X', '1', 'm')];
    const cache = new DimCache();
    cache.initialize(formulas);
    expect(cache.get('X')).toBeDefined();
  });

  it('invalidates entries', () => {
    const formulas = [makeFormula('X', '1', 'm')];
    const cache = new DimCache();
    cache.initialize(formulas);
    cache.invalidate('X');
    expect(cache.get('X')).toBeUndefined();
  });
});

describe('regression: dependency engine unchanged', () => {
  it('computeDependencyGroups still works', () => {
    const formulas = [makeFormula('base', '42'), makeFormula('derived', 'base + 1'), makeFormula('sink', 'derived + 2')];
    const groups = computeDependencyGroups(formulas);
    expect(groups.length).toBe(1);
    expect(groups[0].sink).toBe('sink');
    expect(groups[0].formulaIds).toContain('base');
  });
});