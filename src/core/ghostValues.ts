import * as vscode from "vscode";

import { collectCppCodeLensItems } from "./cppCodeLensItems";
import { shouldRenderGhostInsteadOfCodeLens } from "./ghostPolicy";
import { CalcDocsState } from "./state";
import { evaluateInlineCalcs, isTrivialAssignExpression } from "./inlineCalc";

// Languages that receive inline-calc ghost decorations (=calc / @assign).
const INLINE_CALC_GHOST_LANGUAGES = new Set(["c", "cpp"]);

// Languages for which C/C++ symbol resolution (collectCppCodeLensItems) is run.
// Extended from just "c" so that .h files identified as "cpp" by VSCode also
// receive ghost values instead of falling back to CodeLens.
const CPP_SYMBOL_GHOST_LANGUAGES = new Set(["c", "cpp"]);

const MAX_GHOST_TEXT_LEN = 180;

function clampGhostText(text: string): string {
  if (text.length <= MAX_GHOST_TEXT_LEN) {
    return text;
  }

  return `${text.slice(0, MAX_GHOST_TEXT_LEN - 3)}...`;
}

export function extractPureGhostValue(title: string, kind: string): string {
  const noIcon = title.replace(/^\$\([^)]+\)\s*/, "");
  const noPrefix = noIcon.replace(/^CalcDocs:\s*/, "").trim();

  // Strip #define NAME / #define NAME(params) prefix regardless of kind
  const defineMatch = noPrefix.match(/^#define\s+[A-Za-z_]\w*(?:\s*\([^)]*\))?\s+(.+)$/);
  const withoutDefine = defineMatch ? defineMatch[1].trim() : noPrefix;
  
  // For expandedPreview/functionCall: use full stripped preview (shows expression/structure)
  if (kind === "expandedPreview" || kind === "functionCall") {
    return withoutDefine;
  }
  
  if (defineMatch) {
    return withoutDefine;
  }
  
  // CASO 2: NAME = VALUE → pure VALUE
  const constMatch = noPrefix.match(/^[^=]+\s*=\s*(.+)$/);
  if (constMatch) {
    return constMatch[1].trim();
  }

  // CASO 3: Anonymous expressions (e.g. from control flow)
  // If it starts with "(" and ends with ")", it might be an anonymous expression preview
  // e.g. "((Flags < 101))" -> "(Flags < 101)"
  if (noPrefix.startsWith("(") && noPrefix.endsWith(")")) {
    return noPrefix;
  }
  
  // Fallback: full stripped text (errors, ambiguity, etc.)
  return noPrefix || title;
}

function toGhostText(titles: string[]): string {
  const joined = titles.join(" | ");
  return clampGhostText(joined);
}

export class GhostValueProvider {
  private readonly decorationType: vscode.TextEditorDecorationType;

  constructor(private readonly state: CalcDocsState) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 12px",
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "italic",
      },
    });
  }

  public update(editor: vscode.TextEditor): void {
    if (!editor) {
      return;
    }

    const document = editor.document;

    // Guard: ghost is only available for supported languages.
    // CPP_SYMBOL_GHOST_LANGUAGES covers "c" and "cpp" (the latter includes .h
    // files identified as cpp).  INLINE_CALC_GHOST_LANGUAGES covers the same set
    // for inline-calc ghost annotations.
    const hasCppSymbolGhost = CPP_SYMBOL_GHOST_LANGUAGES.has(document.languageId);
    const hasInlineCalcGhost = INLINE_CALC_GHOST_LANGUAGES.has(document.languageId);

    if (!this.state.enabled || !this.state.inlineGhostEnabled || (!hasCppSymbolGhost && !hasInlineCalcGhost)) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const perLineGhostTexts = new Map<number, string[]>();

    // ── C/C++ code-lens ghost values (existing logic, C only) ──────────────
    if (hasCppSymbolGhost) {
      const maxItemsPerViewport = Math.max(1, this.state.cppCodeLens.maxItemsPerViewport);
      const items = collectCppCodeLensItems(document, this.state, maxItemsPerViewport * 4);

      for (const item of items) {
        if (!shouldRenderGhostInsteadOfCodeLens(document, item, this.state)) {
          continue;
        }

        const normalizedTitle = extractPureGhostValue(item.title, item.kind);
        if (!normalizedTitle) {
          continue;
        }

        const texts = perLineGhostTexts.get(item.line) ?? [];
        texts.push(normalizedTitle);
        perLineGhostTexts.set(item.line, texts);
      }
    }

    // ── Inline-calc ghost (=calc / @assign annotations) ──
    if (hasInlineCalcGhost) {
      const results = evaluateInlineCalcs(
        document.getText(),
        this.state,
        { includeAssignments: true },
        document.languageId
      );

      for (const result of results) {
        if (result.line < 0 || result.line >= document.lineCount) {
          continue;
        }

        // Assegnamento con valore numerico puro: il ghost è ridondante
        if (result.kind === "assign" && isTrivialAssignExpression(result.expression)) {
          continue;
        }

        const ghostText =
          result.kind === "assign"
            ? result.displayValue.replace(/^@[A-Za-z_]\w*\s*=\s*/, "")
            : result.displayValue;

        const texts = perLineGhostTexts.get(result.line) ?? [];
        texts.push(ghostText);
        perLineGhostTexts.set(result.line, texts);
      }
    }

    const decorations: vscode.DecorationOptions[] = [];
    for (const [line, titles] of perLineGhostTexts) {
      if (line < 0 || line >= document.lineCount || titles.length === 0) {
        continue;
      }

      const lineText = document.lineAt(line).text;
      decorations.push({
        range: new vscode.Range(line, lineText.length, line, lineText.length),
        renderOptions: {
          after: {
            contentText: ` ← ${toGhostText(titles)}`,
          },
        },
      });
    }

    editor.setDecorations(this.decorationType, decorations);
  }
}
