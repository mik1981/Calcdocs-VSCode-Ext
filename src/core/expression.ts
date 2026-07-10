import { OP_RX, NUM_LITERAL_RX, TOKEN_RX } from "../utils/regex";
import { stripComments } from "../utils/text";
import { evaluateExpression } from "../engine/evaluator";
import { ENGINEERING_MATH_SCOPE } from "../engine/mathScope";
import {
  createQuantity,
  createQuantityFromData,
  normalizeUnit,
  toDisplayUnit,
  toDisplayValue,
} from "../engine/units";
import type { CsvTable, CsvTableMap } from "./csvTables";
import { normalizeCsvTableKey } from "./csvTables";

export type EvaluationContext = {
  csvTables?: CsvTableMap;
};

export type FunctionMacroDefinition = {
  params: string[];
  body: string;
};

export type CastOverflowInfo = {
  castType: string;
  inputValue: number;
  truncatedValue: number;
  min: number;
  max: number;
};

export type CompositeExpressionPreviewError = {
  kind: "cast-overflow" | "other";
  message: string;
  overflow?: CastOverflowInfo;
};

export type NumericDisplayFormat = 'decimal' | 'hex' | 'binary' | 'boolean';

const HEX_LITERAL_DETECT_RX = /\b0[xX][0-9a-fA-F]/;
const BINARY_LITERAL_DETECT_RX = /\b0[bB][01]/;

// ⚠️ Deve rilevare SOLO operatori bitwise reali (&, |, ^, ~, <<, >>), NON
// gli operatori logici && e || — che contengono comunque i caratteri '&'/'|'
// e con una classe di caratteri semplice [&|^~] venivano rilevati come falsi
// positivi "bitwise". Questo causava, tra l'altro, il blocco del constant-folding
// (simplifyNumericFragments) e il numericFormat errato (hex invece di boolean)
// per QUALSIASI espressione contenente && o ||, es. una condizione if con un
// AND logico che include una chiamata a funzione-macro pienamente risolvibile
// (es. "cond1 && (x >= fT_to_Timer(10.0))" restava non semplificata).
const BITWISE_OP_DETECT_RX = /(?<!&)&(?!&)|(?<!\|)\|(?!\|)|\^|~|<<|>>/;
const LOGICAL_OP_DETECT_RX = /&&|\|\||!(?!=)/;
const RELATIONAL_OP_DETECT_RX = /==|!=|<=|>=|(?<![<>])[<>](?![=<>])/;
const SIGNED_CAST_DETECT_RX    =
  /\(\s*(?:int(?:8|16|32)(?:_t)?|INT(?:8|16|32)|int(?:8|16|32)|char|short|int|long|signed)\s*\)/i;

function normalizeHexLiterals(expr: string): string {
  return expr.replace(/\b0[xX][0-9a-fA-F]+\b/g, m => Number(m).toString());
}

const SIZEOF_TYPE_SIZES: Record<string, number> = {
  char: 1, short: 2, int: 4, long: 4,
  float: 4, double: 8,
  uint8_t: 1, uint16_t: 2, uint32_t: 4, uint64_t: 8,
  int8_t: 1, int16_t: 2, int32_t: 4, int64_t: 8,
  uint8: 1, uint16: 2, uint32: 4, uint64: 8,
  int8: 1, int16: 2, int32: 4, int64: 8,
  size_t: 4, ptrdiff_t: 4, intptr_t: 4, uintptr_t: 4,
  _Bool: 1, bool: 1, void: 0,
};

// AFTER
function preprocessSizeofAlignof(expr: string): string {
  // [^()]* safely captures inner content without nested parens,
  // which covers all C sizeof() operands we care about.
  return expr.replace(
    /\b(?:sizeof|_Alignof|__alignof__|_Alignas|__alignas__)\s*\(\s*([^()]*?)\s*\)/g,
    (_match, inner: string) => {
      const trimmed = inner.trim();

      // Pointer type: void*, int*, const char* …  → pointer size (32-bit)
      if (/^(?:(?:unsigned|signed|const|volatile)\s+)*[A-Za-z_]\w*\s*\*+\s*$/.test(trimmed)) {
        return "4";
      }

      // Array type: TYPE[N]  →  sizeof(TYPE) * N
      const arrayMatch = trimmed.match(
        /^(?:(?:unsigned|signed)\s+)?([A-Za-z_]\w*)\s*\[(\d+)\]$/
      );
      if (arrayMatch) {
        const elementSize = SIZEOF_TYPE_SIZES[arrayMatch[1].trim()] ?? 4;
        return String(elementSize * parseInt(arrayMatch[2], 10));
      }

      // Plain type, optionally qualified: unsigned int, int8_t, char …
      const plainMatch = trimmed.match(
        /^(?:(?:unsigned|signed)\s+)?([A-Za-z_]\w*)$/
      );
      if (plainMatch) {
        const typeName = plainMatch[1].trim();
        if (typeName in SIZEOF_TYPE_SIZES) {
          return String(SIZEOF_TYPE_SIZES[typeName]);
        }
      }

      // Expression or unknown type (e.g. sizeof(5 + 3 * 2), sizeof(MyStruct))
      // → return the default int size (4)
      return "4";
    }
  );
}

export function detectExpressionNumericFormat(expr: string): NumericDisplayFormat {
  if (HEX_LITERAL_DETECT_RX.test(expr) || BITWISE_OP_DETECT_RX.test(expr)) {
    return 'hex';
  }
  if (BINARY_LITERAL_DETECT_RX.test(expr)) {
    return 'binary';
  }
  // Ternary expressions produce a numeric result even when the
  // condition uses relational operators — avoid boolean display.
  if (expr.includes('?')) {
    return 'decimal';
  }
  if (LOGICAL_OP_DETECT_RX.test(expr) || RELATIONAL_OP_DETECT_RX.test(expr)) {
    return 'boolean';
  }
  return 'decimal';
}

export type CompositeExpressionPreview = {
  expanded: string;
  value: number | null;
  error: CompositeExpressionPreviewError | null;
  displayValue?: number;
  displayUnit?: string;
  /** Formato numerico suggerito in base al contenuto dell'espressione */
  numericFormat?: NumericDisplayFormat;
};

type IdentifierMeta = {
  prevChar: string;
  nextChar: string;
};

type EvalScopeValue =
  | number
  | ((...args: number[]) => number)
  | ((...args: unknown[]) => number)
  | object;

const MAX_MACRO_EXPANSION_DEPTH = 12;
// Hard stop for recursive symbol resolution to avoid JS stack overflow.
const MAX_SYMBOL_RESOLUTION_DEPTH = 96;
const MAX_CYCLE_SAMPLES = 10;
const SIMPLIFY_MAX_PASSES = 4;
const NUMERIC_MUL_DIV_CHAIN_RX =
  /(?<![A-Za-z0-9_.$])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?:\s*[*/]\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?)+(?![A-Za-z0-9_])/g;
const CAST_OVERFLOW_ERROR_NAME = "CalcDocsCastOverflowError";

type IntegerCastRange = {
  min: number;
  max: number;
};

type CastOverflowError = Error & {
  castOverflow: CastOverflowInfo;
};

function isFunctionCallToken(
  token: string,
  meta: IdentifierMeta,
  functionDefines: Map<string, FunctionMacroDefinition>
): boolean {
  return meta.nextChar === "(" && functionDefines.has(token);
}

function toFiniteNumber(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return numeric;
}

function createCastOverflowError(info: CastOverflowInfo): CastOverflowError {
  const error = new Error(
    `cast overflow: (${info.castType}) cannot represent ${info.truncatedValue} (range ${info.min}..${info.max})`
  ) as CastOverflowError;

  error.name = CAST_OVERFLOW_ERROR_NAME;
  error.castOverflow = info;
  return error;
}

function buildIntegerCast(
  castType: string,
  range: IntegerCastRange
): (value: unknown) => number {
  return (value: unknown): number => {
    const numeric = toFiniteNumber(value);
    const truncated = Math.trunc(numeric);

    if (truncated < range.min || truncated > range.max) {
      throw createCastOverflowError({
        castType,
        inputValue: numeric,
        truncatedValue: truncated,
        min: range.min,
        max: range.max,
      });
    }

    return truncated;
  };
}

function buildUnsignedIntegerCast(
  castType: string,
  bits: number
): (value: unknown) => number {
  const modulus = 2 ** bits;
  return (value: unknown): number => {
    const numeric = toFiniteNumber(value);
    const truncated = Math.trunc(numeric);
    return ((truncated % modulus) + modulus) % modulus;
  };
}

function uintCastRange(bits: number): IntegerCastRange {
  return {
    min: 0,
    max: 2 ** bits - 1,
  };
}

function intCastRange(bits: number): IntegerCastRange {
  const signBit = 2 ** (bits - 1);
  return {
    min: -signBit,
    max: signBit - 1,
  };
}

export function getCastOverflowInfo(error: unknown): CastOverflowInfo | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const maybeOverflowError = error as Partial<CastOverflowError>;
  if (maybeOverflowError.name !== CAST_OVERFLOW_ERROR_NAME) {
    return null;
  }

  const info = maybeOverflowError.castOverflow;
  if (!info) {
    return null;
  }

  return info;
}

