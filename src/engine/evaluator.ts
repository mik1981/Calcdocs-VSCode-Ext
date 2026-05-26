import {
  type BinaryExpressionNode,
  type ExpressionNode,
  mapExpression,
  parseExpression,
  printExpression,
} from "./ast";
import { formatNumberToSigFigs } from "../utils/nformat";
import {
  addQuantities,
  applyOutputUnit,
  createDimensionlessQuantity,
  createQuantity,
  divideQuantities,
  formatDimension,
  getUnitSpec,
  isDimensionless,
  multiplyQuantities,
  negateQuantity,
  subtractQuantities,
  toDisplayValue,
  type Quantity,
  type UnitResult,
} from "./units";

type RuntimeValue =
  | {
      kind: "quantity";
      quantity: Quantity;
    }
  | {
      kind: "string";
      value: string;
    };

export type PrimitiveArgument = number | string;

export type EvaluationContext = {
  resolveIdentifier: (name: string) => Quantity | undefined;
  resolveLookup?: (functionName: string, args: PrimitiveArgument[]) => number | Quantity;
  ignoreUnitCompatibility?: boolean;
  onWarning?: (message: string) => void;
};

export type EvaluationResult =
  | { ok: true; quantity: Quantity }
  | { ok: false; error: string };

const QUANTITY_LITERAL_RX =
  /(?<![A-Za-z0-9_.$])([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)\s+([A-Za-z%][A-Za-z0-9_%]*)/g;

/**
 * Tenta di decomporre un token unità sconosciuto come "A2" in "A^2".
 * Cerca un prefisso di unità base seguito da un esponente numerico.
 * Esempi: "A2" → "A^2", "mA2" → "mA^2", "V2" → "V^2"
 * Non decompone unità già definite come "m2", "in2", ecc.
 */
function decomposeUnit(rawUnit: string): string | undefined {
  // Cerca un pattern: base unit (lettere) + esponente (numeri), es. "A2", "V3"
  // Deve finire con cifre, e la parte letterale deve essere un'unità valida
  const match = rawUnit.match(/^([A-Za-z%][A-Za-z%]*?)(\d+)$/);
  if (!match) return undefined;

  const base = match[1];
  const exponent = match[2];

  // Verifica che la base sia un'unità valida
  if (!getUnitSpec(base)) return undefined;

  return `${base}^${exponent}`;
}

export function preprocessExpression(expression: string): string {
  // 1. Literal numerici: "5 mA" -> "__unit(5, 'mA')"
  let processed = expression.replace(
    QUANTITY_LITERAL_RX,
    (full: string, rawValue: string, rawUnit: string) => {
      const spec = getUnitSpec(rawUnit);
      if (spec) {
        return `__unit(${rawValue}, ${JSON.stringify(rawUnit)})`;
      }

      // Unità non riconosciuta: prova a decomporre, es. "A2" → "A^2"
      const decomposed = decomposeUnit(rawUnit);
      if (decomposed) {
        return `__unit(${rawValue}, ${JSON.stringify(decomposed)})`;
      }

      return full;
    }
  );

  // 2. Parentesi o chiamate a funzione con unità: "(1+2) V" -> "__unit((1+2), 'V')" o "csv(...) ohm" -> "__unit(csv(...), 'ohm')"
  // Cerchiamo ") [unit]" dove [unit] è un'unità valida.
  const COMPLEX_UNIT_RX = /\)\s*([A-Za-z%][A-Za-z0-9_%]*)/g;
  let match: RegExpExecArray | null;

  // Usiamo un ciclo per processare tutte le occorrenze, partendo dal fondo per non sfasare gli indici 
  // o semplicemente ricostruendo la stringa.
  // Dato che le sostituzioni possono sovrapporsi, facciamo un approccio più semplice:
  // cerchiamo il pattern e se lo troviamo, cerchiamo la parentesi aperta corrispondente.
  
  // Per evitare loop infiniti o problemi con sostituzioni multiple, usiamo un approccio di scansione 
  // che sostituisce le occorrenze in modo sicuro.
  
  let result = processed;
  let offset = 0;
  
  // Reset regex state
  COMPLEX_UNIT_RX.lastIndex = 0;
  
  while ((match = COMPLEX_UNIT_RX.exec(result)) !== null) {
    const unitToken = match[1];
    let effectiveUnit: string | undefined;

    const spec = getUnitSpec(unitToken);
    if (spec) {
      effectiveUnit = unitToken;
    } else {
      // Prova a decomporre, es. ") A2" → ") A^2"
      effectiveUnit = decomposeUnit(unitToken);
    }

    if (!effectiveUnit) {
      continue;
    }

    const closeParenIndex = match.index;
    const unitStart = match.index + 1;
    const unitEnd = match.index + match[0].length;

    // Troviamo la parentesi aperta corrispondente camminando a ritroso
    let depth = 0;
    let openParenIndex = -1;
    for (let i = closeParenIndex; i >= 0; i--) {
      if (result[i] === ')') depth++;
      else if (result[i] === '(') {
        depth--;
        if (depth === 0) {
          openParenIndex = i;
          break;
        }
      }
    }

    if (openParenIndex !== -1) {
      // Se prima della parentesi aperta c'è un identificatore (chiamata a funzione), includiamolo
      let startIndex = openParenIndex;
      while (startIndex > 0 && /[A-Za-z0-9_]/.test(result[startIndex - 1])) {
        startIndex--;
      }

      const expressionToWrap = result.slice(startIndex, closeParenIndex + 1);
      const replacement = `__unit(${expressionToWrap}, ${JSON.stringify(effectiveUnit)})`;
      
      const before = result.slice(0, startIndex);
      const after = result.slice(unitEnd);
      
      result = before + replacement + after;
      
      // Riposizioniamo lastIndex dato che la stringa è cambiata
      COMPLEX_UNIT_RX.lastIndex = before.length + replacement.length;
    }
  }

  return result;
}

