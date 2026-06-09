import * as vscode from "vscode";
import { collectCppCodeLensItems, type CppCodeLensItem } from "./cppCodeLensItems";
import { extractPureGhostValue } from "./ghostValues";
import { CalcDocsState } from "./state";
import { getMaxItemsPerViewport } from "./viewport";

// Extended to include "cpp" so that .h files (which VSCode may identify as
// either "c" or "cpp" depending on workspace / extension config) also receive
// ghost decorations instead of falling back to CodeLens only.
const GHOST_SUPPORTED_LANGUAGES = new Set(["c", "cpp"]);

// Cache: uri+line → { showGhost, showCodeLens } 
// Invalidata solo quando cambiano symbolValues/allDefines, non allo scroll
const priorityCache = new Map<string, { showGhost: boolean; showCodeLens: boolean; tick: number }>();

let currentDataTick = 0; // incrementato ogni volta che i dati cambiano

export function invalidatePriorityCache(): void {
  currentDataTick++;
}

function isGhostReplaceableItem(item: CppCodeLensItem): boolean {
  return (
    item.kind === "resolvedValue" ||
    item.kind === "expandedPreview" ||
    item.kind === "functionCall" // ghost/hover only, never code lens
  );
}

export function shouldRenderInlineCalcGhostForResult(
  result: { line: number; kind: string; expression: string },
  state: CalcDocsState
): boolean {
  if (!state.inlineGhostEnabled) return false;

  // Stessa esclusione che fa GhostValueProvider: assign con valore puro = no ghost
  if (
    result.kind === "assign" &&
    /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?\s*(?:[A-Za-z%][A-Za-z0-9_%/^*.-]*)?$/.test(
      result.expression.trim()
    )
  ) {
    return false;
  }

  return true;
}

export function shouldRenderGhostInsteadOfCodeLens(
  document: vscode.TextDocument,
  item: CppCodeLensItem,
  state: CalcDocsState
): boolean {
  if (!state.enabled || !state.inlineGhostEnabled) {
    return false;
  }

  if (!GHOST_SUPPORTED_LANGUAGES.has(document.languageId)) {
    return false;
  }

  if (item.line < 0 || item.line >= document.lineCount) {
    return false;
  }

  if (!isGhostReplaceableItem(item)) {
    return false;
  }

  // Keep ghost rendering active even with trailing comments:
  // parser/preview already strip comments where needed.
  return true;
}

export function getPotentialGhostItems(
  document: vscode.TextDocument,
  line: number,
  state: CalcDocsState,
  { forPriority = false }: { forPriority?: boolean } = {}
): CppCodeLensItem[] {
  const maxItems = forPriority
    ? 500  // costante generosa, non dipende dal viewport
    : getMaxItemsPerViewport(state.cppCodeLens, 40);

  const allItems = collectCppCodeLensItems(document, state, maxItems, {
    lineRanges: [{ startLine: line, endLine: line }],
  });
  return allItems.filter(
    (item) => item.line === line && isGhostReplaceableItem(item)
  );
}

export function shouldRenderGhost(
  document: vscode.TextDocument,
  line: number,
  state: CalcDocsState
): boolean {
  const items = getPotentialGhostItems(document, line, state, { forPriority: true });
  for (const item of items) {
    if (!shouldRenderGhostInsteadOfCodeLens(document, item, state)) {
      continue;
    }

    const ghostText = extractPureGhostValue(item.title, item.kind);
    if (ghostText && ghostText.trim().length > 0) {
      return true;
    }
  }

  return false;
}

export function shouldShowCodeLens(
  document: vscode.TextDocument,
  line: number,
  state: CalcDocsState
): boolean {
  if (!state.cppCodeLens.enabled && !state.inlineCodeLens.enabled) {
    return false;
  }

  // functionCall items are never code lens — exclude them so they don't
  // cause getLineDisplayPriority to suppress the hover provider.
  const items = getPotentialGhostItems(document, line, state, { forPriority: true }).filter(
    (item) => item.kind !== "functionCall"
  );
  if (items.length === 0) {
    return false;
  }

  return !items.every((item) =>
    shouldRenderGhostInsteadOfCodeLens(document, item, state)
  );
}

export function hasRichHoverContent(state: CalcDocsState): boolean {
  return (
    state.cppHover.showFormulaSection ||
    state.cppHover.showConditionalDefinitions ||
    state.cppHover.showInheritedAmbiguity ||
    state.inlineHover.showDimension ||
    state.inlineHover.showWarnings ||
    state.cppHover.showCastOverflow ||
    state.cppHover.showKnownValue
  );
}

export type LineDisplayPriority = {
  showGhost: boolean;
  showCodeLens: boolean;
  showHover: boolean;
};

export function getLineDisplayPriority(
  document: vscode.TextDocument,
  line: number,
  state: CalcDocsState
): LineDisplayPriority {
  const key = `${document.uri.toString()}:${line}`;
  const cached = priorityCache.get(key);
  
  if (cached && cached.tick === currentDataTick) {
    return { ...cached, showHover: true };
  }

  const showGhost = shouldRenderGhost(document, line, state);
  const showCodeLens = !showGhost && shouldShowCodeLens(document, line, state);
  const richHover = hasRichHoverContent(state);
  const showHover = richHover || (!showGhost && !showCodeLens);

  priorityCache.set(key, { showGhost, showCodeLens, tick: currentDataTick });
  return { showGhost, showCodeLens, showHover };
}
