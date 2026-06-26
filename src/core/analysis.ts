import * as fsp from "fs/promises";

import { collectDefinesAndConsts, parseCppSymbolDefinition } from "./cppParser";
import { extractConfigVarsFromFile } from "./configParser";
import * as path from "path";
import { listFilesRecursive, findFormulaYamlFile } from "./files";
import {
  createSymbolResolutionStats,
  buildCompositeExpressionPreview,
  safeEval,
  isCompositeExpression,
  replaceTokens,
  expandExpression,
  resolveSymbol,
  resolveInlineLookups,
  type EvaluationContext,
  type SymbolResolutionStats,
  snapshotSymbolResolutionStats,
} from "./expression";
import { loadAdjacentCsvTables, loadWorkspaceCsvTables } from "./csvTables";
import { loadYaml, buildFormulaEntry, type LoadedYaml } from "./yamlParser";
import { getConfig, isIgnoredFsPath, refreshIgnoredDirs } from "./config";
import * as vscode from "vscode";
import { Uri } from "vscode";
import { CalcDocsState, type YamlParseErrorInfo, clearDiagnostics } from "./state";
import {
  evaluateYamlDocument,
  type EvaluatedYamlSymbol,
} from "../engine/yamlEngine";
import { extractUnitsFromCppFiles } from "../engine/cUnitExtractor";


import { type FormulaEntry, type FormulaLabel } from "../types/FormulaEntry";
import { clampLen } from "../utils/text";
import { TOKEN_RX } from "../utils/regex";
import { localize } from "../utils/localize";
import { updateBraceDepth } from "../utils/braceDepth";
import {
  parseExpressionUnit,
  buildVariableDimensions,
  evaluateExpressionDimensions,
  formatDimensionVector,
  dimensionsEqual,
  normalizeUnitToken,
  UNIT_SPECS,
} from "./inlineCalc";

import * as os from "os";
import * as crypto from "crypto";

/**
 * Risultato dell'analisi del workspace.
 * Indica se il file formulas YAML è cambiato dall'ultima analisi.
 */
export type AnalysisResult = {
  /** True se il file formulas.yaml è stato aggiunto o rimosso */
  hasFormulasFileChanged: boolean;
};

/**
 * Risultato della scansione del workspace.
 * Contiene la lista dei file e il percorso del file YAML trovato.
 */
type WorkspaceScan = {
  /** Lista di tutti i file sorgente nel workspace */
  files: string[];
  /** Percorso del file formulas YAML trovato, undefined se assente */
  yamlPath?: string;
  /** True se lo stato di presenza del file YAML è cambiato */
  hasFormulasFileChanged: boolean;
};

/** Tipo per le entry YAML: coppie chiave-oggetto al primo livello */
type YamlNodeEntries = Array<[string, Record<string, unknown>]>;

/** Tipo di ritorno del parser C/C++ per i simboli */
type CollectedCppSymbols = Awaited<ReturnType<typeof collectDefinesAndConsts>>;

