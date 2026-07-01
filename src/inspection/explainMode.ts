import * as path from "path";
import * as vscode from "vscode";
import * as yaml from "js-yaml";

import type {
  CalcDocsState,
  SymbolDefinitionLocation,
} from "../core/state";
import { buildFormulaEntry } from "../core/yamlParser";
import { createCsvLookupResolver } from "../engine/csvLookup";
import {
  buildFormulaSymbolTable,
  resolveFormulaValue,
  scaleValueToUnit,
} from "../formulaOutline/formulaEvaluator";
import {
  analyzeParametricFormula,
  hasParametricUnitMismatch,
} from "./parametricAnalysis";
import type { FormulaEntry } from "../types/FormulaEntry";
import { pickWord } from "../utils/editor";
import { formatNumberToSigFigs } from "../utils/nformat";

const FORMULA_YAML_NAME_RX = /(^|[\\/])formulas?.*\.ya?ml$/i;

function isFormulaYamlDocument(document: vscode.TextDocument): boolean {
  return (
    document.uri.scheme === "file" &&
    FORMULA_YAML_NAME_RX.test(path.basename(document.uri.fsPath))
  );
}

/**
 * Effettua il parsing locale di un singolo documento formula*.yaml, senza
 * dipendere da state.formulaIndex (che il core engine popola con un solo
 * file per workspace, vedi src/core/files.ts -> findFormulaYamlFile).
 *
 * Riusa due pezzi già esistenti del codebase, entrambi pensati per girare
 * in sicurezza su un singolo documento senza scansioni di workspace:
 *
 * 1. buildFormulaEntry (core/yamlParser.ts) per la struttura (chiave,
 *    espressione, unità, label, posizione riga) — lo stesso parser
 *    strutturale usato dal core engine.
 *
 * 2. buildFormulaSymbolTable / resolveFormulaValue
 *    (formulaOutline/formulaEvaluator.ts) per i VALORI calcolati — lo
 *    stesso motore di valutazione già usato per renderizzare i ghost
 *    value nell'editor YAML (formulaOutlineProvider.ts). Non è quindi
 *    "nuova" logica di calcolo: è il motore di preview già esistente,
 *    applicato qui per popolare valueCalc così l'inspector mostra valori
 *    coerenti con quelli già visibili come ghost text.
 *
 * I simboli C/C++ noti (state.symbolValues/symbolUnits) vengono comunque
 * usati come contesto, esattamente come fa il ghost rendering: questo non
 * introduce nuova risoluzione di simboli C/C++, riusa solo quelli già
 * presenti nello stato calcolato.
 */