const C_CAST_SCOPE: Record<string, EvalScopeValue> = {
  UINT8:    buildUnsignedIntegerCast("UINT8",    8),
  UINT16:   buildUnsignedIntegerCast("UINT16",   16),
  UINT32:   buildUnsignedIntegerCast("UINT32",   32),
  INT8: buildIntegerCast("INT8", intCastRange(8)),
  INT16: buildIntegerCast("INT16", intCastRange(16)),
  INT32: buildIntegerCast("INT32", intCastRange(32)),
  uint8_t:  buildUnsignedIntegerCast("uint8_t",  8),
  uint16_t: buildUnsignedIntegerCast("uint16_t", 16),
  uint32_t: buildUnsignedIntegerCast("uint32_t", 32),
  int8_t: buildIntegerCast("int8_t", intCastRange(8)),
  int16_t: buildIntegerCast("int16_t", intCastRange(16)),
  int32_t: buildIntegerCast("int32_t", intCastRange(32)),
  uint8:    buildUnsignedIntegerCast("uint8",    8),
  uint16:   buildUnsignedIntegerCast("uint16",   16),
  uint32:   buildUnsignedIntegerCast("uint32",   32),
  int8: buildIntegerCast("int8", intCastRange(8)),
  int16: buildIntegerCast("int16", intCastRange(16)),
  int32: buildIntegerCast("int32", intCastRange(32)),
  char: buildIntegerCast("char", intCastRange(8)),
  int: buildIntegerCast("int", intCastRange(32)),
  short: buildIntegerCast("short", intCastRange(16)),
  long: buildIntegerCast("long", intCastRange(32)),
  unsigned: buildUnsignedIntegerCast("unsigned", 32),
  signed: buildIntegerCast("signed", intCastRange(32)),
  float: (value: unknown) => toFiniteNumber(value),
  double: (value: unknown) => toFiniteNumber(value),
  bool: (value: unknown) => (toFiniteNumber(value) === 0 ? 0 : 1),
  _Bool: (value: unknown) => (toFiniteNumber(value) === 0 ? 0 : 1),
  // _Complex: restituisce la parte reale (semplificazione per firmware C99)
  _Complex: (value: unknown) => toFiniteNumber(value),
  // Unsigned 32-bit bitwise NOT helper used by expression pre-processing.
  bnot: (value: unknown) => (~Math.trunc(toFiniteNumber(value))) >>> 0,
};

const BASE_MATH_SCOPE: Record<string, EvalScopeValue> = {
  ...C_CAST_SCOPE,
  Math,
  ...ENGINEERING_MATH_SCOPE,
};

const MATH_SCOPE = addUppercaseAliases(BASE_MATH_SCOPE);
const LOOKUP_FUNCTION_NAMES = new Set<string>(["csv", "table", "lookup"]);
const RESERVED_IDENTIFIERS = new Set<string>([
  ...Object.keys(MATH_SCOPE),
  "csv",
  "table",
  "lookup",
  "true",
  "false",
  "null",
  "undefined",
  "Infinity",
  "NaN",
]);

export type SymbolResolutionStats = {
  // Current recursive depth while traversing dependencies.
  currentDepth: number;
  // Highest depth reached in the whole analysis pass.
  maxDepth: number;
  // Configured hard limit used by guards.
  depthLimit: number;
  // Circular references detected during resolution.
  cycleCount: number;
  // Number of branches stopped by depth guard.
  depthLimitHits: number;
  // Unique samples of circular dependency chains, e.g. A -> B -> A.
  cycleSamples: string[];
};

export type SymbolResolutionSnapshot = {
  usedDepth: number;
  depthLimit: number;
  cycleCount: number;
  prunedCount: number;
  degraded: boolean;
};

export function createSymbolResolutionStats(
  depthLimit = MAX_SYMBOL_RESOLUTION_DEPTH
): SymbolResolutionStats {
  return {
    currentDepth: 0,
    maxDepth: 0,
    depthLimit,
    cycleCount: 0,
    depthLimitHits: 0,
    cycleSamples: [],
  };
}

export function snapshotSymbolResolutionStats(
  stats: SymbolResolutionStats
): SymbolResolutionSnapshot {
  return {
    usedDepth: stats.maxDepth,
    depthLimit: stats.depthLimit,
    cycleCount: stats.cycleCount,
    prunedCount: stats.depthLimitHits,
    degraded: stats.cycleCount > 0 || stats.depthLimitHits > 0,
  };
}

function addUppercaseAliases(
  scope: Record<string, EvalScopeValue>
): Record<string, EvalScopeValue> {
  const withAliases: Record<string, EvalScopeValue> = {
    ...scope,
  };

  for (const [key, value] of Object.entries(scope)) {
    const upper = key.toUpperCase();
    if (!(upper in withAliases)) {
      withAliases[upper] = value;
    }
  }

  return withAliases;
}

function isIdentifierStartChar(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPartChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function isWhitespaceChar(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function findPrevNonWhitespaceChar(text: string, start: number): string {
  for (let i = start - 1; i >= 0; i -= 1) {
    const char = text[i];
    if (!isWhitespaceChar(char)) {
      return char;
    }
  }

  return "";
}

function findNextNonWhitespaceChar(text: string, start: number): string {
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (!isWhitespaceChar(char)) {
      return char;
    }
  }

  return "";
}

function looksLikeNumericSuffixToken(
  expr: string,
  start: number,
  token: string
): boolean {
  const prevRawChar = start > 0 ? expr[start - 1] : "";
  const prevIsNumberPiece = /[0-9.]/.test(prevRawChar);

  if (prevIsNumberPiece && /^e[0-9]*$/i.test(token)) {
    return true;
  }

  if (prevRawChar === "0" && /^[xXbBoO][0-9A-Fa-f]+$/.test(token)) {
    return true;
  }

  return false;
}

function replaceIdentifiersOutsideStrings(
  expr: string,
  replacer: (identifier: string, meta: IdentifierMeta) => string
): string {
  let output = "";

  for (let i = 0; i < expr.length; ) {
    const char = expr[i];

    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      const start = i;
      i += 1;

      while (i < expr.length) {
        const current = expr[i];

        if (current === "\\") {
          i += 2;
          continue;
        }

        i += 1;

        if (current === quote) {
          break;
        }
      }

      output += expr.slice(start, i);
      continue;
    }

    if (!isIdentifierStartChar(char)) {
      output += char;
      i += 1;
      continue;
    }

    const start = i;
    i += 1;

    while (i < expr.length && isIdentifierPartChar(expr[i])) {
      i += 1;
    }

    const token = expr.slice(start, i);
    if (looksLikeNumericSuffixToken(expr, start, token)) {
      output += token;
      continue;
    }

    output += replacer(token, {
      prevChar: findPrevNonWhitespaceChar(expr, start),
      nextChar: findNextNonWhitespaceChar(expr, i),
    });
  }

  return output;
}

function parseCsvNumericValue(rawValue: string): number | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const directNumber = Number(trimmed);
  if (Number.isFinite(directNumber)) {
    return directNumber;
  }

  if (trimmed.includes(",") && !trimmed.includes(".")) {
    const commaDecimal = Number(trimmed.replace(",", "."));
    if (Number.isFinite(commaDecimal)) {
      return commaDecimal;
    }
  }

  return null;
}

function resolveCsvTable(
  csvTables: CsvTableMap | undefined,
  tableName: string
): CsvTable | undefined {
  if (!csvTables) {
    return undefined;
  }

  const normalized = normalizeCsvTableKey(tableName);
  const normalizedWithoutExt = normalized.endsWith(".csv")
    ? normalized.slice(0, -4)
    : normalized;
  const lastSlashIndex = normalized.lastIndexOf("/");
  const basename =
    lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
  const basenameWithoutExt = basename.endsWith(".csv")
    ? basename.slice(0, -4)
    : basename;

  return (
    csvTables.get(normalized) ??
    csvTables.get(normalizedWithoutExt) ??
    csvTables.get(basename) ??
    csvTables.get(basenameWithoutExt)
  );
}

function parseCsvRowIndex(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  return null;
}

type CsvInterpolationMode = "none" | "linear" | "nearest";

function resolveCsvColumnIndex(table: CsvTable, columnRef: unknown): number | null {
  if (typeof columnRef === "number" && Number.isFinite(columnRef)) {
    return Math.trunc(columnRef);
  }

  if (typeof columnRef === "string") {
    const normalized = columnRef.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    if (table.headerIndex.has(normalized)) {
      return table.headerIndex.get(normalized) ?? null;
    }

    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) {
      return Math.trunc(numeric);
    }
  }

  return null;
}

function parseCsvInterpolationMode(modeRef: unknown): CsvInterpolationMode {
  if (modeRef == null) {
    return "none";
  }

  if (typeof modeRef !== "string") {
    throw new Error("csv interpolation mode must be string");
  }

  const normalized = modeRef.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "exact") {
    return "none";
  }

  if (normalized === "linear" || normalized === "lerp") {
    return "linear";
  }

  if (normalized === "nearest" || normalized === "closest") {
    return "nearest";
  }

  throw new Error(`unsupported csv interpolation mode: ${modeRef}`);
}

function tryParseCsvInterpolationMode(
  modeRef: unknown
): CsvInterpolationMode | null {
  try {
    return parseCsvInterpolationMode(modeRef);
  } catch {
    return null;
  }
}

function parseCsvLookupNumericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    return parseCsvNumericValue(value);
  }

  return null;
}

