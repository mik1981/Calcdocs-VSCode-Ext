import * as vscode from 'vscode';
import { inferDimension, dimToString, getUnitDim, type Dim } from './dimensionEvaluator';
import { FormulaRegistry } from './formulaRegistry';
import { FormulaCodeActionProvider } from './codeActionProvider';
import type { OutlineFormula } from './formulaParser';
import type { CalcDocsState } from '../core/state';
import { UNIT_SPEC_LIST, dimensionsEqual, type DimensionVector } from '../engine/units';

/**
 * Converte una DimensionVector nell'unità canonica più leggibile.
 * Preferisce le unità SI (factorToSi = 1) per evitare es. "g" invece di "kg".
 */
function inferCanonicalUnitFromDim(dim: Dim): string | undefined {
  if (!dim) return undefined;
  const EPSILON = 1e-12;

  for (const spec of UNIT_SPEC_LIST) {
    if (
      Math.abs(spec.factorToSi - 1) < EPSILON &&
      dimensionsEqual(spec.dimension as DimensionVector, dim as DimensionVector)
    ) {
      return spec.canonical;
    }
  }
  for (const spec of UNIT_SPEC_LIST) {
    if (dimensionsEqual(spec.dimension as DimensionVector, dim as DimensionVector)) {
      return spec.canonical;
    }
  }
  return undefined;
}

export class FormulaHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly registry: FormulaRegistry,
    private readonly getState?: () => CalcDocsState | undefined
  ) {}

  async provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const formulas = await this.registry.getFormulas(doc.uri.toString());

    // Hover sulla riga chiave (es. "PHASE_CURRENT_A:")
    const onKeyLine = formulas.find(f => f.lineStart === pos.line);
    if (onKeyLine) {
      return this.buildFormulaKeyHover(onKeyLine, formulas);
    }

    // Hover all'interno di un blocco formula (su variabili, espressioni, ecc.)
    const containing = formulas.find(
      f => pos.line > f.lineStart && pos.line <= f.lineEnd
    );
    if (containing) {
      return this.buildVariableHover(doc, pos, formulas);
    }

    return undefined;
  }

  // ------------------------------------------------------------------

  private buildFormulaKeyHover(
    formula: OutlineFormula,
    allFormulas: OutlineFormula[]
  ): vscode.Hover | undefined {
    if (!formula.expr && formula.value === undefined) return undefined;

    const md = new vscode.MarkdownString();
    md.supportHtml = false;
    md.isTrusted = false;

    md.appendMarkdown(`### 🧮 ${formula.id}\n`);

    if (formula.expr) {
      md.appendCodeblock(formula.expr, 'c');
    } else if (formula.value !== undefined) {
      md.appendMarkdown(`**Value:** \`${formula.value}\``);
    }

    // Unità dichiarata
    if (formula.unit) {
      md.appendMarkdown(`\n\n**Unit:** \`${formula.unit}\``);
    }

    // Derivazione dell'unità dalle dimensioni
    if (formula.expr) {
      const inferred = inferDimension(formula.expr, allFormulas, formula.unit);

      if (inferred.error) {
        md.appendMarkdown(`\n\n⛔ **Operazione non valida**`);
      } else if (inferred.dim) {
        const canonical = inferCanonicalUnitFromDim(inferred.dim);

        if (!formula.unit) {
          if (canonical) {
            md.appendMarkdown(
              `\n\n💡 **Unità derivata:** \`${canonical}\`` +
              `  \n*(aggiungi \`unit: ${canonical}\` per confermare)*`
            );
          } else {
            md.appendMarkdown(`\n\n**Dimensione:** \`${dimToString(inferred.dim)}\``);
          }
        } else {
          // Verifica coerenza con l'unità dichiarata
          const declared = getUnitDim(formula.unit);
          if (declared && dimToString(inferred.dim) !== dimToString(declared)) {
            const calcLabel = canonical ?? dimToString(inferred.dim);
            md.appendMarkdown(
              `\n\n⚠ **Mismatch dimensionale**` +
              `  \nDichiarata: \`${formula.unit}\`  Calcolata: \`${calcLabel}\``
            );
          }
        }
      }
    }

    return new vscode.Hover(md);
  }

  // ------------------------------------------------------------------

  private async buildVariableHover(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    allFormulas: OutlineFormula[]
  ): Promise<vscode.Hover | undefined> {
    const wordRange = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
    if (!wordRange) return undefined;

    const word = doc.getText(wordRange);
    if (!word) return undefined;

    // È un'altra formula nello stesso file?
    const refFormula = allFormulas.find(f => f.id === word);
    if (refFormula) {
      return this.buildFormulaKeyHover(refFormula, allFormulas);
    }

    // È un simbolo C/C++ noto allo stato CalcDocs?
    const state = this.getState?.();
    if (!state) return undefined;

    const formulaEntry  = state.formulaIndex.get(word);
    const cValue        = state.symbolValues.get(word);
    const cUnit         = state.symbolUnits.get(word);
    const cExpr         = state.allDefines.get(word);

    if (formulaEntry) {
      const md = new vscode.MarkdownString();
      md.isTrusted = false;
      md.appendMarkdown(`### 📐 ${word}\n`);
      if (formulaEntry.formula) md.appendCodeblock(formulaEntry.formula, 'c');
      if (formulaEntry.unit) md.appendMarkdown(`\n**Unit:** \`${formulaEntry.unit}\``);
      if (typeof formulaEntry.valueCalc === 'number') {
        md.appendMarkdown(`\n**Value:** \`${formulaEntry.valueCalc}\``);
      }
      return new vscode.Hover(md, wordRange);
    }

    if (cValue !== undefined || cUnit !== undefined) {
      const md = new vscode.MarkdownString();
      md.isTrusted = false;
      md.appendMarkdown(`### 🔧 ${word}  *(C/C++)*\n`);
      if (cValue !== undefined) md.appendMarkdown(`**Value:** \`${cValue}\``);
      if (cUnit)                md.appendMarkdown(`\n\n**Unit:** \`${cUnit}\``);
      if (cExpr && cExpr !== String(cValue)) md.appendCodeblock(cExpr, 'c');
      return new vscode.Hover(md, wordRange);
    }

    return undefined;
  }
}

// ----------------------------------------------------------------------

export function registerFormulaOutlineHoverProvider(
  context: vscode.ExtensionContext,
  registry: FormulaRegistry,
  getState?: () => CalcDocsState | undefined
): void {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { language: 'yaml', pattern: '**/*formulas*.yaml' },
      new FormulaHoverProvider(registry, getState)
    )
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: 'yaml', pattern: '**/*formulas*.yaml' },
      new FormulaCodeActionProvider(registry),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );
}