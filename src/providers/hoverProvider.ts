import * as vscode from "vscode";

import {
  DEFINE_DIRECTIVE_RX,
  findDocumentSymbolDefinitions,
} from "../core/documentSymbols";
import {
  evaluateExpressionPreview,
  formatExpandedPreview,
  formatPreviewNumber,
  formatPreviewNumberWithHex,
} from "../core/preview";
import type { CastOverflowInfo } from "../core/expression";
import { CalcDocsState } from "../core/state";
import { pickWord } from "../utils/editor";
import { formatNumbersWithThousandsSeparator } from "../utils/nformat";
import { DEFINE_NAME_RX, FUNCTION_DEFINE_RX, OBJECT_DEFINE_RX } from "../utils/regex";
import { stripComments } from "../utils/text";
import {
  type BitfieldDecodeTheme,
  decodeBitfieldValue,
  formatBitfieldDecodeMarkdown,
  parseRegisterAssignment,
} from "../core/bitfieldDecoder";
import { buildCopyLink

 } from "../utils/hoverActions";

type InDocumentSymbolDefinition = {
  expr: string;
  line: number;
};

function debugLog(state: CalcDocsState, message: string): void {
  state.output.detail(message);
}

function getBitfieldDecodeTheme(): BitfieldDecodeTheme {
  const themeKind = vscode.window.activeColorTheme.kind;
  return themeKind === vscode.ColorThemeKind.Dark ||
    themeKind === vscode.ColorThemeKind.HighContrast
    ? "dark"
    : "light";
}

function toCCodeBlock(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) {
    return "";
  }

  return `\`\`\`c\n${trimmed}\n\`\`\``;
}

