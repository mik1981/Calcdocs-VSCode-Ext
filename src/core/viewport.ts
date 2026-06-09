import * as vscode from "vscode";

import type { CalcDocsState } from "./state";

export type ViewportLineRange = {
  startLine: number;
  endLine: number;
};

export type LineTextSource = {
  lineCount: number;
  lineAt(line: number): { text: string };
};

export const VIEWPORT_REFRESH_DEBOUNCE_MS = 80;
export const CODELENS_DENSE_LINE_ITEM_LIMIT = 1;
export const GHOST_CACHE_MAX_ENTRIES = 48;

type ViewportLimitConfig = {
  maxItemsPerViewport?: number;
  maxItemsPerFile?: number;
};

function sameDocumentUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

export function padLineRanges(
  ranges: ViewportLineRange[],
  totalLines: number,
  pad: number
): ViewportLineRange[] {
  return ranges.map(({ startLine, endLine }) => ({
    startLine: Math.max(0, startLine - pad),
    endLine: Math.min(totalLines - 1, endLine + pad),
  }));
}

export function getMaxItemsPerViewport(
  config: ViewportLimitConfig,
  fallback: number
): number {
  const configured = config.maxItemsPerViewport ?? config.maxItemsPerFile ?? fallback;
  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : fallback;
}

export function getVisibleEditorsForDocument(
  document: vscode.TextDocument
): vscode.TextEditor[] {
  const editors = vscode.window.visibleTextEditors.filter((editor) =>
    sameDocumentUri(editor.document.uri, document.uri)
  );
  const activeEditor = vscode.window.activeTextEditor;

  if (
    activeEditor &&
    sameDocumentUri(activeEditor.document.uri, document.uri) &&
    !editors.some((editor) => editor === activeEditor)
  ) {
    return [activeEditor, ...editors];
  }

  return editors;
}

export function getVisibleRangesForDocument(
  document: vscode.TextDocument
): vscode.Range[] {
  const ranges: vscode.Range[] = [];

  for (const editor of getVisibleEditorsForDocument(document)) {
    ranges.push(...editor.visibleRanges);
  }

  return ranges;
}

export function toViewportLineRanges(
  document: { lineCount: number },
  ranges: readonly vscode.Range[]
): ViewportLineRange[] {
  if (document.lineCount <= 0 || ranges.length === 0) {
    return [];
  }

  const normalized = ranges
    .map((range) => ({
      startLine: Math.max(0, Math.min(document.lineCount - 1, range.start.line)),
      endLine: Math.max(0, Math.min(document.lineCount - 1, range.end.line)),
    }))
    .filter((range) => range.startLine <= range.endLine)
    .sort((left, right) => left.startLine - right.startLine);

  const merged: ViewportLineRange[] = [];

  for (const range of normalized) {
    const previous = merged[merged.length - 1];
    if (!previous || range.startLine > previous.endLine + 1) {
      merged.push({ ...range });
      continue;
    }

    previous.endLine = Math.max(previous.endLine, range.endLine);
  }

  return merged;
}

export function lineInViewportRanges(
  line: number,
  ranges: readonly ViewportLineRange[]
): boolean {
  return ranges.some((range) => line >= range.startLine && line <= range.endLine);
}

export function filterItemsToViewport<T extends { line: number }>(
  items: readonly T[],
  ranges: readonly ViewportLineRange[]
): T[] {
  if (ranges.length === 0) {
    return [];
  }

  return items.filter((item) => lineInViewportRanges(item.line, ranges));
}

export function countItemsByLine<T extends { line: number }>(
  items: readonly T[]
): Map<number, number> {
  const counts = new Map<number, number>();

  for (const item of items) {
    counts.set(item.line, (counts.get(item.line) ?? 0) + 1);
  }

  return counts;
}

export function viewportRangesKey(ranges: readonly ViewportLineRange[]): string {
  return ranges
    .map((range) => `${range.startLine}-${range.endLine}`)
    .join(",");
}

export function viewportDocumentCacheKey(
  document: vscode.TextDocument,
  ranges: readonly ViewportLineRange[]
): string {
  return `${document.uri.toString()}@${document.version}:${viewportRangesKey(ranges)}`;
}

export function debugViewportLog(
  state: CalcDocsState,
  scope: string,
  details: Record<string, unknown>
): void {
  state.output.debug(`[viewport.${scope}] ${JSON.stringify(details)}`);
}
