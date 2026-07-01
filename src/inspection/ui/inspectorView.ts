import * as vscode from "vscode";

import type { CalcDocsState } from "../../core/state";
import {
  buildFormulaInspection,
  getActiveFormulaContext,
  type FormulaInspection,
  type InspectionSymbol,
} from "../explainMode";

function escapeHtml(value: string | number | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSymbols(symbols: readonly InspectionSymbol[]): string {
  if (symbols.length === 0) {
    return `<p class="muted">No resolved symbols are present in the current state for this formula.</p>`;
  }

  return `<table>
    <thead><tr><th>Name</th><th>Value</th><th>Origin</th></tr></thead>
    <tbody>
      ${symbols.map((symbol) => `<tr>
        <td><code>${escapeHtml(symbol.name)}</code></td>
        <td>${escapeHtml(symbol.displayValue)}</td>
        <td class="muted">${escapeHtml(symbol.origin ?? symbol.source)}</td>
      </tr>`).join("")}
    </tbody>
  </table>`;
}

function renderMessages(title: string, messages: readonly string[]): string {
  if (messages.length === 0) {
    return "";
  }

  return `<section>
    <h2>${escapeHtml(title)}</h2>
    <ul>${messages.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul>
  </section>`;
}

function buildEmptyHtml(webview: vscode.Webview, message: string): string {
  return buildShellHtml(
    webview,
    `<main class="empty"><p>${escapeHtml(message)}</p></main>`
  );
}

function renderParametricNotes(notes: readonly string[]): string {
  if (notes.length === 0) return "";
  return `<section class="parametric-notes">
    <h2>Parametric Analysis</h2>
    <p class="parametric-label">ℹ Dimensional balance verified with assumed units</p>
    <ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
  </section>`;
}

function buildInspectorBody(formula: FormulaInspection): string {
  const expression = formula.expression
    ? `<pre>${escapeHtml(formula.expression)}</pre>`
    : `<p class="muted">No raw expression is present in this formula entry.</p>`;

  const isParametric = formula.parametricNotes.length > 0 && formula.value === null;
  const displayBadge = isParametric
    ? `<span class="badge-parametric">parametric</span>`
    : "";

  return `<main>
    <header>
      <h1>${escapeHtml(formula.id)} ${displayBadge}</h1>
      <div class="value">${escapeHtml(formula.displayValue)}</div>
      <div class="muted">
        ${formula.sourceFile ? escapeHtml(formula.sourceFile) : "source unavailable"}${
          formula.sourceLine ? `:${formula.sourceLine}` : ""
        }
      </div>
    </header>

    <section class="facts">
      <div><span>Type</span><strong>${escapeHtml(formula.exprType ?? "formula")}</strong></div>
      <div><span>Unit</span><strong>${escapeHtml(formula.unit ?? "-")}</strong></div>
      <div><span>Symbols</span><strong>${formula.resolvedSymbols.length}</strong></div>
    </section>

    <section>
      <h2>Expression</h2>
      ${expression}
    </section>

    ${
      formula.expanded
        ? `<section><h2>Expanded</h2><pre>${escapeHtml(formula.expanded)}</pre></section>`
        : ""
    }

    <section>
      <h2>Resolved Symbols</h2>
      ${renderSymbols(formula.resolvedSymbols)}
    </section>

    ${renderParametricNotes(formula.parametricNotes)}
    ${renderMessages("Errors", formula.errors)}
    ${renderMessages("Warnings", formula.warnings)}
  </main>`;
}

function buildShellHtml(webview: vscode.Webview, body: string): string {
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family, "Segoe UI", sans-serif);
  font-size: var(--vscode-font-size, 13px);
  line-height: 1.45;
}
main {
  padding: 16px 18px 28px;
}
.empty {
  min-height: 100vh;
  display: flex;
  align-items: center;
  color: var(--vscode-descriptionForeground);
}
header {
  border-bottom: 1px solid var(--vscode-panel-border);
  padding-bottom: 12px;
  margin-bottom: 14px;
}
h1, h2 {
  margin: 0 0 10px;
  font-weight: 650;
}
h1 {
  font-size: 1.2rem;
}
h2 {
  font-size: 0.95rem;
}
section {
  margin: 16px 0;
}
pre, code {
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
}
pre {
  margin: 0;
  padding: 10px 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--vscode-textCodeBlock-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  text-align: left;
  vertical-align: top;
  padding: 6px 4px;
  border-top: 1px solid var(--vscode-panel-border);
}
th {
  color: var(--vscode-descriptionForeground);
  font-weight: 600;
}
ul {
  margin: 0;
  padding-left: 18px;
}
.value {
  font-size: 1.1rem;
  font-weight: 700;
  margin-bottom: 4px;
}
.muted {
  color: var(--vscode-descriptionForeground);
}
.facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.facts div {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  padding: 8px;
  min-width: 0;
}
.facts span {
  display: block;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 3px;
}
.facts strong {
  overflow-wrap: anywhere;
}
.parametric-notes {
  border-left: 3px solid var(--vscode-editorInfo-foreground, #3794ff);
  padding-left: 10px;
  background: color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 8%, transparent);
  border-radius: 0 4px 4px 0;
}
.parametric-label {
  color: var(--vscode-editorInfo-foreground, #3794ff);
  font-weight: 600;
  margin-bottom: 6px;
}
.parametric-notes ul {
  margin-top: 4px;
}
.badge-parametric {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  padding: 1px 7px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 15%, transparent);
  color: var(--vscode-editorInfo-foreground, #3794ff);
  border: 1px solid var(--vscode-editorInfo-foreground, #3794ff);
  vertical-align: middle;
  margin-left: 6px;
}
</style>
</head>
<body>${body}</body>
</html>`;
}

export class FormulaInspectorView implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  
  // Ultimo editor valido (non-webview) memorizzato prima che il focus
  // passasse alla webview stessa.
  private lastValidEditor: vscode.TextEditor | undefined;
  // Ultimo id formula selezionata esplicitamente dall'utente
  private pinnedFormulaId: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: CalcDocsState
  ) {}

  /**
   * Chiamato da extension.ts ogni volta che cambia l'editor attivo.
   * Salviamo solo editor con schema "file" (non il pannello webview).
   */
  notifyEditorChanged(editor: vscode.TextEditor | undefined): void {
    if (editor && editor.document.uri.scheme === "file") {
      this.lastValidEditor = editor;
      // Se l'inspector è aperto, aggiorna il contenuto
      this.scheduleRefresh();
    }
  }

  open(): void {
    // Cattura l'editor corrente prima che la webview prenda il focus
    const currentEditor = vscode.window.activeTextEditor;
    if (currentEditor && currentEditor.document.uri.scheme === "file") {
      this.lastValidEditor = currentEditor;
    }

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.refresh();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "calcdocsFormulaInspector",
      "CalcDocs Formula Inspector",
      vscode.ViewColumn.Beside,
      {
        enableScripts: false,
        retainContextWhenHidden: true,
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.clearRefreshTimer();
    }, undefined, this.context.subscriptions);

    this.refresh();
  }

  scheduleRefresh(delayMs = 250): void {
    if (!this.panel) {
      return;
    }

    this.clearRefreshTimer();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, delayMs);
  }

  refresh(): void {
    if (!this.panel) {
      return;
    }

    if (!this.state.enabled) {
      this.panel.webview.html = buildEmptyHtml(
        this.panel.webview,
        "CalcDocs is disabled."
      );
      return;
    }

    // Cerca la formula usando il lastValidEditor memorizzato,
    // così funziona anche quando il focus è sulla webview. Con più file
    // formula*.yaml nel workspace, getActiveFormulaContext esegue parsing
    // locale del documento attivo quando necessario, e restituisce anche
    // la mappa delle formule dello stesso file locale, necessaria per
    // risolvere correttamente i simboli dipendenti.
    const { entry, localEntries } = getActiveFormulaContext(this.state, this.lastValidEditor);
    if (!entry) {
      // Fallback: prova con tutti gli entry nell'indice se ce n'è almeno uno
      const allEntries = Array.from(this.state.formulaIndex.values());
      if (allEntries.length > 0 && this.pinnedFormulaId) {
        const pinned = this.state.formulaIndex.get(this.pinnedFormulaId);
        if (pinned) {
          const formula = buildFormulaInspection(this.state, pinned);
          this.panel.webview.html = buildShellHtml(
            this.panel.webview,
            buildInspectorBody(formula)
          );
          return;
        }
      }

      this.panel.webview.html = buildEmptyHtml(
        this.panel.webview,
        "No formula selected. Place the cursor on a formula name in your YAML or C/C++ file."
      );
      return;
    }

    // Memorizza l'id così possiamo ripristinarlo se l'editor perde il focus
    this.pinnedFormulaId = entry.key;

    const formula = buildFormulaInspection(this.state, entry, localEntries);
    this.panel.webview.html = buildShellHtml(
      this.panel.webview,
      buildInspectorBody(formula)
    );
  }

  dispose(): void {
    this.clearRefreshTimer();
    this.panel?.dispose();
    this.panel = undefined;
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }
}