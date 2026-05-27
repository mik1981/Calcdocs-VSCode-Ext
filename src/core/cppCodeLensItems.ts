import * as vscode from "vscode";

import { collectDocumentSymbolDefinitions } from "./documentSymbols";
import { 
  isCompositeExpression, 
  unwrapParens, 
  removeRedundantParens, 
  NumericDisplayFormat 
} from "./expression";
import {
  buildCStylePreview,
  evaluateExpressionPreview,
  formatExpandedPreview,
  formatPreviewNumberWithFormat,
  normalizeExpandedPreviewText,
  formatPreviewNumber,
} from "./preview";
import { CalcDocsState } from "./state";

const CODELENS_PREVIEW_MAX_LEN = 140;
const MISMATCH_THRESHOLD = 0.01;

export type CppCodeLensItemKind =
  | "ambiguity"
  | "castOverflow"
  | "mismatch"
  | "openFormula"
  | "resolvedValue"
  | "expandedPreview"
  /** Standalone function-call expression in code body: ghost/hover only, never code lens. */
  | "functionCall";

export type CppCodeLensItem = {
  line: number;
  title: string;
  kind: CppCodeLensItemKind;
  command?: string;
  arguments?: unknown[];
};

function createInfoItem(
  line: number,
  title: string,
  kind: CppCodeLensItemKind
): CppCodeLensItem {
  return { line, title, kind };
}

function createOpenFormulaItem(
  state: CalcDocsState,
  symbol: string,
  line: number
): CppCodeLensItem | null {
  const formula = state.formulaIndex.get(symbol);
  if (!formula?._filePath) {
    return null;
  }

  const formulaLine = (formula._line ?? 0) + 1;
  return {
    line,
    kind: "openFormula",
    title: `CalcDocs: open formula ${formula._filePath}:${formulaLine}`,
    command: "calcdocs.fixMismatch",
    arguments: [symbol],
  };
}

function hasFormulaMismatch(formulaValue: number, evaluatedValue: number): boolean {
  const baseline = formulaValue === 0 ? 1 : Math.abs(formulaValue);
  const diff = Math.abs(formulaValue - evaluatedValue) / baseline;
  return diff > MISMATCH_THRESHOLD;
}

function buildAmbiguityTitle(symbolName: string, roots: string[]): string {
  const inheritedRoots = roots.filter((root) => root !== symbolName);
  return inheritedRoots.length > 0
    ? `CalcDocs: ${symbolName} depends on conditional symbols (${inheritedRoots.join(", ")})`
    : `CalcDocs: ${symbolName} has multiple conditional definitions`;
}

function normalizeExpressionForComparison(expression: string): string {
  return normalizeExpandedPreviewText(removeRedundantParens(unwrapParens(expression)));
}