function parseLocalFormulaYamlDocument(
  state: CalcDocsState,
  document: vscode.TextDocument
): Map<string, FormulaEntry> {
  const result = new Map<string, FormulaEntry>();
  const rawText = document.getText();

  let parsedRoot: unknown;
  try {
    parsedRoot = yaml.load(rawText);
  } catch {
    return result;
  }

  if (!parsedRoot || typeof parsedRoot !== "object" || Array.isArray(parsedRoot)) {
    return result;
  }

  // Fase 1: parsing strutturale di tutte le formule del documento,
  // necessario prima di poterle valutare (buildFormulaSymbolTable ha
  // bisogno della lista completa per risolvere dipendenze incrociate).
  const structuralEntries: FormulaEntry[] = [];
  for (const [key, node] of Object.entries(parsedRoot as Record<string, unknown>)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      continue;
    }

    const globallyIndexed = state.formulaIndex.get(key);
    if (
      globallyIndexed &&
      documentMatchesPath(document, toAbsoluteFormulaPath(state, globallyIndexed))
    ) {
      // Questo è il file effettivamente indicizzato dal core engine:
      // l'entry "ricca" già calcolata (valueCalc, explainSteps,
      // diagnostica) è già corretta e completa, nessun bisogno di
      // rivalutare localmente.
      structuralEntries.push(globallyIndexed);
      continue;
    }

    structuralEntries.push(
      buildFormulaEntry(
        key,
        node as Record<string, unknown>,
        rawText,
        document.uri.fsPath,
        state.workspaceRoot
      )
    );
  }

  // Fase 2: valutazione, riusando lo stesso motore dei ghost value.
  // OutlineFormula e FormulaEntry condividono la stessa forma per i campi
  // usati qui (id/key, expr/formula, unit, example, parameters, values),
  // quindi adattiamo al volo senza duplicare logica di valutazione.
  const outlineFormulas = structuralEntries.map((entry) => ({
    id: entry.key,
    expr: entry.formula ?? "",
    unit: entry.unit,
    value: entry.valueYaml,
    values: entry.valueYamlList,
    parameters: entry.parameters,
    example: undefined as Record<string, number> | undefined,
    lineStart: entry._line ?? 0,
    lineEnd: entry._line ?? 0,
    _filePath: entry._filePath,
    line: entry._line,
    rawNode: {} as Record<string, unknown>,
  }));

  const lookupResolver = createCsvLookupResolver(state.csvTables, document.uri.fsPath);
  const symbolTable = buildFormulaSymbolTable(
    outlineFormulas,
    state.symbolValues,
    lookupResolver
  );

  for (const entry of structuralEntries) {
    if (entry.valueCalc !== undefined && entry.valueCalc !== null) {
      // Già un'entry "ricca" dal core engine: non toccarla.
      result.set(entry.key, entry);
      continue;
    }

    const outlineFormula = outlineFormulas.find((o) => o.id === entry.key)!;
    const { resolved } = resolveFormulaValue(
      outlineFormula,
      symbolTable,
      state.symbolValues,
      lookupResolver,
      outlineFormulas
    );

    if (resolved === null) {
      result.set(entry.key, entry);
      continue;
    }

    const displayValue = scaleValueToUnit(resolved, entry.unit);
    result.set(entry.key, {
      ...entry,
      valueCalc: Number.isFinite(displayValue) ? displayValue : resolved,
    });
  }

  return result;
}

export type InspectionSymbolSource = "formula" | "c-symbol";

export type InspectionSymbol = {
  name: string;
  source: InspectionSymbolSource;
  value?: number;
  displayValue: string;
  unit?: string;
  origin?: string;
  resolvedText?: string;
};

export type FormulaInspection = {
  id: string;
  expression: string;
  exprType?: string;
  value: number | null;
  displayValue: string;
  unit?: string;
  sourceFile?: string;
  sourceLine?: number;
  expanded?: string;
  resolvedSymbols: InspectionSymbol[];
  explainSteps: string[];
  errors: string[];
  warnings: string[];
  // Presente quando la formula ha parametri liberi e l'analisi dimensionale
  // ipotetica riesce a chiudere il bilancio: contiene la spiegazione
  // dell'ipotesi usata (messaggio info, non errore).
  parametricNotes: string[];
};

export type ExplainModePayload = {
  formula: FormulaInspection;
  finalValue: string;
  knownSymbols: InspectionSymbol[];
  steps: string[];
  notes: string[];
};

const IDENTIFIER_RX = /[A-Za-z_][A-Za-z0-9_.]*/g;
const RESERVED_WORDS = new Set([
  "abs", "acos", "asin", "atan", "atan2", "ceil", "cos", "csv",
  "e", "exp", "floor", "log", "log10", "lookup", "max", "min",
  "pi", "pow", "round", "sin", "sqrt", "table", "tan",
]);

function normalizeForCompare(value: string): string {
  return path.normalize(value).replace(/\\/g, "/").toLowerCase();
}

function toAbsoluteFormulaPath(state: CalcDocsState, entry: FormulaEntry): string | undefined {
  if (!entry._filePath) {
    return undefined;
  }
  return path.isAbsolute(entry._filePath)
    ? entry._filePath
    : path.resolve(state.workspaceRoot, entry._filePath);
}

export function documentMatchesPath(
  document: vscode.TextDocument,
  candidatePath: string | undefined
): boolean {
  if (!candidatePath || document.uri.scheme !== "file") {
    return false;
  }
  return normalizeForCompare(document.uri.fsPath) === normalizeForCompare(candidatePath);
}

