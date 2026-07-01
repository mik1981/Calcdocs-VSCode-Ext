import * as vscode from "vscode";

import { type FunctionMacroDefinition } from "./expression";
import type { CsvTableMap } from "./csvTables";
import type {
  CppCodeLensConfig,
  CppHoverConfig,
  InlineCalcDiagnosticsLevel,
  InlineCodeLensConfig,
  InlineHoverConfig,
  UiInvasivenessLevel,
} from "./config";
import { FormulaEntry } from "../types/FormulaEntry";
import { type ColoredOutput } from "../utils/output";
import type {
  MissingYamlSuggestion,
  YamlEvaluationDiagnostic,
} from "../engine/yamlEngine";
import { getConfig } from "./config";
import { OutlineFormula } from "../formulaOutline/formulaParser";


/**
 * Posizione di una definizione di simbolo nel codice sorgente.
 * Utilizzata per la navigazione (Go to Definition).
 */
export type SymbolDefinitionLocation = {
  /** Percorso del file relativo alla root del workspace */
  file: string;
  /** Numero di linea (0-based) dove è definito il simbolo */
  line: number;
};

/**
 * Definizione condizionale di un simbolo (#ifdef, #ifndef, #if).
 * Memorizza la posizione e la condizione del preprocessore.
 */
export type SymbolConditionalDefinition = SymbolDefinitionLocation & {
  /** Espressione raw del define (es. "#define FOO 42") */
  expr: string;
  /** Condizione del preprocessore (es. "defined(DEBUG)", "!defined(FOO)") */
  condition: string;
};

/**
 * Statistiche sull'utilizzo dello stack durante la risoluzione dei simboli.
 * Utilizzate per diagnosticare problemi di ricorsione e prestazioni.
 */
export type AnalysisStackUsage = {
  /** Profondità massima di ricorsione raggiunta durante la risoluzione dei simboli */
  usedDepth: number;
  /** Limite di sicurezza impostato per evitare stack overflow */
  depthLimit: number;
  /** Numero di dipendenze circolari rilevate (es. A -> B -> A) */
  cycleCount: number;
  /** Numero di risoluzioni saltate perché è stato raggiunto il limite di profondità */
  prunedCount: number;
  /** True se i guard di sicurezza hanno alterato il normale percorso di analisi */
  degraded: boolean;
};

/**
 * Informazioni sull'errore di parsing del file YAML.
 */
export type YamlParseErrorInfo = {
  /** Percorso assoluto del file formulas*.yaml che ha fallito il parsing */
  yamlPath: string;
  /** Messaggio di errore restituito dal parser js-yaml */
  message: string;
  /** Riga opzionale (1-based) per diagnostica del parser, quando disponibile */
  line?: number;
  /** Colonna opzionale (1-based) per diagnostica del parser, quando disponibile */
  column?: number;
};

/**
 * Stato completo dell'estensione CalcDocs per un workspace.
 * Condiviso tra analisi e provider VSCode.
 */
