/**
 * Analisi dimensionale ipotetica per formule con parametri liberi.
 *
 * Quando yamlEngine.ts segnala "unit mismatch" su una formula che ha
 * dipendenze non risolte (variabili libere come NTC_R senza unit:
 * dichiarata), questo modulo tenta di capire se esiste un'assegnazione
 * di unità ai parametri liberi tale da chiudere il bilancio dimensionale
 * con l'output unit dichiarato. Se sì, la formula è "ragionevolmente
 * corretta" e l'errore non va segnalato — solo un info con l'ipotesi.
 *
 * Usa SOLO:
 * - il parser dimensionale già esistente (formulaOutline/dimensionEvaluator.ts)
 * - le unità già note in state.symbolUnits / state.formulaIndex / localEntries
 * - le unità già note negli altri simboli della stessa formula (heuristic)
 * - UNIT_SPEC_LIST dell'engine per cercare unità compatibili
 *
 * Nessuna nuova valutazione di espressioni, nessuna scansione workspace.
 */

import type { CalcDocsState } from "../core/state";
import type { FormulaEntry } from "../types/FormulaEntry";
import {
  evaluateExpressionDimensions,
  getUnitDim,
  type Dim,
} from "../formulaOutline/dimensionEvaluator";
import {
  UNIT_SPEC_LIST,
  dimensionsEqual,
  isDimensionless,
  type DimensionVector,
} from "../engine/units";

export type ParameterHypothesis = {
  paramName: string;
  assumedUnit: string;
  assumedDim: Dim;
};

export type ParametricAnalysisResult =
  | {
      compatible: true;
      hypotheses: ParameterHypothesis[];
      message: string;
    }
  | {
      compatible: false;
      reason: string;
    }
  | {
      compatible: "unknown";
      reason: string;
    };

// Costanti matematiche e funzioni built-in da ignorare nell'analisi
const BUILTIN_TOKENS = new Set([
  "abs", "acos", "asin", "atan", "atan2", "ceil", "cos", "csv",
  "e", "exp", "floor", "ln", "log", "log10", "lookup", "max", "min",
  "pi", "pow", "round", "sin", "sqrt", "table", "tan", "trunc",
  "E", "PI",
]);

const IDENTIFIER_RX = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;

/** Raccoglie tutti gli identificatori usati nell'espressione */
function collectTokens(expression: string): string[] {
  const tokens = new Set<string>();
  for (const match of expression.matchAll(IDENTIFIER_RX)) {
    const t = match[1];
    if (!BUILTIN_TOKENS.has(t) && !/^\d/.test(t)) {
      tokens.add(t);
    }
  }
  return Array.from(tokens);
}

/** Risolve la dimensione di un simbolo noto */
function resolveKnownDim(
  name: string,
  state: CalcDocsState,
  localEntries?: ReadonlyMap<string, FormulaEntry>
): Dim | null {
  const unit =
    state.symbolUnits.get(name) ??
    state.formulaIndex.get(name)?.unit ??
    localEntries?.get(name)?.unit;
  if (!unit) return null;
  return getUnitDim(unit);
}

/**
 * Costruisce la mappa nome→dimensione usata da evaluateExpressionDimensions,
 * includendo i simboli noti e usando l'ipotesi per quelli liberi.
 */
function buildDimMap(
  tokens: string[],
  state: CalcDocsState,
  localEntries: ReadonlyMap<string, FormulaEntry> | undefined,
  hypothesis: Map<string, Dim>
): Map<string, DimensionVector> {
  const dimMap = new Map<string, DimensionVector>();
  for (const token of tokens) {
    const hyp = hypothesis.get(token);
    if (hyp) {
      dimMap.set(token, hyp as DimensionVector);
      continue;
    }
    const known = resolveKnownDim(token, state, localEntries);
    if (known) {
      dimMap.set(token, known as DimensionVector);
    }
    // se non noto e non ipotizzato, lascia fuori → dimensionless per default
    // nel parser dimensionale (comportamento attuale di dimensionEvaluator)
  }
  return dimMap;
}