function toQuantity(value: RuntimeValue, contextMessage: string): UnitResult<Quantity> {
  if (value.kind !== "quantity") {
    return {
      ok: false,
      error: `${contextMessage} expects numeric value`,
    };
  }

  return {
    ok: true,
    value: value.quantity,
  };
}

function quantityToPrimitive(quantity: Quantity): number {
  return toDisplayValue(quantity);
}

function runtimeToPrimitive(value: RuntimeValue): UnitResult<PrimitiveArgument> {
  if (value.kind === "string") {
    return {
      ok: true,
      value: value.value,
    };
  }

  return {
    ok: true,
    value: quantityToPrimitive(value.quantity),
  };
}

function evaluateCall(
  callee: string,
  args: RuntimeValue[],
  context: EvaluationContext
): UnitResult<RuntimeValue> {
  const normalized = callee.trim().toLowerCase();

  if (normalized === "abs") {
    if (args.length !== 1) {
      return {
        ok: false,
        error: "abs() expects one argument",
      };
    }

    const argument = toQuantity(args[0], "abs()");
    if (!argument.ok) {
      return argument;
    }

    return {
      ok: true,
      value: {
        kind: "quantity",
        quantity: {
          ...argument.value,
          valueSi: Math.abs(argument.value.valueSi),
        },
      },
    };
  }

  if (normalized === "sin" || normalized === "cos") {
    if (args.length !== 1) {
      return {
        ok: false,
        error: `${normalized}() expects one argument`,
      };
    }

    const argument = toQuantity(args[0], `${normalized}()`);
    if (!argument.ok) {
      return argument;
    }

    if (!isDimensionless(argument.value.dimension)) {
      return {
        ok: false,
        error: `${normalized}() requires a dimensionless argument`,
      };
    }

    const numeric = quantityToPrimitive(argument.value);
    const computed = normalized === "sin" ? Math.sin(numeric) : Math.cos(numeric);
    if (!Number.isFinite(computed)) {
      return {
        ok: false,
        error: `${normalized}() returned non-finite value`,
      };
    }

    return {
      ok: true,
      value: {
        kind: "quantity",
        quantity: createDimensionlessQuantity(computed),
      },
    };
  }

  if (normalized === "csv" || normalized === "lookup" || normalized === "table") {
    if (!context.resolveLookup) {
      return {
        ok: false,
        error: `${normalized}() is not available in this context`,
      };
    }

    const primitiveArgs: PrimitiveArgument[] = [];
    for (const arg of args) {
      const primitive = runtimeToPrimitive(arg);
      if (!primitive.ok) {
        return primitive;
      }

      primitiveArgs.push(primitive.value);
    }

    const lookupValue = context.resolveLookup(normalized, primitiveArgs);

    if (typeof lookupValue === "object" && lookupValue !== null && "valueSi" in lookupValue) {
      return {
        ok: true,
        value: {
          kind: "quantity",
          quantity: lookupValue as Quantity,
        },
      };
    }

    if (typeof lookupValue !== "number" || !Number.isFinite(lookupValue)) {
      return {
        ok: false,
        error: `${normalized}() returned non-finite value`,
      };
    }

    return {
      ok: true,
      value: {
        kind: "quantity",
        quantity: createDimensionlessQuantity(lookupValue),
      },
    };
  }

  if (normalized === "__unit") {
    if (args.length !== 2) {
      return {
        ok: false,
        error: "__unit() expects value and unit arguments",
      };
    }

    const valueArg = runtimeToPrimitive(args[0]);
    if (!valueArg.ok || typeof valueArg.value !== "number") {
      return {
        ok: false,
        error: "__unit() requires numeric value as first argument",
      };
    }

    const unitArg = runtimeToPrimitive(args[1]);
    if (!unitArg.ok || typeof unitArg.value !== "string") {
      return {
        ok: false,
        error: "__unit() requires unit string as second argument",
      };
    }

    const quantity = createQuantity(valueArg.value, unitArg.value);
    if (!quantity.ok) {
      return {
        ok: false,
        error: quantity.error,
      };
    }

    return {
      ok: true,
      value: {
        kind: "quantity",
        quantity: quantity.value,
      },
    };
  }

  return {
    ok: false,
    error: `unsupported function '${callee}'`,
  };
}