/** Regex per rilevare chiamate a funzioni di lookup CSV/table */
const TABLE_LOOKUP_RX = /\b(?:csv|table|lookup)\s*\(/i;
/** Regex per rilevare chiamate a funzioni in espressioni */
const FUNC_CALL_RX = /\b[A-Za-z_][A-Za-z0-9_]*\s*\(/;
/** Regex per contare operatori matematici nelle espressioni */
const OPERATOR_COUNT_RX = /[+\-*/%&|^~<>?:]/g;
/** Regex per rilevare direttive #define in una riga */
const DEFINE_DIRECTIVE_RX = /^\s*#\s*define\b/;
// Usato per distinguere errori generici da stack overflow per ricorsione
const STACK_OVERFLOW_RX = /maximum call stack size exceeded/i;
/** Regex per estrarre linea e colonna dai messaggi di errore YAML di js-yaml */
const YAML_LINE_COLUMN_RX = /line\s+(\d+)\s*,\s*column\s+(\d+)/i;
/** Soglia di mismatch tra define C/C++ e valore formula (1%) */
const DEFINE_VALUE_MISMATCH_THRESHOLD = 0.01;

/** Estensioni solo per file sorgente C/C++ (no headers) */
const SOURCES_ONLY_EXTS = new Set([".c", ".cpp", ".cc"]);



/**
 * Estrae la posizione (linea e colonna) da un messaggio di errore YAML.
 * 
 * @param message - Messaggio di errore del parser js-yaml
 * @returns Oggetto contenente linea e colonna opzionali
 */
function parseYamlErrorPosition(message: string): {
  line?: number;
  column?: number;
} {
  const match = message.match(YAML_LINE_COLUMN_RX);
  if (!match) {
    return {};
  }

  const line = Number(match[1]);
  const column = Number(match[2]);

  return {
    line: Number.isFinite(line) ? line : undefined,
    column: Number.isFinite(column) ? column : undefined,
  };
}

/**
 * Aggiorna lo stato con le statistiche di utilizzo dello stack.
 * 
 * @param state - Stato corrente dell'estensione
 * @param stackStats - Statistiche di risoluzione simboli
 * @param forceDegraded - Se true, forza lo stato degraded indipendentemente dalle statistiche
 */
function updateStateStackUsage(
  state: CalcDocsState,
  stackStats: SymbolResolutionStats,
  forceDegraded = false
): void {
  const snapshot = snapshotSymbolResolutionStats(stackStats);
  state.lastAnalysisStackUsage = forceDegraded
    ? {
        ...snapshot,
        degraded: true,
      }
    : snapshot;
}

/**
 * Registra nel log le statistiche di utilizzo dello stack se in modalità degradata.
 * Stampa eventuali dipendenze circolari rilevate.
 * 
 * @param state - Stato corrente dell'estensione
 * @param stackStats - Statistiche di risoluzione simboli
 */
function logStackUsageIfNeeded(
  state: CalcDocsState,
  stackStats?: SymbolResolutionStats
): void {
  const usage = state.lastAnalysisStackUsage;

  // Non loggare se tutto OK
  if (!usage.degraded) {
    return;
  }

  state.output.warn(
    localize("output.stackSafeMode", usage.usedDepth, usage.depthLimit, usage.cycleCount, usage.prunedCount)
  );

  // Logga le dipendenze circolari rilevate
  if (usage.cycleCount > 0 && stackStats && stackStats.cycleSamples.length > 0) {
    state.output.warn(localize("output.circularReferences"));
    for (const cycleSample of stackStats.cycleSamples) {
      state.output.detail(`[CalcDocs]   - ${cycleSample}`);
    }
  }
}

/**
 * Crea un mega-file temporaneo per un file sorgente C/C++, risolvendo ricorsivamente tutti gli #include
 * (solo sorgenti, headers ignorati). Ogni mega-file è indipendente.
 * 
 * @param sourcePath - File sorgente principale (.c/.cpp/.cc)
 * @param workspaceRoot - Root del workspace per path relativi
 * @param output - Output channel per logging
 * @returns Percorso del file temporaneo mega
 */
// async function createMegaSourceFile(
//   sourcePath: string,
//   workspaceRoot: string,
//   output: any
// ): Promise<string> {
//   const visited = new Set<string>();
//   const tempDirName = `calcdocs-mega-${crypto.randomUUID().slice(0,8)}`;
//   const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), tempDirName + '-'));
  
//   async function resolveInclude(relIncludePath: string, baseDir: string): Promise<string> {
//     const absIncludePath = path.resolve(baseDir, relIncludePath);
//     const key = absIncludePath.toLowerCase();
    
//     if (visited.has(key)) {
//       return '';
//     }
//     visited.add(key);
    
//     const ext = path.extname(absIncludePath).toLowerCase();
//     // if (!SOURCES_ONLY_EXTS.has(ext)) {
//     //   output.detail(`[Mega] Skip header: ${relIncludePath}`);
//     //   return '';
//     // }
    
//     let content: string;
//     try {
//       content = await fsp.readFile(absIncludePath, 'utf8');
//     } catch (err) {
//       output.warn(`[Mega] Failed read ${relIncludePath}: ${err}`);
//       return '';
//     }
    
//     const lines = content.split(/\r?\n/);
//     let processedContent = `/* === INCL ${path.relative(workspaceRoot, absIncludePath)} === */\n`;
    
//     for (const line of lines) {
//       const includeMatch = line.match(INCLUDE_RX);
//       if (includeMatch) {
//         const nested = await resolveInclude(includeMatch[1], path.dirname(absIncludePath));
//         processedContent += nested || line + '\\n';
//       } else {
//         processedContent += line + '\\n';
//       }
//     }
    
//     output.detail(`trovati: ${processedContent}`);
//     return processedContent;
//   }
  
//   // Main source processing
//   const mainDir = path.dirname(sourcePath);
//   let megaContent = `/* === MEGA from ${path.relative(workspaceRoot, sourcePath)} === */\n`;
//   const mainContent = await fsp.readFile(sourcePath, 'utf8');
//   const mainLines = mainContent.split(/\r?\n/);
  
//   for (const line of mainLines) {
//     const includeMatch = line.match(INCLUDE_RX);
//     if (includeMatch) {
//       const included = await resolveInclude(includeMatch[1], mainDir);
//       output.warn(`incluso ${includeMatch[1]} in ${mainDir}`);
//       megaContent += included || line + '\\n';
//     } else {
//       megaContent += line + '\\n';
//     }
//   }
  
//   const tempFileName = `mega-${path.basename(sourcePath)}`;
//   const tempPath = path.join(tempDir, tempFileName);
//   await fsp.writeFile(tempPath, megaContent, 'utf8');
  
//   const sizeKB = (Buffer.byteLength(megaContent) / 1024).toFixed(1);
//   output.detail(`[Mega] Created ${tempPath} (${sizeKB}kB)`);
  
//   return tempPath;
// }

/**
 * Orchestrazione principale dell'analisi del workspace.
 * Scansiona i file, decide la modalità (YAML vs solo C/C++) e popola le mappe di stato condivise.
 * 
 * @param state - Stato corrente dell'estensione
 * @returns Risultato dell'analisi con indicazione di cambiamento del file YAML
 */
export async function runAnalysis(state: CalcDocsState): Promise<AnalysisResult> {
  clearFormulaDiagnostics(state);
  state.configVars.clear();

  // Oggetto di diagnostica per-run, condiviso da tutte le chiamate di risoluzione simboli/macro
  const stackStats = createSymbolResolutionStats();
  state.lastYamlParseError = null;

  try {
    // Scansiona il workspace per ottenere lista file e trovare YAML
    const workspaceScan = await scanWorkspace(state);

    // Parse config files for @config.*
    const configFiles = workspaceScan.files.filter(f => /[\\/]config\.[ch]$/i.test(f));
    for (const configFile of configFiles) {
      const configVars = await extractConfigVarsFromFile(configFile, state.workspaceRoot, state);
      if (configVars) {
        const relPath = path.relative(state.workspaceRoot, configFile);
        state.configVars.set(relPath, configVars);
      }
    }
    state.output.info(`[Config] Parsed ${state.configVars.size} config files`);

    // Se non c'è un file YAML, esegui solo l'analisi C/C++
    if (!workspaceScan.yamlPath) {
      state.yamlDiagnostics = [];
      state.missingYamlSuggestions = [];
      await runCppOnlyAnalysis(state, workspaceScan.files, stackStats);
      updateStateStackUsage(state, stackStats);
      logStackUsageIfNeeded(state, stackStats);
      return {
        hasFormulasFileChanged: workspaceScan.hasFormulasFileChanged,
      };
    }

    // Carica il file YAML e gestisci eventuali errori di parsing
    const loadedYaml = await loadYamlOrReportError(state, workspaceScan.yamlPath);
    if (!loadedYaml) {
      state.yamlDiagnostics = [];
      state.missingYamlSuggestions = [];
      updateStateStackUsage(state, stackStats);
      return {
        hasFormulasFileChanged: workspaceScan.hasFormulasFileChanged,
      };
    }

    // Esegui l'analisi completa con YAML
    await runYamlAnalysis(
      state,
      workspaceScan.files,
      workspaceScan.yamlPath,
      loadedYaml,
      stackStats
    );
    
    // Report formula discrepancies after analysis
    await reportFormulaDiscrepancies(state, workspaceScan.files);
    
    updateStateStackUsage(state, stackStats);
    logStackUsageIfNeeded(state, stackStats);

    return {
      hasFormulasFileChanged: workspaceScan.hasFormulasFileChanged,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const isStackOverflow = STACK_OVERFLOW_RX.test(message);
    state.output.warn(
      isStackOverflow
        ? localize("output.stackOverflow", message)
        : localize("output.analysisError", message)
    );
    updateStateStackUsage(state, stackStats, isStackOverflow);
    logStackUsageIfNeeded(state, stackStats);

    return {
      hasFormulasFileChanged: false,
    };
  }
}

/**
 * Analizza solo il file C/C++ attivo (più include risolti) senza rieseguire la scansione YAML globale.
 * Mantiene formulaIndex già presente e aggiorna le mappe simboliche usate da hover/definition/codelens.
 * 
 * @param state - Stato corrente dell'estensione
 * @param sourcePath - Percorso assoluto del file C/C++ attivo
 */
export async function runActiveCppFileAnalysis(
  state: CalcDocsState,
  sourcePath: string
): Promise<void> {
  const normalizedSourcePath = path.resolve(sourcePath);
  if (!SOURCES_ONLY_EXTS.has(path.extname(normalizedSourcePath).toLowerCase())) {
    return;
  }

  const stackStats = createSymbolResolutionStats();

  try {
    const config = getConfig();
    const cppSymbols = await collectDefinesAndConsts(
      [normalizedSourcePath],
      state.workspaceRoot,
      {
        resolveIncludes: true,
        output: state.output,
        maxMegaCacheEntries: config.cppCacheMaxEntries,
      } as any // TS workaround for optional cache bypass
    );

    applyCppSymbols(state, cppSymbols, {
      resetSymbolValues: true,
      applyConstsBeforeResolve: false,
      requireFiniteResolvedValues: true,
      symbolResolutionStats: stackStats,
    });

    updateStateStackUsage(state, stackStats);
    logStackUsageIfNeeded(state, stackStats);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const isStackOverflow = STACK_OVERFLOW_RX.test(message);
    state.output.warn(
      isStackOverflow
        ? localize("output.stackOverflow", message)
        : localize("output.analysisError", message)
    );
    updateStateStackUsage(state, stackStats, isStackOverflow);
    logStackUsageIfNeeded(state, stackStats);
  }
}


/**
 * Enumera i file del workspace e aggiorna lo stato di presenza del file formulas YAML.
 * Esempio: toggla la visibilità della status bar quando formulas.yaml appare/scompare.
 * 
 * @param state - Stato corrente dell'estensione
 * @returns Risultato della scansione con file e percorso YAML
 */
async function scanWorkspace(state: CalcDocsState): Promise<WorkspaceScan> {
  const config = getConfig();
  refreshIgnoredDirs(state, config);

  // Lista ricorsiva dei file, saltando le directory ignorate
  const files = await listFilesRecursive(
    state.workspaceRoot,
    (absoluteDirPath) => isIgnoredFsPath(state, absoluteDirPath),
    state
  );

  // Trova il file formulas YAML
  const yamlPath = findFormulaYamlFile(files);
  const previousHasFormulasFile = state.hasFormulasFile;
  state.hasFormulasFile = Boolean(yamlPath);

  return {
    files,
    yamlPath,
    hasFormulasFileChanged: previousHasFormulasFile !== state.hasFormulasFile,
  };
}

/**
 * Modalità fallback usata quando non viene trovato nessun formulas*.yaml.
 * Mantiene i valori e le posizioni dei simboli C/C++ disponibili per hover/definition.
 * 
 * @param state - Stato corrente dell'estensione
 * @param files - Lista dei file da analizzare
 * @param stackStats - Statistiche per la risoluzione simboli
 */
async function runCppOnlyAnalysis(
  state: CalcDocsState,
  files: string[],
  stackStats: SymbolResolutionStats
): Promise<void> {
  if (files.length === 0) {
    return;
  }

  // Filter only C/C++ source files (no headers)
  const sourceFiles = files.filter((f) =>
    SOURCES_ONLY_EXTS.has(path.extname(f).toLowerCase())
  ).sort((left, right) => left.localeCompare(right));

  if (sourceFiles.length === 0) {
    state.output.info('No C/C++ source files found for analysis.');
    return;
  }

  // Collect symbols from source files with include resolution
  const config = getConfig();
  const cppSymbols = await collectDefinesAndConsts(sourceFiles, state.workspaceRoot, {
    resolveIncludes: true,
    maxMegaCacheEntries: config.cppCacheMaxEntries,
  });
  // const cppSymbols = await collectDefinesAndConsts(files, state.workspaceRoot);
  applyCppSymbols(state, cppSymbols, {
    resetSymbolValues: true,
    applyConstsBeforeResolve: false,
    requireFiniteResolvedValues: true,
    symbolResolutionStats: stackStats,
  });

  state.output.info(
    localize("output.cppAnalysisComplete", state.symbolValues.size)
  );
}

/**
 * Reports YAML parse error as VSCode diagnostic in Problems panel.
 */
function reportYamlParseDiagnostic(
  state: CalcDocsState,
  parseError: YamlParseErrorInfo
): void {
  if (!state.diagnostics) return;

  const uri = vscode.Uri.file(parseError.yamlPath);
  const line = (parseError.line ?? 1) - 1; // 0-based
  const col = (parseError.column ?? 0) - 1;

  const diag = new vscode.Diagnostic(
    col > 0 
      ? new vscode.Range(line, col, line, col + 10) 
      : new vscode.Range(line, 0, line, 80),
    `CalcDocs YAML Parse Error: ${parseError.message}`,
    vscode.DiagnosticSeverity.Error
  );
  diag.source = "CalcDocs";

  state.diagnostics!.set(uri, [diag]);

}

/**
 * Clear all diagnostics for formulas.yaml files.
 */
function clearFormulaDiagnostics(state: CalcDocsState): void {
  clearDiagnostics(state);
}

function buildSymbolRangeInLine(
  lineText: string,
  symbol: string,
  line: number
): vscode.Range {
  const index = lineText.indexOf(symbol);
  const start = index >= 0 ? index : 0;
  const end =
    index >= 0
      ? index + symbol.length
      : Math.min(lineText.length, symbol.length);
  const safeEnd = Math.max(start, end);
  return new vscode.Range(line, start, line, safeEnd);
}

function hasMissingYamlValue(entry: FormulaEntry): boolean {
  return !(typeof entry.valueYaml === "number" && Number.isFinite(entry.valueYaml));
}

function getUniqueSymbolLocations(
  state: CalcDocsState,
  symbol: string
): Array<{ file: string; line: number }> {
  const variants = state.symbolConditionalDefs.get(symbol) ?? [];
  const unique = new Map<string, { file: string; line: number }>();

  for (const variant of variants) {
    const key = `${variant.expr}@@${variant.condition}`;
    unique.set(key, {
      file: variant.file,
      line: variant.line,
    });
  }

  return Array.from(unique.values());
}

function appendMissingYamlValueDuplicateDiagnostics(
  state: CalcDocsState,
  diagsByFile: Map<string, vscode.Diagnostic[]>
): void {
  const workspaceRoot = state.workspaceRoot;

  for (const [key, entry] of state.formulaIndex) {
    if (!entry._filePath || !hasMissingYamlValue(entry)) {
      continue;
    }

    const locations = getUniqueSymbolLocations(state, key);
    if (locations.length <= 1) {
      continue;
    }

    const uri = vscode.Uri.file(path.join(workspaceRoot, entry._filePath));
    const uriStr = uri.toString();
    const line = Math.max(0, entry._line ?? 0);
    const range = new vscode.Range(line, 0, line, Math.max(1, key.length));
    const previewLocations = locations
      .slice(0, 4)
      .map((location) => `${location.file}:${location.line}`)
      .join(", ");
    const extraCount = locations.length - 4;
    const suffix = extraCount > 0 ? ` (+${extraCount} more)` : "";

    const message =
      `Duplicate C/C++ references found for missing YAML value '${key}': ` +
      `${previewLocations}${suffix}.`;
    const fileDiags = diagsByFile.get(uriStr) ?? [];
    fileDiags.push(
      new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error)
    );
    diagsByFile.set(uriStr, fileDiags);
  }
}

async function appendDefineMismatchDiagnostics(
  state: CalcDocsState,
  files: string[],
  diagsByFile: Map<string, vscode.Diagnostic[]>
): Promise<void> {
  if (state.formulaIndex.size === 0) {
    return;
  }

  const sourceFiles = files.filter((file) =>
    SOURCES_ONLY_EXTS.has(path.extname(file).toLowerCase())
  );

  if (sourceFiles.length === 0) {
    return;
  }

  for (const filePath of sourceFiles) {
    let text: string;
    try {
      text = await fsp.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    let braceDepth = 0;
    const uri = vscode.Uri.file(filePath);
    const uriStr = uri.toString();
    const fileDiags = diagsByFile.get(uriStr) ?? [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const canParseDeclaration =
        braceDepth === 0 || DEFINE_DIRECTIVE_RX.test(line);
      const parsed = canParseDeclaration
        ? parseCppSymbolDefinition(line)
        : undefined;

      if (parsed) {
        const { name, expr, macroParams } = parsed;
        const ambiguityRoots = state.symbolAmbiguityRoots.get(name) ?? [];

        if (ambiguityRoots.length === 0) {
          const isFunctionLikeMacro = macroParams != null;
          if (
            !isFunctionLikeMacro &&
            !isCompositeExpression(expr, state.symbolValues, state.allDefines, state.functionDefines)
          ) {
            const formula = state.formulaIndex.get(name);
            if (formula && typeof formula.valueCalc === "number") {
              const preview = buildCompositeExpressionPreview(
                expr,
                state.symbolValues,
                state.allDefines,
                state.functionDefines,
                {},
                state.defineConditions
              );
              const value = preview.value;

              if (typeof value === "number") {
                const baseline =
                  formula.valueCalc === 0 ? 1 : Math.abs(formula.valueCalc);
                const diff = Math.abs(formula.valueCalc - value) / baseline;

                if (diff > DEFINE_VALUE_MISMATCH_THRESHOLD) {
                  const pct = diff * 100;
                  const range = buildSymbolRangeInLine(line, name, i);
                  fileDiags.push(
                    new vscode.Diagnostic(
                      range,
                      `C/C++ define value ${value} differs from formulas value ${formula.valueCalc} (${pct.toFixed(1)}% diff)`,
                      vscode.DiagnosticSeverity.Warning
                    )
                  );
                }
              }
            }
          }
        }
      }

      braceDepth = updateBraceDepth(braceDepth, line);
    }

    if (fileDiags.length > 0) {
      diagsByFile.set(uriStr, fileDiags);
    }
  }
}

function toDiagnosticSeverity(
  severity: "error" | "warning" | "info"
): vscode.DiagnosticSeverity {
  if (severity === "error") {
    return vscode.DiagnosticSeverity.Error;
  }

  if (severity === "warning") {
    return vscode.DiagnosticSeverity.Warning;
  }

  return vscode.DiagnosticSeverity.Information;
}

function appendYamlEngineDiagnostics(
  state: CalcDocsState,
  diagsByFile: Map<string, vscode.Diagnostic[]>
): void {
  if (!state.lastYamlPath || state.yamlDiagnostics.length === 0) {
    return;
  }

  const uri = vscode.Uri.file(state.lastYamlPath);
  const uriStr = uri.toString();
  const fileDiags = diagsByFile.get(uriStr) ?? [];

  for (const diagnostic of state.yamlDiagnostics) {
    const line = Math.max(0, diagnostic.line);
    const endCharacter = Math.max(1, diagnostic.symbol.length);
    const range = new vscode.Range(line, 0, line, endCharacter);
    const vscodeDiagnostic = new vscode.Diagnostic(
      range,
      diagnostic.message,
      toDiagnosticSeverity(diagnostic.severity)
    );
    vscodeDiagnostic.source = "CalcDocs YAML";
    fileDiags.push(vscodeDiagnostic);
  }

  if (state.missingYamlSuggestions.length > 0) {
    const preview = state.missingYamlSuggestions
      .slice(0, 6)
      .map((entry) => `${entry.name} (${entry.unit})`)
      .join(", ");
    const suffix =
      state.missingYamlSuggestions.length > 6
        ? ` (+${state.missingYamlSuggestions.length - 6} more)`
        : "";

    fileDiags.push(
      new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        `CalcDocs suggestion: add YAML entries for C/C++ symbols with units: ${preview}${suffix}`,
        vscode.DiagnosticSeverity.Information
      )
    );
  }

  if (fileDiags.length > 0) {
    diagsByFile.set(uriStr, fileDiags);
  }
}

function appendAmbiguousSymbolDiagnostics(
  state: CalcDocsState,
  diagsByFile: Map<string, vscode.Diagnostic[]>
): void {
  for (const [symbol, variants] of state.symbolConditionalDefs) {
    if (variants.length <= 1) {
      continue;
    }

    const roots = state.symbolAmbiguityRoots.get(symbol) ?? [symbol];
    const inherited = roots.filter((root) => root !== symbol);
    const inheritedSuffix =
      inherited.length > 0
        ? `; inherited from ${inherited.join(", ")}`
        : "";

    for (const variant of variants) {
      const filePath = path.resolve(state.workspaceRoot, variant.file);
      const uri = vscode.Uri.file(filePath);
      const uriStr = uri.toString();
      const fileDiags = diagsByFile.get(uriStr) ?? [];
      const line =
        variant.line > 0
          ? Math.max(0, variant.line - 1)
          : Math.max(0, variant.line);
      const range = new vscode.Range(line, 0, line, Math.max(1, symbol.length));

      fileDiags.push(
        new vscode.Diagnostic(
          range,
          `Ambiguous symbol '${symbol}': ${variants.length} conditional definitions detected${inheritedSuffix}.`,
          vscode.DiagnosticSeverity.Warning
        )
      );

      diagsByFile.set(uriStr, fileDiags);
    }
  }
}

function appendFormulaAmbiguityDiagnostics(
  state: CalcDocsState,
  diagsByFile: Map<string, vscode.Diagnostic[]>
): void {
  const workspaceRoot = state.workspaceRoot;

  for (const [name, entry] of state.formulaIndex) {
    if (!entry._filePath || !entry.formula) {
      continue;
    }

    const ambiguousSymbols = getAmbiguousFormulaSymbols(entry.formula, state);
    if (ambiguousSymbols.length === 0) {
      continue;
    }

    const uri = vscode.Uri.file(path.join(workspaceRoot, entry._filePath));
    const uriStr = uri.toString();
    const fileDiags = diagsByFile.get(uriStr) ?? [];
    const line = Math.max(0, entry._line ?? 0);
    const range = new vscode.Range(line, 0, line, Math.max(1, name.length));

    fileDiags.push(
      new vscode.Diagnostic(
        range,
        `Formula '${name}' depends on ambiguous C/C++ symbols: ${ambiguousSymbols.join(", ")}.`,
        vscode.DiagnosticSeverity.Warning
      )
    );

    diagsByFile.set(uriStr, fileDiags);
  }
}

/**
 * Check formula entry for label/value discrepancies and report as diagnostics.
 */
async function reportFormulaDiscrepancies(
  state: CalcDocsState,
  files: string[]
): Promise<void> {
  if (!state.diagnostics || state.formulaIndex.size === 0) return;

  const diagsByFile = new Map<string, vscode.Diagnostic[]>();
  const workspaceRoot = state.workspaceRoot;

  for (const [key, entry] of state.formulaIndex) {
    if (!entry._filePath) continue;
    const uriStr = path.join(workspaceRoot, entry._filePath);
    const uri = vscode.Uri.file(uriStr);
    const line = (entry._line || 0);

    const fileDiags = diagsByFile.get(uri.toString()) || [];

    // Value discrepancy check
    if (entry.valueYaml != null && entry.valueCalc != null && Math.abs(entry.valueCalc - entry.valueYaml) > 0.01) {
      const diff = Math.abs(entry.valueCalc - entry.valueYaml);
      const baseline = Math.abs(entry.valueYaml || 1);
      const pct = (diff / baseline) * 100;
      fileDiags.push(new vscode.Diagnostic(
        new vscode.Range(line, 0, line, key.length),
        `Value discrepancy: YAML=${entry.valueYaml.toFixed(2)} vs computed=${entry.valueCalc.toFixed(2)} (${pct.toFixed(1)}% diff)`,
        vscode.DiagnosticSeverity.Warning
      ));
    }

    // Label discrepancy checks (report if explicit label missing inferred one)
    if (entry.formula) {
      if (TABLE_LOOKUP_RX.test(entry.formula) && !entry.labels.includes("table_lookup")) {
        fileDiags.push(new vscode.Diagnostic(
          new vscode.Range(line, 0, line, key.length),
          `Formula uses csv/table lookup but missing explicit 'table_lookup' label`,
          vscode.DiagnosticSeverity.Hint
        ));
      }
      if (isComplexFormulaExpression(entry.formula) && !entry.labels.includes("complex_expression")) {
        fileDiags.push(new vscode.Diagnostic(
          new vscode.Range(line, 0, line, key.length),
          `Complex formula but missing explicit 'complex_expression' label`,
          vscode.DiagnosticSeverity.Hint
        ));
      }
    }

    if (fileDiags.length > 0) {
      diagsByFile.set(uri.toString(), fileDiags);
    }
  }

  appendMissingYamlValueDuplicateDiagnostics(state, diagsByFile);
  appendYamlEngineDiagnostics(state, diagsByFile);
  appendAmbiguousSymbolDiagnostics(state, diagsByFile);
  appendFormulaAmbiguityDiagnostics(state, diagsByFile);
  await appendDefineMismatchDiagnostics(state, files, diagsByFile);

  // Clear previous and set new
  state.diagnostics!.clear();
  diagsByFile.forEach((diags, uriStr) => {
    const uri = vscode.Uri.parse(uriStr);
    state.diagnostics!.set(uri, diags);
  });
}




/**
 * Carica il file YAML e riporta gli errori di parsing al canale di output senza lanciare eccezioni.
 * 
 * @param state - Stato corrente dell'estensione
 * @param yamlPath - Percorso del file YAML da caricare
 * @returns L'oggetto LoadedYaml se il parsing ha successo, null altrimenti
 */
async function loadYamlOrReportError(
  state: CalcDocsState,
  yamlPath: string
): Promise<LoadedYaml | null> {
  try {
    return await loadYaml(yamlPath);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const position = parseYamlErrorPosition(message);
    const parseError: YamlParseErrorInfo = {
      yamlPath,
      message,
      line: position.line,
      column: position.column,
    };

    state.lastYamlParseError = parseError;

    const locationLabel =
      parseError.line != null && parseError.column != null
        ? `:${parseError.line}:${parseError.column}`
        : "";
    state.output.error(localize("output.yamlError", parseError.yamlPath, locationLabel, parseError.message));
    
    // Report to Problems panel
    reportYamlParseDiagnostic(state, parseError);
    
    // Forza l'apertura del pannello CalcDocs per mostrare subito la diagnostica all'utente
    state.output.show(false);
    return null;
  }
}



/**
 * Modalità analisi completa quando esiste il file formulas YAML.
 * Flusso:
 * 1) seeding dei valori numerici noti da YAML
 * 2) merge e risoluzione dei simboli C/C++
 * 3) ricostruzione dell'indice delle formule con espressioni espanse
 * 
 * @param state - Stato corrente dell'estensione
 * @param files - Lista dei file da analizzare
 * @param yamlPath - Percorso del file YAML
 * @param loadedYaml - Contenuto YAML parsato
 * @param stackStats - Statistiche per la risoluzione simboli
 */
async function runYamlAnalysis(
  state: CalcDocsState,
  files: string[],
  yamlPath: string,
  loadedYaml: LoadedYaml,
  stackStats: SymbolResolutionStats
): Promise<void> {
  state.lastYamlPath = yamlPath;
  state.lastYamlRaw = loadedYaml.rawText;

  // Estrai le entry YAML e inizializza i valori dei simboli
  const yamlNodes = getYamlNodeEntries(loadedYaml.parsed);
  seedSymbolValuesFromYaml(state, yamlNodes);

  // Filter only C/C++ source files (no headers)
  const sourceFiles = files.filter((f) =>
    SOURCES_ONLY_EXTS.has(path.extname(f).toLowerCase())
  ).sort((left, right) => left.localeCompare(right));

  // Collect symbols from source files with include resolution (force fresh for tests)
  const config = getConfig();
  const collectOpts: any = {
    resolveIncludes: true,
    output: state.output,
    maxMegaCacheEntries: config.cppCacheMaxEntries,
  };
  if (sourceFiles.some(f => f.includes('test'))) {
    // state.output.appendLine('[Analysis] 🔄 Test files detected - forcing fresh C parse (cache bypassed)');
    collectOpts.clearTestCache = true; // Trigger cache clear in cppParser
  }
  const cppSymbols = await collectDefinesAndConsts(sourceFiles, state.workspaceRoot, collectOpts);

  applyCppSymbols(state, cppSymbols, {
    resetSymbolValues: false,
    applyConstsBeforeResolve: true,
    requireFiniteResolvedValues: false,
    symbolResolutionStats: stackStats,
  });

  // Carica le tabelle CSV del workspace (incluse quelle adiacenti allo YAML)
  const csvFiles = files.filter(f => f.toLowerCase().endsWith(".csv"));
  state.csvTables = await loadWorkspaceCsvTables(csvFiles);

  // Estrai unità dai sorgenti C/C++ e sincronizzale con YAML.
  const extractedUnits = await extractUnitsFromCppFiles(files, state.workspaceRoot);
  for (const [name, value] of extractedUnits.values) {
    if (!state.symbolValues.has(name)) {
      state.symbolValues.set(name, value);
    }
  }

  const yamlExternalValues = new Map<string, number>(state.symbolValues);
  for (const [name, value] of cppSymbols.consts) {
    if (Number.isFinite(value) && !yamlExternalValues.has(name)) {
      yamlExternalValues.set(name, value);
    }
  }
  for (const [name, expr] of cppSymbols.defines) {
    if (yamlExternalValues.has(name)) {
      continue;
    }

    try {
      const numericValue = safeEval(expr);
      if (Number.isFinite(numericValue)) {
        yamlExternalValues.set(name, numericValue);
      }
    } catch {
      // Keep unresolved expressions out of the YAML engine context.
    }
  }

  const yamlEngineResult = evaluateYamlDocument(loadedYaml.parsed, {
    rawText: loadedYaml.rawText,
    yamlPath: yamlPath,
    externalValues: yamlExternalValues,
    externalUnits: extractedUnits.units,
    csvTables: state.csvTables,
  });

  state.yamlDiagnostics = yamlEngineResult.diagnostics;
  state.missingYamlSuggestions = yamlEngineResult.missingSuggestions;

  rebuildFormulaIndexWithEngine(
    state,
    yamlNodes,
    loadedYaml.rawText,
    yamlPath,
    yamlEngineResult.symbols
  );
  fillMissingYamlValuesFromCppSymbols(state);

  if (yamlEngineResult.missingSuggestions.length > 0) {
    const preview = yamlEngineResult.missingSuggestions
      .slice(0, 8)
      .map((entry) => `${entry.name} [${entry.unit}]`)
      .join(", ");
    const suffix =
      yamlEngineResult.missingSuggestions.length > 8
        ? ` (+${yamlEngineResult.missingSuggestions.length - 8} more)`
        : "";
    state.output.info(`[YAML] Suggested new symbols from C/C++ units: ${preview}${suffix}`);
  }

  state.output.info(
    localize("output.analysisComplete", state.formulaIndex.size)
  );
}

/**
 * Filtra l'oggetto YAML radice fino ai soli nodi oggetto di primo livello.
 * Esempio: ignora le chiavi scalari come "version: 1" e tiene i blocchi come "PRESSURE_DROP:".
 * 
 * @param yamlRoot - Oggetto YAML parsato
 * @returns Array di coppie [chiave, oggetto] per i nodi di primo livello
 */
function getYamlNodeEntries(yamlRoot: Record<string, unknown>): YamlNodeEntries {
  const entries: YamlNodeEntries = [];

  for (const [key, value] of Object.entries(yamlRoot)) {
    // Salta valori non-oggetto o array
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    entries.push([key, value as Record<string, unknown>]);
  }

  return entries;
}

/**
 * Inizializza i valori simbolici dai campi "value" YAML.
 * Esempio: { PRESSURE_DROP: { value: 25 } } -> symbolValues.set("PRESSURE_DROP", 25)
 * 
 * @param state - Stato corrente dell'estensione
 * @param yamlNodes - Entry YAML da processare
 */
function seedSymbolValuesFromYaml(
  state: CalcDocsState,
  yamlNodes: YamlNodeEntries
): void {
  state.symbolValues.clear();

  for (const [key, node] of yamlNodes) {
    if (!("value" in node)) {
      continue;
    }

    const rawValue = node.value;
    let numericValue = Number(rawValue);

    if (!Number.isFinite(numericValue) && typeof rawValue === "string") {
      const match = rawValue.trim().match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-z%][A-Za-z0-9_%]*)$/);
      if (match) {
        numericValue = Number(match[1]);
      }
    }

    if (Number.isFinite(numericValue)) {
      state.symbolValues.set(key, numericValue);
    }
  }
}

