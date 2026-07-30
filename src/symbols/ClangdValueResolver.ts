import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

import type { ClangdService } from "../clangd/ClangdService";
import type { CollectedCppSymbols } from "../core/cppParser";
import { safeEval } from "../core/expression";
import type { SymbolDefinitionLocation } from "../core/state";
import { stripComments } from "../utils/text";

type ClangdValueCandidateKind = "macro" | "enum";

type ClangdValueCandidate = {
  name: string;
  kind: ClangdValueCandidateKind;
  uri: vscode.Uri;
  position: vscode.Position;
  location: SymbolDefinitionLocation;
};

export type ClangdResolvedValueSymbol = {
  name: string;
  kind: ClangdValueCandidateKind;
  value?: number;
  expression?: string;
  location: SymbolDefinitionLocation;
};

export type ClangdResolvedValueSet = {
  symbols: Map<string, ClangdResolvedValueSymbol>;
  queriedCandidates: number;
  skippedConflicts: string[];
  /**
   * True when the file/time budget ran out before every reachable file or
   * candidate could be inspected. Not an error: on very large codebases with
   * huge #include graphs this is the expected, safe outcome.
   */
  truncated: boolean;
};

export type ClangdValueResolverOptions = {
  headerIndex?: Map<string, string[]>;
  maxIncludeDepth?: number;
  maxCandidates?: number;
  /** Hard cap on distinct files visited while following #include chains. */
  maxFiles?: number;
  /** Wall-clock budget (ms) for the whole augmentation pass. */
  timeBudgetMs?: number;
  /** Per textDocument/hover request timeout (ms). */
  hoverTimeoutMs?: number;
};

const SOURCE_EXTS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"]);
const INCLUDE_RX = /^\s*#\s*include\s+["<]([^">]+)[">]/;
const DEFINE_RX = /^\s*#\s*define\s+([A-Za-z_]\w*)(.*)$/;
const IDENTIFIER_RX = /^[A-Za-z_]\w*/;
const DEFAULT_MAX_INCLUDE_DEPTH = 8;
const DEFAULT_MAX_CANDIDATES = 400;
// Same order of magnitude as maxCandidates: even a header-heavy project
// (e.g. a "db.h" pulling in hundreds of transitive includes) should not
// force us to touch more files than we could plausibly query anyway.
const DEFAULT_MAX_FILES = 150;
// Keep the whole pass short: this runs on every analysis, so on a huge or
// already-overloaded clangd instance we must bail out quickly rather than
// stall the editor. Mirrors the deadline pattern used by computeMegaBudget.
const DEFAULT_TIME_BUDGET_MS = 2000;
const DEFAULT_HOVER_TIMEOUT_MS = 300;

function createEmptyResolvedValueSet(): ClangdResolvedValueSet {
  return {
    symbols: new Map(),
    queriedCandidates: 0,
    skippedConflicts: [],
    truncated: false,
  };
}

function isUsableClangdValueSource(clangdService: ClangdService | undefined): boolean {
  if (!clangdService?.isAvailable()) {
    return false;
  }

  const status = clangdService.getStatus();
  // Skip augmentation while clangd is (heuristically) busy indexing: piling
  // more hover requests onto it right when it's already struggling is what
  // tends to destabilize the editor on very large projects. The next
  // analysis pass will simply retry once things settle down.
  return status.available && status.hasCompileCommands && !status.indexing;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);

    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      }
    );
  });
}

function normalizePathForKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTS.has(path.extname(filePath).toLowerCase());
}

function resolveIncludeFromIndex(
  includePath: string,
  headerIndex: Map<string, string[]> | undefined
): string | undefined {
  const candidates = headerIndex?.get(path.basename(includePath).toLowerCase());
  if (!candidates || candidates.length === 0) {
    return undefined;
  }

  return [...candidates].sort((left, right) => left.localeCompare(right))[0];
}

