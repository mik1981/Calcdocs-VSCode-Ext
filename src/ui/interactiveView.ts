import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { evaluateInlineCalcs } from "../core/inlineCalc";
import type { CalcDocsState } from "../core/state";
import type { FormulaEntry as CoreFormulaEntry } from "../types/FormulaEntry";
import { parseFormulaDocument } from "../formulaOutline/formulaParser";
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
 * Verifica se c'è contenuto calcolabile sufficiente per aprire la Interactive View.
 * Restituisce false se il file attivo non è rilevante o non contiene formule.
 */
export function hasInteractiveContent(
  editor: vscode.TextEditor | undefined,
  state: CalcDocsState
): boolean {
  // Nessun editor aperto: controlla se lo stato ha già voci indicizzate
  if (!editor || editor.document.uri.scheme !== "file") {
    return Array.from(state.formulaIndex.values()).some(isFormulaLikeEntry);
  }

  const languageId = editor.document.languageId;
  const fileName   = editor.document.fileName.toLowerCase();
  const relativePath = path.relative(state.workspaceRoot, editor.document.uri.fsPath);

  // ── File C/C++ ──────────────────────────────────────────────────────────
  if (isCppLanguage(languageId)) {
    // Controllo rapido: cerca almeno un'assegnazione @variable = ...
    // senza eseguire la valutazione completa.
    return /@[A-Za-z_][A-Za-z0-9_]*\s*=/.test(editor.document.getText());
  }

  // ── File YAML ───────────────────────────────────────────────────────────
  if (/^ya?ml$/i.test(languageId)) {
    // Se ci sono già voci indicizzate per questo file, è sufficiente.
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
  return Boolean(entry.formula) || entry.valueYaml !== undefined || entry.valueCalc !== undefined;
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
  const outline = parseFormulaDocument(
    editor.document.getText().split(/\r?\n/),
    relativePath
  );

  return outline.map((formula): CoreFormulaEntry => ({
    key: formula.id,
    unit: formula.unit || undefined,
    formula: formula.expr || undefined,
    exprType: formula.expr ? "expr" : "const",
    steps: [],
    labels: [],
    valueYaml: formula.value,
    valueCalc: formula.value ?? null,
    _filePath: relativePath,
    _line: formula.lineStart,
  }));
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
      // 1. Puliamo l'espressione rimuovendo i caratteri '@'
      const expression = normalizeInlineExpression(result.expression).trim();

      // Ricava il nome: usa result.variable se disponibile,
      // altrimenti estrae la parte sinistra dell'assegnazione
      // rimuovendo caratteri di commento (// /* * @) e spazi.
      const rawKey = result.variable
        ? result.variable.replace(/@/g, "").trim()
        : result.source
            .split('=')[0]
            .replace(/[/@*]/g, " ")   // sostituisce /  @  * con spazio
            .trim()
            .replace(/\s+/g, "_")     // normalizza spazi interni
            || `inline_${result.line}`;

      const key = rawKey.replace(/@/g, "").trim();
      if (!key || seen.has(key)) return null;
      seen.add(key);

      const isPureConstant = /^-?\d+(\.\d+)?([eE][+-]?\d+)?(\s*[A-Za-z%][A-Za-z0-9_%/^*.-]*)?$/.test(expression);
      const exprType = isPureConstant ? "const" : "expr";

      // Per costanti pure (es. "5 mm", "9.81 m/s2") estrai l'unità dall'espressione
      // se l'evaluator non l'ha già fornita in outputUnit.
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
        // Se è una costante numerica pura, non passiamo la formula stringa per evitare che il motore la blocchi
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

  // ── Priorità 1: file C/C++ con calc inline nei commenti.
  // Le entry inline vengono aggiunte sopra al state completo (che contiene
  // tutti i simboli indicizzati: #define, YAML, ecc.) così i riferimenti
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

  // ── Priorità 2: entry indicizzate del file corrente (non-C, o C senza inline)
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

  // ── Priorità 3: YAML aperto direttamente nell'editor (transient parse)
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

  // ── Priorità 4: tutte le entry indicizzate del workspace
  if (allIndexedEntries.length > 0) {
    const engine = new InteractiveFormulaEngine(state);
    return {
      entries: allIndexedEntries,
      formulas: buildInteractiveFormulaEntries(state, allIndexedEntries, engine),
      engine,
    };
  }

  // ── Priorità 5: inline calcs generici per qualsiasi tipo di file
  if (editor) {
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

  refreshHtml(vscode.window.activeTextEditor);

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