/**
 * Merge delle definizioni #define e costanti C/C++ nello stato e risoluzione dei simboli derivati.
 * Le opzioni controllano l'ordine di merge in base alla modalità di analisi corrente.
 * 
 * @param state - Stato corrente dell'estensione
 * @param cppSymbols - Simboli C/C++ raccolti dal parser
 * @param options - Opzioni che controllano l'ordine di merge
 */
function applyCppSymbols(
  state: CalcDocsState,
  cppSymbols: CollectedCppSymbols,
  options: {
    resetSymbolValues: boolean;
    applyConstsBeforeResolve: boolean;
    requireFiniteResolvedValues: boolean;
    symbolResolutionStats: SymbolResolutionStats;
  }
): void {
  // Pulisci tutte le strutture dati
  state.allDefines.clear();
  state.defineConditions.clear();
  state.defineComments.clear();
  state.functionDefines.clear();
  state.symbolDefs.clear();
  state.symbolConditionalDefs.clear();
  state.symbolAmbiguityRoots.clear();
  state.symbolUnits.clear();

  if (options.resetSymbolValues) {
    state.symbolValues.clear();
  }

  // Copia le unità estratte
  for (const [name, unit] of cppSymbols.units) {
    state.symbolUnits.set(name, unit);
  }

  // Processa le definizioni #define
  for (const [name, expr] of cppSymbols.defines) {
    state.allDefines.set(name, expr);
    state.defineConditions.set(
      name,
      cppSymbols.defineConditions.get(name) ?? "always"
    );
    const comment = cppSymbols.defineComments.get(name);
    if (comment) {
      state.defineComments.set(name, comment);
    }

    // Prova a valutare immediatamente il valore numerico
    try {
      const numericValue = safeEval(expr);
      state.symbolValues.set(name, numericValue);
    } catch {
      // Mantieni le definizioni non risolte per espansione ricorsiva
    }
  }

  // Processa le macro funzione
  for (const [name, definition] of cppSymbols.functionDefines) {
    state.functionDefines.set(name, {
      params: [...definition.params],
      body: definition.body,
    });
  }

  // Applica le costanti prima o dopo la risoluzione in base alle opzioni
  if (options.applyConstsBeforeResolve) {
    mergeConstValues(state, cppSymbols.consts);
  }

  // Risolvi le definizioni rimanenti ricorsivamente
  resolveRemainingDefines(
    state,
    options.requireFiniteResolvedValues,
    options.symbolResolutionStats
  );

  if (!options.applyConstsBeforeResolve) {
    mergeConstValues(state, cppSymbols.consts);
  }

  // Aggiungi le posizioni delle definizioni
  for (const [name, location] of cppSymbols.locations) {
    state.symbolDefs.set(name, location);
  }

  // Aggiorna le informazioni sulle definizioni condizionali
  updateConditionalDefinitionInfo(state, cppSymbols.defineVariants);
  // Rimuovi i simboli ambigui dallo stato di valutazione
  removeAmbiguousSymbolsFromEvaluationState(state);
}

