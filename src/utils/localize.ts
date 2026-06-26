import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

// Stable key -> English message map used by call sites.
const fallbackEn: Record<string, string> = {
  "extension.description": "Excel for firmware — instantly evaluate C/C++ macros, constants, and YAML formulas with real computed values inside VS Code",

  "config.title": "CalcDocs",
  "config.enabled": "Enable or disable CalcDocs without uninstalling the extension.",
  "config.scanInterval": "Interval in seconds for periodic scanning (0 = disabled).",
  "config.ignoredDirs": "Folders to ignore during analysis.",
  "config.enableCppProviders": "Enable CalcDocs providers for C/C++ as fallback (priority to C/C++ Tools).",
  "config.useClangd": "Enable optional clangd backend (LSP) for C/C++ symbol resolution.",
  "config.resourceStatusMode.always": "Always show runtime status (toggle + CPU/RAM).",
  "config.resourceStatusMode.aboveCpuThreshold": "Show runtime status only when CPU usage exceeds threshold.",
  "config.resourceStatusMode": "Controls when to show runtime status in status bar.",
  "config.resourceCpuThreshold": "CPU threshold (%) used when calcdocs.resourceStatusMode = aboveCpuThreshold.",
  "config.thousandsSeparator.none": "No thousands separator.",
  "config.thousandsSeparator.space": "Space (scientific standard)",
  "config.thousandsSeparator.dot": "Dot operator (â‹…, U+22C5)",
  "config.thousandsSeparator.comma": "Comma (USA, UK)",
  "config.thousandsSeparator.apostrophe": "Apostrophe (Switzerland)",
  "config.thousandsSeparator.narrowNoBreakSpace": "Narrow No-Break Space (U+202F)",
  "config.thousandsSeparator": "Thousands separator for formatted numbers.",

  "command.recompute.title": "CalcDocs: Recompute Analysis",
  "command.setScanInterval.title": "CalcDocs: Set Scan Interval",
  "command.toggleEnabled.title": "CalcDocs: Toggle Enable/Disable",
  "command.toggleGhostValues.title": "CalcDocs: Toggle Ghost Values",
  "command.restart.title": "CalcDocs: Restart (Clear Cache + Reanalyze)",
  "command.runtimeMenu.title": "CalcDocs: Runtime Quick Menu",
  "command.setUiInvasiveness.title": "CalcDocs: Set UI Invasiveness",
  "command.showOutput.title": "CalcDocs: Show Log Output",

  "statusBar.initializing": "Initializing CalcDocs...",
  "statusBar.formulaCount": "CalcDocs: {0}",
  "statusBar.yamlError": "CalcDocs YAML error",
  "statusBar.yamlErrorTooltip": "Parsing failed for {0}{1}. Click to open CalcDocs output.",
  "statusBar.updatesIndexed": "Updates indexed formulas",
  "statusBar.runtimeInitializing": "CalcDocs initializing",
  "statusBar.runtimeOn": "CalcDocs ON",
  "statusBar.runtimeOff": "CalcDocs OFF",
  "statusBar.clickToOpenMenu": "Click to open CalcDocs quick menu.",
  "statusBar.clickToDisable": "Click to disable CalcDocs",
  "statusBar.clickToEnable": "CalcDocs disabled. Click to enable.",
  "statusBar.enabled": "CalcDocs enabled.",
  "statusBar.enabledDetails": "CalcDocs enabled.\n\nCPU {0}% RAM {1}MB{2}.\nCPU threshold: {3}%.\n\n{4}\n\nClick to open quick menu.",
  "statusBar.enabledDegradedDetails": "CalcDocs enabled.\n\nCPU {0}% RAM {1}MB{2}.\nCPU threshold: {3}%.\nStack usage {4}/{5}, circular reference detected {6}, branches stopped by depth guard {7}.\n\n{8}\n\nClick to open quick menu.",
  "statusBar.stackUsage": " STK {0}/{1}",

  "command.recompute.warningDisabled": "CalcDocs is disabled. Re-enable it from settings or with CalcDocs: Toggle Enabled.",
  "command.recompute.success": "CalcDocs updated.",
  "command.setScanInterval.prompt": "Scan interval in seconds, 0 disables periodic scan",
  "command.setScanInterval.invalidInput": "Insert a number >= 0",
  "command.toggleEnabled.enabled": "CalcDocs enabled.",
  "command.toggleEnabled.disabled": "CalcDocs disabled.",
  "command.toggleGhostValues.enabled": "CalcDocs ghost values enabled.",
  "command.toggleGhostValues.disabled": "CalcDocs ghost values disabled.",
  "command.restart.done": "CalcDocs restarted and cache rebuilt.",
  "command.runtimeMenu.placeholder": "Choose a quick CalcDocs action",
  "command.setUiInvasiveness.updated": "CalcDocs UI invasiveness set to {0}.",
  "command.goToCounterpart.warningDisabled": "CalcDocs is disabled. Re-enable it to use Go to Counterpart.",
  "command.goToCounterpart.noFormula": "No formulas entry for '{0}'",
  "command.pickSymbol.placeholder": "Multiple definitions found for {0}",

  "output.activate": "[activate] CalcDocs",
  "output.deactivate": "[deactivate] CalcDocs",
  "output.noWorkspace": "No workspace folder found.",
  "output.stackSafeMode": "[CalcDocs] Stack-safe analysis mode (depth {0}/{1}, cycles {2}, pruned {3})",
  "output.circularReferences": "[CalcDocs] Circular references detected:",
  "output.yamlError": "[YAML error] {0}{1}\nReason: {2}",
  "output.stackOverflow": "[Analysis warning] Stack overflow avoided by safety limits. {0}",
  "output.analysisError": "[Analysis error] {0}",
  "output.cppAnalysisComplete": "[CalcDocs] formulas*.yaml not found, C/C++ analysis completed ({0} values)",
  "output.analysisComplete": "Analysis ok ({0} formulas)",
  "output.noYamlUpdates": "No YAML updates needed: {0}",
  "output.yamlUpdated": "Updated YAML: {0}",

  "channel.name": "CalcDocs",
  "command.openTestFolder.title": "CalcDocs: Open Test Folder",
  "command.inlineCalc.openGuide.title": "Inline Calc Guide",
  "command.formulas.foldAll": "Fold All Formulas",
  "command.generateFormulaHeader.title": "Generate Formulas Header",
  "view.inlineCalcResults.name": "CalcDocs Inline Results",
  "config.formulaHeader.outputPath": "Path for generated C header with formula macros",
  "config.formulaHeader.includeResolvedValues": "Add resolved numeric value as comment next to each generated #define.",
  "command.generateCompileCommands.title": "Generate compile_commands.json for clangd"
};