function indentBlock(block: string, indent = "  "): string {
  return block
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function extractFunctionMacroCall(
  document: vscode.TextDocument,
  position: vscode.Position
): string | null {
  const lineText = document.lineAt(position.line).text;
  const lineUntilCursor = lineText.slice(0, position.character);

  let identifierStart = lineUntilCursor.length - 1;
  while (identifierStart >= 0 && /[A-Za-z_]/.test(lineText[identifierStart])) {
    identifierStart -= 1;
  }
  identifierStart += 1;

  if (identifierStart >= lineUntilCursor.length) {
    return null;
  }

  const potentialName = lineText.slice(identifierStart, lineUntilCursor.length);
  if (!/^[A-Za-z_]\w*$/.test(potentialName)) {
    return null;
  }

  const afterName = lineUntilCursor
    .slice(identifierStart + potentialName.length)
    .match(/^\s*\(/);
  if (!afterName) {
    return null;
  }

  let depth = 0;
  let end = identifierStart + potentialName.length + afterName[0].length - 1;

  while (end < lineText.length) {
    const char = lineText[end];

    if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    } else if (char === '"' || char === "'") {
      const quote = char;
      end += 1;
      while (end < lineText.length) {
        if (lineText[end] === "\\") {
          end += 2;
          continue;
        }

        if (lineText[end] === quote) {
          end += 1;
          break;
        }

        end += 1;
      }
      continue;
    }

    end += 1;
  }

  if (depth !== 0) {
    return null;
  }

  const call = lineText.slice(identifierStart, end).trim();
  return call || null;
}

function extractMacroCallWithRegex(lineText: string): string | null {
  if (/^\s*#\s*define/.test(lineText)) {
    return null;
  }

  const match = lineText.match(/([A-Za-z_]\w*)\s*\((.*)\)/);
  return match ? match[0] : null;
}

function extractMacroCallFromDefineRightSide(lineText: string): string | null {
  const noComment = lineText.split("//")[0];
  const defineMatch = noComment.match(/^\s*#\s*define\s+[A-Za-z_]\w*\s+(.*)$/);
  if (!defineMatch) {
    return null;
  }

  const rightHandSide = defineMatch[1].trim();
  const nameMatch = rightHandSide.match(/^([A-Za-z_]\w*)\s*\(/);
  if (!nameMatch) {
    return null;
  }

  let depth = 0;
  let end = nameMatch[0].length - 1;

  while (end < rightHandSide.length) {
    const char = rightHandSide[end];

    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    } else if (char === '"' || char === "'") {
      const quote = char;
      end += 1;
      while (end < rightHandSide.length) {
        if (rightHandSide[end] === "\\") {
          end += 2;
          continue;
        }

        if (rightHandSide[end] === quote) {
          break;
        }

        end += 1;
      }
    }

    end += 1;
  }

  if (depth !== 0) {
    return null;
  }

  return rightHandSide.slice(0, end).trim();
}

function normalizeMacroCallForDisplay(call: string): string {
  let output = call;
  output = output.replace(/\s+\(/g, "(");
  output = output.replace(/\(\s+/g, "(");
  output = output.replace(/\s+\)/g, ")");
  output = output.replace(/\)\s+/g, ")");
  output = output.replace(/\s*,\s*/g, ",");
  output = output.replace(/\s*([+\-*/%|&^<>])\s*/g, "$1");
  return output.replace(/\s+/g, " ").trim();
}

function getMacroName(call: string): string | null {
  return call.match(/^([A-Za-z_]\w*)/)?.[1] ?? null;
}

function isKnownCalcDocsMacro(name: string, state: CalcDocsState): boolean {
  return (
    state.functionDefines.has(name) ||
    state.allDefines.has(name) ||
    state.symbolValues.has(name) ||
    state.formulaIndex.has(name)
  );
}

function resolveMacroCallForHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  hoveredWord: string,
  lineText: string,
  state: CalcDocsState
): string | null {
  const isDefineLine = DEFINE_DIRECTIVE_RX.test(lineText);
  let macroToEvaluate =
    extractFunctionMacroCall(document, position) ??
    extractMacroCallWithRegex(lineText) ??
    null;

  const definedMacro = lineText.match(DEFINE_NAME_RX)?.[1] ?? null;

  if (isDefineLine) {
    const functionDefineMatch = lineText.match(FUNCTION_DEFINE_RX);
    const objectDefineMatch = lineText.match(OBJECT_DEFINE_RX);

    if (functionDefineMatch) {
      const macroName = functionDefineMatch[1];
      if (hoveredWord !== macroName) {
        return null;
      }

      const rhsCall = extractMacroCallFromDefineRightSide(lineText);
      if (rhsCall) {
        const rhsMacroName = getMacroName(rhsCall);
        if (rhsMacroName && isKnownCalcDocsMacro(rhsMacroName, state)) {
          macroToEvaluate = rhsCall;
        }
      }
      return macroToEvaluate;
    }

    if (objectDefineMatch) {
      if (hoveredWord === definedMacro) {
        debugLog(state, "Hover on object-like macro name, skipping macro evaluation");
        return null;
      }

      const rhsCall = extractMacroCallFromDefineRightSide(lineText);
      if (!rhsCall) {
        return null;
      }

      const rhsMacroName = getMacroName(rhsCall);
      if (
        rhsMacroName === hoveredWord &&
        rhsMacroName &&
        isKnownCalcDocsMacro(rhsMacroName, state)
      ) {
        return rhsCall;
      }

      return null;
    }
  }

  const rhsCall = extractMacroCallFromDefineRightSide(lineText);
  if (
    rhsCall &&
    getMacroName(rhsCall) === hoveredWord &&
    isKnownCalcDocsMacro(hoveredWord, state)
  ) {
    return rhsCall;
  }
  if (!macroToEvaluate) {
    return null;
  }

  const macroName = getMacroName(macroToEvaluate);
  if (!macroName || !isKnownCalcDocsMacro(macroName, state)) {
    return null;
  }

  return macroToEvaluate;
}

function formatConditionalDefinitionsSection(
  symbol: string,
  state: CalcDocsState
): string | null {
  if (!state.cppHover.showConditionalDefinitions) {
    return null;
  }

  const variants = state.symbolConditionalDefs.get(symbol);
  if (!variants || variants.length <= 1) {
    return null;
  }

  const lines: string[] = ["**Multiple C/C++ definitions:**"];
  const shown = variants.slice(0, state.cppHover.maxConditionalDefinitions);

  for (const variant of shown) {
    const location = `${variant.file}:${variant.line + 1}`;
    lines.push(`- when \`${variant.condition}\`:`);

    const exprBlock = toCCodeBlock(variant.expr);
    if (exprBlock) {
      lines.push(indentBlock(exprBlock));
    } else {
      lines.push(`  \`${variant.expr}\``);
    }

    lines.push(`  (\`${location}\`)`);
  }

  if (variants.length > shown.length) {
    lines.push(`- ...and ${variants.length - shown.length} more`);
  }

  return lines.join("\n");
}

function formatInDocumentMultipleDefinitionsSection(
  symbol: string,
  document: vscode.TextDocument,
  state: CalcDocsState,
  inDocumentDefinitions: InDocumentSymbolDefinition[]
): string | null {
  if (!state.cppHover.showInDocumentDefinitions) {
    return null;
  }

  const trackedVariants = state.symbolConditionalDefs.get(symbol);
  if (trackedVariants && trackedVariants.length > 1) {
    return null;
  }

  if (inDocumentDefinitions.length <= 1) {
    return null;
  }

  const lines: string[] = ["**Multiple definitions found in current file:**"];
  const shown = inDocumentDefinitions.slice(0, state.cppHover.maxInDocumentDefinitions);
  const relativePath = vscode.workspace.asRelativePath(document.uri.fsPath);

  for (const definition of shown) {
    lines.push(`- \`${definition.expr}\` (\`${relativePath}:${definition.line + 1}\`)`);
  }

  if (inDocumentDefinitions.length > shown.length) {
    lines.push(`- ...and ${inDocumentDefinitions.length - shown.length} more`);
  }

  return lines.join("\n");
}

function formatInheritedAmbiguitySection(
  symbol: string,
  state: CalcDocsState
): string | null {
  if (!state.cppHover.showInheritedAmbiguity) {
    return null;
  }

  const roots = state.symbolAmbiguityRoots.get(symbol);
  if (!roots || roots.length === 0) {
    return null;
  }

  const inheritedFrom = roots.filter((name) => name !== symbol);
  if (inheritedFrom.length === 0) {
    return null;
  }

  return `**Depends on symbols with multiple definitions:** \`${inheritedFrom.join("`, `")}\``;
}

function buildOpenFormulaCommandLink(
  symbol: string,
  formula: { _filePath?: string; _line?: number }
): string | null {
  if (!formula._filePath) {
    return null;
  }

  const line = (formula._line ?? 0) + 1;
  const locationLabel = `${formula._filePath}:${line}`;
  const args = encodeURIComponent(JSON.stringify([symbol]));
  return `[Open formula source (${locationLabel})](command:calcdocs.fixMismatch?${args})`;
}

function appendFormulaSection(
  symbol: string,
  state: CalcDocsState,
  sections: string[]
): void {
  if (!state.cppHover.showFormulaSection) {
    return;
  }

  const formula = state.formulaIndex.get(symbol);
  if (!formula) {
    return;
  }

  sections.push(
    `### ${formula.key}${formula.unit ? `  \n*Unit:* \`${formula.unit}\`` : ""}`
  );

  if (Array.isArray(formula.steps) && formula.steps.length > 0) {
    const stepLines = formula.steps.map((step) => `  - \`${step}\``).join("\n");
    sections.push(`*Steps:*\n${stepLines}`);
  }

  if (formula.formula) {
    sections.push("*Formula:*");
    const formulaBlock = toCCodeBlock(formula.formula);
    if (formulaBlock) {
      sections.push(formulaBlock);
    }
  }

  if (formula.expanded) {
    sections.push("*Expanded:*");
    const expandedBlock = toCCodeBlock(
      formatExpandedPreview(state, formula.expanded)
    );
    if (expandedBlock) {
      sections.push(expandedBlock);
    }

    if (typeof formula.valueCalc === "number") {
      sections.push(`-> \`${formatPreviewNumberWithHex(state, formula.valueCalc)}\``);
      sections.push(buildCopyLink(String(formula.valueCalc)));
    }
  }

  if (
    Array.isArray(formula.resolvedDependencies) &&
    formula.resolvedDependencies.length > 0
  ) {
    const resolved = formula.resolvedDependencies
      .map((line) => `- \`${line}\``)
      .join("\n");
    sections.push(`*Resolved symbols:*\n${resolved}`);
  }

  if (Array.isArray(formula.explainSteps) && formula.explainSteps.length > 0) {
    sections.push("*Explain:*");
    sections.push(`\`\`\`text\n${formula.explainSteps.join("\n")}\n\`\`\``);
  }

  if (Array.isArray(formula.evaluationErrors) && formula.evaluationErrors.length > 0) {
    const errorLines = formula.evaluationErrors.map((error) => `- ${error}`).join("\n");
    sections.push(`**Evaluation errors:**\n${errorLines}`);
  }

  if (
    Array.isArray(formula.evaluationWarnings) &&
    formula.evaluationWarnings.length > 0
  ) {
    const warningLines = formula.evaluationWarnings
      .map((warning) => `- ${warning}`)
      .join("\n");
    sections.push(`**Evaluation warnings:**\n${warningLines}`);
  }

  const openFormulaLink = buildOpenFormulaCommandLink(symbol, formula);
  if (openFormulaLink) {
    sections.push(openFormulaLink);
  }
}

