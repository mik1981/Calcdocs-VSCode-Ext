import { CalcDocsState } from "./state";
import { LogLevel } from "../utils/output";

// vscode viene importato in modo lazy per evitare crash nei test
// quando l'alias vitest non risolve le importazioni transitive
let _vscode: typeof import("vscode") | undefined;
function getVscode(): typeof import("vscode") | undefined {
  if (_vscode === undefined) {
    try {
      _vscode = require("vscode");
    } catch {
      _vscode = undefined;
    }
  }
  return _vscode;
}

/**
 * Modalità di visualizzazione dello stato delle risorse nella status bar.
 * - "always": mostra sempre le statistiche di utilizzo
 * - "aboveCpuThreshold": mostra solo quando la CPU supera la soglia
 */
export type ResourceStatusMode = "always" | "aboveCpuThreshold";

/**
 * Livello di diagnostica per inline calc.
 * - "off": nessuna diagnostica
 * - "errors": solo errori
 * - "warnings": errori + warning
 * - "info": errori + warning + info
 */
export type InlineCalcDiagnosticsLevel = "off" | "errors" | "warnings" | "info";

/**
 * Profilo di invasività UI:
 * - minimal: meno informazioni visuali, priorità a non disturbare
 * - standard: comportamento bilanciato (default)
 * - verbose: massimo dettaglio visivo
 */
export type UiInvasivenessLevel = "minimal" | "standard" | "verbose";

/**
 * Opzioni per il separatore delle migliaia nei numeri formattati.
 * - "none": nessun separatore
 * - "space": spazio (standard scientifico)
 * - "dot": punto alto (⋅, U+22C5) - default precedente
 * - "comma": virgola (USA, UK)
 * - "apostrophe": apostrofo (Svizzera)
 * - "narrowNoBreakSpace": narrow no-break space (U+202F)
 */
export type ThousandsSeparator = "none" | "space" | "dot" | "comma" | "apostrophe" | "narrowNoBreakSpace";

export type CppCodeLensConfig = {
  enabled: boolean;
  maxItemsPerViewport: number;
  /** @deprecated Use maxItemsPerViewport. Kept for existing state/test objects. */
  maxItemsPerFile?: number;
  showAmbiguity: boolean;
  showCastOverflow: boolean;
  showMismatch: boolean;
  showOpenFormula: boolean;
  showResolvedValue: boolean;
  showExpandedPreview: boolean;
};

export type CppHoverConfig = {
  enabled: boolean;
  maxConditionalDefinitions: number;
  maxInDocumentDefinitions: number;
  showConditionalDefinitions: boolean;
  showInDocumentDefinitions: boolean;
  showCastOverflow: boolean;
  showInheritedAmbiguity: boolean;
  showFormulaSection: boolean;
  showKnownValue: boolean;
  showLiveRegisterDecoder: boolean;
};

export type InlineCodeLensConfig = {
  enabled: boolean;
  maxItemsPerViewport: number;
  /** @deprecated Use maxItemsPerViewport. Kept for existing state/test objects. */
  maxItemsPerFile?: number;
};

export type InlineHoverConfig = {
  enabled: boolean;
  showDimension: boolean;
  showWarnings: boolean;
  showErrors: boolean;
};

export type InlineDiagnosticsConfig = {
  level: InlineCalcDiagnosticsLevel;
};

/**
 * Configurazione dell'estensione CalcDocs.
 * Rappresenta tutte le impostazioni modificabili dall'utente.
 */
