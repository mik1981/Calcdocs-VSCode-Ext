/**
 * formulaYaml.ts
 * ══════════════════════════════════════════════════════════════════════════════
 * Parser del formato YAML delle formule CalcDocs.
 *
 * Supporta due formati per la tolleranza:
 *
 * ── NUOVO (canonico, preferito) ───────────────────────────────────────────────
 *   resistor:
 *     value: 100
 *     uncertainty:
 *       type: percent
 *       value: 5
 *     distribution:
 *       type: normal
 *       sigma_level: 3
 *
 *   output_formula:
 *     formula: resistor * current
 *     propagation: monte_carlo      # worst_case | rss | monte_carlo
 *     confidence: 95
 *
 * ── LEGACY (deprecato, letto ma non scritto) ──────────────────────────────────
 *   resistor:
 *     value: 100
 *     tol: 5
 *     tol_mode: gaussian
 *     sigma: 2
 *
 * ══════════════════════════════════════════════════════════════════════════════
 */

import * as yaml from "js-yaml";
import type {
  UncertaintySpec,
  DistributionSpec,
  PropagationMethod,
  ValidationIssue,
} from "../types/toleranceModel";
import {
  validateUncertainty,
  validateDistribution,
} from "../types/toleranceModel";

export const FORMULA_YAML_FILE_RX = /(^|[\\/])formulas?.*\.ya?ml$/i;

// ─── Tipo canonico per la tolleranza di un simbolo ───────────────────────────

/**
 * ParsedInputTolerance — tolleranza di un simbolo input (const).
 * Contiene i tre livelli separati.
 */
export interface ParsedInputTolerance {
  uncertainty: UncertaintySpec;
  distribution: DistributionSpec;
  /** Issue di validazione riscontrate durante il parsing. */
  issues: ValidationIssue[];
  /** true se derivato dalla conversione del formato legacy. */
  isLegacy: boolean;
}

/**
 * ParsedOutputPropagation — metodo di propagazione per un simbolo output (expr).
 */
export interface ParsedOutputPropagation {
  method: PropagationMethod;
  confidence?: number;
  samples?: number;
  seed?: number;
}

/**
 * FormulaToleranceSpec — contenitore completo per un simbolo.
 * Uno dei due campi (input / output) sarà presente, mai entrambi.
 */
export interface FormulaToleranceSpec {
  /** Presente se il simbolo è un input con incertezza (const). */
  input?: ParsedInputTolerance;

  /** Presente se il simbolo è un output con propagazione (expr/lookup). */
  output?: ParsedOutputPropagation;

  /**
   * Overrides per-parametro: la formula output può specificare una
   * tolleranza diversa per ogni sua dipendenza.
   *
   *   formula:
   *     formula: R * I
   *     parameter_tolerances:
   *       R:
   *         uncertainty: { type: percent, value: 1 }
   *         distribution: { type: normal, sigma_level: 3 }
   */
  parameterOverrides?: Record<string, ParsedInputTolerance>;

  /** Issue aggregate (input + overrides). */
  issues: ValidationIssue[];
}

// ─── Backward-compat: alias per il vecchio FormulaToleranceRange ──────────────

/** @deprecated Usa ParsedInputTolerance */
export interface FormulaToleranceRange {
  min?: number;
  max?: number;
  tol?: number;
  mode?: string;
  sigma?: number;
  source?: string;
}

// ─── Helpers di parsing ───────────────────────────────────────────────────────

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseFloat(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function toNumericArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const item of value) {
    const n = toFiniteNumber(item);
    if (n === undefined) return undefined;
    out.push(n);
  }
  return out;
}

// ─── Parsing formato NUOVO ────────────────────────────────────────────────────

function parseUncertaintySpec(
  raw: unknown,
  symbolName: string
): { spec: UncertaintySpec; issues: ValidationIssue[] } | undefined {
  if (!isObjectRecord(raw)) return undefined;

  const issues = validateUncertainty(raw as Record<string, unknown>, symbolName);
  const type   = raw["type"] as UncertaintySpec["type"] | undefined;
  if (!type) return { spec: { type: "percent" }, issues }; // sentinel

  const spec: UncertaintySpec = { type };
  if (raw["value"]    !== undefined) spec.value    = toFiniteNumber(raw["value"]);
  if (raw["min"]      !== undefined) spec.min      = toFiniteNumber(raw["min"]);
  if (raw["max"]      !== undefined) spec.max      = toFiniteNumber(raw["max"]);
  if (raw["absolute"] !== undefined) spec.absolute = toFiniteNumber(raw["absolute"]);
  if (raw["sigma"]    !== undefined) spec.sigma    = toFiniteNumber(raw["sigma"]);

  return { spec, issues };
}

