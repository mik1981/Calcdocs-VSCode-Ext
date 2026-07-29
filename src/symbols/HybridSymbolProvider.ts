import type * as vscode from "vscode";

import type { ClangdService } from "../clangd/ClangdService";
import type { ClangdSymbolProvider } from "./ClangdSymbolProvider";
import type { LegacyParserProvider } from "./LegacyParserProvider";
import {
  applyConfidenceAdjustments,
  computeConfidence,
  CSymbol,
  SourceType,
} from "./SymbolTypes";

function isPartialSymbol(symbol: CSymbol): boolean {
  return !symbol.value || !symbol.location || !symbol.type;
}

function mergeKinds(primary: CSymbol, secondary: CSymbol): CSymbol["kind"] {
  if (primary.kind === "macro" || secondary.kind === "macro") {
    return "macro";
  }
  if (primary.kind === "enum" || secondary.kind === "enum") {
    return "enum";
  }
  if (primary.kind === "const" || secondary.kind === "const") {
    return "const";
  }
  return "variable";
}

export class HybridSymbolProvider {
  constructor(
    private readonly clangdService: ClangdService,
    private readonly clangdProvider: ClangdSymbolProvider,
    private readonly legacyProvider: LegacyParserProvider
  ) {}

  async getSymbolAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<CSymbol | null> {
    const [clangdSymbol, parserSymbol] = await Promise.all([
      this.clangdProvider.getSymbolAtPosition(document, position),
      this.legacyProvider.getSymbolAtPosition(document, position),
    ]);

    const hasCompileCommands = this.clangdService.getStatus().hasCompileCommands;

    if (!clangdSymbol && !parserSymbol) {
      return null;
    }

    if (clangdSymbol && parserSymbol) {
      const clangdPrimaryForValue =
        hasCompileCommands &&
        (clangdSymbol.kind === "macro" || clangdSymbol.kind === "enum") &&
        clangdSymbol.value != null;
      const clangdPrimaryForExpression =
        hasCompileCommands &&
        clangdSymbol.kind === "macro" &&
        clangdSymbol.expression != null;
      const merged: CSymbol = {
        name: parserSymbol.name || clangdSymbol.name,
        kind: mergeKinds(clangdSymbol, parserSymbol),
        value: clangdPrimaryForValue
          ? clangdSymbol.value
          : parserSymbol.value ?? clangdSymbol.value,
        unit: parserSymbol.unit ?? clangdSymbol.unit,
        type: clangdSymbol.type ?? parserSymbol.type,
        location: clangdSymbol.location ?? parserSymbol.location,
        expression: clangdPrimaryForExpression
          ? clangdSymbol.expression
          : parserSymbol.expression ?? clangdSymbol.expression,
        source: "mixed",
        confidence: 0,
        fieldSources: {
          value: clangdPrimaryForValue
            ? "clangd"
            : parserSymbol.value != null
              ? "parser"
              : "clangd",
          unit: parserSymbol.unit != null ? "parser" : clangdSymbol.unit != null ? "clangd" : undefined,
          type: clangdSymbol.type != null ? "clangd" : parserSymbol.type != null ? "parser" : undefined,
          location:
            clangdSymbol.location != null
              ? "clangd"
              : parserSymbol.location != null
                ? "parser"
                : undefined,
          expression:
            clangdPrimaryForExpression
              ? "clangd"
              : parserSymbol.expression != null
                ? "parser"
                : clangdSymbol.expression != null
                  ? "clangd"
                  : undefined,
        },
        notes: [],
      };

      if (!hasCompileCommands) {
        merged.notes?.push("clangd without compile_commands.json");
      }

      merged.confidence = applyConfidenceAdjustments(computeConfidence(merged), {
        hasCompileCommands,
        partialEvaluation: isPartialSymbol(merged),
        usesClangdData: true,
      });

      return merged;
    }

    const single = (clangdSymbol ?? parserSymbol)!;
    const singleSource: SourceType = clangdSymbol ? "clangd" : "parser";
    const usesClangdData = singleSource === "clangd";
    const output: CSymbol = {
      ...single,
      source: singleSource,
      notes: [...(single.notes ?? [])],
      confidence: 0,
    };

    if (usesClangdData && !hasCompileCommands) {
      output.notes?.push("clangd without compile_commands.json");
    }

    output.confidence = applyConfidenceAdjustments(computeConfidence(output), {
      hasCompileCommands,
      partialEvaluation: isPartialSymbol(output),
      usesClangdData,
    });

    return output;
  }
}
