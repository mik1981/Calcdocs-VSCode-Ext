import type { CalcDocsState } from "../core/state";
import type { FormulaEntry as CoreFormulaEntry } from "../types/FormulaEntry";
import {
  parseExpression,
  type ExpressionNode,
} from "../engine/ast";
import {
  evaluateExpressionWithOutputUnit,
  preprocessExpression,
  type EvaluationContext,
} from "../engine/evaluator";
import { createCsvLookupResolver } from "../engine/csvLookup";
import {
  createDimensionlessQuantity,
  createQuantity,
  createQuantityFromData,
  toDisplayUnit,
  toDisplayValue,
  type Quantity,
} from "../engine/units";
import type {
  EvalStep,
  FormulaEntry,
  FormulaInputNode,
  FormulaTreeNode,
} from "./webview-types";

export const MAX_INTERACTIVE_DEPTH = 5;

type FormulaKind = "formula" | "constant" | "leaf";

type SymbolEvaluation = {
  name: string;
  quantity?: Quantity;
  value?: number;
  unit?: string;
  expression?: string;
  errors: string[];
  warnings: string[];
};

export type InteractiveEvaluationResult = {
  rootId: string;
  value: number | null;
  unit?: string;
  values: Record<string, number>;
  units: Record<string, string>;
  errors: Record<string, string[]>;
  warnings: Record<string, string[]>;
  active: string[];
  propagation: string[];
  steps: EvalStep[];
  tree: FormulaTreeNode;
  last?: string;
};

type BuildTreeOptions = {
  evaluation?: InteractiveEvaluationResult;
  overrides?: Record<string, number>;
};

const BUILTIN_IDENTIFIERS = new Set([
  "abs",
  "cos",
  "csv",
  "lookup",
  "sin",
  "table",
  "__unit",
]);

const SUPPRESS_INTERACTIVE_WARNINGS = [
  /missing value for /,
  /incompatible units/i,
  /unit mismatch/i,
];

const SUPPRESS_INTERACTIVE_ERRORS = [
  /unit mismatch/i,
  /incompatible units/i,
];

function isSuppressedInteractiveWarning(message: string): boolean {
  return SUPPRESS_INTERACTIVE_WARNINGS.some((re) => re.test(message));
}