function parseDistributionSpec(
  raw: unknown,
  symbolName: string
): { spec: DistributionSpec; issues: ValidationIssue[] } | undefined {
  if (!isObjectRecord(raw)) return undefined;

  const issues = validateDistribution(raw as Record<string, unknown>, symbolName);
  const type   = raw["type"] as DistributionSpec["type"] | undefined;
  if (!type) return { spec: { type: "uniform" }, issues }; // default

  const spec: DistributionSpec = { type };
  if (raw["sigma_level"] !== undefined) spec.sigma_level = toFiniteNumber(raw["sigma_level"]);
  if (raw["mode_value"]  !== undefined) spec.mode_value  = toFiniteNumber(raw["mode_value"]);

  return { spec, issues };
}

function parsePropagationMethod(raw: unknown): PropagationMethod | undefined {
  if (raw === "worst_case" || raw === "rss" || raw === "monte_carlo") return raw;
  return undefined;
}

// ─── Conversione formato LEGACY → nuovo ───────────────────────────────────────

/**
 * Converte i campi legacy (tol, tol_mode, sigma, probabilistic) nel nuovo formato.
 * Emette warning per ogni campo deprecato usato.
 */
function convertLegacyToleranceToNew(
  node: Record<string, unknown>,
  symbolName: string
): ParsedInputTolerance | undefined {
  const issues: ValidationIssue[] = [];
  const hasTol  = node["tol"]      !== undefined;
  const hasMin  = node["min"]      !== undefined;
  const hasMax  = node["max"]      !== undefined;
  const hasProb = isObjectRecord(node["probabilistic"]);

  if (!hasTol && !hasMin && !hasMax && !hasProb) return undefined;

  // Legge il mode dal campo legacy (tol_mode, mode, probabilistic.mode)
  const rawMode =
    node["tol_mode"] ??
    node["mode"]     ??
    (hasProb ? (node["probabilistic"] as Record<string, unknown>)["mode"] : undefined);

  const rawSigma =
    node["sigma"] ??
    (hasProb ? (node["probabilistic"] as Record<string, unknown>)["sigma"] : undefined);

  // Costruisce uncertainty
  let uncertainty: UncertaintySpec;
  if (hasTol) {
    uncertainty = { type: "percent", value: toFiniteNumber(node["tol"]) };
    issues.push({ severity: "warning", field: "tol",
      message: `[${symbolName}] Legacy field "tol" – use uncertainty: { type: percent, value: N } instead.` });
  } else {
    // min/max espliciti
    uncertainty = {
      type: "range",
      min: toFiniteNumber(node["min"]),
      max: toFiniteNumber(node["max"]),
    };
    issues.push({ severity: "warning", field: "min/max",
      message: `[${symbolName}] Legacy fields "min"/"max" – use uncertainty: { type: range, min: N, max: N } instead.` });
  }

  // Costruisce distribution
  let distribution: DistributionSpec;
  const mode = typeof rawMode === "string" ? rawMode.toLowerCase() : undefined;
  if (mode === "gaussian" || mode === "normal") {
    distribution = {
      type: "normal",
      sigma_level: toFiniteNumber(rawSigma) ?? 3,
    };
  } else {
    distribution = { type: "uniform" };
  }

  if (rawMode !== undefined) {
    issues.push({ severity: "warning", field: "tol_mode",
      message: `[${symbolName}] Legacy field "tol_mode"/"mode" – use distribution: { type: ... } on the input and propagation: ... on the output instead.` });
  }

  return { uncertainty, distribution, issues, isLegacy: true };
}

// ─── Parser principale della tolleranza ──────────────────────────────────────

/**
 * Legge la specifica di tolleranza da un nodo YAML.
 * Gestisce nuovo formato e legacy in modo trasparente.
 */