export type CalcDocsConfig = {
  /** True se l'estensione è abilitata, false se disabilitata */
  enabled: boolean;
  /** Intervallo di scansione in secondi (0 = disabilitato) */
  scanInterval: number;
  /** Lista di directory da ignorare durante la scansione */
  ignoredDirs: string[];
  /** True se i provider C/C++ sono abilitati */
  enableCppProviders: boolean;
  /** Modalità di visualizzazione dello stato risorse */
  resourceStatusMode: ResourceStatusMode;
  /** Soglia CPU percentuale per il warning */
  resourceCpuThreshold: number;
  /** Separatore delle migliaia per i numeri formattati */
  thousandsSeparator: ThousandsSeparator;
  /** livello di log nell'output console */
  internalDebugMode: LogLevel;
  /** Numero massimo di file C/C++ preprocessati mantenuti in cache LRU */
  cppCacheMaxEntries: number;
  /** Abilita integrazione clangd come backend LSP opzionale */
  useClangd: boolean;
  /** Abilita/disabilita i CodeLens per inline calc nei commenti */
  inlineCalcEnableCodeLens: boolean;
  /** Abilita/disabilita i ghost value */
  inlineGhostEnable: boolean;
  /** Abilita/disabilita l'hover per inline calc nei commenti */
  inlineCalcEnableHover: boolean;
  /** Livello di severità per la diagnostica inline calc */
  inlineCalcDiagnosticsLevel: InlineCalcDiagnosticsLevel;
  /** Profilo globale di invasività UI */
  uiInvasiveness: UiInvasivenessLevel;
  /** Path for generated C header with formula macros */
  formulaHeader: {
    outputPath: string;
    includeResolvedValues: boolean;
  };
  /** Configurazione CodeLens C/C++ */
  cppCodeLens: CppCodeLensConfig;
  /** Configurazione Hover C/C++ */
  cppHover: CppHoverConfig;
  /** Configurazione Inline CodeLens */
  inlineCodeLens: InlineCodeLensConfig;
  /** Configurazione Inline Hover */
  inlineHover: InlineHoverConfig;
  /** Configurazione diagnostica Inline */
  inlineDiagnostics: InlineDiagnosticsConfig;
};

type UiProfileDefaults = {
  cppCodeLens: Omit<CppCodeLensConfig, "enabled">;
  cppHover: Omit<CppHoverConfig, "enabled">;
  inlineCodeLens: Omit<InlineCodeLensConfig, "enabled">;
  inlineHover: Omit<InlineHoverConfig, "enabled">;
};

const DEFAULT_UI_PROFILE: UiInvasivenessLevel = "standard";

const UI_PROFILE_DEFAULTS: Record<UiInvasivenessLevel, UiProfileDefaults> = {
  minimal: {
    cppCodeLens: {
      maxItemsPerViewport: 12,
      showAmbiguity: true,
      showCastOverflow: true,
      showMismatch: true,
      showOpenFormula: false,
      showResolvedValue: true,
      showExpandedPreview: false,
    },
    cppHover: {
      maxConditionalDefinitions: 3,
      maxInDocumentDefinitions: 3,
      showConditionalDefinitions: true,
      showInDocumentDefinitions: false,
      showCastOverflow: true,
      showInheritedAmbiguity: true,
      showFormulaSection: false,
      showKnownValue: true,
      showLiveRegisterDecoder: true,
    },
    inlineCodeLens: {
      maxItemsPerViewport: 8,
    },
    inlineHover: {
      showDimension: false,
      showWarnings: true,
      showErrors: true,
    },
  },
  standard: {
    cppCodeLens: {
      maxItemsPerViewport: 40,
      showAmbiguity: true,
      showCastOverflow: true,
      showMismatch: true,
      showOpenFormula: true,
      showResolvedValue: true,
      showExpandedPreview: true,
    },
    cppHover: {
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
      maxItemsPerViewport: 30,
    },
    inlineHover: {
      showDimension: true,
      showWarnings: true,
      showErrors: true,
    },
  },
  verbose: {
    cppCodeLens: {
      maxItemsPerViewport: 150,
      showAmbiguity: true,
      showCastOverflow: true,
      showMismatch: true,
      showOpenFormula: true,
      showResolvedValue: true,
      showExpandedPreview: true,
    },
    cppHover: {
      maxConditionalDefinitions: 20,
      maxInDocumentDefinitions: 20,
      showConditionalDefinitions: true,
      showInDocumentDefinitions: true,
      showCastOverflow: true,
      showInheritedAmbiguity: true,
      showFormulaSection: true,
      showKnownValue: true,
      showLiveRegisterDecoder: true,
    },
    inlineCodeLens: {
      maxItemsPerViewport: 100,
    },
    inlineHover: {
      showDimension: true,
      showWarnings: true,
      showErrors: true,
    },
  },
};

function normalizeUiInvasiveness(value: string | undefined): UiInvasivenessLevel {
  return value === "minimal" || value === "verbose" || value === "standard"
    ? value
    : DEFAULT_UI_PROFILE;
}

function normalizeInlineDiagnosticsLevel(value: string): InlineCalcDiagnosticsLevel {
  return value === "off" ||
    value === "errors" ||
    value === "warnings" ||
    value === "info"
    ? value
    : "warnings";
}

function normalizePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

