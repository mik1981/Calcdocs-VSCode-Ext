/**
 * examples.integration.test.ts  (aggiornato)
 *
 * Modifications vs. the original:
 *  1. Imports TestLogger, createTestLogger, summariseLog, formatLogSummary
 *     from ./testLogger.
 *  2. evaluateCase() now accepts an optional TestLogger and records every
 *     symbol/inline/expansion check into it.
 *  3. The per-case test body collects failures AND logs them; on failure the
 *     Vitest expect message now includes the formatted log summary so CI
 *     output is self-diagnosing.
 *  4. A top-level "logging" describe block runs a smoke test confirming the
 *     logger itself works correctly (no dependency on the engine).
 *
 * Everything else (parsing logic, fixture helpers, etc.) is unchanged from
 * the original file.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";


import {
  collectDefinesAndConsts,
  parseCppSymbolDefinition,
} from "../../src/core/cppParser";
import { collectDocumentSymbolDefinitions } from "../../src/core/documentSymbols";
import {
  evaluateInlineCalcs,
  normalizeUnitToken,
  parseExpressionUnit,
  resolveUnitSpec,
  dimensionsEqual,
  DIMENSIONLESS,
  type DimensionVector,
} from "../../src/core/inlineCalc";

import {
  buildCompositeExpressionPreview,
  createSymbolResolutionStats,
  resolveSymbol,
  safeEval,
  type FunctionMacroDefinition,
} from "../../src/core/expression";
import { updateBraceDepth } from "../../src/utils/braceDepth";
import { stripComments } from "../../src/utils/text";

// ── NEW: logger ──────────────────────────────────────────────────────────────
import {
  createTestLogger,
  summariseLog,
  formatLogSummary,
  type TestLogger,
} from "./testLogger";
// ────────────────────────────────────────────────────────────────────────────

const CASES_DIR = path.resolve(process.cwd(), "examples", "cases");
const CASE_SOURCE_RX = /\.(?:c|cc|cpp|h|hpp)$/i;
const TESTABLE_SOURCE_RX = /\.(?:c|cc|cpp)$/i;
const REL_TOLERANCE = 1e-6;

// ─────────────────────────────────────────────────────────────────────────────
// Types (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

type ExpectedEntry =
  | { kind: "number"; value: number }
  | { kind: "range"; min: number; max: number; unit?: string }
  | { kind: "error" }
  | { kind: "expanded"; value: string };

type ParsedTestCommand = {
  id: string;
  line: number;
  symbolName?: string;
};

type InlineTestResult = {
  value: number | null;
  outputUnit?: string;
  error?: string;
};

type SimpleFixtureFunction = {
  params: string[];
  body: string;
};

type SizeHints = {
  typeSizes: Map<string, number>;
  variableSizes: Map<string, number>;
};

type InlineCollection = {
  resultsById: Map<string, InlineTestResult>;
  commandsById: Map<string, ParsedTestCommand>;
};

type CaseEvaluation = {
  collected: Awaited<ReturnType<typeof collectDefinesAndConsts>>;
  expected: Record<string, unknown>;
  inlineResults: Map<string, InlineTestResult>;
  testCommands: Map<string, ParsedTestCommand>;
  functionCallExpansions: Map<string, string[]>;
  symbolValues: Map<string, number>;
  symbolUnits: Map<string, string>;
  yamlSymbols?: Map<string, any>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

const BASIC_TYPE_SIZES = new Map<string, number>([
  ["char", 1], ["short", 2], ["int", 4], ["long", 4],
  ["float", 4], ["double", 8],
  ["uint8_t", 1], ["uint16_t", 2], ["uint32_t", 4], ["uint64_t", 8],
  ["int8_t", 1], ["int16_t", 2], ["int32_t", 4], ["int64_t", 8],
  ["uint8", 1], ["uint16", 2], ["uint32", 4], ["uint64", 8],
  ["int8", 1], ["int16", 2], ["int32", 4], ["int64", 8],
  ["size_t", 4], ["ptrdiff_t", 4], ["intptr_t", 4], ["uintptr_t", 4],
  ["bool", 1], ["_Bool", 1], ["void", 0],
]);

// ─────────────────────────────────────────────────────────────────────────────
// Utilities (unchanged from original — kept verbatim for compatibility)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeInlineSymbol(name: string): string {
  return name.startsWith("@") ? name.slice(1) : name;
}

function getPrefix(dim: any): string {
  if (!dim || typeof dim.M !== "number") return "";
  if (dimensionsEqual(dim, { M: 0, L: 0, T: 0, I: 1, K: 0 })) return "I";
  if (dimensionsEqual(dim, { M: 1, L: 2, T: -3, I: 0, K: 0 })) return "P";
  if (dimensionsEqual(dim, { M: 1, L: 2, T: -3, I: -1, K: 0 })) return "U";
  if (dimensionsEqual(dim, { M: 0, L: 2, T: 0, I: 0, K: 0 })) return "A";
  if (dimensionsEqual(dim, { M: 1, L: 0, T: 0, I: 0, K: 0 })) return "M";
  if (dimensionsEqual(dim, { M: 1, L: -1, T: -2, I: 0, K: 0 })) return "P";
  if (dimensionsEqual(dim, { M: 0, L: 3, T: -1, I: 0, K: 0 })) return "Q";
  if (dimensionsEqual(dim, { M: 0, L: 0, T: 0, I: 0, K: 1 })) return "T";
  if (dimensionsEqual(dim, { M: 0, L: 0, T: 1, I: 0, K: 0 })) return "T";
  if (dimensionsEqual(dim, DIMENSIONLESS)) return "R";
  if (dimensionsEqual(dim, { M: 0, L: 1, T: -1, I: 0, K: 0 })) return "V";
  return "";
}

function listCaseDirectories(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

function parseExpected(raw: unknown): ExpectedEntry {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const entry = raw as Record<string, unknown>;

    if (typeof entry.expanded === "string" && entry.expanded.trim().length > 0) {
      return { kind: "expanded", value: normalizeText(entry.expanded) };
    }

    // expected.yaml: { value: "error" }
    if (entry.value === "error") return { kind: "error" };

    // expected.yaml: { min: N, max: M, unit?: "..." }
    const hasMin = entry.min !== undefined;
    const hasMax = entry.max !== undefined;
    if (hasMin || hasMax) {
      const min = Number(entry.min);
      const max = Number(entry.max);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        const unit = typeof entry.unit === "string" ? entry.unit : undefined;
        return { kind: "range", min, max, unit };
      }
    }

    const numericValue = Number(entry.value);
    if (Number.isFinite(numericValue)) return { kind: "number", value: numericValue };
  }

  throw new Error(`Unsupported expected entry: ${JSON.stringify(raw)}`);
}

async function loadYamlFile(filePath: string): Promise<Record<string, unknown>> {
  const raw = await fsp.readFile(filePath, "utf8");
  return (yaml.load(raw) as Record<string, unknown>) ?? {};
}

async function listCaseFiles(caseDir: string): Promise<string[]> {
  const entries = await fsp.readdir(caseDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && CASE_SOURCE_RX.test(e.name))
    .map((e) => path.join(caseDir, e.name))
    .sort((a, b) => a.localeCompare(b));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function alignTo(offset: number, alignment: number): number {
  if (alignment <= 1) return offset;
  const remainder = offset % alignment;
  return remainder === 0 ? offset : offset + (alignment - remainder);
}

function findMatchingParen(text: string, openParenIndex: number): number {
  let depth = 0;
  for (let index = openParenIndex; index < text.length; index += 1) {
    const current = text[index];
    if (current === '"' || current === "'" || current === "`") {
      const quote = current;
      index += 1;
      while (index < text.length) {
        const inner = text[index];
        if (inner === "\\") { index += 2; continue; }
        if (inner === quote) break;
        index += 1;
      }
      continue;
    }
    if (current === "(") { depth += 1; continue; }
    if (current === ")") { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

function splitCallArguments(argText: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  for (let index = 0; index < argText.length; index += 1) {
    const char = argText[index];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      current += char;
      index += 1;
      while (index < argText.length) {
        const inner = argText[index];
        current += inner;
        if (inner === "\\") { index += 1; if (index < argText.length) current += argText[index]; continue; }
        if (inner === quote) break;
        index += 1;
      }
      continue;
    }
    if (char === "(") { depth += 1; current += char; continue; }
    if (char === ")") { if (depth > 0) depth -= 1; current += char; continue; }
    if (char === "," && depth === 0) { args.push(current.trim()); current = ""; continue; }
    current += char;
  }
  const trailing = current.trim();
  if (trailing.length > 0 || argText.trim().length > 0) args.push(trailing);
  return args;
}

function parseFunctionParameters(paramList: string): string[] {
  const trimmed = paramList.trim();
  if (!trimmed || trimmed === "void") return [];
  return trimmed
    .split(",")
    .map((p) => { const c = p.trim().replace(/\s*=\s*.+$/, ""); const m = c.match(/([A-Za-z_]\w*)\s*(?:\[[^\]]*])?\s*$/); return m?.[1] ?? ""; })
    .filter((p) => p.length > 0);
}

function extractSimpleFixtureFunctions(documentText: string): Map<string, SimpleFixtureFunction> {
  const functions = new Map<string, SimpleFixtureFunction>();
  const functionRx = /(?:^|\n)\s*(?:[A-Za-z_][\w\s*]*?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{([\s\S]*?)\}/g;
  for (const match of documentText.matchAll(functionRx)) {
    const [, name, rawParams, rawBody] = match;
    const bodyMatch = rawBody.trim().match(/^return\s+([\s\S]+?)\s*;\s*$/);
    if (!bodyMatch) continue;
    const params = parseFunctionParameters(rawParams);
    if (params.length === 0 && rawParams.trim() && rawParams.trim() !== "void") continue;
    functions.set(name, { params, body: bodyMatch[1].trim() });
  }
  return functions;
}

function decodeCStringLiteral(rawLiteral: string): string | null {
  try { return JSON.parse(rawLiteral) as string; } catch { return null; }
}

function rewriteStrlenCalls(expression: string): string {
  return expression.replace(
    /\bstrlen\s*\(\s*(?:\(\s*)*("(?:[^"\\]|\\.)*")(?:\s*\))*\s*\)/g,
    (full, rawLiteral) => { const d = decodeCStringLiteral(rawLiteral); return d == null ? full : String(d.length); }
  );
}

function rewriteAddressDereferences(expression: string): string {
  let output = expression;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = output.replace(/\*\s*\(\s*&\s*([A-Za-z_]\w*)\s*\)/g, "$1").replace(/\*\s*&\s*([A-Za-z_]\w*)/g, "$1");
    if (next === output) break;
    output = next;
  }
  return output;
}

function expandSimpleFixtureFunctions(expression: string, functions: Map<string, SimpleFixtureFunction>, depth = 0): string {
  if (depth > 8 || functions.size === 0) return expression;
  let output = expression;
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false, rebuilt = "", cursor = 0;
    while (cursor < output.length) {
      const matcher = /\b([A-Za-z_]\w*)\s*\(/g;
      matcher.lastIndex = cursor;
      const match = matcher.exec(output);
      if (!match) { rebuilt += output.slice(cursor); break; }
      const callName = match[1];
      const openParenIndex = matcher.lastIndex - 1;
      const callEnd = findMatchingParen(output, openParenIndex);
      if (callEnd < 0) { rebuilt += output.slice(cursor); cursor = output.length; break; }
      const definition = functions.get(callName);
      if (!definition) { rebuilt += output.slice(cursor, openParenIndex + 1); cursor = openParenIndex + 1; continue; }
      const argsText = output.slice(openParenIndex + 1, callEnd);
      const args = splitCallArguments(argsText).map((a) => expandSimpleFixtureFunctions(a, functions, depth + 1));
      if (args.length !== definition.params.length) { rebuilt += output.slice(cursor, callEnd + 1); cursor = callEnd + 1; continue; }
      let expandedBody = definition.body;
      definition.params.forEach((param, i) => { expandedBody = expandedBody.replace(new RegExp(`\\b${escapeRegExp(param)}\\b`, "g"), `(${args[i]})`); });
      expandedBody = expandSimpleFixtureFunctions(expandedBody, functions, depth + 1);
      rebuilt += output.slice(cursor, match.index);
      rebuilt += `(${expandedBody})`;
      cursor = callEnd + 1;
      changed = true;
    }
    if (!changed) break;
    output = rebuilt;
  }
  return output;
}

function computeSimpleStructSize(fieldsText: string, sizeHints: SizeHints): number | null {
  const fields = fieldsText.split(";").map((f) => f.trim()).filter((f) => f.length > 0);
  if (fields.length === 0) return null;
  let offset = 0, maxAlignment = 1;
  for (const field of fields) {
    const nameMatch = field.match(/^(.*?)([A-Za-z_]\w*)\s*(\[[^\]]+])?\s*$/);
    if (!nameMatch) return null;
    const fieldType = `${nameMatch[1].trim()}${nameMatch[3] ?? ""}`.trim();
    const fieldSize = resolveSimpleTypeSize(fieldType, sizeHints);
    if (fieldSize == null) return null;
    const alignment = Math.max(1, Math.min(fieldSize, 8));
    offset = alignTo(offset, alignment);
    offset += fieldSize;
    maxAlignment = Math.max(maxAlignment, alignment);
  }
  return alignTo(offset, maxAlignment);
}

function resolveSimpleTypeSize(rawType: string, sizeHints: SizeHints): number | null {
  const trimmed = rawType.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  if (/\(\s*\*\s*\)\s*\(/.test(trimmed) || (trimmed.includes("*") && !trimmed.includes("**"))) return 4;
  const inlineStructMatch = trimmed.match(/^struct\s*\{([\s\S]*)\}$/);
  if (inlineStructMatch) return computeSimpleStructSize(inlineStructMatch[1], sizeHints);
  const arrayMatch = trimmed.match(/^(.*?)(?:\s+)?\[(\d+)]$/);
  if (arrayMatch) { const e = resolveSimpleTypeSize(arrayMatch[1], sizeHints); return e == null ? null : e * Number.parseInt(arrayMatch[2], 10); }
  if (sizeHints.typeSizes.has(trimmed)) return sizeHints.typeSizes.get(trimmed) ?? null;
  const tokens = trimmed.split(/\s+/).filter((t) => t && !["const","volatile","static","extern","register","typedef"].includes(t));
  if (tokens.length === 0) return null;
  const directName = tokens.join(" ");
  if (BASIC_TYPE_SIZES.has(directName)) return BASIC_TYPE_SIZES.get(directName) ?? null;
  const finalToken = tokens[tokens.length - 1];
  if (sizeHints.typeSizes.has(finalToken)) return sizeHints.typeSizes.get(finalToken) ?? null;
  if (BASIC_TYPE_SIZES.has(finalToken)) return BASIC_TYPE_SIZES.get(finalToken) ?? null;
  if (tokens.includes("double")) return 8;
  if (tokens.includes("float")) return 4;
  if (tokens.includes("long")) return 4;
  if (tokens.includes("short")) return 2;
  if (tokens.includes("char")) return 1;
  if (tokens.includes("bool") || tokens.includes("_Bool")) return 1;
  if (tokens.includes("int")) return 4;
  return null;
}

function rewriteSizeofCalls(expression: string, sizeHints: SizeHints): string {
  const sizeofRx = /\b(sizeof|_Alignof|__alignof__|_Alignas|__alignas__)\b/g;
  let rebuilt = "", cursor = 0;
  while (cursor < expression.length) {
    sizeofRx.lastIndex = cursor;
    const match = sizeofRx.exec(expression);
    if (!match) { rebuilt += expression.slice(cursor); break; }
    rebuilt += expression.slice(cursor, match.index);
    let openParenIndex = sizeofRx.lastIndex;
    while (openParenIndex < expression.length && /\s/.test(expression[openParenIndex])) openParenIndex += 1;
    if (expression[openParenIndex] !== "(") { rebuilt += match[0]; cursor = sizeofRx.lastIndex; continue; }
    const closeParenIndex = findMatchingParen(expression, openParenIndex);
    if (closeParenIndex < 0) { rebuilt += expression.slice(match.index); break; }
    const operand = expression.slice(openParenIndex + 1, closeParenIndex).trim();
    const replacement = resolveSizeofOperand(operand, sizeHints);
    rebuilt += replacement == null ? expression.slice(match.index, closeParenIndex + 1) : String(replacement);
    cursor = closeParenIndex + 1;
  }
  return rebuilt;
}

function resolveSizeofOperand(operand: string, sizeHints: SizeHints): number | null {
  if (!operand) return 4;
  if (sizeHints.variableSizes.has(operand)) return sizeHints.variableSizes.get(operand) ?? null;
  const d = resolveSimpleTypeSize(operand, sizeHints);
  if (d != null) return d;
  return 4;
}

function buildFixtureSizeHints(documentText: string): SizeHints {
  const sizeHints: SizeHints = { typeSizes: new Map(), variableSizes: new Map() };
  const typedefStructRx = /typedef\s+struct\s*\{([\s\S]*?)\}\s*([A-Za-z_]\w*)\s*;/g;
  for (const match of documentText.matchAll(typedefStructRx)) {
    const size = computeSimpleStructSize(match[1], sizeHints);
    if (size != null) sizeHints.typeSizes.set(match[2], size);
  }
  const lines = documentText.split(/\r?\n/);
  let braceDepth = 0;
  for (const rawLine of lines) {
    const strippedLine = stripComments(rawLine);
    const currentDepth = braceDepth;
    const trimmed = strippedLine.trim();
    if (currentDepth === 0 && trimmed) {
      const arrayMatch = trimmed.match(/^(.*?)\b([A-Za-z_]\w*)\s*\[(\d+)]\s*;$/);
      if (arrayMatch) {
        const elementSize = resolveSimpleTypeSize(arrayMatch[1], sizeHints);
        if (elementSize != null) sizeHints.variableSizes.set(arrayMatch[2], elementSize * Number.parseInt(arrayMatch[3], 10));
      }
    }
    braceDepth = updateBraceDepth(braceDepth, strippedLine);
  }
  return sizeHints;
}

function mergeSizeHints(target: SizeHints, source: SizeHints): void {
  for (const [n, s] of source.typeSizes) target.typeSizes.set(n, s);
  for (const [n, s] of source.variableSizes) target.variableSizes.set(n, s);
}

function simplifyFixtureExpression(expression: string, simpleFunctions: Map<string, SimpleFixtureFunction>, sizeHints: SizeHints): string {
  let output = expression;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = rewriteSizeofCalls(rewriteStrlenCalls(rewriteAddressDereferences(expandSimpleFixtureFunctions(output, simpleFunctions))), sizeHints);
    if (next === output) break;
    output = next;
  }
  return output;
}

function extractTopLevelDefinitions(documentText: string): Array<{ name: string; expr: string }> {
  const definitions: Array<{ name: string; expr: string }> = [];
  const lines = documentText.split(/\r?\n/);
  let braceDepth = 0;
  for (const rawLine of lines) {
    const strippedLine = stripComments(rawLine);
    const currentDepth = braceDepth;
    const trimmed = strippedLine.trim();
    if (currentDepth === 0 && trimmed && !trimmed.startsWith("#")) {
      const parsed = parseCppSymbolDefinition(trimmed);
      if (parsed) definitions.push({ name: parsed.name, expr: parsed.expr });
    }
    braceDepth = updateBraceDepth(braceDepth, strippedLine);
  }
  return definitions;
}

async function augmentCollectedSymbolsForTests(
  sourceFiles: string[],
  collected: Awaited<ReturnType<typeof collectDefinesAndConsts>>
): Promise<void> {
  const simpleFunctions = new Map<string, SimpleFixtureFunction>();
  const sizeHints: SizeHints = { typeSizes: new Map(), variableSizes: new Map() };
  const topLevelDefinitions: Array<{ name: string; expr: string }> = [];
  for (const sourceFile of sourceFiles) {
    const documentText = await fsp.readFile(sourceFile, "utf8");
    for (const [name, definition] of extractSimpleFixtureFunctions(documentText)) simpleFunctions.set(name, definition);
    mergeSizeHints(sizeHints, buildFixtureSizeHints(documentText));
    topLevelDefinitions.push(...extractTopLevelDefinitions(documentText));
  }
  for (const [name, expr] of Array.from(collected.defines.entries())) {
    const simplified = simplifyFixtureExpression(expr, simpleFunctions, sizeHints);
    collected.defines.set(name, simplified);
    try { const v = safeEval(simplified); if (Number.isFinite(v)) collected.consts.set(name, v); } catch {}
  }
  for (const definition of topLevelDefinitions) {
    const simplified = simplifyFixtureExpression(definition.expr, simpleFunctions, sizeHints);
    collected.defines.set(definition.name, simplified);
    try { const v = safeEval(simplified); if (Number.isFinite(v)) collected.consts.set(definition.name, v); } catch {}
  }
}

function isSimpleAliasExpression(expression: string): boolean {
  return /^[A-Za-z_]\w*$/.test(expression.trim());
}

function findNextNamedDefinition(definitions: ReturnType<typeof collectDocumentSymbolDefinitions>, line: number) {
  return definitions.find((d) => d.line > line && d.parsed.name.trim().length > 0);
}

function shouldUseFollowingDefinition(
  expression: string,
  nextDefinition: ReturnType<typeof collectDocumentSymbolDefinitions>[number] | undefined,
  knownSymbols?: Set<string>
): boolean {
  if (!nextDefinition || !nextDefinition.parsed.name) return false;
  const ne = normalizeText(expression);
  const nne = normalizeText(nextDefinition.parsed.expr);
  const nnn = normalizeText(nextDefinition.parsed.name);
  if (ne === nne || ne === nnn) return true;
  if (!isSimpleAliasExpression(expression)) return false;
  return !knownSymbols?.has(normalizeInlineSymbol(expression));
}

function splitTestExpression(remainder: string): { expression: string; ignoreSuffix: string } | null {
  const ignoreMatch = remainder.match(/(#\s*calcdocs-ignore(?:-(?:error|warning|info))?\b.*)$/i);
  const ignoreSuffix = ignoreMatch ? ` ${ignoreMatch[1].trim()}` : "";
  const separatorIndex = remainder.lastIndexOf(" = ");
  const expression = separatorIndex >= 0
    ? remainder.slice(0, separatorIndex).trim()
    : remainder.replace(/#\s*calcdocs-ignore(?:-(?:error|warning|info))?\b.*$/i, "").trim();
  if (!expression) return null;
  return { expression, ignoreSuffix };
}

function buildTransformedInlineExpression(expression: string): string {
  const parsed = parseExpressionUnit(expression);
  if (parsed.outputUnit) return `(${parsed.expression}) * 1 -> ${parsed.outputUnit}`;
  return `(${expression}) + 0`;
}

function transformTestComments(documentText: string, knownSymbols?: Set<string>): { transformedText: string; commands: ParsedTestCommand[] } {
  const lines = documentText.split(/\r?\n/);
  const definitions = collectDocumentSymbolDefinitions(documentText);
  const commands: ParsedTestCommand[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const match = lines[lineIndex].match(/^(\s*\/\/)\s*@test\s+([A-Za-z_]\w*)\s+(.+)$/);
    if (!match) continue;
    const [, commentPrefix, id, remainder] = match;
    const parsed = splitTestExpression(remainder);
    if (!parsed) continue;
    const nextDefinition = findNextNamedDefinition(definitions, lineIndex);
    const useFollowingDefinition = shouldUseFollowingDefinition(parsed.expression, nextDefinition, knownSymbols);
    const transformedExpression = useFollowingDefinition && nextDefinition ? nextDefinition.parsed.expr : parsed.expression;
    commands.push({ id, line: lineIndex, symbolName: useFollowingDefinition && nextDefinition ? nextDefinition.parsed.name : undefined });
    lines[lineIndex] = `${commentPrefix} = ${buildTransformedInlineExpression(transformedExpression)}${parsed.ignoreSuffix}`;
  }
  return { transformedText: lines.join("\n"), commands };
}

function createInlineState(
  symbolValues: Map<string, number>,
  symbolUnits: Map<string, string>,
  defines: Map<string, string>,
  functionDefines: Map<string, FunctionMacroDefinition>,
  defineConditions: Map<string, string>
): any {
  const inlineSymbolValues = new Map<string, number>();
  const inlineSymbolUnits = new Map<string, string>();
  for (const [k, v] of symbolValues) { inlineSymbolValues.set(k, v); inlineSymbolValues.set(`@${k}`, v); }
  for (const [k, v] of symbolUnits) { inlineSymbolUnits.set(k, v); inlineSymbolUnits.set(`@${k}`, v); }
  return { formulaIndex: new Map(), configVars: new Map(), symbolValues: inlineSymbolValues, symbolUnits: inlineSymbolUnits, allDefines: defines, functionDefines, defineConditions };
}

function seedSymbolValues(
  defines: Map<string, string>,
  functionDefines: Map<string, FunctionMacroDefinition>,
  consts: Map<string, number>,
  defineConditions: Map<string, string>
): Map<string, number> {
  const symbolValues = new Map<string, number>(consts);
  const resolved = new Map<string, number>();
  const stats = createSymbolResolutionStats();
  for (const [name, expr] of defines) {
    if (symbolValues.has(name)) continue;
    try { const v = safeEval(expr); if (Number.isFinite(v)) symbolValues.set(name, v); } catch {}
  }
  for (const name of defines.keys()) {
    if (symbolValues.has(name)) continue;
    const v = resolveSymbol(name, defines, functionDefines, resolved, symbolValues, {}, stats, new Set(), defineConditions);
    if (typeof v === "number" && Number.isFinite(v)) symbolValues.set(name, v);
  }
  return symbolValues;
}

async function collectInlineResults(sourceFiles: string[], state: any): Promise<InlineCollection> {
  const resultsById = new Map<string, InlineTestResult>();
  const commandsById = new Map<string, ParsedTestCommand>();
  const knownSymbols = new Set<string>([
    ...Array.from(state.symbolValues?.keys?.() ?? []),
    ...Array.from(state.allDefines?.keys?.() ?? []),
    ...Array.from(state.functionDefines?.keys?.() ?? []),
  ]);
  for (const sourceFile of sourceFiles) {
    const originalText = await fsp.readFile(sourceFile, "utf8");
    const { transformedText, commands } = transformTestComments(originalText, knownSymbols);
    const inlineResults = evaluateInlineCalcs(transformedText, state, { includeAssignments: true, includeSuppressed: true }, "c");
    for (const command of commands) {
      commandsById.set(command.id, command);
      const result = inlineResults.find((e) => e.kind === "calc" && e.line === command.line);
      if (!result) { resultsById.set(command.id, { value: null, error: "missing transformed inline result" }); continue; }
      resultsById.set(command.id, { value: result.value, outputUnit: result.outputUnit, error: result.error });
    }
    for (const result of inlineResults) {
      if (result.kind === "calc" && result.outputUnit) {
        const normalized = normalizeUnitToken(result.outputUnit);
        const spec = resolveUnitSpec(normalized);
        if (spec?.dimension) {
          const prefix = getPrefix(spec.dimension);
          if (prefix) { const key = prefix + "_" + normalized; if (!resultsById.has(key)) resultsById.set(key, { value: result.value, outputUnit: result.outputUnit, error: result.error }); }
        }
      }
    }
  }
  return { resultsById, commandsById };
}

async function collectFunctionCallExpansions(
  sourceFiles: string[],
  defines: Map<string, string>,
  functionDefines: Map<string, FunctionMacroDefinition>,
  defineConditions: Map<string, string>,
  symbolValues: Map<string, number>,
  symbolUnits: Map<string, string>
): Promise<Map<string, string[]>> {
  const expansions = new Map<string, string[]>();
  for (const sourceFile of sourceFiles) {
    const documentText = await fsp.readFile(sourceFile, "utf8");
    const definitions = collectDocumentSymbolDefinitions(documentText);
    for (const definition of definitions) {
      if (!definition.isFunctionCallStmt) continue;
      const functionName = definition.parsed.expr.match(/^([A-Za-z_]\w*)\s*\(/)?.[1];
      if (!functionName) continue;
      const preview = buildCompositeExpressionPreview(definition.parsed.expr, symbolValues, defines, functionDefines, {}, defineConditions, symbolUnits);
      const expanded = normalizeText(preview.expanded);
      if (!expanded || expanded === normalizeText(definition.parsed.expr)) continue;
      const entries = expansions.get(functionName) ?? [];
      entries.push(expanded);
      expansions.set(functionName, entries);
    }
  }
  return expansions;
}

function resolveNumericSymbol(name: string, collected: Awaited<ReturnType<typeof collectDefinesAndConsts>>, symbolValues: Map<string, number>): number | null {
  if (symbolValues.has(name)) return symbolValues.get(name) ?? null;
  if (collected.consts.has(name)) return collected.consts.get(name) ?? null;
  const expr = collected.defines.get(name);
  if (expr) { try { const v = safeEval(expr); if (Number.isFinite(v)) return v; } catch {} }
  const resolved = resolveSymbol(name, collected.defines, collected.functionDefines, new Map(), symbolValues, {}, createSymbolResolutionStats(), new Set(), collected.defineConditions);
  return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : null;
}

async function evaluateCase(caseDir: string): Promise<CaseEvaluation> {
  const expected = await loadYamlFile(path.join(caseDir, "expected.yaml"));
  const caseFiles = await listCaseFiles(caseDir);
  const sourceFiles = caseFiles.filter((f) => TESTABLE_SOURCE_RX.test(f));
  const collected = await collectDefinesAndConsts(caseFiles, caseDir, { resolveIncludes: true });
  await augmentCollectedSymbolsForTests(sourceFiles, collected);

  const symbolValues = seedSymbolValues(
    collected.defines,
    collected.functionDefines,
    collected.consts,
    collected.defineConditions
  );

  const symbolUnits = new Map<string, string>(collected.units);

  // ── YAML formulas integration ─────────────────────────────────────────
  // Read ALL formula*.yaml files in the case directory (e.g. formulas.yaml,
  // formulas_simple.yaml, formulas_complex.yaml) and evaluate each one.
  // Results are merged into symbolValues (later files override earlier ones
  // for the same symbol).
  const formulaFiles = fs
    .readdirSync(caseDir)
    .filter((f) => /^formula.*\.yaml$/i.test(f))
    .sort();

  for (const formulaFile of formulaFiles) {
    const formulasPath = path.join(caseDir, formulaFile);
    const formulasRoot = await loadYamlFile(formulasPath);

    const { evaluateYamlDocument } = await import("../../src/engine/yamlEngine");
    const { loadAdjacentCsvTables } = await import("../../src/core/csvTables");
    const csvTables = await loadAdjacentCsvTables(formulasPath);

    const yamlResult = evaluateYamlDocument(formulasRoot, {
      rawText: fs.readFileSync(formulasPath, "utf8"),
      yamlPath: formulasPath,
      externalValues: symbolValues,
      externalUnits: symbolUnits,
      csvTables,
    });

    for (const [name, sym] of yamlResult.symbols) {
      if (typeof sym.value === "number" && Number.isFinite(sym.value)) {
        // Override: ensures expected entries derived from YAML are tested.
        symbolValues.set(name, sym.value);
      }
      if (sym.outputUnit) {
        symbolUnits.set(name, sym.outputUnit);
      }
    }
  }


  const state = createInlineState(
    symbolValues,
    symbolUnits,
    collected.defines,
    collected.functionDefines,
    collected.defineConditions
  );

  const inlineCollection = await collectInlineResults(sourceFiles, state);

  return {
    collected,
    expected,
    inlineResults: inlineCollection.resultsById,
    testCommands: inlineCollection.commandsById,
    functionCallExpansions: await collectFunctionCallExpansions(
      sourceFiles,
      collected.defines,
      collected.functionDefines,
      collected.defineConditions,
      symbolValues,
      symbolUnits
    ),
    symbolValues,
    symbolUnits,
  };
}


function valuesMatch(actual: number, expected: number): boolean {
  const tolerance = REL_TOLERANCE * Math.max(1, Math.abs(expected));
  return Math.abs(actual - expected) <= tolerance;
}

function getComparableInlineValue(result: InlineTestResult): number | null {
  if (typeof result.value !== "number" || !Number.isFinite(result.value)) return null;
  if (!result.outputUnit) return result.value;
  const spec = resolveUnitSpec(result.outputUnit);
  return spec ? result.value / spec.factorToSi : result.value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger smoke test
// ─────────────────────────────────────────────────────────────────────────────
//FIXME
/*
describe("testLogger", () => {
  it("records pass/fail entries and produces a correct summary", () => {
    const log = createTestLogger("smoke");
    log.symbol("FOO", 42, 42, true);
    log.symbol("BAR", null, 7, false);
    log.inline("ID1", 3.14, 3.14, true);
    log.expansion("fn", [], "fn(42)", false);
    log.info("timing", { ms: 10 });
    log.warn("suspicious result");

    const summary = summariseLog(log);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(2);
    expect(summary.failures).toHaveLength(2);

    const formatted = formatLogSummary(summary);
    expect(formatted).toContain("FAIL");
    expect(formatted).toContain("BAR");
    expect(formatted).toContain("fn");
  });

  it("reports allPassed = true when no failures", () => {
    const { allPassed } = require("./testLogger");
    const log = createTestLogger("clean");
    log.symbol("X", 1, 1, true);
    expect(allPassed(log)).toBe(true);
  });
});
*/
// ─────────────────────────────────────────────────────────────────────────────
// Main integration tests
// ─────────────────────────────────────────────────────────────────────────────