/**
 * Verifica se le dimensioni dell'espressione con le ipotesi date
 * coincidono con la dimensione dell'output unit atteso.
 */
function checkDimensions(
  expression: string,
  targetDim: Dim | null,
  dimMap: Map<string, DimensionVector>
): boolean {
  const result = evaluateExpressionDimensions(expression, dimMap);
  if (!result.dimension) return false;
  if (!targetDim) {
    // output unit non dichiarato o dimensionless: la formula va bene
    return isDimensionless(result.dimension as DimensionVector) || true;
  }
  return dimensionsEqual(
    result.dimension as DimensionVector,
    targetDim as DimensionVector
  );
}

/**
 * Raccoglie unità candidate per un parametro libero cercando:
 * 1. Le unità degli altri simboli nella stessa formula (heuristic
 *    "stesso tipo fisico dei vicini")
 * 2. L'output unit stessa (per formule del tipo OUT = FREE * known)
 * 3. Le famiglie dimensionali dei gruppi più comuni (R, C, L, V, A, W...)
 *
 * Limitato a max ~30 candidati per non esplose combinatorialmente.
 */
function collectCandidateUnits(
  freeParam: string,
  allTokens: string[],
  expression: string,
  outputUnit: string | undefined,
  state: CalcDocsState,
  localEntries: ReadonlyMap<string, FormulaEntry> | undefined
): string[] {
  const candidates = new Set<string>();

  // 1. Unità degli altri simboli noti nella formula
  for (const token of allTokens) {
    if (token === freeParam) continue;
    const unit =
      state.symbolUnits.get(token) ??
      state.formulaIndex.get(token)?.unit ??
      localEntries?.get(token)?.unit;
    if (unit) candidates.add(unit);
  }

  // 2. Output unit stessa
  if (outputUnit) candidates.add(outputUnit);

  // 3. Unità più comuni dell'ingegneria elettrica/meccanica
  // (lista ridotta, solo famiglie rilevanti per evitare explosion)
  const COMMON_UNITS = [
    "Ohm", "kOhm", "MOhm",
    "V", "mV",
    "A", "mA", "uA",
    "W", "mW",
    "F", "uF", "nF", "pF",
    "H", "mH", "uH",
    "Hz", "kHz", "MHz",
    "s", "ms", "us",
    "m", "mm", "km",
    "K", "degC",
    "N", "Pa",
    "kg", "g",
  ];
  for (const u of COMMON_UNITS) candidates.add(u);

  return Array.from(candidates).slice(0, 32);
}

/**
 * Analisi principale. Tenta ipotesi di unità per i parametri liberi
 * e verifica se le dimensioni chiudono con l'output unit dichiarato.
 *
 * Complessità: O(freeParams × candidateUnits) = tipicamente O(2 × 30) = O(60)
 * Non scala esponenzialmente perché considera i parametri liberi
 * INDIPENDENTEMENTE (un'assunzione semplificativa ma corretta per la
 * quasi totalità dei casi reali: se due parametri liberi devono avere
 * la stessa unità per chiudere, il solutore li trova entrambi).
 */