function evaluateBinary(
  node: BinaryExpressionNode,
  leftValue: RuntimeValue,
  rightValue: RuntimeValue,
  context: EvaluationContext
): UnitResult<RuntimeValue> {
  const left = toQuantity(leftValue, `operator '${node.operator}' left operand`);
  if (!left.ok) {
    return left;
  }

  const right = toQuantity(rightValue, `operator '${node.operator}' right operand`);
  if (!right.ok) {
    return right;
  }

  switch (node.operator) {
    case "+": {
      const result = addQuantities(left.value, right.value);
      if (!result.ok) {
        if (context.ignoreUnitCompatibility) {
          context.onWarning?.(
            `incompatible units: ${formatDimension(left.value.dimension)} and ${formatDimension(
              right.value.dimension
            )}`
          );
          let quantity: Quantity;
          if (isDimensionless(left.value.dimension)) {
            quantity = {
              ...right.value,
              valueSi: left.value.valueSi + right.value.valueSi,
            };
          } else if (isDimensionless(right.value.dimension)) {
            quantity = {
              ...left.value,
              valueSi: left.value.valueSi + right.value.valueSi,
            };
          } else {
            quantity = {
              ...left.value,
              valueSi: left.value.valueSi + right.value.valueSi,
            };
          }
          return {
            ok: true,
            value: {
              kind: "quantity",
              quantity,
            },
          };
        }
        return result;
      }

      return {
        ok: true,
        value: {
          kind: "quantity",
          quantity: result.value,
        },
      };
    }
    case "-": {
      const result = subtractQuantities(left.value, right.value);
      if (!result.ok) {
        if (context.ignoreUnitCompatibility) {
          context.onWarning?.(
            `incompatible units: ${formatDimension(left.value.dimension)} and ${formatDimension(
              right.value.dimension
            )}`
          );
          let quantity: Quantity;
          if (isDimensionless(left.value.dimension)) {
            quantity = {
              ...right.value,
              valueSi: left.value.valueSi - right.value.valueSi,
            };
          } else if (isDimensionless(right.value.dimension)) {
            quantity = {
              ...left.value,
              valueSi: left.value.valueSi - right.value.valueSi,
            };
          } else {
            quantity = {
              ...left.value,
              valueSi: left.value.valueSi - right.value.valueSi,
            };
          }
          return {
            ok: true,
            value: {
              kind: "quantity",
              quantity,
            },
          };
        }
        return result;
      }

      return {
        ok: true,
        value: {
          kind: "quantity",
          quantity: result.value,
        },
      };
    }
    case "*": {
      const result = multiplyQuantities(left.value, right.value);
      if (!result.ok) {
        return result;
      }

      return {
        ok: true,
        value: {
          kind: "quantity",
          quantity: result.value,
        },
      };
    }
    case "/": {
      const result = divideQuantities(left.value, right.value);
      if (!result.ok) {
        return result;
      }

      return {
        ok: true,
        value: {
          kind: "quantity",
          quantity: result.value,
        },
      };
    }
  }
}