export function formulaEntryMatchesDocument(
  state: CalcDocsState,
  entry: FormulaEntry,
  document: vscode.TextDocument
): boolean {
  if (document.uri.scheme !== "file") {
    return false;
  }
  const entryPath = toAbsoluteFormulaPath(state, entry);
  if (documentMatchesPath(document, entryPath)) {
    return true;
  }
  return !entry._filePath && documentMatchesPath(document, state.lastYamlPath);
}

export type DocumentFormulaContext = {
  entries: FormulaEntry[];
  // Presente solo quando le entry derivano da parseLocalFormulaYamlDocument
  // (documento diverso dal file YAML indicizzato globalmente). Serve ai
  // chiamanti che devono risolvere dipendenze incrociate tra formule dello
  // stesso file locale (vedi collectResolvedSymbols / getInspectionSymbol).
  localEntries?: Map<string, FormulaEntry>;
};

/**
 * Calcola UNA SOLA VOLTA le entry pertinenti al documento dell'editor
 * fornito, evitando di ripetere il parsing YAML locale più volte per la
 * stessa richiesta (come accadeva prima con getFormulaEntriesForDocument
 * e getActiveFormulaEntry chiamati separatamente sullo stesso editor).
 *
 * Esposta pubblicamente per i chiamanti (es. export report) che devono
 * iterare su tutte le entry di un documento E avere accesso alla mappa
 * locale per risolvere dipendenze incrociate tra formule dello stesso
 * file non indicizzato globalmente.
 */
export function getDocumentFormulaContext(
  state: CalcDocsState,
  editor: vscode.TextEditor | undefined
): DocumentFormulaContext {
  if (!editor) {
    return { entries: [] };
  }

  // Caso comune: il documento è il file YAML già indicizzato globalmente
  // (o un file C/C++ con simboli/formule referenziate lì). Usa l'indice
  // globale com'è sempre stato.
  const globalEntries = Array.from(state.formulaIndex.values()).filter((entry) =>
    formulaEntryMatchesDocument(state, entry, editor.document)
  );
  if (globalEntries.length > 0) {
    return { entries: globalEntries };
  }

  // Caso multi-file: il documento è un formula*.yaml valido ma diverso da
  // quello che il core engine ha indicizzato (state.lastYamlPath), perché
  // findFormulaYamlFile analizza un solo file per workspace. Qui facciamo
  // parsing locale del documento attivo, sul solo testo già in editor,
  // senza alcuna scansione di workspace aggiuntiva.
  if (isFormulaYamlDocument(editor.document)) {
    const localEntries = parseLocalFormulaYamlDocument(state, editor.document);
    return { entries: Array.from(localEntries.values()), localEntries };
  }

  return { entries: [] };
}

export function getFormulaEntriesForDocument(
  state: CalcDocsState,
  editor: vscode.TextEditor | undefined
): FormulaEntry[] {
  return getDocumentFormulaContext(state, editor).entries;
}

function getEntryForEditorLine(
  entries: FormulaEntry[],
  line: number
): FormulaEntry | undefined {
  const sorted = entries
    .filter((entry) => typeof entry._line === "number")
    .sort((left, right) => (left._line ?? 0) - (right._line ?? 0));

  let selected: FormulaEntry | undefined;
  for (const entry of sorted) {
    if ((entry._line ?? 0) > line) {
      break;
    }
    selected = entry;
  }
  return selected;
}

/**
 * Come getActiveFormulaEntry, ma restituisce anche la mappa delle entry
 * locali (se il documento è un formula*.yaml non indicizzato globalmente),
 * così i chiamanti possono passarla a buildFormulaInspection per risolvere
 * correttamente le dipendenze tra formule dello stesso file.
 *
 * Priorità:
 * 1. Parola sotto il cursore nell'editor fornito → lookup diretto
 *    (indice globale prima, poi parsing locale del documento)
 * 2. Formula per posizione/riga corrente nel documento
 * 3. Se l'editor è valido ma NON è pertinente → undefined, NON un
 *    fallback arbitrario
 * 4. Solo se non c'è alcun editor valido: prima formula dell'intero
 *    indice globale, utile per webview aperte senza contesto pregresso
 */