/**
 * Simple template replacement for {0}, {1}, {2}, etc.
 */
function replacePlaceholders(template: string, args: (string | number | boolean)[]): string {
  return template.replace(/\{(\d+)\}/g, (match, index) => {
    const i = parseInt(index, 10);
    return args[i] !== undefined ? String(args[i]) : match;
  });
}

/**
 * Localizes a string using VSCode's built-in localization system.
 * First tries vscode.l10n.t, if no translation found (returns key unchanged),
 * falls back to messagesByKey.
 * 
 * @param key - The localization key (e.g., "statusBar.initializing")
 * @param args - Optional arguments to replace placeholders like {0}, {1}, etc.
 * @returns The localized string
 */
export function localize(key: string, ...args: (string | number | boolean)[]): string {
  // Try VSCode's built-in localization first
  const translated = vscode.l10n.t(key, ...args);
  
  // If vscode.l10n.t returns the key unchanged, no translation was found
  // Fall back to messagesByKey
  if (translated === key) {
    const fallback = fallbackEn[key];
    if (fallback && args.length > 0) {
      return replacePlaceholders(fallback, args);
    }
    return fallback ?? key;
  }
  
  return translated;
}

export function test_lang(ctx: vscode.ExtensionContext, console: vscode.OutputChannel) {
  const root = vscode.Uri.joinPath(ctx.extensionUri, '.');        // root del pacchetto estensione
  const l10nDir = vscode.Uri.joinPath(ctx.extensionUri, 'l10n');  // dove deve stare la cartella
  const lang = vscode.env.language;                                // locale attivo (es. "en", "it")

  const fallback = vscode.Uri.joinPath(l10nDir, 'bundle.l10n.json');
  const forLang = vscode.Uri.joinPath(l10nDir, `bundle.l10n.${lang}.json`);

  const toFsPath = (u: vscode.Uri) => (process.platform === 'win32' ? u.fsPath : u.fsPath);

  console.appendLine('EXT ROOT =' + toFsPath(root));
  console.appendLine('L10N DIR  =' + toFsPath(l10nDir));
  console.appendLine('LANG      =' + lang);
  console.appendLine('HAS fallback bundle =' + fs.existsSync(toFsPath(fallback)));
  console.appendLine('HAS lang bundle     =' + fs.existsSync(toFsPath(forLang)));
  console.appendLine("HAS L10N =" + typeof vscode.l10n?.t);

  // Test di risoluzione diretta della chiave
  console.appendLine(`T() PROBE =` + vscode.l10n.t('statusBar.initializing'));

  // (Facoltativo) prova anche a leggere/parsing del JSON per.appendLinegare eventuali errori
  try {
    if (fs.existsSync(toFsPath(fallback))) {
      const txt = fs.readFileSync(toFsPath(fallback), 'utf8');
      JSON.parse(txt); // se fallisce, il bundle è malformato
      console.appendLine('fallback bundle JSON parse: OK');
    }
  } catch (e) {
    console.appendLine('[ERROR] fallback bundle JSON parse: ERROR ' + e);
  }
}
