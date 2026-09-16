/**
 * Identifier token: C-like symbol names used in formulas and C/C++ defines.
 */
export const TOKEN_RX = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * #define NAME EXPR matcher (single-line expression).
 */
export const DEFINE_RX = /^\s*#define\s+([A-Za-z_]\w*)(.*)$/;
  // /^\s*#define\s+([A-Za-z_]\w*)\s+([^\r\n]+?)\s*$/;

/**
 * const TYPE NAME = EXPR matcher used for numeric extraction.
 */
const CONST_RX =
  /\b(?:static\s+)?const\s+(?:unsigned\s+)?(?:long|int|short|char|float|double|uint\d*_t|int\d*_t)\s+([A-Za-z_]\w*)\s*=\s*([^;]+)/g;

/**
 * Numeric literal matcher with decimal/hex/bin/octal and common C suffixes.
 */
export const NUM_LITERAL_RX =
  /^\s*(?:[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?|0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+)\s*(?:ul|lu|ull|llu|u|l|ll|f)?\s*$/;

/**
 * Operator presence check for quick composite-expression detection.
 */
// export const OP_RX = /[+\-*/%&|^~<>?:()]/;
export const OP_RX = /(\+|\-|\*|\/|%|&|\||\^|~|<<|>>)/;

/**
 * File extensions considered C/C++ sources for analysis.
 */
export const SRC_EXTS = new Set([".c", ".h", ".cpp", ".hpp", ".cc", ".hh"]);

/** Detect function-like macro definitions */
export const FUNCTION_DEFINE_RX = /^\s*#\s*define\s+([A-Za-z_]\w*)\s*\(/;

/** Detect object-like macro definitions */
export const OBJECT_DEFINE_RX = /^\s*#\s*define\s+([A-Za-z_]\w*)\b(?!\s*\()/;

export const DEFINE_NAME_RX = /^\s*#\s*define\s+([A-Za-z_]\w*)/;