export function parseToleranceSpec(
  node: Record<string, unknown>,
  symbolName: string
): FormulaToleranceSpec | undefined {
  const issues: ValidationIssue[] = [];

  // ── PROPAGATION (per output / formula) ──
  const rawProp = node["propagation"];
  const method  = parsePropagationMethod(rawProp);

  // ── INPUT UNCERTAINTY (per input / const) ── nuovo formato
  const rawUnc  = node["uncertainty"];
  const rawDist = node["distribution"];

  const hasNewUncertainty  = isObjectRecord(rawUnc);
  const hasNewDistribution = isObjectRecord(rawDist);

  // ── Legacy check ──
  const legacyInput = convertLegacyToleranceToNew(node, symbolName);

  // ── Parameter overrides ──
  const rawParamTol = node["parameter_tolerances"];
  const parameterOverrides: Record<string, ParsedInputTolerance> = {};
  if (isObjectRecord(rawParamTol)) {
    for (const [paramName, paramRaw] of Object.entries(rawParamTol)) {
      if (!isObjectRecord(paramRaw)) continue;
      const paramKey = `${symbolName}.${paramName}`;
      const pUnc  = parseUncertaintySpec(paramRaw["uncertainty"], paramKey);
      const pDist = parseDistributionSpec(
        paramRaw["distribution"] ?? { type: "uniform" },
        paramKey
      );
      if (pUnc) {
        issues.push(...pUnc.issues);
        issues.push(...(pDist?.issues ?? []));
        parameterOverrides[paramName] = {
          uncertainty:  pUnc.spec,
          distribution: pDist?.spec ?? { type: "uniform" },
          issues:       [...pUnc.issues, ...(pDist?.issues ?? [])],
          isLegacy:     false,
        };
      }
    }
  }

  // Errore se nuovo e legacy sono mescolati sullo stesso nodo
  if (hasNewUncertainty && legacyInput) {
    issues.push({ severity: "error", field: "uncertainty",
      message: `[${symbolName}] Cannot mix new "uncertainty:" block with legacy "tol"/"min"/"max" fields. Remove the legacy fields.` });
  }

  const hasAnything = hasNewUncertainty || legacyInput || method !== undefined || Object.keys(parameterOverrides).length > 0;
  if (!hasAnything) return undefined;

  const result: FormulaToleranceSpec = { issues };

  // Costruisce input spec
  if (hasNewUncertainty) {
    const pUnc  = parseUncertaintySpec(rawUnc, symbolName)!;
    const pDist = parseDistributionSpec(
      hasNewDistribution ? rawDist : { type: "uniform" },
      symbolName
    );
    if (!hasNewDistribution) {
      issues.push({ severity: "warning", field: "distribution",
        message: `[${symbolName}] No "distribution:" block found – defaulting to uniform.` });
    }
    issues.push(...pUnc.issues, ...(pDist?.issues ?? []));
    result.input = {
      uncertainty:  pUnc.spec,
      distribution: pDist?.spec ?? { type: "uniform" },
      issues:       [...pUnc.issues, ...(pDist?.issues ?? [])],
      isLegacy:     false,
    };
  } else if (legacyInput) {
    issues.push(...legacyInput.issues);
    result.input = legacyInput;
  }

  // Costruisce output propagation spec
  if (method !== undefined) {
    result.output = {
      method,
      confidence: toFiniteNumber(node["confidence"]),
      samples:    toFiniteNumber(node["samples"]) !== undefined
                    ? Math.round(toFiniteNumber(node["samples"])!) : undefined,
      seed:       toFiniteNumber(node["seed"]) !== undefined
                    ? Math.round(toFiniteNumber(node["seed"])!) : undefined,
    };
  }

  if (Object.keys(parameterOverrides).length > 0) {
    result.parameterOverrides = parameterOverrides;
  }

  return result;
}

// ─── Tipi e funzioni pubbliche non cambiate ───────────────────────────────────

export type ParsedFormulaYamlEntry = {
  id: string;
  expr: string;
  desc?: string;
  example?: Record<string, number>;
  unit?: string;
  value?: number;
  values?: number[];
  parameters?: string[];
  tolerance?: FormulaToleranceSpec;
  lineStart: number;
  lineEnd: number;
  _filePath?: string;
  line?: number;
  rawNode: Record<string, unknown>;
};

const NUMERIC_WITH_UNIT_RX =
  /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-z%][A-Za-z0-9_%]*)$/;

export function parseFormulaYamlValue(value: unknown): {
  value?: number; values?: number[]; unitFromValue?: string;
} {
  const values = toNumericArray(value);
  if (values) return { values };
  if (typeof value === "string") {
    const match = value.trim().match(NUMERIC_WITH_UNIT_RX);
    if (match) return { value: Number(match[1]), unitFromValue: match[2] };
  }
  return { value: toFiniteNumber(value) };
}

