/**
 * analysis/index.ts
 *
 * Public exports for the Physics-Aware Dependency Clustering module.
 *
 * This module is a STRICTLY ADDITIVE analysis layer on top of the existing
 * dependency graph and formula model. No parser, AST, dependency engine, or
 * core formula model is modified.
 *
 * Structure:
 *   dimTypes.ts      - Types for dimension results, canonical keys, SI units, clusters
 *   dimEngine.ts     - Dimensional vector propagation engine (tokenizer + RPN evaluator)
 *   dimCanonicalizer.ts - Canonical form normalization (integer ratio reduction)
 *   siResolver.ts    - Deterministic SI unit resolution from dimension vectors
 *   dimClustering.ts - Physics-aware clustering layer (cache + clustering algorithm)
 */

// Types
export type {
  DimStatus,
  DimResult,
  CanonicalKey,
  SiUnitMatch,
  PhysicalCluster,
  PhysicsAugmentedGroup,
  DimCacheEntry,
} from "./dimTypes";

// Engine
export { computeExpressionDim, areAdditionCompatible, getUnitDim } from "./dimEngine";

// Canonicalization
export {
  toCanonicalKey,
  canonicalKeyFromResult,
} from "./dimCanonicalizer";

// SI resolution
export {
  resolveSiUnits,
  formatSiUnits,
  canonicalKeyFromVector,
} from "./siResolver";

// Clustering
export {
  DimCache,
  clusterDependencyGroup,
  computePhysicsClusters,
} from "./dimClustering";