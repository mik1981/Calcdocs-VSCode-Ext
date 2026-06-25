/**
 * toleranceModel.ts
 * ══════════════════════════════════════════════════════════════════════════════
 * Modello canonico a tre livelli per la propagazione delle tolleranze.
 *
 * Principio fondamentale: i tre livelli sono INDIPENDENTI e non devono essere
 * mai mescolati in un singolo campo YAML.
 *
 *   Livello 1 — UNCERTAINTY  : come viene descritta la banda di incertezza
 *   Livello 2 — DISTRIBUTION : come il valore è distribuito dentro la banda
 *   Livello 3 — PROPAGATION  : come si combinano le incertezze degli input
 *
 * YAML canonico (nuovo formato):
 *
 *   resistor:
 *     value: 100
 *     uncertainty:
 *       type: percent          # percent | range | absolute | sigma
 *       value: 5               # campi dipendono dal type (vedi UncertaintySpec)
 *     distribution:
 *       type: normal           # normal | uniform | triangular
 *       sigma_level: 3         # solo per normal: banda = ±sigma_level·σ
 *
 *   output_formula:
 *     formula: resistor * current
 *     propagation: monte_carlo  # worst_case | rss | monte_carlo
 *     confidence: 95            # percentile per i bounds MC (default 95)
 * ══════════════════════════════════════════════════════════════════════════════
 */

// ─── Livello 1: UNCERTAINTY ───────────────────────────────────────────────────

/**
 * Descrive la banda di incertezza di un input.
 * I campi ammessi dipendono dal `type` (validazione in validateUncertainty).
 */
export type UncertaintyType = "percent" | "range" | "absolute" | "sigma";

export interface UncertaintySpec {
  type: UncertaintyType;

  /** Solo per type=percent: percentuale (es. 5 → ±5%) */
  value?: number;

  /** Solo per type=range: limite inferiore assoluto */
  min?: number;

  /** Solo per type=range: limite superiore assoluto */
  max?: number;

  /** Solo per type=absolute: valore assoluto della banda (es. ±0.5) */
  absolute?: number;

  /** Solo per type=sigma: standard deviation diretta */
  sigma?: number;
}

/**
 * Rappresentazione interna normalizzata dell'incertezza.
 * Tutti i tipi vengono convertiti in [lower, upper] attorno al nominale.
 */
export interface NormalizedUncertainty {
  nominal: number;
  lower: number;   // valore minimo assoluto
  upper: number;   // valore massimo assoluto
  halfWidth: number; // (upper - lower) / 2
}

// ─── Livello 2: DISTRIBUTION ─────────────────────────────────────────────────

/**
 * Come il valore è distribuito all'interno della banda di incertezza.
 *
 *   normal     — gaussiana; sigma_level specifica quanti σ coprono la banda
 *   uniform    — uniforme tra [lower, upper]; default quando non specificata
 *   triangular — triangolare con picco al nominale
 */
export type DistributionType = "normal" | "uniform" | "triangular";

export interface DistributionSpec {
  type: DistributionType;

  /**
   * Solo per type=normal: quanti σ coprono la banda [lower, upper].
   * Default: 3.  Esempio: sigma_level=3 → σ = halfWidth / 3.
   */
  sigma_level?: number;

  /**
   * Solo per type=triangular: valore più probabile (picco).
   * Default: nominale.
   */
  mode_value?: number;
}

// ─── Livello 3: PROPAGATION ───────────────────────────────────────────────────

/**
 * Metodo con cui si combinano le incertezze degli input per calcolare
 * l'incertezza dell'output.
 *
 *   worst_case   — somma lineare delle sensibilità (garantistico, conservativo)
 *   rss          — radice della somma dei quadrati (valido per errori indipendenti)
 *   monte_carlo  — campionamento statistico; golden model di riferimento
 */
export type PropagationMethod = "worst_case" | "rss" | "monte_carlo";

export interface PropagationSpec {
  method: PropagationMethod;

  /** Percentile per i bounds MC, 0–100. Default: 95. */
  confidence?: number;

  /** Numero di campioni MC. Default: auto in base al numero di input. */
  samples?: number;

  /** Seed per riproducibilità MC. */
  seed?: number;
}

// ─── Specifica completa di un simbolo con incertezza ─────────────────────────

/**
 * Specifica completa per un simbolo input (const con incertezza).
 */
export interface InputUncertaintyDef {
  uncertainty: UncertaintySpec;
  distribution: DistributionSpec;
  normalized?: NormalizedUncertainty; // popolato dopo parsing
}

/**
 * Specifica completa per un simbolo output (formula con propagazione).
 */