function evaluateNode(
  node: ExpressionNode,
  context: EvaluationContext
): UnitResult<RuntimeValue> {
  switch (node.kind) {
    case "number":
      return {
        ok: true,
        value: {
          kind: "quantity",
          quantity: createDimensionlessQuantity(node.value),
        },
      };
    case "string":
      return {
        ok: true,
        value: {
          kind: "string",
          value: node.value,
        },
      };
    case "identifier": {
      const quantity = context.resolveIdentifier(node.name);
      if (!quantity) {
        // ✅ Formula parametrizzata: variabile libera, non fallire!
        // Restituiamo un valore dummy dimensionally neutral per permettere alla valutazione di continuare
        // La formula verrà comunque esportata correttamente nel codice C come macro parametrizzata
        return {
          ok: true,
          value: {
            kind: "quantity",
            quantity: createDimensionlessQuantity(1.0),
          },
        };
      }

      return {
        ok: true,
        value: {
          kind: "quantity",
          quantity,
        },
      };
    }
    case "unary": {
      const argument = evaluateNode(node.argument, context);
      if (!argument.ok) {
        return argument;
      }

      const numeric = toQuantity(argument.value, "unary operator");
      if (!numeric.ok) {
        return numeric;
      }

      const quantity =
        node.operator === "-" ? negateQuantity(numeric.value) : numeric.value;

      return {
        ok: true,
        value: {
          kind: "quantity",
          quantity,
        },
      };
    }
    case "binary": {
      const left = evaluateNode(node.left, context);
      if (!left.ok) {
        return left;
      }

      const right = evaluateNode(node.right, context);
      if (!right.ok) {
        return right;
      }

      return evaluateBinary(node, left.value, right.value, context);
    }
    case "call": {
      const args: RuntimeValue[] = [];
      for (const arg of node.args) {
        const computed = evaluateNode(arg, context);
        if (!computed.ok) {
          return computed;
        }

        args.push(computed.value);
      }

      return evaluateCall(node.callee, args, context);
    }
  }
}

export function evaluateExpressionAst(
  ast: ExpressionNode,
  context: EvaluationContext
): EvaluationResult {
  const result = evaluateNode(ast, context);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
    };
  }

  if (result.value.kind !== "quantity") {
    return {
      ok: false,
      error: "expression cannot resolve to a string value",
    };
  }

  if (!Number.isFinite(result.value.quantity.valueSi)) {
    return {
      ok: false,
      error: "expression evaluated to a non-finite value",
    };
  }

  return {
    ok: true,
    quantity: result.value.quantity,
  };
}

