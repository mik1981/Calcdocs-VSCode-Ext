import * as vscode from 'vscode';
import { DecorationRangeBehavior } from 'vscode';
import type { TextDocument } from 'vscode';
import { OutlineFormula } from './formulaParser';
import { FormulaRegistry } from './formulaRegistry';
import { createCsvLookupResolver } from '../engine/csvLookup';
import type { CsvTableMap } from '../core/csvTables';
import {
  buildFormulaSymbolTable,
  resolveFormulaValue,
  scaleValueToUnit,
  formatGhostNumber,
  MATH_SCOPE,
  UNIT_SYMBOLS,
  suggestUnits,
} from './formulaEvaluator';
import { getUnitSpec, parseUnitToQuantity } from "../engine/units";
import { inferDimension, getUnitDim, type Dim } from './dimensionEvaluator';
import { UNIT_SPECS } from '../engine/units';
import { formatNumbersWithThousandsSeparator } from '../utils/nformat';
import type { CalcDocsState } from '../core/state';

export function normalizeGhostUnitLabel(rawUnit?: string): string | undefined {
  if (!rawUnit) {
    return undefined;
  }

  const cleaned = rawUnit.trim().replace(/^\[+/, "").replace(/\]+$/, "").trim();
  if (!cleaned) {
    return undefined;
  }

  // Prova prima come token atomico (es. "A", "V", "Ohm")
  const spec = getUnitSpec(cleaned);
  if (spec) return spec.canonical;

  // Fallback: prova come espressione di unità composta (es. "A^2", "A*V", "N*m")
  const parsed = parseUnitToQuantity(cleaned);
  if (parsed.ok) return cleaned;

  return cleaned;
}

export function formatGhostParamEntry(name: string, value: number, rawUnit?: string): string {
  const valueText = `${name}=${formatGhostNumber(value)}`;
  const unitText = normalizeGhostUnitLabel(rawUnit);
  if (!unitText) {
    return valueText;
  }

  if (/\[[^\]]+\]\s*$/.test(valueText)) {
    return valueText;
  }

  return `${valueText} [${unitText}]`;
}

/**
 * Suggerisci un'unità basata sulla dimensione calcolata della formula.
 * Cerca il primo UNIT_SPEC che corrisponde alla dimensione.
 */
function suggestUnitFromDimension(dim: Dim): string | undefined {
  if (!dim) return undefined;

  // Cerca tra tutti gli UNIT_SPECS uno che corrisponda a questa dimensione
  for (const [, spec] of UNIT_SPECS) {
    if (
      spec.dimension.M === dim.M &&
      spec.dimension.L === dim.L &&
      spec.dimension.T === dim.T &&
      spec.dimension.I === dim.I &&
      spec.dimension.K === dim.K
    ) {
      return spec.canonical;
    }
  }

  return undefined;
}

