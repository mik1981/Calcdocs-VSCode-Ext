// dimensionEvaluator.ts

import type { OutlineFormula } from './formulaParser';
import { parseExpression, type ExpressionNode } from '../engine/ast';
import { preprocessExpression } from '../engine/evaluator';
import { isLookupFunctionName } from '../engine/mathScope';
import {
  type DimensionVector as Dim,
  dimensionsEqual as sameDim,
  addDimensions as addDim,
  subtractDimensions as subDim,
  multiplyDimensions,
  divideDimensions,
  getUnitSpec,
  parseUnitToQuantity,
} from '../engine/units';

// -------------------- DIM TYPE --------------------

export { type Dim };

export const ZERO_DIM: Dim = { M:0, L:0, T:0, I:0, K:0 };

// -------------------- UNIT → DIM --------------------

export function getUnitDim(unit?: string): Dim | null {
  if (!unit) return null;
  // Prova prima come token atomico (es. "A", "V", "Ohm")
  const spec = getUnitSpec(unit);
  if (spec) return spec.dimension;

  // Fallback: prova come espressione di unità composta (es. "A^2", "A*V", "N/m")
  const parsed = parseUnitToQuantity(unit);
  if (parsed.ok) return parsed.value.dimension;

  return null;
}

// -------------------- C SYMBOL DIM PROPAGATION --------------------

export type CSymbolDimMap = Map<string, Dim>;

export function buildCSymbolDimTable(
  formulas: OutlineFormula[]
): CSymbolDimMap {

  const map = new Map<string, Dim>();

  for (const f of formulas) {
    const dim = getUnitDim(f.unit);
    if (dim) map.set(f.id, dim);
  }

  return map;
}

// -------------------- FUNCTION RULES --------------------

function applyFunction(name: string, args: Dim[]): Dim {
  const d = args[0] ?? ZERO_DIM;
  switch (name) {
    case 'abs':
    case 'ass':
    case 'fabs':
    case 'int':
    case 'integer':
    case 'ceil':
    case 'floor':
    case 'round':
    case 'trunc':
    case 'min':
    case 'max':
    case 'hypot':
      return d;

    case 'sqrt':
      return { M: d.M / 2, L: d.L / 2, T: d.T / 2, I: d.I / 2, K: d.K / 2 };

    case 'pow':
    case 'power':
      // pow(x, n) → dimension x^n
      const power = args[1] ? 2 : 1; // fallback
      return { M: d.M * power, L: d.L * power, T: d.T * power, I: d.I * power, K: d.K * power };

    case 'sin':
    case 'cos':
    case 'tan':
    case 'asin':
    case 'acos':
    case 'atan':
    case 'atan2':
    case 'ln':
    case 'log':
    case 'log10':
    case 'log2':
    case 'exp':
    case 'sign':
      return ZERO_DIM;

    default:
      return ZERO_DIM;
  }
}

// -------------------- INFERENCE ENGINE --------------------

export function inferDimension(
  expr: string,
  formulas: OutlineFormula[],
  declaredUnit?: string
): { dim: Dim | null; error?: string } {
  try {
    const ast = parseExpression(preprocessExpression(expr));
    return { dim: inferNodeDimension(ast, formulas, declaredUnit) };

  } catch (e: any) {
    return { dim: null, error: e.message };
  }
}

function inferNodeDimension(
  node: ExpressionNode,
  formulas: OutlineFormula[],
  declaredUnit?: string
): Dim {
  const getVarDim = (name: string): Dim => {
    const f = formulas.find(f => f.id === name);
    return getUnitDim(f?.unit) ?? ZERO_DIM;
  };

  switch (node.kind) {
    case "number":
    case "string":
      return ZERO_DIM;
    case "identifier":
      return getVarDim(node.name);
    case "unary":
      return inferNodeDimension(node.argument, formulas, declaredUnit);
    case "index":
      if (node.target.kind === "identifier") {
        return getVarDim(node.target.name);
      }
      return ZERO_DIM;
    case "binary": {
      const left = inferNodeDimension(node.left, formulas, declaredUnit);
      const right = inferNodeDimension(node.right, formulas, declaredUnit);

      if (node.operator === "+" || node.operator === "-" || node.operator === "%") {
        if (!sameDim(left, right) && !(node.operator === "%" && sameDim(right, ZERO_DIM))) {
          throw new Error("ADD_MISMATCH");
        }
        return left;
      }

      if (node.operator === "*") {
        return multiplyDimensions(left, right);
      }

      if (node.operator === "/") {
        return divideDimensions(left, right);
      }

      if (node.operator === "^") {
        const exponent = numericLiteralValue(node.right) ?? 1;
        return scaleDim(left, exponent);
      }

      return ZERO_DIM;
    }
    case "call": {
      const normalized = node.callee.toLowerCase();
      if (isLookupFunctionName(normalized)) {
        return declaredUnit ? getUnitDim(declaredUnit) ?? ZERO_DIM : ZERO_DIM;
      }

      const formula = formulas.find((item) => item.id === node.callee);
      if (formula) {
        return getUnitDim(formula.unit) ?? ZERO_DIM;
      }

      const args = node.args.map((arg) => inferNodeDimension(arg, formulas, declaredUnit));
      return applyFunction(normalized, args);
    }
  }
}

