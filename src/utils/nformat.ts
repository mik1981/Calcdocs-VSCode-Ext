import { CalcDocsState } from "../core/state";
import { getConfig, getThousandsSeparatorChar } from "../core/config";

/**
 * Formats a number to a given number of significant figures.
 *
 * If all significant digits fit before the decimal point (i.e. the integer part
 * already has sigFigs or more digits), the decimal part is stripped entirely.
 * Otherwise trailing zeros after the decimal point are removed.
 *
 * Examples (sigFigs = 6):
 *   1234.56789   → "1234.57"
 *   123456.789   → "123457"      (6 digits before decimal → integer)
 *   3.14159265   → "3.14159"
 *   1000         → "1000"
 *   100000       → "100000"      (exactly 6 digits → integer)
 *   0.00123456789 → "0.00123457"
 *   1.2345e-5    → "0.000012345" (from toPrecision, then cleaned)
 */
export function formatNumberToSigFigs(value: number, sigFigs: number = 6): string {
  if (!Number.isFinite(value)) return "?";

  if (value === 0) return "0";

  // Use toPrecision for significant figures
  let formatted = value.toPrecision(sigFigs);

  // Exponential notation is already concise — return as-is
  if (formatted.includes("e")) return formatted;

  // If the integer part already has >= sigFigs digits, strip decimal entirely.
  // That means abs(value) >= 10^(sigFigs-1).
  if (Math.abs(value) >= Math.pow(10, sigFigs - 1)) {
    // parseFloat removes trailing ".0" etc. while keeping the rounding from toPrecision
    return parseFloat(formatted).toString();
  }

  // Strip trailing zeros after decimal point, and the dot itself if nothing remains
  return formatted.replace(/\.?0+$/, "");
}

/**
 * Checks if a number is an integer (no fractional part).
 * @param n - The number to check
 * @returns true if the number is an integer
 */
function isInteger(n: number): boolean {
  return Number.isFinite(n) && n === Math.floor(n);
}

/**
 * Converts a number to a formatted hexadecimal string with 4-digit grouping.
 * Examples:
 * - 1024 → "0x0400"
 * - 65536 → "0x0001_0000"
 * - 255 → "0x00FF"
 * - 0 → "0x0000"
 * 
 * @param n - The number to convert
 * @returns The formatted hex string
 */
export function toHexString(n: number): string {
  if (!isInteger(n) || n < 0) {
    return "";
  }
  
  const hex = n.toString(16).toUpperCase();
  const padded = hex.padStart(Math.ceil(hex.length / 4) * 4, "0");
  
  // Add underscore every 4 digits from the left
  const groups: string[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    groups.push(padded.slice(i, i + 4));
  }
  
  const config = getConfig();
  const separator = getThousandsSeparatorChar(config.thousandsSeparator);
  return "0x" + groups.join(separator);
}


export function toBinaryString(n: number): string {
  if (!isInteger(n) || n < 0) {
    return "";
  }
  if (n === 0) {
    return "0b0";
  }
  const raw = n.toString(2);
  // Raggruppa le cifre a nibble (4 bit) per leggibilità
  const padded = raw.padStart(Math.ceil(raw.length / 4) * 4, "0");
  const groups: string[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    groups.push(padded.slice(i, i + 4));
  }
  const config = getConfig();
  const separator = getThousandsSeparatorChar(config.thousandsSeparator);
  return "0b" + groups.join(separator);
}


/**
 * Formatta un numero secondo il formato rilevato dall'espressione sorgente:
 * - 'hex'    → 0x... (interi) o decimale (float)
 * - 'binary' → 0b... (interi) o decimale (float)
 * - 'decimal'→ separatore migliaia normale
 */
export function formatValueForDisplay(
  state: CalcDocsState,
  value: number,
  format?: 'decimal' | 'hex' | 'binary'
): string {
  if (format === 'hex') {
    const hex = toHexString(value);
    if (hex) {
      return hex;
    }
  }
  if (format === 'binary') {
    const bin = toBinaryString(value);
    if (bin) {
      return bin;
    }
  }
  return formatNumbersWithThousandsSeparator(state, String(value));
}

/**
 * Adds high dot (⋅) as thousands separator to all numbers in a string.
 * Example: "value is 1234567" → "value is 1⋅234⋅567"
 *
 * @param text - The input string containing numbers to format
 * @returns The string with all numbers formatted with thousands separators
 */
export function formatNumbersWithThousandsSeparator(state: CalcDocsState, text: string): string {
  // Get separator from config
  const config = getConfig();
  const separator = getThousandsSeparatorChar(config.thousandsSeparator);
  // Match numbers: hex (0x...), integers, decimals, and scientific notation
  // Also matches negative numbers and numbers with C suffixes like ul, lu, ull, etc.
  const numberPattern =
    /[-+]?(?:0[xX][0-9a-fA-F]+|(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*(?:ul|lu|ull|llu|u|l|ll|f)?/g;

  const ret = text.replace(numberPattern, (match) => {
    // Remove any existing spaces/suffixes from the number for processing
    const cleanNumber = match.trim();

    // Hex literals: group every 4 digits
    if (/^[-+]?0[xX][0-9a-fA-F]+/.test(cleanNumber)) {
      const hexMatch = cleanNumber.match(
        /^([+-]?)(0[xX])([0-9a-fA-F]+)(\s*(?:ul|lu|ull|llu|u|l|ll|f)?)$/
      );
      if (!hexMatch) {
        return match;
      }

      const [, sign, prefix, digits, suffix] = hexMatch;
      const groups: string[] = [];
      for (let i = digits.length; i > 0; i -= 4) {
        const start = Math.max(0, i - 4);
        groups.push(digits.slice(start, i));
      }
      groups.reverse();

      return `${sign}${prefix}${groups.join(separator)}${suffix}`;
    }

    // Split into integer and decimal parts
    const parts = cleanNumber.split(".");
    let integerPart = parts[0];
    const decimalPart = parts[1];

    // Remove any existing commas for processing
    integerPart = integerPart.replace(/,/g, "");

    // Add thousands separator (high dot) to integer part
    // The negative lookahead (?!\d|\.) ensures we don't add separator before decimal point
    // Carattere 	Nome Unicode	Codice Unicode	Uso tipico
    // .	Full Stop	U+002E	Europa, Italia
    // ,	Comma	U+002C	USA, UK
    // ** **	Narrow No-Break Space	U+202F	Standard Scientifico
    // '	Apostrophe	U+0027	Svizzera
    const formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d|\.))/g, separator);

    // Reconstruct the number with decimal part if present
    if (decimalPart !== undefined) {
      return `${formattedInteger}.${decimalPart}`;
    }

    return formattedInteger;
  });

  // state.output.detail(`${text} → ${ret}`)
  return ret
}