function resolveCsvRow(
  table: CsvTable,
  rowRef: unknown,
  lookupColumnIndex: number,
  allowNumericRowIndex: boolean
): string[] | null {
  if (allowNumericRowIndex) {
    const numericRowIndex = parseCsvRowIndex(rowRef);
    if (numericRowIndex != null) {
      if (numericRowIndex < 0) {
        return null;
      }

      const dataRows = table.rows.length > 1 ? table.rows.slice(1) : table.rows;
      return dataRows[numericRowIndex] ?? null;
    }
  }

  const lookupKey = String(rowRef ?? "").trim();
  if (!lookupKey) {
    return null;
  }

  const numericLookup = parseCsvLookupNumericValue(rowRef);

  for (let i = 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const cellValue = (row[lookupColumnIndex] ?? "").trim();
    if (!cellValue) {
      continue;
    }

    if (cellValue === lookupKey) {
      return row;
    }

    if (numericLookup != null) {
      const numericCell = parseCsvNumericValue(cellValue);
      if (numericCell != null && numericCell === numericLookup) {
        return row;
      }
    }
  }

  const firstRow = table.rows[0];
  const firstCellValue = (firstRow?.[lookupColumnIndex] ?? "").trim();
  if (firstCellValue === lookupKey) {
    return firstRow;
  }

  if (numericLookup != null) {
    const numericCell = parseCsvNumericValue(firstCellValue);
    if (numericCell != null && numericCell === numericLookup) {
      return firstRow ?? null;
    }
  }

  return null;
}

type CsvInterpolationPoint = {
  x: number;
  y: number;
};

function collectCsvInterpolationPoints(
  table: CsvTable,
  lookupColumnIndex: number,
  valueColumnIndex: number
): CsvInterpolationPoint[] {
  const points: CsvInterpolationPoint[] = [];

  for (const row of table.rows) {
    const x = parseCsvNumericValue(row[lookupColumnIndex] ?? "");
    const y = parseCsvNumericValue(row[valueColumnIndex] ?? "");
    if (x == null || y == null) {
      continue;
    }

    points.push({
      x,
      y,
    });
  }

  points.sort((a, b) => a.x - b.x);
  return points;
}

function interpolateCsvValue(
  target: number,
  points: CsvInterpolationPoint[],
  mode: CsvInterpolationMode
): number | null {
  if (points.length === 0) {
    return null;
  }

  let lowerPoint: CsvInterpolationPoint | null = null;
  let upperPoint: CsvInterpolationPoint | null = null;
  let nearestPoint: CsvInterpolationPoint = points[0];
  let nearestDistance = Math.abs(points[0].x - target);

  for (const point of points) {
    if (point.x === target) {
      return point.y;
    }

    if (point.x < target && (!lowerPoint || point.x > lowerPoint.x)) {
      lowerPoint = point;
    }

    if (point.x > target && (!upperPoint || point.x < upperPoint.x)) {
      upperPoint = point;
    }

    const distance = Math.abs(point.x - target);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestPoint = point;
    }
  }

  if (mode === "nearest") {
    return nearestPoint.y;
  }

  if (!lowerPoint || !upperPoint || upperPoint.x === lowerPoint.x) {
    return null;
  }

  const ratio = (target - lowerPoint.x) / (upperPoint.x - lowerPoint.x);
  return lowerPoint.y + ratio * (upperPoint.y - lowerPoint.y);
}

function lookupCsvValue(
  args: unknown[],
  csvTables: CsvTableMap | undefined
): number | any {
  if (args.length < 2) {
    throw new Error("csv() requires at least table and row parameters");
  }

  const [tableRef, rowRef] = args;
  if (typeof tableRef !== "string" || !tableRef.trim()) {
    throw new Error("csv() first argument must be table name");
  }

  const table = resolveCsvTable(csvTables, tableRef);
  if (!table) {
    throw new Error(`csv table not found: ${tableRef}`);
  }

  // Supported signatures:
  // - csv(table, row, valueColumn)
  // - csv(table, row, valueColumn, interpolationMode)
  // - csv(table, row, lookupColumn, valueColumn)
  // - csv(table, row, lookupColumn, valueColumn, interpolationMode)
  // - csv(table, row, lookupColumn, valueColumn, interpolationMode, unit)
  let isNewSignature = false;
  let allowNumericRowIndex = true;
  const fallbackValueColumn = typeof rowRef === "string" ? 1 : 0;
  let lookupColumnRef: unknown = 0;
  let valueColumnRef: unknown = args[2] ?? fallbackValueColumn;
  let interpolationModeRef: unknown = args[3];
  let unitRef: unknown = undefined;

  if (args.length >= 6) {
    isNewSignature = true;
    allowNumericRowIndex = false;
    lookupColumnRef = args[2];
    valueColumnRef = args[3];
    interpolationModeRef = args[4];
    unitRef = args[5];
  } else if (args.length === 5) {
    const thirdIsColumn = resolveCsvColumnIndex(table, args[2]) != null;
    const fourthIsColumn = resolveCsvColumnIndex(table, args[3]) != null;
    const fifthIsMode = (() => {
        try {
          parseCsvInterpolationMode(args[4]);
          return true;
        } catch {
          return false;
        }
    })();

    if (thirdIsColumn && fourthIsColumn) {
      isNewSignature = true;
      allowNumericRowIndex = false;
      lookupColumnRef = args[2];
      valueColumnRef = args[3];
      if (fifthIsMode) {
        interpolationModeRef = args[4];
        unitRef = undefined;
      } else {
        interpolationModeRef = undefined;
        unitRef = args[4];
      }
    } else {
      isNewSignature = false;
      allowNumericRowIndex = true;
      lookupColumnRef = 0;
      valueColumnRef = args[2];
      interpolationModeRef = args[3];
      unitRef = args[4];
    }
  } else if (args.length === 4) {
    const secondArgColumnExists = resolveCsvColumnIndex(table, args[2]) != null;
    const thirdArgColumnExists = resolveCsvColumnIndex(table, args[3]) != null;
    const maybeInterpolationMode = tryParseCsvInterpolationMode(args[3]);

    if (secondArgColumnExists && thirdArgColumnExists) {
      isNewSignature = true;
      allowNumericRowIndex = false;
      lookupColumnRef = args[2];
      valueColumnRef = args[3];
      interpolationModeRef = undefined;
      unitRef = undefined;
    } else if (secondArgColumnExists && maybeInterpolationMode != null) {
      isNewSignature = false;
      allowNumericRowIndex = true;
      lookupColumnRef = 0;
      valueColumnRef = args[2];
      interpolationModeRef = args[3];
      unitRef = undefined;
    } else {
      isNewSignature = true;
      allowNumericRowIndex = false;
      lookupColumnRef = args[2];
      valueColumnRef = args[3];
      interpolationModeRef = undefined;
      unitRef = args[3]; // Wait, actually args[3] might be unit if it's not a column
    }
  } else if (args.length === 3) {
    isNewSignature = false;
    allowNumericRowIndex = true;
    lookupColumnRef = 0;
    valueColumnRef = args[2];
    interpolationModeRef = undefined;
    unitRef = undefined;
  } else {
    isNewSignature = false;
    allowNumericRowIndex = true;
    lookupColumnRef = 0;
    valueColumnRef = fallbackValueColumn;
    interpolationModeRef = undefined;
    unitRef = undefined;
  }

  const interpolationMode = parseCsvInterpolationMode(interpolationModeRef);

  const lookupColumnIndex = resolveCsvColumnIndex(table, lookupColumnRef);
  if (
    lookupColumnIndex == null ||
    lookupColumnIndex < 0 ||
    lookupColumnIndex >= table.rows[0].length
  ) {
    throw new Error(`csv column not found: ${String(lookupColumnRef)}`);
  }

  const valueColumnIndex = resolveCsvColumnIndex(table, valueColumnRef);
  if (
    valueColumnIndex == null ||
    valueColumnIndex < 0 ||
    valueColumnIndex >= table.rows[0].length
  ) {
    throw new Error(`csv column not found: ${String(valueColumnRef)}`);
  }

  const row = resolveCsvRow(
    table,
    rowRef,
    lookupColumnIndex,
    allowNumericRowIndex
  );
  if (row) {
    const numericCellValue = parseCsvNumericValue(row[valueColumnIndex] ?? "");
    if (numericCellValue == null) {
      throw new Error("csv value is not numeric");
    }

    if (unitRef != null && typeof unitRef === "string" && unitRef.trim()) {
        const q = createQuantityFromData(numericCellValue, unitRef.trim());
        if (q.ok) return q.value;
    }

    return numericCellValue;
  }

  if (interpolationMode === "none") {
    throw new Error(`csv row not found: ${String(rowRef)}`);
  }

  const targetValue = parseCsvLookupNumericValue(rowRef);
  if (targetValue == null) {
    throw new Error("csv interpolation requires a numeric lookup value");
  }

  const points = collectCsvInterpolationPoints(
    table,
    lookupColumnIndex,
    valueColumnIndex
  );
  const interpolatedValue = interpolateCsvValue(
    targetValue,
    points,
    interpolationMode
  );
  if (interpolatedValue == null) {
    throw new Error("csv interpolation not possible for requested value");
  }

  if (unitRef != null && typeof unitRef === "string" && unitRef.trim()) {
      const q = createQuantityFromData(interpolatedValue, unitRef.trim());
      if (q.ok) return q.value;
  }

  return interpolatedValue;
}

