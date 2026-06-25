import * as vscode from "vscode";

import { evaluateInlineCalcs } from "../core/inlineCalc";
import { CalcDocsState } from "../core/state";
import { buildCopyLink } from "../utils/hoverActions";

function isCommentishLine(lineText: string, languageId: string): boolean {
  const trimmed = lineText.trim();
  if (languageId === "yaml") {
    return trimmed.includes("#");
  }
  return (
    trimmed.includes("//") ||
    trimmed.includes("/*") ||
    trimmed.includes("*/") ||
    trimmed.startsWith("*")
  );
}

function buildHoverMarkdown(
  results: ReturnType<typeof evaluateInlineCalcs>,
  state: CalcDocsState
): vscode.MarkdownString {
  const lines: string[] = ["### CalcDocs Inline"];

  for (const result of results) {
    const kindLabel = result.kind === "assign" ? "@assign" : "=calc";
    lines.push(`- **${kindLabel}** \`${result.source}\``);
    lines.push(`  - Result: \`${result.displayValue}\``);
    if (result.value !== null) {
      lines.push(`  - ${buildCopyLink(String(result.value))}`);
    }
    if (state.inlineHover.showDimension) {
      lines.push(`  - Dimension: \`${result.dimensionText}\``);
    }
    if (result.error && state.inlineHover.showErrors) {
      lines.push(`  - Error: ${result.error}`);
    }
    if (!state.inlineHover.showWarnings) {
      continue;
    }

    for (const warning of result.warnings) {
      lines.push(`  - Warning: ${warning}`);
    }
  }

  const markdown = new vscode.MarkdownString(lines.join("\n"));
  markdown.isTrusted = true;
  markdown.supportHtml = true;
  return markdown;
}

export function registerInlineCalcHoverProvider(
  context: vscode.ExtensionContext,
  state: CalcDocsState
): void {
  const selector: vscode.DocumentSelector = [
    { language: "c", scheme: "file" },
    { language: "cpp", scheme: "file" },
    { language: "c", scheme: "untitled" },
    { language: "cpp", scheme: "untitled" },
  ];

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        if (!state.enabled || !state.inlineHover.enabled) {
          return undefined;
        }

        // New priority logic: skip if ghost or codelens takes precedence  
        const { showHover } = require("../core/ghostPolicy").getLineDisplayPriority(document, position.line, state);
        if (!showHover) {
          return undefined;
        }

        const lineText = document.lineAt(position.line).text;
        if (!isCommentishLine(lineText, document.languageId)) {
          return undefined;
        }

        const lineResults = evaluateInlineCalcs(document.getText(), state, {
          includeAssignments: true,
        }, document.languageId).filter((result) => result.line === position.line);
        if (lineResults.length === 0) {
          return undefined;
        }

        const markdown = buildHoverMarkdown(lineResults, state);
        const lineRange = document.lineAt(position.line).range;
        return new vscode.Hover(markdown, lineRange);
      },
    })
  );
}
