/**
 * Tipi condivisi tra l'estensione VS Code e la WebView React.
 * Copia questo file in: src/ui/webview-types.ts
 */

// ─── Dependency tree nodes ───────────────────────────────────────────────────

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
  };
  errors?: string[];
  warnings?: string[];
  cycle?: boolean;
  cyclePath?: string[];
  depthLimited?: boolean;
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
};

// ─── Evaluation primitives ────────────────────────────────────────────────────

export type EvalStep = {
  name: string;
  expression: string;
  resolved: string;
  result: number;
  unit?: string;
  depth?: number; // livello di annidamento (0 = formula radice)
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
