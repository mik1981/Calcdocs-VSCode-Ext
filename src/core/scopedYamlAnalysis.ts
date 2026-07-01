import * as fsp from "fs/promises";
import * as path from "path";

import {
  applyCppSymbols,
  fillMissingYamlValuesFromCppSymbols,
  getYamlNodeEntries,
  loadYamlOrReportError,
  rebuildFormulaIndexWithEngine,
  seedSymbolValuesFromYaml,
} from "./analysis";
import { getConfig, isIgnoredFsPath, refreshIgnoredDirs } from "./config";
import { collectDefinesAndConsts } from "./cppParser";
import { loadAdjacentCsvTables } from "./csvTables";
import { createSymbolResolutionStats } from "./expression";
import { listFilesRecursive } from "./files";
import { parseFormulaYamlText, type ParsedFormulaYamlEntry } from "./formulaYaml";
import { CalcDocsState, type YamlSymbolLocationEntry } from "./state";
import { extractUnitsFromCppFiles } from "../engine/cUnitExtractor";
import { RESERVED_EXPRESSION_NAMES } from "../engine/mathScope";
import { evaluateYamlDocument } from "../engine/yamlEngine";
import { buildFormulaSymbolTable } from "../formulaOutline/formulaEvaluator";

/**
 * scopedYamlAnalysis
 * -------------------
 * Replaces the "always parse every C/C++ file in the workspace" behavior of
 * core/analysis.ts's runYamlAnalysis() with a scoped equivalent:
 *
 *   1. Seed everything resolvable from the YAML file itself — zero file-system
 *      access beyond the YAML file.
 *   2. Extract identifiers referenced by formula expressions that are NOT
 *      covered by step 1 (real free/external symbols the formulas depend on).
 *   3. If nothing is missing: evaluate and stop. No C/C++ file is read at all.
 *   4. For anything missing, consult state.yamlSymbolLocations first — a
 *      persistent, per-symbol "who defines this" cache:
 *        - never seen before -> workspace search (locateDefiningFiles), ONCE.
 *        - seen before, remembered file + its includes unchanged (mtime) ->
 *          reuse the cached value, zero file reads beyond stat().
 *        - seen before, something in that closure changed -> re-parse ONLY
 *          that closure (no workspace search) and refresh the cache entry.
 *        - re-parse no longer finds the symbol there (moved/deleted) -> that
 *          one symbol falls back to a fresh workspace search.
 *
 * So a full workspace search happens at most once per symbol, ever, for a
 * given formulas.yaml — not on every activation/edit of the file.
 *
 * State effects are identical to the legacy runYamlAnalysis(): this function
 * reuses the same private helpers (now exported for this purpose) so
 * formulaOutlineProvider / hover / inspection tooling see no difference in
 * CalcDocsState shape, only in how it got populated.
 *
 * Deliberately NOT replicated here: reportFormulaDiscrepancies() (the
 * workspace-wide "does the YAML value match what's in the C files everywhere"
 * cross-check). That feature is inherently workspace-wide by definition, so it
 * stays on the manual/background path (calcdocs.recompute) rather than running
 * on every keystroke.
 */

const SOURCE_EXTS = new Set([".c", ".cc", ".cpp", ".h", ".hpp"]);
const IDENTIFIER_RX = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
const DEFINED_NAME_RX =
  /^\s*#\s*define\s+([A-Za-z_]\w*)|^\s*(?:static\s+)?(?:const\s+)?(?:volatile\s+)?[A-Za-z_][\w:<>\s*]*?\b([A-Za-z_]\w*)\s*=\s*[^;]+;|^\s*enum\b[^{]*\{([^}]*)\}/gm;

interface DefinedNamesCacheEntry {
  mtimeMs: number;
  names: Set<string>;
}

/** Per-file cache of "cheaply detected" identifier names, keyed by absolute path. */
const definedNamesCache = new Map<string, DefinedNamesCacheEntry>();