export function getActiveFormulaContext(
  state: CalcDocsState,
  editor?: vscode.TextEditor
): { entry: FormulaEntry | undefined; localEntries?: Map<string, FormulaEntry> } {
  const effectiveEditor = editor ?? vscode.window.activeTextEditor;

  if (effectiveEditor && effectiveEditor.document.uri.scheme === "file") {
    const document = effectiveEditor.document;
    const position = effectiveEditor.selection.active;
    const word = pickWord(document, position);
    const context = getDocumentFormulaContext(state, effectiveEditor);

    // 1. Parola sotto il cursore. Priorità: prima un match che appartiene
    // davvero a QUESTO documento (locale o globale), poi un match globale
    // generico (es. simbolo C/C++ definito altrove). Questo evita che, con
    // due file formula*.yaml che riusano lo stesso nome di chiave, venga
    // mostrata per errore la formula dell'altro file.
    if (word) {
      const byWord = state.formulaIndex.get(word);
      if (byWord && formulaEntryMatchesDocument(state, byWord, document)) {
        return { entry: byWord, localEntries: context.localEntries };
      }

      const localMatch = context.localEntries?.get(word);
      if (localMatch) {
        return { entry: localMatch, localEntries: context.localEntries };
      }

      // Nessun match specifico per questo documento: un match globale
      // generico è comunque meglio di niente.
      if (byWord) {
        return { entry: byWord, localEntries: context.localEntries };
      }
    }

    // 2. Formula per posizione/riga corrente nel documento.
    if (context.entries.length > 0) {
      const entry =
        getEntryForEditorLine(context.entries, position.line) ?? context.entries[0];
      return { entry, localEntries: context.localEntries };
    }

    // 3. Editor valido ma non pertinente: non indovinare una formula a caso.
    return { entry: undefined };
  }

  // 4. Nessun editor valido disponibile: mostra comunque la prima formula
  // nota nell'indice globale, meglio di uno schermo vuoto.
  const allEntries = Array.from(state.formulaIndex.values());
  return { entry: allEntries.length > 0 ? allEntries[0] : undefined };
}

/**
 * Variante semplificata di getActiveFormulaContext per i chiamanti che
 * hanno bisogno solo dell'entry (es. comando "Explain Formula").
 *
 * @param state      Stato CalcDocs corrente
 * @param editor     Editor da usare. Se undefined, usa activeTextEditor come fallback
 *                   (ma il chiamante dovrebbe passare lastValidEditor per evitare
 *                   che il pannello webview oscuri il contesto).
 */
export function getActiveFormulaEntry(
  state: CalcDocsState,
  editor?: vscode.TextEditor
): FormulaEntry | undefined {
  return getActiveFormulaContext(state, editor).entry;
}

export function formatValue(value: number | null | undefined, unit?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unresolved";
  }
  const formatted = formatNumberToSigFigs(value, 8);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatLocation(location: SymbolDefinitionLocation | undefined): string | undefined {
  if (!location) {
    return undefined;
  }
  return `${location.file}:${location.line + 1}`;
}

function getFormulaOrigin(entry: FormulaEntry): string | undefined {
  if (!entry._filePath) {
    return undefined;
  }
  return `${entry._filePath}:${(entry._line ?? 0) + 1}`;
}

function getSymbolOrigin(state: CalcDocsState, name: string): string | undefined {
  const conditional = state.symbolConditionalDefs.get(name);
  if (conditional && conditional.length > 0) {
    return conditional
      .slice(0, 3)
      .map((location) => `${location.file}:${location.line + 1}`)
      .join(", ");
  }
  return formatLocation(state.symbolDefs.get(name));
}

