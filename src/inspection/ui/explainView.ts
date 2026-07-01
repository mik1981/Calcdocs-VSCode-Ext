import * as vscode from "vscode";

import type { ExplainModePayload, InspectionSymbol } from "../explainMode";

function escapeHtml(value: string | undefined): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSymbol(symbol: InspectionSymbol): string {
  const origin = symbol.origin
    ? `<span class="muted">${escapeHtml(symbol.origin)}</span>`
    : `<span class="muted">origin unavailable</span>`;

  return `<li>
    <div class="row">
      <code>${escapeHtml(symbol.name)}</code>
      <strong>${escapeHtml(symbol.displayValue)}</strong>
    </div>
    <div class="meta">${escapeHtml(symbol.source)} - ${origin}</div>
  </li>`;
}

function renderList(items: readonly string[], emptyText: string): string {
  if (items.length === 0) {
    return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  }

  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function buildExplainHtml(webview: vscode.Webview, payload: ExplainModePayload): string {
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
  ].join("; ");

  const expression = payload.formula.expression
    ? `<pre>${escapeHtml(payload.formula.expression)}</pre>`
    : `<p class="muted">No raw expression is present in the current formula entry.</p>`;

  const expanded = payload.formula.expanded
    ? `<section><h2>Expanded</h2><pre>${escapeHtml(payload.formula.expanded)}</pre></section>`
    : "";

  const symbols = payload.knownSymbols.length > 0
    ? `<ul class="symbols">${payload.knownSymbols.map(renderSymbol).join("")}</ul>`
    : `<p class="muted">No resolved symbol list is present in the current computed state.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 18px 20px 28px;
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family, "Segoe UI", sans-serif);
  font-size: var(--vscode-font-size, 13px);
  line-height: 1.45;
}
header {
  border-bottom: 1px solid var(--vscode-panel-border);
  margin-bottom: 18px;
  padding-bottom: 14px;
}
h1, h2 {
  font-size: 1rem;
  margin: 0 0 10px;
  font-weight: 650;
}
h1 {
  font-size: 1.25rem;
}
section {
  margin: 18px 0;
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
ul {
  margin: 0;
  padding-left: 18px;
}
.value {
  font-size: 1.05rem;
}
.muted, .meta {
  color: var(--vscode-descriptionForeground);
}
.symbols {
  list-style: none;
  padding: 0;
}
.symbols li {
  border-top: 1px solid var(--vscode-panel-border);
  padding: 8px 0;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}
.row strong {
  text-align: right;
}
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(payload.formula.id)}</h1>
    <div class="value">Final value: <strong>${escapeHtml(payload.finalValue)}</strong></div>
    ${
      payload.formula.sourceFile
        ? `<div class="muted">${escapeHtml(payload.formula.sourceFile)}${
            payload.formula.sourceLine ? `:${payload.formula.sourceLine}` : ""
          }</div>`
        : ""
    }
  </header>
  <section>
    <h2>Expression</h2>
    ${expression}
  </section>
  ${expanded}
  <section>
    <h2>Existing Evaluation Steps</h2>
    ${renderList(payload.steps, "No explain steps are present in the current computed state.")}
  </section>
  <section>
    <h2>Known Symbols</h2>
    ${symbols}
  </section>
  ${
    payload.formula.errors.length > 0
      ? `<section><h2>Errors</h2>${renderList(payload.formula.errors, "")}</section>`
      : ""
  }
  ${
    payload.formula.warnings.length > 0
      ? `<section><h2>Warnings</h2>${renderList(payload.formula.warnings, "")}</section>`
      : ""
  }
  ${
    payload.notes.length > 0
      ? `<section><h2>Notes</h2>${renderList(payload.notes, "")}</section>`
      : ""
  }
</body>
</html>`;
}

export function openExplainView(
  context: vscode.ExtensionContext,
  payload: ExplainModePayload
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "calcdocsExplainMode",
    `Explain: ${payload.formula.id}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: false,
      retainContextWhenHidden: true,
    }
  );

  panel.webview.html = buildExplainHtml(panel.webview, payload);
  context.subscriptions.push(panel);
  return panel;
}
