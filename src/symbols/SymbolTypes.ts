import type * as vscode from "vscode";

export type SourceType = "clangd" | "parser" | "mixed" | "unknown";

export type SymbolKindType = "macro" | "const" | "enum" | "variable";

type SymbolFieldName = "value" | "unit" | "type" | "location" | "expression";

type SymbolFieldSources = Partial<Record<SymbolFieldName, SourceType>>;

export interface CSymbol {
  name: string;
  kind: SymbolKindType;
  value?: string;
  unit?: string;
  type?: string;
  location?: vscode.Location;
  expression?: string;
  source: SourceType;
  confidence: number; // 0.0 - 1.0
  fieldSources: SymbolFieldSources;
  notes?: string[];
}

export function computeConfidence(symbol: CSymbol): number {
  if (symbol.source === "mixed") {
    return 0.9;
  }

  if (symbol.source === "clangd") {
    return 0.85;
  }

  if (symbol.source === "parser") {
    return 0.6;
  }

  return 0.3;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

export function applyConfidenceAdjustments(
  baseConfidence: number,
  options: {
    hasCompileCommands: boolean;
    partialEvaluation: boolean;
    usesClangdData: boolean;
  }
): number {
  let adjusted = baseConfidence;

  if (options.usesClangdData && !options.hasCompileCommands) {
    adjusted -= 0.2;
  }

  if (options.partialEvaluation) {
    adjusted -= 0.1;
  }

  return clampConfidence(adjusted);
}