function appendKnownValueSection(
  symbol: string,
  state: CalcDocsState,
  sections: string[],
  inDocumentDefinitions: InDocumentSymbolDefinition[]
): void {
  if (!state.cppHover.showKnownValue) {
    return;
  }

  if (state.formulaIndex.has(symbol)) {
    return;
  }

  if (inDocumentDefinitions.length === 0) {
    return;
  }

  const knownValue = state.symbolValues.get(symbol);
  if (typeof knownValue !== "number") {
    return;
  }

  sections.push(`${symbol} = **${formatPreviewNumberWithHex(state, knownValue)}**`);
  sections.push(buildCopyLink(String(knownValue)));    
}

function formatCastOverflowSummary(
  state: CalcDocsState,
  overflow: CastOverflowInfo
): string {
  const rangeText = `[${formatPreviewNumber(state, overflow.min)}..${formatPreviewNumber(state, overflow.max)}]`;
  const truncated = formatPreviewNumber(state, overflow.truncatedValue);
  const input = formatPreviewNumber(state, overflow.inputValue);
  const fromSuffix =
    overflow.inputValue === overflow.truncatedValue ? "" : ` (from ${input})`;

  return `(${overflow.castType}) ${truncated}${fromSuffix} outside ${rangeText}`;
}

function formatCastOverflowErrorLine(
  state: CalcDocsState,
  overflow: CastOverflowInfo
): string {
  return `<span style="color:#d32f2f"><strong>Cast overflow:</strong> ${formatCastOverflowSummary(state, overflow)}</span>`;
}

