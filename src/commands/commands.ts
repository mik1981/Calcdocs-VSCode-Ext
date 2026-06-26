import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

import { clearCppParserCache } from "../core/cppParser";
import { getConfig } from "../core/config";
import { CalcDocsState, SymbolDefinitionLocation } from "../core/state";
import { AnalysisScheduler } from "../infra/watchers";
import { pickWord } from "../utils/editor";
import { localize } from "../utils/localize";
import { generateFormulaHeader } from "../utils/headerGenerator";
// import { openInlineCalcGuide } from "./guide";
import { openInteractiveView, hasInteractiveContent, refreshInteractiveViewContext } from "../ui/interactiveView";
import { FormulaRegistry } from "../formulaOutline/formulaRegistry";

type RegisterCommandsParams = {
  context: vscode.ExtensionContext;
  state: CalcDocsState;
  scheduler: AnalysisScheduler;
  runAnalysisAndRefreshUi: () => Promise<void>;
  formulaRegistry: FormulaRegistry;
};

/**
 * Registers all extension commands exposed in package.json.
 * Example: "calcdocs.recompute" runs analysis and writes computed values back to YAML.
 */
export function registerCommands({
  context,
  state,
  scheduler,
  runAnalysisAndRefreshUi,
  formulaRegistry,
}: RegisterCommandsParams): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("calcdocs.recompute", async () => {
      if (!state.enabled) {
        await vscode.window.showWarningMessage(
          localize("command.recompute.warningDisabled")
        );
        return;
      }

      await runAnalysisAndRefreshUi();
      await vscode.window.showInformationMessage("CalcDocs analysis updated.");
    }),

    vscode.commands.registerCommand("calcdocs.generateFormulaHeader", async () => {
      const outputPath = getConfig().formulaHeader.outputPath || 'macro_generate.h';
      await generateFormulaHeader([], outputPath, state);
    }),

    vscode.commands.registerCommand("calcdocs.showOutput", async () => {
      state.output.show(false);
    }),

    vscode.commands.registerCommand("calcdocs.setScanInterval", async () => {
      const currentInterval = getConfig().scanInterval;

      const input = await vscode.window.showInputBox({
        prompt: "Scan interval in seconds, 0 disables periodic scan",
        value: String(currentInterval),
        validateInput(value) {
          const numeric = Number(value);
          return !Number.isFinite(numeric) || numeric < 0
            ? "Insert a number >= 0"
            : null;
        },
      });

      if (input == null) {
        return;
      }

      const nextInterval = Number(input);

      await vscode.workspace
        .getConfiguration("calcdocs")
        .update("scanInterval", nextInterval, vscode.ConfigurationTarget.Workspace);

      scheduler.applyConfiguration(context, getConfig());
    }),

    vscode.commands.registerCommand("calcdocs.toggleEnabled", async () => {
      const currentEnabled = getConfig().enabled;
      const nextEnabled = !currentEnabled;

      await vscode.workspace
        .getConfiguration("calcdocs")
        .update("enabled", nextEnabled, vscode.ConfigurationTarget.Workspace);

      const stateLabel = nextEnabled ? localize("command.toggleEnabled.enabled") : localize("command.toggleEnabled.disabled");
      await vscode.window.showInformationMessage(stateLabel);
    }),

    vscode.commands.registerCommand("calcdocs.toggleGhostValues", async () => {
      const config = getConfig();
      const nextEnabled = !config.inlineGhostEnable;

      await vscode.workspace
        .getConfiguration("calcdocs")
        .update("inline.ghost.enabled", nextEnabled, vscode.ConfigurationTarget.Workspace);

      const stateLabel = nextEnabled
        ? localize("command.toggleGhostValues.enabled")
        : localize("command.toggleGhostValues.disabled");
      await vscode.window.showInformationMessage(stateLabel);
    }),

    vscode.commands.registerCommand("calcdocs.restart", async () => {
      clearCppParserCache();
      await runAnalysisAndRefreshUi();
      await vscode.window.showInformationMessage(localize("command.restart.done"));
    }),

    vscode.commands.registerCommand("calcdocs.setUiInvasiveness", async () => {
      await promptAndSetUiInvasiveness();
    }),

    vscode.commands.registerCommand("calcdocs.runtimeMenu", async () => {
      await openRuntimeQuickMenu(runAnalysisAndRefreshUi);
    }),

    vscode.commands.registerCommand("calcdocs.goToCounterpart", async () => {
      if (!state.enabled) {
        await vscode.window.showWarningMessage(
          localize("command.goToCounterpart.warningDisabled")
        );
        return;
      }

      await goToCounterpart(state);
    }),

    vscode.commands.registerCommand("calcdocs.fixMismatch", async (label: string) => {
      if (!state.enabled) {
        return;
      }

      await openFormulaDefinition(state, label);
    }),

    vscode.commands.registerCommand(
      "calcdocs.inlineCalc.openResult",
      async (uri: vscode.Uri | string, line: number) => {
        const targetUri =
          uri instanceof vscode.Uri ? uri : vscode.Uri.parse(String(uri));
        const safeLine = Number.isFinite(line) ? Math.max(0, Math.trunc(line)) : 0;
        await reveal(targetUri, safeLine);
      }
    ),

    vscode.commands.registerCommand("calcdocs.inlineCalc.openGuide", async () => {
      await openInlineCalcGuide(context);
    }),

    vscode.commands.registerCommand("calcdocs.openTestFolder", async () => {
      // Open examples folder in a COMPLETELY NEW VS CODE WINDOW (fresh workspace)
      // Independent of workspaceRoot - works at startup
      const examplesFolderUri = vscode.Uri.joinPath(context.extensionUri, "examples");
      
      try {
        await fsp.access(examplesFolderUri.fsPath);
      } catch {
        await vscode.window.showWarningMessage("CalcDocs examples folder not found.");
      state.output.warn("openTestFolder: examples folder access failed");
        return;
      }

      // This is equivalent to File -> Open Folder, opens in a new separate window
      await vscode.commands.executeCommand('vscode.openFolder', examplesFolderUri, true);
      state.output.info("openTestFolder: Opened examples/ in new window");
    }),

    vscode.commands.registerCommand(
      "calcdocs.copyValue",
      async (value: string) => {
        await vscode.env.clipboard.writeText(value);
        await vscode.window.showInformationMessage(
          `CalcDocs: copied "${value}"`
        );
      }
    ),  

    vscode.commands.registerCommand("calcdocs.openInteractiveView", async () => {
      const editor = vscode.window.activeTextEditor;

      if (!hasInteractiveContent(editor, state)) {
        const detail = editor
          ? `The file "${path.basename(editor.document.fileName)}" does not contain any calculable formulas.\n\nOpen this command from:\n• a C/C++ file with inline assignments  (@variable = expression)\n• a formula*.yaml file with at least one formula or constant`
          : `No active file detected.\n\nOpen this command from:\n• a C/C++ file with inline assignments  (@variable = expression)\n• a formula*.yaml file with at least one formula or constant`;

        await vscode.window.showInformationMessage(
          "CalcDocs – Interactive View: no formulas found.",
          { modal: true, detail }
        );
        return;
      }

      openInteractiveView(context, state);
    }),
  );

  // ── Context key per il bottone "Open Interactive View" nel view/title ────────
  // Valore iniziale calcolato sull'editor già aperto al momento dell'attivazione.
  refreshInteractiveViewContext(vscode.window.activeTextEditor, state);

  // Aggiornamento al cambio di editor attivo.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      refreshInteractiveViewContext(editor, state);
    })
  );

  // Aggiornamento alle modifiche del documento, con debounce per non
  // rieseguire il test regex su ogni singola battuta.
  let contextRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (event.document.uri.toString() !== editor.document.uri.toString()) return;
      clearTimeout(contextRefreshTimer);
      contextRefreshTimer = setTimeout(() => {
        refreshInteractiveViewContext(editor, state);
      }, 600);
    })
  );

  async function openRuntimeQuickMenu(
    refresh: () => Promise<void>
  ): Promise<void> {
    const config = getConfig();
    const picks: Array<
      vscode.QuickPickItem & {
        action:
          | "recompute"
          | "restart"
          | "toggleEnabled"
          | "setInvasiveness"
          | "toggleCppCodeLens"
          | "toggleCppHover"
          | "toggleInlineCodeLens"
          | "toggleInlineHover"
          | "toggleGhostValues"
          | "showOutput"
          | "generateFormulaHeader"
          | "openInteractiveView"
          | "openSettings";
      }
    > = [
      {
        label: "$(refresh) Force Recompute",
        description: "Full analysis refresh (Ctrl+Alt+R)",
        action: "recompute",
      },
      {
        label: "$(sync~spin) Restart CalcDocs",
        description: "Clear parser cache and rebuild analysis",
        action: "restart",
      },
      {
        label: config.enabled ? "$(circle-slash) Disable CalcDocs" : "$(play) Enable CalcDocs",
        description: config.enabled ? "Pause all analysis/providers" : "Resume analysis/providers",
        action: "toggleEnabled",
      },
      {
        label: "$(symbol-color) UI Invasiveness",
        description: `Current: ${config.uiInvasiveness}`,
        action: "setInvasiveness",
      },
      {
        label: config.cppCodeLens.enabled
          ? "$(eye-closed) Disable C/C++ CodeLens"
          : "$(eye) Enable C/C++ CodeLens",
        description: "Quick toggle for C/C++ CodeLens hints",
        action: "toggleCppCodeLens",
      },
      {
        label: config.cppHover.enabled
          ? "$(eye-closed) Disable C/C++ Hover"
          : "$(eye) Enable C/C++ Hover",
        description: "Quick toggle for C/C++ hover details",
        action: "toggleCppHover",
      },
      {
        label: config.inlineCodeLens.enabled
          ? "$(eye-closed) Disable Inline CodeLens"
          : "$(eye) Enable Inline CodeLens",
        description: "Quick toggle for inline calc CodeLens",
        action: "toggleInlineCodeLens",
      },
      {
        label: config.inlineHover.enabled
          ? "$(eye-closed) Disable Inline Hover"
          : "$(eye) Enable Inline Hover",
        description: "Quick toggle for inline calc hover",
        action: "toggleInlineHover",
      },
      {
        label: config.inlineGhostEnable
          ? "$(eye-closed) Disable Ghost Values"
          : "$(eye) Enable Ghost Values",
        description: "Quick toggle for ghost value usage and inline rendering",
        action: "toggleGhostValues",
      },
      {
        label: "$(output) Show CalcDocs Output",
        description: "Open extension output channel",
        action: "showOutput",
      },
      {
        label: "$(beaker) Open Interactive View",
        description: "Open the interactive formula explorer for the active file",
        action: "openInteractiveView",
      },
      {
        label: "$(settings-gear) Open CalcDocs Settings",
        description: "Open settings filtered by @ext:convergo-dev.calcdocs-vscode-extension",
        action: "openSettings",
      },
    ];

    // Aggiungi comando compile_commands solo se c'è workspace aperto e clangd è presente
    const hasWorkspace = !!vscode.workspace.workspaceFolders?.[0];
    // Show if workspace open (internal clangd handles reload - no extension needed)
    if (hasWorkspace) {
      picks.push({
        label: "$(file-code) Generate Formulas Header",
        description: `C macros to "${getConfig().formulaHeader.outputPath || 'macro_generate.h'}"`,
        action: "generateFormulaHeader",
      });
    }

    const picked = await vscode.window.showQuickPick(picks, {
      placeHolder: localize("command.runtimeMenu.placeholder"),
    });
    if (!picked) {
      return;
    }

    switch (picked.action) {
      case "recompute":
        await vscode.commands.executeCommand("calcdocs.recompute");
        return;
      case "restart":
        clearCppParserCache();
        await refresh();
        await vscode.window.showInformationMessage(localize("command.restart.done"));
        return;
      case "generateFormulaHeader":
        const outputPath = getConfig().formulaHeader.outputPath || 'macro_generate.h';
        await generateFormulaHeader([], outputPath, state);
        return;
      case "toggleEnabled":
        await toggleWorkspaceBoolean("enabled", config.enabled);
        return;
      case "setInvasiveness":
        await promptAndSetUiInvasiveness();
        return;
      case "toggleCppCodeLens":
        await toggleWorkspaceBoolean("cpp.codeLens.enabled", config.cppCodeLens.enabled);
        return;
      case "toggleCppHover":
        await toggleWorkspaceBoolean("cpp.hover.enabled", config.cppHover.enabled);
        return;
      case "toggleInlineCodeLens":
        await toggleWorkspaceBoolean("inline.codeLens.enabled", config.inlineCodeLens.enabled);
        return;
      case "toggleInlineHover":
        await toggleWorkspaceBoolean("inline.hover.enabled", config.inlineHover.enabled);
        return;
      case "toggleGhostValues":
        await vscode.commands.executeCommand("calcdocs.toggleGhostValues");
        return;
      case "showOutput":
        state.output.show(false);
        return;
      case "openInteractiveView":
        await vscode.commands.executeCommand("calcdocs.openInteractiveView");
        return;
      case "openSettings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "@ext:convergo-dev.calcdocs-vscode-extension"
        );
        return;

      default:
        return;
    }
  }
}