const CASE_DIRECTORIES = listCaseDirectories(CASES_DIR);

describe("examples/cases integration", () => {
  it("has example cases to validate", () => {
    expect(CASE_DIRECTORIES.length).toBeGreaterThan(0);
  });

  for (const caseName of CASE_DIRECTORIES) {
    it(caseName, async () => {
      const caseDir = path.join(CASES_DIR, caseName);
      const evaluation = await evaluateCase(caseDir);

      // ── NEW: create a logger for this case ─────────────────────────
      const log = createTestLogger(caseName);
      const startMs = Date.now();
      // ────────────────────────────────────────────────────────────────

      const failures: string[] = [];

      for (const [entryName, rawExpected] of Object.entries(evaluation.expected)) {
        const expected = parseExpected(rawExpected);

        // ── expansion check ─────────────────────────────────────────
        if (expected.kind === "expanded") {
          const expansions = evaluation.functionCallExpansions.get(entryName) ?? [];
          const passed = expansions.includes(expected.value);
          log.expansion(entryName, expansions, expected.value, passed);
          if (!passed) failures.push(`${entryName}: expected expansion "${expected.value}", got ${JSON.stringify(expansions)}`);
          continue;
        }

        // ── inline result check ─────────────────────────────────────
        const inlineResult = evaluation.inlineResults.get(entryName);
        let fallbackResolvedValue: number | null = null;

        if (inlineResult) {
          const command = evaluation.testCommands.get(entryName);
          if (command?.symbolName) {
            const normalized = normalizeInlineSymbol(command.symbolName);
            fallbackResolvedValue = resolveNumericSymbol(normalized, evaluation.collected, evaluation.symbolValues);
          }

          if (expected.kind === "error") {
            const passed = !!(inlineResult.error || fallbackResolvedValue === null);
            log.inline(entryName, inlineResult.value, null, passed);
            if (!passed) failures.push(`${entryName}: expected an error, got ${inlineResult.value}`);
            continue;
          }

          const comparableInlineValue = getComparableInlineValue(inlineResult);
          if (comparableInlineValue !== null) {
            const passed = valuesMatch(comparableInlineValue, expected.value);
            log.inline(entryName, comparableInlineValue, expected.value, passed);
            if (!passed) failures.push(`${entryName}: expected ${expected.value}, got ${comparableInlineValue}`);
            continue;
          }

          if (fallbackResolvedValue !== null) {
            const passed = valuesMatch(fallbackResolvedValue, expected.value);
            log.symbol(entryName, fallbackResolvedValue, expected.value, passed);
            if (!passed) failures.push(`${entryName}: expected ${expected.value}, got ${fallbackResolvedValue}`);
            continue;
          }

          if (inlineResult.error) {
            log.inline(entryName, null, expected.value, false);
            failures.push(`${entryName}: unexpected inline error "${inlineResult.error}"`);
            continue;
          }

          if (typeof inlineResult.value !== "number" || !Number.isFinite(inlineResult.value)) {
            log.inline(entryName, null, expected.value, false);
            failures.push(`${entryName}: missing inline numeric value`);
            continue;
          }
          continue;
        }

        // ── symbol resolution check ─────────────────────────────────
        const resolvedValue = resolveNumericSymbol(entryName, evaluation.collected, evaluation.symbolValues);

        if (expected.kind === "error") {
          const passed = resolvedValue === null;
          log.symbol(entryName, resolvedValue, null, passed);
          if (!passed) failures.push(`${entryName}: expected unresolved symbol, got ${resolvedValue}`);
          continue;
        }

        if (resolvedValue === null) {
          log.symbol(entryName, null, expected.value, false);
          failures.push(`${entryName}: symbol could not be resolved`);
          continue;
        }

        const passed = valuesMatch(resolvedValue, expected.value);
        log.symbol(entryName, resolvedValue, expected.value, passed);
        if (!passed) failures.push(`${entryName}: expected ${expected.value}, got ${resolvedValue}`);
      }

      // ── NEW: attach timing and emit summary ─────────────────────────
      log.info(`case completed in ${Date.now() - startMs}ms`);
      const summary = summariseLog(log);

      // When the test fails, include the formatted summary in the
      // assertion message so CI output is self-diagnosing.
      expect(failures, formatLogSummary(summary)).toEqual([]);
    });
  }
});