export interface OutputPropagationDef {
  propagation: PropagationSpec;
}

// ─── Output della propagazione ────────────────────────────────────────────────

/**
 * Distribuzione completa dell'output dopo propagazione MC.
 */
export interface OutputDistribution {
  samples: number;

  mean: number;
  median: number;
  stddev: number;

  min: number;
  max: number;

  p001: number;
  p010: number;
  p025: number;
  p500: number;
  p975: number;
  p990: number;
  p999: number;

  skewness: number;
  kurtosis: number;

  /**
   * Pre-computed histogram derived directly from the Monte Carlo samples.
   * `counts[i]` = number of samples in bin i.
   * Bin i spans [lo + i*(hi-lo)/bins, lo + (i+1)*(hi-lo)/bins).
   * `lo` and `hi` are the actual sample min/max (= dist.min / dist.max).
   * The webview renders this directly — no CDF reconstruction, no synthetic
   * samples, no theoretical approximation.
   */
  histogram: {
    counts: number[];   // length = BINS (fixed 32)
    lo: number;         // = dist.min
    hi: number;         // = dist.max
  };
}

/**
 * Risultato della propagazione (usato da yamlEngine per popolare result.range).
 */
export interface PropagationResult {
  method: PropagationMethod;
  min: number;           // lower bound (default: p025 per MC, deterministic altrimenti)
  max: number;           // upper bound
  nominalValue?: number;
  stddev?: number;
  distribution?: OutputDistribution; // solo per MC
  contributingInputs: string[];
}

// ─── Backward-compat: vecchio formato flat ────────────────────────────────────

/**
 * Formato legacy (supportato in lettura, deprecato in scrittura).
 *
 *   X_GAUSS:
 *     tol: 5
 *     tol_mode: gaussian
 *     sigma: 2
 *
 * viene convertito internamente in:
 *   uncertainty: { type: percent, value: 5 }
 *   distribution: { type: normal, sigma_level: 2 }
 *   (propagation ereditata dall'output, non dall'input)
 */
export interface LegacyToleranceFlat {
  tol?: number;
  min?: number;
  max?: number;
  /** @deprecated Usa distribution.type sul simbolo output + propagation */
  tol_mode?: "worst_case" | "rss" | "gaussian" | "monte_carlo";
  /** @deprecated Usa distribution.sigma_level */
  sigma?: number;
  /** @deprecated */
  mode?: "worst_case" | "rss" | "gaussian" | "monte_carlo";
  probabilistic?: {
    mode?: "worst_case" | "rss" | "gaussian";
    sigma?: number;
    distribution?: "uniform" | "gaussian";
    solver?: "monte_carlo";
  };
}

// ─── Validazione ──────────────────────────────────────────────────────────────

export interface ValidationIssue {
  severity: "error" | "warning";
  field: string;
  message: string;
}

/**
 * Matrice dei campi ammessi/vietati per ogni UncertaintyType.
 * Produce errore se l'utente specifica un campo vietato.
 */
const UNCERTAINTY_FIELD_RULES: Record<
  UncertaintyType,
  { allowed: (keyof UncertaintySpec)[]; forbidden: (keyof UncertaintySpec)[] }
> = {
  percent:  { allowed: ["type", "value"],         forbidden: ["min", "max", "absolute", "sigma"] },
  range:    { allowed: ["type", "min", "max"],     forbidden: ["value", "absolute", "sigma"] },
  absolute: { allowed: ["type", "absolute"],       forbidden: ["value", "min", "max", "sigma"] },
  sigma:    { allowed: ["type", "sigma"],          forbidden: ["value", "min", "max", "absolute"] },
};

const DISTRIBUTION_FIELD_RULES: Record<
  DistributionType,
  { allowed: (keyof DistributionSpec)[]; forbidden: (keyof DistributionSpec)[] }
> = {
  normal:     { allowed: ["type", "sigma_level"],  forbidden: ["mode_value"] },
  uniform:    { allowed: ["type"],                 forbidden: ["sigma_level", "mode_value"] },
  triangular: { allowed: ["type", "mode_value"],   forbidden: ["sigma_level"] },
};

