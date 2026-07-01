import * as vscode from "vscode";

import type { CalcDocsState } from "../core/state";
import {
  buildExplainModePayload,
  getActiveFormulaContext,
  getInspectionSymbol,
  type InspectionSymbol,
} from "./explainMode";
import { showInspectionExportReport } from "./exportReport";
import { showLocalFormulaHealthCheck } from "./healthCheck";
import { openExplainView } from "./ui/explainView";
import { FormulaInspectorView } from "./ui/inspectorView";

function symbolToMarkdown(symbol: InspectionSymbol): vscode.MarkdownString {
  const lines = [
    `### ${symbol.name}`,
    `- Value: \`${symbol.displayValue}\``,
  ];

  if (symbol.origin) {
    lines.push(`- Origin: \`${symbol.origin}\``);
  }

  const markdown = new vscode.MarkdownString(lines.join("\n"));
  markdown.isTrusted = false;
  markdown.supportHtml = false;
  return markdown;
}

function registerInlineSymbolTooltip(
  context: vscode.ExtensionContext,
  state: CalcDocsState
): void {
  const selector: vscode.DocumentSelector = [
    { language: "c", scheme: "file" },
    { language: "cpp", scheme: "file" },
    { language: "c", scheme: "untitled" },
    { language: "cpp", scheme: "untitled" },
    { language: "yaml", scheme: "file" },
    { language: "yaml", scheme: "untitled" },
  ];

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        if (!state.enabled) {
          return undefined;
        }

        const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_.]*/);
        if (!range) {
          return undefined;
        }

        const word = document.getText(range);
        const symbol = getInspectionSymbol(state, word);
        if (!symbol) {
          return undefined;
        }

        return new vscode.Hover(symbolToMarkdown(symbol), range);
      },
    })
  );
}

export function registerInspectionFeatures(
  context: vscode.ExtensionContext,
  state: CalcDocsState
): void {
  const inspectorView = new FormulaInspectorView(context, state);
  context.subscriptions.push(inspectorView);

  // Notifica l'inspector ogni volta che cambia l'editor attivo,
  // così mantiene memoria dell'ultimo editor valido anche quando
  // il pannello webview ha il focus.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      inspectorView.notifyEditorChanged(editor);
    })
  );

  // Notifica anche il cambio di selezione (cursore) all'interno del documento
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor.document.uri.scheme === "file") {
        inspectorView.notifyEditorChanged(event.textEditor);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("calcdocs.inspection.openInspector", () => {
      inspectorView.open();
    }),

    vscode.commands.registerCommand("calcdocs.inspection.explainFormula", async () => {
      // Per explain, usa l'editor attivo OPPURE il lastValidEditor
      const activeEditor = vscode.window.activeTextEditor;
      const { entry, localEntries } = getActiveFormulaContext(state, activeEditor);
      if (!entry) {
        await vscode.window.showWarningMessage(
          "CalcDocs: select a formula or formula symbol to explain."
        );
        return;
      }

      openExplainView(context, buildExplainModePayload(state, entry, localEntries));
    }),

    vscode.commands.registerCommand("calcdocs.inspection.healthCheck", async () => {
      await showLocalFormulaHealthCheck(state);
    }),

    vscode.commands.registerCommand("calcdocs.inspection.exportReport", async () => {
      await showInspectionExportReport(state);
    })
  );

  registerInlineSymbolTooltip(context, state);
}