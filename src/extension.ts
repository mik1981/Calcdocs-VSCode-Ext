import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

import { registerCommands } from "./commands/commands";
import {
  createClangdService,
  reconfigureClangdService,
} from "./clangd/clangdFactory";
import { ClangdStatus } from "./clangd/ClangdClient";
import { ClangdService } from "./clangd/ClangdService";
import { runAnalysis, runActiveCppFileAnalysis } from "./core/analysis";
import { flushPendingMegaContentDiskWrites } from "./core/cppParser";
import { createLatestWinsGuard, type LatestWinsToken } from "./utils/latestWins";
import { runScopedYamlAnalysis } from "./core/scopedYamlAnalysis";
import { ensureConfigVarsLoaded } from "./core/scopedConfigVars";
import { isFormulaYamlFileName } from "./core/formulaYaml";
import {
  clearInlineCalcDiagnostics,
  refreshInlineCalcDiagnosticsForDocument,
  refreshInlineCalcDiagnosticsForVisibleEditors,
} from "./core/inlineCalcDiagnostics";
import { type CalcDocsConfig, getConfig } from "./core/config";
import { clearComputedState, createCalcDocsState, clearDiagnostics } from "./core/state";

import { createColoredOutput } from "./utils/output";
import { localize } from "./utils/localize";
import { ExtensionResourceMonitor, type ExtensionResourceSnapshot } from "./infra/resourceMonitor";
import { AnalysisScheduler } from "./infra/watchers";
import {
  CppValueCodeLensProvider,
  registerCppCodeLensProvider,
} from "./providers/codeLensProvider";
import {
  InlineCalcCodeLensProvider,
  registerInlineCalcCodeLensProvider,
} from "./providers/inlineCalcCodeLensProvider";
import { registerInlineCalcHoverProvider } from "./providers/inlineCalcHoverProvider";
import { registerYamlHoverProvider } from "./providers/yamlHoverProvider";
import { registerDefinitionProviders } from "./providers/definitionProvider";
import { registerCppHoverProvider } from "./providers/hoverProvider";
import { registerHybridHoverProvider } from "./hover/HoverProvider";
import { DiagnosticsProvider } from "./diagnostics/DiagnosticsProvider";
import { InlineCalcResultsViewProvider } from "./ui/inlineCalcResultsView";
import {
  createRuntimeStatusBar,
  updateRuntimeStatusBar,
} from "./ui/statusBar";
import { runProgressiveAnalysis, type ProgressiveAnalysisNotice } from "./utils/progressiveAnalysis";
import { ClangdSymbolProvider } from "./symbols/ClangdSymbolProvider";
import { HybridSymbolProvider } from "./symbols/HybridSymbolProvider";
import { LegacyParserProvider } from "./symbols/LegacyParserProvider";
import { GhostValueProvider } from "./core/ghostValues";
import { FormulaOutlineProvider } from "./formulaOutline/formulaOutlineProvider";
import { FormulaRegistry } from "./formulaOutline/formulaRegistry";
import { registerFormulaCommands } from "./formulaOutline/commands";
import {
  FormulaViewMode,
  FormulaSortOrder,
} from "./ui/formulaViewTypes";
import { registerFormulaOutlineHoverProvider } from "./formulaOutline/hoverProvider";
import { invalidatePriorityCache } from "./core/ghostPolicy";
import { GuideWebviewProvider } from "./ui/guideWebviewProvider";
import { registerInspectionFeatures } from "./inspection/formulaInspector";

import { initGuideEngineClient } from "./ui/guideEngineClient";


function isCppFileEditor(
  editor: vscode.TextEditor | undefined
): editor is vscode.TextEditor {
  if (!editor) {
    return false;
  }

  const languageId = editor.document.languageId;
  if (languageId !== "c" && languageId !== "cpp") {
    return false;
  }

  return editor.document.uri.scheme === "file";
}

function applyConfigToState(state: ReturnType<typeof createCalcDocsState>, config: CalcDocsConfig): void {
  state.enabled = config.enabled;
  state.inlineCalcEnableCodeLens = config.inlineCalcEnableCodeLens;
  state.inlineCalcEnableHover = config.inlineCalcEnableHover;
  state.inlineCalcDiagnosticsLevel = config.inlineCalcDiagnosticsLevel;
  state.inlineGhostEnabled = config.inlineGhostEnable;
  state.uiInvasiveness = config.uiInvasiveness;
  state.cppCodeLens = { ...config.cppCodeLens };
  state.cppHover = { ...config.cppHover };
  state.inlineCodeLens = { ...config.inlineCodeLens };
  state.inlineHover = { ...config.inlineHover };
  state.megaBudgetOverrides = {
    maxChars: config.megaContentMaxCharsPerFile,
    maxTimeMs: config.megaContentMaxTimeMsPerFile,
    maxDepth: config.megaContentMaxIncludeDepth,
  };
}

/**
 * Re-reads calcdocs.* settings and re-applies them to every config-driven
 * piece of the running extension: state flags, the analysis scheduler's
 * watchers/periodic timer, and the resource monitor's thresholds.
 *
 * This is the same "settings changed, react to it" recipe used by the
 * onDidChangeConfiguration handler in activate() and by "Restart CalcDocs"
 * (see commands.ts's reapplyConfig callback) — extracted once so the two
 * can't quietly drift apart from each other. Deliberately leaves clangd
 * reconfiguration and cache invalidation to their own call sites: this
 * function's only job is "make runtime config match calcdocs.* settings",
 * nothing more.
 */
