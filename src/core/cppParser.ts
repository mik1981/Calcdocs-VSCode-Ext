import * as fsp from "fs/promises";
import * as path from "path";

import { updateBraceDepth } from "../utils/braceDepth";
import { DEFINE_RX, SRC_EXTS, TOKEN_RX } from "../utils/regex";
import { stripComments, stripLineContinuations } from "../utils/text";
import { type FunctionMacroDefinition, safeEval } from "./expression";
import {
  SymbolConditionalDefinition,
  SymbolDefinitionLocation,
} from "./state";
import { type ColoredOutput } from "../utils/output";

export type CppSymbolDefinition = {
  name: string;
  expr: string;
  macroParams?: string[];
};

export type CollectedCppSymbols = {
  defines: Map<string, string>;
  defineConditions: Map<string, string>;
  defineComments: Map<string, string>;
  functionDefines: Map<string, FunctionMacroDefinition>;
  defineVariants: Map<string, SymbolConditionalDefinition[]>;
  consts: Map<string, number>;
  units: Map<string, string>;
  locations: Map<string, SymbolDefinitionLocation>;
};

export type CollectOptions = {
  resolveIncludes?: boolean;
  output?: ColoredOutput;
  workspaceRoot?: string;
  maxMegaCacheEntries?: number;
};

type ParsedDefineDirective = {
  name: string;
  expr: string;
  params?: string[];
  comment?: string;
};

type ParsedValueDeclaration = {
  name: string;
  expr: string;
  isConst?: boolean;
  isStatic?: boolean;
  isDefinition?: boolean;
  comment?: string;
};

function extractCppLineComment(text: string): string | undefined {
  let inString: string | null = null;

  for (let i = 0; i < text.length - 1; i += 1) {
    const current = text[i];
    const next = text[i + 1];

    if (inString) {
      if (current === "\\") {
        i += 1;
        continue;
      }
      if (current === inString) {
        inString = null;
      }
      continue;
    }

    if (current === '"' || current === "'" || current === "`") {
      inString = current;
      continue;
    }

    if (current === "/" && next === "/") {
      return text.slice(i + 2).trim();
    }
    if (current === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end !== -1) {
        return text.slice(i + 2, end).trim();
      }
      return text.slice(i + 2).trim();
    }
  }

  return undefined;
}

type ConditionalFrame = {
  parentCondition: string | null;
  branchConditions: string[];
  activeCondition: string;
};

const IFDEF_RX = /^\s*#\s*ifdef\s+([A-Za-z_]\w*)\b/;
const IFNDEF_RX = /^\s*#\s*ifndef\s+([A-Za-z_]\w*)\b/;
const IF_RX = /^\s*#\s*if\b(.+)$/;
const ELIF_RX = /^\s*#\s*elif\b(.+)$/;
const ELSE_RX = /^\s*#\s*else\b/;
const ENDIF_RX = /^\s*#\s*endif\b/;
const UNDEF_RX = /^\s*#\s*undef\s+([A-Za-z_]\w*)\b/;
const CONTROL_FLOW_KEYWORD_RX =
  /^(?:if|else|for|while|switch|case|return|goto|do)\b/;
const UNIT_COMMENT_RX = /@unit=([a-zA-Z0-9^*/_%-]+)/;

/** Regex per catturare #include "file" o <file> */
const INCLUDE_RX = /^\s*#include\s+["<]([^">]+)[">]/i;

type FileStamp = {
  mtimeMs: number;
  size: number;
};

type MegaCacheEntry = {
  content: string;
  dependencies: Map<string, FileStamp>;
  byteSize: number;
  lastAccessed: number;
};

const DEFAULT_MEGA_CACHE_MAX_ENTRIES = 50; // Increased for test files
const MIN_MEGA_CACHE_ENTRIES = 1;
const megaCache = new Map<string, MegaCacheEntry>();

/**
 * Clears internal preprocessing cache used for mega translation units.
 * Useful for explicit "restart" actions from UI commands.
 */
export function clearCppParserCache(): void {
  megaCache.clear();
}

function normalizeCacheKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  // Solo Windows ha filesystem case-insensitive di default
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function getFileStamp(filePath: string, output?: ColoredOutput): Promise<FileStamp | null> {
  try {
    const stat = await fsp.stat(filePath);
    return {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch (err) {
    output?.warn(`[MegaStamp] ❌ Missing dep: ${path.relative(process.cwd(), filePath)}`);
    return null;
  }
}

async function isMegaCacheEntryValid(entry: MegaCacheEntry, output?: ColoredOutput): Promise<boolean> {
  for (const [dependencyPath, previousStamp] of entry.dependencies) {
    const currentStamp = await getFileStamp(dependencyPath, output);
    if (!currentStamp) {
      output?.appendLine(`[MegaValid] ❌ Invalid cache (missing dep): ${path.basename(dependencyPath)}`);
      return false;
    }

    if (
      currentStamp.mtimeMs !== previousStamp.mtimeMs ||
      currentStamp.size !== previousStamp.size
    ) {
      output?.appendLine(`[MegaValid] ❌ Invalid cache (changed): ${path.basename(dependencyPath)}`);
      return false;
    }
  }

  return true;
}

function touchMegaCacheEntry(cacheKey: string, entry: MegaCacheEntry): void {
  entry.lastAccessed = Date.now();
  megaCache.delete(cacheKey);
  megaCache.set(cacheKey, entry);
}

function clampMegaCacheEntries(maxMegaCacheEntries: number | undefined): number {
  if (!Number.isFinite(maxMegaCacheEntries)) {
    return DEFAULT_MEGA_CACHE_MAX_ENTRIES;
  }

  return Math.max(MIN_MEGA_CACHE_ENTRIES, Math.floor(maxMegaCacheEntries!));
}

function evictOldMegaEntries(maxEntries: number, output?: ColoredOutput): void {
  while (megaCache.size > maxEntries) {
    const oldest = megaCache.keys().next();
    if (oldest.done) {
      break;
    }

    const oldestKey = oldest.value;
    const oldestEntry = megaCache.get(oldestKey);
    megaCache.delete(oldestKey);

    if (oldestEntry) {
      output?.detail(
        `[Mega] LRU evict ${path.basename(oldestKey)} (${(oldestEntry.byteSize / 1024).toFixed(1)}kB)`
      );
    }
  }
}


/*
 * Adapted from analysis.ts createMegaSourceFile logic.
 */
async function resolveInclude(
  relIncludePath: string, 
  baseDir: string, 
  workspaceRoot: string,
  output: ColoredOutput | undefined,
  visited: Set<string>,
  dependencyTracker: Set<string>
): Promise<string> {
// FIXED: Prioritize inc/test/inc dirs for external headers
  // output?.appendLine(`[ResolveInclude] 🔍 Searching "${relIncludePath}" (baseDir="${path.relative(workspaceRoot, baseDir)}")`);
  
  const candidateDirs = [
    path.join(baseDir, '..', 'inc'),     // 0. Sibling inc/ (test/src → test/inc)
    path.join(workspaceRoot, 'test', 'inc'), // 1. Explicit test/inc
    path.join(workspaceRoot, 'inc'),     // 2. Workspace inc/
    path.join(workspaceRoot, 'include'), // 3. include/
    path.join(workspaceRoot, 'headers'), // 4. headers/
    baseDir,                             // 5. Source dir
    workspaceRoot,                       // 6. Root
    path.join(workspaceRoot, 'src')      // 7. src/
  ];
  
  let absIncludePath: string | null = null;
  let triedPaths: string[] = [];
  
  for (const dir of candidateDirs) {
    const candidatePath = path.resolve(dir, relIncludePath);
    triedPaths.push(path.relative(workspaceRoot || '.', candidatePath));
    try {
      await fsp.access(candidatePath);
      absIncludePath = candidatePath;
      output?.appendLine(`[ResolveInclude] ✅ Found: ${relIncludePath} → ${path.relative(workspaceRoot || '.', absIncludePath)} (in ${path.basename(path.dirname(absIncludePath))})`);
      break;
    } catch {
      // Continue to next directory
    }
  }
  
  if (!absIncludePath) {
    // output?.appendLine(`[ResolveInclude] ❌ NOT FOUND: ${relIncludePath} (tried ${triedPaths.slice(0,5).join(' → ')}${triedPaths.length>5 ? '...' : ''})`);
    return '';
  }
  
  const key = normalizeCacheKey(absIncludePath);
  // output?.appendLine(`[ResolveInclude] Entry: ${relIncludePath} → ${key} (ext: ${path.extname(relIncludePath)})`);

  if (visited.has(key)) {
    // output?.appendLine(`[ResolveInclude] SKIP recursive include: ${path.basename(relIncludePath)}`);
    return '';
  }

  visited.add(key);
  dependencyTracker.add(absIncludePath);


  let content: string;
  try {
    content = await fsp.readFile(absIncludePath, 'utf8');
    // output?.appendLine(`[ResolveInclude] Read ${relIncludePath}: lines=${content.split('\n').length}`);
  } catch (err) {
    // output?.appendLine(`[ResolveInclude] Failed read ${relIncludePath}: ${err}`);
    return '';
  }
  
  const lines = content.split(/\r?\n/);
  let processedContent = `/* === INCL ${path.relative(workspaceRoot, absIncludePath)} === */\n`;
  
  for (const line of lines) {
  const includeMatch = line.match(INCLUDE_RX);
    if (includeMatch) {
      // output?.appendLine(`[ResolveInclude] Found include match: ${includeMatch[1]}`);
      const nested = await resolveInclude(

        includeMatch[1], 
        path.dirname(absIncludePath), 
        workspaceRoot,
        output,
        visited,
        dependencyTracker
      );
      processedContent += nested || line + '\n';
    } else {
      processedContent += line + '\n';
    }
  }
  
  return processedContent;
}

/**
 * Builds mega-content for main source file.
 */
async function buildMegaContent(
  sourcePath: string,
  workspaceRoot: string,
  output: ColoredOutput | undefined,
  maxMegaCacheEntries: number
): Promise<string> {
  // Force clear cache for test files to avoid stale data
  if (sourcePath.includes('test')) {
    const testKey = normalizeCacheKey(sourcePath);
    if (megaCache.has(testKey)) {
      output?.appendLine(`[Mega] 🔄 Force clear test cache: ${path.basename(sourcePath)}`);
      megaCache.delete(testKey);
    }
  }
  
  const cacheKey = normalizeCacheKey(sourcePath);
  const cached = megaCache.get(cacheKey);
  if (cached) {
    const isValid = await isMegaCacheEntryValid(cached);
    if (isValid) {
      touchMegaCacheEntry(cacheKey, cached);
      output?.appendLine(
        `[Mega] CACHE HIT: ${path.basename(sourcePath)} (${(cached.byteSize / 1024).toFixed(1)}kB)`
      );
      return cached.content;
    }

    megaCache.delete(cacheKey);
    output?.appendLine(`[Mega] CACHE STALE: ${path.basename(sourcePath)} → rebuilding`);
  }
  output?.appendLine(`[Mega] CACHE MISS: ${path.basename(sourcePath)} → building fresh`);


  const visited = new Set<string>();
  const dependencyTracker = new Set<string>([path.resolve(sourcePath)]);
  const mainDir = path.dirname(sourcePath);
  
  let megaContent = `/* === MEGA from ${path.relative(workspaceRoot, sourcePath)} === */\n`;
  let mainContent: string;
  try {
    mainContent = await fsp.readFile(sourcePath, 'utf8');
  } catch (err) {
    output?.appendLine(`[Mega] Failed read main ${sourcePath}: ${err}`);
    return megaContent;
  }
  
  const mainLines = mainContent.split(/\r?\n/);
  
  for (const line of mainLines) {
    const includeMatch = line.match(INCLUDE_RX);
    if (includeMatch) {
      const included = await resolveInclude(
        includeMatch[1], 
        mainDir, 
        workspaceRoot,
        output,
        visited,
        dependencyTracker
      );
      if (included) {
      output?.appendLine(`[Mega] included ${includeMatch[1]} in ${mainDir}`);
      }
      megaContent += included || line + '\n';
    } else {
      megaContent += line + '\n';
    }
  }

  const lines = megaContent.split(/\r?\n/);
  const byteSize = Buffer.byteLength(megaContent);
  const sizeKB = (byteSize / 1024).toFixed(1);
  const dependencies = new Map<string, FileStamp>();
  for (const dependencyPath of dependencyTracker) {
    const stamp = await getFileStamp(dependencyPath);
    if (stamp) {
      dependencies.set(dependencyPath, stamp);
    }
  }

  const cacheEntry: MegaCacheEntry = {
    content: megaContent,
    dependencies,
    byteSize,
    lastAccessed: Date.now(),
  };
  megaCache.set(cacheKey, cacheEntry);
  evictOldMegaEntries(maxMegaCacheEntries, output);

  output?.appendLine(`[Mega] Built ${path.basename(sourcePath)}: lines=${lines.length}, size=${sizeKB}kB`);
  return megaContent;
}


function findNextMeaningfulLine(
  lines: string[],
  startIndex: number
): string | null {
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const candidate = stripComments(lines[i]).trim();
    if (!candidate) {
      continue;
    }

    return candidate;
  }

  return null;
}

function isTopLevelIncludeGuard(
  lines: string[],
  lineIndex: number,
  guardSymbol: string,
  conditionalStackDepth: number
): boolean {
  if (conditionalStackDepth !== 0) {
    return false;
  }

  const nextMeaningfulLine = findNextMeaningfulLine(lines, lineIndex);
  if (!nextMeaningfulLine) {
    return false;
  }

  const defineMatch = nextMeaningfulLine.match(
    /^\s*#\s*define\s+([A-Za-z_]\w*)\b/
  );

  return Boolean(defineMatch && defineMatch[1] === guardSymbol);
}

function normalizeDirectiveCondition(raw: string): string {
  const cleaned = stripComments(raw).trim();
  return cleaned.length > 0 ? cleaned : "1";
}

function parseDefineNameDirective(line: string): string | undefined {
  const match = stripComments(line).match(/^\s*#\s*define\s+([A-Za-z_]\w*)\b/);
  return match?.[1];
}

function resolveCondition(
  rawCondition: string,
  defines: Map<string, string>,
  consts: Map<string, number>,
  definedSymbols: Set<string>,
  output?: ColoredOutput,
): string {
  const cleaned = stripComments(rawCondition).trim();
  if (!cleaned) {
    return "1";
  }

  rawCondition = rawCondition.replace(
    /defined\s*\(\s*(\w+)\s*\)/g,
    (_, name) => defines.has(name) ? "1" : "0"
  );

  let resolved = cleaned;
  // output?.appendLine(`resolveCondition input: "${rawCondition}" -> "${cleaned}"`); // TEMP DEBUG
  
  resolved = resolved.replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/gi, (_, symbol) => {
    return definedSymbols.has(symbol) || consts.has(symbol) ? "1" : "0";
  });
  
  resolved = resolved.replace(/!\s*defined\s*\(\s*([A-Za-z_]\w*)\s*\)/gi, (_, symbol) => {
    return definedSymbols.has(symbol) || consts.has(symbol) ? "0" : "1";
  });

  const tokenSet = new Set(resolved.match(TOKEN_RX) ?? []);
  const tokens = Array.from(tokenSet);

  for (const token of tokens) {
    if (token === "defined" || token === "sizeof" || token === "nullptr") {
      continue;
    }
    
    if (token === "not" || token === "and" || token === "or" ||
        token === "bitand" || token === "bitor" || token === "xor" ||
        token === "compl") {
      continue;
    }

    if (consts.has(token)) {
      const value = consts.get(token)!;
      resolved = resolved.replace(new RegExp(`\\b${token}\\b`, 'g'), String(value));
      continue;
    }

    if (definedSymbols.has(token) && !defines.has(token)) {
      resolved = resolved.replace(new RegExp(`\\b${token}\\b`, "g"), "1");
      continue;
    }

    if (defines.has(token)) {
      const expr = defines.get(token)!;

      try {
        const value = safeEval(expr);
        resolved = resolved.replace(new RegExp(`\\b${token}\\b`, 'g'), String(value));
      } catch {
        resolved = resolved.replace(new RegExp(`\\b${token}\\b`, 'g'), "1");
      }
      continue;
    }

    // In C preprocessor #if expressions, unknown identifiers are treated as 0.
    resolved = resolved.replace(new RegExp(`\\b${token}\\b`, "g"), "0");
  }

  try {
    const value = safeEval(resolved);
    output?.appendLine(`[resolveCondition] cleaned=${cleaned} resolved=${resolved} value=${value}`);
    return value !== 0 ? "1" : "0";
  } catch {
    output?.warn(`[resolveCondition] ⚠️ FAILED final eval (fallback 0): "${resolved}"`);
    return "0";
  }
}

function combineConditions(parent: string | null, branch: string): string {
  const normalizedBranch = branch.trim() || "1";

  if (!parent || parent === "1") {
    return normalizedBranch;
  }

  if (normalizedBranch === "1") {
    return parent;
  }

  return `(${parent}) && (${normalizedBranch})`;
}

function negateCondition(condition: string): string {
  const trimmed = condition.trim();
  if (!trimmed) {
    return "1";
  }

  if (trimmed === "1") {
    return "0";
  }

  const definedMatch = trimmed.match(/^defined\(\s*([A-Za-z_]\w*)\s*\)$/);
  if (definedMatch) {
    return `!defined(${definedMatch[1]})`;
  }

  const notDefinedMatch = trimmed.match(/^!defined\(\s*([A-Za-z_]\w*)\s*\)$/);
  if (notDefinedMatch) {
    return `defined(${notDefinedMatch[1]})`;
  }

  if (trimmed.startsWith("!(") && trimmed.endsWith(")")) {
    const inner = trimmed.slice(2, -1).trim();
    if (inner.length > 0) {
      return inner;
    }
  }

  return `!(${trimmed})`;
}

function buildElseCondition(branchConditions: string[]): string {
  if (branchConditions.length === 0) {
    return "1";
  }

  return branchConditions.map((condition) => negateCondition(condition)).join(" && ");
}

function normalizeVariantCondition(condition: string): string {
  const trimmed = condition.trim();
  if (!trimmed || trimmed === "1" || trimmed.toLowerCase() === "always") {
    return "always";
  }

  try {
    const value = safeEval(trimmed);
    if (Number.isFinite(value)) {
      return value !== 0 ? "always" : "0";
    }
  } catch {
    // keep raw symbolic condition when not directly evaluable
  }

  return trimmed.replace(/\s+/g, " ");
}

function normalizeVariantExpression(expr: string): string {
  return expr.trim().replace(/\s+/g, " ");
}

function buildVariantDedupKey(variant: SymbolConditionalDefinition): string {
  const normalizedCondition = normalizeVariantCondition(variant.condition);
  const normalizedExpression = normalizeVariantExpression(variant.expr);
  return `${normalizedCondition}::${normalizedExpression}`;
}

function dedupeDefineVariants(
  defineVariants: Map<string, SymbolConditionalDefinition[]>
): Map<string, SymbolConditionalDefinition[]> {
  const deduped = new Map<string, SymbolConditionalDefinition[]>();

  for (const [name, variants] of defineVariants) {
    const seenKeys = new Set<string>();
    const uniqueVariants: SymbolConditionalDefinition[] = [];

    for (const variant of variants) {
      const dedupKey = buildVariantDedupKey(variant);
      if (seenKeys.has(dedupKey)) {
        continue;
      }

      seenKeys.add(dedupKey);
      uniqueVariants.push({ ...variant });
    }

    if (uniqueVariants.length > 0) {
      deduped.set(name, uniqueVariants);
    }
  }

  return deduped;
}

function parseDefineDirective(line: string): ParsedDefineDirective | undefined {
  const directiveMatch = line.match(DEFINE_RX);
  if (!directiveMatch) {
    return undefined;
  }

  const name = directiveMatch[1];
  const rawTail = directiveMatch[2] ?? "";

  // Function-like macro: no space between name and '('
  // Object-like macro: expression may start with '(' but has leading whitespace
  if (rawTail.startsWith("(") && !rawTail.startsWith(" ")) {
    let depth = 0;
    let closeIndex = -1;

    for (let i = 0; i < rawTail.length; i += 1) {
      const char = rawTail[i];
      if (char === "(") {
        depth += 1;
        continue;
      }

      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          closeIndex = i;
          break;
        }
      }
    }

    if (closeIndex < 0) {
      return undefined;
    }

    const rawParams = rawTail.slice(1, closeIndex).trim();
    const params =
      rawParams.length === 0
        ? []
        : rawParams
            .split(",")
            .map((param) => param.trim())
            .filter((param) => param.length > 0);

    const comment = extractCppLineComment(rawTail.slice(closeIndex + 1));
    const expr = stripComments(rawTail.slice(closeIndex + 1)).trim();
    if (!expr) {
      return undefined;
    }

    return {
      name,
      expr,
      params,
      comment,
    };
  }

  const comment = extractCppLineComment(rawTail);
  const expr = stripComments(rawTail).trim();
  if (!expr) {
    return undefined;
  }

  return {
    name,
    expr,
    comment,
  };
}

