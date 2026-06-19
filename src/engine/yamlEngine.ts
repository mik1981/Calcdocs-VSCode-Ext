import type { CsvTableMap } from "../core/csvTables";
import {
  getYamlTopLevelLine,
  normalizeFormulaYamlNode,
  parseFormulaYamlValue,
  type FormulaToleranceRange,
  type FormulaToleranceSpec,
} from "../core/formulaYaml";
import {
  collectFunctionCallees,
  collectIdentifiers,
  parseExpression,
  printExpression,
  type ExpressionNode,
} from "./ast";
import { createCsvLookupResolver } from "./csvLookup";
import { formatNumberToSigFigs } from "../utils/nformat";
import {
  buildExplainSteps,
  evaluateExpressionAst,
  preprocessExpression,
  substituteIdentifiersForExplain,
  type EvaluationContext,
} from "./evaluator";
import {
  applyOutputUnit,
  createDimensionlessQuantity,
  createQuantity,
  createQuantityFromData,
  dimensionsEqual,
  formatDimension,
  getUnitSpec,
  isDimensionless,
  parseUnitToQuantity,
  toDisplayUnit,
  toDisplayValue,
  type UnitSpec,
  type Quantity,
  SCALABLE_UNIT_FAMILY,
  UNIT_SPEC_LIST,
  UNIT_SPECS,
} from "./units";
import {
  PropagationMethod,
  PropagationResult,
  normalizeUncertainty,
  computeStdDev,
} from "../types/toleranceModel";
import {
  propagate,
  runMonteCarlo,
  generateSamplesForInput,
  resultFromSamples,
  computeOutputDistribution,
  type McInput
} from "./monteCarlo";

export type YamlSymbolType = "const" | "expr" | "lookup";

export type DiagnosticSeverity = "error" | "warning" | "info";

export type YamlEvaluationDiagnostic = {
  symbol: string;
  line: number;
  severity: DiagnosticSeverity;
  message: string;
};

export type MissingYamlSuggestion = {
  name: string;
  unit: string;
  value?: number;
};

type ParsedSymbol = {
  name: string;
  line: number;
  type: YamlSymbolType;
  rawNode: Record<string, unknown>;
  expression?: string;
  ast?: ExpressionNode;
  literalValue?: number;
  literalValues?: number[];
  declaredUnit?: string;
  effectiveUnit?: string;
  yamlValue?: number;
  parameters: string[];
  tolerance?: FormulaToleranceSpec;
  dependencies: string[];
  parseError?: string;
};

export type EvaluatedYamlSymbol = {
  name: string;
  line: number;
  type: YamlSymbolType;
  expression?: string;
  dependencies: string[];
  resolvedDependencies: string[];
  expanded?: string;
  explainSteps: string[];
  quantity?: Quantity;
  value?: number;
  outputUnit?: string;
  yamlValue?: number;
  range?: PropagationResult & {
    source: "declared" | "propagated";
  };

  errors: string[];
  warnings: string[];
  isParameterized?: boolean;
};

export type YamlEvaluationResult = {
  symbols: Map<string, EvaluatedYamlSymbol>;
  diagnostics: YamlEvaluationDiagnostic[];
  cycles: string[][];
  missingSuggestions: MissingYamlSuggestion[];
};

export type EvaluateYamlOptions = {
  rawText: string;
  yamlPath?: string;
  externalValues?: Map<string, number>;
  externalUnits?: Map<string, string>;
  csvTables?: CsvTableMap;
};

function inferCanonicalUnit(quantity: Quantity): string | undefined {
  if (isDimensionless(quantity.dimension)) return undefined;
  if (quantity.preferredUnit) {
    const spec = UNIT_SPECS.get(quantity.preferredUnit);
    if (spec) return spec.canonical;
  }
  if (quantity.displayUnit && !/^[MLTIK]/.test(quantity.displayUnit)) return quantity.displayUnit;
  const EPSILON = 1e-12;
  for (const spec of UNIT_SPEC_LIST) {
    if (Math.abs(spec.factorToSi - 1) < EPSILON && dimensionsEqual(spec.dimension, quantity.dimension))
      return spec.canonical;
  }
  for (const spec of UNIT_SPEC_LIST) {
    if (dimensionsEqual(spec.dimension, quantity.dimension)) return spec.canonical;
  }
  return undefined;
}

function toNumericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
    const match = trimmed.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)\s*[A-Za-z%][A-Za-z0-9_%]*$/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function inferSymbolType(node: Record<string, unknown>): YamlSymbolType | null {
  if (typeof node.type === "string") {
    const normalized = node.type.trim().toLowerCase();
    if (normalized === "const") return "const";
    if (normalized === "expr" || normalized === "expression") return "expr";
    if (normalized === "lookup" || normalized === "table") return "lookup";
    return null;
  }
  if (typeof node.expr === "string" || typeof node.formula === "string") return "expr";
  if (node.table != null || node.lookup != null || node.column != null) return "lookup";
  const parsedValue = parseFormulaYamlValue(node.value);
  if (parsedValue.value != null || parsedValue.values != null) return "const";
  return null;
}