/** Ritorna la configurazione di default quando vscode non è disponibile (es. test) */
function getDefaultConfig(): CalcDocsConfig {
  return {
    enabled: true,
    scanInterval: 0,
    ignoredDirs: [],
    enableCppProviders: true,
    resourceStatusMode: "always",
    resourceCpuThreshold: 70,
    thousandsSeparator: "space",
    internalDebugMode: "off" as LogLevel,
    cppCacheMaxEntries: 24,
    useClangd: true,
    inlineGhostEnable: true,
    inlineCalcEnableCodeLens: true,
    inlineCalcEnableHover: true,
    inlineCalcDiagnosticsLevel: "warnings",
    uiInvasiveness: "standard",
    formulaHeader: { outputPath: "macro_generate.h", includeResolvedValues: true },
    cppCodeLens: { enabled: true, maxItemsPerViewport: 40, showAmbiguity: true, showCastOverflow: true, showMismatch: true, showOpenFormula: true, showResolvedValue: true, showExpandedPreview: true },
    cppHover: { enabled: true, maxConditionalDefinitions: 8, maxInDocumentDefinitions: 6, showConditionalDefinitions: true, showInDocumentDefinitions: true, showCastOverflow: true, showInheritedAmbiguity: true, showFormulaSection: true, showKnownValue: true, showLiveRegisterDecoder: true },
    inlineCodeLens: { enabled: true, maxItemsPerViewport: 30 },
    inlineHover: { enabled: true, showDimension: true, showWarnings: true, showErrors: true },
    inlineDiagnostics: { level: "warnings" },
  };
}

/**
 * Legge le impostazioni dell'estensione da "calcdocs.*" e normalizza i valori di default.
 * 
 * @returns Oggetto di configurazione con i valori attuali
 */
