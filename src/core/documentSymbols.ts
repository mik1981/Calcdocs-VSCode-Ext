import { parseCppSymbolDefinition, type CppSymbolDefinition } from "./cppParser";
import { updateBraceDepth } from "../utils/braceDepth";
import { stripComments, createCommentStripper } from "../utils/text";
import type { LineTextSource, ViewportLineRange } from "./viewport";

export const DEFINE_DIRECTIVE_RX = /^\s*#\s*define\b/;
const CONTROL_FLOW_RX = /^\s*(else\s+if|if|while|for|switch|return|do)\b/;
const MAX_LOGICAL_LINE_CONTINUATION_LINES = 128;

export type DocumentSymbolDefinition = {
  line: number;
  lineText: string;
  isDefineLine: boolean;
  /** True for runtime assignments (e.g. `value = NEXT;`), not declarations. */
  isAssignment?: boolean;
  /** True for standalone function-call statements (e.g. HAL_delay(X)). */
  isFunctionCallStmt?: boolean;
  parsed: CppSymbolDefinition;
};


function isStatementIncomplete(text: string): boolean {
  const s = stripComments(text).trim();
  if (!s) return false;

  if (/^(case\b.*|default)\s*:\s*$/.test(s)) {
    return false;
  }

  // 1. parentesi / brace sbilanciate
  let paren = 0, brace = 0, bracket = 0;
  for (const c of s) {
    if (c === "(") paren++;
    else if (c === ")") paren--;
    // else if (c === "{") brace++;
    // else if (c === "}") brace--;
    else if (c === "[") bracket++;
    else if (c === "]") bracket--;
  }
  if (paren > 0 || brace > 0 || bracket > 0) return true;

  // Balanced, complete block-header lines never need continuation merging:
  // they carry no assignment/declaration on their own, and merging them with
  // a following '{' only serves to silently consume one extra physical line.
  // That's harmless when scanning a whole document, but combined with
  // viewport-range scanning (collectDocumentSymbolDefinitionsInLineRanges)
  // it can push the scan position one line past a range boundary right as a
  // block opens - and once past every range, the scan aborts entirely,
  // dropping the block's body (see BUGFIX: DC / else-block ghost values).
  if (/^(if|for|while|switch|catch)\s*\([\s\S]*\)\s*$/.test(s)) return false;
  if (/^else\s+if\s*\([\s\S]*\)\s*$/.test(s)) return false;
  if (/^(else|do|try)$/.test(s)) return false;

  // 2. operatori binari a fine riga
  if (/[+\-*/%&|^=,?:]$/.test(s)) return true;

  // 3. keyword di controllo con '('
  if (/^(if|for|while|switch)\b[^(]*\([^)]*$/.test(s)) return true;

  // 4. chiamata funzione aperta
  if (/^[A-Za-z_]\w*\s*\([^)]*$/.test(s)) return true;

  // Block headers are complete statements even without ';'
  if (!s.endsWith(";") && /[A-Za-z0-9_)]$/.test(s)) {
    return true;
  }

  return false;
}

