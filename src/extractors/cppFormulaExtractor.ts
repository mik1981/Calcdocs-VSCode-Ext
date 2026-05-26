import * as path from "path";
import * as vscode from "vscode";

import type { FormulaEntry } from "../types/FormulaEntry";

/**
 * C/C++ keywords that should NOT be treated as dependency identifiers.
 */
const C_KEYWORDS = new Set([
  "auto", "break", "case", "char", "const", "continue", "default", "do",
  "double", "else", "enum", "extern", "float", "for", "goto", "if",
  "inline", "int", "long", "register", "restrict", "return", "short",
  "signed", "sizeof", "static", "struct", "switch", "typedef", "union",
  "unsigned", "void", "volatile", "while", "bool", "true", "false",
  "uint8_t", "uint16_t", "uint32_t", "uint64_t",
  "int8_t", "int16_t", "int32_t", "int64_t",
  "size_t", "ssize_t", "uintptr_t", "intptr_t",
  "NULL", "nullptr",
]);

/**
 * Regex for inline variable definition with optional expression and trailing comment.
 *
 * Matches patterns like:
 *   float PRESSURE_DROP = 1.5;           // [Pa] Pressure drop
 *   const double SPEED = BASE * 2.0;     // [m/s]
 *   uint32_t COUNTER = 1000;             // [counts]
 *   int TEMP_OFFSET = someExpr + 5;      // [K] Temperature offset
 * Not used as a global constant; implemented inline in the main loop.
 */

/**
 * Regex for #define with optional expression and trailing comment.
 *
 * Matches patterns like:
 *   #define PRESSURE_DROP 1.5              // [Pa]
 *   #define SPEED (BASE * 2.0)             // [m/s]
 *   #define TEMP_OFFSET someExpr + 5       // K
 */
const DEFINE_PATTERN =
  /^\s*#\s*define\s+([A-Za-z_]\w*)(?:\([^)]*\))?\s+(.+)$/gm;

/**
 * Regex for extracting dependencies from an expression.
 * Picks word identifiers that are not C keywords and not numeric literals.
 */
function extractDeps(expr: string): string[] {
  const deps = new Set<string>();
  const identifierPattern = /\b([A-Za-z_]\w*)\b/g;
  let match: RegExpExecArray | null;

  while ((match = identifierPattern.exec(expr)) !== null) {
    const id = match[1];
    // Skip C keywords
    if (C_KEYWORDS.has(id)) {
      continue;
    }
    // Skip numeric literals (hex, binary, decimal)
    if (/^[0-9]/.test(id)) {
      continue;
    }
    deps.add(id);
  }

  return Array.from(deps);
}

/**
 * Extracts unit token from a trailing comment.
 * Supports: @unit=token, [token], or first unit-like word.
 */
function extractUnit(comment: string): string | undefined {
  if (!comment) {
    return undefined;
  }

  // Explicit @unit= tag
  const explicitMatch = comment.match(/@unit=([a-zA-Z0-9^*/_%-]+)/);
  if (explicitMatch) {
    return explicitMatch[1].trim();
  }

  // Bracket notation [unit]
  const bracketMatch = comment.match(/\[([a-zA-Z0-9^*/_%-]+)\]/);
  if (bracketMatch) {
    return bracketMatch[1].trim();
  }

  // First word that looks like a unit
  const trimmed = comment.trim();
  const wordMatch = trimmed.match(/^([A-Za-z%][A-Za-z0-9_%*/^.-]*)/);
  if (wordMatch) {
    return wordMatch[1].trim();
  }

  return undefined;
}

/**
 * Normalizes a C expression for the CalcDocs evaluator.
 * Handles:
 * - Explicit casts: `(uint32_t)expr` → `expr`
 * - Hex literals: `0xFF` → `255`
 * - Binary literals: `0b1010` → `10`
 * - Boolean literals: `true`/`false` → `1`/`0`
 */
export function normalizeExpression(expr: string): string {
  let normalized = expr
    .trim()
    // Remove explicit C-style casts
    .replace(/\(u?int\d+_t\)/g, "")
    .replace(/\(\s*(?:unsigned\s+|signed\s+)?(?:char|short|int|long|float|double)\s*\*?\s*\)/g, "")
    .replace(/\(\s*size_t\s*\)/g, "")
    // Remove leading/trailing parentheses wrapping the whole expression
    .replace(/^\s*\(\s*(.+)\s*\)\s*$/, "$1")
    .trim();

  // Replace boolean literals
  normalized = normalized
    .replace(/\btrue\b/g, "1")
    .replace(/\bfalse\b/g, "0");

  // Convert hex literals (0xFF → 255)
  normalized = normalized.replace(
    /\b0x([0-9a-fA-F]+)\b/g,
    (_, hex) => String(parseInt(hex, 16))
  );

  // Convert binary literals (0b1010 → 10)
  normalized = normalized.replace(
    /\b0b([01]+)\b/g,
    (_, bin) => String(parseInt(bin, 2))
  );

  // Convert octal literals when they start with 0 (e.g., 0777 → 511)
  // but be careful not to match decimal numbers starting with 0
  normalized = normalized.replace(
    /\b0([0-7]+)\b/g,
    (_, oct) => String(parseInt(oct, 8))
  );

  return normalized;
}

/**
 * Computes the 0-based line number for a given string index within the source.
 */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length - 1;
}

/**
 * Determines the expression type based on the expression content.
 */
function determineExprType(expression: string): "const" | "expr" {
  // If the expression contains operators or function calls, it's an expression
  if (/[+\-*/%<>&|^!~?:]|\(|\)/.test(expression)) {
    return "expr";
  }
  // If it's a pure numeric or identifier, it's a constant
  return "const";
}