function buildCastOverflowTitle(
  state: CalcDocsState,
  symbolName: string,
  error: NonNullable<ReturnType<typeof evaluateExpressionPreview>["error"]>,
  numericFormat?: NumericDisplayFormat //'decimal' | 'hex' | 'binary'
): string {
  const overflow = error.overflow;
  if (!overflow) {
    return `$(error) CalcDocs: ${symbolName} cast overflow: ${error.message}`;
  }
  const rangeText = `[${formatPreviewNumberWithFormat(state, overflow.min, numericFormat)}..${formatPreviewNumberWithFormat(state, overflow.max, numericFormat)}]`;
  const truncated = formatPreviewNumberWithFormat(state, overflow.truncatedValue, numericFormat);
  const input = formatPreviewNumberWithFormat(state, overflow.inputValue, numericFormat);
  const fromSuffix =
    overflow.inputValue === overflow.truncatedValue ? "" : ` (from ${input})`;

  return `$(error) CalcDocs: ${symbolName} cast overflow (${overflow.castType}) ${truncated}${fromSuffix} not in ${rangeText}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enum parser
//
// Scans the document text for `enum [class|struct] [Name] [: BaseType] { … }`
// blocks and produces one resolvedValue item per entry whose value can be
// determined.  Auto-increment semantics (value = previous + 1) are tracked
// inside each block.
//
// The parser:
//   • strips C/C++ line- and block-comments before splitting entries (while
//     keeping offsets so `document.positionAt` stays accurate)
//   • splits entries on top-level commas (respects parenthesis depth for
//     expressions like `A = (1 << 3)`)
//   • resolves expressions via evaluateExpressionPreview so that enum entries
//     referencing existing symbols (state.symbolValues / state.allDefines)
//     are evaluated correctly
//   • skips entries whose value cannot be determined and advances the
//     auto-counter so subsequent plain entries keep the right value
//   • uses word-boundary–safe search to locate each entry name in the original
//     document text, avoiding false hits inside longer identifiers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace comment text with spaces of the same byte-length so that character
 * offsets into the cleaned string remain identical to offsets in the original.
 */
function eraseComments(src: string): string {
  // Block comments: replace every non-newline character with a space so line
  // numbers are preserved.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " ")
  );
  // Line comments: same treatment.
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}

/**
 * Split `text` on commas that are at parenthesis depth 0.  Returns an array
 * of `{ src, offset }` where `offset` is the index of the entry's first
 * character within `text`.
 */
function splitTopLevelCommas(
  text: string
): Array<{ src: string; offset: number }> {
  const entries: Array<{ src: string; offset: number }> = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      entries.push({ src: text.slice(start, i), offset: start });
      start = i + 1;
    }
  }

  const tail = text.slice(start).trim();
  if (tail) {
    entries.push({ src: text.slice(start), offset: start });
  }

  return entries;
}

/**
 * Find the first occurrence of `word` as a whole identifier (not a substring
 * of a longer identifier) starting from `fromIndex` and before `limit`.
 * Returns -1 if not found.
 */
function findWordBoundary(
  text: string,
  word: string,
  fromIndex: number,
  limit: number
): number {
  let pos = text.indexOf(word, fromIndex);
  while (pos !== -1 && pos < limit) {
    const before = pos > 0 ? text[pos - 1] : " ";
    const after =
      pos + word.length < text.length ? text[pos + word.length] : " ";
    if (!/\w/.test(before) && !/\w/.test(after)) {
      return pos;
    }
    pos = text.indexOf(word, pos + 1);
  }
  return -1;
}

/**
 * Collect CodeLens items for every resolvable enum entry found in `document`.
 * Only emits items when `state.cppCodeLens.showResolvedValue` is true.
 * Lines already occupied by another item (`occupiedLines`) are skipped to
 * avoid duplicate decorations.
 */
function collectEnumItems(
  document: vscode.TextDocument,
  state: CalcDocsState,
  remainingSlots: number,
  occupiedLines: Set<number>
): CppCodeLensItem[] {
  if (!state.cppCodeLens.showResolvedValue || remainingSlots <= 0) {
    return [];
  }

  const items: CppCodeLensItem[] = [];
  const text = document.getText();

  // Match the enum header up to and including the opening brace.
  // Covers: enum Foo {, enum class Foo {, enum Foo : uint8_t {, typedef enum {
  const enumHeaderRx =
    /\benum\b(?:\s+(?:class|struct))?\s*(?:[A-Za-z_]\w*)?\s*(?::\s*[\w\s:]+?)?\{/g;

  let headerMatch: RegExpExecArray | null;

  while ((headerMatch = enumHeaderRx.exec(text)) !== null) {
    if (items.length >= remainingSlots) break;

    const bodyStart = headerMatch.index + headerMatch[0].length;

    // Find the matching closing brace.
    let depth = 1;
    let pos = bodyStart;
    while (pos < text.length && depth > 0) {
      const ch = text[pos];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      pos++;
    }
    if (depth !== 0) continue; // Unbalanced – skip this block.

    const bodyEnd = pos - 1; // index of the closing '}'
    const bodyRaw = text.slice(bodyStart, bodyEnd);

    // Erase comments while keeping offsets stable.
    const bodyClean = eraseComments(bodyRaw);

    // Split into comma-separated entries.
    const entries = splitTopLevelCommas(bodyClean);

    let autoValue = 0; // Tracks the next implicit enum value.

    for (const entry of entries) {
      if (items.length >= remainingSlots) break;

      const trimmed = entry.src.trim();
      if (!trimmed) continue;

      // Extract the identifier name (first word in the entry).
      const nameMatch = trimmed.match(/^([A-Za-z_]\w*)/);
      if (!nameMatch) continue;
      const name = nameMatch[1];

      // Extract the initialiser expression, if any.
      const eqIdx = trimmed.indexOf("=");
      const exprStr = eqIdx >= 0 ? trimmed.slice(eqIdx + 1).trim() : undefined;

      let value: number;

      if (exprStr && exprStr.length > 0) {
        const preview = evaluateExpressionPreview(state, exprStr);
        if (typeof preview.value === "number") {
          value = preview.value;
        } else {
          // Expression unresolvable – advance counter and skip this entry.
          autoValue++;
          continue;
        }
      } else {
        value = autoValue;
      }

      autoValue = value + 1;

      // Locate the entry name in the original document text.
      const absoluteOffset = bodyStart + entry.offset;
      const namePos = findWordBoundary(text, name, absoluteOffset, bodyEnd);
      if (namePos === -1) continue;

      const line = document.positionAt(namePos).line;
      if (occupiedLines.has(line)) continue;

      items.push(
        createInfoItem(
          line,
          `CalcDocs: ${name} = ${formatPreviewNumber(state, value)}`,
          "resolvedValue"
        )
      );
    }
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export function collectCppCodeLensItems(
  document: vscode.TextDocument,
  state: CalcDocsState,
  maxItemsPerFile: number
): CppCodeLensItem[] {
  const maxItems = Math.max(1, maxItemsPerFile);
  const items: CppCodeLensItem[] = [];
  const renderedAmbiguityLens = new Set<string>();
  const definitions = collectDocumentSymbolDefinitions(document.getText());

  const pushItem = (item: CppCodeLensItem): boolean => {
    if (items.length >= maxItems) {
      return false;
    }

    items.push(item);
    return true;
  };

  // ── #define / variable definitions ──────────────────────────────────────
  for (const definition of definitions) {
    if (items.length >= maxItems) {
      break;
    }

    if (definition.isFunctionCallStmt) {
      continue; // Handled in the second pass below
    }

    const { line, isDefineLine, parsed } = definition;
    const { name, expr } = parsed;

    if (name) {
      const ambiguityRoots = state.symbolAmbiguityRoots.get(name) ?? [];

      if (ambiguityRoots.length > 0) {
        if (state.cppCodeLens.showAmbiguity && !renderedAmbiguityLens.has(name)) {
          renderedAmbiguityLens.add(name);
          if (!pushItem(createInfoItem(line, buildAmbiguityTitle(name, ambiguityRoots), "ambiguity"))) {
            break;
          }
        }

        continue;
      }
    }

    const displayName = parsed.macroParams
      ? `${name}(${parsed.macroParams.join(", ")})`
      : name;
    const isFunctionLikeMacro = parsed.macroParams != null;

    const preview = evaluateExpressionPreview(state, expr);
    const value = preview.value;

    if (preview.error?.kind === "cast-overflow") {
      if (state.cppCodeLens.showCastOverflow) {
        if (
          !pushItem(
            createInfoItem(
              line,
              buildCastOverflowTitle(state, displayName, preview.error, preview.numericFormat),
              "castOverflow"
            )
          )
        ) {
          break;
        }
      }

      continue;
    }

    if (
      !isFunctionLikeMacro &&
      !isCompositeExpression(expr, state.symbolValues, state.allDefines, state.functionDefines)
    ) {
      const formula = state.formulaIndex.get(name);
      const mismatch =
        Boolean(formula) &&
        typeof formula?.valueCalc === "number" &&
        typeof value === "number" &&
        hasFormulaMismatch(formula.valueCalc, value);

      if (mismatch) {
        if (state.cppCodeLens.showMismatch) {
          if (
            !pushItem({
              line,
              kind: "mismatch",
              title: formula
                ? `CalcDocs: ${name} differs from YAML value ${formula.valueCalc} (click to open)`
                : `CalcDocs: ${name} needs a check (click to open)`,
              command: "calcdocs.fixMismatch",
              arguments: [name],
            })
          ) {
            break;
          }
        }
      } else if (state.cppCodeLens.showOpenFormula) {
        const openFormulaItem = createOpenFormulaItem(state, name, line);
        if (openFormulaItem && !pushItem(openFormulaItem)) {
          break;
        }
      }

      continue;
    }

    if (typeof value === "number" && state.cppCodeLens.showResolvedValue) {
      const hasUnitDisplay =
        typeof preview.displayValue === "number" &&
        typeof preview.displayUnit === "string" &&
        preview.displayUnit.trim().length > 0;
      const rightHandSide = hasUnitDisplay
        ? `${formatPreviewNumber(state, preview.displayValue!)} [${preview.displayUnit}]`
        : formatPreviewNumberWithFormat(state, value, preview.numericFormat);
      const cLikePreview = buildCStylePreview(
        displayName,
        rightHandSide,
        isDefineLine
      );

      if (!pushItem(createInfoItem(line, `CalcDocs: ${cLikePreview}`, "resolvedValue"))) {
        break;
      }

      continue;
    }

    if (!state.cppCodeLens.showExpandedPreview) {
      continue;
    }

    const previewText = formatExpandedPreview(state, preview.expanded, {
      maxLength: CODELENS_PREVIEW_MAX_LEN,
    });
    const originalComparable = normalizeExpressionForComparison(expr);
    const expandedComparable = normalizeExpressionForComparison(preview.expanded);

    if (previewText && expandedComparable !== originalComparable) {
      const cLikePreview = buildCStylePreview(displayName, previewText, isDefineLine);
      if (!pushItem(createInfoItem(line, `CalcDocs: ${cLikePreview}`, "expandedPreview"))) {
        break;
      }
    }
  }

  // ── Second pass: standalone function-call expressions ──────────────────────
  // These items are "functionCall" kind: shown only as ghost value (never code
  // lens). The expansion replaces known macro arguments with their values, e.g.
  //   HAL_delay(COMMENTED)  →  HAL_delay(28)
  for (const definition of definitions) {
    if (items.length >= maxItems) {
      break;
    }

    if (!definition.isFunctionCallStmt) {
      continue;
    }

    const { line, parsed } = definition;
    const { expr } = parsed;
    if (!expr) {
      continue;
    }

    const preview = evaluateExpressionPreview(state, expr);
    const expanded = (preview.expanded ?? "").trim();
    if (!expanded) {
      continue;
    }

    const originalNorm = normalizeExpressionForComparison(expr);
    const expandedNorm = normalizeExpressionForComparison(expanded);
    if (expandedNorm === originalNorm) {
      continue; // No actual expansion — nothing useful to show
    }

    const previewText = formatExpandedPreview(state, expanded, {
      maxLength: CODELENS_PREVIEW_MAX_LEN,
    });
    if (!previewText) {
      continue;
    }

    pushItem(createInfoItem(line, `CalcDocs: ${previewText}`, "functionCall"));
  }

  // ── Enum entries ─────────────────────────────────────────────────────────
  // Run after the two loops above so `occupiedLines` correctly reflects every
  // line already claimed by a #define / variable / function-call item.
  if (items.length < maxItems) {
    const occupiedLines = new Set(items.map((i) => i.line));
    const enumItems = collectEnumItems(
      document,
      state,
      maxItems - items.length,
      occupiedLines
    );
    items.push(...enumItems);
  }

  return items;
}
