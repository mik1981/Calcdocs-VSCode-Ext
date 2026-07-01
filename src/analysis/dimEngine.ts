/**
 * dimEngine.ts
 *
 * Dimensional vector propagation engine.
 *
 * Derives dimensional vectors (M, L, T, I, K) from formula expressions
 * using the existing dependency graph. Does NOT modify the parser or AST.
 *
 * Key design decisions:
 * - Operates on parsed formula strings (OutlineFormula.expr) only
 * - Reuses the existing DimensionVector type from engine/units
 * - Pure deterministic computation — no heuristics or ML
 */

import type { DimensionVector } from "../engine/units";
import {
  DIMENSIONLESS,
  dimensionsEqual,
  multiplyDimensions,
  divideDimensions,
} from "../engine/units";
import type { DimResult, DimCacheEntry } from "./dimTypes";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Sentinel for unknown dimensions */
const UNKNOWN_DIM: DimensionVector = {
  M: Number.NaN,
  L: Number.NaN,
  T: Number.NaN,
  I: Number.NaN,
  K: Number.NaN,
};

function isUnknownDim(v: DimensionVector): boolean {
  return Number.isNaN(v.M);
}

// ---------------------------------------------------------------------------
// Expression tokenizer for dimensional analysis
// ---------------------------------------------------------------------------

/**
 * Simple token types for dimensional expression analysis.
 */
const enum DimTokenType {
  Number,
  Identifier,
  Plus,
  Minus,
  Star,
  Slash,
  Caret,
  LParen,
  RParen,
  Comma,
  Unknown,
}

interface DimToken {
  type: DimTokenType;
  value: string;
}

/**
 * Minimal tokenizer for dimensional analysis.
 */
function tokenizeForDim(expr: string): DimToken[] {
  const tokens: DimToken[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];

    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }

    if (ch === "+") { tokens.push({ type: DimTokenType.Plus, value: "+" }); i++; continue; }
    if (ch === "-") { tokens.push({ type: DimTokenType.Minus, value: "-" }); i++; continue; }
    if (ch === "*") { tokens.push({ type: DimTokenType.Star, value: "*" }); i++; continue; }
    if (ch === "/") { tokens.push({ type: DimTokenType.Slash, value: "/" }); i++; continue; }
    if (ch === "^") { tokens.push({ type: DimTokenType.Caret, value: "^" }); i++; continue; }
    if (ch === "(") { tokens.push({ type: DimTokenType.LParen, value: "(" }); i++; continue; }
    if (ch === ")") { tokens.push({ type: DimTokenType.RParen, value: ")" }); i++; continue; }
    if (ch === ",") { tokens.push({ type: DimTokenType.Comma, value: "," }); i++; continue; }

    if (/[0-9.]/.test(ch)) {
      let num = "";
      while (i < expr.length && /[0-9.eExXoObBa-fA-F]/.test(expr[i])) {
        num += expr[i];
        i++;
      }
      tokens.push({ type: DimTokenType.Number, value: num });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let id = "";
      while (i < expr.length && /[A-Za-z0-9_]/.test(expr[i])) {
        id += expr[i];
        i++;
      }
      tokens.push({ type: DimTokenType.Identifier, value: id });
      continue;
    }

    i++;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Shunting-yard to RPN for dimension evaluation
// ---------------------------------------------------------------------------

const enum RpnTokenType {
  Value,
  Ident,
  BinOp,
  UnaryOp,
  Call,
}

type RpnToken =
  | { type: RpnTokenType.Value; dim: DimensionVector }
  | { type: RpnTokenType.Ident; name: string }
  | { type: RpnTokenType.BinOp; name: string }
  | { type: RpnTokenType.UnaryOp; name: string }
  | { type: RpnTokenType.Call; name: string; argCount: number };

/**
 * Evaluate dimensions using RPN.
 */
function evaluateRpn(
  rpn: RpnToken[],
  resolveIdentifier: (name: string) => DimResult
): DimResult {
  const stack: DimensionVector[] = [];

  for (const token of rpn) {
    switch (token.type) {
      case RpnTokenType.Value: {
        stack.push(token.dim);
        break;
      }
      case RpnTokenType.Ident: {
        const resolved = resolveIdentifier(token.name);
        if (resolved.status !== "ok") return resolved;
        stack.push(resolved.vector);
        break;
      }
      case RpnTokenType.UnaryOp: {
        const a = stack.pop();
        if (!a) return { status: "invalid_dimension", error: "stack underflow" };
        stack.push({ M: a.M, L: a.L, T: a.T, I: a.I, K: a.K });
        break;
      }
      case RpnTokenType.BinOp: {
        const b = stack.pop();
        const a = stack.pop();
        if (!a || !b) return { status: "invalid_dimension", error: "stack underflow" };

        switch (token.name) {
          case "+":
          case "-": {
            if (!dimensionsEqual(a, b)) {
              return { status: "invalid_dimension", error: "incompatible dimensions" };
            }
            stack.push({ M: a.M, L: a.L, T: a.T, I: a.I, K: a.K });
            break;
          }
          case "*": {
            stack.push(multiplyDimensions(a, b));
            break;
          }
          case "/": {
            stack.push(divideDimensions(a, b));
            break;
          }
          default:
            return { status: "invalid_dimension", error: `unknown op: ${token.name}` };
        }
        break;
      }
      case RpnTokenType.Call: {
        const args: DimensionVector[] = [];
        for (let i = 0; i < token.argCount; i++) {
          const arg = stack.pop();
          if (!arg) return { status: "invalid_dimension", error: "stack underflow" };
          args.push(arg);
        }
        const result = applyKnownFunctionDim(token.name, args);
        if (result.status !== "ok") return result;
        stack.push(result.vector);
        break;
      }
    }
  }

  if (stack.length !== 1) {
    return { status: "invalid_dimension", error: `stack has ${stack.length} items` };
  }

  return { status: "ok", vector: stack[0] };
}