export class FormulaOutlineProvider implements vscode.FoldingRangeProvider {
  private foldingRanges = new WeakMap<TextDocument, vscode.FoldingRange[]>();
  /**
   * Optional getter for CalcDocsState (needed for thousands separator config).
   * Pass `() => state` from extension.ts.
   */
  private _getState: (() => CalcDocsState) | undefined;
  private decorations = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: '',
      color: { id: 'editorGhostText.foreground' },
      fontStyle: 'italic',
      margin: '0 0 0 12px'
    }
  });

  private keyDecoConstant = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'hsla(220, 60%, 40%, 0.3)',
    fontWeight: 'bold',
    border: '1px solid hsla(220, 60%, 40%, 0.5)',
    rangeBehavior: DecorationRangeBehavior.ClosedClosed,
    color: 'hsla(220, 60%, 40%, 1)',
    overviewRulerColor: 'hsla(220, 60%, 50%, 0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Right
  });

  private keyDecoFull = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'hsla(120, 60%, 40%, 0.3)',
    fontWeight: 'bold',
    border: '1px solid hsla(120, 60%, 40%, 0.5)',
    rangeBehavior: DecorationRangeBehavior.ClosedClosed,
    color: 'hsla(120, 60%, 40%, 1)',
    overviewRulerColor: 'hsla(120, 60%, 50%, 0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Right
  });

  private keyDecoParam = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'hsla(39, 100%, 50%, 0.3)',
    fontWeight: 'bold',
    border: '1px solid hsla(39, 100%, 50%, 0.5)',
    rangeBehavior: DecorationRangeBehavior.ClosedClosed,
    color: 'hsla(39, 100%, 50%, 1)',
    overviewRulerColor: 'hsla(39, 100%, 50%, 0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Right
  });

  private keyDecoExternal = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'hsla(280, 60%, 40%, 0.3)',
    border: '1px solid hsla(280, 60%, 40%, 0.5)',
    color: 'hsla(280, 60%, 40%, 1)',
    overviewRulerColor: 'hsla(280, 60%, 50%, 0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Right
  });

  private fieldDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'hsla(0, 0%, 60%, 0.2)',
    fontStyle: 'italic',
    color: 'hsla(0, 0%, 40%, 1)'
  });

  private opDeco = vscode.window.createTextEditorDecorationType({
    color: 'hsla(39, 100%, 50%, 1)',
    fontWeight: 'bold'
  });

  private missingVarDeco = vscode.window.createTextEditorDecorationType({
    border: '1px dashed rgba(255, 80, 80, 0.9)',
    backgroundColor: 'rgba(255, 80, 80, 0.15)',
    color: 'rgba(255, 120, 120, 1)',
    fontWeight: 'bold',
    overviewRulerColor: 'rgba(255, 80, 80, 0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Right
  });

  private _registry: FormulaRegistry;
  /**
   * Optional getter for the C/C++ resolved symbol values from state.symbolValues.
   * Called lazily on every decoration refresh so it always reflects the latest analysis.
   * Pass `() => state.symbolValues` from extension.ts.
   */
  private _getSymbolValues: () => Map<string, number>;
  private _getSymbolUnits: () => Map<string, string>;

  /**
   * Optional getter for CSV tables from state.csvTables.
   */
  private _getCsvTables: () => CsvTableMap;

  constructor(
    registry: FormulaRegistry,
    getSymbolValues?: () => Map<string, number>,
    getSymbolUnits?: () => Map<string, string>,
    getCsvTables?: () => CsvTableMap,
    getState?: () => CalcDocsState
  ) {
    this._registry = registry;
    this._getSymbolValues = getSymbolValues ?? (() => new Map());
    this._getSymbolUnits = getSymbolUnits ?? (() => new Map());
    this._getCsvTables = getCsvTables ?? (() => new Map());
    this._getState = getState;

    vscode.workspace.onDidChangeTextDocument(this.onDocumentChanged, this);
    vscode.workspace.onDidOpenTextDocument(this.onDocumentOpened, this);
    vscode.window.onDidChangeVisibleTextEditors(this.onEditorsChanged, this);

    // Inizializzazione immediata per i file già aperti all'avvio
    this.initExistingEditors();
  }

  private async initExistingEditors() {
    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document;
      if (doc.languageId === 'yaml' && /.*formulas.*\.yaml$/i.test(doc.fileName.toLowerCase())) {
        await this._registry.parseDocument(doc);
        await this.updateFolding(doc);
        this.applyDecorations(editor);
      }
    }
  }

  private async onDocumentOpened(doc: vscode.TextDocument) {
    if (doc.languageId !== 'yaml') return;
    if (!/.*formulas.*\.yaml$/i.test(doc.fileName.toLowerCase())) return;

    await this._registry.parseDocument(doc);
    await this.updateFolding(doc);

    // Immediate activation for active editor
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor?.document === doc) {
      this.applyDecorations(activeEditor);
    }

    // Fallback for visible editors (reduced delay)
    setTimeout(() => {
      const editors = vscode.window.visibleTextEditors.filter(ed => ed.document === doc);
      for (const editor of editors) {
        this.applyDecorations(editor);
      }
    }, 0);
  }

  private onEditorsChanged(editors: readonly vscode.TextEditor[]) {
    editors.forEach(editor => {
      if (
        editor.document.languageId === 'yaml' &&
        /.*formulas.*\.yaml$/i.test(editor.document.fileName.toLowerCase())
      ) {
        this.applyDecorations(editor);
      }
    });
  }

  private async onDocumentChanged(e: vscode.TextDocumentChangeEvent) {
    if (e.document.languageId !== 'yaml') return;
    if (!/.*formulas.*\.yaml$/i.test(e.document.fileName.toLowerCase())) return;

    await this._registry.parseDocument(e.document);
    await this.updateFolding(e.document);
    const editors = vscode.window.visibleTextEditors.filter(ed => ed.document === e.document);
    for (const editor of editors) {
      this.applyDecorations(editor);
    }
  }

  // ---------------------------------------------------------------------------
  // Public refresh — called by extension after a C/C++ analysis completes so
  // that ghost values pick up newly resolved macro values (e.g. MUL, ADC_MAX).
  // ---------------------------------------------------------------------------

  /**
   * Re-applies decorations on all visible formulas*.yaml editors.
   * Call this after `runAnalysis` updates `state.symbolValues`.
   */
  public refreshDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      if (
        editor.document.languageId === 'yaml' &&
        /.*formulas.*\.yaml$/i.test(editor.document.fileName.toLowerCase())
      ) {
        this.applyDecorations(editor);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Decoration rendering
  // ---------------------------------------------------------------------------

  private async applyDecorations(editor: vscode.TextEditor) {
    const uri = editor.document.uri.toString();
    const formulas = await this._registry.getFormulas(uri);
    const doc = editor.document;

    const ghostDecos: vscode.DecorationOptions[] = [];
    const keyConstant: vscode.DecorationOptions[] = [];
    const keyFull: vscode.DecorationOptions[] = [];
    const keyParam: vscode.DecorationOptions[] = [];
    const keyExternal: vscode.DecorationOptions[] = [];
    const fieldDecos: vscode.DecorationOptions[] = [];
    const opDecos: vscode.DecorationOptions[] = [];
    const missingVarDecos: vscode.DecorationOptions[] = [];

    const cSymbols = this._getSymbolValues();
    const cSymbolUnits = this._getSymbolUnits();
    const csvTables = this._getCsvTables();
    const lookupResolver = createCsvLookupResolver(csvTables, editor.document.uri.fsPath);
    const formulaUnitsById = new Map<string, string>();
    for (const item of formulas) {
      const normalizedUnit = normalizeGhostUnitLabel(item.unit);
      if (!normalizedUnit) {
        continue;
      }
      formulaUnitsById.set(item.id, normalizedUnit);
    }

    const symbolTable = buildFormulaSymbolTable(formulas, cSymbols, lookupResolver);

    const mathFunctions = new Set(
      Object.keys(MATH_SCOPE).map(k => k.toLowerCase())
    );

    for (const formula of formulas) {
      const lineLength = doc.lineAt(formula.lineStart).text.length;

      // resolveFormulaValue returns the raw SI-unit value.
      // Unit scaling to the formula's `unit:` field is applied below at display time.
      const evalResult = resolveFormulaValue(formula, symbolTable, cSymbols, lookupResolver);

      const hasExpr = !!formula.expr;
      const hasExternal = /(csv|table|lookup)/i.test(formula.expr || '');
      const isPureConstant = !hasExpr;
      const isResolved = evalResult.resolved !== null; // ✅ FIX importante

      type FormulaKind = 'constant' | 'computed' | 'external' | 'parametric' | 'fallback';

      let kind: FormulaKind;

      if (isPureConstant) {
        kind = 'constant';
      } else if (hasExternal) {
        kind = isResolved ? 'external' : 'parametric';
      } else if (isResolved) {
        kind = 'computed';
      } else if (evalResult.source === 'value') {
        kind = 'fallback';
      } else {
        kind = 'parametric';
      }

      // ---------------- KEY ----------------
      const keyLine = doc.lineAt(formula.lineStart);
      const colonIndex = keyLine.text.indexOf(':');

      if (colonIndex > 0) {
        const keyRange = new vscode.Range(formula.lineStart, 0, formula.lineStart, colonIndex);

        if (kind === 'constant') keyConstant.push({ range: keyRange });
        else if (kind === 'computed') keyFull.push({ range: keyRange });
        else if (kind === 'external') keyExternal.push({ range: keyRange });
        else keyParam.push({ range: keyRange });
      }

      // ---------------- FIELDS + OPS + MISSING ----------------
      for (let l = formula.lineStart + 1; l <= formula.lineEnd; l++) {
        const lineText = doc.lineAt(l).text;

        // fields
        if (/^( +)?(formula|unit|steps|value):/.test(lineText)) {
          fieldDecos.push({
            range: new vscode.Range(l, 0, l, lineText.indexOf(':') + 1)
          });
        }

        // operators
        const opRegex = /([+*\/\-()])|csv|sin|table|lookup/gi;
        let match;
        while ((match = opRegex.exec(lineText)) !== null) {
          opDecos.push({
            range: new vscode.Range(l, match.index, l, match.index + match[0].length)
          });
        }

        // missing vars — only on `formula:` lines
        if (/^\s*formula\s*:/.test(lineText)) {
          const exprPart = lineText.split(':').slice(1).join(':');

          let cleanExpr = exprPart.replace(/(csv|table|lookup)\([^)]*\)/gi, '');
          cleanExpr = cleanExpr.replace(/\b\d+(\.\d+)?\s*[a-zA-Z]+\b/g, '');
          cleanExpr = cleanExpr.replace(/\b\d+(\.\d+)?[a-zA-Z]+\b/g, '');

          const symbols = cleanExpr.match(/[A-Z_][A-Z0-9_]*/gi) || [];

          for (const sym of symbols) {
            const symLower = sym.toLowerCase();

            if (mathFunctions.has(symLower)) continue;
            if (UNIT_SYMBOLS.has(symLower)) continue;

            const isKnown =
              symbolTable.has(sym) ||
              cSymbols.has(sym) ||
              formulas.some(f => f.id === sym); 
              
            if (!isKnown) {
              let idx = lineText.indexOf(sym);
              while (idx !== -1) {
                const before = lineText.slice(0, idx);
                const insideFunction = /(csv|table|lookup)\([^)]*$/.test(before);

                if (!insideFunction) {
                  missingVarDecos.push({
                    range: new vscode.Range(l, idx, l, idx + sym.length),
                    hoverMessage: `$(warning) Variabile non risolta: ${sym}`
                  });
                }

                idx = lineText.indexOf(sym, idx + sym.length);
              }
            }
          }
        }
      }

      // ---------------- DERIVAZIONE AUTOMATICA ----------------
      // Se non c'è formula espressa ma c'è value, deriva la formula dal value
      let derivedExpr = formula.expr;
      let derivedUnit = formula.unit;
      let formulaWasDerived = false;

      if (!formula.expr && formula.value !== null && formula.value !== undefined) {
        // Deriva formula dal value (es: value: 24 → formula: "24")
        derivedExpr = String(formula.value);
        formulaWasDerived = true;

        // Se non c'è unità espressa, prova a derivarla dalla dimensione
        if (!formula.unit) {
          const inferResult = inferDimension(derivedExpr, formulas, undefined);
          if (inferResult.dim) {
            const suggestedUnit = suggestUnitFromDimension(inferResult.dim);
            if (suggestedUnit) {
              derivedUnit = suggestedUnit;
            }
          }
        }
      }

      // Valuta la formula derivata se necessario
      let derivedEvalResult = evalResult;
      if (formulaWasDerived) {
        const tempFormula: OutlineFormula = {
          ...formula,
          expr: derivedExpr,
        };
        derivedEvalResult = resolveFormulaValue(tempFormula, symbolTable, cSymbols, lookupResolver);
      }

      // Ricalcola isResolved con la formula derivata
      const isResolvedFinal = derivedEvalResult.resolved !== null;

      // Ricalcola kindFinal considerando la formula derivata
      let kindFinal: FormulaKind = kind;
      if (formulaWasDerived && !hasExternal && isResolvedFinal) {
        kindFinal = 'computed';
      }

      // Ricalcola normalizedUnitFinal con l'unità derivata
      const normalizedUnitFinal = normalizeGhostUnitLabel(derivedUnit);
      const unitKnownFinal = normalizedUnitFinal
        ? (getUnitSpec(normalizedUnitFinal) !== undefined || parseUnitToQuantity(normalizedUnitFinal).ok)
        : false;

      // ---------------- UNITA' SCONOSCIUTA + SUGGERIMENTI ----------------
      const normalizedUnit = normalizeGhostUnitLabel(formula.unit);
      // Verifica se l'unità è valida: supporta sia token atomici (es. "V")
      // che espressioni composte (es. "A^2", "A*V", "N/m")
      const unitKnown = normalizedUnit
        ? (getUnitSpec(normalizedUnit) !== undefined || parseUnitToQuantity(normalizedUnit).ok)
        : false;

      let unitWarning = '';

      if (normalizedUnit && !unitKnown) {
        const suggestions = suggestUnits(normalizedUnit);

        unitWarning = suggestions.length
          ? ` ⚠ unknown (did you mean: ${suggestions.join(', ')})`
          : ' ⚠ unknown unit';
      }

      // ---------------- VALUE ----------------
      // Scale the raw SI result to the formula's declared display unit
      // before formatting. This mirrors inlineCalc.ts `formatWithOutputUnit`:
      //   converted = rawValue / spec.factor
      //
      // Examples:
      //   unit:'mV', raw=3.3   → scaled=3300,  display="3300 [mV]"
      //   unit:'kHz', raw=50000 → scaled=50,   display="50 [kHz]"
      //   unit:'V', raw=3.3    → scaled=3.3,   display="3.3 [V]"
      let valueText: string;

      if (isResolvedFinal) {
        if (unitKnownFinal) {
          const scaled = scaleValueToUnit(derivedEvalResult.resolved!, derivedUnit);
          valueText = formatGhostNumber(scaled);
        } else {
          // ⚠ unit sconosciuta → mostra valore raw senza "?"
          valueText = formatGhostNumber(derivedEvalResult.resolved!);
        }
      } else {
        // Se la formula non è risolta e non è stata derivata dal value, mostra "?"
        // Se è stata derivata dal value (costante), mostra il valore
        if (formulaWasDerived) {
          valueText = derivedEvalResult.resolved !== null 
            ? formatGhostNumber(derivedEvalResult.resolved)
            : '—';
        } else {
          valueText = hasExpr ? '?' : '—';
        }
      }

      if (normalizedUnitFinal) {
        if (unitKnownFinal) {
          valueText += ` [${normalizedUnitFinal}]`;
        }
        else {
          valueText += ` [${normalizedUnitFinal} ⛔]`;
        }
      }
      

      switch (kindFinal) {
        case 'external':
          valueText += ' 📥';
          break;
        case 'fallback':
          if (!formulaWasDerived) {
            valueText += ' ⚠ fallback';
          }
          break;
      }

      // ---------------- VARIABLES ----------------
      // Variable sub-values are shown as raw SI values (not scaled),
      // since each variable may have a different unit.
      let variablesText = '';

      // Usa derivedExpr al posto di formula.expr per le variabili
      if (derivedExpr?.length > 0) {
        let cleanExpr = derivedExpr.replace(/(csv|table|lookup)\([^)]*\)/gi, '');
        cleanExpr = cleanExpr.replace(/\b\d+(\.\d+)?\s*[a-zA-Z]+\b/g, '');
        cleanExpr = cleanExpr.replace(/\b\d+(\.\d+)?[a-zA-Z]+\b/g, '');

        const symbols = cleanExpr.match(/[A-Z_][A-Z0-9_]*/gi) || [];
        const uniqueSymbols = [...new Set(symbols)];

        const knownUnits = new Set(
          formulas.map(f => f.unit?.toLowerCase()).filter((u): u is string => !!u)
        );

        const varEntries: string[] = [];

        for (const sym of uniqueSymbols) {
          const symLower = sym.toLowerCase();

          if (mathFunctions.has(symLower)) continue;
          if (/(csv|table|lookup)/i.test(sym)) continue;
          if (UNIT_SYMBOLS.has(symLower) || knownUnits.has(symLower)) continue;

          const symValue =
            symbolTable.get(sym) ??
            cSymbols.get(sym) ??
            null;
          const symUnit = formulaUnitsById.get(sym) ?? cSymbolUnits.get(sym);

          if (symValue !== null && symValue !== undefined) {
            varEntries.push(formatGhostParamEntry(sym, symValue, symUnit));
          } else {
            varEntries.push(`${sym}=?`);
          }
        }

        if (varEntries.length > 0) {
          variablesText = ` (${varEntries.join(', ')})`;
        }
      }

      // ---------------- GHOST ----------------
      // Apply thousands separator to the ghost value text (if state is available)
      let ghostText = `    = ${valueText}${variablesText}`;
      const state = this._getState?.();
      if (state?.enabled) {
        ghostText = `    = ${formatNumbersWithThousandsSeparator(state, valueText)}${variablesText}`;
      }

      // Mostra la formula derivata se è stata derivata dal value
      /*if (derivedExpr) {
        ghostText += ` ⟵ ${derivedExpr}`;
      }*/

      ghostDecos.push({
        range: new vscode.Range(
          formula.lineStart,
          lineLength,
          formula.lineStart,
          lineLength
        ),
        renderOptions: {
          after: { contentText: ghostText }
        }
      });
    }

    // APPLY
    editor.setDecorations(this.decorations, ghostDecos);
    editor.setDecorations(this.keyDecoConstant, keyConstant);
    editor.setDecorations(this.keyDecoFull, keyFull);
    editor.setDecorations(this.keyDecoParam, keyParam);
    editor.setDecorations(this.keyDecoExternal, keyExternal);
    editor.setDecorations(this.fieldDeco, fieldDecos);
    editor.setDecorations(this.opDeco, opDecos);
    editor.setDecorations(this.missingVarDeco, missingVarDecos);
  }

  // ---------------------------------------------------------------------------
  // Folding
  // ---------------------------------------------------------------------------

  async provideFoldingRanges(doc: TextDocument): Promise<vscode.FoldingRange[]> {
    if (!this.foldingRanges.has(doc)) {
      await this.updateFolding(doc);
    }
    return this.foldingRanges.get(doc) ?? [];
  }

  private async updateFolding(doc: TextDocument) {
    const uri = doc.uri.toString();
    const formulas = await this._registry.getFormulas(uri);
    const ranges: vscode.FoldingRange[] = formulas.map(f => ({
      start: f.lineStart,
      end: f.lineEnd,
      kind: vscode.FoldingRangeKind.Region
    }));
    this.foldingRanges.set(doc, ranges);

    // Refresh folding: wait for VSCode to register new ranges before closing
    setTimeout(async () => {
      try {
        // Modern command for VSCode >= 1.86
        await vscode.commands.executeCommand('editor.foldAllRegions');
      } catch {
        try {
          // Fallback for older VSCode versions
          await vscode.commands.executeCommand('editor.foldAllMarkerRanges');
        } catch {
          console.debug('Auto folding non disponibile su questa versione di VSCode');
        }
      }
    }, 50);
  }

  dispose() {
    this.decorations.dispose();
    this.keyDecoConstant.dispose();
    this.keyDecoFull.dispose();
    this.keyDecoParam.dispose();
    this.keyDecoExternal.dispose();
    this.fieldDeco.dispose();
    this.opDeco.dispose();
    this.missingVarDeco.dispose();
  }
}