function findAssignmentOperatorIndex(line: string): number {
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char !== "=") {
      continue;
    }

    const prev = i > 0 ? line[i - 1] : "";
    const next = i + 1 < line.length ? line[i + 1] : "";

    if (
      prev === "=" ||
      prev === "!" ||
      prev === "<" ||
      prev === ">" ||
      prev === "+" ||
      prev === "-" ||
      prev === "*" ||
      prev === "/" ||
      prev === "%" ||
      prev === "&" ||
      prev === "|" ||
      prev === "^" ||
      next === "="
    ) {
      continue;
    }

    return i;
  }

  return -1;
}

function parseValueDeclaration(
  line: string
): ParsedValueDeclaration | undefined {
  const cleaned = stripComments(line).trim();

  if (!cleaned || cleaned.startsWith("#")) {
    return undefined;
  }

  const semicolonIndex = cleaned.lastIndexOf(";");

  if (semicolonIndex < 0) {
    return undefined;
  }

  const comment = extractCppLineComment(line);
  const declaration = cleaned.slice(0, semicolonIndex).trim();

  if (!declaration) {
    return undefined;
  }

  const assignmentIndex = findAssignmentOperatorIndex(declaration);

  if (assignmentIndex <= 0) {
    return undefined;
  }

  const leftSide = declaration.slice(0, assignmentIndex).trim();
  const expr = declaration.slice(assignmentIndex + 1).trim();

  if (!leftSide || !expr || expr.startsWith("{")) {
    return undefined;
  }

  // Reject function calls / arrays / scopes
  if (
    leftSide.includes("(") ||
    leftSide.includes(")") ||
    leftSide.includes("[") ||
    leftSide.includes("]") ||
    leftSide.includes("{") ||
    leftSide.includes("}") ||
    leftSide.includes(".") ||
    leftSide.includes("->")
  ) {
    return undefined;
  }

  const leftTokens = leftSide
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (leftTokens.length < 2) {
    return undefined;
  }

  if (CONTROL_FLOW_KEYWORD_RX.test(leftTokens[0])) {
    return undefined;
  }

  // ------------------------------------------------------------------
  // Validate this is REALLY a declaration and not an assignment.
  //
  // VALID:
  //
  //   int value = 0;
  //   const uint32_t test = 1;
  //   MyType obj = ...
  //
  // INVALID:
  //
  //   value = 0;
  //   result = 10;
  // ------------------------------------------------------------------

  const TYPE_LIKE_TOKENS = new Set([
    "const",
    "constexpr",
    "volatile",
    "static",
    "extern",
    "register",
    "signed",
    "unsigned",
    "short",
    "long",
    "char",
    "int",
    "float",
    "double",
    "bool",
    "void",
    "auto",
    "size_t",
    "uint8_t",
    "uint16_t",
    "uint32_t",
    "uint64_t",
    "int8_t",
    "int16_t",
    "int32_t",
    "int64_t",
  ]);

  // Need at least:
  //   <type> <name>
  //
  // so plain:
  //   value = 1;
  // is rejected immediately.
  if (leftTokens.length < 2) {
    return undefined;
  }

  const variableToken = leftTokens[leftTokens.length - 1]
    .replace(/^[*&]+/, "");

  const typeTokens = leftTokens
    .slice(0, -1)
    .map((token) => token.replace(/[*&]+/g, ""));

  if (!/^[A-Za-z_]\w*$/.test(variableToken)) {
    return undefined;
  }

  const hasValidType = typeTokens.some((token) => {
    if (TYPE_LIKE_TOKENS.has(token)) {
      return true;
    }

    // Accept custom typedefs / structs:
    //
    // MyType value = ...
    // CONFIG_DATA cfg = ...
    //
    return /^[A-Z][A-Za-z0-9_]*$/.test(token);
  });

  if (!hasValidType) {
    return undefined;
  }

  let name = leftTokens[leftTokens.length - 1].replace(/^[*&]+/, "");

  if (!name && leftTokens.length >= 2) {
    const fallbackToken = leftTokens[leftTokens.length - 2];
    name = fallbackToken.replace(/^[*&]+/, "");
  }

  if (!/^[A-Za-z_]\w*$/.test(name)) {
    return undefined;
  }

  // Reject multiple declarations:
  //
  // int a = 1, b = 2;
  //
  if (/,\s*[A-Za-z_]\w*\s*=/.test(expr)) {
    return undefined;
  }

  const isConst =
    leftTokens.includes("const") ||
    leftTokens.includes("constexpr");

  const isStatic = leftTokens.includes("static");

  // ONLY true constants are treated as "symbol definitions"
  // for duplicate-definition / variant tracking.
  const isDefinition = isConst;

  return {
    name,
    expr,
    isConst,
    isStatic,
    isDefinition,
    comment,
  };
}