// ---------------------------------------------------------------------------
// Known function dimension mapping
// ---------------------------------------------------------------------------

function applyKnownFunctionDim(
  name: string,
  args: DimensionVector[]
): DimResult {
  const lower = name.toLowerCase();

  const dimensionlessFns = new Set([
    "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
    "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
    "exp", "log", "log10", "log2", "log1p", "expm1",
    "erf", "erfc", "tgamma", "lgamma", "sign", "signum",
  ]);

  if (dimensionlessFns.has(lower)) {
    return { status: "ok", vector: DIMENSIONLESS };
  }

  const preserveFns = new Set([
    "abs", "floor", "ceil", "round", "trunc", "fract", "neg",
  ]);

  if (preserveFns.has(lower)) {
    if (args.length < 1) return { status: "ok", vector: DIMENSIONLESS };
    return { status: "ok", vector: args[0] };
  }

  if (lower === "sqrt") {
    if (args.length < 1) return { status: "ok", vector: DIMENSIONLESS };
    const v = args[0];
    return {
      status: "ok",
      vector: { M: v.M/2, L: v.L/2, T: v.T/2, I: v.I/2, K: v.K/2 },
    };
  }

  if (lower === "cbrt") {
    if (args.length < 1) return { status: "ok", vector: DIMENSIONLESS };
    const v = args[0];
    return {
      status: "ok",
      vector: { M: v.M/3, L: v.L/3, T: v.T/3, I: v.I/3, K: v.K/3 },
    };
  }

  if (lower === "pow") {
    if (args.length < 2) return { status: "ok", vector: DIMENSIONLESS };
    return { status: "unknown", vector: DIMENSIONLESS };
  }

  if (lower === "min" || lower === "max") {
    if (args.length < 1) return { status: "ok", vector: DIMENSIONLESS };
    const first = args[0];
    for (let i = 1; i < args.length; i++) {
      if (!dimensionsEqual(first, args[i])) {
        return { status: "invalid_dimension", error: `incompatible dimensions in ${name}()` };
      }
    }
    return { status: "ok", vector: first };
  }

  if (lower === "clamp") {
    if (args.length < 1) return { status: "ok", vector: DIMENSIONLESS };
    return { status: "ok", vector: args[0] };
  }

  if (lower === "csv" || lower === "table" || lower === "lookup") {
    return { status: "unknown", vector: DIMENSIONLESS };
  }

  return { status: "unknown", vector: DIMENSIONLESS };
}

// ---------------------------------------------------------------------------
// Expression parser for dimensional analysis
// ---------------------------------------------------------------------------

function opPrecedence(op: string): number {
  switch (op) {
    case "+":
    case "-": return 1;
    case "*":
    case "/": return 2;
    case "^": return 4;
    default: return 0;
  }
}

