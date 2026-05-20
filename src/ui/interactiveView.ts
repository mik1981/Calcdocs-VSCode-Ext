import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

import { CalcDocsState } from '../core/state';
import { evaluateExpression, type EvaluationContext } from '../engine/evaluator';
import { evaluateInlineCalcs } from '../core/inlineCalc';
import { parseFormulaDocument } from '../formulaOutline/formulaParser';
import { hasUnit, Quantity, DIMENSIONLESS } from '../engine/units';

import type {
  FormulaEntry,
  FormulaTreeNode,
  FormulaInputNode,
  EvalStep,
  EvaluationState,
  HistoryEntry,
  InteractiveSnapshot,
  ExtensionToWebviewMsg,
  WebviewToExtensionMsg,
  CalcDocsInitialData,
} from './webview-types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildInputNode(name: string, state: CalcDocsState): FormulaInputNode {
  const childFormula = state.formulaIndex.get(name);

  return {
    name,
    unit: state.symbolUnits.get(name),
    defaultValue: state.symbolValues.get(name),
    hasDefault: state.symbolValues.has(name),
    kind: childFormula?.formula ? 'formula' : 'leaf',
  };
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function extractIdentifiersFromFormula(formula: string): Set<string> {
  const identifiers = new Set<string>();
  const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\b(?!\()/g;
  let match;
  while ((match = regex.exec(formula)) !== null) {
    const id = match[1];
    if (['csv', 'defined', 'ifdef', 'ifndef'].includes(id.toLowerCase())) continue;
    if (hasUnit(id)) continue;
    identifiers.add(id);
  }
  return identifiers;
}

function normalizeInlineExpression(expression: string): string {
  return expression.replace(/@([A-Za-z_]\w*)/g, '$1');
}

// ─── Dependency tree ──────────────────────────────────────────────────────────

function buildDependencyTree(
  name: string,
  state: CalcDocsState,
  visited = new Set<string>(),
  depth = 0
): FormulaTreeNode {
  const formula = state.formulaIndex.get(name);

  if (!formula?.formula) {
    return {
      id: name,
      name,
      depth,
      expression: '',
      unit: state.symbolUnits.get(name),
      localInputs: [ buildInputNode(name, state) ],
      children: [],
    };
  }

  if (visited.has(name)) {
    return {
      id: name,
      name,
      depth,
      expression: formula.formula,
      unit: formula.unit,
      localInputs: [],
      children: [],
    };
  }

  visited.add(name);

  const identifiers = Array.from(extractIdentifiersFromFormula(formula.formula));
  const children: FormulaTreeNode[] = [];
  const localInputs: FormulaInputNode[] = [];

  for (const id of identifiers) {
    localInputs.push(buildInputNode(id, state))
    
    const childFormula = state.formulaIndex.get(id);
    if (childFormula?.formula) {
      children.push(buildDependencyTree(id, state, new Set(visited), depth + 1));
    }
  }

  console.log("FORMULA", formula.formula);
  console.log("IDENTIFIERS", identifiers);
  console.log("LOCAL INPUTS", localInputs); 
  
  return {
    id: name,
    name,
    depth,
    expression: formula.formula,
    unit: formula.unit,
    localInputs,
    children,
  };
}

// ─── Formula node builder ─────────────────────────────────────────────────────

function buildFormulaNodes(
  editor: vscode.TextEditor | undefined,
  state: CalcDocsState
): FormulaEntry[] {

  if (editor) {
    const relativePath = path.relative(state.workspaceRoot, editor.document.uri.fsPath);
    const yamlEntries = Array.from(state.formulaIndex.values()).filter(
      (entry) =>
        entry._filePath === relativePath &&
        (entry.formula || entry.valueYaml !== undefined)
    );

    if (yamlEntries.length > 0) {
      return yamlEntries.map((entry) => {
        const tree = buildDependencyTree(entry.key, state, new Set(), 0);
        return {
          id: entry.key,
          name: entry.key,
          expression: entry.formula ?? String(entry.valueYaml ?? entry.valueCalc ?? 0),
          unit: entry.unit,
          localInputs: tree.localInputs, // <-- Assegna alla root
          tree,
          line: entry._line !== undefined ? entry._line + 1 : undefined,
          type: entry.formula ? 'formula' : 'constant',
        };
      });
    }

    if (/^ya?ml$/i.test(editor.document.languageId)) {
      const outline = parseFormulaDocument(
        editor.document.getText().split(/\r?\n/),
        relativePath
      );
      if (outline.length > 0) {
        return outline.map((f) => {
          const expr = f.expr || (f.value !== undefined ? String(f.value) : '');
          const identifiers = Array.from(extractIdentifiersFromFormula(expr));
          const localInputs = identifiers.map(n => buildInputNode(n, state));

          return {
            id: f.id,
            name: f.id,
            expression: expr,
            unit: f.unit,
            localInputs, // <-- Assegna alla root
            tree: {
              id: f.id,
              name: f.id,
              expression: expr,
              unit: f.unit,
              depth: 0,
              localInputs,
              children: [],
            },
            line: f.line !== undefined ? f.line + 1 : undefined,
            type: f.expr ? 'formula' : 'constant',
          };
        });
      }
    }

    const inlineResults = evaluateInlineCalcs(
      editor.document.getText(),
      state,
      { includeAssignments: true, includeSuppressed: true },
      editor.document.languageId
    );

    if (inlineResults.length > 0) {
      return inlineResults.map((result) => {
        const expression = normalizeInlineExpression(result.expression);
        const identifiers = Array.from(extractIdentifiersFromFormula(expression));
        const id = `inline-${result.line}-${result.kind}-${result.variable ?? 'calc'}`;
        const name = result.variable ? `@${result.variable}` : `calc:${result.line + 1}`;
        const localInputs = identifiers.map(n => buildInputNode(n, state));

        return {
          id,
          name,
          expression,
          unit: result.outputUnit,
          localInputs, // <-- Assegna alla root
          tree: {
            id,
            name,
            expression,
            unit: result.outputUnit,
            depth: 0,
            localInputs,
            children: [],
          },
          line: result.line + 1,
          type: result.variable ? 'formula' : 'constant',
        };
      });
    }
  }

  return Array.from(state.formulaIndex.values())
    .filter((entry) => entry.formula || entry.valueYaml !== undefined)
    .map((entry) => {
      const tree = buildDependencyTree(entry.key, state, new Set(), 0);
      return {
        id: entry.key,
        name: entry.key,
        expression: entry.formula ?? String(entry.valueYaml ?? entry.valueCalc ?? 0),
        unit: entry.unit,
        localInputs: tree.localInputs, // <-- Assegna alla root
        tree,
        line: entry._line !== undefined ? entry._line + 1 : undefined,
        type: entry.formula ? 'formula' : 'constant',
      };
    });
}

// ─── Evaluation engine ────────────────────────────────────────────────────────

function buildExecutionOrder(formulaId: string, formulas: FormulaEntry[]): string[] {
  const order: string[] = [];
  const visited = new Set<string>();

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);

    const f = formulas.find((x) => x.id === id);
    if (!f) return;

    const deps = Array.from(extractIdentifiersFromFormula(f.expression));
    for (const dep of deps) {
      if (formulas.find((x) => x.id === dep)) {
        visit(dep);
      }
    }
    order.push(id);
  }

  visit(formulaId);
  return order;
}