async function resolveIncludePath(
  includePath: string,
  includingFile: string,
  workspaceRoot: string,
  headerIndex: Map<string, string[]> | undefined
): Promise<string | undefined> {
  const baseDir = path.dirname(includingFile);
  const candidates = [
    path.resolve(baseDir, includePath),
    path.resolve(baseDir, "..", "inc", includePath),
    path.resolve(workspaceRoot, "inc", includePath),
    path.resolve(workspaceRoot, "include", includePath),
    path.resolve(workspaceRoot, "headers", includePath),
    path.resolve(workspaceRoot, "src", includePath),
    path.resolve(workspaceRoot, includePath),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return resolveIncludeFromIndex(includePath, headerIndex);
}

async function expandFilesWithIncludes(
  files: readonly string[],
  workspaceRoot: string,
  options: ClangdValueResolverOptions,
  deadline: number
): Promise<{ files: string[]; truncated: boolean }> {
  const maxDepth = options.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const visited = new Set<string>();
  const output: string[] = [];
  const queue: Array<{ file: string; depth: number }> = files
    .filter(isSourceFile)
    .map((file) => ({ file: path.resolve(file), depth: 0 }));

  let truncated = false;

  while (queue.length > 0) {
    // Depth alone doesn't bound the amount of work: a header with a very
    // wide #include graph (e.g. "db.h" pulling in hundreds of headers) can
    // still enumerate huge numbers of files well within maxDepth. Guard on
    // total file count and elapsed time as well.
    if (output.length >= maxFiles || Date.now() > deadline) {
      truncated = true;
      break;
    }

    const current = queue.shift();
    if (!current) {
      continue;
    }

    const normalized = normalizePathForKey(current.file);
    if (visited.has(normalized)) {
      continue;
    }

    visited.add(normalized);
    output.push(current.file);

    if (current.depth >= maxDepth) {
      continue;
    }

    let text: string;
    try {
      text = await fsp.readFile(current.file, "utf8");
    } catch {
      continue;
    }

    for (const line of text.split(/\r?\n/)) {
      const includeMatch = line.match(INCLUDE_RX);
      if (!includeMatch) {
        continue;
      }

      const resolved = await resolveIncludePath(
        includeMatch[1],
        current.file,
        workspaceRoot,
        options.headerIndex
      );
      if (!resolved || !isSourceFile(resolved)) {
        continue;
      }

      queue.push({ file: resolved, depth: current.depth + 1 });
    }
  }

  return { files: output, truncated };
}

function positionAtOffset(text: string, offset: number): vscode.Position {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;

  for (let i = 0; i < safeOffset; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }

  return new vscode.Position(line, safeOffset - lineStart);
}

function locationForOffset(
  text: string,
  offset: number,
  filePath: string,
  workspaceRoot: string
): SymbolDefinitionLocation {
  const position = positionAtOffset(text, offset);
  return {
    file: path.relative(workspaceRoot, filePath),
    line: position.line + 1,
  };
}

function isFunctionLikeMacroTail(rawTail: string): boolean {
  return rawTail.startsWith("(");
}

function collectMacroCandidates(
  text: string,
  filePath: string,
  workspaceRoot: string,
  uri: vscode.Uri
): ClangdValueCandidate[] {
  const candidates: ClangdValueCandidate[] = [];
  let offset = 0;

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(DEFINE_RX);
    if (match) {
      const name = match[1];
      const rawTail = match[2] ?? "";
      const expr = stripComments(rawTail).trim();
      if (expr && !isFunctionLikeMacroTail(rawTail)) {
        const nameOffset = offset + line.indexOf(name);
        candidates.push({
          name,
          kind: "macro",
          uri,
          position: positionAtOffset(text, nameOffset),
          location: locationForOffset(text, nameOffset, filePath, workspaceRoot),
        });
      }
    }

    offset += line.length + 1;
  }

  return candidates;
}

function eraseCommentsKeepingOffsets(text: string): string {
  let output = text.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " ")
  );
  output = output.replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
  return output;
}

function splitEnumEntries(
  text: string
): Array<{ source: string; offset: number }> {
  const entries: Array<{ source: string; offset: number }> = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      entries.push({ source: text.slice(start, i), offset: start });
      start = i + 1;
    }
  }

  const tail = text.slice(start);
  if (tail.trim()) {
    entries.push({ source: tail, offset: start });
  }

  return entries;
}

function findWordInRange(
  text: string,
  word: string,
  fromOffset: number,
  toOffset: number
): number {
  let index = text.indexOf(word, fromOffset);
  while (index >= 0 && index < toOffset) {
    const before = index > 0 ? text[index - 1] : "";
    const after = index + word.length < text.length ? text[index + word.length] : "";
    if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) {
      return index;
    }

    index = text.indexOf(word, index + word.length);
  }

  return -1;
}