export type FileConfigVars = Map<string, any>;
export type CalcDocsState = {
  /** Percorso assoluto alla cartella root del workspace */
  workspaceRoot: string;
  /** Canale di output per messaggi di log e diagnostica con supporto colori */
  output: ColoredOutput;
  /** Flag globale: true se l'estensione è abilitata, false se disabilitata */
  enabled: boolean;
  /** Percorso dell'ultimo file YAML analizzato */
  lastYamlPath: string;
  /** Contenuto raw dell'ultimo YAML parsato (per write-back) */
  lastYamlRaw: string;
  /** True se esiste almeno un file formulas.yaml nel workspace */
  hasFormulasFile: boolean;
  /** Set di directory da ignorare durante la scansione (da configurazione) */
  ignoredDirs: Set<string>;
  /** Mappa delle formule indicizzate: nome formula -> entry completa */
  formulaIndex: Map<string, FormulaEntry>;
  /** Live outline formulas per documento */
  formulaOutlines: Map<string, OutlineFormula[]>;
  /** Mappa dei valori numerici risolti dei simboli: nome -> valore */
  symbolValues: Map<string, number>;
  /** Mappa delle unità di misura associate ai simboli (da commenti @unit=) */
  symbolUnits: Map<string, string>;
  /** Mappa dei CSV tables caricati: nome -> tabella */
  csvTables: CsvTableMap;
  /** Mappa config files → their @config.* vars */
  configVars: Map<string, FileConfigVars>;
  /** Mappa delle posizioni delle definizioni dei simboli */
  symbolDefs: Map<string, SymbolDefinitionLocation>;
  /** Mappa delle definizioni condizionali (multiple varianti per simbolo) */
  symbolConditionalDefs: Map<string, SymbolConditionalDefinition[]>;
  /** Mappa delle radici di ambiguità: simbolo ambiguo -> simboli da cui dipende */
  symbolAmbiguityRoots: Map<string, string[]>;
  /** Mappa di tutte le definizioni #define: nome -> espressione raw */
  allDefines: Map<string, string>;
  /** Mappa delle condizioni del preprocessore per ogni define */
  defineConditions: Map<string, string>;
  /** Mappa dei commenti associati ai define */
  defineComments: Map<string, string>;
  /** Mappa delle macro funzione: nome -> {params, body} */
  functionDefines: Map<string, FunctionMacroDefinition>;
  /** Header generation config */
  headerGenConfig: { outputPath: string };
  /** Snapshot delle statistiche di stack dell'ultima analisi */
  lastAnalysisStackUsage: AnalysisStackUsage;
  /** Ultimo errore di parsing YAML; null se il parsing è riuscito */
  lastYamlParseError: YamlParseErrorInfo | null;
  /** VSCode diagnostics collection for formulas.yaml errors/discrepancies */
  diagnostics?: vscode.DiagnosticCollection;
  /** VSCode diagnostics collection for inline calc comments */
  inlineCalcDiagnostics?: vscode.DiagnosticCollection;
  /** Diagnostics produced by the safe YAML evaluation engine */
  yamlDiagnostics: YamlEvaluationDiagnostic[];
  /** Suggestions inferred from C/C++ symbols not present in YAML */
  missingYamlSuggestions: MissingYamlSuggestion[];
  /** True se i CodeLens inline calc sono abilitati */
  inlineCalcEnableCodeLens: boolean;
  /** True se l'hover inline calc è abilitato */
  inlineCalcEnableHover: boolean;
  /** True se i ghost value sono abilitati */
  inlineGhostEnabled: boolean;
  /** Livello di diagnostica inline calc */
  inlineCalcDiagnosticsLevel: InlineCalcDiagnosticsLevel;
  /** Profilo invasività UI corrente */
  uiInvasiveness: UiInvasivenessLevel;
  /** Configurazione runtime CodeLens C/C++ */
  cppCodeLens: CppCodeLensConfig;
  /** Configurazione runtime Hover C/C++ */
  cppHover: CppHoverConfig;
  /** Configurazione runtime Inline CodeLens */
  inlineCodeLens: InlineCodeLensConfig;
  /** Configurazione runtime Inline Hover */
  inlineHover: InlineHoverConfig;

  /**
   * Persistent cache: which file resolved a given external C/C++ symbol for
   * a given formulas.yaml, and what the include-closure mtimes were at the
   * time. A full workspace search only happens once per symbol - never
   * needed until the remembered file (or one of its own includes) changes,
   * is deleted, or no longer defines the symbol.
   * Key: `${yamlPath}::${symbolName}`.
   */
  yamlSymbolLocations: Map<string, YamlSymbolLocationEntry>;

  /**
   * Persistent record of which config.c/config.h files have been located in
   * the workspace and their mtime at last parse - so the (cheap, filename-only)
   * workspace search for these files happens once, not on every inline-calc
   * evaluation. Key: absolute file path.
   */
  configVarsSourceFiles: Map<string, number>;
};

export type YamlSymbolLocationEntry = {
  
  symbol: string;
  
  definingFile: string;
  
  /** file path -> mtimeMs, at the time this entry was last verified. Includes definingFile itself. */
  includeClosureMtimes: Map<string, number>;
  
  value: number;
  
  unit?: string;
};



export function createDefaultAnalysisStackUsage(): AnalysisStackUsage {
  return {
    usedDepth: 0,
    depthLimit: 0,
    cycleCount: 0,
    prunedCount: 0,
    degraded: false,
  };
}

