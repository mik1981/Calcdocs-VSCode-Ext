import * as vscode from "vscode";

import { registerCommands } from "./commands/commands";
import {
  createClangdService,
  reconfigureClangdService,
} from "./clangd/clangdFactory";
import { ClangdStatus } from "./clangd/ClangdClient";
import { ClangdService } from "./clangd/ClangdService";
import { runAnalysis, runActiveCppFileAnalysis } from "./core/analysis";
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
import { ClangdSymbolProvider } from "./symbols/ClangdSymbolProvider";
import { HybridSymbolProvider } from "./symbols/HybridSymbolProvider";
import { LegacyParserProvider } from "./symbols/LegacyParserProvider";
import { GhostValueProvider } from "./core/ghostValues";
import { FormulaOutlineProvider } from "./formulaOutline/formulaOutlineProvider";
import { FormulaRegistry } from "./formulaOutline/formulaRegistry";
import { registerFormulaCommands } from "./formulaOutline/commands";
import { registerFormulaOutlineHoverProvider } from "./formulaOutline/hoverProvider";
import { invalidatePriorityCache } from "./core/ghostPolicy";
import { GuideWebviewProvider } from "./ui/guideWebviewProvider";

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


export function registerGuideCommands(context: vscode.ExtensionContext): void {
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

  // Create diagnostics collection for YAML errors/discrepancies
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
      runtimeBackendLabel
    );

    const shouldShow = !state.enabled || lastResourceSnapshot.shouldShowStatus;
    if (shouldShow) {
      runtimeStatusBar.show();
      return;
    }

    runtimeStatusBar.hide();
  };

  /**
   * Esegue l'analisi completa del workspace e sincronizza tutti i componenti UI
   * che dipendono dallo stato corrente.
   */
  const runAnalysisAndRefreshUi = async (): Promise<void> => {
    try {
      // Se l'estensione è disabilitata, pulisci lo stato e ferma i provider
      if (!state.enabled) {
        clearComputedState(state);
        clearDiagnostics(state);
        clearInlineCalcDiagnostics(state);
        refreshRuntimeStatus();
        invalidatePriorityCache();
        codeLensProvider.refresh();
        inlineCalcCodeLensProvider.refresh();
        inlineCalcResultsViewProvider.refresh();
        diagnosticsProvider.mergeForVisibleEditors();
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          ghostProvider.update(activeEditor);
        }
        return;
      }

      // Esegui l'analisi del workspace
      await runAnalysis(state);

      const activeEditor = vscode.window.activeTextEditor;
      if (isCppFileEditor(activeEditor)) {
        await runActiveCppFileAnalysis(state, activeEditor.document.uri.fsPath);
      }

      // Aggiorna tutti i componenti UI
      refreshRuntimeStatus();
      invalidatePriorityCache();
      codeLensProvider.refresh();
      inlineCalcCodeLensProvider.refresh();
      inlineCalcResultsViewProvider.refresh();
      refreshInlineCalcDiagnosticsForVisibleEditors(state);
      diagnosticsProvider.mergeForVisibleEditors();
      if (activeEditor) {
        ghostProvider.update(activeEditor);
        formulaOutlineProvider.refreshDecorations();
      }
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      state.output.warn(`[runAnalysisAndRefreshUi] errore inatteso: ${message}`);
    }
  };

  const runActiveCppAnalysisAndRefreshUi = async (
    editor: vscode.TextEditor | undefined
  ): Promise<void> => {
    try {
      if (!state.enabled || !isCppFileEditor(editor)) {
        return;
      }

      await runActiveCppFileAnalysis(state, editor.document.uri.fsPath);
      refreshRuntimeStatus();
      invalidatePriorityCache();
      codeLensProvider.refresh();
      inlineCalcCodeLensProvider.refresh();
      inlineCalcResultsViewProvider.refresh();
      refreshInlineCalcDiagnosticsForVisibleEditors(state);
      diagnosticsProvider.mergeForVisibleEditors();
      ghostProvider.update(editor);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      state.output.warn(`[runActiveCppAnalysisAndRefreshUi] errore inatteso: ${message}`);
    }
  };


  // Inizializza il monitor delle risorse di sistema (optional)
  resourceMonitor = new ExtensionResourceMonitor(
    (snapshot) => {
      lastResourceSnapshot = snapshot;
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

  // Aggiorna i CodeLens quando un documento viene modificato
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!state.enabled) {
        return;
      }

      codeLensProvider.refresh();
      inlineCalcCodeLensProvider.refresh();
      inlineCalcResultsViewProvider.notifyDocumentChanged(event.document);
      refreshInlineCalcDiagnosticsForDocument(event.document, state);
      diagnosticsProvider.mergeDiagnosticsForUri(event.document.uri);

      const isYamlDocument =
        (event.document.languageId === "yaml" || event.document.languageId === "yml") &&
        (event.document.uri.scheme === "file" || event.document.uri.scheme === "untitled");
      if (isYamlDocument) {
        scheduler?.schedule(200);
      }

      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document) {
        ghostProvider.update(editor);
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      inlineCalcResultsViewProvider.setActiveEditor(editor);
      inlineCalcCodeLensProvider.refresh();
      if (editor) {
        refreshInlineCalcDiagnosticsForDocument(editor.document, state);
        diagnosticsProvider.mergeDiagnosticsForUri(editor.document.uri);
        ghostProvider.update(editor);
      }
      void runActiveCppAnalysisAndRefreshUi(editor);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        return;
      }

      if (activeEditor.document.uri.toString() !== document.uri.toString()) {
        return;
      }

      inlineCalcResultsViewProvider.notifyDocumentChanged(document);
      inlineCalcCodeLensProvider.refresh();
      refreshInlineCalcDiagnosticsForDocument(document, state);
      diagnosticsProvider.mergeDiagnosticsForUri(document.uri);
      ghostProvider.update(activeEditor);
      void runActiveCppAnalysisAndRefreshUi(activeEditor);
    })
  );

  // Inizializza lo scheduler per l'analisi automatica
  scheduler = new AnalysisScheduler(state, runAnalysisAndRefreshUi);
  scheduler.applyConfiguration(context, config);
  context.subscriptions.push(scheduler);

  // Registra i comandi della guida interattiva
  registerGuideCommands(context);

  // Registra i comandi dell'estensione (toggleEnabled, etc.)
  registerCommands({
    context,
    state,
    scheduler,
    runAnalysisAndRefreshUi,
    formulaRegistry,
  });

  // Gestisce i cambi di configurazione dell'estensione
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      // Verifica se il cambiamento riguarda CalcDocs
      if (!event.affectsConfiguration("calcdocs")) {
        return;
      }

      const previousConfig = config;
      const nextConfig = getConfig();
      config = nextConfig;
      applyConfigToState(state, nextConfig);

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

      // Aggiorna la configurazione dello scheduler e del monitor risorse
      scheduler?.applyConfiguration(context, nextConfig);
      resourceMonitor?.applyConfiguration({
        mode: nextConfig.resourceStatusMode,
        cpuThreshold: nextConfig.resourceCpuThreshold,
      });
      refreshRuntimeStatus();
      invalidatePriorityCache();
      codeLensProvider.refresh();
      inlineCalcCodeLensProvider.refresh();
      inlineCalcResultsViewProvider.refresh();
      refreshInlineCalcDiagnosticsForVisibleEditors(state);
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
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