function collectEnumCandidates(
  text: string,
  filePath: string,
  workspaceRoot: string,
  uri: vscode.Uri
): ClangdValueCandidate[] {
  const candidates: ClangdValueCandidate[] = [];
  const cleaned = eraseCommentsKeepingOffsets(text);
  const enumOpenRx = /\benum\b(?:\s+(?:class|struct))?\s*(?:[A-Za-z_]\w*)?\s*(?::\s*[\w\s:]+?)?\{/g;
  let match: RegExpExecArray | null;

  while ((match = enumOpenRx.exec(cleaned)) !== null) {
    const bodyStart = match.index + match[0].length;
    let depth = 1;
    let cursor = bodyStart;

    while (cursor < cleaned.length && depth > 0) {
      const char = cleaned[cursor];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
      cursor += 1;
    }

    if (depth !== 0) {
      continue;
    }

    const bodyEnd = cursor - 1;
    const body = cleaned.slice(bodyStart, bodyEnd);

    for (const entry of splitEnumEntries(body)) {
      const trimmed = entry.source.trimStart();
      const name = trimmed.match(IDENTIFIER_RX)?.[0];
      if (!name) {
        continue;
      }

      const entryStart = bodyStart + entry.offset;
      const nameOffset = findWordInRange(text, name, entryStart, bodyEnd);
      if (nameOffset < 0) {
        continue;
      }

      candidates.push({
        name,
        kind: "enum",
        uri,
        position: positionAtOffset(text, nameOffset),
        location: locationForOffset(text, nameOffset, filePath, workspaceRoot),
      });
    }
  }

  return candidates;
}

function hoverToText(hover: vscode.Hover | null): string {
  if (!hover) {
    return "";
  }

  return hover.contents
    .map((content) => {
      if (typeof content === "string") {
        return content;
      }

      if (content instanceof vscode.MarkdownString) {
        return content.value;
      }

      if (content && typeof content === "object" && "value" in content) {
        const value = (content as { value?: unknown }).value;
        return typeof value === "string" ? value : "";
      }

      return "";
    })
    .join("\n")
    .trim();
}

function hoverLines(text: string): string[] {
  return text
    .replace(/```[a-zA-Z0-9_+-]*\n?/g, "")
    .replace(/```/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeExpressionFromHover(expression: string): string {
  return stripComments(expression)
    .replace(/[;,]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tryEvaluateHoverExpression(expression: string): number | undefined {
  const normalized = normalizeExpressionFromHover(expression);
  if (!normalized) {
    return undefined;
  }

  try {
    const value = safeEval(normalized);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseMacroHover(
  hoverText: string,
  name: string
): Pick<ClangdResolvedValueSymbol, "value" | "expression"> | undefined {
  for (const line of hoverLines(hoverText)) {
    const defineMatch = line.match(
      new RegExp(`^#\\s*define\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b(.*)$`)
    );
    if (!defineMatch) {
      continue;
    }

    const expression = normalizeExpressionFromHover(defineMatch[1] ?? "");
    if (!expression) {
      continue;
    }

    return {
      expression,
      value: tryEvaluateHoverExpression(expression),
    };
  }

  return undefined;
}

function parseEnumHover(
  hoverText: string,
  name: string
): Pick<ClangdResolvedValueSymbol, "value" | "expression"> | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (const line of hoverLines(hoverText)) {
    const namedAssignment = line.match(
      new RegExp(`\\b${escapedName}\\b\\s*=\\s*([^,;)]+)`)
    );
    // clangd's real hover output typically renders this as "Value = N",
    // but also tolerate a "value: N" spelling for robustness.
    const valueAssignment = line.match(/^value\s*[:=]\s*(.+)$/i);
    const expression = normalizeExpressionFromHover(
      namedAssignment?.[1] ?? valueAssignment?.[1] ?? ""
    );
    if (!expression) {
      continue;
    }

    const value = tryEvaluateHoverExpression(expression);
    if (value === undefined) {
      continue;
    }

    return {
      expression: String(value),
      value,
    };
  }

  return undefined;
}

function parseClangdHoverForCandidate(
  hoverText: string,
  candidate: ClangdValueCandidate
): ClangdResolvedValueSymbol | undefined {
  const parsed =
    candidate.kind === "macro"
      ? parseMacroHover(hoverText, candidate.name)
      : parseEnumHover(hoverText, candidate.name);

  if (!parsed || (parsed.value === undefined && parsed.expression === undefined)) {
    return undefined;
  }

  return {
    name: candidate.name,
    kind: candidate.kind,
    value: parsed.value,
    expression: parsed.expression,
    location: candidate.location,
  };
}

function sameResolvedSymbol(
  left: ClangdResolvedValueSymbol,
  right: ClangdResolvedValueSymbol
): boolean {
  return (
    left.kind === right.kind &&
    left.value === right.value &&
    (left.expression ?? "") === (right.expression ?? "")
  );
}

async function collectCandidatesForFile(
  filePath: string,
  workspaceRoot: string
): Promise<ClangdValueCandidate[]> {
  let text: string;
  try {
    text = await fsp.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const uri = vscode.Uri.file(filePath);
  return [
    ...collectMacroCandidates(text, filePath, workspaceRoot, uri),
    ...collectEnumCandidates(text, filePath, workspaceRoot, uri),
  ];
}

export async function resolveClangdValuesForFiles(
  files: readonly string[],
  workspaceRoot: string,
  clangdService: ClangdService | undefined,
  options: ClangdValueResolverOptions = {}
): Promise<ClangdResolvedValueSet> {
  if (!isUsableClangdValueSource(clangdService)) {
    return createEmptyResolvedValueSet();
  }

  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const hoverTimeoutMs = options.hoverTimeoutMs ?? DEFAULT_HOVER_TIMEOUT_MS;
  const deadline = Date.now() + timeBudgetMs;

  const result = createEmptyResolvedValueSet();
  const conflicts = new Set<string>();
  const { files: filesToScan, truncated: includesTruncated } = await expandFilesWithIncludes(
    files,
    workspaceRoot,
    options,
    deadline
  );
  result.truncated = includesTruncated;

  for (const filePath of filesToScan) {
    if (result.queriedCandidates >= maxCandidates || Date.now() > deadline) {
      result.truncated = true;
      break;
    }

    const candidates = await collectCandidatesForFile(filePath, workspaceRoot);
    for (const candidate of candidates) {
      if (result.queriedCandidates >= maxCandidates || Date.now() > deadline) {
        result.truncated = true;
        break;
      }
      if (conflicts.has(candidate.name)) {
        continue;
      }

      const hover = await withTimeout(
        clangdService!.getHover(candidate.uri, candidate.position).catch(() => null),
        hoverTimeoutMs,
        null
      );

      result.queriedCandidates += 1;
      const resolved = parseClangdHoverForCandidate(hoverToText(hover), candidate);
      if (!resolved) {
        continue;
      }

      const previous = result.symbols.get(candidate.name);
      if (previous && !sameResolvedSymbol(previous, resolved)) {
        result.symbols.delete(candidate.name);
        conflicts.add(candidate.name);
        result.skippedConflicts.push(candidate.name);
        continue;
      }

      result.symbols.set(candidate.name, resolved);
    }
  }

  return result;
}

function cloneMap<K, V>(input: Map<K, V>): Map<K, V> {
  return new Map(input);
}

export function mergeClangdResolvedSymbols(
  cppSymbols: CollectedCppSymbols,
  clangdSymbols: ClangdResolvedValueSet
): CollectedCppSymbols {
  if (clangdSymbols.symbols.size === 0) {
    return cppSymbols;
  }

  const merged: CollectedCppSymbols = {
    defines: cloneMap(cppSymbols.defines),
    defineConditions: cloneMap(cppSymbols.defineConditions),
    defineComments: cloneMap(cppSymbols.defineComments),
    functionDefines: cloneMap(cppSymbols.functionDefines),
    defineVariants: cloneMap(cppSymbols.defineVariants),
    consts: cloneMap(cppSymbols.consts),
    units: cloneMap(cppSymbols.units),
    locations: cloneMap(cppSymbols.locations),
  };

  for (const symbol of clangdSymbols.symbols.values()) {
    const expression =
      symbol.expression ??
      (typeof symbol.value === "number" && Number.isFinite(symbol.value)
        ? String(symbol.value)
        : undefined);

    if (expression) {
      merged.defines.set(symbol.name, expression);
      merged.defineConditions.set(symbol.name, "always");
      merged.defineVariants.set(symbol.name, [
        {
          ...symbol.location,
          expr: expression,
          condition: "always",
        },
      ]);
    }

    if (typeof symbol.value === "number" && Number.isFinite(symbol.value)) {
      merged.consts.set(symbol.name, symbol.value);
    }

    merged.locations.set(symbol.name, symbol.location);
  }

  return merged;
}