/**
 * Copia i valori numerici diretti estratti dalle dichiarazioni C/C++ in symbolValues.
 * 
 * @param state - Stato corrente dell'estensione
 * @param consts - Mappa nome -> valore delle costanti
 */
function mergeConstValues(
  state: CalcDocsState,
  consts: Map<string, number>
): void {
  for (const [name, value] of consts) {
    state.symbolValues.set(name, value);
  }
}

/**
 * Tentativo di valutazione ricorsiva per i simboli #define non ancora risolti.
 * Esempio: se A=10 e B=(A*2), questo riempie B=20.
 * 
 * @param state - Stato corrente dell'estensione
 * @param requireFiniteResolvedValues - Se true, richiede valori finiti
 * @param stackStats - Statistiche per il monitoraggio della ricorsione
 */
function resolveRemainingDefines(
  state: CalcDocsState,
  requireFiniteResolvedValues: boolean,
  stackStats: SymbolResolutionStats
): void {
  for (const name of state.allDefines.keys()) {
    // Salta se già risolto
    if (state.symbolValues.has(name)) {
      continue;
    }

    // Prova a risolvere il simbolo
    const resolvedValue = resolveSymbol(
      name,
      state.allDefines,
      state.functionDefines,
      new Map<string, number>(),
      state.symbolValues,
      {},
      stackStats,
      new Set<string>(),
      state.defineConditions
    );

    const isResolvedNumber =
      typeof resolvedValue === "number" &&
      (!requireFiniteResolvedValues || Number.isFinite(resolvedValue));

    if (isResolvedNumber) {
      state.symbolValues.set(name, resolvedValue);
    }
  }
}