function createEvaluationScope(
  context: EvaluationContext
): Record<string, EvalScopeValue> {
  const csvLookup = (...args: unknown[]) => lookupCsvValue(args, context.csvTables);

  return {
    ...MATH_SCOPE,
    csv: csvLookup,
    table: csvLookup,
    lookup: csvLookup,
  };
}

function findFunctionCallEnd(expr: string, openParenIndex: number): number {
  let depth = 0;

  for (let i = openParenIndex; i < expr.length; i += 1) {
    const char = expr[i];

    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i += 1;

      while (i < expr.length) {
        const current = expr[i];
        if (current === "\\") {
          i += 2;
          continue;
        }

        if (current === quote) {
          break;
        }

        i += 1;
      }

      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }

  return -1;
}

function splitCallArguments(argText: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;

  for (let i = 0; i < argText.length; i += 1) {
    const char = argText[i];

    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      current += char;
      i += 1;

      while (i < argText.length) {
        const inner = argText[i];
        current += inner;
        if (inner === "\\") {
          i += 1;
          if (i < argText.length) {
            current += argText[i];
          }
          i += 1;
          continue;
        }

        if (inner === quote) {
          break;
        }

        i += 1;
      }

      continue;
    }

    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ")") {
      if (depth > 0) {
        depth -= 1;
      }

      current += char;
      continue;
    }

    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing.length > 0 || argText.trim().length > 0) {
    args.push(trailing);
  }

  return args;
}

function normalizeMacroTokenForPaste(value: string): string {
  return value
    .trim()
    .replace(/^\((.*)\)$/s, "$1")
    .replace(/\s+/g, "");
}

function stringifyMacroArgument(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  const escaped = normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function applyMacroTokenPasting(
  body: string,
  rawArguments: Map<string, string>
): string {
  const OPERAND_RX = "([A-Za-z_]\\w*|\\d+)";
  const tokenPasteRx = new RegExp(`${OPERAND_RX}\\s*##\\s*${OPERAND_RX}`, "g");

  let output = body;
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    output = output.replace(
      tokenPasteRx,
      (_full, leftRaw: string, rightRaw: string) => {
        const left = rawArguments.get(leftRaw) ?? leftRaw;
        const right = rawArguments.get(rightRaw) ?? rightRaw;
        changed = true;
        return `${normalizeMacroTokenForPaste(left)}${normalizeMacroTokenForPaste(right)}`;
      }
    );

    if (!changed) {
      break;
    }
  }

  return output;
}

function applyMacroStringizing(
  body: string,
  rawArguments: Map<string, string>
): string {
  return body.replace(/(^|[^#])#\s*([A-Za-z_]\w*)/g, (full, prefix: string, name: string) => {
    if (!rawArguments.has(name)) {
      return full;
    }

    return `${prefix}${stringifyMacroArgument(rawArguments.get(name) ?? "")}`;
  });
}

function replaceMacroParameter(body: string, parameter: string, value: string): string {
  return replaceIdentifiersOutsideStrings(body, (token) => {
    if (token === parameter) {
      return value;
    }

    return token;
  });
}

function formatPreviewNumber(value: number): string {
  if (Object.is(value, -0)) {
    return "0";
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  return String(value);
}

function isReducibleNumericFragment(fragment: string): boolean {
  const trimmed = fragment.trim();
  if (!trimmed) {
    return false;
  }

  if (/[A-Za-z_]/.test(trimmed)) {
    return false;
  }

  return /^[0-9+\-*/%()\s.eE]+$/.test(trimmed);
}

function simplifyNumericFragments(expr: string, context: EvaluationContext): string {
  if (BITWISE_OP_DETECT_RX.test(expr)) {
    return expr;
  }

  let output = expr;

  for (let pass = 0; pass < SIMPLIFY_MAX_PASSES; pass += 1) {
    let changed = false;

  output = output.replace(
    /\(([^()]+)\)/g,
    (group, inner: string, offset: number, source: string) => {
      if (!isReducibleNumericFragment(inner)) {
        return group;
      }

      const prefix = source.slice(0, offset);

      // Don't strip parens that are function call arguments (identifier immediately before '(')
      if (/[A-Za-z0-9_]$/.test(prefix.trimEnd())) {
        return group;
      }

      try {
        const value = safeEval(inner, context);
        changed = true;
        const formatted = formatPreviewNumber(value);
        const castPrefixMatch = prefix.match(
          /\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)\s*$/
        );

        return castPrefixMatch ? `(${formatted})` : formatted;
      } catch {
        return group;
      }
    }
  );



    output = output.replace(NUMERIC_MUL_DIV_CHAIN_RX, (segment) => {
      if (!isReducibleNumericFragment(segment)) {
        return segment;
      }

      try {
        const value = safeEval(segment, context);
        changed = true;
        return formatPreviewNumber(value);
      } catch {
        return segment;
      }
    });

    if (!changed) {
      break;
    }
  }

  return output;
}

function numericSubstitution(value: number): string {
  return value < 0 ? `(${value})` : String(value);
}

function expandFunctionLikeMacrosInExpression(
  expr: string,
  functionDefines: Map<string, FunctionMacroDefinition>,
  symbolValues: Map<string, number>,
  defines: Map<string, string>,
  resolved: Map<string, number>,
  context: EvaluationContext,
  depth = 0,
  stackStats: SymbolResolutionStats = createSymbolResolutionStats(),
  resolving: Set<string> = new Set<string>(),
  defineConditions: Map<string, string> = new Map<string, string>(),
  activeCondition: string | null = null
): string {
  if (!expr || functionDefines.size === 0 || depth >= MAX_MACRO_EXPANSION_DEPTH) {
    return expr;
  }

  let output = "";

  for (let i = 0; i < expr.length; ) {
    const char = expr[i];

    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      const start = i;
      i += 1;

      while (i < expr.length) {
        const current = expr[i];
        if (current === "\\") {
          i += 2;
          continue;
        }

        i += 1;
        if (current === quote) {
          break;
        }
      }

      output += expr.slice(start, i);
      continue;
    }

    if (!isIdentifierStartChar(char)) {
      output += char;
      i += 1;
      continue;
    }

    const tokenStart = i;
    i += 1;
    while (i < expr.length && isIdentifierPartChar(expr[i])) {
      i += 1;
    }

    const token = expr.slice(tokenStart, i);
    const macro = functionDefines.get(token);
    if (!macro) {
      output += token;
      continue;
    }

    let openParenIndex = i;
    while (openParenIndex < expr.length && isWhitespaceChar(expr[openParenIndex])) {
      openParenIndex += 1;
    }

    if (expr[openParenIndex] !== "(") {
      output += token;
      continue;
    }

    const callEnd = findFunctionCallEnd(expr, openParenIndex);
    if (callEnd < 0) {
      output += token;
      continue;
    }

    const rawArgs = expr.slice(openParenIndex + 1, callEnd - 1);
    const parsedArgs = splitCallArguments(rawArgs);
    if (parsedArgs.length !== macro.params.length) {
      output += expr.slice(tokenStart, callEnd);
      i = callEnd;
      continue;
    }

    const expandedArgs = parsedArgs.map((argument) => {
      const expandedArgument = expandFunctionLikeMacrosInExpression(
        argument,
        functionDefines,
        symbolValues,
        defines,
        resolved,
        context,
        depth + 1,
        stackStats,
        resolving,
        defineConditions,
        activeCondition
      );

      return replaceIdentifiersOutsideStrings(expandedArgument, (identifier, meta) => {
        if (meta.prevChar === ".") {
          return identifier;
        }

        if (symbolValues.has(identifier)) {
          const v = symbolValues.get(identifier)!;
          return numericSubstitution(v);
        }


        if (RESERVED_IDENTIFIERS.has(identifier) || isFunctionCallToken(identifier, meta, functionDefines)) {
          return identifier;
        }

        const value = resolveSymbol(
          identifier,
          defines,
          functionDefines,
          resolved,
          symbolValues,
          context,
          stackStats,
          resolving,
          defineConditions,
          activeCondition
        );
        if (value == null) {
          return identifier;
        }

        return numericSubstitution(value);//String(value);
      });
    });

    const rawArgumentMap = new Map<string, string>();
    const expandedArgumentMap = new Map<string, string>();
    for (let argIndex = 0; argIndex < macro.params.length; argIndex += 1) {
      const parameterName = macro.params[argIndex];
      rawArgumentMap.set(parameterName, parsedArgs[argIndex]);
      expandedArgumentMap.set(parameterName, expandedArgs[argIndex]);
    }

    let expandedBody = applyMacroTokenPasting(macro.body, rawArgumentMap);
    expandedBody = applyMacroStringizing(expandedBody, rawArgumentMap);

    for (let argIndex = 0; argIndex < macro.params.length; argIndex += 1) {
      const parameterName = macro.params[argIndex];
      const expandedParameterValue = expandedArgumentMap.get(parameterName) ?? "";
      
      // Avoid redundant parentheses for simple identifiers or already wrapped expressions
      const needsParens = !/^[A-Za-z_]\w*$/.test(expandedParameterValue) && 
                         !(expandedParameterValue.startsWith("(") && expandedParameterValue.endsWith(")"));
      
      const replacementValue = needsParens ? `(${expandedParameterValue})` : expandedParameterValue;

      expandedBody = replaceMacroParameter(
        expandedBody,
        parameterName,
        replacementValue
      );
    }

    expandedBody = expandFunctionLikeMacrosInExpression(
      expandedBody,
      functionDefines,
      symbolValues,
      defines,
      resolved,
      context,
      depth + 1,
      stackStats,
      resolving,
      defineConditions,
      activeCondition
    );

    // Only wrap the body if it's not a single token and not already wrapped
    const bodyNeedsParens = !/^[A-Za-z_]\w*$/.test(expandedBody) && 
                           !(expandedBody.startsWith("(") && expandedBody.endsWith(")"));
    
    let segment = bodyNeedsParens ? `(${expandedBody})` : expandedBody;
    output += removeRedundantParens(segment);
    i = callEnd;
  }

  return output;
}

