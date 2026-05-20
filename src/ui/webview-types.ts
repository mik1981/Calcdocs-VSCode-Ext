/**
 * Tipi condivisi tra l'estensione VS Code e la WebView React.
 * Copia questo file in: src/ui/webview-types.ts
 */

// ─── Dependency tree nodes ───────────────────────────────────────────────────

export type FormulaInputNode = {
  name: string;
  unit?: string;
  defaultValue?: number;
  hasDefault: boolean;
  kind: 'leaf' | 'formula';
};

export type FormulaTreeNode = {
  id: string;
  name: string;
  expression: string;
  unit?: string;
  depth: number;
  localInputs: FormulaInputNode[];
  children: FormulaTreeNode[];
};

export type FormulaEntry = {
  id: string;
  name: string;
  expression: string;
  unit?: string;
  localInputs?: FormulaInputNode[];
  tree: FormulaTreeNode;
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
      action: 'updateFormulas';
      formulas: FormulaEntry[];
      activeFileName: string;
      selectedFormulaId: string | null;
    }
  | {
      action: 'result';
      value: number | null;
      error?: string;
      steps: EvalStep[];
      /** All intermediate values produced during this evaluation. */
      allValues: Record<string, number>;
    }
  | {
      action: 'inverseResult';
      /** The input parameter that was back-solved. */
      targetParam: string;
      /** The new value found for that parameter. */
      newValue: number;
      error?: string;
      steps: EvalStep[];
      allValues: Record<string, number>;
    }
  | {
      action: 'snapshotSaved';
      snapshot: InteractiveSnapshot;
    }
  | {
      action: 'history';
      entries: HistoryEntry[];
    }
  | {
      action: 'historyUpdated';
      entries: HistoryEntry[];
    }
  | {
      action: 'loadSnapshot';
      snapshot: InteractiveSnapshot;
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
      /**
       * Back-solve: given the current params (minus `solveFor`), find the
       * value of `solveFor` that makes the formula output equal to `targetOutput`.
       */
      action: 'inverseSolve';
      formulaId: string;
      params: Record<string, number>;
      targetOutput: number;
      solveFor: string;
    }
  | {
      action: 'saveSnapshot';
      formulaId: string;
      params: Record<string, number>;
      note?: string;
    }
  | {
      action: 'requestHistory';
    }
  | {
      action: 'loadHistoryEntry';
      id: string;
    }
  | {
      action: 'loadSnapshot';
      id: string;
    }
  | {
      action: 'clearHistory';
    }
  | {
      action: 'exportPdf';
    };

// ─── Initial payload injected into the HTML ──────────────────────────────────

export type CalcDocsInitialData = {
  formulas: FormulaEntry[];
  selectedFormulaId: string | null;
  activeFileName: string;
};