/**
 * Parses one C/C++ line and extracts either:
 * - "#define NAME EXPR"
 * - "#define NAME(P1,...) EXPR"
 * - scalar declaration with assignment ("TYPE NAME = EXPR;")
 * Returns undefined for non-matching lines.
 */
export function parseCppSymbolDefinition(
  line: string
): CppSymbolDefinition | undefined {
  const parsedDefine = parseDefineDirective(line);
  if (parsedDefine) {
    return {
      name: parsedDefine.name,
      expr: parsedDefine.expr,
      macroParams: parsedDefine.params,
    };
  }

  const parsedValueDeclaration = parseValueDeclaration(line);
  if (parsedValueDeclaration) {
    return {
      name: parsedValueDeclaration.name,
      expr: parsedValueDeclaration.expr,
    };
  }

  return undefined;
}

/**
 * Extracts enum member name/value pairs from comment-stripped C source text.
 * Handles explicit assignments and auto-increment (e.g. SCREEN_OFF = 0, SCREEN_ON).
 */
function extractEnumMembers(
  strippedText: string
): Array<{ name: string; value: number; line: number }> {
  const results: Array<{ name: string; value: number; line: number }> = [];
  const enumOpenRx = /\benum\b[^{;]*\{/g;
  let startMatch: RegExpExecArray | null;

  while ((startMatch = enumOpenRx.exec(strippedText)) !== null) {
    const openPos = strippedText.indexOf('{', startMatch.index);
    if (openPos === -1) continue;

    // Walk to the matching closing brace
    let depth = 1;
    let pos = openPos + 1;
    while (pos < strippedText.length && depth > 0) {
      const ch = strippedText[pos];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      pos++;
    }

    const blockText = strippedText.slice(openPos + 1, pos - 1);
    const baseLineNum = (strippedText.slice(0, openPos + 1).match(/\n/g) ?? []).length;

    let autoValue = 0;
    const blockLines = blockText.split('\n');

    for (let li = 0; li < blockLines.length; li++) {
      // A line can have multiple comma-separated members (unusual but valid)
      for (const part of blockLines[li].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // IDENTIFIER  [= expression]
        const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*(.+))?$/);
        if (!m) continue;

        const name = m[1];
        if (/^(sizeof|typeof|__typeof__|__attribute__|typedef|struct|union|enum|const|volatile|static|extern|inline|if|else|while|for|do|return)$/.test(name)) {
          continue;
        }

        if (m[2] !== undefined) {
          try {
            const val = safeEval(m[2].trim());
            if (Number.isFinite(val)) autoValue = Math.trunc(val);
          } catch {
            // Keep current autoValue when expression can't be evaluated
          }
        }

        results.push({ name, value: autoValue, line: baseLineNum + li });
        autoValue++;
      }
    }
  }

  return results;
}