/**
 * Persiste ogni definizione condizionale parsata e propaga l'ambiguità ai simboli dipendenti.
 * Esempio: se N ha 2 varianti #define e M usa N, sia N che M vengono marcati come ambigui.
 * 
 * @param state - Stato corrente dell'estensione
 * @param defineVariants - Varianti delle definizioni raccolte dal parser
 */
function updateConditionalDefinitionInfo(
  state: CalcDocsState,
  defineVariants: CollectedCppSymbols["defineVariants"]
): void {
  // Salva tutte le varianti condizionali
  for (const [name, variants] of defineVariants) {
    state.symbolConditionalDefs.set(
      name,
      variants.map((variant) => ({ ...variant }))
    );
  }

  // Trova le radici di ambiguità (simboli con più varianti)
  const ambiguousRoots = Array.from(defineVariants.entries())
    .filter(([, variants]) => variants.length > 1)
    .map(([name]) => name);

  if (ambiguousRoots.length === 0) {
    return;
  }

  // Costruisci le dipendenze inverse per propagare l'ambiguità
  const reverseDependencies = buildReverseDefineDependencies(defineVariants);
  const inheritedAmbiguities = new Map<string, Set<string>>();

  // Propaga l'ambiguità a tutti i simboli dipendenti
  for (const root of ambiguousRoots) {
    const rootSet = inheritedAmbiguities.get(root) ?? new Set<string>();
    rootSet.add(root);
    inheritedAmbiguities.set(root, rootSet);

    const visited = new Set<string>([root]);
    const queue = Array.from(reverseDependencies.get(root) ?? []);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }

      visited.add(current);

      const currentSet = inheritedAmbiguities.get(current) ?? new Set<string>();
      currentSet.add(root);
      inheritedAmbiguities.set(current, currentSet);

      // Aggiungi i dipendenti alla coda
      for (const next of reverseDependencies.get(current) ?? []) {
        if (!visited.has(next)) {
          queue.push(next);
        }
      }
    }
  }

  // Salva le ambiguità ereditate
  for (const [name, roots] of inheritedAmbiguities) {
    state.symbolAmbiguityRoots.set(name, Array.from(roots).sort());
  }
}