export async function runScopedYamlAnalysis(
  state: CalcDocsState,
  yamlPath: string
): Promise<void> {
  const loadedYaml = await loadYamlOrReportError(state, yamlPath);
  if (!loadedYaml) {
    state.yamlDiagnostics = [];
    state.missingYamlSuggestions = [];
    return;
  }

  state.lastYamlPath = yamlPath;
  state.lastYamlRaw = loadedYaml.rawText;

  const yamlNodes = getYamlNodeEntries(loadedYaml.parsed);
  seedSymbolValuesFromYaml(state, yamlNodes);

  const formulas = parseFormulaYamlText(loadedYaml.rawText, yamlPath);
  const missing = findMissingExternalIdentifiers(formulas, state.symbolValues);

  const csvRefs = extractReferencedCsvPaths(formulas);
  if (csvRefs.size > 0) {
    const loadedCsvTables = await loadReferencedCsvTables(yamlPath, csvRefs);
    for (const [key, value] of loadedCsvTables) {
      state.csvTables.set(key, value);
    }
  }

  const externalUnits = new Map<string, string>();
  let usedWorkspaceSearch = false;

  if (missing.size > 0) {
    const outcome = await resolveMissingExternalSymbols(state, yamlPath, missing);
    usedWorkspaceSearch = outcome.usedWorkspaceSearch;
    for (const [name, value] of outcome.values) {
      if (!state.symbolValues.has(name)) {
        state.symbolValues.set(name, value);
      }
    }
    for (const [name, unit] of outcome.units) {
      externalUnits.set(name, unit);
    }
  }

  const yamlEngineResult = evaluateYamlDocument(loadedYaml.parsed, {
    rawText: loadedYaml.rawText,
    yamlPath,
    externalValues: new Map(state.symbolValues),
    externalUnits,
    csvTables: state.csvTables,
  });

  state.yamlDiagnostics = yamlEngineResult.diagnostics;
  state.missingYamlSuggestions = yamlEngineResult.missingSuggestions;

  rebuildFormulaIndexWithEngine(
    state,
    yamlNodes,
    loadedYaml.rawText,
    yamlPath,
    yamlEngineResult.symbols
  );
  fillMissingYamlValuesFromCppSymbols(state);

  state.output.info(
    `[YAML lazy] ${formulas.length} formulas, ${missing.size} external symbol(s) needed` +
      (missing.size > 0
        ? `, workspace search: ${usedWorkspaceSearch ? "yes" : "no (cache hit)"}.`
        : ".")
  );
}

/**
 * Resolves external symbols using the persistent per-symbol cache described
 * above. Returns the resolved values/units and whether a workspace-wide
 * search was actually needed this call (for logging/telemetry only).
 */
async function resolveMissingExternalSymbols(
  state: CalcDocsState,
  yamlPath: string,
  missing: Set<string>
): Promise<{
  values: Map<string, number>;
  units: Map<string, string>;
  usedWorkspaceSearch: boolean;
}> {
  const values = new Map<string, number>();
  const units = new Map<string, string>();
  const needsResolution = new Set<string>();
  let usedWorkspaceSearch = false;

  // Phase 1: try the persistent cache for each symbol.
  for (const symbol of missing) {
    const cacheKey = yamlSymbolCacheKey(yamlPath, symbol);
    const cached = state.yamlSymbolLocations.get(cacheKey);
    if (!cached) {
      needsResolution.add(symbol);
      continue;
    }

    if (await isClosureUnchanged(cached.includeClosureMtimes)) {
      values.set(symbol, cached.value);
      if (cached.unit) units.set(symbol, cached.unit);
      continue;
    }

    // Something in the remembered closure changed - re-parse just that
    // closure (no workspace search yet).
    const refreshed = await reparseClosureForSymbol(state, symbol, cached);
    if (refreshed) {
      state.yamlSymbolLocations.set(cacheKey, refreshed);
      values.set(symbol, refreshed.value);
      if (refreshed.unit) units.set(symbol, refreshed.unit);
    } else {
      // Symbol moved away or was removed from that file - only now do we
      // fall back to a fresh workspace search for this specific symbol.
      needsResolution.add(symbol);
    }
  }

  // Phase 2: workspace search, only for symbols that were never cached or
  // whose remembered location stopped panning out.
  if (needsResolution.size > 0) {
    usedWorkspaceSearch = true;
    const bySymbol = await locateDefiningFiles(needsResolution, state.workspaceRoot, state);

    if (bySymbol.size > 0) {
      const config = getConfig();
      const foundFiles = Array.from(new Set(bySymbol.values()));

      // NOTE: collectDefinesAndConsts's resolveIncludes:true mode silently
      // filters its input down to .c/.cpp/.cc roots (headers are normally
      // only reached by being #included from one of those). Our found files
      // may themselves BE headers, so we expand the set ourselves - bounded,
      // local, quoted #includes only - and parse with resolveIncludes:false
      // so every candidate (.c or .h) is actually read.
      const expandedFiles = await expandWithLocalIncludes(foundFiles, state.workspaceRoot, 5);

      const stats = createSymbolResolutionStats();
      const cppSymbols = await collectDefinesAndConsts(expandedFiles, state.workspaceRoot, {
        resolveIncludes: false,
        output: state.output,
        maxMegaCacheEntries: config.cppCacheMaxEntries,
      });

      applyCppSymbols(state, cppSymbols, {
        resetSymbolValues: false,
        applyConstsBeforeResolve: true,
        requireFiniteResolvedValues: false,
        symbolResolutionStats: stats,
      });

      const unitResult = await extractUnitsFromCppFiles(expandedFiles, state.workspaceRoot);

      for (const [symbol, definingFile] of bySymbol) {
        const value = state.symbolValues.get(symbol);
        if (value === undefined || !Number.isFinite(value)) {
          continue;
        }
        const unit = unitResult.units.get(symbol);
        const closure = await expandWithLocalIncludes([definingFile], state.workspaceRoot, 5);
        const includeClosureMtimes = await statAll(closure);

        const entry: YamlSymbolLocationEntry = {
          symbol,
          definingFile,
          includeClosureMtimes,
          value,
          unit,
        };
        state.yamlSymbolLocations.set(yamlSymbolCacheKey(yamlPath, symbol), entry);
        values.set(symbol, value);
        if (unit) units.set(symbol, unit);
      }
    }
  }

  return { values, units, usedWorkspaceSearch };
}