function reapplyRuntimeConfig(
  context: vscode.ExtensionContext,
  state: ReturnType<typeof createCalcDocsState>
): CalcDocsConfig {
  const nextConfig = getConfig();
  applyConfigToState(state, nextConfig);
  scheduler?.applyConfiguration(context, nextConfig);
  resourceMonitor?.applyConfiguration({
    mode: nextConfig.resourceStatusMode,
    cpuThreshold: nextConfig.resourceCpuThreshold,
  });
  return nextConfig;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function handleActivationError(error: unknown): void {
  const message = getErrorMessage(error);
  coloredOutput?.error(`[activate] errore inatteso: ${message}`);
  vscode.window.showErrorMessage(`CalcDocs: errore di attivazione. ${message}`);
}

/**
 * Canale di output dell'estensione per messaggi di log e diagnostica.
 * Utilizzato per scrivere messaggi nella panel "CalcDocs" di VSCode.
 */
let outputChannel: vscode.OutputChannel | undefined;

/**
 * Wrapper ColoredOutput per supportare i colori nell'output.
 */
let coloredOutput: ReturnType<typeof createColoredOutput> | undefined;

/**
 * Pianificatore per l'analisi automatica del workspace.
 * Gestisce i watcher sui file e le esecuzioni periodiche/differite dell'analisi.
 */
let scheduler: AnalysisScheduler | undefined;

/**
 * Elemento della status bar che mostra lo stato runtime dell'estensione
 * (abilitata/disabilitata) e le statistiche di utilizzo risorse.
 */
let runtimeStatusBar: vscode.StatusBarItem | undefined;

/**
 * Monitor per le risorse di sistema (CPU e RAM) utilizzate dall'estensione.
 * Raccoglie periodicamente statistiche sull'utilizzo della CPU e della memoria.
 */
let resourceMonitor: ExtensionResourceMonitor | undefined;
let clangdService: ClangdService | undefined;


function registerGuideCommands(context: vscode.ExtensionContext): void {
  // Comando per aprire la guida interattiva (per .c files e formula*.yaml)
  context.subscriptions.push(
    vscode.commands.registerCommand("calcdocs.openGuide", async () => {
      const editor = vscode.window.activeTextEditor;
      const fileName = editor?.document.fileName.toLowerCase() ?? "";
      
      // Per file .c/.cpp/.h: apre la guida inline calc
      if (editor && /\.(c|cc|cpp|cxx|h|hpp|hxx)$/.test(fileName)) {
        await vscode.commands.executeCommand("calcdocs.inlineCalc.openGuide");
        return;
      }
      
      // Per file formulas*.yaml: apre la guida interattiva completa
      if (editor && /formula.*\.(yaml|yml)$/.test(fileName)) {
        GuideWebviewProvider.openAsPanel(context);
        return;
      }
      
      // Fallback: apre la guida interattiva come pannello
      GuideWebviewProvider.openAsPanel(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("calcdocs.openGuideYaml", async () => {
      const panel = vscode.window.createWebviewPanel(
        "calcdocsYamlGuide",
        "CalcDocs YAML Guide",
        vscode.ViewColumn.Beside,
        {
          enableFindWidget: true,
          retainContextWhenHidden: true,
        }
      );

      const locale = vscode.env.language.toLowerCase();
      const lang = locale.split("-")[0];

      const tryFiles = [
        `formula-yaml-guide_${lang}.html`,
        "formula-yaml-guide_en.html",
      ];

      let htmlContent: string | undefined;

      for (const fileName of tryFiles) {
        const htmlUri = vscode.Uri.joinPath(
          context.extensionUri,
          "resources",
          fileName
        );

        try {
          htmlContent = await fsp.readFile(htmlUri.fsPath, "utf8");
          break;
        } catch {
          // file non esiste → continua
        }
      }

      panel.webview.html =
        htmlContent ??
        `<!doctype html>
<html><body><h2>CalcDocs YAML Guide</h2><p>Guide file not found.</p></body></html>`;
    })
  );

  // Imposta il context key per lo sdoppiamento dell'icona
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        vscode.commands.executeCommand("setContext", "calcdocs.formulaFileNames", false);
        return;
      }
      const fileName = editor.document.fileName.toLowerCase();
      const isFormulaYaml = /formula.*\.(yaml|yml)$/.test(fileName);
      vscode.commands.executeCommand("setContext", "calcdocs.formulaFileNames", isFormulaYaml);
      vscode.commands.executeCommand("setContext", "calcdocs.cFileActive", /\.(c|cc|cpp|cxx|h|hpp|hxx)$/.test(fileName));
    })
  );
}