/**
 * Mantiene i simboli ambigui disponibili per la navigazione, ma li esclude dalla valutazione numerica.
 * 
 * @param state - Stato corrente dell'estensione
 */
function removeAmbiguousSymbolsFromEvaluationState(state: CalcDocsState): void {
  for (const name of state.symbolAmbiguityRoots.keys()) {
    state.symbolValues.delete(name);
    state.allDefines.delete(name);
    state.defineConditions.delete(name);
    state.functionDefines.delete(name);
  }
}

/**
 * Costruisce una mappa di dipendenze inverse per le definizioni condizionali.
 * Mappa ogni simbolo all'insieme dei simboli che dipendono da esso.
 * 
 * @param defineVariants - Varianti delle definizioni
 * @returns Mappa delle dipendenze inverse
 */
function buildReverseDefineDependencies(
  defineVariants: CollectedCppSymbols["defineVariants"]
): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();

  for (const [name, variants] of defineVariants) {
    const dependencies = new Set<string>();

    // Estrai tutti i token usati in ogni variante
    for (const variant of variants) {
      for (const token of variant.expr.match(TOKEN_RX) ?? []) {
        if (token !== name) {
          dependencies.add(token);
        }
      }
    }

    // Registra ogni dipendenza
    for (const dependency of dependencies) {
      const dependents = reverse.get(dependency) ?? new Set<string>();
      dependents.add(name);
      reverse.set(dependency, dependents);
    }
  }

  return reverse;
}

