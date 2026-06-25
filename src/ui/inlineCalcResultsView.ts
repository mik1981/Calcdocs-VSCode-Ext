import * as vscode from "vscode";

import { evaluateInlineCalcs, type InlineCalcResult } from "../core/inlineCalc";
import { CalcDocsState } from "../core/state";
import type { FormulaRegistry } from "../formulaOutline/formulaRegistry";
import type { OutlineFormula } from "../formulaOutline/formulaParser";

const ITEM_SOURCE_MAX_LEN = 72;

function clampText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max - 3)}...`;
}

function createInfoItem(label: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon("info");
  return item;
}

function createGuideItem(): vscode.TreeItem {
  const item = new vscode.TreeItem(
    "Open Inline HTML Guide",
    vscode.TreeItemCollapsibleState.None
  );
  item.iconPath = new vscode.ThemeIcon("book");
  item.command = {
    command: "calcdocs.inlineCalc.openGuide",
    title: "Open inline guide",
  };
  item.tooltip = "CalcDocs: Open Inline Guide";
  return item;
}

function toItemIcon(result: InlineCalcResult): vscode.ThemeIcon {
  if (result.severity === "error") {
    return new vscode.ThemeIcon("error");
  }

  if (result.severity === "warning") {
    return new vscode.ThemeIcon("warning");
  }

  return new vscode.ThemeIcon(
    result.kind === "assign" ? "symbol-variable" : "symbol-number"
  );
}

function toFormulaItemIcon(formula: OutlineFormula): vscode.ThemeIcon {
  // Use different icons based on formula type
  if (formula.expr && formula.expr.length > 0) {
    return new vscode.ThemeIcon("symbol-function");
  }
  return new vscode.ThemeIcon("symbol-constant");
}

function isYamlFormulaFile(document: vscode.TextDocument): boolean {
  const fileName = document.fileName.toLowerCase();
  return (
    document.languageId === "yaml" &&
    /.*formulas.*\.ya?ml$/i.test(fileName)
  );
}

/**
 * Tree view provider used by the "CalcDocs Inline Results" mini panel.
 * Displays inline calc results for C/C++ files and formulas for YAML files.
 */
export class InlineCalcResultsViewProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private readonly emitter = new vscode.EventEmitter<void>();
  private activeDocument: vscode.TextDocument | undefined;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly state: CalcDocsState,
    private readonly formulaRegistry?: FormulaRegistry
  ) {}

  setActiveEditor(editor: vscode.TextEditor | undefined): void {
    this.activeDocument = editor?.document;
    this.refresh();
  }

  notifyDocumentChanged(document: vscode.TextDocument): void {
    if (!this.activeDocument) {
      return;
    }

    if (this.activeDocument.uri.toString() !== document.uri.toString()) {
      return;
    }

    this.refresh();
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) {
      return [];
    }

    const items: vscode.TreeItem[] = [];//[createGuideItem()];

    if (!this.state.enabled) {
      items.push(createInfoItem("CalcDocs is disabled"));
      return items;
    }

    if (!this.activeDocument) {
      items.push(createInfoItem("Open a C/C++ or YAML file to see results"));
      return items;
    }

    // Check if this is a YAML formulas file
    if (isYamlFormulaFile(this.activeDocument)) {
      return this.getFormulaItems(this.activeDocument);
    }

    // Inline calculations are only for C/C++ files
    if (this.activeDocument.languageId !== "c" && this.activeDocument.languageId !== "cpp") {
      items.push(createInfoItem("Inline calculations are only available in C/C++ files"));
      return items;
    }

    const results = evaluateInlineCalcs(
      this.activeDocument.getText(),
      this.state,
      {},
      this.activeDocument.languageId
    );

    if (results.length === 0) {
      items.push(createInfoItem("No inline calculations (= ...) or formulas file found (formula*.yaml)"));
      return items;
    }

    for (const result of results) {
      const lineLabel = `L${result.line + 1}`;
      const prefix = result.kind === "assign" ? "@" : "=";
      const label = `${lineLabel} ${prefix} ${clampText(
        result.source,
        ITEM_SOURCE_MAX_LEN
      )}`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.description =
        result.severity === "error"
          ? `ERROR: ${result.error ?? "unresolved"}`
          : result.severity === "warning"
            ? `WARN: ${result.warnings[0] ?? result.displayValue}`
            : result.displayValue;
      item.tooltip = [
        `${lineLabel}: ${result.source}`,
        `Result: ${result.displayValue}`,
        `Dimension: ${result.dimensionText}`,
        ...result.warnings.map((warning) => `Warning: ${warning}`),
        result.error ? `Error: ${result.error}` : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n");
      item.iconPath = toItemIcon(result);
      item.command = {
        command: "calcdocs.inlineCalc.openResult",
        title: "Open inline calc result",
        arguments: [this.activeDocument.uri, result.line],
      };
      items.push(item);
    }

    return items;
  }

  private getFormulaItems(document: vscode.TextDocument): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = [];

    if (!this.formulaRegistry) {
      items.push(createInfoItem("FormulaRegistry not initialized"));
      return items;
    }

    // Get formulas from the registry synchronously
    // Note: We use the internal formulas map directly via a workaround
    const formulas = this.formulaRegistry['formulas'].get(document.uri.toString()) ?? [];

    if (formulas.length === 0) {
      items.push(createInfoItem("No formulas found in this file"));
      return items;
    }

    for (const formula of formulas) {
      const lineLabel = `L${formula.lineStart + 1}`;
      const label = clampText(formula.id, ITEM_SOURCE_MAX_LEN);
      // const label = `${clampText(formula.id, ITEM_SOURCE_MAX_LEN)} (${lineLabel})`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

      // Show formula expression or value as description
      const description =
        formula.expr && formula.expr.length > 0
          ? `= ${clampText(formula.expr, ITEM_SOURCE_MAX_LEN)}`
          : formula.value !== undefined
            ? `${formula.value}${formula.unit ? ` ${formula.unit}` : ""}`
            : "—";

      //item.description = `${lineLabel} ${description}`;
      item.description = description;

      // Build tooltip with full information
      const tooltipLines = [
        `ID: ${formula.id}`,
        `Line: L${formula.lineStart + 1}`,
      ];

      if (formula.expr && formula.expr.length > 0) {
        tooltipLines.push(`Expression: ${formula.expr}`);
      }

      if (formula.unit) {
        tooltipLines.push(`Unit: ${formula.unit}`);
      }

      if (formula.value !== undefined) {
        tooltipLines.push(`Value: ${formula.value}`);
      }

      if (formula.desc) {
        tooltipLines.push(`Description: ${formula.desc}`);
      }

      item.tooltip = tooltipLines.join("\n");
      item.iconPath = toFormulaItemIcon(formula);

      // Command to navigate to the formula line
      item.command = {
        command: "calcdocs.inlineCalc.openResult",
        title: "Open formula",
        arguments: [document.uri, formula.lineStart],
      };

      items.push(item);
    }

    return items;
  }
}