function numericLiteralValue(node: ExpressionNode): number | undefined {
  if (node.kind === "number") {
    return node.value;
  }

  if (node.kind === "unary") {
    const value = numericLiteralValue(node.argument);
    return value === undefined ? undefined : node.operator === "-" ? -value : value;
  }

  return undefined;
}

function scaleDim(d: Dim, factor: number): Dim {
  return { M: d.M * factor, L: d.L * factor, T: d.T * factor, I: d.I * factor, K: d.K * factor };
}

// -------------------- EXTERNAL DIMENSION EVALUATION --------------------

/**
 * Evaluate the dimension of an expression given a pre-built map of symbol → dimension.
 * This is used by parametricAnalysis.ts to test hypothetical unit assignments.
 */
export function evaluateExpressionDimensions(
  expr: string,
  dimMap: Map<string, Dim>
): { dimension: Dim | null; error?: string } {
  try {
    const ast = parseExpression(preprocessExpression(expr));
    return { dimension: inferNodeDimensionWithMap(ast, dimMap) };
  } catch (e: any) {
    return { dimension: null, error: e.message };
  }
}

function inferNodeDimensionWithMap(
  node: ExpressionNode,
  dimMap: Map<string, Dim>
): Dim {
  switch (node.kind) {
    case "number":
    case "string":
      return ZERO_DIM;
    case "identifier":
      return dimMap.get(node.name) ?? ZERO_DIM;
    case "unary":
      return inferNodeDimensionWithMap(node.argument, dimMap);
    case "index":
      if (node.target.kind === "identifier") {
        return dimMap.get(node.target.name) ?? ZERO_DIM;
      }
      return ZERO_DIM;
    case "binary": {
      const left = inferNodeDimensionWithMap(node.left, dimMap);
      const right = inferNodeDimensionWithMap(node.right, dimMap);

      if (node.operator === "+" || node.operator === "-" || node.operator === "%") {
        if (!sameDim(left, right) && !(node.operator === "%" && sameDim(right, ZERO_DIM))) {
          throw new Error("ADD_MISMATCH");
        }
        return left;
      }

      if (node.operator === "*") {
        return multiplyDimensions(left, right);
      }

      if (node.operator === "/") {
        return divideDimensions(left, right);
      }

      if (node.operator === "^") {
        const exponent = numericLiteralValue(node.right) ?? 1;
        return scaleDim(left, exponent);
      }

      return ZERO_DIM;
    }
    case "call": {
      const normalized = node.callee.toLowerCase();

      // preprocessExpression() rewrites quantity literals like "1.25V" into
      // __unit(1.25, "V") before this AST is built (see engine/evaluator.ts).
      // Without this case, the generic call-handling below infers ZERO_DIM
      // for both arguments (a number and a string literal are always
      // dimensionless on their own), silently discarding the very unit the
      // author wrote - causing false ADD_MISMATCH errors when that literal
      // is combined with a properly-dimensioned quantity elsewhere in the
      // same formula. This is the fix for that: honor the declared unit.
      if (normalized === "__unit") {
        const unitArg = node.args[1];
        const unitToken = unitArg && unitArg.kind === "string" ? unitArg.value : undefined;
        const dim = getUnitDim(unitToken);
        return dim ?? ZERO_DIM;
      }

      if (isLookupFunctionName(normalized)) {
        return ZERO_DIM;
      }

      const args = node.args.map((arg) => inferNodeDimensionWithMap(arg, dimMap));
      return applyFunction(normalized, args);
    }
  }
}

// -------------------- DEBUG --------------------

export function dimToString(d: Dim): string {
  return Object.entries(d)
    .filter(([_, v]) => v !== 0)
    .map(([k, v]) => `${k}^${v}`)
    .join(' ') || '1';
}
