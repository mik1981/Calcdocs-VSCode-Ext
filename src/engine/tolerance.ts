/**
 * tolerance.ts — versione type-safe senza require()
 */
export type {
  UncertaintyType, UncertaintySpec, NormalizedUncertainty,
  DistributionType, DistributionSpec,
  PropagationMethod, PropagationSpec,
  InputUncertaintyDef, OutputPropagationDef,
  OutputDistribution, PropagationResult,
  LegacyToleranceFlat, ValidationIssue,
} from "../types/toleranceModel";
export {
  validateUncertainty, validateDistribution,
  normalizeUncertainty, computeStdDev, recommendedSamples,
} from "../types/toleranceModel";

export type DistributionKind = "normal" | "uniform" | "triangular";

import type { UncertaintySpec, DistributionSpec } from "../types/toleranceModel";
import { normalizeUncertainty, computeStdDev } from "../types/toleranceModel";

export interface McSampleSpec {
  name: string;
  nominal: number;
  lower: number;
  upper: number;
  distribution: DistributionKind;
  sigmaLevel: number;
  stdDev: number;
}

export function buildMcSampleSpec(
  name: string,
  nominal: number,
  uncertainty: UncertaintySpec,
  distribution: DistributionSpec,
): McSampleSpec | undefined {
  const norm = normalizeUncertainty(uncertainty, nominal);
  if (!norm) return undefined;
  const distKind: DistributionKind =
    distribution.type === "normal"     ? "normal"     :
    distribution.type === "triangular" ? "triangular" : "uniform";
  const sigmaLevel = distribution.type === "normal" ? (distribution.sigma_level ?? 3) : 1;
  const stdDev = computeStdDev(norm, distribution);
  return { name, nominal, lower: norm.lower, upper: norm.upper, distribution: distKind, sigmaLevel, stdDev };
}