function rebuildFormulaIndexWithEngine(
  state: CalcDocsState,
  yamlNodes: YamlNodeEntries,
  yamlRaw: string,
  yamlPath: string,
  evaluatedSymbols: Map<string, EvaluatedYamlSymbol>
): void {
  state.formulaIndex.clear();

  for (const [key, node] of yamlNodes) {
    const entry = buildFormulaEntry(
      key,
      node,
      yamlRaw,
      yamlPath,
      state.workspaceRoot
    );

    if (entry.unit) {
      state.symbolUnits.set(key, entry.unit);
    }
    const evaluated = evaluatedSymbols.get(key);

    if (evaluated) {
      entry.exprType = evaluated.type;
      entry.formula = evaluated.expression ?? entry.formula;
      entry.labels = mergeEntryLabels(entry.formula ?? "", entry.labels);
      entry.explainSteps = evaluated.explainSteps.length
        ? [...evaluated.explainSteps]
        : undefined;
      entry.resolvedDependencies = evaluated.resolvedDependencies.length
        ? [...evaluated.resolvedDependencies]
        : undefined;
      entry.evaluationErrors = evaluated.errors.length
        ? [...evaluated.errors]
        : undefined;
      entry.evaluationWarnings = evaluated.warnings.length
        ? [...evaluated.warnings]
        : undefined;
      entry.toleranceResult = evaluated.range
        ? {
            ...evaluated.range,
            source: evaluated.range.source,
          }
        : undefined;

      if (evaluated.outputUnit) {
        entry.unit = evaluated.outputUnit;
      }

      if (typeof evaluated.value === "number" && Number.isFinite(evaluated.value)) {
        entry.valueCalc = evaluated.value;
        state.symbolValues.set(key, evaluated.value);
      } else {
        entry.valueCalc = null;
      }

      if (evaluated.expanded) {
        entry.expanded = clampLen(evaluated.expanded);
      }
    } else if (entry.formula) {
      entry.labels = mergeEntryLabels(entry.formula, entry.labels);
    }

    state.formulaIndex.set(key, entry);
  }
}