function toLookupArgument(value: unknown, options?: { allowIdentifier?: boolean }): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const text = String(value ?? "").trim();
  if (!text) return '""';
  if (options?.allowIdentifier && /^[A-Za-z_]\w*$/.test(text)) return text;
  return JSON.stringify(text);
}

function buildLookupExpression(node: Record<string, unknown>): string | null {
  const table = node.table ?? node.lookup ?? node.csv;
  const row = node.row ?? node.key ?? node.lookupKey;
  const valueColumn = node.valueColumn ?? node.column ?? node.outputColumn;
  const lookupColumn = node.lookupColumn ?? node.inputColumn;
  const interpolation = node.interpolation ?? node.mode;
  const tableText = String(table ?? "").trim();
  if (!tableText || row == null || valueColumn == null) return null;
  const tableArgument = JSON.stringify(tableText);
  const rowArgument = toLookupArgument(row, { allowIdentifier: true });
  const valueColumnArgument = toLookupArgument(valueColumn);
  const interpolationArgument = interpolation == null ? undefined : toLookupArgument(interpolation);
  if (lookupColumn != null) {
    const lookupColumnArgument = toLookupArgument(lookupColumn);
    if (interpolationArgument) return `csv(${tableArgument}, ${rowArgument}, ${lookupColumnArgument}, ${valueColumnArgument}, ${interpolationArgument})`;
    return `csv(${tableArgument}, ${rowArgument}, ${lookupColumnArgument}, ${valueColumnArgument})`;
  }
  if (interpolationArgument) return `csv(${tableArgument}, ${rowArgument}, ${valueColumnArgument}, ${interpolationArgument})`;
  return `csv(${tableArgument}, ${rowArgument}, ${valueColumnArgument})`;
}

function formatExplainNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return formatNumberToSigFigs(value, 6);
}

function formatResolvedDependency(name: string, quantity: Quantity | undefined, fallbackValue?: number): string | undefined {
  if (quantity) {
    const value = formatExplainNumber(toDisplayValue(quantity));
    const unit = toDisplayUnit(quantity);
    return unit ? `${name} = ${value} ${unit}` : `${name} = ${value}`;
  }
  if (typeof fallbackValue === "number" && Number.isFinite(fallbackValue)) return `${name} = ${formatExplainNumber(fallbackValue)}`;
  return undefined;
}

type NumericRange = { min: number; max: number };

/**
 * Converte FormulaToleranceSpec → FormulaToleranceRange per retrocompatibilità.
 */
function specToToleranceRange(spec: FormulaToleranceSpec | undefined): FormulaToleranceRange | undefined {
  if (!spec) return undefined;
  let tol: number | undefined;
  let min: number | undefined;
  let max: number | undefined;
  let mode: string | undefined;
  let sigma: number | undefined;
  if (spec.input) {
    const unc = spec.input.uncertainty;
    switch (unc.type) {
      case "percent": tol = unc.value; break;
      case "range": min = unc.min; max = unc.max; break;
      case "absolute": break;
      case "sigma": sigma = unc.sigma; break;
    }
    if (spec.input.distribution.type === "normal") {
      mode = "gaussian";
      if (sigma === undefined) sigma = spec.input.distribution.sigma_level;
    }
  }
  if (spec.output) mode = spec.output.method;
  return { min, max, tol, mode, sigma };
}

function normalizeToleranceRange(range: FormulaToleranceRange | undefined, nominal?: number): NumericRange | undefined {
  if (!range) return undefined;
  let min = range.min;
  let max = range.max;
  if ((min === undefined || max === undefined) && range.tol !== undefined && nominal !== undefined) {
    const delta = Math.abs(nominal) * Math.abs(range.tol) / 100;
    min ??= nominal - delta;
    max ??= nominal + delta;
  }
  if (min === undefined || max === undefined) return undefined;
  return min <= max ? { min, max } : { min: max, max: min };
}

function getToleranceParameterRange(tolerance: FormulaToleranceSpec | undefined, name: string): FormulaToleranceRange | undefined {
  const param = tolerance?.parameterOverrides?.[name];
  if (!param) return undefined;
  const result: FormulaToleranceRange = {};
  if (param.uncertainty.type === "percent") result.tol = param.uncertainty.value;
  else if (param.uncertainty.type === "range") { result.min = param.uncertainty.min; result.max = param.uncertainty.max; }
  if (param.distribution.type === "normal") { result.mode = "gaussian"; result.sigma = param.distribution.sigma_level; }
  return result;
}

function expressionNeedsOutputConversion(ast: ExpressionNode | undefined): boolean {
  if (!ast) return false;
  let requiresConversion = false;
  const walk = (node: ExpressionNode): void => {
    if (requiresConversion) return;
    switch (node.kind) {
      case "binary":
        if (node.operator === "+" || node.operator === "-") { requiresConversion = true; return; }
        walk(node.left); walk(node.right); return;
      case "unary": walk(node.argument); return;
      case "call": for (const arg of node.args) walk(arg); return;
      case "identifier": case "number": case "string": return;
    }
  };
  walk(ast);
  return requiresConversion;
}

