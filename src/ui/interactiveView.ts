import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { evaluateInlineCalcs } from "../core/inlineCalc";
import type { CalcDocsState } from "../core/state";
import type { FormulaEntry as CoreFormulaEntry } from "../types/FormulaEntry";
import { parseFormulaDocument } from "../formulaOutline/formulaParser";
import * as yaml from "js-yaml";
import { evaluateYamlDocument } from "../engine/yamlEngine";
import {
  InteractiveFormulaEngine,
  buildInteractiveFormulaEntries,
} from "./interactiveFormulaEngine";
import type {
  CalcDocsInitialData,
  ExtensionToWebviewMsg,
  FormulaEntry,
  WebviewToExtensionMsg,
} from "./webview-types";
import { extractFormulasFromCpp, isCppLanguage, isCppExtension } from "../extractors/cppFormulaExtractor";

type FormulaViewModel = {
  entries: CoreFormulaEntry[];
  formulas: FormulaEntry[];
  engine: InteractiveFormulaEngine;
};

/**
 * Check if there is enough computable content to open the Interactive View.
 * Returns false if the active file is not relevant or contains no formulas.
 */
export function hasInteractiveContent(
  editor: vscode.TextEditor | undefined,
  state: CalcDocsState
): boolean {
  // No open editor: check if the state already has indexed entries
  if (!editor || editor.document.uri.scheme !== "file") {
    return Array.from(state.formulaIndex.values()).some(isFormulaLikeEntry);
  }

  const languageId = editor.document.languageId;
  const fileName   = editor.document.fileName.toLowerCase();
  const relativePath = path.relative(state.workspaceRoot, editor.document.uri.fsPath);

  // ── File C/C++ ──────────────────────────────────────────────────────────
  if (isCppLanguage(languageId)) {
    // Quick check: look for at least one @variable = ... assignment
    // without running the full evaluation.
    return /@[A-Za-z_][A-Za-z0-9_]*\s*=/.test(editor.document.getText());
  }

  // ── File YAML ───────────────────────────────────────────────────────────
  if (/^ya?ml$/i.test(languageId)) {
    // If there are already indexed entries for this file, that is sufficient.
    const hasIndexed = Array.from(state.formulaIndex.values())
      .some(e => e._filePath === relativePath && isFormulaLikeEntry(e));
    if (hasIndexed) return true;

    // Per i file formula*.yaml, tenta un parsing leggero.
    if (/formula.*\.ya?ml$/i.test(fileName)) {
      const outline = parseFormulaDocument(
        editor.document.getText().split(/\r?\n/),
        relativePath
      );
      return outline.length > 0;
    }

    return false;
  }

  return false;
}

/**
 * Aggiorna il context key VS Code usato dal menu view/title
 * per mostrare/nascondere il bottone "Open Interactive View".
 * Da chiamare ad ogni cambio di editor attivo o modifica del documento.
 */