/**
 * Ricostruisce le entry dell'indice delle formule arricchite con espressione espansa e valore calcolato.
 * Esempio: "RHO * V * V / 2" -> "1.2 * 10 * 10 / 2" -> 60.
 * 
 * @param state - Stato corrente dell'estensione
 * @param yamlNodes - Entry YAML da processare
 * @param yamlRaw - Testo raw del YAML
 * @param yamlPath - Percorso del file YAML
 * @param defines - Mappa delle definizioni
 * @param functionDefines - Mappa delle macro funzione
 * @param evalContext - Contesto di valutazione (CSV tables, etc.)
 * @param stackStats - Statistiche di risoluzione
 */
function rebuildFormulaIndex(
  state: CalcDocsState,
  yamlNodes: YamlNodeEntries,
  yamlRaw: string,
  yamlPath: string,
  defines: Map<string, string>,
  functionDefines: CalcDocsState["functionDefines"],
  evalContext: EvaluationContext,
  stackStats: SymbolResolutionStats
): void {
  state.formulaIndex.clear();

  for (const [key, node] of yamlNodes) {
    // Costruisci l'entry della formula dal nodo YAML
    const entry = buildFormulaEntry(
      key,
      node,
      yamlRaw,
      yamlPath,
      state.workspaceRoot
    );

    if (entry.unit) {
      state.symbolUnits.set(key, entry.unit);
    }

    // Se c'è una formula, processa e calcola il valore
    if (entry.formula) {
      // Estrai unità di misura inline se presente (es. "5 * MUL -> m/s")
      const parsed = parseExpressionUnit(entry.formula);
      const formulaExpr = parsed.expression;
      const outputUnit = parsed.outputUnit;
      
      // Salva l'unità se trovata
      if (outputUnit) {
        entry.unit = outputUnit;
      }
      
      entry.labels = mergeEntryLabels(formulaExpr, entry.labels);
      const ambiguousSymbols = getAmbiguousFormulaSymbols(formulaExpr, state);
      
      // Processa solo se non ci sono simboli ambigui
      if (ambiguousSymbols.length === 0) {
        const resolvedMap = new Map<string, number>();
        const expanded = expandExpression(
          formulaExpr,
          defines,
          functionDefines,
          resolvedMap,
          state.symbolValues,
          evalContext,
          stackStats,
          state.defineConditions,
          state.symbolUnits
        );
        const expandedWithLookups = resolveInlineLookups(expanded, evalContext);

        entry.expanded = clampLen(expandedWithLookups);

        // Prova a calcolare il valore numerico
        try {
          entry.valueCalc = safeEval(expandedWithLookups, evalContext);
        } catch {
          // Lascia valueCalc come null quando l'espressione non è numerica
        }
        
        // Calcola le dimensioni fisiche se richiesto
        if (outputUnit) {
          const varDims = buildVariableDimensions(state);
          const dimResult = evaluateExpressionDimensions(formulaExpr, varDims);
          if (dimResult.dimension) {
            // Aggiungi warning di dimensione se presente
            const unitSpec = UNIT_SPECS.get(normalizeUnitToken(outputUnit));
            if (unitSpec && !dimensionsEqual(dimResult.dimension, unitSpec.dimension)) {
              state.output.warn(
                `Formula '${entry.key}': dimension mismatch - expression is ${formatDimensionVector(dimResult.dimension)} but output unit '${unitSpec.canonical}' expects ${formatDimensionVector(unitSpec.dimension)}`
              );
            }
          }
        }
      } else {
        // Anche con simboli ambigui, prova a calcolare il valore per il write-back
        const resolvedMap = new Map<string, number>();
        const replaced = replaceTokens(formulaExpr, state.symbolValues);
        const expanded = expandExpression(
          replaced,
          defines,
          functionDefines,
          resolvedMap,
          state.symbolValues,
          evalContext,
          stackStats,
          state.defineConditions,
          state.symbolUnits
        );
        const expandedWithLookups = resolveInlineLookups(expanded, evalContext);

        entry.expanded = clampLen(expandedWithLookups);

        try {
          entry.valueCalc = safeEval(expandedWithLookups, evalContext);
        } catch {
          // Mantieni valueCalc come null
        }
      }
    }

    state.formulaIndex.set(key, entry);
  }
}

function fillMissingYamlValuesFromCppSymbols(state: CalcDocsState): void {
  for (const entry of state.formulaIndex.values()) {
    if (!hasMissingYamlValue(entry)) {
      continue;
    }

    if (typeof entry.valueCalc === "number" && Number.isFinite(entry.valueCalc)) {
      continue;
    }

    const symbolLocations = getUniqueSymbolLocations(state, entry.key);
    if (symbolLocations.length > 1) {
      continue;
    }

    const symbolValue = state.symbolValues.get(entry.key);
    if (typeof symbolValue === "number" && Number.isFinite(symbolValue)) {
      entry.valueCalc = symbolValue;
    }
  }
}

/**
 * Estrae i simboli ambigui da una formula.
 * Un simbolo è ambiguo se ha definizioni condizionali multiple o dipende da un simbolo ambiguo.
 * 
 * @param formula - Stringa della formula da analizzare
 * @param state - Stato corrente dell'estensione
 * @returns Array di nomi di simboli ambigui
 */
function getAmbiguousFormulaSymbols(
  formula: string,
  state: CalcDocsState
): string[] {
  const ambiguous = new Set<string>();

  for (const token of formula.match(TOKEN_RX) ?? []) {
    if (state.symbolAmbiguityRoots.has(token)) {
      ambiguous.add(token);
    }
  }

  return Array.from(ambiguous);
}

/**
 * Unisce le etichette esistenti con le etichette derivate dalla formula.
 * Aggiunge etichette come "table_lookup" o "complex_expression" se appropriato.
 * 
 * @param formula - Stringa della formula
 * @param existingLabels - Etichette già presenti
 * @returns Array di etichette unificate
 */
function mergeEntryLabels(
  formula: string,
  existingLabels: FormulaLabel[]
): FormulaLabel[] {
  const merged = new Set<FormulaLabel>(existingLabels);

  // Aggiungi etichetta table_lookup se la formula usa lookup
  if (TABLE_LOOKUP_RX.test(formula)) {
    merged.add("table_lookup");
  }

  // Aggiungi etichetta complex_expression se è un'espressione complessa
  if (isComplexFormulaExpression(formula)) {
    merged.add("complex_expression");
  }

  return Array.from(merged);
}

/**
 * Determina se un'espressione di formula è "complessa".
 * Complessa significa che contiene operatori e/o simboli risolvibili.
 * 
 * @param formula - Stringa della formula da analizzare
 * @returns True se l'espressione è considerata complessa
 */
function isComplexFormulaExpression(formula: string): boolean {
  // Usa lookup table -> complessa
  if (TABLE_LOOKUP_RX.test(formula)) {
    return true;
  }

  // Chiama funzioni -> complessa
  if (FUNC_CALL_RX.test(formula)) {
    return true;
  }

  // Controlla se ci sono almeno 2 operatori
  const operatorCount = formula.match(OPERATOR_COUNT_RX)?.length ?? 0;
  return operatorCount >= 2;
}
