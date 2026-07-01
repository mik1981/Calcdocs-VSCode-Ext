import * as vscode from "vscode";

import type { CalcDocsState } from "../core/state";
import {
  buildFormulaInspection,
  getDocumentFormulaContext,
  type FormulaInspection,
} from "./explainMode";

export type InspectionExportFormat = "markdown" | "json";

export type InspectionExportReport = {
  generatedAt: string;
  activeDocument: string;
  formulas: FormulaInspection[];
};

export function buildInspectionExportReport(
  state: CalcDocsState,
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor
): InspectionExportReport | undefined {
  if (!editor) {
    return undefined;
  }

  // getDocumentFormulaContext copre sia il file YAML indicizzato
  // globalmente sia eventuali altri formula*.yaml nel workspace, tramite
  // parsing locale del documento attivo quando necessario. localEntries
  // viene propagato a ogni formula così le dipendenze tra formule dello
  // stesso file locale vengono risolte correttamente nel report.
  const { entries, localEntries } = getDocumentFormulaContext(state, editor);
  const formulas = entries.map((entry) =>
    buildFormulaInspection(state, entry, localEntries)
  );

  return {
    generatedAt: new Date().toISOString(),
    activeDocument: editor.document.fileName,
    formulas,
  };
}

export function exportReportToJson(report: InspectionExportReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function exportReportToMarkdown(report: InspectionExportReport): string {
  const lines: string[] = [
    "# CalcDocs Formula Report",
    "",
    `Generated: \`${report.generatedAt}\``,
    `Document: \`${report.activeDocument}\``,
    `Formula count: ${report.formulas.length}`,
  ];

  if (report.formulas.length === 0) {
    lines.push("", "No formulas from the current computed state match this document.");
    return `${lines.join("\n")}\n`;
  }

  for (const formula of report.formulas) {
    lines.push("", `## ${formula.id}`, "");
    lines.push(`- Value: \`${formula.displayValue}\``);
    if (formula.unit) {
      lines.push(`- Unit: \`${formula.unit}\``);
    }
    if (formula.sourceFile) {
      const line = formula.sourceLine ? `:${formula.sourceLine}` : "";
      lines.push(`- Source: \`${formula.sourceFile}${line}\``);
    }
    if (formula.exprType) {
      lines.push(`- Type: \`${formula.exprType}\``);
    }

    if (formula.expression) {
      lines.push("", "Expression:", "```text", formula.expression, "```");
    }

    if (formula.expanded) {
      lines.push("", "Expanded:", "```text", formula.expanded, "```");
    }

    if (formula.resolvedSymbols.length > 0) {
      lines.push("", "Resolved symbols:");
      for (const symbol of formula.resolvedSymbols) {
        const origin = symbol.origin ? ` (${symbol.origin})` : "";
        lines.push(`- \`${symbol.name}\`: \`${symbol.displayValue}\`${origin}`);
      }
    }

    if (formula.errors.length > 0) {
      lines.push("", "Errors:");
      lines.push(...formula.errors.map((message) => `- ${message}`));
    }

    if (formula.warnings.length > 0) {
      lines.push("", "Warnings:");
      lines.push(...formula.warnings.map((message) => `- ${message}`));
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderReport(report: InspectionExportReport, format: InspectionExportFormat): string {
  return format === "json"
    ? exportReportToJson(report)
    : exportReportToMarkdown(report);
}

export async function showInspectionExportReport(
  state: CalcDocsState
): Promise<void> {
  const report = buildInspectionExportReport(state);
  if (!report) {
    await vscode.window.showWarningMessage("CalcDocs: open a document to export an inspection report.");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "Markdown",
        description: "Open a human-readable formula report",
        format: "markdown" as const,
      },
      {
        label: "JSON",
        description: "Open a structured formula report",
        format: "json" as const,
      },
    ],
    { placeHolder: "Export current document inspection data" }
  );

  if (!picked) {
    return;
  }

  const document = await vscode.workspace.openTextDocument({
    language: picked.format === "json" ? "json" : "markdown",
    content: renderReport(report, picked.format),
  });
  await vscode.window.showTextDocument(document, { preview: false });
}