/**
 * Removes redundant nested parentheses like ((expr)) -> (expr)
 * and (token) -> token.
 */
export function removeRedundantParens(expr: string): string {
  let current = expr.trim();
  if (!current) return current;

  let changed = true;
  while (changed) {
    changed = false;

    // Step 1: rimuove parens attorno a singoli atomi.
    // Il negative lookahead (?!\s*[A-Za-z0-9_(]) evita di strippare cast C
    // come (uint16_t) quando sono immediatamente seguiti da un operando.
    const nextAfterStep1 = current.replace(
      /(?<![A-Za-z0-9_.$])\(([A-Za-z_]\w*|\d+(?:\.\d+)?)\)(?!\s*[A-Za-z0-9_(~\-])/g,
      "$1"
    );

    if (nextAfterStep1 !== current) {
      current = nextAfterStep1;
      changed = true;
    }

    // 2. ((balanced_expr)) -> (balanced_expr)
    // We look for any occurrences of ((...)) where the inner (...) is balanced.
    let nextAfterStep2 = "";
    let step2Changed = false;
    for (let i = 0; i < current.length; i++) {
      if (current[i] === "(" && current[i + 1] === "(") {
        const innerEnd = findClosingParen(current, i + 1);

        // Case A: ((X)) → (X)  [double-wrap classico]
        if (innerEnd !== -1 && innerEnd + 1 < current.length && current[innerEnd + 1] === ")") {
          const inner = current.slice(i + 1, innerEnd + 1);
          if (isParentheticallyBalanced(inner)) {
            nextAfterStep2 += inner;
            i = innerEnd + 1;
            step2Changed = true;
            continue;
          }
        }

        // Case B: ((TypeName) value) → (TypeName) value
        // Le macro in C wrappano spesso il cast in parens esterne di sicurezza.
        if (innerEnd !== -1) {
          const castContent = current.slice(i + 1, innerEnd + 1);
          if (/^\([A-Za-z_][A-Za-z0-9_]*\)$/.test(castContent)) {
            const outerEnd = findClosingParen(current, i);
            if (outerEnd !== -1) {
              nextAfterStep2 += current.slice(i + 1, outerEnd);
              i = outerEnd;
              step2Changed = true;
              continue;
            }
          }
        }
      }
      nextAfterStep2 += current[i];
    }

    if (step2Changed) {
      current = nextAfterStep2;
      changed = true;
    }
  }

  return current;
}

function findClosingParen(text: string, openPos: number): number {
  let depth = 1;
  for (let i = openPos + 1; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isParentheticallyBalanced(expr: string): boolean {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * Resolves inline CSV/table lookup calls into numeric literals.
 * Example: csv("ntc.csv","25","temp_c","r","linear") -> 10000
 */
export function resolveInlineLookups(
  expr: string,
  context: EvaluationContext = {}
): string {
  if (!expr) {
    return expr;
  }

  let output = "";

  for (let i = 0; i < expr.length; ) {
    const char = expr[i];

    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      const start = i;
      i += 1;

      while (i < expr.length) {
        const current = expr[i];
        if (current === "\\") {
          i += 2;
          continue;
        }

        i += 1;
        if (current === quote) {
          break;
        }
      }

      output += expr.slice(start, i);
      continue;
    }

    if (!isIdentifierStartChar(char)) {
      output += char;
      i += 1;
      continue;
    }

    const tokenStart = i;
    i += 1;
    while (i < expr.length && isIdentifierPartChar(expr[i])) {
      i += 1;
    }

    const token = expr.slice(tokenStart, i);
    if (!LOOKUP_FUNCTION_NAMES.has(token.toLowerCase())) {
      output += token;
      continue;
    }

    let openParenIndex = i;
    while (openParenIndex < expr.length && isWhitespaceChar(expr[openParenIndex])) {
      openParenIndex += 1;
    }

    if (expr[openParenIndex] !== "(") {
      output += token;
      continue;
    }

    const callEnd = findFunctionCallEnd(expr, openParenIndex);
    if (callEnd < 0) {
      output += token;
      continue;
    }

    const callExpr = expr.slice(tokenStart, callEnd);
    try {
      const lookupValue = safeEval(callExpr, context);
      output += String(lookupValue);
    } catch {
      output += callExpr;
    }

    i = callEnd;
  }

  return output;
}

function hasWholeExpressionOuterParens(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    return false;
  }

  let depth = 0;

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];

    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i += 1;
      while (i < trimmed.length) {
        const current = trimmed[i];
        if (current === "\\") {
          i += 2;
          continue;
        }

        if (current === quote) {
          break;
        }

        i += 1;
      }
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }

      // If we close the first opening parenthesis before the end,
      // this is not a single outer wrapper (e.g. "(A) + (B)").
      if (depth === 0 && i < trimmed.length - 1) {
        return false;
      }
    }
  }

  return depth === 0;
}

/**
 * Removes redundant outer parenthesis layers only when they wrap the whole expression.
 *
 * Examples:
 * - "((42))" -> "42"
 * - "((A))" -> "A"
 * - "(A) + (B)" -> "(A) + (B)" (not a whole-expression wrapper)
 * - "(unsigned int)(X)" -> "(unsigned int)(X)" (cast preserved)
 */
export function unwrapParens(expr: string): string {
  let value = expr.trim();

  // Remove trailing semicolon if present
  if (value.endsWith(";")) {
    const inner = value.slice(0, -1).trim();
    if (inner) {
      value = inner;
    }
  }

  while (hasWholeExpressionOuterParens(value)) {
    const inner = value.slice(1, -1).trim();
    if (!inner) {
      break;
    }

    value = inner;
  }

  return value;
}

/**
 * Removes common C literal suffixes so JavaScript evaluation can parse them.
 * Example: "10UL + 3f" -> "10 + 3"
 */
type LiteralSanitizationResult = {
  expression: string;
  hasUnsignedIntegerLiteral: boolean;
};

const C_NUMERIC_LITERAL_WITH_SUFFIX_RX =
  /(?<![A-Za-z0-9_.$])((?:0[xX][0-9A-Fa-f]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?))(u(?:ll|l)?|(?:ll|l)u|ll|l|f)\b/gi;
const SIGNED_RIGHT_SHIFT_RX = />>(?!>)/g;
const BITWISE_OPERATOR_RX = /(?<![&])&(?!&)|(?<![|])\|(?!\|)|\^|~|<<|>>>?/;
const UNARY_BITWISE_NOT_PAREN_RX = /~\s*\(/g;
const UNARY_BITWISE_NOT_TOKEN_RX =
  /~\s*(0[xX][0-9A-Fa-f]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]\w*)/g;

function literalIsFloatingPoint(literal: string, suffix: string): boolean {
  if (suffix.toLowerCase().includes("f")) {
    return true;
  }

  if (/^0[xX]/.test(literal) || /^0[bB]/.test(literal) || /^0[oO]/.test(literal)) {
    return false;
  }

  return literal.includes(".") || /[eE]/.test(literal);
}

function sanitizeCLiteralsForEval(expr: string): LiteralSanitizationResult {
  let hasUnsignedIntegerLiteral = false;
  const expression = expr.replace(
    C_NUMERIC_LITERAL_WITH_SUFFIX_RX,
    (full: string, literal: string, suffix: string) => {
      const normalizedSuffix = suffix.toLowerCase();
      if (
        /^0[xX]/.test(literal) &&
        normalizedSuffix === "f"
      ) {
        return full;
      }

      if (
        normalizedSuffix.includes("u") &&
        !literalIsFloatingPoint(literal, normalizedSuffix)
      ) {
        hasUnsignedIntegerLiteral = true;
      }

      return literal;
    }
  );

  return {
    expression,
    hasUnsignedIntegerLiteral,
  };
}

function preprocessUnsignedBitwiseOps(
  expr: string,
  hasUnsignedIntegerLiteral: boolean,
  hasHexLiteral: boolean = false 
): string {
  if (!hasUnsignedIntegerLiteral && !hasHexLiteral) {  // ← aggiornata guardia
    return expr;
  }

  if (!expr.includes(">>")) {
    return expr;
  }

  let output = expr;

  // bnot solo per letterali con suffisso U esplicito (0xFu, 1u, ecc.)
  // Per hex puri (0xFF senza U), ci si affida a >>> 0 in safeEval
  if (hasUnsignedIntegerLiteral) {
    output = output.replace(UNARY_BITWISE_NOT_PAREN_RX, "bnot(");
    output = output.replace(
      UNARY_BITWISE_NOT_TOKEN_RX,
      (_: string, operand: string) => `bnot(${operand})`
    );
  }

  // >> → >>> vale per entrambi i contesti
  return output.replace(SIGNED_RIGHT_SHIFT_RX, ">>>");
}