/**
 * Evaluate a formula forward (bottom-up). Returns the final value, all
 * intermediate values, and a step trace.
 */
function evaluateFormulaWithState(
  formulaId: string,
  params: Record<string, number>,
  state: CalcDocsState,
  formulas: FormulaEntry[]
): { value: number | null; error?: string; steps: EvalStep[]; allValues: Record<string, number> } {
  const steps: EvalStep[] = [];
  const allValues: Record<string, number> = {};

  try {
    const execOrder = buildExecutionOrder(formulaId, formulas);
    const internalMap = new Map<string, Quantity>();

    // Seed from params (user overrides) and state defaults
    for (const [k, v] of Object.entries(params)) {
      internalMap.set(k, {
        valueSi: v,
        dimension: DIMENSIONLESS,
      });

      allValues[k] = v;
    }

    // 2. Seed from state defaults for any dependencies that are not formulas themselves
    const allRequired = new Set<string>();
    for (const id of execOrder) {
      const entry = formulas.find(f => f.id === id);
      if (entry) {
        extractIdentifiersFromFormula(entry.expression).forEach(dep => allRequired.add(dep));
      }
    }

    for (const id of allRequired) {
      // ✅ PRIORITÀ PARAMS
      if (params[id] !== undefined) {
        internalMap.set(id, {
          valueSi: params[id],
          dimension: DIMENSIONLESS,
        });
        allValues[id] = params[id];
        continue;
      }

      // ✅ fallback default
      if (!formulas.find(f => f.id === id)) {
        const defVal = state.symbolValues.get(id);
        if (typeof defVal === 'number') {
          internalMap.set(id, {
            valueSi: defVal,
            dimension: DIMENSIONLESS,
          });
          allValues[id] = defVal;
        }
      }
    }

    const context: EvaluationContext = {
      resolveIdentifier: (name: string) => internalMap.get(name),
    };

    for (const id of execOrder) {
      const entry = formulas.find(f => f.id === id);
      if (!entry?.expression) continue;

      const result = evaluateExpression(entry.expression, context);
      if (result.ok) {
        const numVal =
          typeof result.quantity.valueSi === 'number'
            ? result.quantity.valueSi
            : Number(result.quantity.valueSi);

        // Build resolved expression (substitute known values)
        let resolved = entry.expression;
        for (const [k, v] of internalMap) {
          if (typeof v.valueSi === 'number') {
            resolved = resolved.replace(
              new RegExp(`\\b${k}\\b`, 'g'),
              v.valueSi.toPrecision(6).replace(/\.?0+$/, '')
            );
          }
        }

        steps.push({
          name: id,
          expression: entry.expression,
          resolved,
          result: numVal,
          unit: entry.unit,
        });

        internalMap.set(id, result.quantity);
        allValues[id] = numVal;
      }
    }

    const finalQuantity = internalMap.get(formulaId);
    if (finalQuantity !== undefined && typeof finalQuantity.valueSi === 'number') {
      return { value: finalQuantity.valueSi, steps, allValues };
    }

    return { value: null, error: `Cannot evaluate "${formulaId}"`, steps, allValues };
  } catch (err) {
    return {
      value: null,
      error: err instanceof Error ? err.message : String(err),
      steps,
      allValues,
    };
  }
}

