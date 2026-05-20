import {
  buildCompositeExpressionPreview,
  type CompositeExpressionPreviewError,
  type NumericDisplayFormat,
} from "./expression";
import { CalcDocsState } from "./state";
import {
  formatNumberToSigFigs,
  formatNumbersWithThousandsSeparator,
  formatValueForDisplay,
  toHexString,
} from "../utils/nformat";

export type ExpressionPreview = {
  expanded: string;
  value: number | null;
  error: CompositeExpressionPreviewError | null;
  displayValue?: number;
  displayUnit?: string;
  numericFormat?: NumericDisplayFormat;
};

type FormatExpandedPreviewOptions = {
  maxLength?: number;
};

const WRAPPED_CAST_RX =
  /^\(\s*(?:u?int(?:8|16|32)|u?int(?:8|16|32)_t|float|double)\s*\)\s*\((.+)\)$/i;

/**
 * Shared expression preview engine used by CodeLens and Hover.
 */
export function evaluateExpressionPreview(
  state: CalcDocsState,
  expression: string
): ExpressionPreview {
  return buildCompositeExpressionPreview(
    expression,
    state.symbolValues,
    state.allDefines,
    state.functionDefines,
    {},
    state.defineConditions,
    state.symbolUnits
  );
}

/**
 * Normalizes an expanded expression for display:
 * - compacts whitespace
 * - removes one outer cast wrapper on whole expression
 */
export function normalizeExpandedPreviewText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.replace(WRAPPED_CAST_RX, "$1");
}

/**
 * Formats expanded preview text with optional truncation and thousand separators.
 */
export function formatExpandedPreview(
  state: CalcDocsState,
  expanded: string,
  options: FormatExpandedPreviewOptions = {}
): string {
  let normalized = normalizeExpandedPreviewText(expanded);

  if (
    typeof options.maxLength === "number" &&
    options.maxLength > 0 &&
    normalized.length > options.maxLength
  ) {
    normalized = `${normalized.slice(0, options.maxLength)}...`;
  }

  return formatNumbersWithThousandsSeparator(state, normalized);
}

/**
 * Formats numeric value for inline previews (6 significant figures).
 */
export function formatPreviewNumber(state: CalcDocsState, value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const sigFigStr = formatNumberToSigFigs(value, 6);
  return formatNumbersWithThousandsSeparator(state, sigFigStr);
}


/**
 * Come formatPreviewNumber ma rispetta il formato numerico rilevato
 * dall'espressione sorgente (hex/binary/decimal).
 */
export function formatPreviewNumberWithFormat(
  state: CalcDocsState,
  value: number,
  format?: NumericDisplayFormat
): string {
  if (format === 'boolean') {
    return value !== 0 ? 'true' : 'false';
  }
  return formatValueForDisplay(state, value,
    format /*as 'decimal' | 'hex' | 'binary' | undefined*/);
}

/**
 * Formats numeric value and appends hex form when available.
 */
export function formatPreviewNumberWithHex(
  state: CalcDocsState,
  value: number
): string {
  const decimal = formatPreviewNumber(state, value);
  const hex = toHexString(value);
  return hex ? `${decimal} (${hex})` : decimal;
}

/**
 * Renders a C-like preview row from symbol name and right-hand side.
 */
export function buildCStylePreview(
  displayName: string,
  rightHandSide: string,
  isDefineDirective: boolean
): string {
  if (!displayName) {
    return `(${rightHandSide})`;
  }

  return isDefineDirective
    ? `#define ${displayName} ${rightHandSide}`
    : `${displayName} = ${rightHandSide}`;
}