// const C_QUALIFIER_PATTERN =
//   "volatile|const|restrict|__restrict__|__restrict|__volatile__|__volatile|__const__|__const|__extension__";
// const C_TYPE_PATTERN =
//   "(?:u?int|UINT|INT)(?:8|16|32)(?:_t)?|float|double|bool|char|short|long|unsigned|signed|int";
// // const C_TYPE_PATTERN =
// //   /\(\s*(u?int(?:8|16|32)(?:_t)?|UINT(?:8|16|32)|INT(?:8|16|32)|uint(?:8|16|32)|int(?:8|16|32)|float|double|bool|char|short|long|unsigned|signed|int)\s*\)\s*(?!\()([-+~]?(?:0[xX][\dA-Fa-f]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]\w*)(?!\s*\())/gi
// //   // "u?int(?:8|16|32)(?:_t)?|UINT(?:8|16|32)|INT(?:8|16|32)|uint(?:8|16|32)|int(?:8|16|32)|float|double|bool|char|short|long|unsigned|signed|int";
// const C_CAST_WITH_QUALIFIER_RX = new RegExp(
//   `\\(\\s*(?:(?:${C_QUALIFIER_PATTERN})\\s+)+(${C_TYPE_PATTERN})\\s*\\)`,
//   "gi"
// );
// const C_CAST_UNPAREN_RX = new RegExp(
//   `\\(\\s*(${C_TYPE_PATTERN})\\s*\\)` +
//     `\\s*(?!\\()` +
//     `([-+~]?(?:0[xX][\\dA-Fa-f]+|0[bB][01]+|0[oO][0-7]+|(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?|[A-Za-z_]\\w*)(?!\\s*\\()))`,
//   "gi"
// );

const C_QUALIFIER_PATTERN =
  "volatile|const|restrict|__restrict__|__restrict|__volatile__|__volatile|__const__|__const|__extension__";

const C_TYPE_PATTERN =
  "(?:u?int|UINT|INT)(?:8|16|32)(?:_t)?|float|double|bool|char|short|long|unsigned|signed|int";

const C_CAST_WITH_QUALIFIER_RX = new RegExp(
  `\\(\\s*(?:(?:${C_QUALIFIER_PATTERN})\\s+)+(${C_TYPE_PATTERN})\\s*\\)`,
  "gi"
);

const C_CAST_UNPAREN_RX = new RegExp(
  `\\(\\s*(${C_TYPE_PATTERN})\\s*\\)` +
    `\\s*(?!\\()` +
    `([-+~]?(?:0[xX][\\dA-Fa-f]+|0[bB][01]+|0[oO][0-7]+|(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?|[A-Za-z_]\\w*)(?!\\s*\\())`,
  "gi"
);


function normalizePrimitiveCastSpelling(expr: string): string {
  return expr
    .replace(/\(\s*unsigned\s+int\s*\)/gi, "(unsigned)")
    .replace(/\(\s*signed\s+int\s*\)/gi, "(signed)")
    .replace(/\(\s*long\s+int\s*\)/gi, "(long)")
    .replace(/\(\s*short\s+int\s*\)/gi, "(short)");
}

function preprocessCCastsForEval(expr: string): string {
  let output = normalizePrimitiveCastSpelling(expr).replace(
    C_CAST_WITH_QUALIFIER_RX,
    (_, typeName: string) => `(${typeName})`
  );

  for (let pass = 0; pass < 4; pass += 1) {
    const next = output.replace(
      C_CAST_UNPAREN_RX,
      (_, typeName: string, operand: string) => `(${typeName})(${operand})`
    );

    if (next === output) {
      break;
    }

    output = next;
  }

  return output;
}

/**
 * Evaluates an expression and accepts only finite numeric results.
 * Throws when expression is not reducible to a finite number.
 */
export function safeEval(expr: string, context: EvaluationContext = {}): number {
  const casted = preprocessCCastsForEval(expr);
  const literalSanitized = sanitizeCLiteralsForEval(casted);
  const hasHexLiteral = HEX_LITERAL_DETECT_RX.test(expr);
  const cleaned = preprocessUnsignedBitwiseOps(
    literalSanitized.expression,
    literalSanitized.hasUnsignedIntegerLiteral,
    hasHexLiteral
  );

  const scope = createEvaluationScope(context);
  const scopeKeys = Object.keys(scope);
  const scopeValues = scopeKeys.map((key) => scope[key]);

  // Add eval support for C ==/!= in conditions
  // const conditionExpr = cleaned/*.replace(/==/g, '===').replace(/!=/g, '!==')*/;
  let conditionExpr = cleaned;
  conditionExpr = normalizeHexLiterals(conditionExpr);
  conditionExpr = preprocessSizeofAlignof(conditionExpr);

  const fn = new Function(...scopeKeys, `"use strict"; return (${conditionExpr});`);
  let value = fn(...scopeValues);

  const IS_TERNARY_EXPR = /[?]/.test(expr);
  const IS_BOOLEAN_EXPR =
    !IS_TERNARY_EXPR && (
      LOGICAL_OP_DETECT_RX.test(expr) ||
      RELATIONAL_OP_DETECT_RX.test(expr)
    );

  if (typeof value === "boolean") {
    value = value ? 1 : 0;
  } else if (IS_BOOLEAN_EXPR) {
    value = toFiniteNumber(value) !== 0 ? 1 : 0;
  }

  return value;
}


function normalizeConditionExpression(condition: string | null | undefined): string {
  const trimmed = (condition ?? "").trim();
  if (!trimmed || trimmed === "1" || trimmed.toLowerCase() === "always") {
    return "always";
  }

  return trimmed;
}

function compactConditionExpression(condition: string): string {
  return condition.replace(/\s+/g, "");
}

function stripOuterConditionParens(condition: string): string {
  let output = condition.trim();

  while (output.startsWith("(") && output.endsWith(")")) {
    let depth = 0;
    let wrapsWholeExpression = true;

    for (let i = 0; i < output.length; i += 1) {
      const char = output[i];
      if (char === "(") {
        depth += 1;
        continue;
      }

      if (char === ")") {
        depth -= 1;
        if (depth < 0) {
          wrapsWholeExpression = false;
          break;
        }

        if (depth === 0 && i < output.length - 1) {
          wrapsWholeExpression = false;
          break;
        }
      }
    }

    if (!wrapsWholeExpression || depth !== 0) {
      break;
    }

    output = output.slice(1, -1).trim();
  }

  return output;
}

function splitTopLevelAndConditions(condition: string): string[] {
  const trimmed = condition.trim();
  if (!trimmed) {
    return [];
  }

  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0 && trimmed[i] === "&" && trimmed[i + 1] === "&") {
      const chunk = trimmed.slice(start, i).trim();
      if (chunk.length > 0) {
        parts.push(chunk);
      }

      i += 1;
      start = i + 1;
    }
  }

  const trailing = trimmed.slice(start).trim();
  if (trailing.length > 0) {
    parts.push(trailing);
  }

  return parts.length > 0 ? parts : [trimmed];
}

function negateConditionExpression(condition: string): string {
  const normalized = normalizeConditionExpression(condition);
  if (normalized === "always") {
    return "0";
  }

  if (normalized === "0") {
    return "always";
  }

  const trimmed = normalized.trim();
  if (trimmed.startsWith("!(") && trimmed.endsWith(")")) {
    const inner = trimmed.slice(2, -1).trim();
    return inner || "always";
  }

  return `!(${normalized})`;
}

function mergeConditionExpressions(
  parentCondition: string | null,
  currentCondition: string
): string {
  const normalizedParent = normalizeConditionExpression(parentCondition);
  const normalizedCurrent = normalizeConditionExpression(currentCondition);

  if (normalizedParent === "always") {
    return normalizedCurrent;
  }

  if (normalizedCurrent === "always") {
    return normalizedParent;
  }

  if (normalizedParent === normalizedCurrent) {
    return normalizedParent;
  }

  return `(${normalizedParent}) && (${normalizedCurrent})`;
}