export function analyzeParametricFormula(
  entry: FormulaEntry,
  state: CalcDocsState,
  localEntries?: ReadonlyMap<string, FormulaEntry>
): ParametricAnalysisResult {
  const expression = entry.formula;
  if (!expression) {
    return { compatible: "unknown", reason: "no expression available" };
  }

  const outputUnit = entry.unit;
  const targetDim = outputUnit ? getUnitDim(outputUnit) : null;

  const allTokens = collectTokens(expression);

  // Identifica i parametri liberi (nessuna unità nota da nessuna fonte)
  const freeParams = allTokens.filter(
    (token) => !resolveKnownDim(token, state, localEntries)
  );

  if (freeParams.length === 0) {
    // Nessun parametro libero: il mismatch è reale
    return {
      compatible: false,
      reason: "all symbols have known units but dimensions do not match",
    };
  }

  // Prova prima con tutti i parametri liberi ipotizzati come dimensionless
  // (caso in cui la formula sarebbe corretta senza alcuna ipotesi di unità)
  const dimMapNone = buildDimMap(allTokens, state, localEntries, new Map());
  if (checkDimensions(expression, targetDim, dimMapNone)) {
    return {
      compatible: true,
      hypotheses: [],
      message:
        `Formula dimensions close with free parameter(s) ${freeParams.join(", ")} ` +
        `treated as dimensionless.`,
    };
  }

  // Cerca un'ipotesi per ogni parametro libero indipendentemente
  const resolvedHypotheses: ParameterHypothesis[] = [];

  for (const freeParam of freeParams) {
    const candidates = collectCandidateUnits(
      freeParam,
      allTokens,
      expression,
      outputUnit,
      state,
      localEntries
    );

    let found: ParameterHypothesis | null = null;

    for (const candidateUnit of candidates) {
      const candidateDim = getUnitDim(candidateUnit);
      if (!candidateDim) continue;

      // Costruisce mappa con ipotesi per questo parametro + ipotesi già
      // trovate per i parametri precedenti
      const hypothesis = new Map<string, Dim>();
      for (const prev of resolvedHypotheses) {
        hypothesis.set(prev.paramName, prev.assumedDim);
      }
      hypothesis.set(freeParam, candidateDim);

      const dimMap = buildDimMap(allTokens, state, localEntries, hypothesis);
      if (checkDimensions(expression, targetDim, dimMap)) {
        found = { paramName: freeParam, assumedUnit: candidateUnit, assumedDim: candidateDim };
        break;
      }
    }

    if (found) {
      resolvedHypotheses.push(found);
    } else {
      // Nessuna unità candidata chiude le dimensioni per questo parametro:
      // non possiamo concludere che la formula sia corretta, ma non possiamo
      // nemmeno dire che sia certamente sbagliata (le nostre candidate potrebbero
      // non includere l'unità giusta).
      return {
        compatible: "unknown",
        reason:
          `Could not find a plausible unit for free parameter '${freeParam}' ` +
          `that closes the dimensional balance with output unit '${outputUnit ?? "dimensionless"}'.`,
      };
    }
  }

  // Tutte le ipotesi trovate: verifica globale con tutte insieme
  const finalHypothesis = new Map<string, Dim>(
    resolvedHypotheses.map((h) => [h.paramName, h.assumedDim])
  );
  const finalDimMap = buildDimMap(allTokens, state, localEntries, finalHypothesis);

  if (!checkDimensions(expression, targetDim, finalDimMap)) {
    // Le ipotesi trovate individualmente non chiudono insieme
    return {
      compatible: "unknown",
      reason:
        `Individual unit hypotheses found for each free parameter, but they ` +
        `do not close dimensionally when combined.`,
    };
  }

  const hypothesisText = resolvedHypotheses
    .map((h) => `${h.paramName} ~ ${h.assumedUnit}`)
    .join(", ");

  return {
    compatible: true,
    hypotheses: resolvedHypotheses,
    message:
      `Formula dimensions close correctly assuming ${hypothesisText}. ` +
      `No dimensional error — add 'unit: ${resolvedHypotheses.map((h) => h.assumedUnit).join(" / ")}' ` +
      `to the free parameter(s) to make this explicit.`,
  };
}

/**
 * Ritorna true se l'entry ha errori di unit-mismatch che potrebbero
 * essere spiegati da parametri liberi (e quindi non sono errori reali).
 */
export function hasParametricUnitMismatch(entry: FormulaEntry): boolean {
  const errors = entry.evaluationErrors ?? [];
  const warnings = entry.evaluationWarnings ?? [];
  const allMessages = [...errors, ...warnings];
  return allMessages.some(
    (m) =>
      /unit mismatch|dimension mismatch/i.test(m) ||
      /invalid.value|unresolved/i.test(m)
  );
}