function isSuppressedInteractiveError(message: string): boolean {
  return SUPPRESS_INTERACTIVE_ERRORS.some((re) => re.test(message));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function addUnique(target: string[], message: string): void {
  if (!target.includes(message)) {
    target.push(message);
  }
}

function collectIdentifiersInOrder(expression: string): string[] {
  const identifiers: string[] = [];
  const seen = new Set<string>();

  const push = (name: string): void => {
    if (BUILTIN_IDENTIFIERS.has(name.toLowerCase()) || seen.has(name)) {
      return;
    }
    seen.add(name);
    identifiers.push(name);
  };

  const walk = (node: ExpressionNode): void => {
    switch (node.kind) {
      case "identifier":
        push(node.name);
        return;
      case "number":
      case "string":
        return;
      case "unary":
        walk(node.argument);
        return;
      case "binary":
        walk(node.left);
        walk(node.right);
        return;
      case "call":
        for (const arg of node.args) {
          walk(arg);
        }
        return;
    }
  };

  try {
    walk(parseExpression(preprocessExpression(expression)));
    return identifiers;
  } catch {
    const matcher = /\b([A-Za-z_][A-Za-z0-9_.]*)\b(?!\s*\()/g;
    for (const match of expression.matchAll(matcher)) {
      push(match[1]);
    }
    return identifiers;
  }
}

function getEntryExpression(entry: CoreFormulaEntry): string {
  if (entry.formula) {
    return entry.formula;
  }

  if (isFiniteNumber(entry.valueYaml)) {
    return String(entry.valueYaml);
  }

  if (isFiniteNumber(entry.valueCalc)) {
    return String(entry.valueCalc);
  }

  return "";
}

function getEntryKind(entry: CoreFormulaEntry | undefined): FormulaKind {
  if (!entry) {
    return "leaf";
  }
  // Se l'entry ha una formula stringa complessa è una formula, altrimenti è una costante modificabile
  return (entry.formula && entry.formula.trim().length > 0) ? "formula" : "constant";
}

function getDefaultValue(
  name: string,
  entry: CoreFormulaEntry | undefined,
  state: CalcDocsState
): number | undefined {
  if (isFiniteNumber(entry?.valueYaml)) {
    return entry.valueYaml;
  }

  if (isFiniteNumber(entry?.valueCalc)) {
    return entry.valueCalc;
  }

  const stateValue = state.symbolValues.get(name);
  return isFiniteNumber(stateValue) ? stateValue : undefined;
}

function getUnit(
  name: string,
  entry: CoreFormulaEntry | undefined,
  state: CalcDocsState
): string | undefined {
  return entry?.unit ?? state.symbolUnits.get(name);
}

function createQuantityForSymbol(
  value: number,
  unit: string | undefined
): { quantity?: Quantity; error?: string } {
  const result = unit
    ? createQuantityFromData(value, unit)
    : createQuantity(value);

  if (!result.ok) {
    return { error: result.error };
  }

  return { quantity: result.value };
}

function getRawYamlBlock(entry: CoreFormulaEntry, state: CalcDocsState): string | undefined {
  if (!state.lastYamlRaw || entry._line == null || entry._line < 0) {
    return undefined;
  }

  const lines = state.lastYamlRaw.split(/\r?\n/);
  if (entry._line >= lines.length) {
    return undefined;
  }

  let end = lines.length;
  for (let index = entry._line + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S.*:\s*(?:#.*)?$/.test(line)) {
      end = index;
      break;
    }
  }

  return lines.slice(entry._line, end).join("\n").trimEnd();
}

function formatResolvedExpression(
  expression: string,
  values: Record<string, number>
): string {
  let resolved = expression;
  const names = Object.keys(values).sort((left, right) => right.length - left.length);

  for (const name of names) {
    const value = values[name];
    if (!Number.isFinite(value)) {
      continue;
    }

    resolved = resolved.replace(
      new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"),
      Number.parseFloat(value.toPrecision(8)).toString()
    );
  }

  return resolved;
}

export class InteractiveFormulaEngine {
  private readonly csvLookup: EvaluationContext["resolveLookup"];

  constructor(private readonly state: CalcDocsState) {
    this.csvLookup = createCsvLookupResolver(
      state.csvTables,
      state.lastYamlPath || undefined
    );
  }

  createFormulaEntry(entry: CoreFormulaEntry, options: BuildTreeOptions = {}): FormulaEntry {
    const expression = getEntryExpression(entry);
    const tree = this.buildTree(entry.key, [], 0, options);
    const value = options.evaluation?.values[entry.key] ?? getDefaultValue(entry.key, entry, this.state);
    const rawYaml = getRawYamlBlock(entry, this.state);

    return {
      id: entry.key,
      name: entry.key,
      expression,
      unit: getUnit(entry.key, entry, this.state),
      localInputs: tree.localInputs,
      tree,
      rawYaml,
      value,
      errors: options.evaluation?.errors[entry.key] ?? entry.evaluationErrors,
      warnings: options.evaluation?.warnings[entry.key] ?? entry.evaluationWarnings,
      line: entry._line !== undefined ? entry._line + 1 : undefined,
      type: getEntryKind(entry) === "formula" ? "formula" : "constant",
    };
  }

  evaluate(
    rootId: string,
    overrides: Record<string, number>,
    changedId?: string
  ): InteractiveEvaluationResult {
    const values: Record<string, number> = {};
    const units: Record<string, string> = {};
    const errors: Record<string, string[]> = {};
    const warnings: Record<string, string[]> = {};
    let steps: EvalStep[] = [];
    const memo = new Map<string, SymbolEvaluation>();

    const record = (result: SymbolEvaluation): SymbolEvaluation => {
      if (isFiniteNumber(result.value)) {
        values[result.name] = result.value;
      }
      if (result.unit) {
        units[result.name] = result.unit;
      }
      if (result.errors.length > 0) {
        errors[result.name] = result.errors;
      }
      if (result.warnings.length > 0) {
        warnings[result.name] = result.warnings;
      }
      memo.set(result.name, result);
      return result;
    };

    const evaluateSymbol = (name: string, stack: string[], targetSteps: EvalStep[] = []): SymbolEvaluation => {
      const overrideValue = overrides[name];
      
      // 1. Cerca nell'indice globale (formule locali o globali già caricate)
      let entry = this.state.formulaIndex.get(name);
      
      // VIRTUALIZZAZIONE: Se non esiste e contiene un punto (es: "motore.giri"), 
      // proviamo a risolverla cercando la variabile standalone "giri" o caricandola dal contesto
      if (!entry && name.includes('.')) {
        const parts = name.split('.');
        const bareName = parts[parts.length - 1];
        // Usa il fallback SOLO se il nome nudo non è definito localmente.
        // Se 'vin' esiste nel formulaIndex come costante inline, allora
        // 'config.vin' è un simbolo distinto e non deve alias-are su 'vin'.
        if (!this.state.formulaIndex.has(bareName)) {
          entry = this.state.formulaIndex.get(bareName);
        }
      }

      const unit = getUnit(name, entry, this.state);

      if (isFiniteNumber(overrideValue)) {
        const created = createQuantityForSymbol(overrideValue, unit);
        const result: SymbolEvaluation = {
          name,
          quantity: created.quantity ?? createDimensionlessQuantity(overrideValue),
          value: overrideValue,
          unit,
          errors: [],
          warnings: created.error ? [created.error] : [],
        };
        return record(result);
      }

      const cached = memo.get(name);
      if (cached) {
        return cached;
      }

      const cycleIndex = stack.indexOf(name);
      if (cycleIndex >= 0) {
        const cyclePath = [...stack.slice(cycleIndex), name];
        return record({
          name,
          value: undefined,
          unit,
          errors: [`cyclic dependency detected: ${cyclePath.join(" -> ")}`],
          warnings: [],
        });
      }


      if (!entry) {
        // Gestione dei fallback nel caso di simboli mappati da codice C standard o esterni senza formula espressa
        let externalValue = this.state.symbolValues.get(name);
        
        // Fallback virtualizzato per il valore numerico se ha il punto
        if (externalValue == null && name.includes('.')) {
          const parts = name.split('.');
          const bareName = parts[parts.length - 1];
          // Stesso criterio: non fare fallback se il nome nudo è definito localmente
          if (!this.state.formulaIndex.has(bareName)) {
            externalValue = this.state.symbolValues.get(bareName);
          }
        }

        if (isFiniteNumber(externalValue)) {
          const created = createQuantityForSymbol(externalValue, unit);
          return record({
            name,
            quantity: created.quantity ?? createDimensionlessQuantity(externalValue),
            value: externalValue,
            unit,
            errors: [],
            warnings: created.error ? [created.error] : [],
          });
        }

        return record({
          name,
          unit,
          errors: [],
          warnings: [],
        });
      }

      if (!entry.formula) {
        const value = getDefaultValue(name, entry, this.state);
        if (!isFiniteNumber(value)) {
          return record({
            name,
            unit,
            errors: [`constant '${name}' has no numeric value`],
            warnings: [],
          });
        }

        const created = createQuantityForSymbol(value, unit);
        return record({
          name,
          quantity: created.quantity,
          value,
          unit,
          expression: String(value),
          errors: created.error ? [created.error] : [],
          warnings: [],
        });
      }

      const expression = entry.formula;
      const dependencyErrors: string[] = [];
      const dependencyWarnings: string[] = [];
      const nextStack = [...stack, name];

      const context: EvaluationContext = {
        resolveIdentifier: (identifier) => {
          const dependency = evaluateSymbol(identifier, nextStack, targetSteps);
          for (const error of dependency.errors) {
            addUnique(dependencyErrors, `${identifier}: ${error}`);
          }
          for (const warning of dependency.warnings) {
            // Non propagare "missing value" e unit-mismatch verso il padre:
            // in modalità interattiva sono rumori attesi per parametri liberi.
            if (!isSuppressedInteractiveWarning(warning)) {
              addUnique(dependencyWarnings, `${identifier}: ${warning}`);
            }
          }
          return dependency.quantity;
        },
        resolveLookup: this.csvLookup,
        ignoreUnitCompatibility: true,
        onWarning: (message) => {
          if (!isSuppressedInteractiveWarning(message)) {
            addUnique(dependencyWarnings, message);
          }
        },
      };

      const evaluated = evaluateExpressionWithOutputUnit(expression, context, unit);
      const result: SymbolEvaluation = {
        name,
        expression,
        errors: [],
        warnings: dependencyWarnings,
      };

      if (dependencyErrors.length > 0) {
        result.errors.push(...dependencyErrors);
        return record(result);
      }

      if (!evaluated.ok) {
        if (!isSuppressedInteractiveError(evaluated.error)) {
          result.errors.push(evaluated.error);
        }
        //
        return record(result);
      }

      result.quantity = evaluated.quantity;
      result.value = evaluated.displayValue ?? toDisplayValue(evaluated.quantity);
      result.unit = evaluated.displayUnit ?? toDisplayUnit(evaluated.quantity) ?? unit;

      targetSteps.push({
        name,
        expression,
        resolved: formatResolvedExpression(expression, values),
        result: result.value,
        unit: result.unit,
        depth: stack.length, // 0 = radice, 1 = dipendenza diretta, …
      });

      return record(result);
    };

    const rootResult = evaluateSymbol(rootId, [], steps);

    for (const [name] of this.state.formulaIndex) {
      if (!memo.has(name)) {
        evaluateSymbol(name, []);
      }
    }

    const baseResult: InteractiveEvaluationResult = {
      rootId,
      value: isFiniteNumber(rootResult.value) ? rootResult.value : null,
      unit: rootResult.unit,
      values,
      units,
      errors,
      warnings,
      active: Object.keys(values),
      propagation: this.collectPropagation(rootId, changedId),
      steps,
      tree: {} as FormulaTreeNode,
      last: changedId,
    };

    baseResult.tree = this.buildTree(rootId, [], 0, {
      evaluation: baseResult,
      overrides,
    });

    return baseResult;
  }

  private buildTree(
    name: string,
    path: string[],
    depth: number,
    options: BuildTreeOptions
  ): FormulaTreeNode {
    const entry = this.state.formulaIndex.get(name);
    const kind = getEntryKind(entry);
    const unit = getUnit(name, entry, this.state);
    const expression = entry ? getEntryExpression(entry) : "";
    const instanceId = [...path, name].join("/");
    const cycleIndex = path.indexOf(name);
    const nodeErrors = [
      ...(options.evaluation?.errors[name] ?? entry?.evaluationErrors ?? [])
    ].filter(msg => !isSuppressedInteractiveError(msg));
    const nodeWarnings = [
      ...(options.evaluation?.warnings[name] ?? entry?.evaluationWarnings ?? [])
    ].filter(msg => !isSuppressedInteractiveWarning(msg));
    const resultValue = options.evaluation?.values[name] ?? getDefaultValue(name, entry, this.state);
    const resultUnit = options.evaluation?.units[name] ?? unit;

    if (cycleIndex >= 0) {
      const cyclePath = [...path.slice(cycleIndex), name];
      addUnique(nodeErrors, `cyclic dependency detected: ${cyclePath.join(" -> ")}`);
      return {
        id: name,
        instanceId,
        name,
        expression,
        unit,
        depth,
        localInputs: [],
        children: [],
        rawYaml: entry ? getRawYamlBlock(entry, this.state) : undefined,
        sourceFile: entry?._filePath,
        line: entry?._line !== undefined ? entry._line + 1 : undefined,
        type: kind,
        result: {
          value: resultValue,
          unit: resultUnit,
          error: nodeErrors[0],
        },
        errors: nodeErrors,
        warnings: nodeWarnings,
        cycle: true,
        cyclePath,
      };
    }

    const localInputs: FormulaInputNode[] = [];
    const children: FormulaTreeNode[] = [];
    const dependencies = entry?.formula ? collectIdentifiersInOrder(entry.formula) : [];
    const nextPath = [...path, name];

    for (const dependency of dependencies) {
      let dependencyEntry = this.state.formulaIndex.get(dependency);
      
      // Se non lo trova con il prefisso completo, usa la virtualizzazione per pescare i dati di default
      if (!dependencyEntry && dependency.includes('.')) {
        const parts = dependency.split('.');
        const bareName = parts[parts.length - 1];
        if (!this.state.formulaIndex.has(bareName)) {
          dependencyEntry = this.state.formulaIndex.get(bareName);
        }
      }

      const dependencyKind = getEntryKind(dependencyEntry);
      const sourceFormulaId = dependencyEntry?.formula ? dependency : undefined;
      const currentValue = options.evaluation?.values[dependency];
      const defaultValue = getDefaultValue(dependency, dependencyEntry, this.state);
      
      const dependencyUnit =
        options.evaluation?.units[dependency] ??
        getUnit(dependency, dependencyEntry, this.state);
        
      const isOverridden = isFiniteNumber(options.overrides?.[dependency]);
      const isFormula = dependencyKind === "formula";
      const inputErrors = options.evaluation?.errors[dependency] ?? dependencyEntry?.evaluationErrors;
      const inputWarnings = options.evaluation?.warnings[dependency] ?? dependencyEntry?.evaluationWarnings;

      // Determina se l'origine è un simbolo cross-file virtualizzato
      const isCrossFile = dependency.includes('.');

      localInputs.push({
        name: dependency, // <--- Mantiene il nome con il prefisso (es: "sensori.temperatura")
        unit: dependencyUnit,
        defaultValue,
        currentValue: currentValue ?? defaultValue,
        hasDefault: isFiniteNumber(defaultValue),
        kind: isFormula
          ? "formula"
          : dependencyEntry
            ? "constant"
            : this.state.symbolValues.has(dependency) || isCrossFile
              ? "external"
              : "unknown",
        origin: isFormula
          ? "yaml-formula"
          : isCrossFile
            ? "cpp-symbol" // Trattato come input virtuale modificabile
            : dependencyEntry
              ? "yaml-constant"
              : "unknown",
        sourceFormulaId,
        expression: dependencyEntry?.formula,
        editable: !isFormula, // Se non è una formula annidata complessa, permette l'input numerico nella UI
        overridden: isOverridden,
        calculated: isFormula || currentValue !== undefined,
        errors: inputErrors,
        warnings: inputWarnings,
      });

      if (!isFormula) {
        continue;
      }

      if (depth >= MAX_INTERACTIVE_DEPTH) {
        children.push({
          id: dependency,
          instanceId: [...nextPath, dependency].join("/"),
          name: dependency,
          expression: dependencyEntry?.formula ?? "",
          unit: dependencyUnit,
          depth: depth + 1,
          localInputs: [],
          children: [],
          rawYaml: dependencyEntry ? getRawYamlBlock(dependencyEntry, this.state) : undefined,
          sourceFile: dependencyEntry?._filePath,
          line: dependencyEntry?._line !== undefined ? dependencyEntry._line + 1 : undefined,
          type: "formula",
          result: {
            value: currentValue,
            unit: dependencyUnit,
            error: inputErrors?.[0],
          },
          errors: inputErrors,
          warnings: inputWarnings,
          depthLimited: true,
        });
        continue;
      }

      children.push(this.buildTree(dependency, nextPath, depth + 1, options));
    }

    return {
      id: name,
      instanceId,
      name,
      expression,
      unit,
      depth,
      localInputs,
      children,
      rawYaml: entry ? getRawYamlBlock(entry, this.state) : undefined,
      sourceFile: entry?._filePath,
      line: entry?._line !== undefined ? entry._line + 1 : undefined,
      type: kind,
      result: {
        value: resultValue,
        unit: resultUnit,
        error: nodeErrors[0],
      },
      errors: nodeErrors,
      warnings: nodeWarnings,
    };
  }

  private collectPropagation(rootId: string, changedId: string | undefined): string[] {
    if (!changedId) {
      return [];
    }

    const affected = new Set<string>();
    const visits = new Set<string>();

    const visit = (name: string): boolean => {
      if (name === changedId) {
        affected.add(name);
        return true;
      }

      const visitKey = `${name}:${changedId}`;
      if (visits.has(visitKey)) {
        return false;
      }
      visits.add(visitKey);

      const entry = this.state.formulaIndex.get(name);
      if (!entry?.formula) {
        return false;
      }

      let childAffected = false;
      for (const dependency of collectIdentifiersInOrder(entry.formula)) {
        if (visit(dependency)) {
          childAffected = true;
        }
      }

      if (childAffected) {
        affected.add(name);
      }

      return childAffected;
    };

    visit(rootId);
    return Array.from(affected);
  }
}

export function buildInteractiveFormulaEntries(
  state: CalcDocsState,
  entries: CoreFormulaEntry[],
  engine = new InteractiveFormulaEngine(state)
): FormulaEntry[] {
  return entries.map((entry) => engine.createFormulaEntry(entry));
}