function formatInDocumentOverflowSection(
  state: CalcDocsState,
  document: vscode.TextDocument,
  inDocumentDefinitions: InDocumentSymbolDefinition[]
): string | null {
  const lines: string[] = [];
  const relativePath = vscode.workspace.asRelativePath(document.uri.fsPath);

  for (const definition of inDocumentDefinitions) {
    const preview = evaluateExpressionPreview(state, definition.expr);
    if (preview.error?.kind !== "cast-overflow" || !preview.error.overflow) {
      continue;
    }

    lines.push(
      `- \`${relativePath}:${definition.line + 1}\`: ${formatCastOverflowSummary(
        state,
        preview.error.overflow
      )}`
    );
  }

  if (lines.length === 0) {
    return null;
  }

  return [
    "<span style=\"color:#d32f2f\"><strong>Cast overflow detected:</strong></span>",
    ...lines,
  ].join("\n");
}

function evaluateMacroForHover(macroCall: string, state: CalcDocsState): string {
  const preview = evaluateExpressionPreview(state, macroCall);
  state.output.detail(`Preview.expanded: ${preview.expanded}`);
  state.output.detail(`Preview.value: ${preview.value}`);

  const displayCall = normalizeMacroCallForDisplay(stripComments(macroCall));
  const sections: string[] = [];
  const displayBlock = toCCodeBlock(displayCall);
  sections.push(displayBlock || displayCall);

  // In evaluateMacroForHover — dopo aver calcolato preview.value
  if (typeof preview.value === "number") {
    const displayStr =
      typeof preview.displayValue === "number" && 
      typeof preview.displayUnit === "string" &&
      preview.displayUnit.trim().length > 0
        ? `${formatPreviewNumber(state, preview.displayValue)} [${preview.displayUnit}]`
        : formatPreviewNumberWithHex(state, preview.value);

    sections.push(`-> **${displayStr}**`);
    sections.push(buildCopyLink(String(preview.value)));

    const decode = decodeBitfieldValue(preview.value, state.allDefines, state);
    const decodeText = decode
      ? formatBitfieldDecodeMarkdown(decode, { theme: getBitfieldDecodeTheme() })
      : null;
    if (decodeText) {
      sections.push(decodeText);
    }

    return sections.join("\n\n");
  }

  if (preview.error?.kind === "cast-overflow" && preview.error.overflow) {
    sections.push(formatCastOverflowErrorLine(state, preview.error.overflow));
    return sections.join("\n\n");
  }

  const expanded = (preview.expanded ?? "").trim();
  if (!expanded || expanded === macroCall) {
    sections.push(`-> \`${displayCall}\``);
    return sections.join("\n\n");
  }

  const expandedNumber = Number(expanded);
  if (Number.isFinite(expandedNumber)) {
    sections.push(`-> **${formatPreviewNumberWithHex(state, expandedNumber)}**`);
    return sections.join("\n\n");
  }

  const expandedBlock = toCCodeBlock(formatExpandedPreview(state, expanded));
  if (expandedBlock) {
    sections.push(`->\n${expandedBlock}`);
  } else {
    sections.push(`-> **${formatExpandedPreview(state, expanded)}**`);
  }

  return sections.join("\n\n");
}