export function getConfig(): CalcDocsConfig {
  // Quando vscode non è disponibile (es. test), restituisci configurazione di default
  const v = getVscode();
  if (!v || !v.workspace) {
    return getDefaultConfig();
  }
  const cfg = v.workspace.getConfiguration("calcdocs");
  
  // Leggi l'intervallo di scansione
  const scanInterval = Number(cfg.get<number>("scanInterval", 0));
  
  // Leggi la modalità di visualizzazione risorse
  const resourceStatusModeValue = cfg.get<string>("resourceStatusMode", "always");
  
  // Leggi la soglia CPU
  const rawCpuThreshold = Number(cfg.get<number>("resourceCpuThreshold", 70));

  // Normalizza la modalità risorse
  const resourceStatusMode: ResourceStatusMode =
    resourceStatusModeValue === "aboveCpuThreshold"
      ? "aboveCpuThreshold"
      : "always";
  
  // Normalizza la soglia CPU (tra 0 e 100)
  const resourceCpuThreshold = Number.isFinite(rawCpuThreshold)
    ? Math.min(100, Math.max(0, rawCpuThreshold))
    : 70;

  // Leggi il separatore delle migliaia
  const thousandsSeparatorValue = cfg.get<string>("thousandsSeparator", "space");
  const thousandsSeparator: ThousandsSeparator = 
    ["none", "space", "dot", "comma", "apostrophe", "narrowNoBreakSpace"].includes(thousandsSeparatorValue)
      ? thousandsSeparatorValue as ThousandsSeparator
      : "space";

  // Leggi il livello di log
  const internalDebugModeValue = cfg.get<string>("internalDebugMode", "");
  const internalDebugMode: LogLevel = internalDebugModeValue as LogLevel;
  const rawCppCacheMaxEntries = Number(cfg.get<number>("cppCacheMaxEntries", 24));
  const cppCacheMaxEntries = Number.isFinite(rawCppCacheMaxEntries)
    ? Math.max(1, Math.floor(rawCppCacheMaxEntries))
    : 24;

  const uiInvasiveness = normalizeUiInvasiveness(
    cfg.get<string>("ui.invasiveness", DEFAULT_UI_PROFILE)
  );
  const uiDefaults = UI_PROFILE_DEFAULTS[uiInvasiveness];

  const formulaHeader = {
    outputPath: cfg.get<string>("formulaHeader.outputPath", "macro_generate.h"),
    includeResolvedValues: cfg.get<boolean>("formulaHeader.includeResolvedValues", true)
  };

  const cppCodeLensEnabled = cfg.get<boolean>("cpp.codeLens.enabled", true);
  const cppCodeLensMaxItemsPerViewport = normalizePositiveInt(
    Number(
      cfg.get<number>(
        "cpp.codeLens.maxItemsPerViewport",
        cfg.get<number>(
          "cpp.codeLens.maxItemsPerFile",
          uiDefaults.cppCodeLens.maxItemsPerViewport
        )
      )
    ),
    uiDefaults.cppCodeLens.maxItemsPerViewport
  );
  const cppCodeLens: CppCodeLensConfig = {
    enabled: cppCodeLensEnabled,
    maxItemsPerViewport: cppCodeLensMaxItemsPerViewport,
    maxItemsPerFile: cppCodeLensMaxItemsPerViewport,
    showAmbiguity: cfg.get<boolean>(
      "cpp.codeLens.showAmbiguity",
      uiDefaults.cppCodeLens.showAmbiguity
    ),
    showCastOverflow: cfg.get<boolean>(
      "cpp.codeLens.showCastOverflow",
      uiDefaults.cppCodeLens.showCastOverflow
    ),
    showMismatch: cfg.get<boolean>(
      "cpp.codeLens.showMismatch",
      uiDefaults.cppCodeLens.showMismatch
    ),
    showOpenFormula: cfg.get<boolean>(
      "cpp.codeLens.showOpenFormula",
      uiDefaults.cppCodeLens.showOpenFormula
    ),
    showResolvedValue: cfg.get<boolean>(
      "cpp.codeLens.showResolvedValue",
      uiDefaults.cppCodeLens.showResolvedValue
    ),
    showExpandedPreview: cfg.get<boolean>(
      "cpp.codeLens.showExpandedPreview",
      uiDefaults.cppCodeLens.showExpandedPreview
    ),
  };

  const cppHoverEnabled = cfg.get<boolean>("cpp.hover.enabled", true);
  const cppHover: CppHoverConfig = {
    enabled: cppHoverEnabled,
    maxConditionalDefinitions: normalizePositiveInt(
      Number(
        cfg.get<number>(
          "cpp.hover.maxConditionalDefinitions",
          uiDefaults.cppHover.maxConditionalDefinitions
        )
      ),
      uiDefaults.cppHover.maxConditionalDefinitions
    ),
    maxInDocumentDefinitions: normalizePositiveInt(
      Number(
        cfg.get<number>(
          "cpp.hover.maxInDocumentDefinitions",
          uiDefaults.cppHover.maxInDocumentDefinitions
        )
      ),
      uiDefaults.cppHover.maxInDocumentDefinitions
    ),
    showConditionalDefinitions: cfg.get<boolean>(
      "cpp.hover.showConditionalDefinitions",
      uiDefaults.cppHover.showConditionalDefinitions
    ),
    showInDocumentDefinitions: cfg.get<boolean>(
      "cpp.hover.showInDocumentDefinitions",
      uiDefaults.cppHover.showInDocumentDefinitions
    ),
    showCastOverflow: cfg.get<boolean>(
      "cpp.hover.showCastOverflow",
      uiDefaults.cppHover.showCastOverflow
    ),
    showInheritedAmbiguity: cfg.get<boolean>(
      "cpp.hover.showInheritedAmbiguity",
      uiDefaults.cppHover.showInheritedAmbiguity
    ),
    showFormulaSection: cfg.get<boolean>(
      "cpp.hover.showFormulaSection",
      uiDefaults.cppHover.showFormulaSection
    ),
    showKnownValue: cfg.get<boolean>(
      "cpp.hover.showKnownValue",
      uiDefaults.cppHover.showKnownValue
    ),
    showLiveRegisterDecoder: cfg.get<boolean>(
      "cpp.hover.showLiveRegisterDecoder",
      uiDefaults.cppHover.showLiveRegisterDecoder
    ),
  };

  const inlineCodeLensEnabled = cfg.get<boolean>(
    "inline.codeLens.enabled",
    cfg.get<boolean>("inlineCalc.enableCodeLens", true)
  );
  const inlineCodeLensMaxItemsPerViewport = normalizePositiveInt(
      Number(
      cfg.get<number>(
        "inline.codeLens.maxItemsPerViewport",
        cfg.get<number>(
          "inline.codeLens.maxItemsPerFile",
          uiDefaults.inlineCodeLens.maxItemsPerViewport
        )
        )
      ),
    uiDefaults.inlineCodeLens.maxItemsPerViewport
  );
  const inlineCodeLens: InlineCodeLensConfig = {
    enabled: inlineCodeLensEnabled,
    maxItemsPerViewport: inlineCodeLensMaxItemsPerViewport,
    maxItemsPerFile: inlineCodeLensMaxItemsPerViewport,
  };

  const inlineHoverEnabled = cfg.get<boolean>(
    "inline.hover.enabled",
    cfg.get<boolean>("inlineCalc.enableHover", true)
  );
  const inlineHover: InlineHoverConfig = {
    enabled: inlineHoverEnabled,
    showDimension: cfg.get<boolean>(
      "inline.hover.showDimension",
      uiDefaults.inlineHover.showDimension
    ),
    showWarnings: cfg.get<boolean>(
      "inline.hover.showWarnings",
      uiDefaults.inlineHover.showWarnings
    ),
    showErrors: cfg.get<boolean>(
      "inline.hover.showErrors",
      uiDefaults.inlineHover.showErrors
    ),
  };

  const inlineDiagnosticsLevelValue = cfg.get<string>(
    "inline.diagnostics.level",
    cfg.get<string>("inlineCalc.diagnosticsLevel", "warnings")
  );
  const inlineDiagnostics: InlineDiagnosticsConfig = {
    level: normalizeInlineDiagnosticsLevel(inlineDiagnosticsLevelValue),
  };

  // Backward-compatible aliases consumed by existing code paths.
  const inlineGhostEnable = cfg.get<boolean>(
    "inline.ghost.enabled",
    cfg.get<boolean>("inlineGhostEnabled", true)
  );
  const inlineCalcEnableCodeLens = inlineCodeLens.enabled;
  const inlineCalcEnableHover = inlineHover.enabled;
  const inlineCalcDiagnosticsLevel = inlineDiagnostics.level;

  return {
    enabled: cfg.get<boolean>("enabled", true),
    scanInterval:
      Number.isFinite(scanInterval) && scanInterval >= 0 ? scanInterval : 0,
    ignoredDirs: cfg.get<string[]>("ignoredDirs", []),
    enableCppProviders: cfg.get<boolean>("enableCppProviders", true),
    resourceStatusMode,
    resourceCpuThreshold,
    thousandsSeparator,
    internalDebugMode,
    cppCacheMaxEntries,
    useClangd: cfg.get<boolean>("useClangd", true),
    inlineGhostEnable,
    inlineCalcEnableCodeLens,
    inlineCalcEnableHover,
    inlineCalcDiagnosticsLevel,
    uiInvasiveness,
    formulaHeader,
    cppCodeLens,
    cppHover,
    inlineCodeLens,
    inlineHover,
    inlineDiagnostics,
  };
}

