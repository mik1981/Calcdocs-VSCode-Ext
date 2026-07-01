import * as vscode from "vscode";

import type { CalcDocsState } from "../core/state";
import type { FormulaEntry } from "../types/FormulaEntry";
import {
  documentMatchesPath,
  formulaEntryMatchesDocument,
  formatValue,
  getDocumentFormulaContext,
} from "./explainMode";
import {
  analyzeParametricFormula,
  hasParametricUnitMismatch,
} from "./parametricAnalysis";

export type LocalHealthSeverity = "error" | "warning" | "info";

export type LocalHealthIssue = {
  severity: LocalHealthSeverity;
  category: "missing-symbol" | "invalid-value" | "unit-mismatch" | "diagnostic" | "parametric";
  formulaId?: string;
  line?: number;
  message: string;
};

export type LocalHealthReport = {
  activeDocument: string;
  checkedFormulaCount: number;
  issues: LocalHealthIssue[];
};

function issueSeverityFromText(message: string): LocalHealthSeverity {
  return /error|missing|unresolved|undefined|not defined|nan/i.test(message)
    ? "error"
    : /warning|mismatch/i.test(message)
      ? "warning"
      : "info";
}

function classifyMessage(message: string): LocalHealthIssue["category"] {
  if (/unit mismatch|dimension mismatch|output unit mismatch/i.test(message)) {
    return "unit-mismatch";
  }

  if (/missing|unresolved|undefined|not defined|unknown symbol/i.test(message)) {
    return "missing-symbol";
  }

  return "diagnostic";
}

function isMismatchOrInvalidMsg(message: string): boolean {
  return /unit mismatch|dimension mismatch|invalid.value|unresolved/i.test(message);
}

function hasComputedValueProblem(entry: FormulaEntry): boolean {
  if (typeof entry.valueCalc === "number") {
    return !Number.isFinite(entry.valueCalc);
  }

  return entry.valueCalc === null && Boolean(entry.formula || entry.exprType === "expr");
}

function addEntryMessages(
  issues: LocalHealthIssue[],
  entry: FormulaEntry,
  messages: readonly string[],
  fallbackSeverity: LocalHealthSeverity
): void {
  for (const message of messages) {
    const category = classifyMessage(message);
    issues.push({
      severity:
        category === "unit-mismatch"
          ? "warning"
          : issueSeverityFromText(message) || fallbackSeverity,
      category,
      formulaId: entry.key,
      line: typeof entry._line === "number" ? entry._line + 1 : undefined,
      message,
    });
  }
}

function addFormulaIssues(
  issues: LocalHealthIssue[],
  entries: readonly FormulaEntry[],
  state: CalcDocsState,
  localEntries?: ReadonlyMap<string, FormulaEntry>
): void {
  for (const entry of entries) {
    const errors = entry.evaluationErrors ?? [];
    const warnings = entry.evaluationWarnings ?? [];

    // Se la formula ha errori di mismatch/invalid-value che potrebbero
    // essere spiegati da parametri liberi, tenta l'analisi ipotetica.
    if (hasParametricUnitMismatch(entry)) {
      const analysis = analyzeParametricFormula(entry, state, localEntries);

      if (analysis.compatible === true) {
        // Falsi errori: dimensioni chiudono con ipotesi plausibili.
        // Rimuove i messaggi di mismatch/invalid-value, aggiunge info.
        const realErrors = errors.filter((m) => !isMismatchOrInvalidMsg(m));
        const realWarnings = warnings.filter((m) => !isMismatchOrInvalidMsg(m));

        // Segnala anche invalid-value solo se valueCalc è davvero null
        // PER RAGIONI DIVERSE dal mismatch (es. simboli mancanti non-dimensionali)
        // — in questo caso è già coperto da realErrors.

        addEntryMessages(issues, entry, realErrors, "error");
        addEntryMessages(issues, entry, realWarnings, "warning");

        // Aggiunge l'info parametrico
        issues.push({
          severity: "info",
          category: "parametric",
          formulaId: entry.key,
          line: typeof entry._line === "number" ? entry._line + 1 : undefined,
          message: analysis.message,
        });
        continue;
      }

      if (analysis.compatible === "unknown") {
        // Analisi inconcludente: mantieni gli errori originali ma
        // aggiunge una nota di contesto (info, non ulteriore errore).
        if (hasComputedValueProblem(entry)) {
          issues.push({
            severity: "error",
            category: "invalid-value",
            formulaId: entry.key,
            line: typeof entry._line === "number" ? entry._line + 1 : undefined,
            message: `Existing evaluation value is ${formatValue(entry.valueCalc, entry.unit)}.`,
          });
        }
        addEntryMessages(issues, entry, errors, "error");
        addEntryMessages(issues, entry, warnings, "warning");
        issues.push({
          severity: "info",
          category: "parametric",
          formulaId: entry.key,
          line: typeof entry._line === "number" ? entry._line + 1 : undefined,
          message: `Parametric analysis inconclusive: ${analysis.reason}`,
        });
        continue;
      }

      // compatible === false: tutte le unità note ma non chiudono → errore reale
    }

    // Percorso normale: nessun mismatch parametrico rilevato
    if (hasComputedValueProblem(entry)) {
      issues.push({
        severity: "error",
        category: "invalid-value",
        formulaId: entry.key,
        line: typeof entry._line === "number" ? entry._line + 1 : undefined,
        message: `Existing evaluation value is ${formatValue(entry.valueCalc, entry.unit)}.`,
      });
    }

    addEntryMessages(issues, entry, errors, "error");
    addEntryMessages(issues, entry, warnings, "warning");
  }
}

