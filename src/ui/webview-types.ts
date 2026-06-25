import { TolMode } from "../types/FormulaEntry";

/**
 * Tipi condivisi tra l'estensione VS Code e la WebView React.
 * Copia questo file in: src/ui/webview-types.ts
 */

// ─── Dependency tree nodes ───────────────────────────────────────────────────
/** Subset of OutputDistribution passed through the webview protocol. */
export interface OutputDistribution {
  samples: number;
  mean: number;
  median: number;
  stddev: number;
  min: number;
  max: number;
  p001: number;
  p010: number;
  p025: number;
  p500: number;
  p975: number;
  p990: number;
  p999: number;
  skewness: number;
  kurtosis: number;
  /** Pre-computed histogram from MC samples. Webview renders counts[] directly. */
  histogram: {
    counts: number[];
    lo: number;
    hi: number;
  };
}

export type FormulaInputNode = {
  name: string;
  unit?: string;
  defaultValue?: number;
  currentValue?: number;
  hasDefault: boolean;
  kind: 'leaf' | 'formula' | 'constant' | 'external' | 'unknown';
  origin?: 'yaml-formula' | 'yaml-constant' | 'cpp-symbol' | 'user-override' | 'unknown';
  sourceFormulaId?: string;
  expression?: string;
  editable?: boolean;
  overridden?: boolean;
  calculated?: boolean;
  errors?: string[];
  warnings?: string[];
};

export type FormulaTreeNode = {
  id: string;
  instanceId?: string;
  name: string;
  expression: string;
  unit?: string;
  depth: number;
  localInputs: FormulaInputNode[];
  children: FormulaTreeNode[];
  rawYaml?: string;
  sourceFile?: string;
  line?: number;
  type?: 'formula' | 'constant' | 'leaf';
  result?: {
    value?: number;
    unit?: string;
    error?: string;
    range?: {
      min: number;
      max: number;
      source: 'declared' | 'propagated';
      method?: string;
      nominalValue?: number;
      stddev?: number;
      distribution?: OutputDistribution;
    };
  };
  errors?: string[];
  warnings?: string[];
  cycle?: boolean;
  cyclePath?: string[];
  depthLimited?: boolean;
  range?: {
    min: number;
    max: number;
    source: 'declared' | 'propagated';
    method?: string;
    nominalValue?: number;
    stddev?: number;
    distribution?: OutputDistribution;
  };
};

export type FormulaEntry = {
  id: string;
  name: string;
  expression: string;
  unit?: string;
  localInputs?: FormulaInputNode[];
  tree: FormulaTreeNode;
  rawYaml?: string;
  value?: number;
  errors?: string[];
  warnings?: string[];
  line?: number;
  type?: 'formula' | 'constant';
  range?: {
    min: number;
    max: number;
    source: 'declared' | 'propagated';
    method?: string;
    nominalValue?: number;
    stddev?: number;
    distribution?: OutputDistribution;
  };
};

// ─── Evaluation primitives ────────────────────────────────────────────────────

export type EvalStep = {
  name: string;
  expression: string;
  resolved: string;
  result: number;
  unit?: string;
  depth?: number; // livello di annidamento (0 = formula radice)
  range?: {
    min: number;
    max: number;
    source: 'declared' | 'propagated';
    method?: string;
    nominalValue?: number;
    stddev?: number;
    distribution?: OutputDistribution;
  };
  /**
   * Tolleranze note sui parametri d'ingresso di questa formula.
   * Ogni voce corrisponde a un parametro dichiarato nel tolerance.parameters YAML.
   * Se vuoto significa che non ci sono tolleranze note sugli input.
   */
  inputTolerances?: Array<{
    name: string;
    source: 'declared' | 'propagated' | 'unknown';
    tol?: number;
    min?: number;
    max?: number;
  }>;
};


/** Full snapshot of every computed intermediate value during one evaluation. */
export type EvaluationState = {
  /** Raw user-supplied inputs (overrides). */
  params: Record<string, number>;
  /** All intermediate + final values produced by the engine. */
  results: Record<string, number>;
};

// ─── History ──────────────────────────────────────────────────────────────────

export type HistoryDirection = 'forward' | 'inverse';

/**
 * One entry in the modification history.
 *
 * `forward`  = user edited an input  → engine propagated forward to output.
 * `inverse`  = user edited the output → engine back-solved a chosen input.
 */
export type HistoryEntry = {
  id: string;
  ts: number;
  formulaId: string;
  /** Which variable the user explicitly changed. */
  changedParam: string;
  changedValue: number;
  direction: HistoryDirection;
  state: EvaluationState;
  result: number | null;
  steps: EvalStep[];
};

// ─── Named snapshots (user-saved) ────────────────────────────────────────────

export type InteractiveSnapshot = {
  id: string;
  ts: number;
  formulaId: string;
  params: Record<string, number>;
  note?: string;
  result?: number | null;
  steps?: EvalStep[];
};

// ─── Messages: Extension → WebView ───────────────────────────────────────────

export type ExtensionToWebviewMsg =
  | {
      action: 'updateResult';
      values: Record<string, number>;
      units?: Record<string, string>;
      errors?: Record<string, string[]>;
      warnings?: Record<string, string[]>;
      active: string[];
      propagation: string[];
      tree?: FormulaTreeNode;
      params?: Record<string, number>;
      steps?: EvalStep[];
      last?: string;
    }
  | {
      action: 'historyUpdated';
      entries: HistoryEntry[];
    }
  | {
      action: 'updateFormulas';
      formulas: FormulaEntry[];
      selectedFormulaId: string | null;
      activeFileName: string;
    }
  | {
      action: 'forceSelect';
      formulaId: string;
    };

// ─── Messages: WebView → Extension ───────────────────────────────────────────

export type WebviewToExtensionMsg =
  | {
      action: 'evaluate';
      formulaId: string;
      params: Record<string, number>;
    }
  | {
      action: 'updateInput';
      formulaId: string;
      inputs: Record<string, number>;
      changedId: string;
    };

// ─── Initial payload injected into the HTML ──────────────────────────────────

export type CalcDocsInitialData = {
  formulas: FormulaEntry[];
  selectedFormulaId: string | null;
  activeFileName: string;
};