async function toggleWorkspaceBoolean(
  settingKey: string,
  fallbackValue: boolean
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("calcdocs");
  const currentValue = cfg.get<boolean>(settingKey, fallbackValue);
  await cfg.update(settingKey, !currentValue, vscode.ConfigurationTarget.Workspace);
}

async function promptAndSetUiInvasiveness(): Promise<void> {
  const current = getConfig().uiInvasiveness;
  const picks: Array<
    vscode.QuickPickItem & {
      value: "minimal" | "standard" | "verbose";
    }
  > = [
    {
      label: "Minimal",
      description: "Less visual noise, fewer hints",
      value: "minimal",
    },
    {
      label: "Standard",
      description: "Balanced details (default)",
      value: "standard",
    },
    {
      label: "Verbose",
      description: "Maximum details and hints",
      value: "verbose",
    },
  ];

  const selected = await vscode.window.showQuickPick(picks, {
    placeHolder: `Current UI invasiveness: ${current}`,
  });
  if (!selected) {
    return;
  }

  await vscode.workspace
    .getConfiguration("calcdocs")
    .update("ui.invasiveness", selected.value, vscode.ConfigurationTarget.Workspace);
  await vscode.window.showInformationMessage(
    localize("command.setUiInvasiveness.updated", selected.label)
  );
}

