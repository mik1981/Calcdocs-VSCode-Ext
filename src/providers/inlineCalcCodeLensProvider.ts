import * as vscode from "vscode";

import { evaluateInlineCalcs, type InlineCalcResult } from "../core/inlineCalc";
import { CalcDocsState } from "../core/state";

const CODELENS_MAX_TITLE_LEN = 160;
const CODELENS_SOURCE_PREVIEW_LEN = 80;
const INLINE_CALC_GHOST_LANGUAGES = new Set(["c", "cpp", "plaintext", "yaml"]);

function clampText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max - 3)}...`;
}

function buildCodeLensTitle(result: InlineCalcResult, state: CalcDocsState): string {
  if (state.uiInvasiveness === "minimal") {
    if (result.severity === "error") {
      return clampText(`CalcDocs: ERROR (${result.error ?? "unresolved"})`, CODELENS_MAX_TITLE_LEN);
    }

    if (result.severity === "warning") {
      return clampText(
        `CalcDocs: WARNING (${result.warnings[0] ?? "dimension warning"})`,
        CODELENS_MAX_TITLE_LEN
      );
    }

    return clampText(`CalcDocs: ${result.displayValue}`, CODELENS_MAX_TITLE_LEN);
  }

  const sourcePreview = clampText(result.source, CODELENS_SOURCE_PREVIEW_LEN);

  if (result.severity === "error") {
    return clampText(
      `CalcDocs: ${sourcePreview} -> ERROR (${result.error ?? "unresolved"})`,
      CODELENS_MAX_TITLE_LEN
    );
  }

  if (result.severity === "warning") {
    const warning = result.warnings[0] ?? "dimension warning";
    return clampText(
      `CalcDocs: ${sourcePreview} -> WARNING (${warning})`,
      CODELENS_MAX_TITLE_LEN
    );
  }

  const verboseSuffix =
    state.uiInvasiveness === "verbose" ? ` [${result.dimensionText}]` : "";
  return clampText(`CalcDocs: ${sourcePreview} -> ${result.displayValue}${verboseSuffix}`, CODELENS_MAX_TITLE_LEN);
}

/**
 * Shows inline calculation results for comment-based expressions:
 * - @name = ...
 * - = expression
 */
export class InlineCalcCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly state: CalcDocsState) {}

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.state.enabled || !this.state.inlineCodeLens.enabled) {
      return [];
    }

    const maxItemsPerFile = Math.max(1, this.state.inlineCodeLens.maxItemsPerFile);
    const results = evaluateInlineCalcs(document.getText(), this.state, {
      includeAssignments: true,
    }, document.languageId);
    const lenses: vscode.CodeLens[] = [];

    for (const result of results) {
      if (lenses.length >= maxItemsPerFile) {
        break;
      }

      // Skip if ghost takes priority on this line
      if (this.state.inlineGhostEnabled && INLINE_CALC_GHOST_LANGUAGES.has(document.languageId)) {
        continue;
      }

      lenses.push(
        new vscode.CodeLens(new vscode.Range(result.line, 0, result.line, 0), {
          title: buildCodeLensTitle(result, this.state),
          command: "",
        })
      );
    }

    return lenses;
  }
}

export function registerInlineCalcCodeLensProvider(
  context: vscode.ExtensionContext,
  provider: InlineCalcCodeLensProvider
): void {
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "c", scheme: "file" },
        { language: "cpp", scheme: "file" },
        { language: "c", scheme: "untitled" },
        { language: "cpp", scheme: "untitled" },
        { language: "plaintext", scheme: "file" },
        { language: "yaml", scheme: "file" },
        { language: "yaml", scheme: "untitled" },
      ],
      provider
    )
  );
}