export function getYamlTopLevelLine(yamlText: string, key: string): number {
  const lines = yamlText.split(/\r?\n/);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyRegex = new RegExp(`^\\s*${escapedKey}\\s*:\\s*(#.*)?$`);
  return lines.findIndex((line) => keyRegex.test(line));
}

function getTopLevelKeyLines(lines: string[]): Map<string, number> {
  const result = new Map<string, number>();
  const keyRx  = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(?:#.*)?$/;
  lines.forEach((line, index) => {
    if (/^\s/.test(line)) return;
    const match = line.trim().match(keyRx);
    if (match) result.set(match[1], index);
  });
  return result;
}

function getLineEnd(lineStart: number, orderedStarts: number[], lineCount: number): number {
  const next = orderedStarts.find((line) => line > lineStart);
  return (next ?? lineCount) - 1;
}

function parseExample(node: Record<string, unknown>): Record<string, number> {
  const example: Record<string, number> = {};
  const reserved = new Set([
    "type","expr","formula","unit","desc","description","value","values",
    "steps","labels","etichette","revision","parameters","tolerance",
    "ranges","min","max","tol","uncertainty","distribution","propagation",
    "confidence","samples","seed","parameter_tolerances",
    "tol_mode","mode","sigma","probabilistic",
  ]);
  if (isObjectRecord(node.example)) {
    for (const [key, value] of Object.entries(node.example)) {
      const n = toFiniteNumber(value);
      if (n !== undefined) example[key] = n;
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (reserved.has(key)) continue;
    const n = toFiniteNumber(value);
    if (n !== undefined) example[key] = n;
  }
  return example;
}

function parseParameterNames(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw.split(",").map(p => p.trim()).filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map(p => String(p).trim()).filter(Boolean);
  }
  if (isObjectRecord(raw)) {
    return Object.keys(raw).filter(Boolean);
  }
  return [];
}

export function normalizeFormulaYamlNode(
  id: string,
  node: Record<string, unknown>,
  yamlText: string,
  filePath?: string
): ParsedFormulaYamlEntry {
  const rawValue = parseFormulaYamlValue(node.value);
  const expr =
    (typeof node.expr    === "string" ? node.expr    : undefined) ??
    (typeof node.formula === "string" ? node.formula : undefined) ?? "";
  const unit =
    (typeof node.unit === "string" ? node.unit.trim() : undefined) ??
    rawValue.unitFromValue;
  const desc =
    (typeof node.desc        === "string" ? node.desc        : undefined) ??
    (typeof node.description === "string" ? node.description : undefined);
  const parameters = parseParameterNames(node.parameters);
  const lineStart  = Math.max(0, getYamlTopLevelLine(yamlText, id));

  return {
    id,
    expr,
    desc,
    example:    parseExample(node),
    unit,
    value:      rawValue.value,
    values:     rawValue.values,
    parameters: parameters.length > 0 ? parameters : undefined,
    tolerance:  parseToleranceSpec(node, id),
    lineStart,
    lineEnd:    lineStart,
    _filePath:  filePath,
    line:       lineStart,
    rawNode:    node,
  };
}

export function parseFormulaYamlText(rawText: string, filePath?: string): ParsedFormulaYamlEntry[] {
  const parsedRoot = yaml.load(rawText);
  if (!isObjectRecord(parsedRoot)) return [];

  const lines        = rawText.split(/\r?\n/);
  const keyLines     = getTopLevelKeyLines(lines);
  const orderedStarts = Array.from(keyLines.values()).sort((a, b) => a - b);
  const entries: ParsedFormulaYamlEntry[] = [];

  for (const [id, rawNode] of Object.entries(parsedRoot)) {
    if (!isObjectRecord(rawNode)) continue;
    const entry     = normalizeFormulaYamlNode(id, rawNode, rawText, filePath);
    const lineStart = keyLines.get(id) ?? entry.lineStart;
    entry.lineStart = lineStart;
    entry.line      = lineStart;
    entry.lineEnd   = getLineEnd(lineStart, orderedStarts, lines.length);
    if (entry.expr || entry.value !== undefined || entry.values !== undefined) {
      entries.push(entry);
    }
  }

  return entries;
}

export function parseFormulaYamlLines(lines: string[], filePath?: string): ParsedFormulaYamlEntry[] {
  return parseFormulaYamlText(lines.join("\n"), filePath);
}

export function isFormulaYamlFileName(fileName: string): boolean {
  return FORMULA_YAML_FILE_RX.test(fileName);
}