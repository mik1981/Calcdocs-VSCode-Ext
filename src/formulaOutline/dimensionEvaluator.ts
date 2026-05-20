// dimensionEvaluator.ts

import type { OutlineFormula } from './formulaParser';
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

// -------------------- TOKENIZER --------------------

type Token =
  | { type: 'var'; v: string }
  | { type: 'op'; v: string }
  | { type: 'num' }
  | { type: 'func'; v: string }
  | { type: 'paren'; v: string };

function tokenize(expr: string): Token[] {
  // const regex = /([A-Z_][A-Z0-9_]*)|(sqrt|sin|cos|tan|pow)|(\d+(\.\d+)?)|([+\-*/(),])/gi;
  const regex = /([A-Z_][A-Z0-9_]*)|(csv|lookup|table|sqrt|sin|cos|tan|pow)|(\d+(\.\d+)?)|([+\-*/(),])/gi;

  const tokens: Token[] = [];

  let m;
  while ((m = regex.exec(expr)) !== null) {
    if (m[1]) tokens.push({ type: 'var', v: m[1] });
    else if (m[2]) tokens.push({ type: 'func', v: m[2] });
    else if (m[3]) tokens.push({ type: 'num' });
    else tokens.push({ type: 'op', v: m[5] });
  }

  return tokens;
}

// -------------------- FUNCTION RULES --------------------

function applyFunction(name: string, args: Dim[]): Dim {
  const d = args[0];
  switch (name) {
    case 'sqrt':
      return { M: d.M / 2, L: d.L / 2, T: d.T / 2, I: d.I / 2, K: d.K / 2 };

    case 'pow':
      // pow(x, n) → dimension x^n
      const power = args[1] ? 2 : 1; // fallback
      return { M: d.M * power, L: d.L * power, T: d.T * power, I: d.I * power, K: d.K * power };

    case 'sin':
    case 'cos':
    case 'tan':
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

  const tokens = tokenize(expr);
  const stack: Dim[] = [];
  const ops: string[] = [];

  const getVarDim = (name: string): Dim => {
    const f = formulas.find(f => f.id === name);
    return getUnitDim(f?.unit) ?? ZERO_DIM;
  };

  function applyOp() {
    const b = stack.pop();
    const a = stack.pop();
    const op = ops.pop();

    if (!a || !b || !op) return;

    if (op === '+' || op === '-') {
      if (!sameDim(a, b)) throw new Error('ADD_MISMATCH');
      stack.push(a);
    }

    if (op === '*') stack.push(multiplyDimensions(a, b));
    if (op === '/') stack.push(divideDimensions(a, b));
  }

  try {
    const EXTERNAL_FUNCS = new Set(['csv', 'lookup', 'table']);

    for (const t of tokens) {
      if (t.type === 'var') stack.push(getVarDim(t.v));
      else if (t.type === 'num') stack.push(ZERO_DIM);
      else if (t.type === 'op') {
        while (ops.length) applyOp();
        ops.push(t.v);
      }
      else if (t.type === 'func') {
        if (EXTERNAL_FUNCS.has(t.v.toLowerCase())) {
          const dim = declaredUnit
            ? getUnitDim(declaredUnit)
            : ZERO_DIM;

          stack.push(dim ?? ZERO_DIM);
        } else {
          const arg = stack.pop();
          if (arg) stack.push(applyFunction(t.v, [arg]));
        }
        // const arg = stack.pop();
        // if (!arg) continue;
        // stack.push(applyFunction(t.v, [arg]));
      }
    }

    while (ops.length) applyOp();

    return { dim: stack[0] ?? null };

  } catch (e: any) {
    return { dim: null, error: e.message };
  }
}

// -------------------- DEBUG --------------------

export function dimToString(d: Dim): string {
  return Object.entries(d)
    .filter(([_, v]) => v !== 0)
    .map(([k, v]) => `${k}^${v}`)
    .join(' ') || '1';
}