function tokensToRpn(tokens: DimToken[]): RpnToken[] | { error: string } {
  const output: RpnToken[] = [];
  const opStack: any[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    switch (token.type) {
      case DimTokenType.Number: {
        output.push({ type: RpnTokenType.Value, dim: DIMENSIONLESS });
        i++;
        break;
      }
      case DimTokenType.Identifier: {
        if (i + 1 < tokens.length && tokens[i + 1].type === DimTokenType.LParen) {
          opStack.push({ type: DimTokenType.Identifier, value: token.value, argCount: 0 });
          i += 2;
        } else {
          output.push({ type: RpnTokenType.Ident, name: token.value });
          i++;
        }
        break;
      }
      case DimTokenType.LParen: {
        opStack.push(token);
        i++;
        break;
      }
      case DimTokenType.RParen: {
        while (opStack.length > 0) {
          const top = opStack.pop()!;
          if (top.type === DimTokenType.LParen) {
            if (opStack.length > 0 && opStack[opStack.length-1]?.type === DimTokenType.Identifier) {
              const fn = opStack.pop()!;
              output.push({ type: RpnTokenType.Call, name: fn.value, argCount: fn.argCount ?? 0 });
            }
            break;
          }
          if ([DimTokenType.Star, DimTokenType.Slash, DimTokenType.Plus, DimTokenType.Minus, DimTokenType.Caret].includes(top.type)) {
            output.push({ type: RpnTokenType.BinOp, name: top.value });
          }
        }
        i++;
        break;
      }
      case DimTokenType.Comma: {
        while (opStack.length > 0 && opStack[opStack.length-1]?.type !== DimTokenType.LParen) {
          const top = opStack.pop()!;
          if ([DimTokenType.Star, DimTokenType.Slash, DimTokenType.Plus, DimTokenType.Minus, DimTokenType.Caret].includes(top.type)) {
            output.push({ type: RpnTokenType.BinOp, name: top.value });
          }
        }
        for (let j = opStack.length - 1; j >= 0; j--) {
          if (opStack[j].type === DimTokenType.Identifier) {
            opStack[j].argCount = (opStack[j].argCount ?? 0) + 1;
            break;
          }
        }
        i++;
        break;
      }
      case DimTokenType.Plus:
      case DimTokenType.Minus: {
        const isUnary = output.length === 0 || i === 0 ||
          [DimTokenType.LParen, DimTokenType.Comma, DimTokenType.Star, DimTokenType.Slash, DimTokenType.Caret, DimTokenType.Plus, DimTokenType.Minus].includes(tokens[i-1]?.type);

        if (isUnary) {
          opStack.push({ type: DimTokenType.Identifier, value: token.type === DimTokenType.Minus ? "u-" : "u+" });
        } else {
          while (opStack.length > 0 && opStack[opStack.length-1]?.type !== DimTokenType.LParen) {
            const top = opStack[opStack.length-1];
            if ([DimTokenType.Star, DimTokenType.Slash, DimTokenType.Plus, DimTokenType.Minus, DimTokenType.Caret].includes(top.type)) {
              if (opPrecedence(top.value) >= opPrecedence(token.value)) {
                opStack.pop();
                output.push({ type: RpnTokenType.BinOp, name: top.value });
              } else break;
            } else break;
          }
          opStack.push(token);
        }
        i++;
        break;
      }
      case DimTokenType.Star:
      case DimTokenType.Slash:
      case DimTokenType.Caret: {
        while (opStack.length > 0 && opStack[opStack.length-1]?.type !== DimTokenType.LParen) {
          const top = opStack[opStack.length-1];
          if ([DimTokenType.Star, DimTokenType.Slash, DimTokenType.Plus, DimTokenType.Minus, DimTokenType.Caret].includes(top.type)) {
            if ((token.type !== DimTokenType.Caret || opPrecedence(top.value) > opPrecedence(token.value)) &&
                opPrecedence(top.value) >= opPrecedence(token.value)) {
              opStack.pop();
              output.push({ type: RpnTokenType.BinOp, name: top.value });
            } else break;
          } else break;
        }
        opStack.push(token);
        i++;
        break;
      }
      default: i++; break;
    }
  }

  while (opStack.length > 0) {
    const top = opStack.pop()!;
    if (top.type === DimTokenType.LParen) continue;
    if ([DimTokenType.Star, DimTokenType.Slash, DimTokenType.Plus, DimTokenType.Minus, DimTokenType.Caret].includes(top.type)) {
      output.push({ type: RpnTokenType.BinOp, name: top.value });
    } else if (top.type === DimTokenType.Identifier && top.argCount !== undefined) {
      output.push({ type: RpnTokenType.Call, name: top.value, argCount: top.argCount });
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function formatDim(v: DimensionVector): string {
  const parts: string[] = [];
  if (v.M !== 0) parts.push(`M^${v.M}`);
  if (v.L !== 0) parts.push(`L^${v.L}`);
  if (v.T !== 0) parts.push(`T^${v.T}`);
  if (v.I !== 0) parts.push(`I^${v.I}`);
  if (v.K !== 0) parts.push(`K^${v.K}`);
  return parts.length === 0 ? "dimensionless" : parts.join("·");
}

/**
 * Compute the dimensional vector for a formula expression.
 */
export function computeExpressionDim(
  expr: string,
  resolveIdent: (name: string) => DimResult
): DimResult {
  if (!expr || expr.trim().length === 0) {
    return { status: "ok", vector: DIMENSIONLESS };
  }

  const tokens = tokenizeForDim(expr);
  if (tokens.length === 0) {
    return { status: "ok", vector: DIMENSIONLESS };
  }

  const rpn = tokensToRpn(tokens);
  if ("error" in rpn) {
    return { status: "invalid_dimension", error: rpn.error };
  }

  return evaluateRpn(rpn, resolveIdent);
}

/**
 * Check if two dimensional vectors are compatible for addition.
 */
export function areAdditionCompatible(a: DimensionVector, b: DimensionVector): boolean {
  return dimensionsEqual(a, b);
}

/**
 * Stub: unit-based dimension lookup moved to siResolver.
 */
export function getUnitDim(unit?: string): DimensionVector | null {
  return null;
}