function addYamlDiagnostics(
  state: CalcDocsState,
  document: vscode.TextDocument,
  issues: LocalHealthIssue[]
): void {
  if (!documentMatchesPath(document, state.lastYamlPath)) {
    return;
  }

  for (const diagnostic of state.yamlDiagnostics) {
    issues.push({
      severity: diagnostic.severity,
      category: classifyMessage(diagnostic.message),
      formulaId: diagnostic.symbol,
      line: diagnostic.line + 1,
      message: diagnostic.message,
    });
  }
}

function dedupeIssues(issues: readonly LocalHealthIssue[]): LocalHealthIssue[] {
  const seen = new Set<string>();
  const result: LocalHealthIssue[] = [];

  for (const issue of issues) {
    const key = [
      issue.severity,
      issue.category,
      issue.formulaId ?? "",
      issue.line ?? "",
      issue.message,
    ].join("\u0000");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(issue);
  }

  return result;
}

export function buildLocalFormulaHealthCheck(
  state: CalcDocsState,
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor
): LocalHealthReport | undefined {
  if (!editor) {
    return undefined;
  }

  // getDocumentFormulaContext gestisce sia il file YAML indicizzato
  // globalmente sia eventuali altri formula*.yaml nel workspace, tramite
  // parsing locale del documento attivo. localEntries è necessario per
  // l'analisi parametrica: permette di trovare unità di simboli definiti
  // nello stesso file ma non nel formulaIndex globale.
  const { entries, localEntries } = getDocumentFormulaContext(state, editor);
  const issues: LocalHealthIssue[] = [];

  addFormulaIssues(issues, entries, state, localEntries);
  addYamlDiagnostics(state, editor.document, issues);

  const visibleIssues = dedupeIssues(issues).filter((issue) => {
    if (!issue.formulaId) {
      return true;
    }
    // Per le entry locali (non nel formulaIndex globale) il filtro
    // per-documento non si applica: sono già del documento corrente.
    const entry = state.formulaIndex.get(issue.formulaId);
    if (!entry) return true;
    return formulaEntryMatchesDocument(state, entry, editor.document);
  });

  return {
    activeDocument: editor.document.fileName,
    checkedFormulaCount: entries.length,
    issues: visibleIssues,
  };
}

function severityRank(severity: LocalHealthSeverity): number {
  if (severity === "error") {
    return 0;
  }
  if (severity === "warning") {
    return 1;
  }
  return 2;
}

export function localHealthCheckToMarkdown(report: LocalHealthReport): string {
  const sortedIssues = [...report.issues].sort((left, right) => {
    const severity = severityRank(left.severity) - severityRank(right.severity);
    if (severity !== 0) {
      return severity;
    }
    // I parametric vanno in fondo agli info
    if (left.category === "parametric" && right.category !== "parametric") return 1;
    if (right.category === "parametric" && left.category !== "parametric") return -1;
    return (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER);
  });

  const realIssues = sortedIssues.filter((i) => i.category !== "parametric");
  const parametricIssues = sortedIssues.filter((i) => i.category === "parametric");

  const counts = {
    error: realIssues.filter((i) => i.severity === "error").length,
    warning: realIssues.filter((i) => i.severity === "warning").length,
    info: realIssues.filter((i) => i.severity === "info").length,
  };

  const lines: string[] = [
    "# CalcDocs Local Formula Health Check",
    "",
    `Document: \`${report.activeDocument}\``,
    `Formulas checked: ${report.checkedFormulaCount}`,
    `Issues: ${counts.error} error, ${counts.warning} warning, ${counts.info} info`,
  ];

  if (parametricIssues.length > 0) {
    lines.push(`Parametric formulas: ${parametricIssues.length} (dimensional analysis with assumed units)`);
  }

  if (realIssues.length === 0 && parametricIssues.length === 0) {
    lines.push("", "No health issues are present in the current computed state.");
    return `${lines.join("\n")}\n`;
  }

  if (realIssues.length > 0) {
    lines.push("", "## Issues");
    for (const issue of realIssues) {
      const location = issue.line ? `L${issue.line}` : "current document";
      const formula = issue.formulaId ? ` \`${issue.formulaId}\`` : "";
      lines.push(
        `- **${issue.severity}** ${location}${formula} (${issue.category}): ${issue.message}`
      );
    }
  }

  if (parametricIssues.length > 0) {
    lines.push("", "## Parametric Formulas");
    lines.push(
      "> Dimensional analysis assumed plausible units for free parameters.",
      "> No errors — add explicit `unit:` declarations to remove this note."
    );
    for (const issue of parametricIssues) {
      const location = issue.line ? `L${issue.line}` : "current document";
      const formula = issue.formulaId ? ` \`${issue.formulaId}\`` : "";
      lines.push(`- **ℹ** ${location}${formula}: ${issue.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function showLocalFormulaHealthCheck(
  state: CalcDocsState
): Promise<void> {
  const report = buildLocalFormulaHealthCheck(state);
  if (!report) {
    await vscode.window.showWarningMessage("CalcDocs: open a document to run a local health check.");
    return;
  }

  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: localHealthCheckToMarkdown(report),
  });
  await vscode.window.showTextDocument(document, { preview: false });
}