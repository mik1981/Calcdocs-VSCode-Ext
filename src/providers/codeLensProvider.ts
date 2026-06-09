import * as vscode from "vscode";

import { collectCppCodeLensItems, type CppCodeLensItem } from "../core/cppCodeLensItems";
import { shouldRenderGhostInsteadOfCodeLens } from "../core/ghostPolicy";
import { CalcDocsState } from "../core/state";
import {
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

function toCodeLens(item: CppCodeLensItem): vscode.CodeLens {
  return new vscode.CodeLens(new vscode.Range(item.line, 0, item.line, 0), {
    title: item.title,
    command: item.command ?? "",
    arguments: item.arguments,
  });
}

/**
 * Adds inline CodeLens hints above C/C++ symbol definitions.
 */
export class CppValueCodeLensProvider implements vscode.CodeLensProvider {
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
    if (!this.state.enabled || !this.state.cppCodeLens.enabled) {
      return [];
    }

    const visibleRanges = getVisibleRangesForDocument(document);
    const lineRanges = toViewportLineRanges(document, visibleRanges);
    if (lineRanges.length === 0) {
      debugViewportLog(this.state, "codelens.cpp", {
        uri: document.uri.toString(),
        totalItems: 0,
        itemsFilteredByViewport: 0,
        itemsRendered: 0,
        ranges: "",
      });
      return [];
    }
    const paddedLineRanges = padLineRanges(lineRanges, document.lineCount, 3);

    const maxItemsPerViewport = getMaxItemsPerViewport(this.state.cppCodeLens, 40);
    const items = collectCppCodeLensItems(
      document,
      this.state,
      maxItemsPerViewport * 4,
      { lineRanges: paddedLineRanges }
    );
    const viewportItems = filterItemsToViewport(items, paddedLineRanges);
    const lineItemCounts = countItemsByLine(viewportItems);
    const lenses: vscode.CodeLens[] = [];

    for (const item of viewportItems) {
      if (lenses.length >= maxItemsPerViewport) {
        break;
      }

      if (item.kind === "functionCall") {
        continue; // function-call items: ghost/hover only, never code lens
      }

      if (shouldRenderGhostInsteadOfCodeLens(document, item, this.state)) {
        continue;
      }

      lenses.push(toCodeLens(item));
    }

    debugViewportLog(this.state, "codelens.cpp", {
      uri: document.uri.toString(),
      totalItems: items.length,
      itemsFilteredByViewport: items.length - viewportItems.length,
      itemsRendered: lenses.length,
      ranges: viewportRangesKey(lineRanges),
      denseLines: Array.from(lineItemCounts.values()).filter((count) => count > 1).length,
    });

    return lenses;
  }
}

/**
 * Registers CodeLens provider for C/C++ (and plaintext file fallback).
 */
export function registerCppCodeLensProvider(
  context: vscode.ExtensionContext,
  provider: CppValueCodeLensProvider
): void {
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "c", scheme: "file" },
        { language: "cpp", scheme: "file" },
        { language: "c", scheme: "untitled" },
        { language: "cpp", scheme: "untitled" },
        { language: "c", scheme: "vscode-userdata" },
        { language: "cpp", scheme: "vscode-userdata" },
        { language: "plaintext", scheme: "file" },
      ],
      provider
    )
  );
}