/**
 * Ricostruisce il set delle directory ignorate all'interno dello stato condiviso
 * dalla configurazione corrente.
 * 
 * @param state - Stato corrente dell'estensione
 * @param config - Configurazione da utilizzare (default: getConfig())
 */
export function refreshIgnoredDirs(
  state: CalcDocsState,
  config: CalcDocsConfig = getConfig()
): void {
  state.ignoredDirs = new Set(config.ignoredDirs);
}

/**
 * Normalizza un percorso filesystem per il confronto.
 * Converte backslash in slash, rimuove slash doppi e converte in minuscolo.
 * 
 * @param value - Percorso da normalizzare
 * @returns Percorso normalizzato
 */
function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

/**
 * Rimuove gli slash iniziali e finali da un percorso.
 * 
 * @param value - Percorso da trimmmare
 * @returns Percorso senza slash iniziali/finali
 */
function trimSlashes(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Rimuove il prefisso del drive da un percorso Windows.
 * Esempio: "C:\project" -> "\project"
 * 
 * @param value - Percorso con drive
 * @returns Percorso senza drive
 */
function stripDrivePrefix(value: string): string {
  return value.replace(/^[a-z]:/i, "");
}

/**
 * Escape dei caratteri speciali regex in una stringa.
 * 
 * @param value - Stringa da escapare
 * @returns Stringa con caratteri speciali escapati
 */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${()|[\]\\]/g, "\\$&");
}

/**
 * Converte un pattern di segmento glob (senza slash) in regex.
 * Supporta * (qualunque cosa) e ? (un carattere).
 * 
 * @param segmentPattern - Pattern del segmento (es. "build" o "Debug*")
 * @returns Regex compilata per il match
 */