function buildSymbolHoverSections(
  word: string,
  document: vscode.TextDocument,
  state: CalcDocsState,
  inDocumentDefinitions: InDocumentSymbolDefinition[]
): string[] {
  const sections: string[] = [];
  const trackedVariants = state.symbolConditionalDefs.get(word) ?? [];
  const ambiguityRoots = state.symbolAmbiguityRoots.get(word) ?? [];

  const hasTrackedAmbiguity = ambiguityRoots.length > 0;
  const hasInDocumentAmbiguity =
    trackedVariants.length <= 1 && inDocumentDefinitions.length > 1;

  if (hasTrackedAmbiguity) {
    sections.push(`**${word}: conditional value (multiple possible definitions)**`);
  } else if (hasInDocumentAmbiguity) {
    sections.push(`**${word}: multiple definitions found, value is not unique**`);
  }

  const conditionalDefinitions = formatConditionalDefinitionsSection(word, state);
  if (conditionalDefinitions) {
    sections.push(formatNumbersWithThousandsSeparator(state, conditionalDefinitions));
  }

  const inDocumentSection = formatInDocumentMultipleDefinitionsSection(
    word,
    document,
    state,
    inDocumentDefinitions
  );
  if (inDocumentSection) {
    sections.push(inDocumentSection);
  }

  if (state.cppHover.showCastOverflow) {
    const inDocumentOverflowSection = formatInDocumentOverflowSection(
      state,
      document,
      inDocumentDefinitions
    );
    if (inDocumentOverflowSection) {
      sections.push(inDocumentOverflowSection);
    }
  }

  const inheritedAmbiguity = formatInheritedAmbiguitySection(word, state);
  if (inheritedAmbiguity) {
    sections.push(inheritedAmbiguity);
  }

  appendFormulaSection(word, state, sections);
  appendKnownValueSection(word, state, sections, inDocumentDefinitions);

  return sections;
}