/**
 * Scans source files and collects:
 * - raw object-like #define expressions
 * - function-like #define macros
 * - scalar declaration expressions (const/variables with one-line assignment)
 * - direct numeric values for declarations that can be evaluated immediately
 * - source locations for navigation
 * 
 * Uses two-pass approach:
 * 1. First pass: collect all defines and consts from all files
 * 2. Second pass: process conditional blocks using resolved conditions
 */
export async function collectDefinesAndConsts(
  files: string[],
  workspaceRoot: string,
  options: CollectOptions = {}
): Promise<CollectedCppSymbols> {

  const { resolveIncludes = false, output, maxMegaCacheEntries } = options;
  const effectiveCacheLimit = clampMegaCacheEntries(maxMegaCacheEntries);

  output?.appendLine(
    `[CPP] entry files=${files.length}, resolveIncludes=${resolveIncludes ? "YES" : "NO"}, cacheLimit=${effectiveCacheLimit}`
  );

  
  const defines = new Map<string, string>();
  const defineConditions = new Map<string, string>();
  const defineComments = new Map<string, string>();
  const functionDefines = new Map<string, FunctionMacroDefinition>();
  const defineVariants = new Map<string, SymbolConditionalDefinition[]>();
  const consts = new Map<string, number>();
  const units = new Map<string, string>();
  const locations = new Map<string, SymbolDefinitionLocation>();
  const globallyDefinedSymbols = new Set<string>();

  const SOURCES_ONLY_EXTS = new Set([".c", ".cpp", ".cc"]);
  const effectiveFiles = resolveIncludes 
    ? files.filter(f => SOURCES_ONLY_EXTS.has(path.extname(f).toLowerCase()))
    : files;
  output?.appendLine(`[CPP] effectiveFiles (${effectiveFiles.length}): ${effectiveFiles.map(p => path.basename(p)).join(', ')}`);

  // ========== FIRST PASS: Collect unconditional defines/consts ==========
  for (const filePath of effectiveFiles) {
    const seenDefinesInFile = new Set<string>(); // Track defines per file

    let text: string;

    if (resolveIncludes) {
      text = await buildMegaContent(
        filePath,
        workspaceRoot,
        output,
        effectiveCacheLimit
      );
    } else {
      try {
        text = await fsp.readFile(filePath, "utf8");
      } catch {
        continue;
      }
    }

    text = stripLineContinuations(text);

    const lines = text.split(/\r?\n/);

    let braceDepth = 0;
    let conditionalDepth = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineWithoutComments = stripComments(line);
      const directive = lineWithoutComments.trim();

      // IMPORTANT:
      // Update brace depth BEFORE parsing.
      //
      // This prevents local variables / runtime assignments
      // inside functions from being treated as global definitions.
      braceDepth = updateBraceDepth(braceDepth, lineWithoutComments);

      // ---- track preprocessor conditionals ----
      if (/^\s*#\s*(if|ifdef|ifndef)\b/.test(directive)) {
        conditionalDepth++;
        continue;
      }

      if (/^\s*#\s*endif\b/.test(directive)) {
        conditionalDepth = Math.max(0, conditionalDepth - 1);
        continue;
      }

      if (/^\s*#\s*(else|elif)\b/.test(directive)) {
        continue;
      }

      // ---- ignore anything inside conditional blocks ----
      if (conditionalDepth > 0) {
        continue;
      }

      // ---- handle #undef ----
      const undefFirstPass = directive.match(UNDEF_RX);

      if (undefFirstPass) {
        const undefinedName = undefFirstPass[1];

        defines.delete(undefinedName);
        consts.delete(undefinedName);
        locations.delete(undefinedName);
        globallyDefinedSymbols.delete(undefinedName);
        // Also remove from seenDefinesInFile so a subsequent
        // #define of the same name in the same file is not skipped.
        seenDefinesInFile.delete(undefinedName);

        continue;
      }

      // ---- parse defines ----
      const defineName = parseDefineNameDirective(line);

      if (defineName) {
        globallyDefinedSymbols.add(defineName);
      }

      const parsedDefine = parseDefineDirective(line);

      if (parsedDefine && !seenDefinesInFile.has(parsedDefine.name)) {
        seenDefinesInFile.add(parsedDefine.name);

        const { name, expr, params } = parsedDefine;

        if (params) {
          if (!functionDefines.has(name)) {
            functionDefines.set(name, {
              params,
              body: expr,
            });
          }
        } else {
          // Allow overwrite in case later file redefines
          defines.set(name, expr);
            if (parsedDefine.comment) {
              defineComments.set(name, parsedDefine.comment);
            }

          defineConditions.set(name, "always");

          const location: SymbolDefinitionLocation = {
            file: path.relative(workspaceRoot, filePath),
            line: i + 1
          };

          locations.set(name, location);
        }

        continue;
      }

      // ------------------------------------------------------------------
      // ONLY collect GLOBAL constant definitions.
      //
      // Ignore:
      //   - local variables
      //   - runtime assignments
      //   - anything inside functions/scopes
      // ------------------------------------------------------------------

      if (braceDepth === 0) {
        const parsedValueDeclaration = parseValueDeclaration(line);

        if (
          parsedValueDeclaration &&
          parsedValueDeclaration.isDefinition &&
          !seenDefinesInFile.has(parsedValueDeclaration.name)
        ) {
          seenDefinesInFile.add(parsedValueDeclaration.name);

          const { name, expr, isStatic } = parsedValueDeclaration;

          // Ignore ALL static variables, including static const
          if (!isStatic) {
            defines.set(name, expr);
            if (parsedValueDeclaration.comment) {
              defineComments.set(name, parsedValueDeclaration.comment);
            }

            const unitMatch = line.match(UNIT_COMMENT_RX);
            if (unitMatch) {
              units.set(name, unitMatch[1]);
            }

            try {
              consts.set(name, safeEval(expr));
            } catch {}

            const location: SymbolDefinitionLocation = {
              file: path.relative(workspaceRoot, filePath),
              line: i + 1
            };

            locations.set(name, location);
          }
        }
      }

    }

    // Enum members are extracted once per file. Keeping this outside the
    // line loop avoids re-parsing the whole file for every line at startup.
    const strippedForEnums = stripComments(text);
    for (const member of extractEnumMembers(strippedForEnums)) {
      if (seenDefinesInFile.has(member.name)) {
        continue;
      }

      seenDefinesInFile.add(member.name);

      if (!defines.has(member.name)) {
        defines.set(member.name, String(member.value));
      }

      if (!consts.has(member.name)) {
        consts.set(member.name, member.value);
      }

      defineConditions.set(member.name, "always");

      if (!locations.has(member.name)) {
        locations.set(member.name, {
          file: path.relative(workspaceRoot, filePath),
          line: member.line + 1,
        });
      }
    }
  }

  // ========== SECOND PASS: Conditional-aware processing ==========
  for (const filePath of effectiveFiles) {
    const seenDefinesInFile = new Set<string>();

    let text: string;    
    if (resolveIncludes) {
      text = await buildMegaContent(
        filePath,
        workspaceRoot,
        output,
        effectiveCacheLimit
      );
    } else {
      try {
        text = await fsp.readFile(filePath, "utf8");
      } catch {
        continue;
      }
    }

    text = stripLineContinuations(text);
    const lines = text.split(/\r?\n/);
    const conditionalStack: ConditionalFrame[] = [];
    let currentCondition: string | null = null;
    let braceDepth = 0;
    const seenVariants = new Set<string>();
    const activeDefinedSymbols = new Set<string>(globallyDefinedSymbols);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineWithoutComments = stripComments(line);
      const directiveLine = lineWithoutComments.trim();
      let isDirectiveLine = false;

      // Conditional directives...
      const ifdefMatch = directiveLine.match(IFDEF_RX);
      if (ifdefMatch) {
        const branchCondition = resolveCondition(
          `defined(${ifdefMatch[1]})`,
          defines,
          consts,
          activeDefinedSymbols,
          output
        );
        const activeCondition = combineConditions(currentCondition, branchCondition);

        conditionalStack.push({
          parentCondition: currentCondition,
          branchConditions: [branchCondition],
          activeCondition,
        });

        currentCondition = activeCondition;
        isDirectiveLine = true;
      } else {
        const ifndefMatch = directiveLine.match(IFNDEF_RX);

        if (ifndefMatch) {
          const branchCondition = isTopLevelIncludeGuard(
            lines,
            i,
            ifndefMatch[1],
            conditionalStack.length
          )
            ? "1"
            : resolveCondition(
                `!defined(${ifndefMatch[1]})`,
                defines,
                consts,
                activeDefinedSymbols,
                output
              );
          const activeCondition = combineConditions(currentCondition, branchCondition);

          conditionalStack.push({
            parentCondition: currentCondition,
            branchConditions: [branchCondition],
            activeCondition,
          });

          currentCondition = activeCondition;
          isDirectiveLine = true;
        } else {
          const ifMatch = directiveLine.match(IF_RX);

          if (ifMatch) {
            const rawCondition = ifMatch[1];
            const branchCondition = resolveCondition(
              rawCondition,
              defines,
              consts,
              activeDefinedSymbols,
              output
            );
            const activeCondition = combineConditions(currentCondition, branchCondition);

            conditionalStack.push({
              parentCondition: currentCondition,
              branchConditions: [branchCondition],
              activeCondition,
            });

            currentCondition = activeCondition;
            isDirectiveLine = true;
          }
        }
      }

      if (!isDirectiveLine) {
        const elifMatch = directiveLine.match(ELIF_RX);
        if (elifMatch) {
          const frame = conditionalStack[conditionalStack.length - 1];

          if (frame) {
            const previousBranchesCondition = buildElseCondition(frame.branchConditions);
            const branchTestCondition = resolveCondition(
              normalizeDirectiveCondition(elifMatch[1]),
              defines,
              consts,
              activeDefinedSymbols,
              output
            );
            const branchCondition = combineConditions(
              previousBranchesCondition,
              branchTestCondition
            );
            const activeCondition = combineConditions(
              frame.parentCondition,
              branchCondition
            );

            frame.branchConditions.push(branchCondition);
            frame.activeCondition = activeCondition;
            currentCondition = activeCondition;
          }

          isDirectiveLine = true;
        } else if (ELSE_RX.test(directiveLine)) {
          const frame = conditionalStack[conditionalStack.length - 1];

          if (frame) {
            const branchCondition = buildElseCondition(frame.branchConditions);
            const activeCondition = combineConditions(
              frame.parentCondition,
              branchCondition
            );

            frame.branchConditions.push(branchCondition);
            frame.activeCondition = activeCondition;
            currentCondition = activeCondition;
          }

          isDirectiveLine = true;
        } else if (ENDIF_RX.test(directiveLine)) {
          const frame = conditionalStack.pop();
          currentCondition = frame?.parentCondition ?? null;
          isDirectiveLine = true;
        } else {
          const undefMatch = directiveLine.match(UNDEF_RX);

          if (undefMatch) {
            let isActiveDirective = true;

            if (currentCondition) {
              try {
                isActiveDirective = safeEval(currentCondition) !== 0;
              } catch {
                isActiveDirective = true;
              }
            }

            if (isActiveDirective) {
              const undefName = undefMatch[1];
              activeDefinedSymbols.delete(undefName);
              defines.delete(undefName);
              consts.delete(undefName);
              defineConditions.delete(undefName);
              locations.delete(undefName);
              // Remove from seenDefinesInFile so a subsequent #define
              // in the same file can be processed (e.g. #undef + #define
              // inside an active conditional branch).
              seenDefinesInFile.delete(undefName);
              defineVariants.delete(undefName);
            }


            isDirectiveLine = true;
          }
        }
      }

      // ------------------------------------------------------------------
      // Parse active content
      // ------------------------------------------------------------------

      if (!isDirectiveLine) {
        let isActiveBranch = true;

        if (currentCondition) {
          // output?.appendLine(`[CPP2] Eval condition "${currentCondition}"`);
          try {
            const evalResult = safeEval(currentCondition);
            // output?.appendLine(`[CPP2] condition eval = ${evalResult} (active=${evalResult !== 0})`);
            isActiveBranch = evalResult !== 0;
          } catch (e) {
            // output?.error(`[CPP2] condition eval FAILED: ${e}`);
            isActiveBranch = true;
          }
        }

        const definitionCondition = isActiveBranch
          ? (currentCondition && currentCondition !== "1" ? currentCondition : "always")
          : "0";

        if (!isActiveBranch) {
          continue;
        }

        const activeDefineName = parseDefineNameDirective(line);
        if (activeDefineName) {
          activeDefinedSymbols.add(activeDefineName);
        }

        const parsedDefine = parseDefineDirective(line);

        if (parsedDefine && !seenDefinesInFile.has(parsedDefine.name)) {
          seenDefinesInFile.add(parsedDefine.name);
          const { name, expr, params } = parsedDefine;
          // output?.appendLine(`[CPP2] Parsed define ${name}=${expr} cond=${definitionCondition} active=${isActiveBranch}`);

          if (params) {
            if (!functionDefines.has(name)) {
              functionDefines.set(name, {
                params,
                body: expr,
              });
            }
          } else {
            if (!defines.has(name)) {
              defines.set(name, expr);
            }

            const unitMatch = line.match(UNIT_COMMENT_RX);
            if (unitMatch) {
              units.set(name, unitMatch[1]);
            }

            defineConditions.set(name, definitionCondition);

            const location: SymbolDefinitionLocation = {
              file: path.relative(workspaceRoot ?? '.', filePath),
              line: i + 1 // 1-based
            };

            const variantKey = `${name}:${location.file}:${location.line}`;

            if (!seenVariants.has(variantKey)) {
              seenVariants.add(variantKey);

              const variants = defineVariants.get(name) ?? [];
              variants.push({
                ...location,
                expr,
                condition: definitionCondition
              });
              defineVariants.set(name, variants);
            }

            if (!locations.has(name)) {
              locations.set(name, location);
            }
          }
        }

        // ------------------------------------------------------------------
        // ONLY collect GLOBAL constant definitions.
        // Ignore local/runtime variables.
        // ------------------------------------------------------------------

        else if (braceDepth === 0 && currentCondition === null) {
          const parsedValueDeclaration = parseValueDeclaration(line);

          if (
            parsedValueDeclaration &&
            parsedValueDeclaration.isDefinition &&
            !seenDefinesInFile.has(parsedValueDeclaration.name)
          ) {
            seenDefinesInFile.add(parsedValueDeclaration.name);

            const { name, expr, isStatic } = parsedValueDeclaration;

            // Ignore ALL static variables, including static const
            if (!isStatic) {
              if (!defines.has(name)) {
                defines.set(name, expr);
                if (parsedValueDeclaration.comment) {
                  defineComments.set(name, parsedValueDeclaration.comment);
                }
              }

              const unitMatch = line.match(UNIT_COMMENT_RX);

              if (unitMatch) {
                units.set(name, unitMatch[1]);
              }

              defineConditions.set(name, definitionCondition);

              try {
                consts.set(name, safeEval(expr));
              } catch {}

              const location: SymbolDefinitionLocation = {
                file: path.relative(workspaceRoot, filePath),
                line: i + 1
              };

              const variantKey = `${location.file}:${location.line}`;

              if (!seenVariants.has(variantKey)) {
                seenVariants.add(variantKey);

                const variants = defineVariants.get(name) ?? [];

                variants.push({
                  ...location,
                  expr,
                  condition: definitionCondition
                });

                defineVariants.set(name, variants);
              }

              if (!locations.has(name)) {
                locations.set(name, location);
              }
            }
          }
        }
      }

      braceDepth = updateBraceDepth(braceDepth, lineWithoutComments);
    }
  }

  const dedupedDefineVariants = dedupeDefineVariants(defineVariants);

  augmentRegisterFamilyAliases(defines, defineConditions);

  return {
    defines,
    defineConditions,
    defineComments,
    functionDefines,
    defineVariants: dedupedDefineVariants,
    consts,
    units,
    locations
  };
}