function shouldConvertPureExpressionOutput(quantity: Quantity, outputSpec?: UnitSpec): boolean {
  if (!outputSpec) return true;
  const sourceToken = quantity.preferredUnit;
  if (!sourceToken) return true;
  if (sourceToken === outputSpec.token) return false;
  const sourceFamily = SCALABLE_UNIT_FAMILY.get(sourceToken);
  const targetFamily = SCALABLE_UNIT_FAMILY.get(outputSpec.token);
  if (!sourceFamily || !targetFamily || sourceFamily !== targetFamily) return false;
  return ["voltage","current","resistance","conductance","capacitance","inductance","frequency","time","power"].includes(sourceFamily);
}

function createDiagnostic(diagnostics: YamlEvaluationDiagnostic[], symbol: string, line: number, severity: DiagnosticSeverity, message: string): void {
  const duplicate = diagnostics.some(entry => entry.symbol === symbol && entry.line === line && entry.severity === severity && entry.message === message);
  if (duplicate) return;
  diagnostics.push({ symbol, line, severity, message });
}

// ── Symbol parsing ──────────────────────────────────────────────────────────

function parseSymbols(root: Record<string, unknown>, options: EvaluateYamlOptions, diagnostics: YamlEvaluationDiagnostic[]): Map<string, ParsedSymbol> {
  const parsed = new Map<string, ParsedSymbol>();
  const externalUnits = options.externalUnits ?? new Map<string, string>();
  for (const [name, rawNode] of Object.entries(root)) {
    if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) continue;
    const node = rawNode as Record<string, unknown>;
    const type = inferSymbolType(node);
    const line = Math.max(0, getYamlTopLevelLine(options.rawText, name));
    const normalizedNode = normalizeFormulaYamlNode(name, node, options.rawText, options.yamlPath);
    const parsedValue = parseFormulaYamlValue(node.value);
    const yamlValue = parsedValue.value;
    const yamlValues = parsedValue.values;
    const declaredUnit = normalizedNode.unit;
    const effectiveUnit = declaredUnit || externalUnits.get(name);
    const parameters = normalizedNode.parameters ?? [];
    const tolerance = normalizedNode.tolerance;
    if (!type) {
      createDiagnostic(diagnostics, name, line, "error", `unable to infer symbol type for '${name}'`);
      parsed.set(name, { name, line, type: "expr", rawNode: node, declaredUnit, effectiveUnit, yamlValue, parameters, tolerance, dependencies: [], parseError: "unknown symbol type" });
      continue;
    }
    if (type === "const") {
      if (yamlValue == null && yamlValues == null) createDiagnostic(diagnostics, name, line, "error", `const '${name}' requires a numeric 'value'`);
      parsed.set(name, { name, line, type, rawNode: node, literalValue: yamlValue ?? undefined, literalValues: yamlValues, declaredUnit, effectiveUnit, yamlValue: yamlValue ?? undefined, parameters, tolerance, dependencies: [] });
      continue;
    }
    const expression = (normalizedNode.expr ? normalizedNode.expr : undefined) ?? (type === "lookup" ? buildLookupExpression(node) ?? undefined : undefined);
    if (!expression) {
      createDiagnostic(diagnostics, name, line, "error", `'${name}' requires an expression`);
      parsed.set(name, { name, line, type, rawNode: node, declaredUnit, effectiveUnit, yamlValue, parameters, tolerance, dependencies: [], parseError: "missing expression" });
      continue;
    }
    try {
      const ast = parseExpression(preprocessExpression(expression));
      const dependencySet = collectIdentifiers(ast);
      for (const callee of collectFunctionCallees(ast)) { if (root[callee] != null) dependencySet.add(callee); }
      const dependencies = Array.from(dependencySet).filter(d => !parameters.includes(d)).sort();
      parsed.set(name, { name, line, type, rawNode: node, expression, ast, declaredUnit, effectiveUnit, yamlValue, parameters, tolerance, dependencies });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      createDiagnostic(diagnostics, name, line, "error", `invalid expression for '${name}': ${message}`);
      parsed.set(name, { name, line, type, rawNode: node, expression, declaredUnit, effectiveUnit, yamlValue, parameters, tolerance, dependencies: [], parseError: message });
    }
  }
  return parsed;
}

function detectCycles(parsedSymbols: Map<string, ParsedSymbol>): string[][] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycleStartIndex = stack.indexOf(name);
      const cyclePath = cycleStartIndex >= 0 ? [...stack.slice(cycleStartIndex), name] : [...stack, name];
      const key = cyclePath.join("->");
      if (!seenCycleKeys.has(key)) { seenCycleKeys.add(key); cycles.push(cyclePath); }
      return;
    }
    visiting.add(name); stack.push(name);
    const symbol = parsedSymbols.get(name);
    if (symbol) { for (const dep of symbol.dependencies) { if (parsedSymbols.has(dep)) visit(dep); } }
    stack.pop(); visiting.delete(name); visited.add(name);
  };
  for (const name of parsedSymbols.keys()) visit(name);
  return cycles;
}

// ── Evaluation ──────────────────────────────────────────────────────────────