function normalizeLineRanges(
  lineCount: number,
  lineRanges: readonly ViewportLineRange[] | undefined
): ViewportLineRange[] {
  if (!lineRanges || lineRanges.length === 0 || lineCount <= 0) {
    return [];
  }

  const normalized = lineRanges
    .map((range) => ({
      startLine: Math.max(0, Math.min(lineCount - 1, range.startLine)),
      endLine: Math.max(0, Math.min(lineCount - 1, range.endLine)),
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

function isLineInRanges(line: number, ranges: readonly ViewportLineRange[]): boolean {
  return ranges.some((range) => line >= range.startLine && line <= range.endLine);
}

function findNextRangeStart(
  line: number,
  ranges: readonly ViewportLineRange[]
): number | undefined {
  return ranges.find((range) => range.startLine > line)?.startLine;
}

/**
 * Collects C/C++ declarations parsed by parseCppSymbolDefinition.
 * Supports both top-level and local declarations to drive inline ghost values.
 * #define directives are parsed regardless of brace depth.
 * Multi-line #define directives using trailing "\" are merged into one
 * logical line before parsing.
 */
export function collectDocumentSymbolDefinitions(
  documentText: string
): DocumentSymbolDefinition[] {
  const lines = documentText.split(/\r?\n/);
  return collectDocumentSymbolDefinitionsFromLineSource({
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
  });
}

export function collectDocumentSymbolDefinitionsInLineRanges(
  source: LineTextSource,
  lineRanges: readonly ViewportLineRange[]
): DocumentSymbolDefinition[] {
  return collectDocumentSymbolDefinitionsFromLineSource(source, lineRanges);
}

function collectDocumentSymbolDefinitionsFromLineSource(
  source: LineTextSource,
  lineRanges?: readonly ViewportLineRange[]
): DocumentSymbolDefinition[] {
  const ranges = normalizeLineRanges(source.lineCount, lineRanges);
  const definitions: DocumentSymbolDefinition[] = [];
  let braceDepth = 0;
  let lineIndex = ranges.length > 0 ? ranges[0].startLine : 0;
  const commentSkip = createCommentStripper();

  while (lineIndex < source.lineCount) {
    if (ranges.length > 0 && !isLineInRanges(lineIndex, ranges)) {
      const nextLine = findNextRangeStart(lineIndex, ranges);
      if (nextLine == null) {
        break;
      }

      lineIndex = nextLine;
      continue;
    }

    // ---------------------------------------------------------------
    // Skip lines that are entirely inside a block comment.
    // isStatementIncomplete() uses stripComments() which is stateless
    // and cannot detect multi-line block comments.  If we let comment
    // lines through, isStatementIncomplete("* test") returns true
    // (ends with letter, no ";"), which triggers logical-line merging
    // that consumes the closing "*/" and the first statement line,
    // producing a merged text like:
    //
    //   " * test */ int z1 = PT100_NUM16(3);"
    //
    // That text may accidentally be parsed as a valid declaration
    // but with startLine pointing to the comment line instead of
    // the actual code line.  The result: every ghost value gets
    // placed at the wrong source location.
    // ---------------------------------------------------------------
    const rawLine = source.lineAt(lineIndex).text;
    const strippedLine = commentSkip.strip(rawLine);
    if (!strippedLine.trim()) {
      lineIndex++;
      continue;
    }

    const startLine = lineIndex;
    let lineText = rawLine;
    let continuationLines = 0;

    while (
      lineText.trimEnd().endsWith("\\") &&
      lineIndex + 1 < source.lineCount &&
      continuationLines < MAX_LOGICAL_LINE_CONTINUATION_LINES
    ) {
      lineIndex += 1;
      continuationLines += 1;
      lineText = `${lineText.trimEnd().slice(0, -1)} ${source.lineAt(lineIndex).text.trim()}`;
    }

    const isDefineLine = DEFINE_DIRECTIVE_RX.test(lineText);

    // Merge multi-line C statements (not #define) where semicolon is missing
    if (!isDefineLine && !lineText.trimStart().startsWith("#")) {
      while (
        lineIndex + 1 < source.lineCount &&
        isStatementIncomplete(lineText) &&
        !source.lineAt(lineIndex + 1).text.trimStart().startsWith("#") &&
        continuationLines < MAX_LOGICAL_LINE_CONTINUATION_LINES
      ) {
        lineIndex++;
        continuationLines += 1;
        lineText = `${lineText.trimEnd()} ${source.lineAt(lineIndex).text.trim()}`;
      }
    }

    const isControlFlow = CONTROL_FLOW_RX.test(lineText);

    if (isDefineLine) {
      const parsed = parseCppSymbolDefinition(lineText);
      if (parsed) {
        definitions.push({
          line: startLine,
          lineText,
          isDefineLine: true,
          parsed,
        });
      }
    } else if (isControlFlow) {
      // Best-effort expression extraction for control flow lines
      const exprMatch = lineText.match(/^[^(]*\((.*)\)[^)]*$/);
      const expr = exprMatch ? exprMatch[1].trim() : "";
      if (expr) {
        definitions.push({
          line: startLine,
          lineText,
          isDefineLine: false,
          parsed: {
            name: "", // anonymous expression
            expr: expr,
          },
        });
      }
    } else {
      // Handle potential multiple declarations on one line (e.g. "int a=1; int b=2;")
      const segments = lineText.split(";");
      for (const segment of segments) {
        const trimmed = segment.trim();
        if (!trimmed) continue;
        
        const parsed = parseCppSymbolDefinition(trimmed + ";");
        if (parsed) {
          definitions.push({
            line: startLine,
            lineText: segment + ";",
            isDefineLine: false,
            parsed,
          });
        } else {
          // parseCppSymbolDefinition requires "TYPE name = expr" (≥2 left-side tokens).
          // Plain assignments like `screen_state = SCREEN_OFF;` are silently dropped.
          // We still want to resolve and display the RHS as a ghost value.
          const assignMatch = (trimmed + ";").match(
            /^([A-Za-z_]\w*(?:\s*(?:->|\.)\s*[A-Za-z_]\w*|\s*\[\s*[^\]]+\s*\])*)\s*(\+|-|\*|\/|%|&|\||\^|<<|>>)?=(?!=)\s*(.+);$/
          );
          if (assignMatch) {
            const assignName = assignMatch[1].replace(/\s+/g, "");
            const compoundOp = assignMatch[2];
            const rhsExpr = assignMatch[3].trim();
            // Compound assignment (x += y, x <<= y, ...) is expanded to its
            // plain-assignment equivalent (x + (y)) so it flows through the
            // exact same downstream expression evaluator as "x = expr;".
            const assignExpr = compoundOp ? `${assignName} ${compoundOp} (${rhsExpr})` : rhsExpr;
            const isCKeyword =
              /^(if|else|while|for|do|switch|case|break|continue|return|goto|sizeof|typeof|typedef|struct|union|enum|const|volatile|static|extern|inline|int|char|short|long|float|double|unsigned|signed|void|bool)$/.test(
                assignName
              );

            // Skip assignments whose expression crosses a '}' boundary.
            // This typically happens when enum/struct/union body lines are
            // merged (e.g. "SCREEN_OFF = 1, SCREEN_ON, } screen_t;"), producing
            // incorrect ghost values. Enum members are already properly resolved
            // by extractEnumMembers() in the parser.
            if (!isCKeyword && assignExpr && !assignExpr.includes("}")) {
              definitions.push({
                line: startLine,
                lineText: segment + ";",
                isDefineLine: false,
                isAssignment: true,
                parsed: { name: assignName, expr: assignExpr },
              });
            }
          } else {
            // Detect switch case statements: case APP_INIT:
            const caseMatch = trimmed.match(/^\s*case\s+([A-Za-z_]\w*)\s*:/);
            if (caseMatch) {
              const caseSymbol = caseMatch[1];
              definitions.push({
                line: startLine,
                lineText: segment + ";",
                isDefineLine: false,
                parsed: { name: "", expr: caseSymbol },
              });
            } else {
              // Detect standalone function-call statements, e.g. HAL_delay(COMMENTED).
              // These are shown only as ghost value or via hover, never as code lens.
              const callNameMatch = trimmed.match(/^([A-Za-z_]\w*)\s*\(/);
              if (callNameMatch) {
                const callName = callNameMatch[1];
                const isCKeywordOrType =
                  /^(if|else|while|for|do|switch|case|break|continue|return|goto|sizeof|typeof|typedef|struct|union|enum|const|volatile|static|extern|inline|void|int|char|short|long|float|double|unsigned|signed|bool|NULL|null|true|false)$/.test(
                    callName
                  );
                if (!isCKeywordOrType) {
                  // Verify outer parentheses are balanced (the call ends at the last char)
                  let parenDepth = 0;
                  let callEnd = -1;
                  for (let ci = 0; ci < trimmed.length; ci++) {
                    if (trimmed[ci] === "(") {
                      parenDepth++;
                    } else if (trimmed[ci] === ")") {
                      parenDepth--;
                      if (parenDepth === 0) {
                        callEnd = ci;
                        break;
                      }
                    }
                  }
                  const balanced = callEnd !== -1;
                  const funcCallText = balanced ? trimmed.slice(0, callEnd + 1).trim() : trimmed;
                  if (balanced) {
                    definitions.push({
                      line: startLine,
                      lineText: segment + ";",
                      isDefineLine: false,
                      isFunctionCallStmt: true,
                      parsed: { name: "", expr: funcCallText },
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    braceDepth = updateBraceDepth(braceDepth, lineText);
    lineIndex += 1;
  }

  return definitions;
}

/**
 * Filters collected definitions by symbol name.
 */
export function findDocumentSymbolDefinitions(
  documentText: string,
  symbolName: string
): DocumentSymbolDefinition[] {
  return collectDocumentSymbolDefinitions(documentText).filter(
    (definition) => definition.parsed.name === symbolName
  );
}