async function openInlineCalcGuide(
  context: vscode.ExtensionContext
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "calcdocsInlineGuide",
    "CalcDocs Guide",
    vscode.ViewColumn.Beside,
    {
      enableFindWidget: true,
      retainContextWhenHidden: true,
    }
  );

  const locale = vscode.env.language.toLowerCase();

  // es: "it", "en", "it-it" → ridotto a "it"
  const lang = locale.split("-")[0];

  const tryFiles = [
    `inline-calc-guide_${lang}.html`,
    "inline-calc-guide_en.html",
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
      break; // trovato → stop
    } catch {
      // file non esiste → continua
    }
  }

  panel.webview.html =
    htmlContent ??
    `<!doctype html>
<html><body><h2>CalcDocs Guide</h2><p>Guide file not found.</p></body></html>`;
}

/**
 * Jumps between C/C++ symbols and YAML formula definitions.
 * Example:
 * - from C/C++ "FOO" -> open formulas*.yaml at FOO entry when available
 * - from YAML "FOO" -> open C/C++ symbol definition for FOO
 */
async function goToCounterpart(state: CalcDocsState): Promise<void> {
  const activeContext = getActiveWord();
  if (!activeContext) {
    return;
  }

  const { editor, word } = activeContext;
  const language = editor.document.languageId;

  if (language === "c" || language === "cpp") {
    const formula = state.formulaIndex.get(word);
    if (formula?._filePath) {
      const targetFile = path.resolve(state.workspaceRoot, formula._filePath);
      await reveal(vscode.Uri.file(targetFile), formula._line ?? 0);
      return;
    }

    const symbolLocation = await pickSymbolLocation(state, word);
    if (symbolLocation) {
      const targetFile = path.resolve(state.workspaceRoot, symbolLocation.file);
      await reveal(vscode.Uri.file(targetFile), symbolLocation.line);
    }

    return;
  }

  if (language === "yaml") {
    const symbolLocation = await pickSymbolLocation(state, word);
    if (symbolLocation) {
      const targetFile = path.resolve(state.workspaceRoot, symbolLocation.file);
      await reveal(vscode.Uri.file(targetFile), symbolLocation.line);
    }
  }
}