// ─── Inverse solver (Newton-Raphson) ─────────────────────────────────────────

/**
 * Given a target output value, find the value of `solveFor` (one of the
 * formula's inputs) that makes the formula evaluate to `targetOutput`.
 *
 * Uses Newton-Raphson with a finite-difference Jacobian.
 */
function inverseSolve(
  formulaId: string,
  params: Record<string, number>,
  targetOutput: number,
  solveFor: string,
  state: CalcDocsState,
  formulas: FormulaEntry[]
): { value: number | null; error?: string; steps: EvalStep[]; allValues: Record<string, number> } {
  const MAX_ITER = 60;
  const TOL = 1e-9;
  const H = 1e-7; // finite-difference step

  // Initial guess: use existing param value, or 1.0 as fallback
  let x = params[solveFor] ?? (state.symbolValues.get(solveFor) as number | undefined) ?? 1.0;

  // Guard: if x is 0, shift to avoid zero-derivative traps
  if (Math.abs(x) < 1e-12) x = 0.1;

  function evalAt(xVal: number) {
    const testParams = { ...params, [solveFor]: xVal };
    return evaluateFormulaWithState(formulaId, testParams, state, formulas);
  }

  let lastSteps: EvalStep[] = [];
  let lastAllValues: Record<string, number> = {};

  for (let i = 0; i < MAX_ITER; i++) {
    const fx = evalAt(x);
    if (fx.value === null) {
      return { value: null, error: fx.error ?? 'Evaluation failed', steps: lastSteps, allValues: lastAllValues };
    }
    lastSteps = fx.steps;
    lastAllValues = fx.allValues;

    const residual = fx.value - targetOutput;
    if (Math.abs(residual) < TOL) break;

    // Finite-difference derivative df/dx
    const fxh = evalAt(x + H);
    if (fxh.value === null) {
      return { value: null, error: 'Derivative evaluation failed', steps: lastSteps, allValues: lastAllValues };
    }

    const derivative = (fxh.value - fx.value) / H;

    if (Math.abs(derivative) < 1e-15) {
      return {
        value: null,
        error: `Formula output is not sensitive to "${solveFor}". Choose a different parameter to solve for.`,
        steps: lastSteps,
        allValues: lastAllValues,
      };
    }

    const step = residual / derivative;
    x = x - step;

    // Damping: avoid runaway steps
    if (!Number.isFinite(x)) {
      return { value: null, error: 'Solver diverged — try a different starting value.', steps: lastSteps, allValues: lastAllValues };
    }
  }

  // Final evaluation with the solved x
  const finalResult = evalAt(x);
  return {
    value: x,
    error: finalResult.error,
    steps: finalResult.steps,
    allValues: { ...finalResult.allValues, [solveFor]: x },
  };
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildWebviewHtml(
  webview: vscode.Webview,
  extensionPath: string,
  nonce: string,
  initialData: CalcDocsInitialData
): string {
  const htmlPath = path.join(extensionPath, 'resources', 'calcdocs-webview.html');

  if (!fs.existsSync(htmlPath)) {
    return `<!DOCTYPE html><html><body style="font-family:monospace;color:#ccc;padding:20px;">
      <h3>⚠️ CalcDocs WebView not found</h3>
      <p>The file <code>resources/calcdocs-webview.html</code> is missing.</p>
    </body></html>`;
  }

  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(/PLACEHOLDER_NONCE/g, nonce);

  const initialScript = `<script nonce="${nonce}">
    window.__CALCDOCS_INITIAL = ${JSON.stringify(initialData)};
  </script>`;
  html = html.replace('<!-- INJECT_INITIAL_JSON -->', initialScript);

  const cspSource = webview.cspSource;
  const csp = [
    `default-src 'none'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${cspSource} https://cdn.jsdelivr.net`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
  ].join('; ');

  html = html.replace(
    /<meta http-equiv="Content-Security-Policy"[^>]*>/,
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`
  );

  return html;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function openInteractiveView(
  context: vscode.ExtensionContext,
  state: CalcDocsState
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'calcdocsInteractiveView',
    'CalcDocs — Interactive View',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, 'resources', 'webview')),
      ],
    }
  );

  let currentFormulas: FormulaEntry[] = [];
  let selectedFormulaId: string | null = null;

  /** Full modification history (auto). */
  const history: HistoryEntry[] = [];
  /** User-named snapshots. */
  const snapshots = new Map<string, InteractiveSnapshot>();

  // ── Helpers ────────────────────────────────────────────────────────────────

  function pushHistory(entry: HistoryEntry) {
    // Keep the last 100 entries
    history.unshift(entry);
    if (history.length > 100) history.pop();

    const msg: ExtensionToWebviewMsg = {
      action: 'historyUpdated',
      entries: history.slice(0, 50),
    };
    panel.webview.postMessage(msg);
  }

  // ── Refresh (full HTML rebuild) ────────────────────────────────────────────

  function refresh(editor?: vscode.TextEditor) {
    const target = editor ?? vscode.window.activeTextEditor;
    currentFormulas = buildFormulaNodes(target, state);

    const prevId = selectedFormulaId;
    selectedFormulaId =
      currentFormulas.find((f) => f.id === prevId)?.id ??
      currentFormulas[0]?.id ??
      null;

    const initialData: CalcDocsInitialData = {
      formulas: currentFormulas,
      selectedFormulaId,
      activeFileName: target?.document.fileName ?? '',
    };

    const nonce = generateNonce();
    panel.webview.html = buildWebviewHtml(
      panel.webview,
      context.extensionPath,
      nonce,
      initialData
    );
  }

  function sendUpdate() {
    const msg: ExtensionToWebviewMsg = {
      action: 'updateFormulas',
      formulas: currentFormulas,
      selectedFormulaId,
      activeFileName: vscode.window.activeTextEditor?.document.fileName ?? '',
    };
    panel.webview.postMessage(msg);
  }

  // ── Initial render ─────────────────────────────────────────────────────────

  // Capture the active editor at the moment the command is launched
  const initialEditor = vscode.window.activeTextEditor;
  refresh(initialEditor);

  // Ignore active-editor changes for a short period after opening the webview.
  // This avoids replacing the initial formula set while VS Code settles focus.
  const interactiveOpenTime = Date.now();

  // Schedule an explicit update after the webview has time to initialize listeners
  setTimeout(() => {
    if (selectedFormulaId) {
      const msg: ExtensionToWebviewMsg = {
        action: 'forceSelect',
        formulaId: selectedFormulaId,
      };
      panel.webview.postMessage(msg);
    }
  }, 300);

  // ── Watchers ───────────────────────────────────────────────────────────────

  const activeEditorWatcher = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (Date.now() - interactiveOpenTime < 1000) {
      return;
    }

    if (editor === undefined) return;

    currentFormulas = buildFormulaNodes(editor, state);
    selectedFormulaId = currentFormulas[0]?.id ?? null;
    sendUpdate();
  });

  const documentWatcher = vscode.workspace.onDidChangeTextDocument((event) => {
    const editor = vscode.window.activeTextEditor;
    if (editor && event.document.uri.toString() === editor.document.uri.toString()) {
      currentFormulas = buildFormulaNodes(editor, state);
      sendUpdate();
    }
  });

  // ── Message handler ────────────────────────────────────────────────────────

  panel.webview.onDidReceiveMessage(
    (message: WebviewToExtensionMsg) => {
      switch (message.action) {

      // ── Forward evaluation ──────────────────────────────────────────────────
      case 'evaluate': {
        const result = evaluateFormulaWithState(
          message.formulaId,
          message.params,
          state,
          currentFormulas
        );

        const msg: ExtensionToWebviewMsg = {
          action: 'result',
          value: result.value,
          error: result.error,
          steps: result.steps,
          allValues: result.allValues,
        };
        panel.webview.postMessage(msg);
        pushHistory({
          id: generateId(),
          ts: Date.now(),
          formulaId: message.formulaId,
          changedParam: Object.keys(message.params)[0] ?? 'eval',
          changedValue: Object.values(message.params)[0] ?? 0,
          direction: 'forward',
          state: {
            params: { ...message.params },
            results: result.allValues,
          },
          result: result.value,
          steps: result.steps,
        });
        break;
      }

      // ── Inverse solve ───────────────────────────────────────────────────────
      case 'inverseSolve': {
        const result = inverseSolve(
          message.formulaId,
          message.params,
          message.targetOutput,
          message.solveFor,
          state,
          currentFormulas
        );

        const msg: ExtensionToWebviewMsg = {
          action: 'inverseResult',
          targetParam: message.solveFor,
          newValue: result.value ?? NaN,
          error: result.error,
          steps: result.steps,
          allValues: result.allValues,
        };
        panel.webview.postMessage(msg);

        // Push to history if successful
        if (result.value !== null) {
          pushHistory({
            id: generateId(),
            ts: Date.now(),
            formulaId: message.formulaId,
            changedParam: message.solveFor,
            changedValue: result.value,
            direction: 'inverse',
            state: {
              params: { ...message.params, [message.solveFor]: result.value },
              results: result.allValues,
            },
            result: message.targetOutput,
            steps: result.steps,
          });
        }
        break;
      }

      // ── Save snapshot ───────────────────────────────────────────────────────
      case 'saveSnapshot': {
        const id = `snap-${Date.now()}`;
        const result = evaluateFormulaWithState(
          message.formulaId,
          message.params,
          state,
          currentFormulas
        );
        const snapshot: InteractiveSnapshot = {
          id,
          ts: Date.now(),
          formulaId: message.formulaId,
          params: message.params,
          note: message.note,
          result: result.value,
          steps: result.steps,
        };
        snapshots.set(id, snapshot);

        const msg: ExtensionToWebviewMsg = { action: 'snapshotSaved', snapshot };
        panel.webview.postMessage(msg);
        break;
      }

      // ── Request full history ────────────────────────────────────────────────
      case 'requestHistory': {
        const msg: ExtensionToWebviewMsg = {
          action: 'history',
          entries: history.slice(0, 50),
        };
        panel.webview.postMessage(msg);
        break;
      }

      // ── Restore a history entry ─────────────────────────────────────────────
      case 'loadHistoryEntry': {
        const entry = history.find((h) => h.id === message.id);
        if (!entry) break;

        // Re-evaluate with the restored state to get fresh allValues
        const result = evaluateFormulaWithState(
          entry.formulaId,
          entry.state.params,
          state,
          currentFormulas
        );

        // Reuse the snapshot restore path in the webview
        const snap: InteractiveSnapshot = {
          id: entry.id,
          ts: entry.ts,
          formulaId: entry.formulaId,
          params: entry.state.params,
          result: result.value,
          steps: result.steps,
        };
        const msg: ExtensionToWebviewMsg = { action: 'loadSnapshot', snapshot: snap };
        panel.webview.postMessage(msg);
        break;
      }

      // ── Restore a named snapshot ────────────────────────────────────────────
      case 'loadSnapshot': {
        const snap = snapshots.get(message.id);
        if (!snap) break;
        selectedFormulaId = snap.formulaId;
        const msg: ExtensionToWebviewMsg = { action: 'loadSnapshot', snapshot: snap };
        panel.webview.postMessage(msg);
        break;
      }

      // ── Clear history ───────────────────────────────────────────────────────
      case 'clearHistory': {
        history.length = 0;
        const msg: ExtensionToWebviewMsg = { action: 'historyUpdated', entries: [] };
        panel.webview.postMessage(msg);
        break;
      }

      case 'exportPdf': {
        vscode.window.showInformationMessage('Export PDF not yet implemented.');
        break;
      }
      } // end switch
    },
    undefined,
    context.subscriptions
  );

  // ── Dispose ────────────────────────────────────────────────────────────────

  panel.onDidDispose(() => {
    activeEditorWatcher.dispose();
    documentWatcher.dispose();
  });

  return panel;
}