export function validateUncertainty(
  raw: Record<string, unknown>,
  symbolName: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const type = raw["type"] as UncertaintyType | undefined;

  if (!type) {
    issues.push({ severity: "error", field: "type",
      message: `[${symbolName}] uncertainty.type is required (percent | range | absolute | sigma).` });
    return issues;
  }

  const rules = UNCERTAINTY_FIELD_RULES[type];
  if (!rules) {
    issues.push({ severity: "error", field: "type",
      message: `[${symbolName}] Invalid uncertainty type "${type}". Valid: percent | range | absolute | sigma.` });
    return issues;
  }

  // Campi vietati
  for (const field of rules.forbidden) {
    if (field in raw) {
      issues.push({ severity: "error", field,
        message: `[${symbolName}] Invalid uncertainty definition. Field "${field}" is not allowed when type=${type}.` });
    }
  }

  // Campi obbligatori
  if (type === "percent" && raw["value"] === undefined) {
    issues.push({ severity: "error", field: "value",
      message: `[${symbolName}] uncertainty.value is required when type=percent.` });
  }
  if (type === "range" && (raw["min"] === undefined || raw["max"] === undefined)) {
    issues.push({ severity: "error", field: "min/max",
      message: `[${symbolName}] uncertainty.min and uncertainty.max are both required when type=range.` });
  }
  if (type === "absolute" && raw["absolute"] === undefined) {
    issues.push({ severity: "error", field: "absolute",
      message: `[${symbolName}] uncertainty.absolute is required when type=absolute.` });
  }
  if (type === "sigma" && raw["sigma"] === undefined) {
    issues.push({ severity: "error", field: "sigma",
      message: `[${symbolName}] uncertainty.sigma is required when type=sigma.` });
  }

  // Campi sconosciuti
  const knownFields = new Set([...rules.allowed, ...rules.forbidden]);
  for (const field of Object.keys(raw)) {
    if (!knownFields.has(field as keyof UncertaintySpec)) {
      issues.push({ severity: "warning", field,
        message: `[${symbolName}] Unknown uncertainty field "${field}" – ignored.` });
    }
  }

  return issues;
}

export function validateDistribution(
  raw: Record<string, unknown>,
  symbolName: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const type = raw["type"] as DistributionType | undefined;

  if (!type) {
    issues.push({ severity: "error", field: "type",
      message: `[${symbolName}] distribution.type is required (normal | uniform | triangular).` });
    return issues;
  }

  const rules = DISTRIBUTION_FIELD_RULES[type];
  if (!rules) {
    issues.push({ severity: "error", field: "type",
      message: `[${symbolName}] Invalid distribution type "${type}".` });
    return issues;
  }

  for (const field of rules.forbidden) {
    if (field in raw) {
      issues.push({ severity: "error", field,
        message: `[${symbolName}] Field "${field}" is not allowed when distribution.type=${type}.` });
    }
  }

  return issues;
}

// ─── Normalizzazione ──────────────────────────────────────────────────────────

/**
 * Converte una UncertaintySpec + nominal in NormalizedUncertainty.
 * Restituisce undefined se la specifica è invalida.
 */
export function normalizeUncertainty(
  spec: UncertaintySpec,
  nominal: number
): NormalizedUncertainty | undefined {
  let lower: number;
  let upper: number;

  switch (spec.type) {
    case "percent": {
      if (spec.value === undefined) return undefined;
      const delta = Math.abs(nominal) * Math.abs(spec.value) / 100;
      lower = nominal - delta;
      upper = nominal + delta;
      break;
    }
    case "range": {
      if (spec.min === undefined || spec.max === undefined) return undefined;
      lower = Math.min(spec.min, spec.max);
      upper = Math.max(spec.min, spec.max);
      break;
    }
    case "absolute": {
      if (spec.absolute === undefined) return undefined;
      lower = nominal - Math.abs(spec.absolute);
      upper = nominal + Math.abs(spec.absolute);
      break;
    }
    case "sigma": {
      if (spec.sigma === undefined) return undefined;
      // Per sigma, la banda è ±3σ per default (coprire 99.7%)
      lower = nominal - 3 * spec.sigma;
      upper = nominal + 3 * spec.sigma;
      break;
    }
    default:
      return undefined;
  }

  return { nominal, lower, upper, halfWidth: (upper - lower) / 2 };
}

/**
 * Estrae la standard deviation da NormalizedUncertainty + DistributionSpec.
 */
export function computeStdDev(
  norm: NormalizedUncertainty,
  dist: DistributionSpec
): number {
  switch (dist.type) {
    case "normal": {
      const sigmaLevel = dist.sigma_level ?? 3;
      return norm.halfWidth / sigmaLevel;
    }
    case "uniform":
      return norm.halfWidth / Math.sqrt(3);
    case "triangular":
      return norm.halfWidth / Math.sqrt(6);
  }
}

/**
 * Numero di campioni MC raccomandato in base al numero di input.
 * ≤5 input → 100000; ≤20 → 50000; >20 → 10000.
 */
export function recommendedSamples(inputCount: number): number {
  if (inputCount <= 5)  return 100_000;
  if (inputCount <= 20) return  50_000;
  return 10_000;
}