export function registerCppHoverProvider(
  context: vscode.ExtensionContext,
  state: CalcDocsState,
  enableCppProviders: boolean
): void {
  if (!enableCppProviders) {
    return;
  }

  const cppSelectors: vscode.DocumentSelector = [
    { language: "c", scheme: "file" },
    { language: "cpp", scheme: "file" },
    { language: "c", scheme: "untitled" },
    { language: "cpp", scheme: "untitled" },
  ];

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(cppSelectors, {
      provideHover(document, position) {
        if (!state.enabled || !state.cppHover.enabled) {
          debugLog(state, "Hover ignored: disabled by runtime or settings");
          return undefined;
        }

        // New priority logic: skip if ghost or codelens takes precedence
        const { showHover } = require("../core/ghostPolicy").getLineDisplayPriority(document, position.line, state);
        if (!showHover) {
          return undefined;
        }

        const word = pickWord(document, position);
        if (!word) {
          return undefined;
        }

        const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
        if (!range) {
          return undefined;
        }

        const fullLine = document.lineAt(position.line).text;
      const assignment = parseRegisterAssignment(fullLine);
        if (
          assignment &&
          state.cppHover.showLiveRegisterDecoder
        ) {
          const preview = evaluateExpressionPreview(state, assignment.rhs);
          if (typeof preview.value === "number") {
            // Pass the FULL lhs (e.g., "TIM1->CR1") so matchesContext can validate
            // all tokens (TIM1, CR1) and check for _Pos/_Msk defines for TIM_CR1.
            const decode = decodeBitfieldValue(
              preview.value,
              state.allDefines,
              state,
              assignment.lhs
            );
            const decodeText = decode
              ? formatBitfieldDecodeMarkdown(decode, { theme: getBitfieldDecodeTheme() })
              : null;
            if (decodeText) {
              const markdown = new vscode.MarkdownString(decodeText);
              markdown.supportHtml = true;
              markdown.isTrusted = true;
              return new vscode.Hover(markdown, range);
            }
          }
        }

        const macroToEvaluate = resolveMacroCallForHover(
          document,
          position,
          word,
          fullLine,
          state
        );

        if (macroToEvaluate) {
          debugLog(state, `Evaluating macro call: ${macroToEvaluate}`);
          const markdown = new vscode.MarkdownString(
            evaluateMacroForHover(macroToEvaluate, state)
          );
          markdown.supportHtml = true;
          markdown.isTrusted = true;
          return new vscode.Hover(markdown, range);
        }

        const inDocumentDefinitions = findDocumentSymbolDefinitions(
          document.getText(),
          word
        )
          .filter((definition) => !definition.isAssignment)
          .map((definition) => ({
            expr: definition.parsed.expr,
            line: definition.line,
          }));

        const sections = buildSymbolHoverSections(
          word,
          document,
          state,
          inDocumentDefinitions
        );

        if (sections.length === 0) {
          return undefined;
        }

        const markdown = new vscode.MarkdownString(sections.join("\n\n"));
        markdown.supportHtml = true;
        markdown.isTrusted = true;
        return new vscode.Hover(markdown, range);
      },
    })
  );
}