function getSymbolLocations(
  state: CalcDocsState,
  word: string
): SymbolDefinitionLocation[] {
  const variants = state.symbolConditionalDefs.get(word) ?? [];
  if (variants.length > 0) {
    const unique = new Map<string, SymbolDefinitionLocation>();

    for (const variant of variants) {
      const key = `${variant.file}:${variant.line}`;
      unique.set(key, {
        file: variant.file,
        line: variant.line,
      });
    }

    return Array.from(unique.values());
  }

  const single = state.symbolDefs.get(word);
  return single ? [single] : [];
}

async function pickSymbolLocation(
  state: CalcDocsState,
  word: string
): Promise<SymbolDefinitionLocation | null> {
  const locations = getSymbolLocations(state, word);
  if (locations.length === 0) {
    return null;
  }

  if (locations.length === 1) {
    return locations[0];
  }

  const picks = locations.map((location) => ({
    label: `${location.file}:${location.line + 1}`,
    location,
  }));

  const selected = await vscode.window.showQuickPick(picks, {
    placeHolder: localize("command.pickSymbol.placeholder", word),
  });

  return selected?.location ?? null;
}

/**
 * Opens the YAML block where a formula key is declared.
 * Example: "fix mismatch" lens passes label "PRESSURE_DROP" and this reveals its node.
 */
async function openFormulaDefinition(
  state: CalcDocsState,
  key: string
): Promise<void> {
  const formula = state.formulaIndex.get(key);
  if (!formula || !formula._filePath) {
    await vscode.window.showWarningMessage(`No formulas entry for '${key}'`);
    return;
  }

  const file = path.resolve(state.workspaceRoot, formula._filePath);
  const line = formula._line ?? 0;

  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document, { preview: false });

  const range = new vscode.Range(line, 0, line, 0);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/**
 * Returns active editor + symbol under cursor if it matches an identifier token.
 */
function getActiveWord():
  | { editor: vscode.TextEditor; word: string }
  | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }

  const position = editor.selection.active;
  const word = pickWord(editor.document, position);

  if (!word) {
    return undefined;
  }

  return { editor, word };
}

/**
 * Opens a document and centers the given line.
 */
async function reveal(uri: vscode.Uri, line: number): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: true });

  const range = new vscode.Range(line, 0, line, 0);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