function yamlSymbolCacheKey(yamlPath: string, symbol: string): string {
  return `${yamlPath}::${symbol}`;
}

async function statAll(files: string[]): Promise<Map<string, number>> {
  const mtimes = new Map<string, number>();
  for (const file of files) {
    try {
      const stat = await fsp.stat(file);
      mtimes.set(file, stat.mtimeMs);
    } catch {
      // Missing file - simply not recorded, which will make
      // isClosureUnchanged() correctly report "changed" if this file
      // reappears or was expected.
    }
  }
  return mtimes;
}

async function isClosureUnchanged(rememberedMtimes: Map<string, number>): Promise<boolean> {
  for (const [file, rememberedMtime] of rememberedMtimes) {
    try {
      const stat = await fsp.stat(file);
      if (stat.mtimeMs !== rememberedMtime) {
        return false;
      }
    } catch {
      return false; // file deleted/moved
    }
  }
  return true;
}

/**
 * Re-parses just the remembered file (+ its own local includes) to see if
 * the symbol is still defined there after a change. Returns null if it's no
 * longer found, signaling the caller to fall back to a fresh workspace
 * search for this one symbol.
 */
async function reparseClosureForSymbol(
  state: CalcDocsState,
  symbol: string,
  cached: YamlSymbolLocationEntry
): Promise<YamlSymbolLocationEntry | null> {
  const config = getConfig();
  const closureFiles = await expandWithLocalIncludes(
    [cached.definingFile],
    state.workspaceRoot,
    5
  );

  const stats = createSymbolResolutionStats();
  const cppSymbols = await collectDefinesAndConsts(closureFiles, state.workspaceRoot, {
    resolveIncludes: false,
    output: state.output,
    maxMegaCacheEntries: config.cppCacheMaxEntries,
  });

  applyCppSymbols(state, cppSymbols, {
    resetSymbolValues: false,
    applyConstsBeforeResolve: true,
    requireFiniteResolvedValues: false,
    symbolResolutionStats: stats,
  });

  const value = state.symbolValues.get(symbol);
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }

  const unitResult = await extractUnitsFromCppFiles(closureFiles, state.workspaceRoot);
  const includeClosureMtimes = await statAll(closureFiles);

  return {
    symbol,
    definingFile: cached.definingFile,
    includeClosureMtimes,
    value,
    unit: unitResult.units.get(symbol),
  };
}

/**
 * Identifiers referenced by formula expressions that are not:
 *  - another formula's id in this document
 *  - already seeded into symbolValues (from `value:` fields)
 *  - a known math/lookup function name (sin, sqrt, csv, lookup, table, ...)
 *  - a numeric-looking token (guards against the identifier regex over-matching)
 */
export function findMissingExternalIdentifiers(
  formulas: ParsedFormulaYamlEntry[],
  seededValues: Map<string, number>
): Set<string> {
  const table = buildFormulaSymbolTable(formulas);
  const formulaIds = new Set(formulas.map((f) => f.id));
  const missing = new Set<string>();

  for (const formula of formulas) {
    if (!formula.expr) {
      continue;
    }
    if (table.has(formula.id)) {
      continue;
    }

    const tokens = formula.expr.match(IDENTIFIER_RX) ?? [];
    for (const token of tokens) {
      if (formulaIds.has(token)) continue;
      if (seededValues.has(token)) continue;
      if (table.has(token)) continue;
      if (RESERVED_EXPRESSION_NAMES.has(token.toLowerCase())) continue;
      if (/^\d/.test(token)) continue;
      missing.add(token);
    }
  }

  return missing;
}

const CSV_CALL_RX = /\b(?:csv|lookup|table)\s*\(\s*["']([^"']+)["']/gi;

/**
 * Table-reference strings passed as the first argument to csv()/lookup()/
 * table() calls in formula expressions, e.g. csv("data/ntc_10k.csv", ...).
 */
function extractReferencedCsvPaths(formulas: ParsedFormulaYamlEntry[]): Set<string> {
  const refs = new Set<string>();
  for (const formula of formulas) {
    if (!formula.expr) {
      continue;
    }
    CSV_CALL_RX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CSV_CALL_RX.exec(formula.expr)) !== null) {
      refs.add(match[1]);
    }
  }
  return refs;
}

