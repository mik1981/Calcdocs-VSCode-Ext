import * as vscode from "vscode";

import { evaluateInlineCalcs } from "./inlineCalc";
import type { InlineCalcDiagnosticsLevel } from "./config";
import { CalcDocsState } from "./state";

const SUPPORTED_INLINE_LANGUAGES = new Set(["c", "cpp"]);

function isSupportedInlineDocument(document: vscode.TextDocument): boolean {
  if (!SUPPORTED_INLINE_LANGUAGES.has(document.languageId)) {
    return false;
  }

  return (
    document.uri.scheme === "file" ||
    document.uri.scheme === "untitled" ||
    document.uri.scheme === "vscode-userdata"
  );
}

function shouldReportSeverity(
  severity: "error" | "warning" | "info",
  level: InlineCalcDiagnosticsLevel
): boolean {
  if (level === "off") {
    return false;
  }

  if (level === "errors") {
    return severity === "error";
  }

  if (level === "warnings") {
    return severity === "error" || severity === "warning";
  }

  return true;
}

function toDiagnosticSeverity(
  severity: "error" | "warning" | "info"
): vscode.DiagnosticSeverity {
  if (severity === "error") {
    return vscode.DiagnosticSeverity.Error;
  }

  if (severity === "warning") {
    return vscode.DiagnosticSeverity.Warning;
  }

  return vscode.DiagnosticSeverity.Information;
}

function buildDiagnosticMessage(result: ReturnType<typeof evaluateInlineCalcs>[number]): string {
  if (result.severity === "error") {
    return `Inline calc: ${result.source} -> ${result.error ?? "unresolved expression"}`;
  }

  if (result.severity === "warning") {
    const warning = result.warnings[0] ?? "dimension warning";
    return `Inline calc: ${result.source} -> ${warning}`;
  }

  return `Inline calc: ${result.source} -> ${result.displayValue}`;
}

export function refreshInlineCalcDiagnosticsForDocument(
  document: vscode.TextDocument,
  state: CalcDocsState
): void {
  const diagnostics = state.inlineCalcDiagnostics;
  if (!diagnostics) {
    return;
  }

  if (
    !state.enabled ||
    state.inlineCalcDiagnosticsLevel === "off" ||
    !isSupportedInlineDocument(document)
  ) {
    diagnostics.delete(document.uri);
    return;
  }

  const results = evaluateInlineCalcs(document.getText(), state, {
    includeAssignments: true,
  }, document.languageId);
  const entries: vscode.Diagnostic[] = [];

  for (const result of results) {
    if (!shouldReportSeverity(result.severity, state.inlineCalcDiagnosticsLevel)) {
      continue;
    }

    const line = Math.max(0, Math.min(result.line, document.lineCount - 1));
    const range = document.lineAt(line).range;
    const diagnostic = new vscode.Diagnostic(
      range,
      buildDiagnosticMessage(result),
      toDiagnosticSeverity(result.severity)
    );
    diagnostic.source = "CalcDocs Inline";
    entries.push(diagnostic);
  }

  diagnostics.set(document.uri, entries);
}

export function refreshInlineCalcDiagnosticsForVisibleEditors(
  state: CalcDocsState
): void {
  for (const editor of vscode.window.visibleTextEditors) {
    refreshInlineCalcDiagnosticsForDocument(editor.document, state);
  }
}

export function clearInlineCalcDiagnostics(state: CalcDocsState): void {
  state.inlineCalcDiagnostics?.clear();
}
