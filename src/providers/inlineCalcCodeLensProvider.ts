import * as vscode from "vscode";

import { evaluateInlineCalcsInLineRanges, isTrivialAssignExpression, type InlineCalcResult } from "../core/inlineCalc";
import { CalcDocsState } from "../core/state";
import {
  CODELENS_DENSE_LINE_ITEM_LIMIT,
  countItemsByLine,
  debugViewportLog,
  filterItemsToViewport,
  getMaxItemsPerViewport,
  getVisibleRangesForDocument,
  toViewportLineRanges,
  viewportRangesKey,
  VIEWPORT_REFRESH_DEBOUNCE_MS,
  padLineRanges
} from "../core/viewport";
import { shouldRenderInlineCalcGhostForResult } from "../core/ghostPolicy";

const CODELENS_MAX_TITLE_LEN = 160;
const CODELENS_SOURCE_PREVIEW_LEN = 80;
const INLINE_CALC_GHOST_LANGUAGES = new Set(["c", "cpp"]);

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
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly state: CalcDocsState) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorVisibleRanges(() => {
        this.scheduleRefresh();
      })
    );
  }

  refresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    this.emitter.fire();
  }

  scheduleRefresh(delayMs = VIEWPORT_REFRESH_DEBOUNCE_MS): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.emitter.fire();
    }, delayMs);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.emitter.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.state.enabled || !this.state.inlineCodeLens.enabled) {
      return [];
    }

    const visibleRanges = getVisibleRangesForDocument(document);
    const lineRanges = toViewportLineRanges(document, visibleRanges);
    if (lineRanges.length === 0) {
      debugViewportLog(this.state, "codelens.inline", {
        uri: document.uri.toString(),
        totalItems: 0,
        itemsFilteredByViewport: 0,
        itemsRendered: 0,
        ranges: "",
      });
      return [];
    }

    const paddedLineRanges = padLineRanges(lineRanges, document.lineCount, 3);
    const maxItemsPerViewport = getMaxItemsPerViewport(this.state.inlineCodeLens, 30);
    const results = evaluateInlineCalcsInLineRanges(
      document,
      this.state,
      { includeAssignments: true },
      document.languageId,
      paddedLineRanges   
    );
    const viewportResults = filterItemsToViewport(results, paddedLineRanges);
    const lineResultCounts = countItemsByLine(viewportResults);
    const lenses: vscode.CodeLens[] = [];
    const ghostCanRender = this.state.inlineGhostEnabled && INLINE_CALC_GHOST_LANGUAGES.has(document.languageId);

    for (const result of viewportResults) {
      if (lenses.length >= maxItemsPerViewport) {
        break;
      }

      if (ghostCanRender && shouldRenderInlineCalcGhostForResult(result, this.state)) {
        continue;
      }

      if (result.kind === "assign" && isTrivialAssignExpression(result.expression)) {
        continue;
      }

      lenses.push(
        new vscode.CodeLens(new vscode.Range(result.line, 0, result.line, 0), {
          title: buildCodeLensTitle(result, this.state),
          command: "",
        })
      );
    }

    debugViewportLog(this.state, "codelens.inline", {
      uri: document.uri.toString(),
      totalItems: results.length,
      itemsFilteredByViewport: results.length - viewportResults.length,
      itemsRendered: lenses.length,
      ranges: viewportRangesKey(lineRanges),
      denseLines: Array.from(lineResultCounts.values()).filter((count) => count > CODELENS_DENSE_LINE_ITEM_LIMIT).length,
    });

    return lenses;
  }
}

export function registerInlineCalcCodeLensProvider(
  context: vscode.ExtensionContext,
  provider: InlineCalcCodeLensProvider
): void {
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "c", scheme: "file" },
        { language: "cpp", scheme: "file" },
        { language: "c", scheme: "untitled" },
        { language: "cpp", scheme: "untitled" },
      ],
      provider
    )
  );
}