/**
 * Checks if a line is a preprocessor conditional directive that should be skipped.
 */
function isPreprocessorConditional(line: string): boolean {
  return /^\s*#\s*(?:if|ifdef|ifndef|else|elif|endif)\b/.test(line);
}

/**
 * Main extraction function.
 * Scans a C/C++ source string and returns FormulaEntry[] compatible with
 * the CalcDocs evaluator model.
 */
export function extractFormulasFromCpp(
  source: string,
  uri: vscode.Uri,
  workspaceRoot: string
): FormulaEntry[] {
  const entries: FormulaEntry[] = [];
  const lines = source.split(/\r?\n/);
  const relativePath = path.relative(workspaceRoot, uri.fsPath);
  const seenKeys = new Set<string>();

  // Track which preprocessor branch we're in
  let inActiveBranch = true;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineText = lines[lineIdx];

    // Track preprocessor conditionals
    if (isPreprocessorConditional(lineText)) {
      // Simple heuristic: assume #if 0 blocks are inactive, everything else active
      if (/^\s*#\s*if\s+0\b/.test(lineText)) {
        inActiveBranch = false;
      } else if (/^\s*#\s*(?:else|elif)\b/.test(lineText) && !inActiveBranch) {
        inActiveBranch = true;
      } else if (/^\s*#\s*endif\b/.test(lineText)) {
        inActiveBranch = true;
      }
      continue;
    }

    // Skip lines in inactive preprocessor branches
    if (!inActiveBranch) {
      continue;
    }

    // Skip multiline comment blocks (lines starting with * or containing */)
    const trimmed = lineText.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("*/") || trimmed.startsWith("//")) {
      continue;
    }

    // Try to match #define pattern
    DEFINE_PATTERN.lastIndex = 0;
    const defineMatch = DEFINE_PATTERN.exec(lineText);
    if (defineMatch) {
      const [, name, rawTail] = defineMatch;
      if (seenKeys.has(name)) {
        continue; // Duplicate
      }
      seenKeys.add(name);

      // Extract comment from tail
      const commentEnd = rawTail.indexOf("//");
      const blockCommentEnd = rawTail.indexOf("/*");
      let comment = "";
      let exprPart = rawTail;

      if (commentEnd >= 0) {
        comment = rawTail.slice(commentEnd + 2).trim();
        exprPart = rawTail.slice(0, commentEnd).trim();
      } else if (blockCommentEnd >= 0) {
        const blockEnd = rawTail.indexOf("*/", blockCommentEnd + 2);
        comment = rawTail.slice(blockCommentEnd + 2, blockEnd >= 0 ? blockEnd : undefined).trim();
        exprPart = rawTail.slice(0, blockCommentEnd).trim();
      }

      const normalizedExpr = normalizeExpression(exprPart);
      entries.push({
        key: name,
        unit: extractUnit(comment),
        formula: normalizedExpr,
        exprType: determineExprType(normalizedExpr),
        steps: [],
        labels: [],
        valueYaml: undefined,
        expanded: exprPart.trim(),
        resolvedDependencies: extractDeps(normalizedExpr),
        valueCalc: null,
        _filePath: relativePath,
        _line: lineIdx,
      });
      continue;
    }

    // Try to match inline const variable pattern
    const varRegex = new RegExp(
      "^(?:static\\s+)?(?:const\\s+)?(?:volatile\\s+)?" +
      "(?:unsigned\\s+|signed\\s+)?" +
      "(?:char|short|int|long|float|double|uint\\d+_t|int\\d+_t|size_t|ssize_t)" +
      "\\s+([A-Za-z_]\\w*)\\s*=\\s*([^;]+);(?:\\s*\\/\\/(.+))?$"
    );

    const varMatch = lineText.match(varRegex);
    if (varMatch) {
      const [, name, exprRaw, comment] = varMatch;
      if (seenKeys.has(name)) {
        continue;
      }
      seenKeys.add(name);

      const normalizedExpr = normalizeExpression(exprRaw);
      entries.push({
        key: name,
        unit: extractUnit(comment ?? ""),
        formula: normalizedExpr,
        exprType: determineExprType(normalizedExpr),
        steps: [],
        labels: [],
        valueYaml: undefined,
        expanded: exprRaw.trim(),
        resolvedDependencies: extractDeps(normalizedExpr),
        valueCalc: null,
        _filePath: relativePath,
        _line: lineIdx,
      });
      continue;
    }
  }

  return entries;
}

/**
 * Detects the language of a file based on its extension.
 */
export function detectLanguage(uri: vscode.Uri): "yaml" | "c" | "cpp" {
  const ext = uri.fsPath.toLowerCase();
  if (/\.(yaml|yml)$/i.test(ext)) {
    return "yaml";
  }
  if (/\.(h|hpp|hxx)$/i.test(ext)) {
    return "cpp"; // Headers treated as C++ for formula extraction
  }
  if (/\.(c|cc|cpp|cxx)$/i.test(ext)) {
    return "cpp";
  }
  return "cpp"; // Default to cpp for unknown extensions
}

/**
 * Determines if a file is a C/C++ source file.
 */
export function isCppLanguage(languageId: string): boolean {
  return /^c$|^cpp$|^cuda-cpp$/i.test(languageId);
}

/**
 * Determines if a file extension belongs to C/C++.
 */
export function isCppExtension(uri: vscode.Uri): boolean {
  return /\.(c|cc|cpp|cxx|h|hpp|hxx)$/i.test(uri.fsPath);
}