/**
 * Loads only the CSV table(s) actually referenced by this yaml's formulas,
 * scoped to the directory (or directories) they live in - not a
 * workspace-wide CSV scan. Reuses loadAdjacentCsvTables() unchanged (same
 * key-registration behavior resolveCsvTable() already expects), just pointed
 * at the referenced file's own directory instead of always the yaml's.
 */
async function loadReferencedCsvTables(
  yamlPath: string,
  refs: Set<string>
): Promise<Map<string, import("./csvTables").CsvTable>> {
  const merged = new Map<string, import("./csvTables").CsvTable>();
  const yamlDir = path.dirname(yamlPath);
  const dirsToScan = new Set<string>();

  for (const ref of refs) {
    const resolved = path.isAbsolute(ref) ? ref : path.resolve(yamlDir, ref);
    dirsToScan.add(path.dirname(resolved));
  }

  for (const dir of dirsToScan) {
    // loadAdjacentCsvTables only uses path.dirname(yamlPath) to pick the
    // directory to list - passing a synthetic path inside the target
    // directory scopes it there without needing a new helper.
    const tables = await loadAdjacentCsvTables(path.join(dir, "__scoped_csv_probe__.yaml"));
    for (const [key, value] of tables) {
      merged.set(key, value);
    }
  }

  return merged;
}

const LOCAL_INCLUDE_RX = /^\s*#\s*include\s*"([^"]+)"/;

/**
 * Expands a set of files with their locally-#included ("...") headers,
 * bounded depth, cycle-safe. Deliberately ignores <system> includes - those
 * are never where a project-local #define/const lives.
 */
async function expandWithLocalIncludes(
  files: string[],
  workspaceRoot: string,
  maxDepth: number
): Promise<string[]> {
  const visited = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = files.map((file) => ({
    file,
    depth: 0,
  }));

  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);

    if (depth >= maxDepth) {
      continue;
    }

    let content: string;
    try {
      content = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }

    const fileDir = path.dirname(file);
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(LOCAL_INCLUDE_RX);
      if (!match) {
        continue;
      }
      const includedPath = path.resolve(fileDir, match[1]);
      if (!visited.has(includedPath)) {
        queue.push({ file: includedPath, depth: depth + 1 });
      }
    }
  }

  return Array.from(visited);
}

/**
 * Cheap, cached, early-exiting search for the file(s) that define a specific
 * set of missing identifier names. This intentionally does NOT run the real
 * C parser (collectDefinesAndConsts) on every file — only a lightweight regex
 * pass to decide *which* file(s) are worth handing to the real parser.
 *
 * Returns a symbol -> defining file map so callers can build a precise,
 * per-symbol cache entry (not just "the symbol is somewhere in this set").
 */
export async function locateDefiningFiles(
  missing: Set<string>,
  workspaceRoot: string,
  state: CalcDocsState
): Promise<Map<string, string>> {
  const config = getConfig();
  refreshIgnoredDirs(state, config);

  const allFiles = await listFilesRecursive(
    workspaceRoot,
    (absoluteDirPath) => isIgnoredFsPath(state, absoluteDirPath),
    state
  );

  const sourceFiles = allFiles
    .filter((file) => SOURCE_EXTS.has(path.extname(file).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));

  const remaining = new Set(missing);
  const found = new Map<string, string>();

  for (const file of sourceFiles) {
    if (remaining.size === 0) {
      break;
    }

    const names = await getDefinedNamesCached(file);
    for (const name of remaining) {
      if (names.has(name)) {
        found.set(name, file);
      }
    }
    for (const name of found.keys()) {
      remaining.delete(name);
    }
  }

  return found;
}

async function getDefinedNamesCached(filePath: string): Promise<Set<string>> {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return new Set();
  }

  const cached = definedNamesCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.names;
  }

  let content = "";
  try {
    content = await fsp.readFile(filePath, "utf8");
  } catch {
    return new Set();
  }

  const names = new Set<string>();
  let match: RegExpExecArray | null;
  DEFINED_NAME_RX.lastIndex = 0;
  while ((match = DEFINED_NAME_RX.exec(content)) !== null) {
    if (match[1]) {
      names.add(match[1]);
    } else if (match[2]) {
      names.add(match[2]);
    } else if (match[3]) {
      for (const token of match[3].match(IDENTIFIER_RX) ?? []) {
        names.add(token);
      }
    }
  }

  definedNamesCache.set(filePath, { mtimeMs: stat.mtimeMs, names });
  return names;
}