export function evaluateExpression(
  expression: string,
  context: EvaluationContext
): EvaluationResult {
  let ast: ExpressionNode;
  try {
    ast = parseExpression(preprocessExpression(expression));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: message,
    };
  }

  return evaluateExpressionAst(ast, context);
}

function literalFromExpression(node: ExpressionNode): PrimitiveArgument | null {
  if (node.kind === "number") {
    return node.value;
  }

  if (node.kind === "string") {
    return node.value;
  }

  return null;
}

function evaluateLiteralCall(
  callee: string,
  args: PrimitiveArgument[],
  lookup?: (functionName: string, args: PrimitiveArgument[]) => number | Quantity
): number | null {
  const normalized = callee.trim().toLowerCase();

  if (normalized === "abs") {
    if (args.length !== 1 || typeof args[0] !== "number") {
      return null;
    }

    return Math.abs(args[0]);
  }

  if (normalized === "sin") {
    if (args.length !== 1 || typeof args[0] !== "number") {
      return null;
    }

    return Math.sin(args[0]);
  }

  if (normalized === "cos") {
    if (args.length !== 1 || typeof args[0] !== "number") {
      return null;
    }

    return Math.cos(args[0]);
  }

  if ((normalized === "csv" || normalized === "lookup" || normalized === "table") && lookup) {
    try {
      const value = lookup(normalized, args);
      // return Number.isFinite(value) ? value : null;
      if (typeof value === 'number') {
          return Number.isFinite(value) ? value : null;
      } 
      // Se è una Quantity, usiamo la funzione di utility che hai già nel progetto
      if (value && typeof value === 'object') {
          const numericValue = quantityToPrimitive(value); // Usa questa funzione definita nel tuo evaluator.ts
          return Number.isFinite(numericValue) ? numericValue : null;
      }
      return null;
      
    } catch {
      return null;
    }
  }

  if (normalized === "__unit") {
    if (args.length !== 2 || typeof args[0] !== "number" || typeof args[1] !== "string") {
      return null;
    }

    const quantity = createQuantity(args[0], args[1]);
    if (!quantity.ok) {
      return null;
    }

    return quantity.value.valueSi;
  }

  return null;
}

function reduceNumericNodeOnce(
  node: ExpressionNode,
  lookup?: (functionName: string, args: PrimitiveArgument[]) => number | Quantity
): { reduced: boolean; node: ExpressionNode } {
  switch (node.kind) {
    case "number":
    case "string":
    case "identifier":
      return {
        reduced: false,
        node,
      };
    case "unary": {
      const inner = reduceNumericNodeOnce(node.argument, lookup);
      if (inner.reduced) {
        return {
          reduced: true,
          node: {
            ...node,
            argument: inner.node,
          },
        };
      }

      if (inner.node.kind !== "number") {
        return {
          reduced: false,
          node,
        };
      }

      const value =
        node.operator === "-" ? -inner.node.value : inner.node.value;

      return {
        reduced: true,
        node: {
          kind: "number",
          value,
          raw: String(value),
        },
      };
    }
    case "binary": {
      const leftReduced = reduceNumericNodeOnce(node.left, lookup);
      if (leftReduced.reduced) {
        return {
          reduced: true,
          node: {
            ...node,
            left: leftReduced.node,
          },
        };
      }

      const rightReduced = reduceNumericNodeOnce(node.right, lookup);
      if (rightReduced.reduced) {
        return {
          reduced: true,
          node: {
            ...node,
            right: rightReduced.node,
          },
        };
      }

      if (leftReduced.node.kind !== "number" || rightReduced.node.kind !== "number") {
        return {
          reduced: false,
          node,
        };
      }

      const left = leftReduced.node.value;
      const right = rightReduced.node.value;
      let value: number;

      switch (node.operator) {
        case "+":
          value = left + right;
          break;
        case "-":
          value = left - right;
          break;
        case "*":
          value = left * right;
          break;
        case "/":
          value = left / right;
          break;
      }

      if (!Number.isFinite(value)) {
        return {
          reduced: false,
          node,
        };
      }

      return {
        reduced: true,
        node: {
          kind: "number",
          value,
          raw: String(value),
        },
      };
    }
    case "call": {
      for (let i = 0; i < node.args.length; i += 1) {
        const reducedArg = reduceNumericNodeOnce(node.args[i], lookup);
        if (reducedArg.reduced) {
          const nextArgs = [...node.args];
          nextArgs[i] = reducedArg.node;
          return {
            reduced: true,
            node: {
              ...node,
              args: nextArgs,
            },
          };
        }
      }

      const literalArgs: PrimitiveArgument[] = [];
      for (const arg of node.args) {
        const literal = literalFromExpression(arg);
        if (literal == null) {
          return {
            reduced: false,
            node,
          };
        }

        literalArgs.push(literal);
      }

      const value = evaluateLiteralCall(node.callee, literalArgs, lookup);
      if (value == null || !Number.isFinite(value)) {
        return {
          reduced: false,
          node,
        };
      }

      return {
        reduced: true,
        node: {
          kind: "number",
          value,
          raw: String(value),
        },
      };
    }
  }
}

function formatStepValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return formatNumberToSigFigs(value, 6);
}

export function substituteIdentifiersForExplain(
  ast: ExpressionNode,
  resolveIdentifier: (name: string) => { value: number; unit?: string } | undefined
): ExpressionNode {
  return mapExpression(ast, (node) => {
    if (node.kind !== "identifier") {
      return node;
    }

    const res = resolveIdentifier(node.name);
    if (!res || typeof res.value !== "number" || !Number.isFinite(res.value)) {
      return node;
    }

    return {
      kind: "identifier",
      name: String(res.value),
      unit: res.unit,
    };
  });
}

export function buildExplainSteps(
  expression: string,
  options?: {
    lookup?: (functionName: string, args: PrimitiveArgument[]) => number | Quantity;
    maxSteps?: number;
  }
): string[] {
  let ast: ExpressionNode;
  try {
    ast = parseExpression(preprocessExpression(expression));
  } catch {
    return [`= ${expression}`];
  }

  const maxSteps = Math.max(2, options?.maxSteps ?? 16);
  const steps: string[] = [];

  const pushStep = (value: string): void => {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }

    const line = `= ${normalized}`;
    if (steps[steps.length - 1] !== line) {
      steps.push(line);
    }
  };

  for (let i = 0; i < maxSteps; i += 1) {
    pushStep(printExpression(ast));
    const reduced = reduceNumericNodeOnce(ast, options?.lookup);
    if (!reduced.reduced) {
      break;
    }

    ast = reduced.node;
  }

  if (ast.kind === "number") {
    pushStep(formatStepValue(ast.value));
  }

  return steps;
}

export function evaluateExpressionWithOutputUnit(
  expression: string,
  context: EvaluationContext,
  outputUnit?: string
): EvaluationResult & {
  displayValue?: number;
  displayUnit?: string;
} {
  const evaluated = evaluateExpression(expression, context);
  if (!evaluated.ok) {
    return evaluated;
  }

  if (!outputUnit) {
    return {
      ...evaluated,
    };
  }

  const converted = applyOutputUnit(evaluated.quantity, outputUnit);
  if (!converted.ok) {
    if (context.ignoreUnitCompatibility) {
      context.onWarning?.(converted.error);
      return {
        ...evaluated,
      };
    }
    return {
      ok: false,
      error: converted.error,
    };
  }

  return {
    ok: true,
    quantity: converted.value.quantity,
    displayValue: converted.value.displayValue,
    displayUnit: converted.value.displayUnit,
  };
}