export function evaluateYamlDocument(root: Record<string, unknown>, options: EvaluateYamlOptions): YamlEvaluationResult {
  const diagnostics: YamlEvaluationDiagnostic[] = [];
  const symbols = parseSymbols(root, options, diagnostics);
  const cycles = detectCycles(symbols);
  const cycleNodes = new Set<string>();
  const externalValues = options.externalValues ?? new Map<string, number>();
  const externalUnits = options.externalUnits ?? new Map<string, string>();
  const csvLookup = createCsvLookupResolver(options.csvTables, options.yamlPath);

  for (const cycle of cycles) {
    for (const name of cycle) {
      cycleNodes.add(name);
      const symbol = symbols.get(name);
      if (!symbol) continue;
      createDiagnostic(diagnostics, name, symbol.line, "error", `circular dependency detected: ${cycle.join(" -> ")}`);
    }
  }

  for (const symbol of symbols.values()) {
    for (const dep of symbol.dependencies) {
      if (symbols.has(dep) || externalValues.has(dep)) continue;
      createDiagnostic(diagnostics, symbol.name, symbol.line, "info", `formula parametrizzata: '${dep}' verrà trattata come argomento libero nel codice generato`);
    }
  }

  const evaluated = new Map<string, EvaluatedYamlSymbol>();
  const evaluating = new Set<string>();

  const createYamlDataQuantity = (value: number, unit?: string): ReturnType<typeof createQuantity> => {
    if (!unit) return createQuantity(value);
    const spec = getUnitSpec(unit);
    if (spec && (spec.toSi || spec.fromSi)) {
      if (!Number.isFinite(value)) return { ok: false, error: `non-finite numeric value: ${value}` };
      return { ok: true, value: { ...createDimensionlessQuantity(value), displayUnit: spec.canonical } };
    }
    return createQuantityFromData(value, unit);
  };

  const resolveExternalQuantity = (name: string): Quantity | undefined => {
    const value = externalValues.get(name);
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    const unit = externalUnits.get(name);
    if (unit) { const qty = createYamlDataQuantity(value, unit); if (qty.ok) return qty.value; }
    else { const qty = createQuantity(value); if (qty.ok) return qty.value; }
    return undefined;
  };

  const createDataQuantity = (value: number, unit?: string): Quantity | undefined => {
    const quantity = createYamlDataQuantity(value, unit);
    return quantity.ok ? quantity.value : undefined;
  };

  const resolveArrayQuantities = (name: string): Quantity[] | undefined => {
    const symbol = symbols.get(name);
    if (!symbol?.literalValues) return undefined;
    const quantities: Quantity[] = [];
    for (const value of symbol.literalValues) {
      const quantity = createDataQuantity(value, symbol.effectiveUnit);
      if (!quantity) return undefined;
      quantities.push(quantity);
    }
    return quantities;
  };

  const evaluateSymbol = (name: string): EvaluatedYamlSymbol | undefined => {
    if (evaluated.has(name)) return evaluated.get(name);
    const symbol = symbols.get(name);
    if (!symbol) return undefined;
    const result: EvaluatedYamlSymbol = {
      name: symbol.name, line: symbol.line, type: symbol.type, expression: symbol.expression,
      dependencies: [...symbol.dependencies], resolvedDependencies: [], explainSteps: [],
      errors: [], warnings: [], yamlValue: symbol.yamlValue,
    };
    const addError = (message: string): void => { if (!result.errors.includes(message)) result.errors.push(message); };
    const addWarning = (message: string): void => { if (!result.warnings.includes(message)) result.warnings.push(message); };
    evaluated.set(name, result);
    if (cycleNodes.has(name)) { addError("evaluation skipped because of circular dependency"); return result; }
    if (symbol.parseError) { addError(symbol.parseError); return result; }
    if (evaluating.has(name)) { addError(`recursive evaluation detected for '${name}'`); return result; }
    evaluating.add(name);

    // ── CONST ───────────────────────────────────────────────────────────────
    if (symbol.type === "const") {
      if (symbol.literalValues) {
        if (symbol.literalValues.length === 0) addError(`const '${name}' has an empty value table`);
        result.expanded = `[${symbol.literalValues.map(formatExplainNumber).join(", ")}]`;
        result.explainSteps = [`= ${result.expanded}`]; result.outputUnit = symbol.effectiveUnit;
        evaluating.delete(name); return result;
      }
      if (typeof symbol.literalValue !== "number" || !Number.isFinite(symbol.literalValue)) {
        addError(`const '${name}' has invalid numeric value`); evaluating.delete(name); return result;
      }
      let constQuantity: Quantity;
      if (symbol.effectiveUnit) {
        const spec = getUnitSpec(symbol.effectiveUnit);
        if (spec && (spec.toSi || spec.fromSi)) {
          constQuantity = { valueSi: symbol.literalValue, dimension: createDimensionlessQuantity(symbol.literalValue).dimension, preferredUnit: undefined, displayUnit: spec.canonical };
        } else {
          const qty = createQuantityFromData(symbol.literalValue, symbol.effectiveUnit);
          if (!qty.ok) { addError(qty.error); evaluating.delete(name); return result; }
          constQuantity = qty.value;
        }
      } else {
        const qty = createQuantity(symbol.literalValue);
        if (!qty.ok) { addError(qty.error); evaluating.delete(name); return result; }
        constQuantity = qty.value;
      }
      result.quantity = constQuantity;
      result.value = toDisplayValue(constQuantity);
      // Propagate tolerance spec issues (e.g. legacy warnings) to symbol warnings
      if (symbol.tolerance?.issues) {
        for (const issue of symbol.tolerance.issues) {
          if (issue.severity === "warning") {
            result.warnings.push(issue.message);
          } else if (issue.severity === "error") {
            if (!result.errors.includes(issue.message)) result.errors.push(issue.message);
          }
        }
      }
      // Use tolerance range from spec
      if (symbol.tolerance?.input) {
        const { uncertainty, distribution } = symbol.tolerance.input;
        const norm = normalizeUncertainty(uncertainty, result.value!);
        if (norm) {
          result.range = {
            min: norm.lower,
            max: norm.upper,
            nominalValue: result.value,
            stddev: computeStdDev(norm, distribution),
            contributingInputs: [],
            method: "worst_case", // Default method for declared constants
            source: "declared",
          };
        }
      }
      const rawUnit = toDisplayUnit(constQuantity);
      const isRawDimension = rawUnit != null && /^[MLTIK]/.test(rawUnit);
      result.outputUnit = isRawDimension || rawUnit == null ? inferCanonicalUnit(constQuantity) : rawUnit;
      result.expanded = formatExplainNumber(result.value);
      result.explainSteps = [`= ${result.expanded}`];
      if (!symbol.declaredUnit && symbol.effectiveUnit)
        createDiagnostic(diagnostics, symbol.name, symbol.line, "info", `unit '${symbol.effectiveUnit}' inferred from C/C++ declarations`);
      if (!symbol.declaredUnit && !symbol.effectiveUnit && result.outputUnit)
        createDiagnostic(diagnostics, symbol.name, symbol.line, "info", `unit '${result.outputUnit}' derived from formula dimensions (add 'unit: ${result.outputUnit}' to confirm)`);
      evaluating.delete(name); return result;
    }

    // ── EXPR / LOOKUP ──────────────────────────────────────────────────────
    if (!symbol.ast || !symbol.expression) { addError("expression is not available"); evaluating.delete(name); return result; }
    const hasUnknownVariables = symbol.dependencies.some(dep => !symbols.has(dep) && !externalUnits.has(dep) && !externalValues.has(dep));
    result.isParameterized = hasUnknownVariables || symbol.parameters.length > 0;

    const context: EvaluationContext = {
      ignoreUnitCompatibility: hasUnknownVariables,
      resolveIdentifier: (identifier: string): Quantity | undefined => {
        if (symbol.parameters.includes(identifier)) return createDimensionlessQuantity(1.0);
        if (symbols.has(identifier)) {
          const depEval = evaluateSymbol(identifier);
          if (depEval?.quantity) return depEval.quantity;
          const declaredUnit = symbols.get(identifier)?.effectiveUnit;
          if (declaredUnit) { const q = createYamlDataQuantity(1.0, declaredUnit); if (q.ok) return q.value; }
        }
        const extValue = externalValues.get(identifier);
        const extUnit = externalUnits.get(identifier);
        if (extUnit) { const q = createYamlDataQuantity(extValue ?? 1.0, extUnit); if (q.ok) return q.value; }
        if (extValue !== undefined) { const q = createQuantity(extValue); if (q.ok) return q.value; }
        return undefined;
      },
      resolveArrayIdentifier: resolveArrayQuantities,
      resolveFunctionCall: (functionName, args) => {
        const target = symbols.get(functionName);
        if (!target) return undefined;
        if (!target.ast || !target.expression) return { ok: false, error: `formula '${functionName}' is not callable` };
        if (args.length !== target.parameters.length) return { ok: false, error: `formula '${functionName}' expects ${target.parameters.length} parameter(s), got ${args.length}` };
        if (evaluating.has(functionName)) return { ok: false, error: `recursive formula call detected for '${functionName}'` };
        const boundParameters = new Map<string, Quantity>();
        target.parameters.forEach((p, i) => boundParameters.set(p, args[i]));
        evaluating.add(functionName);
        const callContext: EvaluationContext = {
          ignoreUnitCompatibility: false,
          resolveIdentifier: (id: string): Quantity | undefined => {
            const bound = boundParameters.get(id); if (bound) return bound;
            if (symbols.has(id)) { const d = evaluateSymbol(id); if (d?.quantity) return d.quantity; const du = symbols.get(id)?.effectiveUnit; if (du) { const q = createYamlDataQuantity(1.0, du); if (q.ok) return q.value; } }
            return resolveExternalQuantity(id);
          },
          resolveArrayIdentifier: resolveArrayQuantities,
          resolveLookup: (ln, la) => csvLookup(ln, la),
          resolveFunctionCall: (nn, na) => context.resolveFunctionCall?.(nn, na),
        };
        const ev = evaluateExpressionAst(target.ast, callContext);
        evaluating.delete(functionName);
        if (!ev.ok) return { ok: false, error: ev.error };
        let callQuantity = ev.quantity;
        if (target.effectiveUnit) {
          const output = applyOutputUnit(callQuantity, target.effectiveUnit);
          if (output.ok) callQuantity = output.value.quantity;
          else if (isDimensionless(callQuantity.dimension)) {
            const tagged = createYamlDataQuantity(callQuantity.valueSi, target.effectiveUnit);
            if (!tagged.ok) return { ok: false, error: tagged.error };
            callQuantity = tagged.value;
          } else return { ok: false, error: output.error };
        }
        return { ok: true, value: callQuantity };
      },
      resolveLookup: (fn, args) => csvLookup(fn, args),
    };

    const evaluatedExpression = evaluateExpressionAst(symbol.ast, context);
    if (!evaluatedExpression.ok) { if (!hasUnknownVariables) addError(evaluatedExpression.error); evaluating.delete(name); return result; }
    let quantity = evaluatedExpression.quantity;

    // Unit handling
    if (symbol.effectiveUnit) {
      const outputUnit = symbol.effectiveUnit;
      const parsedUnit = parseUnitToQuantity(outputUnit);
      if (!parsedUnit.ok) { addError(`unknown unit '${outputUnit}'`); evaluating.delete(name); return result; }
      const outputSpec = getUnitSpec(outputUnit);
      const isRawDimensionless = isDimensionless(quantity.dimension);
      const hasUnitMismatch = !isRawDimensionless && !dimensionsEqual(quantity.dimension, parsedUnit.value.dimension) && !hasUnknownVariables;
      if (hasUnitMismatch) {
        const calcDim = formatDimension(quantity.dimension);
        const targetDim = formatDimension(parsedUnit.value.dimension);
        addError(`unit mismatch: expression has ${calcDim} but output unit '${outputUnit}' expects ${targetDim}`);
        result.quantity = quantity; result.value = toDisplayValue(quantity); result.outputUnit = toDisplayUnit(quantity);
      } else if (isRawDimensionless) {
        const tagged = createYamlDataQuantity(quantity.valueSi, outputUnit);
        if (!tagged.ok) { addError(tagged.error); evaluating.delete(name); return result; }
        quantity = tagged.value;
        result.quantity = quantity; result.value = toDisplayValue(quantity); result.outputUnit = toDisplayUnit(quantity);
      } else if (expressionNeedsOutputConversion(symbol.ast) || shouldConvertPureExpressionOutput(quantity, outputSpec)) {
        const output = applyOutputUnit(quantity, outputUnit);
        if (!output.ok) { addError(output.error); evaluating.delete(name); return result; }
        quantity = output.value.quantity; result.value = output.value.displayValue; result.outputUnit = output.value.displayUnit; result.quantity = quantity;
      } else {
        result.quantity = quantity; result.value = toDisplayValue(quantity); result.outputUnit = toDisplayUnit(quantity);
      }
    } else {
      result.quantity = quantity; result.value = toDisplayValue(quantity); result.outputUnit = toDisplayUnit(quantity);
    }

    // ── TOLERANCE PROPAGATION ──────────────────────────────────────────────
    // Tolerance propagation is now handled in Pass 2 below


    // ── Explain steps ──────────────────────────────────────────────────────
    const substituted = substituteIdentifiersForExplain(symbol.ast, (identifier) => {
      if (symbols.has(identifier)) {
        const dep = evaluateSymbol(identifier);
        if (!dep?.quantity) return undefined;
        return { value: toDisplayValue(dep.quantity), unit: toDisplayUnit(dep.quantity) };
      }
      if (externalValues.has(identifier)) {
        const extQ = resolveExternalQuantity(identifier);
        if (extQ) return { value: toDisplayValue(extQ), unit: toDisplayUnit(extQ) };
        const fallback = externalValues.get(identifier);
        return typeof fallback === "number" ? { value: fallback, unit: externalUnits.get(identifier) } : undefined;
      }
      return undefined;
    });
    result.expanded = printExpression(substituted);
    const resolvedDependencies: string[] = [];
    for (const depName of symbol.dependencies) {
      if (symbols.has(depName)) {
        const dep = evaluateSymbol(depName);
        const resolved = formatResolvedDependency(depName, dep?.quantity);
        if (resolved) resolvedDependencies.push(resolved);
        continue;
      }
      const extQ = resolveExternalQuantity(depName);
      const resolved = formatResolvedDependency(depName, extQ, externalValues.get(depName));
      if (resolved) resolvedDependencies.push(resolved);
    }
    result.resolvedDependencies = resolvedDependencies;
    result.explainSteps = buildExplainSteps(result.expanded, { lookup: (fn, args) => csvLookup(fn, args), maxSteps: 16 });
    if (typeof result.value === "number" && Number.isFinite(result.value)) {
      const last = result.explainSteps[result.explainSteps.length - 1];
      const finalStep = `= ${formatExplainNumber(result.value)}`;
      if (last !== finalStep) result.explainSteps.push(finalStep);
    }
    if (symbol.declaredUnit && quantity && result.outputUnit && !result.errors.length && !result.warnings.length) {
      if (result.outputUnit === formatDimension(quantity.dimension))
        addWarning(`output unit fallback used (${result.outputUnit}) because no canonical unit mapping was found`);
    }
    evaluating.delete(name);
    return result;
  };

  const sampleCache = new Map<string, Float64Array>();
  const SAMPLES_COUNT = 10000;
  const uncertaintyCache = new Map<string, boolean>();

  function checkUncertainty(name: string, visiting = new Set<string>()): boolean {
    if (uncertaintyCache.has(name)) return uncertaintyCache.get(name)!;
    if (visiting.has(name)) return false;
    visiting.add(name);

    const symbol = symbols.get(name);
    if (!symbol) {
      visiting.delete(name);
      return false;
    }
    if (symbol.type === "const") {
      const has = symbol.tolerance?.input !== undefined;
      uncertaintyCache.set(name, has);
      visiting.delete(name);
      return has;
    }
    if (symbol.type === "expr") {
      if (symbol.tolerance?.parameterOverrides) {
        for (const override of Object.values(symbol.tolerance.parameterOverrides)) {
          if (override.uncertainty) {
            uncertaintyCache.set(name, true);
            visiting.delete(name);
            return true;
          }
        }
      }
      for (const depName of symbol.dependencies) {
        if (checkUncertainty(depName, visiting)) {
          uncertaintyCache.set(name, true);
          visiting.delete(name);
          return true;
        }
      }
    }
    uncertaintyCache.set(name, false);
    visiting.delete(name);
    return false;
  }

  function getOrBuildSamples(name: string, seed: number): Float64Array | undefined {
    const cacheKey = `${name}_${seed}`;
    if (sampleCache.has(cacheKey)) return sampleCache.get(cacheKey);

    if (name.startsWith("__array_scale_")) {
      const depName = name.replace("__array_scale_", "");
      const depSymbol = symbols.get(depName);
      const depRange = specToToleranceRange(depSymbol?.tolerance);
      if (depSymbol?.literalValues?.length && depRange?.tol !== undefined) {
        const tolVal = Math.abs(depRange.tol);
        const arr = generateSamplesForInput(
          1.0,
          { type: "percent", value: tolVal },
          { type: "uniform" },
          SAMPLES_COUNT,
          seed
        );
        sampleCache.set(cacheKey, arr);
        return arr;
      }
      return undefined;
    }

    const symbol = symbols.get(name);
    if (!symbol) {
      const extVal = externalValues.get(name);
      if (extVal !== undefined) {
        const arr = new Float64Array(SAMPLES_COUNT);
        arr.fill(extVal);
        sampleCache.set(cacheKey, arr);
        return arr;
      }
      return undefined;
    }

    if (symbol.type === "const") {
      const depEval = evaluated.get(name);
      const val = depEval?.value ?? symbol.literalValue ?? 0;
      if (symbol.tolerance?.input) {
        const spec = symbol.tolerance.input;
        const arr = generateSamplesForInput(val, spec.uncertainty, spec.distribution, SAMPLES_COUNT, seed);
        sampleCache.set(cacheKey, arr);
        return arr;
      } else {
        const arr = new Float64Array(SAMPLES_COUNT);
        arr.fill(val);
        sampleCache.set(cacheKey, arr);
        return arr;
      }
    }

    if (symbol.type === "expr" && symbol.ast) {
      const depEval = evaluated.get(name);
      const val = depEval?.value ?? 0;

      if (!checkUncertainty(name)) {
        const arr = new Float64Array(SAMPLES_COUNT);
        arr.fill(val);
        sampleCache.set(cacheKey, arr);
        return arr;
      }

      const outputSamples = new Float64Array(SAMPLES_COUNT);
      const parameterOverrides = symbol.tolerance?.parameterOverrides ?? {};

      const depSampleArrays = new Map<string, Float64Array>();
      for (const depName of symbol.dependencies) {
        if (parameterOverrides[depName]?.uncertainty) {
          const depSymbol = symbols.get(depName);
          const depEval = evaluated.get(depName);
          const depVal = depEval?.value ?? depSymbol?.literalValue ?? 0;
          const overrideSpec = parameterOverrides[depName];
          const arr = generateSamplesForInput(depVal, overrideSpec.uncertainty, overrideSpec.distribution, SAMPLES_COUNT, seed);
          depSampleArrays.set(depName, arr);
        } else {
          const arr = getOrBuildSamples(depName, seed);
          if (arr) depSampleArrays.set(depName, arr);
        }
      }

      const arrayScales = new Map<string, Float64Array>();
      for (const depName of symbol.dependencies) {
        const depSymbol = symbols.get(depName);
        const depRange = specToToleranceRange(depSymbol?.tolerance);
        if (depSymbol?.literalValues?.length && depRange?.tol !== undefined) {
          const scaleArr = getOrBuildSamples("__array_scale_" + depName, seed);
          if (scaleArr) arrayScales.set(depName, scaleArr);
        }
      }

      for (let i = 0; i < SAMPLES_COUNT; i++) {
        const sampleContext: EvaluationContext = {
          ignoreUnitCompatibility: true,
          resolveIdentifier: (identifier: string): Quantity | undefined => {
            if (symbol.parameters.includes(identifier)) return createDimensionlessQuantity(1.0);

            if (depSampleArrays.has(identifier)) {
              const sVal = depSampleArrays.get(identifier)![i];
              const depEval = evaluated.get(identifier);
              const unit = depEval?.outputUnit ?? depEval?.quantity?.displayUnit;
              const q = unit ? createYamlDataQuantity(sVal, unit) : createQuantity(sVal);
              return q.ok ? q.value : undefined;
            }

            const extValue = externalValues.get(identifier);
            const extUnit = externalUnits.get(identifier);
            if (extUnit) { const q = createYamlDataQuantity(extValue ?? 1.0, extUnit); if (q.ok) return q.value; }
            if (extValue !== undefined) { const q = createQuantity(extValue); if (q.ok) return q.value; }
            return undefined;
          },
          resolveArrayIdentifier: (id: string): Quantity[] | undefined => {
            const base = resolveArrayQuantities(id);
            if (base && arrayScales.has(id)) {
              const scale = arrayScales.get(id)![i];
              return base.map(q => ({ ...q, valueSi: q.valueSi * scale }));
            }
            return base;
          },
          resolveLookup: (fn, args) => csvLookup(fn, args),
          resolveFunctionCall: (functionName, args) => {
            const fnSymbol = symbols.get(functionName);
            if (!fnSymbol?.ast || !fnSymbol.parameters) return undefined;
            
            const boundParameters = new Map<string, Quantity>();
            fnSymbol.parameters.forEach((param, idx) => {
              if (idx < args.length) {
                boundParameters.set(param, args[idx]);
              }
            });

            const fnSampleContext: EvaluationContext = {
              ignoreUnitCompatibility: true,
              resolveIdentifier: (identifier: string): Quantity | undefined => {
                const bound = boundParameters.get(identifier);
                if (bound) return bound;

                const depSamples = getOrBuildSamples(identifier, seed);
                if (depSamples) {
                  const sVal = depSamples[i];
                  const depEval = evaluated.get(identifier);
                  const unit = depEval?.outputUnit ?? depEval?.quantity?.displayUnit;
                  const q = unit ? createYamlDataQuantity(sVal, unit) : createQuantity(sVal);
                  return q.ok ? q.value : undefined;
                }

                const extValue = externalValues.get(identifier);
                const extUnit = externalUnits.get(identifier);
                if (extUnit) { const q = createYamlDataQuantity(extValue ?? 1.0, extUnit); if (q.ok) return q.value; }
                if (extValue !== undefined) { const q = createQuantity(extValue); if (q.ok) return q.value; }
                return undefined;
              },
              resolveArrayIdentifier: (id: string): Quantity[] | undefined => {
                const base = resolveArrayQuantities(id);
                if (base && arrayScales.has(id)) {
                  const scale = arrayScales.get(id)![i];
                  return base.map(q => ({ ...q, valueSi: q.valueSi * scale }));
                }
                return base;
              },
              resolveLookup: (fn, args) => csvLookup(fn, args),
              resolveFunctionCall: (nn, na) => {
                return sampleContext.resolveFunctionCall?.(nn, na);
              }
            };

            const ev = evaluateExpressionAst(fnSymbol.ast, fnSampleContext);
            if (!ev.ok) return undefined;
            let callQuantity = ev.quantity;
            if (fnSymbol.effectiveUnit) {
              const output = applyOutputUnit(callQuantity, fnSymbol.effectiveUnit);
              if (output.ok) callQuantity = output.value.quantity;
            }
            return { ok: true, value: callQuantity };
          }
        };

        const ev = evaluateExpressionAst(symbol.ast, sampleContext);
        if (!ev.ok) {
          outputSamples[i] = NaN;
          continue;
        }

        let q = ev.quantity;
        if (symbol.effectiveUnit) {
          const out = applyOutputUnit(q, symbol.effectiveUnit);
          if (out.ok) {
            outputSamples[i] = out.value.displayValue;
            continue;
          }
        }
        outputSamples[i] = toDisplayValue(q);
      }

      sampleCache.set(cacheKey, outputSamples);
      return outputSamples;
    }

    return undefined;
  }

  for (const name of symbols.keys()) evaluateSymbol(name);

  // Pass 2: Tolerance propagation via Monte Carlo recursive sampling
  for (const name of symbols.keys()) {
    const result = evaluated.get(name);
    if (!result) continue;
    const symbol = symbols.get(name);
    if (!symbol) continue;

    if (checkUncertainty(name)) {
      const seed = symbol.tolerance?.output?.seed ?? 42;
      const samples = getOrBuildSamples(name, seed);
      if (samples) {
        if (symbol.type === "const") {
          const sorted = samples.slice().sort();
          const dist = computeOutputDistribution(sorted);
          if (result.range) {
            result.range.distribution = dist;
          }
        } else {
          const method = symbol.tolerance?.output?.method ?? "worst_case";
          const confidence = symbol.tolerance?.output?.confidence ?? 95;
          const rangeRes = resultFromSamples(samples, method, result.value ?? 0, confidence);
          result.range = {
            ...rangeRes,
            source: "propagated",
          };
        }
      }
    }
  }
  for (const symbol of evaluated.values()) {
    for (const error of symbol.errors) createDiagnostic(diagnostics, symbol.name, symbol.line, "error", error);
    for (const warning of symbol.warnings) createDiagnostic(diagnostics, symbol.name, symbol.line, "warning", warning);
  }
  const missingSuggestions: MissingYamlSuggestion[] = [];
  for (const [name, unit] of externalUnits) {
    if (symbols.has(name)) continue;
    const value = externalValues.get(name);
    missingSuggestions.push({ name, unit, value: Number.isFinite(value ?? Number.NaN) ? value : undefined });
  }
  return { symbols: evaluated, diagnostics, cycles, missingSuggestions };
}