/**
 * Crea il container di stato in-memory condiviso tra l'analisi e i provider VSCode.
 * Inizializza tutte le strutture dati necessarie per il funzionamento dell'estensione.
 * 
 * @param workspaceRoot - Percorso assoluto alla cartella root del workspace
 * @param output - Canale di output VSCode per i messaggi di log (wrapped in ColoredOutput)
 * @returns Stato inizializzato dell'estensione
 */
export function createCalcDocsState(
  workspaceRoot: string,
  output: ColoredOutput
): CalcDocsState {
  return {
    workspaceRoot,
    output,
    enabled: true,
    lastYamlPath: "",
    lastYamlRaw: "",
    hasFormulasFile: false,
    ignoredDirs: new Set<string>(),
    formulaIndex: new Map<string, FormulaEntry>(),
    formulaOutlines: new Map(),
    symbolValues: new Map<string, number>(),
    symbolUnits: new Map<string, string>(),
    csvTables: new Map(),
    configVars: new Map<string, FileConfigVars>(),
    symbolDefs: new Map<string, SymbolDefinitionLocation>(),
    symbolConditionalDefs: new Map<string, SymbolConditionalDefinition[]>(),
    symbolAmbiguityRoots: new Map<string, string[]>(),
    allDefines: new Map<string, string>(),
    defineConditions: new Map<string, string>(),
    defineComments: new Map<string, string>(),
    functionDefines: new Map<string, FunctionMacroDefinition>(),
    headerGenConfig: { outputPath: (getConfig() as any).formulaHeader?.outputPath || 'macro_generate.h' },
    lastAnalysisStackUsage: createDefaultAnalysisStackUsage(),
    lastYamlParseError: null,
    diagnostics: undefined,
    inlineCalcDiagnostics: undefined,
    yamlDiagnostics: [],
    missingYamlSuggestions: [],
    inlineCalcEnableCodeLens: true,
    inlineCalcEnableHover: true,
    inlineGhostEnabled: true,
    inlineCalcDiagnosticsLevel: "warnings",
    uiInvasiveness: "standard",
    cppCodeLens: {
      enabled: true,
      maxItemsPerViewport: 40,
      maxItemsPerFile: 40,
      showAmbiguity: true,
      showCastOverflow: true,
      showMismatch: true,
      showOpenFormula: true,
      showResolvedValue: true,
      showExpandedPreview: true,
    },
    cppHover: {
      enabled: true,
      maxConditionalDefinitions: 8,
      maxInDocumentDefinitions: 6,
      showConditionalDefinitions: true,
      showInDocumentDefinitions: true,
      showCastOverflow: true,
      showInheritedAmbiguity: true,
      showFormulaSection: true,
      showKnownValue: true,
      showLiveRegisterDecoder: true,
    },
    inlineCodeLens: {
      enabled: true,
      maxItemsPerViewport: 30,
      maxItemsPerFile: 30,
    },
    inlineHover: {
      enabled: true,
      showDimension: true,
      showWarnings: true,
      showErrors: true,
    },
    yamlSymbolLocations: new Map<string, YamlSymbolLocationEntry>(),
    configVarsSourceFiles: new Map<string, number>(),
  };
}


/**
 * Pulisce tutti i dati computati dell'analisi.
 * Chiamato quando l'estensione viene disabilitata per fermare i provider dal restituire dati obsoleti.
 * 
 * @param state - Stato corrente dell'estensione da pulire
 */
export function clearComputedState(state: CalcDocsState): void {
  state.formulaIndex.clear();
  state.symbolValues.clear();
  state.symbolUnits.clear();
  state.csvTables.clear();
  state.configVars.clear();
  state.symbolDefs.clear();
  state.symbolConditionalDefs.clear();
  state.symbolAmbiguityRoots.clear();
  state.allDefines.clear();
  state.defineConditions.clear();
  state.functionDefines.clear();
  state.lastAnalysisStackUsage = createDefaultAnalysisStackUsage();
  state.lastYamlParseError = null;
  state.yamlDiagnostics = [];
  state.missingYamlSuggestions = [];
  clearDiagnostics(state);
  state.inlineCalcDiagnostics?.clear();
}

/**
 * Clears all diagnostics from the collection.
 */
export function clearDiagnostics(state: CalcDocsState): void {
  state.diagnostics?.clear();
}