/**
 * Punto di ingresso principale dell'estensione VSCode.
 * Inizializza lo stato, i provider, i comandi, lo scheduler e la status bar.
 * 
 * @param context - Contesto dell'estensione VSCode contenente subscriptions e configurazione
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Crea il canale di output per i messaggi di log
  outputChannel = vscode.window.createOutputChannel("CalcDocs");
  context.subscriptions.push(outputChannel);
  
  // Crea il wrapper ColoredOutput per supportare i colori
  coloredOutput = createColoredOutput(outputChannel);
  coloredOutput.info(localize("output.activate"));

  // Ottiene la cartella root del workspace aperto
  let workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // Removed early return - allow activation without workspace for commands like openTestFolder
  // Will defer analysis/providers until workspace opens
  if (!workspaceRoot) {
    coloredOutput.warn(localize("output.noWorkspace"));
  }

  // Carica la configurazione dell'estensione
  let config = getConfig();

  // Crea lo stato iniziale dell'estensione per il workspace
  const state = createCalcDocsState(workspaceRoot || process.cwd(), coloredOutput); // Fallback to cwd if no workspace
  applyConfigToState(state, config);

  
  // Cache su disco per headerIndex (vedi core/analysis.ts): usiamo lo
  // storage privato dell'estensione, mai il workspace dell'utente.
  // storageUri e' specifico del workspace corrente (ripulito da VS Code se
  // il workspace viene rimosso); globalStorageUri e' il fallback quando
  // storageUri non e' disponibile (nessun workspace aperto).
  const cacheStorageUri = context.storageUri ?? context.globalStorageUri;
  state.headerIndexCachePath = vscode.Uri.joinPath(
    cacheStorageUri,
    "header-index-cache.json"
  ).fsPath;
  state.megaContentCacheDir = vscode.Uri.joinPath(
    cacheStorageUri,
    "mega-content-cache"
  ).fsPath;

  
  state.diagnostics = vscode.languages.createDiagnosticCollection("calcdocs");
  context.subscriptions.push(state.diagnostics);
  state.inlineCalcDiagnostics = vscode.languages.createDiagnosticCollection(
    "calcdocs-inline-calc"
  );
  context.subscriptions.push(state.inlineCalcDiagnostics);

  state.output.setLevel(config.internalDebugMode);

  // Crea gli elementi della status bar
  runtimeStatusBar = createRuntimeStatusBar(context);

  try {
    try {
      clangdService = await createClangdService(context, state.output, config.useClangd);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      state.output.warn(`[clangd] service initialization failed: ${message}`);
      // In caso di errore grave, il factory dovrebbe già aver fornito un fallback.
      clangdService = await createClangdService(context, state.output, false);
    }

    const clangdSymbolProvider = new ClangdSymbolProvider(clangdService);
  const legacySymbolProvider = new LegacyParserProvider(state);
  const hybridSymbolProvider = new HybridSymbolProvider(
    clangdService,
    clangdSymbolProvider,
    legacySymbolProvider
  );
  const diagnosticsProvider = new DiagnosticsProvider(state, clangdService);

  // Formula Outline - create first so it can be passed to inlineCalcResultsViewProvider
  const formulaRegistry = new FormulaRegistry();

  // Crea il provider per i CodeLens (valori delle formule C/C++)
  const codeLensProvider = new CppValueCodeLensProvider(state);
  const inlineCalcCodeLensProvider = new InlineCalcCodeLensProvider(state);
  const inlineCalcResultsViewProvider = new InlineCalcResultsViewProvider(state, formulaRegistry);

  // Crea il provider per i ghost values
  const ghostProvider = new GhostValueProvider(state);

  // Formula Outline
  const formulaOutlineProvider = new FormulaOutlineProvider(
    formulaRegistry,
    () => state.symbolValues,   // ← lazy getter: always reflects latest analysis
    () => state.symbolUnits,
    () => state.csvTables,
    () => state               // ← lazy getter for state (thousands separator config)
  );

  context.subscriptions.push(formulaOutlineProvider);
  context.subscriptions.push(formulaRegistry);
  registerFormulaCommands(context, formulaRegistry);

  // Register formula explorer view commands
  // Each command shows a quick pick menu when invoked without arguments
  // (which is the case when clicked from the view/title toolbar).
  context.subscriptions.push(
    vscode.commands.registerCommand("calcdocs.formulas.setViewMode", (...args: unknown[]) => {
      // If called with an argument (programmatic), use it directly
      if (args.length > 0 && typeof args[0] === "string") {
        const mode = args[0];
        if (mode === "flat") {
          inlineCalcResultsViewProvider.setViewMode(FormulaViewMode.Flat);
        } else if (mode === "dependencyGroups") {
          inlineCalcResultsViewProvider.setViewMode(FormulaViewMode.DependencyGroups);
        }
        return;
      }
      // Otherwise show quick pick (view/title toolbar click)
      const current = inlineCalcResultsViewProvider.viewMode;
      const items: vscode.QuickPickItem[] = [
        { label: "$(list-tree) Flat", description: current === FormulaViewMode.Flat ? "✓ current" : "", picked: current === FormulaViewMode.Flat },
        { label: "$(graph) Dependency Groups", description: current === FormulaViewMode.DependencyGroups ? "✓ current" : "", picked: current === FormulaViewMode.DependencyGroups },
      ];
      vscode.window.showQuickPick(items, { placeHolder: "Select formula view mode" }).then(selected => {
        if (!selected) return;
        if (selected.label.includes("Flat")) {
          inlineCalcResultsViewProvider.setViewMode(FormulaViewMode.Flat);
        } else {
          inlineCalcResultsViewProvider.setViewMode(FormulaViewMode.DependencyGroups);
        }
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("calcdocs.formulas.setSortOrder", (...args: unknown[]) => {
      if (args.length > 0 && typeof args[0] === "string") {
        const order = args[0];
        if (order === "alpha") {
          inlineCalcResultsViewProvider.setSortOrder(FormulaSortOrder.Alphabetical);
        } else if (order === "source") {
          inlineCalcResultsViewProvider.setSortOrder(FormulaSortOrder.Source);
        }
        return;
      }
      const current = inlineCalcResultsViewProvider.sortOrder;
      const items: vscode.QuickPickItem[] = [
        { label: "$(sort-precedence) Alphabetical", description: current === FormulaSortOrder.Alphabetical ? "✓ current" : "", picked: current === FormulaSortOrder.Alphabetical },
        { label: "$(list-tree) Source Order", description: current === FormulaSortOrder.Source ? "✓ current" : "", picked: current === FormulaSortOrder.Source },
      ];
      vscode.window.showQuickPick(items, { placeHolder: "Select formula sort order" }).then(selected => {
        if (!selected) return;
        if (selected.label.includes("Alphabetical")) {
          inlineCalcResultsViewProvider.setSortOrder(FormulaSortOrder.Alphabetical);
        } else {
          inlineCalcResultsViewProvider.setSortOrder(FormulaSortOrder.Source);
        }
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("calcdocs.formulas.setFilter", (...args: unknown[]) => {
      if (args.length > 0 && typeof args[0] === "string") {
        inlineCalcResultsViewProvider.setFilter(args[0]);
        return;
      }
      // Show input box for filter text
      const currentFilter = inlineCalcResultsViewProvider.filterText;
      vscode.window.showInputBox({
        placeHolder: "Filter formulas by name, expression, description, or unit…",
        prompt: "Type to filter formulas shown in the explorer",
        value: currentFilter || "",
      }).then(text => {
        if (text === undefined) return; 
        inlineCalcResultsViewProvider.setFilter(text || "");
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("calcdocs.formulas.clearFilter", () => {
      inlineCalcResultsViewProvider.clearFilter();
    })
  );

  // Pass formulaRegistry to commands

  context.subscriptions.push(
    vscode.window.createTreeView("calcdocs.inlineCalcResults", {
      treeDataProvider: inlineCalcResultsViewProvider,
      showCollapseAll: false,
    })
  );

  inlineCalcResultsViewProvider.setActiveEditor(vscode.window.activeTextEditor);

  // Snapshot iniziale delle risorse di sistema (for resource monitor)
  let lastResourceSnapshot: ExtensionResourceSnapshot = {
    cpuPercent: 0,
    memoryRssMb: process.memoryUsage().rss / (1024 * 1024),
    shouldShowStatus: true,
  };

  // Contatore (non booleano) perché più analisi possono sovrapporsi per
  // qualche istante (es. un full workspace scan in background mentre
  // l'utente ha appena salvato il file attivo): la status bar deve
  // restare "working" finché l'ULTIMA di queste non è terminata, non
  // finché la prima ritorna. beginAnalysisWork()/endAnalysisWork() sono
  // l'unico posto che tocca questo contatore: ogni punto di ingresso
  // dell'analisi (runAnalysisAndRefreshUi, lo scan di background) li
  // richiama in coppia invece di gestire un proprio stato "sto
  // lavorando" duplicato.
  let analysisBusyCount = 0;
  // Timestamp di quando il contatore è salito sopra zero l'ultima volta
  // (undefined quando è a zero). Usato dal watchdog nel polling del
  // resource monitor più sotto: se un singolo await nella catena di
  // analisi restasse sospeso per sempre (es. una chiamata LSP che non
  // risponde né risolve né rigetta - scenario più probabile su progetti
  // reali di grandi dimensioni, o sotto un debugger con un breakpoint
  // su "tutte le eccezioni" che congela l'intero extension host), il
  // finally che decrementa non scatterebbe mai e la status bar
  // resterebbe bloccata su "working" a tempo indeterminato anche se
  // tutte le analisi successive completano correttamente. Il watchdog
  // se ne accorge e si autocorregge invece di mentire per sempre
  // all'utente.
  let analysisBusySince: number | undefined;
  const STUCK_BUSY_THRESHOLD_MS = 30_000;

  function beginAnalysisWork(): void {
    analysisBusyCount += 1;
    if (analysisBusyCount === 1) {
      analysisBusySince = Date.now();
    }
    refreshRuntimeStatus();
  }

  function endAnalysisWork(): void {
    analysisBusyCount = Math.max(0, analysisBusyCount - 1);
    if (analysisBusyCount === 0) {
      analysisBusySince = undefined;
    }
    refreshRuntimeStatus();
  }

  // Messaggio della status bar per il fallback progressivo su progetti
  // enormi (vedi runProgressiveCppAnalysis più sotto). Deliberatamente
  // NON legato al contatore busy: un avviso "truncated" deve restare
  // visibile come stato stabile anche dopo che endAnalysisWork() ha
  // riportato il contatore a zero, non sparire nello stesso istante in
  // cui compare (vanificherebbe lo scopo di comunicare il motivo
  // dell'interruzione). Ogni nuova generazione di analisi lo azzera
  // esplicitamente all'inizio, e runProgressiveCppAnalysis lo re-imposta
  // solo se e quando serve davvero.
  let progressiveNotice: ProgressiveAnalysisNotice | undefined;

  function setProgressiveNotice(notice: ProgressiveAnalysisNotice | undefined): void {
    progressiveNotice = notice;
    refreshRuntimeStatus();
  }

  /**
   * Returns dynamic clangd status label based on live service status and active editor.
   */
  function getRuntimeBackendLabel(): string {
    if (!clangdService) {
      return "legacy";
    }

    const status = clangdService.getStatus();
    if (!status.available) {
      return "fallback";
    }

    if (status.indexing) {
      return "clangd idx…";
    }

    const activeEditor = vscode.window.activeTextEditor;
    const hasCppEditor = isCppFileEditor(activeEditor);

    if (!status.hasCompileCommands) {
      return hasCppEditor ? "clangd(no cmds)" : "clangd cfg?";
    }

    return hasCppEditor ? "clangd ✓" : "clangd ready";
  }

  /**
   * Aggiorna lo stato della status bar runtime (abilitazione e risorse).

   * Callback chiamato quando cambiano le risorse di sistema o lo stato di abilitazione.
   */
  const refreshRuntimeStatus = (): void => {
    if (!runtimeStatusBar) {
      return;
    }

    const runtimeBackendLabel = getRuntimeBackendLabel();

    updateRuntimeStatusBar(
      runtimeStatusBar,
      state.enabled,
      lastResourceSnapshot.cpuPercent,
      lastResourceSnapshot.memoryRssMb,
      config.resourceCpuThreshold,
      state.lastAnalysisStackUsage,
      runtimeBackendLabel,
      analysisBusyCount > 0,
      progressiveNotice
    );

    const shouldShow = !state.enabled || lastResourceSnapshot.shouldShowStatus;
    if (shouldShow) {
      runtimeStatusBar.show();
      return;
    }

    runtimeStatusBar.hide();
  };

  function refreshUi(
    state: ReturnType<typeof createCalcDocsState>,
    options: {
      editor?: vscode.TextEditor;
      refreshDiagnostics?: boolean;
    } = {}
  ): void {
    const { refreshDiagnostics = true } = options;
    // Fallback all'editor attivo quando il chiamante non ne passa uno
    // esplicito (es. il ramo "disabilitato" di runAnalysisAndRefreshUi
    // chiama refreshUi(state) senza editor): prima questo fallback
    // esisteva solo più sotto, per un altro scopo, e QUI sopra restava
    // `if (editor)` — false in quei casi — quindi ghostProvider.update()
    // non veniva mai chiamato per il file attivo. Risultato: disabilitare
    // CalcDocs (o i soli ghost value) non aveva effetto visibile finché
    // non si cambiava file attivo (quel trigger passa sempre un editor
    // esplicito). Ora l'editor attivo viene risolto una sola volta qui,
    // e usato ovunque in questa funzione.
    const activeEditor = options.editor ?? vscode.window.activeTextEditor;

    refreshRuntimeStatus();
    invalidatePriorityCache();

    codeLensProvider.refresh();
    inlineCalcCodeLensProvider.refresh();
    inlineCalcResultsViewProvider.refresh();

    if (refreshDiagnostics) {
      refreshInlineCalcDiagnosticsForVisibleEditors(state);
      diagnosticsProvider.mergeForVisibleEditors();
    }

    // Entrambi i provider decidono da soli se disegnare o pulire in base a
    // state.enabled/state.inlineGhostEnabled (vedi ghostValues.ts e
    // formulaOutlineProvider.ts) — prima qui c'era anche un controllo
    // state.enabled/inlineGhostEnabled lato chiamante che, quando falso,
    // saltava del tutto la chiamata: il provider non veniva MAI invocato
    // per pulire le decorazioni già disegnate in precedenza, che restavano
    // visibili a schermo anche dopo aver disabilitato CalcDocs o i soli
    // ghost values. Va sempre chiamato: decide lui cosa fare.
    if (activeEditor) {
      ghostProvider.update(activeEditor);
      formulaOutlineProvider.refreshDecorations();
    }

    const hasFormulas =
      state.formulaIndex.size > 0 || isActiveFormulaYamlWithEntries(activeEditor, state);
    void vscode.commands.executeCommand(
      "setContext",
      "calcdocs.hasFormulas",
      hasFormulas
    );

    const isYamlActive =
      !!activeEditor &&
      activeEditor.document.languageId === "yaml" &&
      activeEditor.document.fileName.includes("formula");
    void vscode.commands.executeCommand(
      "setContext",
      "calcdocs.mode",
      isYamlActive ? "yaml" : "inline"
    );
  }

  function isActiveFormulaYamlWithEntries(
    editor: vscode.TextEditor | undefined,
    state: ReturnType<typeof createCalcDocsState>
  ): boolean {
    if (!editor) {
      return false;
    }

    const file = editor.document.fileName.toLowerCase();
    const isYaml = file.endsWith(".yaml") || file.endsWith(".yml");
    if (!isYaml || !file.includes("formula")) {
      return false;
    }

    return state.formulaIndex.size > 0;
  }

  
  // La full workspace scan (formule non ancora indicizzate, nessun file
  // rilevante aperto) non deve mai bloccare né l'attivazione dell'estensione
  // né l'analisi del file attivo. Viene pianificata con un piccolo ritardo
  // (per dare priorità a un eventuale editor rilevante aperto nel frattempo)
  // ed eseguita una sola volta in background; al termine la UI viene
  // aggiornata per riflettere i dati nel frattempo diventati disponibili.
  let backgroundScanTimer: NodeJS.Timeout | undefined;
  let backgroundScanInFlight = false;
  context.subscriptions.push({
    dispose: () => {
      if (backgroundScanTimer) {
        clearTimeout(backgroundScanTimer);
        backgroundScanTimer = undefined;
      }
    },
  });

  function scheduleBackgroundFullScan(token: LatestWinsToken): void {
    if (backgroundScanInFlight || backgroundScanTimer) {
      return;
    }
    backgroundScanTimer = setTimeout(() => {
      backgroundScanTimer = undefined;
      void (async () => {
        // Se nel frattempo è arrivato un risultato utile (es. l'utente ha
        // aperto/salvato un file YAML di formule che ha già popolato
        // l'indice), la scansione completa non serve più: risparmiamo il
        // lavoro.
        if (state.hasFormulasFile || state.formulaIndex.size > 0) {
          return;
        }
        backgroundScanInFlight = true;
        beginAnalysisWork();
        try {
          await runAnalysis(state, clangdService, () => token.isCancelled());
          if (token.isStale()) {
            // Una richiesta più recente (es. un toggle enable/disable nel
            // frattempo) ha già preso il sopravvento: non tocchiamo la UI.
            return;
          }
          refreshUi(state, { editor: vscode.window.activeTextEditor });
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          state.output.warn(`[background full scan] errore inatteso: ${message}`);
          if (!token.isStale()) {
            refreshUi(state, { editor: vscode.window.activeTextEditor });
          }
        } finally {
          backgroundScanInFlight = false;
          endAnalysisWork();
        }
      })();
    }, 300);
  }

  // "Latest wins": se due chiamate a runAnalysisAndRefreshUi() sono in
  // volo contemporaneamente (es. toggle disable→enable in rapida
  // successione, o un secondo toggle prima che il primo abbia finito),
  // quella più vecchia potrebbe risolversi DOPO quella più recente e
  // sovrascriverne il risultato (ghost appena ripopolati che spariscono
  // di nuovo). Logica estratta in utils/latestWins.ts (testata in
  // isolamento, senza dipendenze da vscode).
  const analysisGuard = createLatestWinsGuard();

  /**
   * Analisi C/C++ del file attivo con fallback progressivo per progetti
   * così grandi da mettere in difficoltà anche clangd: dopo 5s senza che
   * l'analisi completa sia arrivata, mostra dei ghost value "best
   * effort" calcolati solo dal file attivo + i suoi #include diretti
   * (scope "shallow", niente clangd), poi continua ad aggiornare a
   * intervalli crescenti mentre l'analisi completa prosegue in
   * background. Se il tempo totale supera
   * config.largeProjectAnalysisTimeoutMs, rinuncia per questo giro e lo
   * comunica chiaramente nella status bar - non ha senso restare
   * "working" per minuti. Se l'analisi completa arriva comunque più
   * tardi in background, i risultati migliori vengono comunque
   * applicati appena pronti.
   *
   * Logica di race/checkpoint/troncamento estratta ed effettivamente
   * testata in utils/progressiveAnalysis.ts (con fake timer) — qui c'è
   * solo il collegamento a state/UI/status bar.
   */
  async function runProgressiveCppAnalysis(
    sourcePath: string,
    editor: vscode.TextEditor | undefined,
    token: LatestWinsToken
  ): Promise<void> {
    await runProgressiveAnalysis({
      runFull: () =>
        runActiveCppFileAnalysis(state, sourcePath, clangdService, "full", () =>
          token.isCancelled()
        ),
      runShallow: () =>
        runActiveCppFileAnalysis(state, sourcePath, clangdService, "shallow", () =>
          token.isCancelled()
        ),
      isStale: () => token.isStale(),
      cancel: () => token.cancel(),
      timeoutMs: config.largeProjectAnalysisTimeoutMs,
      onNotice: (notice) => {
        setProgressiveNotice(notice);
        refreshUi(state, { editor });
        if (notice.kind === "truncated") {
          state.output.warn(
            `[progressive] Analisi completa troncata (e fermata) dopo ${Math.round(notice.elapsedMs / 1000)}s su "${path.basename(sourcePath)}" (progetto molto grande) — mostrati solo i valori calcolabili dal file attivo e dai suoi #include diretti.`
          );
        }
      },
      onResolved: () => {
        setProgressiveNotice(undefined);
        refreshUi(state, { editor: vscode.window.activeTextEditor });
      },
    });
  }

  const runAnalysisAndRefreshUi = async (): Promise<void> => {
    const token = analysisGuard.start();
    beginAnalysisWork();
    setProgressiveNotice(undefined);

    try {
      if (!state.enabled) {
        clearComputedState(state);
        clearDiagnostics(state);
        clearInlineCalcDiagnostics(state);

        if (token.isStale()) return;
        refreshUi(state);
        return;
      }

      const activeEditor = vscode.window.activeTextEditor;
      const activeFsPath = activeEditor?.document.uri.fsPath;

      if (isCppFileEditor(activeEditor)) {
        // Active file + its resolved includes only - no workspace scan.
        // Progressive fallback kicks in on its own past 5s (see
        // runProgressiveCppAnalysis); identical single-await behavior
        // otherwise.
        await runProgressiveCppAnalysis(activeFsPath!, activeEditor, token);
        if (token.isStale()) return; // una richiesta più recente ha già preso il sopravvento
        // @config.<hint>.<var> inline-calc references explicitly name a
        // config.c/config.h file by convention - not something reached via
        // #include, so it needs its own (cached, filename-only) lookup.
        await ensureConfigVarsLoaded(state, () => token.isCancelled());
        if (token.isStale()) return; // una richiesta più recente ha già preso il sopravvento
      } else if (activeFsPath && isFormulaYamlFileName(activeFsPath)) {
        // Self-contained YAML -> zero C/C++ parsing. Otherwise, a targeted
        // lookup for only the missing symbols (see scopedYamlAnalysis.ts).
        await runScopedYamlAnalysis(state, activeFsPath, clangdService, () => token.isCancelled());
        if (token.isStale()) return; // una richiesta più recente ha già preso il sopravvento
      } else if (!state.hasFormulasFile && state.formulaIndex.size === 0) {
        scheduleBackgroundFullScan(token);
      }

      if (token.isStale()) return;
      refreshUi(state, { editor: activeEditor });
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      state.output.warn(`[runAnalysisAndRefreshUi] errore inatteso: ${message}`);
      // Anche in caso di errore, se questo è ancora il tentativo più
      // recente, la UI va comunque riallineata allo stato disponibile
      // (che potrebbe già contenere dati validi da prima dell'errore).
      // Prima questo `catch` si limitava a loggare: un singolo errore
      // transitorio sull'analisi più recente lasciava ghost/status bar
      // bloccati sui dati vecchi, perché la guardia "latest wins" impedisce
      // a un tentativo precedente di ridisegnare al posto suo - solo un
      // trigger completamente nuovo (es. cambio file) poteva sbloccare la
      // situazione.
      if (!token.isStale()) {
        refreshUi(state, { editor: vscode.window.activeTextEditor });
      }
    } finally {
      endAnalysisWork();
    }
  };

  const runActiveCppAnalysisAndRefreshUi = async (
    editor: vscode.TextEditor | undefined
  ): Promise<void> => {
    if (!state.enabled || !isCppFileEditor(editor)) {
      return;
    }

    // Condivide la stessa guardia "latest wins" di runAnalysisAndRefreshUi
    // invece di averne una propria separata: sono comunque due modi di
    // avviare la STESSA categoria di lavoro (analisi del file attivo), e
    // un cambio file rapido deve rendere stale un fallback progressivo
    // avviato da QUALUNQUE dei due punti di ingresso, non solo dal suo.
    const token = analysisGuard.start();
    beginAnalysisWork();
    setProgressiveNotice(undefined);
    try {
      await runProgressiveCppAnalysis(editor.document.uri.fsPath, editor, token);
      if (token.isStale()) return;
      refreshUi(state, { editor });
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      state.output.warn(`[runActiveCppAnalysisAndRefreshUi] errore inatteso: ${message}`);
      if (!token.isStale()) {
        refreshUi(state, { editor });
      }
    } finally {
      endAnalysisWork();
    }
  };


  // Inizializza il monitor delle risorse di sistema (optional)
  resourceMonitor = new ExtensionResourceMonitor(
    (snapshot) => {
      lastResourceSnapshot = snapshot;

      // Watchdog: la status bar non deve mai restare bloccata su
      // "working" a tempo indeterminato. Vedi il commento su
      // analysisBusySince più sopra per lo scenario che questo copre.
      if (
        analysisBusySince !== undefined &&
        Date.now() - analysisBusySince > STUCK_BUSY_THRESHOLD_MS
      ) {
        state.output.warn(
          `[watchdog] La status bar era bloccata su "working" da oltre ${Math.round(
            STUCK_BUSY_THRESHOLD_MS / 1000
          )}s (analisi rimasta sospesa senza mai risolversi né fallire) - stato ripristinato automaticamente. Se lo vedi spesso, un "Restart CalcDocs" o una segnalazione con i dettagli di cosa stavi facendo aiutano a trovare la causa.`
        );
        analysisBusyCount = 0;
        analysisBusySince = undefined;
      }

      refreshRuntimeStatus();
    },
    {
      mode: config.resourceStatusMode,
      cpuThreshold: config.resourceCpuThreshold,
    }
  );
  resourceMonitor.start();
  context.subscriptions.push(resourceMonitor);

  // Defer initial analysis until workspace opens
  if (workspaceRoot) {
    await runAnalysisAndRefreshUi();
  } else {
    // Listen for first workspace open
    const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        state.workspaceRoot = workspaceRoot;
        disposable.dispose();
        void runAnalysisAndRefreshUi();
      }
    });
    context.subscriptions.push(disposable);
  }

  registerDefinitionProviders(context, state, config.enableCppProviders);
  registerCppHoverProvider(context, state, config.enableCppProviders);
  registerHybridHoverProvider(
    context,
    state,
    hybridSymbolProvider,
    clangdService,
    config.enableCppProviders
  );
  registerFormulaOutlineHoverProvider(context, formulaRegistry, () => state);
  registerInlineCalcHoverProvider(context, state);
  registerYamlHoverProvider(context, state);
  registerCppCodeLensProvider(context, codeLensProvider);
  registerInlineCalcCodeLensProvider(context, inlineCalcCodeLensProvider);
  registerInspectionFeatures(context, state);

  
  // Debounce leggero e indipendente dallo scheduler di analisi: qui
  // vogliamo solo evitare che ghostProvider.update()/refreshUi() (che
  // riparsano l'intero documento attivo) girino ad ogni singolo carattere
  // digitato. 120ms è impercettibile per l'utente ma coalesce raffiche di
  // keystroke in un'unica ricomputazione.
  let refreshUiTimer: NodeJS.Timeout | undefined;
  const REFRESH_UI_DEBOUNCE_MS = 120;
  context.subscriptions.push({
    dispose: () => {
      if (refreshUiTimer) {
        clearTimeout(refreshUiTimer);
        refreshUiTimer = undefined;
      }
    },
  });

  function scheduleRefreshUi(editor: vscode.TextEditor): void {
    if (refreshUiTimer) {
      clearTimeout(refreshUiTimer);
    }
    refreshUiTimer = setTimeout(() => {
      refreshUiTimer = undefined;
      refreshUi(state, { editor, refreshDiagnostics: true });
    }, REFRESH_UI_DEBOUNCE_MS);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!state.enabled) return;

      inlineCalcResultsViewProvider.notifyDocumentChanged(event.document);

      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document) {
        scheduleRefreshUi(editor);
      }

      const isYamlDocument =
        (event.document.languageId === "yaml" || event.document.languageId === "yml");

      if (isYamlDocument) {
        scheduler?.schedule(200);
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      inlineCalcResultsViewProvider.setActiveEditor(editor);
      inlineCalcCodeLensProvider.refresh();

      if (editor && isCppFileEditor(editor)) {
        // NIENTE refreshUi() immediato per i file C/C++: in questo
        // istante state.symbolValues contiene ancora i simboli
        // dell'analisi del file PRECEDENTE. Disegnare subito i ghost
        // value da quello stato li fa comparire con valori che
        // *sembrano* giusti (su header condivisi spesso lo sono), per
        // poi vederli sparire un attimo dopo, quando l'analisi del file
        // appena attivato completa e riscrive la tabella dei simboli
        // (applyCppSymbols con resetSymbolValues: true) — che su un
        // progetto grande può risolverne meno di quelli mostrati un
        // istante prima. Era esattamente il "appaiono e subito
        // scompaiono" segnalato. Il refresh corretto lo fa
        // runActiveCppAnalysisAndRefreshUi quando i valori sono
        // davvero quelli di QUESTO file.
        void runActiveCppAnalysisAndRefreshUi(editor);
        return;
      }

      if (editor) {
        refreshUi(state, { editor });
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (editor.document.uri.toString() !== document.uri.toString()) return;

      inlineCalcResultsViewProvider.notifyDocumentChanged(document);

      refreshUi(state, { editor });

      void runActiveCppAnalysisAndRefreshUi(editor);
    })
  );

  // Inizializza lo scheduler per l'analisi automatica
  scheduler = new AnalysisScheduler(state, runAnalysisAndRefreshUi);
  scheduler.applyConfiguration(context, config);
  context.subscriptions.push(scheduler);

  // Registra i comandi della guida interattiva
  registerGuideCommands(context);

  // Chiusura usata da "Restart CalcDocs" (vedi commands.ts) per
  // rileggere calcdocs.* e riallineare stato/scheduler/resource monitor
  // esattamente come fa il gestore onDidChangeConfiguration qui sotto -
  // aggiorna anche `config` (variabile locale di activate()), non solo
  // `state`, cosi' refreshRuntimeStatus() non resta con la soglia CPU
  // vecchia dopo un restart.
  const reapplyConfig = (): void => {
    config = reapplyRuntimeConfig(context, state);
  };

  // Registra i comandi dell'estensione (toggleEnabled, etc.)
  registerCommands({
    context,
    state,
    scheduler,
    runAnalysisAndRefreshUi,
    formulaRegistry,
    reapplyConfig,
  });

  // Gestisce i cambi di configurazione dell'estensione
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      // Verifica se il cambiamento riguarda CalcDocs
      if (!event.affectsConfiguration("calcdocs")) {
        return;
      }

      const previousConfig = config;
      const nextConfig = reapplyRuntimeConfig(context, state);
      config = nextConfig;

      if (
        event.affectsConfiguration("calcdocs.useClangd") &&
        clangdService
      ) {
        void reconfigureClangdService(
          clangdService,
          context,
          state.output,
          nextConfig.useClangd
        )
          .then(() => {
            refreshRuntimeStatus();
            void runAnalysisAndRefreshUi();
          })
          .catch((error: unknown) => {
            const message = getErrorMessage(error);
            state.output.warn(`[clangd] reconfigure failed: ${message}`);
            refreshRuntimeStatus();
          });
      }

      // Log del cambiamento di stato enabled
      if (previousConfig.enabled !== nextConfig.enabled) {
        coloredOutput!.info(`[config] enabled=${nextConfig.enabled}`);
      }

      // Clear diagnostics if disabled
      if (!state.enabled) {
        clearDiagnostics(state);
        clearInlineCalcDiagnostics(state);
      }

      // Scheduler e resource monitor sono già stati riallineati da
      // reapplyRuntimeConfig() qui sopra.
      refreshRuntimeStatus();
      invalidatePriorityCache();
      codeLensProvider.refresh();
      inlineCalcCodeLensProvider.refresh();
      inlineCalcResultsViewProvider.refresh();
      refreshInlineCalcDiagnosticsForVisibleEditors(state);
      const activeEditor = vscode.window.activeTextEditor;
      // Quando cambia "calcdocs.enabled" NON ridisegniamo qui: i dati
      // (state.symbolValues ecc.) potrebbero non essere ancora stati
      // ripopolati/svuotati per il nuovo stato, quindi disegneremmo ghost
      // "vuoti" o stantii per un istante. runAnalysisAndRefreshUi() più
      // sotto gestisce già correttamente questo caso (con generation
      // token anti-race) e chiama ghostProvider.update() a dati pronti.
      // Per tutti gli ALTRI cambi di configurazione (es. toggle della
      // sola visibilità dei ghost) non serve una nuova analisi: qui
      // ridisegniamo subito con i dati correnti, che sono già validi.
      if (
        activeEditor &&
        state.inlineGhostEnabled &&
        !event.affectsConfiguration("calcdocs.enabled")
      ) {
        ghostProvider.update(activeEditor);
      }

      // Determina se è necessario rieseguire l'analisi
      const analysisRelevantChange =
        event.affectsConfiguration("calcdocs.enabled") ||
        event.affectsConfiguration("calcdocs.scanInterval") ||
        event.affectsConfiguration("calcdocs.ignoredDirs") ||
        event.affectsConfiguration("calcdocs.enableCppProviders") ||
        event.affectsConfiguration("calcdocs.cppCacheMaxEntries");

      if (analysisRelevantChange) {
        void runAnalysisAndRefreshUi();
      }
    })
  );
  } catch (error: unknown) {
    handleActivationError(error);
  }
}

/**
 * Funzione di chiusura dell'estensione.
 * Rilascia tutti i timer, watcher, canale di output e risorse della status bar.
 */
export async function deactivate(): Promise<void> {
  // Ferma lo scheduler e related timers
  scheduler?.dispose();
  
  await flushPendingMegaContentDiskWrites();

  // Chiude il canale di output
  if (outputChannel && coloredOutput) {
    coloredOutput.info(localize("output.deactivate"));
    outputChannel.dispose();
  }

  // Rilascia le risorse del monitor
  resourceMonitor?.dispose();
  runtimeStatusBar?.dispose();
  await clangdService?.stop();
}