export function getInspectionSymbol(
  state: CalcDocsState,
  name: string,
  resolvedText?: string,
  localEntries?: ReadonlyMap<string, FormulaEntry>
): InspectionSymbol | undefined {
  const formula = state.formulaIndex.get(name) ?? localEntries?.get(name);
  if (formula) {
    return {
      name,
      source: "formula",
      value: typeof formula.valueCalc === "number" ? formula.valueCalc : undefined,
      displayValue: formatValue(formula.valueCalc, formula.unit),
      unit: formula.unit,
      origin: getFormulaOrigin(formula),
      resolvedText,
    };
  }

  const hasValue = state.symbolValues.has(name);
  const hasUnit = state.symbolUnits.has(name);
  const origin = getSymbolOrigin(state, name);
  if (!hasValue && !hasUnit && !origin) {
    return undefined;
  }

  const value = state.symbolValues.get(name);
  const unit = state.symbolUnits.get(name);

  return {
    name,
    source: "c-symbol",
    value,
    displayValue: formatValue(value, unit),
    unit,
    origin,
    resolvedText,
  };
}

function collectIdentifiers(expression: string): string[] {
  const result = new Set<string>();
  for (const match of expression.matchAll(IDENTIFIER_RX)) {
    const token = match[0];
    if (!RESERVED_WORDS.has(token.toLowerCase())) {
      result.add(token);
    }
  }
  return Array.from(result);
}

function parseResolvedDependencyName(line: string): string | undefined {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.]*)\b/);
  return match?.[1];
}