function conditionsCanOverlap(
  leftCondition: string | null,
  rightCondition: string | null
): boolean {
  const normalizedLeft = normalizeConditionExpression(leftCondition);
  const normalizedRight = normalizeConditionExpression(rightCondition);

  if (normalizedLeft === "always" || normalizedRight === "always") {
    return true;
  }

  const compactLeft = compactConditionExpression(normalizedLeft);
  const compactRight = compactConditionExpression(normalizedRight);
  if (!compactLeft || !compactRight) {
    return true;
  }

  if (compactLeft === compactRight) {
    return true;
  }

  const compactLeftNegated = compactConditionExpression(
    negateConditionExpression(normalizedLeft)
  );
  const compactRightNegated = compactConditionExpression(
    negateConditionExpression(normalizedRight)
  );

  if (compactLeft === compactRightNegated || compactRight === compactLeftNegated) {
    return false;
  }

  if (
    compactLeft.includes(`!(${compactRight})`) ||
    compactRight.includes(`!(${compactLeft})`)
  ) {
    return false;
  }

  const leftTerms = splitTopLevelAndConditions(normalizedLeft).map((term) =>
    stripOuterConditionParens(term)
  );
  const rightTerms = splitTopLevelAndConditions(normalizedRight).map((term) =>
    stripOuterConditionParens(term)
  );

  for (const leftTerm of leftTerms) {
    const compactLeftTerm = compactConditionExpression(leftTerm);
    if (!compactLeftTerm) {
      continue;
    }

    const compactLeftTermNegated = compactConditionExpression(
      stripOuterConditionParens(negateConditionExpression(compactLeftTerm))
    );

    for (const rightTerm of rightTerms) {
      const compactRightTerm = compactConditionExpression(rightTerm);
      if (!compactRightTerm) {
        continue;
      }

      const compactRightTermNegated = compactConditionExpression(
        stripOuterConditionParens(negateConditionExpression(compactRightTerm))
      );

      if (
        compactLeftTerm === compactRightTermNegated ||
        compactRightTerm === compactLeftTermNegated ||
        compactLeftTerm.includes(`!(${compactRightTerm})`) ||
        compactRightTerm.includes(`!(${compactLeftTerm})`)
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Replaces identifier tokens with known numeric values.
 * Example: replaceTokens("A+B", {A:2}) -> "2+B"
 */
export function replaceTokens(
  expr: string,
  values: Map<string, number>
): string {
  if (!expr) {
    return expr;
  }

  return replaceIdentifiersOutsideStrings(expr, (token, meta) => {
    if (meta.prevChar === ".") {
      return token;
    }

    if (!values.has(token)) {
      return token;
    }

    return String(values.get(token));
  });
}

/**
 * Recursively resolves one symbol from #define expressions.
 * Example:
 * - defines: A=10, B=A*2
 * - resolveSymbol("B") -> 20
 */
export function resolveSymbol(
  name: string,
  defines: Map<string, string>,
  functionDefines: Map<string, FunctionMacroDefinition>,
  resolved: Map<string, number>,
  symbolValues: Map<string, number>,
  context: EvaluationContext = {},
  stackStats: SymbolResolutionStats = createSymbolResolutionStats(),
  resolving: Set<string> = new Set<string>(),
  defineConditions: Map<string, string> = new Map<string, string>(),
  activeCondition: string | null = null
): number | null {
  if (resolved.has(name)) {
    return resolved.get(name) ?? null;
  }

  if (symbolValues.has(name)) {
    const value = symbolValues.get(name) ?? null;

    if (value != null) {
      resolved.set(name, value);
    }

    return value;
  }

  if (!defines.has(name)) {
    return null;
  }

  const normalizedActiveCondition = normalizeConditionExpression(activeCondition);
  const symbolCondition = normalizeConditionExpression(defineConditions.get(name));

  // Without a concrete preprocessor context, conditional-only symbols are unsafe to
  // resolve numerically because they can pull in mutually-exclusive branches.
  // RELAXATION: Only block if it's explicitly mutually exclusive with the current condition.
  // We allow resolving symbols from other conditions if they don't clash, to be more helpful.
  /*if (symbolCondition !== "always" && normalizedActiveCondition === "always") {
    return null;
  }*/

  if (!conditionsCanOverlap(normalizedActiveCondition, symbolCondition)) {
    return null;
  }

  const nextCondition = mergeConditionExpressions(
    normalizedActiveCondition,
    symbolCondition
  );

  if (resolving.has(name)) {
    stackStats.cycleCount += 1;

    const resolvingChain = Array.from(resolving);
    const cycleStartIndex = resolvingChain.indexOf(name);
    const cycleNodes =
      cycleStartIndex >= 0
        ? resolvingChain.slice(cycleStartIndex)
        : resolvingChain;
    const cycleSample = [...cycleNodes, name].join(" -> ");

    if (
      cycleSample &&
      stackStats.cycleSamples.length <= MAX_CYCLE_SAMPLES &&
      !stackStats.cycleSamples.includes(cycleSample)
    ) {
      if (stackStats.cycleSamples.length < MAX_CYCLE_SAMPLES) {
        stackStats.cycleSamples.push(cycleSample);
      }
      else {
        stackStats.cycleSamples.push("[...]");
      }
    }

    return null;
  }

  if (stackStats.currentDepth >= stackStats.depthLimit) {
    stackStats.depthLimitHits += 1;
    return null;
  }

  resolving.add(name);
  stackStats.currentDepth += 1;
  stackStats.maxDepth = Math.max(stackStats.maxDepth, stackStats.currentDepth);

  const expr = defines.get(name) ?? "";
  try {
    let expanded = expandFunctionLikeMacrosInExpression(
      expr,
      functionDefines,
      symbolValues,
      defines,
      resolved,
      context,
      0,
      stackStats,
      resolving,
      defineConditions,
      nextCondition
    );
    const tokens = expanded.match(TOKEN_RX) ?? [];

    for (const token of tokens) {
      if (token === name) {
        continue;
      }

      const tokenCondition = normalizeConditionExpression(
        defineConditions.get(token)
      );
      if (!conditionsCanOverlap(nextCondition, tokenCondition)) {
        continue;
      }

      const resolvedToken = resolveSymbol(
        token,
        defines,
        functionDefines,
        resolved,
        symbolValues,
        context,
        stackStats,
        resolving,
        defineConditions,
        nextCondition
      );
      if (resolvedToken == null) {
        continue;
      }

      expanded = expanded.replace(
        new RegExp(`\\b${token}\\b`, "g"),
        numericSubstitution(resolvedToken)//String(resolvedToken)
      );
    }

    const value = safeEval(expanded, context);
    resolved.set(name, value);
    symbolValues.set(name, value);
    return value;
  } catch {
    return null;
  } finally {
    stackStats.currentDepth = Math.max(0, stackStats.currentDepth - 1);
    resolving.delete(name);
  }
}

/**
 * Expands every resolvable token in an expression into numeric values.
 * Example: "P + Q" with P=3, Q=4 -> "3 + 4"
 */
export function expandExpression(
  expr: string,
  defines: Map<string, string>,
  functionDefines: Map<string, FunctionMacroDefinition>,
  resolved: Map<string, number>,
  symbolValues: Map<string, number>,
  context: EvaluationContext = {},
  stackStats: SymbolResolutionStats = createSymbolResolutionStats(),
  defineConditions: Map<string, string> = new Map<string, string>(),
  symbolUnits: Map<string, string> = new Map<string, string>()
): string {
  const functionExpanded = expandFunctionLikeMacrosInExpression(
    expr,
    functionDefines,
    symbolValues,
    defines,
    resolved,
    context,
    0,
    stackStats,
    new Set<string>(),
    defineConditions
  );

  return replaceIdentifiersOutsideStrings(functionExpanded, (token, meta) => {
    if (meta.prevChar === ".") {
      return token;
    }

    const value = resolveSymbol(
      token,
      defines,
      functionDefines,
      resolved,
      symbolValues,
      context,
      stackStats,
      new Set<string>(),
      defineConditions
    );
    if (value == null) {
      return token;
    }

    const unit = symbolUnits.get(token);
    return unit ? `${value}[${unit}]` : numericSubstitution(value);//String(value);
  });
}

/**
 * Returns true when expression is already a pure numeric literal.
 * Example: " 42UL " -> true
 */
export function isPureNumericExpression(expr: string): boolean {
  const sanitized = unwrapParens(stripComments(expr));
  return NUM_LITERAL_RX.test(sanitized);
}

const CONTROL_FLOW_RX = /\b(if|while|for|switch|return|do|goto|case|break|continue)\b/;

/**
 * Detects whether expression is composite and worth evaluating for preview.
 * Composite means it contains operators and/or resolvable tokens.
 * We also exclude lines that look like statements (control flow keywords).
 */
export function isCompositeExpression(
  expr: string,
  symbolValues: Map<string, number>,
  allDefines: Map<string, string>,
  functionDefines?: Map<string, FunctionMacroDefinition>
): boolean {
  const sanitized = stripComments(expr).trim();
  if (!sanitized) {
    return false;
  }

  // Exclude non-expression macros (e.g. do {} while(0))
  if (CONTROL_FLOW_RX.test(sanitized)) {
    return false;
  }

  if (isPureNumericExpression(sanitized)) {
    return false;
  }

  if (OP_RX.test(sanitized)) {
    return true;
  }

  // FIX: espressioni puramente bitwise su letterali hex/numerici
  // (es. 0xFF & 0x0F, ~0x0F) non hanno token in symbolValues/allDefines,
  // e OP_RX potrebbe non coprire &, |, ^, ~, <<, >>.
  if (BITWISE_OP_DETECT_RX.test(sanitized)) {
    return true;
  }

  if (RELATIONAL_OP_DETECT_RX.test(sanitized)) {
    return true;
  }

  // Ternary operator (?:)
  if (sanitized.includes("?")) {
    return true;
  }

  // C-style cast operator: (type)value
  if (
    /\(\s*(?:u?int(?:8|16|32|64)(?:_t)?|float|double|char|short|long|unsigned|signed|bool|_Bool)\s*\)/.test(
      sanitized
    )
  ) {
    return true;
  }

  // sizeof / _Alignof
  if (/\bsizeof\b|\b_Alignof\b|\b__alignof__\b/.test(sanitized)) {
    return true;
  }

  const tokens = sanitized.match(TOKEN_RX) ?? [];
  return tokens.some(
    (token) =>
      symbolValues.has(token) ||
      allDefines.has(token) ||
      (functionDefines?.has(token) ?? false)
  );
}

function pickCompositePreviewError(
  errors: unknown[]
): CompositeExpressionPreviewError | null {
  for (const error of errors) {
    const castOverflow = getCastOverflowInfo(error);
    if (!castOverflow) {
      continue;
    }

    return {
      kind: "cast-overflow",
      message: `cast overflow: (${castOverflow.castType}) cannot represent ${castOverflow.truncatedValue} (range ${castOverflow.min}..${castOverflow.max})`,
      overflow: castOverflow,
    };
  }

  return null;
}

function buildUnitAwarePreview(
  expression: string,
  symbolValues: Map<string, number>,
  allDefines: Map<string, string>,
  functionDefines: Map<string, FunctionMacroDefinition>,
  context: EvaluationContext,
  defineConditions: Map<string, string>,
  symbolUnits: Map<string, string>,
  resolvedMap: Map<string, number>,
  stackStats: SymbolResolutionStats
): { displayValue: number; displayUnit: string } | null {
  if (symbolUnits.size === 0) {
    return null;
  }

  const evaluated = evaluateExpression(expression, {
    resolveIdentifier: (identifier: string) => {
      const directValue = symbolValues.get(identifier);
      if (typeof directValue === "number" && Number.isFinite(directValue)) {
        const directQuantity = createQuantity(directValue, symbolUnits.get(identifier));
        return directQuantity.ok ? directQuantity.value : undefined;
      }

      const resolvedValue = resolveSymbol(
        identifier,
        allDefines,
        functionDefines,
        resolvedMap,
        symbolValues,
        context,
        stackStats,
        new Set<string>(),
        defineConditions
      );
      if (typeof resolvedValue !== "number" || !Number.isFinite(resolvedValue)) {
        return undefined;
      }

      const resolvedQuantity = createQuantity(
        resolvedValue,
        symbolUnits.get(identifier)
      );
      return resolvedQuantity.ok ? resolvedQuantity.value : undefined;
    },
    resolveLookup: (functionName, args) =>
      lookupCsvValue(args as unknown[], context.csvTables),
  });
  if (!evaluated.ok) {
    return null;
  }

  const displayUnit = toDisplayUnit(evaluated.quantity);
  if (!displayUnit) {
    return null;
  }

  const normalized = normalizeUnit(toDisplayValue(evaluated.quantity), displayUnit);
  if (!normalized.unit || normalized.unit.trim().length === 0) {
    return null;
  }

  return {
    displayValue: normalized.value,
    displayUnit: normalized.unit,
  };
}

/**
 * Resolves function-like macros and known symbols, then tries to simplify numeric fragments.
 */
export function buildCompositeExpressionPreview(
  expr: string,
  symbolValues: Map<string, number>,
  allDefines: Map<string, string>,
  functionDefines: Map<string, FunctionMacroDefinition> = new Map(),
  context: EvaluationContext = {},
  defineConditions: Map<string, string> = new Map<string, string>(),
  symbolUnits: Map<string, string> = new Map<string, string>()
): CompositeExpressionPreview {
  let expanded = stripComments(expr);
  // ✅ NORMALIZZAZIONE HEX PRIMA DI QUALSIASI SOSTITUZIONE DI IDENTIFICATORI
  // Risolve bug dove 0xFF veniva spezzato in '0' + 'xFF' dal tokenizzatore
  // ✅ IMPORTANTE: manteniamo espressione originale per rilevamento formato numerico
  const numericFormat = detectExpressionNumericFormat(expanded);
  expanded = normalizeHexLiterals(expanded);
  if (CONTROL_FLOW_RX.test(expanded)) {
    return {
      expanded: expr,
      value: null,
      error: { kind: "other", message: "non-expression macro" },
    };
  }
  const resolvedMap = new Map<string, number>();
  const stackStats = createSymbolResolutionStats();

  expanded = expandFunctionLikeMacrosInExpression(
    expanded,
    functionDefines,
    symbolValues,
    allDefines,
    resolvedMap,
    context,
    0,
    stackStats,
    new Set<string>(),
    defineConditions
  );

  // Unit-aware pass runs on macro-expanded text before numeric replacement.
  // This keeps AST parsing independent from presentation suffixes like [A].
  const unitAwareExpanded = resolveInlineLookups(expanded, context);
  const unitAwarePreview = buildUnitAwarePreview(
    unitAwareExpanded,
    symbolValues,
    allDefines,
    functionDefines,
    context,
    defineConditions,
    symbolUnits,
    resolvedMap,
    stackStats
  );

  expanded = replaceIdentifiersOutsideStrings(expanded, (token, meta) => {
    if (meta.prevChar === ".") {
      return token;
    }

    if (symbolValues.has(token)) {
      const val = symbolValues.get(token);
      if (val == null) return token;
      return numericSubstitution(val);
    }


    const value = resolveSymbol(
      token,
      allDefines,
      functionDefines,
      resolvedMap,
      symbolValues,
      context,
      stackStats,
      new Set<string>(),
      defineConditions
    );
    if (value != null) {
      return numericSubstitution(value);//String(value);
    }

    return token;
  });

  expanded = resolveInlineLookups(expanded, context);
  const evaluableExpanded = expanded;
  
  // DEBUG STEPS
  // console.log("STEP 1 - raw input:", expr);
  
  let simplifiedExpanded = simplifyNumericFragments(evaluableExpanded, context);
  // console.log("STEP 2 - after numeric simplification:", simplifiedExpanded);
  
  // DEBUG: Check defines and symbolValues
  // console.log("DEFINES map size:", allDefines.size);
  // console.log("SYMBOLVALUES map size:", symbolValues.size);
  // console.log("RESOLVED map size:", resolvedMap.size);
  
  // After simplification, do a second pass of token replacement for any remaining identifiers
  // This ensures macro names like FINAL are replaced after numeric simplification
  // Example: (FINAL*(2+0.01)) -> (FINAL*2.01) -> (80*2.01)
  const tokens = simplifiedExpanded.match(TOKEN_RX) ?? [];
  // console.log("TOKENS found after simplification:", tokens);

  for (const token of tokens) {
    if (/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+)$/.test(token)) {
      continue;
    }

    // Already in symbolValues? Skip it
    if (symbolValues.has(token)) {
      // console.log(`  Token "${token}" already in symbolValues: ${symbolValues.get(token)}`);
      continue;
    }

    const value =
      symbolValues.get(token) ??
      resolvedMap.get(token) ??
      null;

    // console.log(`  Token "${token}" resolved to:`, value);

    if (value != null) {
      // console.log(`  >> Replacing "${token}" with "${value}"`);
      simplifiedExpanded = replaceIdentifiersOutsideStrings(
        simplifiedExpanded,
        (t) => (t === token ? numericSubstitution(value)/*String(value)*/ : t)
      );
      // console.log(`  >> After replacement:`, simplifiedExpanded);
    }
  }

  // console.log("STEP 3 - after token resolution:", simplifiedExpanded);
  
  // One more simplify pass to clean up numbers
  simplifiedExpanded = simplifyNumericFragments(simplifiedExpanded, context);
  simplifiedExpanded = removeRedundantParens(simplifiedExpanded);
  // console.log("STEP 4 - final simplified:", simplifiedExpanded);
  
  const errors: unknown[] = [];

  try {
    const value = safeEval(evaluableExpanded, context);
    // console.log("EVAL SUCCESS on evaluableExpanded:", value);
    return {
      expanded: unwrapParens(simplifiedExpanded),
      value,
      error: null,
      displayValue: unitAwarePreview?.displayValue,
      displayUnit: unitAwarePreview?.displayUnit,
      numericFormat,
    };
  } catch (error) {
    // console.log("EVAL FAILED on evaluableExpanded:", error);
    errors.push(error);
    try {
      const value = safeEval(simplifiedExpanded, context);
      // console.log("EVAL SUCCESS on simplifiedExpanded:", value);
      return {
        expanded: unwrapParens(simplifiedExpanded),
        value,
        error: null,
        displayValue: unitAwarePreview?.displayValue,
        displayUnit: unitAwarePreview?.displayUnit,
        numericFormat,
      };
    } catch (nextError) {
      // console.log("EVAL FAILED on simplifiedExpanded:", nextError);
      errors.push(nextError);
      return {
        expanded: unwrapParens(simplifiedExpanded),
        value: null,
        error: pickCompositePreviewError(errors),
        displayValue: unitAwarePreview?.displayValue,
        displayUnit: unitAwarePreview?.displayUnit,
        numericFormat,
      };
    }
  }
}

/**
 * Computes numeric value for composite expressions after token resolution.
 * Returns null when unresolved identifiers remain.
 */
export function evaluateCompositeExpression(
  expr: string,
  symbolValues: Map<string, number>,
  allDefines: Map<string, string>,
  functionDefines: Map<string, FunctionMacroDefinition> = new Map(),
  context: EvaluationContext = {},
  defineConditions: Map<string, string> = new Map<string, string>()
): number | null {
  return buildCompositeExpressionPreview(
    expr,
    symbolValues,
    allDefines,
    functionDefines,
    context,
    defineConditions
  ).value;
}