function stripTrailingDigits(name: string): string {
  return name.replace(/\d+$/, "");
}

function augmentRegisterFamilyAliases(
  defines: Map<string, string>,
  defineConditions: Map<string, string>
): void {
  const aliasCandidates = new Map<string, Set<string>>();
  const identifierRegex = /[A-Za-z_]\w*/g;

  for (const [name, expr] of Array.from(defines.entries())) {
    const instanceMatch = name.match(/^([A-Za-z_][\w]*\d+)__(.+)$/);
    if (!instanceMatch) {
      continue;
    }

    const instanceName = instanceMatch[1];
    const registerName = instanceMatch[2];
    const familyName = stripTrailingDigits(instanceName);
    if (!familyName || familyName === instanceName) {
      continue;
    }

    const genericPrefix = `${familyName}_${registerName}_`;
    const specificPrefix = `${instanceName}_${registerName}_`;

    for (const token of expr.match(identifierRegex) ?? []) {
      if (!token.startsWith(genericPrefix)) {
        continue;
      }

      const genericName = token;
      if (defines.has(genericName)) {
        continue;
      }

      const specificName = `${specificPrefix}${genericName.slice(genericPrefix.length)}`;
      if (!defines.has(specificName)) {
        continue;
      }

      const candidates = aliasCandidates.get(genericName) ?? new Set<string>();
      candidates.add(specificName);
      aliasCandidates.set(genericName, candidates);
    }
  }

  for (const [genericName, candidates] of aliasCandidates.entries()) {
    if (defines.has(genericName) || candidates.size !== 1) {
      continue;
    }

    const [specificName] = Array.from(candidates);
    defines.set(genericName, specificName);
    defineConditions.set(genericName, "always");
  }
}