export function refreshInteractiveViewContext(
  editor: vscode.TextEditor | undefined,
  state: CalcDocsState
): void {
  const has = hasInteractiveContent(editor, state);
  vscode.commands.executeCommand(
    "setContext",
    "calcdocs.hasInteractiveContent",
    has
  );
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

function normalizeInlineExpression(expression: string): string {
  // return expression.replace(/@([A-Za-z_]\w*)/g, "$1");
  return expression.replace(/@([A-Za-z_][A-Za-z0-9_.]*)/g, "$1");
}

function isYamlEditor(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
  if (!editor) {
    return false;
  }

  return /^ya?ml$/i.test(editor.document.languageId);
}

function isFormulaLikeEntry(entry: CoreFormulaEntry): boolean {
  return Boolean(entry.formula) || entry.valueYaml !== undefined || entry.valueYamlList !== undefined || entry.valueCalc !== undefined;
}

function cloneStateWithFormulaEntries(
  state: CalcDocsState,
  entries: CoreFormulaEntry[],
  rawText?: string,
  yamlPath?: string
): CalcDocsState {
  const formulaIndex = new Map<string, CoreFormulaEntry>(state.formulaIndex);
  for (const entry of entries) {
    formulaIndex.set(entry.key, entry);
  }

  return {
    ...state,
    formulaIndex,
    lastYamlRaw: rawText ?? state.lastYamlRaw,
    lastYamlPath: yamlPath ?? state.lastYamlPath,
  };
}

function buildTransientYamlEntries(
  editor: vscode.TextEditor,
  state: CalcDocsState
): CoreFormulaEntry[] {
  const relativePath = path.relative(state.workspaceRoot, editor.document.uri.fsPath);
  const rawText = editor.document.getText();
  const outline = parseFormulaDocument(rawText.split(/\r?\n/), relativePath);

  // Try to evaluate the transient YAML to obtain ranges/tolerance propagation
  let evaluatedSymbols: Map<string, any> | undefined = undefined;
  try {
    const parsedRoot = yaml.load(rawText) as Record<string, unknown> | undefined;
    if (parsedRoot && typeof parsedRoot === "object") {
      const evalResult = evaluateYamlDocument(parsedRoot, {
        rawText,
        yamlPath: editor.document.uri.fsPath,
        externalValues: state.symbolValues,
        externalUnits: state.symbolUnits,
        csvTables: state.csvTables,
      });
      evaluatedSymbols = evalResult.symbols;
    }
  } catch {
    // ignore evaluation errors for transient parse - keep entries basic
  }

  return outline.map((formula): CoreFormulaEntry => {
    const evaluated = evaluatedSymbols?.get(formula.id as string);
    const entry: CoreFormulaEntry = {
      key: formula.id,
      unit: formula.unit || undefined,
      formula: formula.expr || undefined,
      exprType: formula.expr ? "expr" : "const",
      steps: [],
      labels: [],
      valueYaml: formula.value,
      valueYamlList: formula.values,
      valueCalc: evaluated && typeof evaluated.value === "number" ? evaluated.value : (formula.value ?? null),
      _filePath: relativePath,
      _line: formula.lineStart,
    };

    if (evaluated) {
      if (evaluated.errors && evaluated.errors.length) {
        entry.evaluationErrors = [...evaluated.errors];
      }
      if (evaluated.warnings && evaluated.warnings.length) {
        entry.evaluationWarnings = [...evaluated.warnings];
      }
      if (evaluated.range) {
        entry.toleranceResult = {
          ...evaluated.range,
          source: evaluated.range.source,
        };
      }
    }

    return entry;
  });
}

function buildInlineEntries(
  editor: vscode.TextEditor,
  state: CalcDocsState
): CoreFormulaEntry[] {
  const inlineResults = evaluateInlineCalcs(
    editor.document.getText(),
    state,
    // includeSuppressed: false → rispetta #calcdocs-ignore-line e simili,
    // coerentemente con il comportamento del motore inline.
    { includeAssignments: true, includeSuppressed: false },
    editor.document.languageId
  );

  const seen = new Set<string>();

  return inlineResults
    .filter(result => {
      // Richiede un'assegnazione esplicita (@nome = ...).
      // Le espressioni standalone nei commenti (// = 25% * 200W -> W)
      // non hanno result.variable e vengono scartate: sono documentazione,
      // non parametri interattivi.
      if (!result.variable) return false;
      const src = result.source.trim();
      return src.includes('=') || src.includes('@');
    })
    .map((result): CoreFormulaEntry | null => {
      // 1. Clean the expression by removing '@' characters
      const expression = normalizeInlineExpression(result.expression).trim();

      // Ricava il nome: usa result.variable se disponibile,
      // altrimenti estrae la parte sinistra dell'assegnazione
      // rimuovendo caratteri di commento (// /* * @) e spazi.
      const rawKey = result.variable
        ? result.variable.replace(/@/g, "").trim()
        : result.source
            .split('=')[0]
            .replace(/[/@*]/g, " ")   // replaces /  @  * with space
            .trim()
            .replace(/\s+/g, "_")     // normalizes internal spaces
            || `inline_${result.line}`;

      const key = rawKey.replace(/@/g, "").trim();
      if (!key || seen.has(key)) return null;
      seen.add(key);

      const isPureConstant = /^-?\d+(\.\d+)?([eE][+-]?\d+)?(\s*[A-Za-z%][A-Za-z0-9_%/^*.-]*)?$/.test(expression);
      const exprType = isPureConstant ? "const" : "expr";

      // For pure constants (e.g. "5 mm", "9.81 m/s2") extract the unit from the expression
      // if the evaluator has not already provided it in outputUnit.
      let inferredUnit = result.outputUnit;
      if (isPureConstant && !inferredUnit) {
        const constUnitMatch = expression.match(
          /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?\s*([A-Za-z%][A-Za-z0-9_%/^*.\-]*)$/
        );
        if (constUnitMatch) {
          inferredUnit = constUnitMatch[1];
        }
      }

      return {
        key,
        unit: inferredUnit,
        // If it is a pure numeric constant, do not pass the formula string to avoid the engine blocking it
        formula: exprType === "const" ? undefined : expression,
        exprType,
        steps: [],
        labels: [],
        valueYaml: isPureConstant ? parseFloat(expression) : undefined,
        valueCalc: typeof result.value === "number" ? result.value : null,
        expanded: result.resolvedExpression,
        evaluationErrors: result.error ? [result.error] : undefined,
        _filePath: path.relative(state.workspaceRoot, editor.document.uri.fsPath),
        _line: result.line,
      };
    })
    .filter((entry): entry is CoreFormulaEntry => entry !== null);
}

function buildFormulaViewModel(
  editor: vscode.TextEditor | undefined,
  state: CalcDocsState
): FormulaViewModel {
  const relativePath =
    editor && editor.document.uri.scheme === "file"
      ? path.relative(state.workspaceRoot, editor.document.uri.fsPath)
      : undefined;

  // ── Priority 1: C/C++ file with inline calc in comments.
  // Le entry inline vengono aggiunte sopra al state completo (che contiene
  // all indexed symbols: #define, YAML, etc.) so references
  // @ADC_MAX, @NTC_R ecc. vengono risolti come input interattivi.
  if (editor && isCppLanguage(editor.document.languageId)) {
    const inlineEntries = buildInlineEntries(editor, state);
    if (inlineEntries.length > 0) {
      const transientState = cloneStateWithFormulaEntries(state, inlineEntries);
      const engine = new InteractiveFormulaEngine(transientState);
      return {
        entries: inlineEntries,
        formulas: buildInteractiveFormulaEntries(transientState, inlineEntries, engine),
        engine,
      };
    }
  }

  const allIndexedEntries = Array.from(state.formulaIndex.values())
    .filter(isFormulaLikeEntry);

  // ── Priority 2: indexed entries of the current file (non-C, or C without inline)
  if (relativePath) {
    const sameFileEntries = allIndexedEntries.filter(
      (entry) => entry._filePath === relativePath
    );

    if (sameFileEntries.length > 0) {
      const engine = new InteractiveFormulaEngine(state);
      return {
        entries: sameFileEntries,
        formulas: buildInteractiveFormulaEntries(state, sameFileEntries, engine),
        engine,
      };
    }
  }

  // ── Priority 3: YAML opened directly in the editor (transient parse)
  if (isYamlEditor(editor)) {
    const transientEntries = buildTransientYamlEntries(editor, state);
    if (transientEntries.length > 0) {
      const transientState = cloneStateWithFormulaEntries(
        state,
        transientEntries,
        editor.document.getText(),
        editor.document.uri.fsPath
      );
      const engine = new InteractiveFormulaEngine(transientState);
      return {
        entries: transientEntries,
        formulas: buildInteractiveFormulaEntries(transientState, transientEntries, engine),
        engine,
      };
    }
  }

  // ── Priority 4: all indexed entries of the workspace
  if (allIndexedEntries.length > 0) {
    const engine = new InteractiveFormulaEngine(state);
    return {
      entries: allIndexedEntries,
      formulas: buildInteractiveFormulaEntries(state, allIndexedEntries, engine),
      engine,
    };
  }

  // ── Priority 5: generic inline calcs for C/C++ files (non YAML)
  //     YAML files already have their handling in Priorities 2/3 via formulaIndex.
  if (editor && !isYamlEditor(editor)) {
    const inlineEntries = buildInlineEntries(editor, state);
    if (inlineEntries.length > 0) {
      const transientState = cloneStateWithFormulaEntries(state, inlineEntries);
      const engine = new InteractiveFormulaEngine(transientState);
      return {
        entries: inlineEntries,
        formulas: buildInteractiveFormulaEntries(transientState, inlineEntries, engine),
        engine,
      };
    }
  }

  const engine = new InteractiveFormulaEngine(state);
  return {
    entries: [],
    formulas: [],
    engine,
  };
}

function buildLoadingHtml(
  webview: vscode.Webview,
  nonce: string
): string {
  const cspSource = webview.cspSource;
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  height: 100vh; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 18px;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-font-family, "Segoe UI", system-ui, sans-serif);
  font-size: var(--vscode-font-size, 13px);
}
.logo { font-size: 1.05rem; font-weight: 700; font-family: var(--vscode-editor-font-family, Consolas, monospace); color: var(--vscode-focusBorder, #007acc); letter-spacing: 0.04em; }
.stage { font-size: 0.82rem; color: var(--vscode-descriptionForeground); min-height: 1.2em; text-align: center; }
.bar-track { width: 280px; height: 4px; background: rgba(128,128,128,0.18); border-radius: 2px; overflow: hidden; position: relative; }
.bar-fill { position: absolute; top: 0; left: 0; bottom: 0; width: 0%; background: var(--vscode-focusBorder, #007acc); border-radius: 2px; transition: width 400ms cubic-bezier(0.4, 0, 0.2, 1); }
.detail { font-size: 0.72rem; color: var(--vscode-descriptionForeground); opacity: 0.55; text-align: center; max-width: 280px; line-height: 1.4; }
</style>
</head>
<body>
<div class="logo">CalcDocs</div>
<div class="stage" id="stage">Initializing…</div>
<div class="bar-track"><div class="bar-fill" id="bar"></div></div>
<div class="detail" id="detail">Monte Carlo calculation in progress…</div>
<script nonce="${nonce}">
const stages = [
  { pct: 15, label: "Building dependency tree…", detail: "" },
  { pct: 40, label: "Starting Monte Carlo simulation…", detail: "N samples per input" },
  { pct: 70, label: "Computing output distribution…", detail: "uncertainty propagation" },
  { pct: 88, label: "Computing statistics (μ, σ, percentiles)…", detail: "almost ready" },
];
let idx = 0;
const stageEl = document.getElementById("stage");
const barEl = document.getElementById("bar");
const detailEl = document.getElementById("detail");
const delays = [300, 800, 1400, 2000];
function advance() {
  if (idx >= stages.length) return;
  const s = stages[idx++];
  if (stageEl) stageEl.textContent = s.label;
  if (barEl) barEl.style.width = s.pct + "%";
  if (detailEl && s.detail) detailEl.textContent = s.detail;
  if (idx < stages.length) setTimeout(advance, delays[idx - 1] || 1200);
}
setTimeout(advance, 100);
</script>
</body>
</html>`;
}

function buildWebviewHtml(
  webview: vscode.Webview,
  extensionPath: string,
  nonce: string,
  initialData: CalcDocsInitialData
): string {
  const htmlPath = path.join(extensionPath, "resources", "interactive_webview_class.html");

  if (!fs.existsSync(htmlPath)) {
    return `<!DOCTYPE html><html><body style="font-family:monospace;padding:20px;">
      <h3>CalcDocs WebView not found</h3>
      <p>The file <code>resources/interactive_webview_class.html</code> is missing.</p>
    </body></html>`;
  }

  let html = fs.readFileSync(htmlPath, "utf8");
  html = html.replace(/PLACEHOLDER_NONCE/g, nonce);

  const initialScript = `<script nonce="${nonce}">
    window.__CALCDOCS_INITIAL = ${JSON.stringify(initialData)};
  </script>`;
  html = html.replace("<!-- INJECT_INITIAL_JSON -->", initialScript);

  const cspSource = webview.cspSource;
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
  ].join("; ");

  html = html.replace(
    /<meta http-equiv="Content-Security-Policy"[^>]*>/,
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`
  );

  return html;
}

export function openInteractiveView(
  context: vscode.ExtensionContext,
  state: CalcDocsState
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "calcdocsInteractiveView",
    "CalcDocs - Interactive View",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "resources"))],
    }
  );

  // ── Show the loading screen immediately (before heavy computation) ──
  panel.webview.html = buildLoadingHtml(panel.webview, generateNonce());

  let viewModel: FormulaViewModel = buildFormulaViewModel(
    vscode.window.activeTextEditor,
    state
  );
  let selectedFormulaId: string | null = viewModel.formulas[0]?.id ?? null;

  function rebuild(editor?: vscode.TextEditor): void {
    viewModel = buildFormulaViewModel(editor ?? vscode.window.activeTextEditor, state);
    selectedFormulaId =
      viewModel.formulas.find((formula) => formula.id === selectedFormulaId)?.id ??
      viewModel.formulas[0]?.id ??
      null;
  }

  function postFormulaList(): void {
    const activeEditor = vscode.window.activeTextEditor;
    const msg: ExtensionToWebviewMsg = {
      action: "updateFormulas",
      formulas: viewModel.formulas,
      selectedFormulaId,
      activeFileName: activeEditor?.document.fileName ?? "",
    };
    panel.webview.postMessage(msg);
  }

  function postEvaluation(
    formulaId: string,
    inputs: Record<string, number>,
    changedId?: string
  ): void {
    selectedFormulaId = formulaId;
    const result = viewModel.engine.evaluate(formulaId, inputs, changedId);
    const msg: ExtensionToWebviewMsg = {
      action: "updateResult",
      values: result.values,
      units: result.units,
      errors: result.errors,
      warnings: result.warnings,
      active: result.active,
      propagation: result.propagation,
      tree: result.tree,
      params: inputs,
      steps: result.steps,
      last: result.last,
    };
    panel.webview.postMessage(msg);
  }

  function refreshHtml(editor?: vscode.TextEditor): void {
    rebuild(editor);
    const nonce = generateNonce();
    const activeEditor = editor ?? vscode.window.activeTextEditor;
    const initialData: CalcDocsInitialData = {
      formulas: viewModel.formulas,
      selectedFormulaId,
      activeFileName: activeEditor?.document.fileName ?? "",
    };

    panel.webview.html = buildWebviewHtml(
      panel.webview,
      context.extensionPath,
      nonce,
      initialData
    );
  }

  // ── Set the actual HTML using the already computed viewModel (avoids double compute) ──
  {
    const nonce = generateNonce();
    const activeEditor = vscode.window.activeTextEditor;
    const initialData: CalcDocsInitialData = {
      formulas: viewModel.formulas,
      selectedFormulaId,
      activeFileName: activeEditor?.document.fileName ?? "",
    };
    panel.webview.html = buildWebviewHtml(panel.webview, context.extensionPath, nonce, initialData);
  }

  const activeEditorWatcher = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor) {
      return;
    }

    rebuild(editor);
    postFormulaList();
  });

  const documentWatcher = vscode.workspace.onDidChangeTextDocument((event) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || event.document.uri.toString() !== editor.document.uri.toString()) {
      return;
    }

    rebuild(editor);
    postFormulaList();
  });

  panel.webview.onDidReceiveMessage((msg: WebviewToExtensionMsg) => {
    if (msg.action === "updateInput") {
      postEvaluation(msg.formulaId, msg.inputs, msg.changedId);
      return;
    }

    if (msg.action === "evaluate") {
      postEvaluation(msg.formulaId, msg.params);
    }
  });

  panel.onDidDispose(() => {
    activeEditorWatcher.dispose();
    documentWatcher.dispose();
  });

  return panel;
}