function segmentGlobToRegex(segmentPattern: string): RegExp {
  let regex = "^";

  for (let i = 0; i < segmentPattern.length; i += 1) {
    const char = segmentPattern[i];

    if (char === "*") {
      regex += "[^/]*";
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    regex += escapeRegexLiteral(char);
  }

  regex += "$";
  return new RegExp(regex);
}

/**
 * Converte un pattern di percorso glob in regex.
 * Supporta * (qualunque cosa), ** (ricorsivo) e ? (un carattere).
 * 
 * @param pathPattern - Pattern del percorso (es. "**{barra}temp{barra}**")
 * @returns Regex compilata per il match
 */
function pathGlobToRegex(pathPattern: string): RegExp {
  let regex = "^";

  for (let i = 0; i < pathPattern.length; i += 1) {
    const char = pathPattern[i];

    if (char === "*") {
      const hasDoubleStar = i + 1 < pathPattern.length && pathPattern[i + 1] === "*";
      if (hasDoubleStar) {
        regex += ".*";
        i += 1;
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    regex += escapeRegexLiteral(char);
  }

  regex += "$";
  return new RegExp(regex);
}

/**
 * Determina se un pattern contiene slash, indicando un pattern di percorso.
 * 
 * @param entry - Pattern da controllare
 * @returns True se contiene slash
 */
function isPathPattern(entry: string): boolean {
  return entry.includes("/");
}

/**
 * Verifica se un percorso normalizzato corrisponde a una entry di ignore.
 * 
 * @param normalizedPath - Percorso normalizzato da controllare
 * @param rawEntry - Entry di ignore (può contenere wildcards)
 * @returns True se il percorso corrisponde all'entry
 */
function matchesIgnoredEntry(normalizedPath: string, rawEntry: string): boolean {
  const normalizedEntry = trimSlashes(normalizePathForMatch(rawEntry));
  if (!normalizedEntry) {
    return false;
  }

  const pathNoDrive = trimSlashes(stripDrivePrefix(normalizedPath));
  if (!pathNoDrive) {
    return false;
  }

  // Se non è un pattern di percorso, matcha solo il segmento finale
  if (!isPathPattern(normalizedEntry)) {
    const segmentRegex = segmentGlobToRegex(normalizedEntry);
    const segments = pathNoDrive.split("/").filter((segment) => segment.length > 0);
    return segments.some((segment) => segmentRegex.test(segment));
  }

  // Pattern di percorso completo
  const pathRegex = pathGlobToRegex(normalizedEntry);
  return pathRegex.test(pathNoDrive) || pathRegex.test(`${pathNoDrive}/`);
}

/**
 * Verifica se un percorso filesystem corrisponde a una delle regole di directory ignorate.
 * Supporta wildcards glob:
 * - "build"      -> qualsiasi cartella chiamata "build"
 * - "Debug*"     -> cartelle con prefisso "Debug"
 * - "**{barra}temp{barra}**" -> qualsiasi percorso contenente "/temp/"
 * 
 * @param state - Stato corrente dell'estensione
 * @param fsPath - Percorso filesystem assoluto da controllare
 * @returns True se il percorso deve essere ignorato
 */
export function isIgnoredFsPath(state: CalcDocsState, fsPath: string): boolean {
  const normalizedPath = normalizePathForMatch(fsPath);

  for (const rawEntry of state.ignoredDirs) {
    if (matchesIgnoredEntry(normalizedPath, rawEntry)) {
      return true;
    }
  }

  return false;
}

/**
 * Verifica se un URI corrisponde a una delle regole di directory ignorate.
 * 
 * @param state - Stato corrente dell'estensione
 * @param uri - URI da controllare
 * @returns True se l'URI deve essere ignorato
 */
export function isIgnoredUri(state: CalcDocsState, uri: any): boolean {
  // Usiamo any qui perché vscode.Uri non è disponibile quando getVscode() restituisce undefined
  // Questo metodo è chiamato solo a runtime dentro VS Code, quindi uri è sempre valido
  return isIgnoredFsPath(state, uri.fsPath);
}

/**
 * Converte l'opzione del separatore delle migliaia nel carattere effettivo.
 * 
 * @param separator - Opzione del separatore
 * @returns Il carattere separatore corrispondente
 */
export function getThousandsSeparatorChar(separator: ThousandsSeparator): string {
  switch (separator) {
    case "none":
      return "";
    case "space":
      return " ";
    case "dot":
      return "⋅"; // U+22C5
    case "comma":
      return ",";
    case "apostrophe":
      return "'";
    case "narrowNoBreakSpace":
      return "\u202F"; // Narrow No-Break Space
    default:
      return " ";
  }
}