function collectResolvedSymbols(
  state: CalcDocsState,
  entry: FormulaEntry,
  localEntries?: ReadonlyMap<string, FormulaEntry>
): InspectionSymbol[] {
  const byName = new Map<string, InspectionSymbol>();

  for (const resolvedText of entry.resolvedDependencies ?? []) {
    const name = parseResolvedDependencyName(resolvedText);
    if (!name || name === entry.key) {
      continue;
    }
    const symbol = getInspectionSymbol(state, name, resolvedText, localEntries);
    if (symbol) {
      byName.set(name, symbol);
    }
  }

  const expression = entry.formula ?? entry.expanded ?? "";
  for (const token of collectIdentifiers(expression)) {
    if (token === entry.key || byName.has(token)) {
      continue;
    }
    const symbol = getInspectionSymbol(state, token, undefined, localEntries);
    if (symbol) {
      byName.set(token, symbol);
    }
  }

  return Array.from(byName.values()).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

/**
 * @param localEntries  Entry derivate da parseLocalFormulaYamlDocument per
 *                       il documento attivo, quando questo non è il file
 *                       indicizzato globalmente dal core engine. Permette
 *                       di risolvere dipendenze tra formule dello stesso
 *                       file locale (altrimenti invisibili a
 *                       state.formulaIndex).
 */
export function buildFormulaInspection(
  state: CalcDocsState,
  entry: FormulaEntry,
  localEntries?: ReadonlyMap<string, FormulaEntry>
): FormulaInspection {
  const value =
    typeof entry.valueCalc === "number" && Number.isFinite(entry.valueCalc)
      ? entry.valueCalc
      : null;

  const rawErrors = [...(entry.evaluationErrors ?? [])];
  const rawWarnings = [...(entry.evaluationWarnings ?? [])];
  const parametricNotes: string[] = [];

  // Se la formula ha errori di unit-mismatch o invalid-value E ha
  // dipendenze potenzialmente libere, tenta l'analisi dimensionale
  // ipotetica. Se riesce, i falsi errori vengono spostati in
  // parametricNotes (info) invece di restare come errori bloccanti.
  if (hasParametricUnitMismatch(entry)) {
    const analysis = analyzeParametricFormula(entry, state, localEntries);

    if (analysis.compatible === true) {
      // Le dimensioni chiudono con ipotesi plausibili: non è un errore reale.
      // Rimuove da errors/warnings i messaggi di mismatch e invalid-value,
      // li sostituisce con un info esplicativo.
      const isMismatchMsg = (m: string) =>
        /unit mismatch|dimension mismatch|invalid.value|unresolved/i.test(m);

      const filteredErrors = rawErrors.filter((m) => !isMismatchMsg(m));
      const filteredWarnings = rawWarnings.filter((m) => !isMismatchMsg(m));

      parametricNotes.push(analysis.message);

      return {
        id: entry.key,
        expression: entry.formula ?? "",
        exprType: entry.exprType,
        value,
        displayValue: value !== null ? formatValue(value, entry.unit) : "parametric",
        unit: entry.unit,
        sourceFile: entry._filePath,
        sourceLine: typeof entry._line === "number" ? entry._line + 1 : undefined,
        expanded: entry.expanded,
        resolvedSymbols: collectResolvedSymbols(state, entry, localEntries),
        explainSteps: [...(entry.explainSteps ?? [])],
        errors: filteredErrors,
        warnings: filteredWarnings,
        parametricNotes,
      };
    }

    if (analysis.compatible === "unknown") {
      // Non riesce a trovare ipotesi che chiudano: mantieni gli errori
      // originali ma aggiungi una nota che spiega il tentativo.
      parametricNotes.push(
        `Parametric analysis attempted but inconclusive: ${analysis.reason}`
      );
    }
    // Se compatible === false: tutte le unità sono note ma non chiudono,
    // errore reale → lascia rawErrors/rawWarnings invariati, nessuna nota.
  }

  return {
    id: entry.key,
    expression: entry.formula ?? "",
    exprType: entry.exprType,
    value,
    displayValue: formatValue(value, entry.unit),
    unit: entry.unit,
    sourceFile: entry._filePath,
    sourceLine: typeof entry._line === "number" ? entry._line + 1 : undefined,
    expanded: entry.expanded,
    resolvedSymbols: collectResolvedSymbols(state, entry, localEntries),
    explainSteps: [...(entry.explainSteps ?? [])],
    errors: rawErrors,
    warnings: rawWarnings,
    parametricNotes,
  };
}

export function buildExplainModePayload(
  state: CalcDocsState,
  entry: FormulaEntry,
  localEntries?: ReadonlyMap<string, FormulaEntry>
): ExplainModePayload {
  const formula = buildFormulaInspection(state, entry, localEntries);
  const steps =
    formula.explainSteps.length > 0
      ? formula.explainSteps
      : formula.expanded
        ? [`Expanded: ${formula.expanded}`, `Final: ${formula.displayValue}`]
        : [`Final: ${formula.displayValue}`];

  const notes: string[] = [];
  if (formula.errors.length > 0) {
    notes.push("Existing evaluation errors are shown below; no missing symbols were resolved.");
  }
  if (formula.resolvedSymbols.length === 0) {
    notes.push("No resolved symbol details are present in the current computed state.");
  }

  return {
    formula,
    finalValue: formula.displayValue,
    knownSymbols: formula.resolvedSymbols,
    steps,
    notes,
  };
}

export function explainModeToMarkdown(payload: ExplainModePayload): string {
  const lines: string[] = [
    `# CalcDocs Explain: ${payload.formula.id}`,
    "",
    `Final value: \`${payload.finalValue}\``,
  ];

  if (payload.formula.unit) {
    lines.push(`Unit: \`${payload.formula.unit}\``);
  }

  if (payload.formula.expression) {
    lines.push("", "## Expression", "```text", payload.formula.expression, "```");
  }

  if (payload.steps.length > 0) {
    lines.push("", "## Existing Evaluation Steps", "```text");
    lines.push(...payload.steps);
    lines.push("```");
  }

  if (payload.knownSymbols.length > 0) {
    lines.push("", "## Known Symbols");
    for (const symbol of payload.knownSymbols) {
      const origin = symbol.origin ? ` - ${symbol.origin}` : "";
      lines.push(`- \`${symbol.name}\`: \`${symbol.displayValue}\`${origin}`);
    }
  }

  if (payload.formula.errors.length > 0) {
    lines.push("", "## Errors");
    lines.push(...payload.formula.errors.map((message) => `- ${message}`));
  }

  if (payload.formula.warnings.length > 0) {
    lines.push("", "## Warnings");
    lines.push(...payload.formula.warnings.map((message) => `- ${message}`));
  }

  if (payload.notes.length > 0) {
    lines.push("", "## Notes");
    lines.push(...payload.notes.map((message) => `- ${message}`));
  }

  return `${lines.join("\n")}\n`;
}