import { resolveSymbol } from "./expression";
import type { CalcDocsState } from "./state";

export type BitfieldMember = {
  name: string;
  fullName: string;
  mask: number;
  bit: number;
  suffix: string;
  comment?: string;
};

export type BitfieldField = {
  kind: "field";
  name: string;
  fullName: string;
  registerPrefix: string;
  mask: number;
  shift: number;
  members: BitfieldMember[];
  comment?: string;
};

export type BitfieldFlag = {
  kind: "flag";
  name: string;
  fullName: string;
  registerPrefix: string;
  mask: number;
  bit: number;
  comment?: string;
};

export type BitfieldEntry = BitfieldField | BitfieldFlag;

export type BitfieldDecodeResult = {
  target: string | null;
  value: number;
  fields: Array<{
    name: string;
    kind: "field" | "flag";
    value: number;
    active: boolean;
    registerPrefix: string;
    mask: number;
    shift: number;
    members?: BitfieldMember[];
    comment?: string;
  }>;
  activeFields: string[];
  inactiveFields: string[];
};

export type BitfieldDecodeTheme = "light" | "dark";

export type BitfieldDecodeFormatOptions = {
  theme?: BitfieldDecodeTheme;
};

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

function getLowestSetBit(value: number): number {
  return value === 0 ? -1 : Math.log2(value & -value);
}

function normalizeDefineName(name: string): {
  registerPrefix: string;
  fieldName: string;
  suffix: string | null;
  helperSuffix: string | null;
} {
  const helperMatch = name.match(/^(.*)_(Pos|pos|Msk|msk)$/);
  if (helperMatch) {
    const baseName = helperMatch[1];
    const suffix = helperMatch[2];
    const parts = baseName.split("_");
    const fieldName = parts.pop() || baseName;
    const registerPrefix = parts.join("_");
    return {
      registerPrefix,
      fieldName,
      suffix: null,
      helperSuffix: suffix.toLowerCase() === "pos" ? "Pos" : "Msk",
    };
  }

  const match = name.match(/^(.*)_([^_]+)$/);
  if (!match) {
    return { registerPrefix: "", fieldName: name, suffix: null, helperSuffix: null };
  }

  const maybeSuffix = match[2];
  if (/^\d+$/.test(maybeSuffix)) {
    const remaining = match[1];
    const fieldParts = remaining.split("_");
    if (fieldParts.length === 0) {
      return {
        registerPrefix: "",
        fieldName: remaining,
        suffix: maybeSuffix,
        helperSuffix: null,
      };
    }
    const fieldName = fieldParts[fieldParts.length - 1];
    const registerPrefix = fieldParts.slice(0, -1).join("_");
    return {
      registerPrefix,
      fieldName,
      suffix: maybeSuffix,
      helperSuffix: null,
    };
  }

  return {
    registerPrefix: match[1],
    fieldName: maybeSuffix,
    suffix: null,
    helperSuffix: null,
  };
}

function evaluateDefineValue(
  name: string,
  expr: string,
  state: CalcDocsState
): number | undefined {
  if (state.symbolValues.has(name)) {
    return state.symbolValues.get(name);
  }

  try {
    const symbolContext = new Map(state.symbolValues);
    const value = resolveSymbol(name, state.allDefines, state.functionDefines, new Map(), symbolContext);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    return Math.trunc(value);
  } catch {
    return undefined;
  }
}

export function buildBitfieldEntries(
  allDefines: Map<string, string>,
  state: CalcDocsState
): BitfieldEntry[] {
  const membersByGroup = new Map<
    string,
    {
      registerPrefix: string;
      fieldName: string;
      members: BitfieldMember[];
    }
  >();

  const consumedNames = new Set<string>();
  const processedBaseNames = new Set<string>();
  const helperDefines = new Map<
    string,
    {
      posValue?: number;
      mskValue?: number;
    }
  >();
  const flagEntries: BitfieldFlag[] = [];
  const fieldEntries: BitfieldField[] = [];

  for (const [name, expr] of allDefines) {
    const normalized = normalizeDefineName(name);
    const comment = state.defineComments?.get(name);
    const value = evaluateDefineValue(name, expr, state);
    if (typeof value !== "number" || !Number.isFinite(value) || value === 0) {
      continue;
    }

    if (normalized.helperSuffix !== null) {
      const baseName = `${normalized.registerPrefix}${normalized.registerPrefix ? "_" : ""}${normalized.fieldName}`;
      const helpers = helperDefines.get(baseName) ?? {};
      if (normalized.helperSuffix === "Pos") {
        helpers.posValue = value;
      } else if (normalized.helperSuffix === "Msk") {
        helpers.mskValue = value;
      }
      helperDefines.set(baseName, helpers);
      consumedNames.add(name);
      continue;
    }

    if (normalized.suffix !== null && isPowerOfTwo(value)) {
      const groupKey = `${normalized.registerPrefix}::${normalized.fieldName}`;
      const bit = getLowestSetBit(value);
      const members = membersByGroup.get(groupKey);
      const member: BitfieldMember = {
        name: normalized.fieldName,
        fullName: name,
        mask: value,
        bit,
        suffix: normalized.suffix,
        comment,
      };
      if (members) {
        members.members.push(member);
      } else {
        membersByGroup.set(groupKey, {
          registerPrefix: normalized.registerPrefix,
          fieldName: normalized.fieldName,
          members: [member],
        });
      }
      consumedNames.add(name);
      processedBaseNames.add(name);
      continue;
    }

    if (isPowerOfTwo(value)) {
      flagEntries.push({
        kind: "flag",
        name: normalized.fieldName,
        fullName: name,
        registerPrefix: normalized.registerPrefix,
        mask: value,
        bit: getLowestSetBit(value),
        comment,
      });
      processedBaseNames.add(name);
    } else {
      processedBaseNames.add(name);
    }
  }

  for (const [baseName, helpers] of helperDefines) {
    if (processedBaseNames.has(baseName) || helpers.mskValue === undefined || helpers.mskValue === 0) {
      continue;
    }

    const normalized = normalizeDefineName(baseName);
    const value = helpers.mskValue;
    const baseComment = state.defineComments?.get(baseName);
    if (isPowerOfTwo(value)) {
      flagEntries.push({
        kind: "flag",
        name: normalized.fieldName,
        fullName: baseName,
        registerPrefix: normalized.registerPrefix,
        mask: value,
        bit: getLowestSetBit(value),
        comment: baseComment,
      });
      continue;
    }

    const shift = getLowestSetBit(value);
    fieldEntries.push({
      kind: "field",
      name: normalized.fieldName,
      fullName: baseName,
      registerPrefix: normalized.registerPrefix,
      mask: value,
      shift,
      members: [],
      comment: baseComment,
    });
  }

  for (const [groupKey, group] of membersByGroup) {
    if (group.members.length <= 1) {
      continue;
    }

    const mask = group.members.reduce((acc, member) => acc | member.mask, 0);
    const shift = Math.min(...group.members.map((member) => member.bit));
    const members = [...group.members].sort(
      (a, b) => Number(a.suffix) - Number(b.suffix)
    );

    fieldEntries.push({
      kind: "field",
      name: group.fieldName,
      fullName: `${group.registerPrefix}${group.registerPrefix ? "_" : ""}${group.fieldName}`,
      registerPrefix: group.registerPrefix,
      mask,
      shift,
      members,
      comment: mergeMemberComments(members),
    });
  }

  const entries: BitfieldEntry[] = [...fieldEntries];

  const groupedNames = new Set(
    fieldEntries.flatMap((field) => field.members.map((member) => member.fullName))
  );

  for (const flag of flagEntries) {
    if (!groupedNames.has(flag.fullName) && !consumedNames.has(flag.fullName)) {
      entries.push(flag);
    }
  }

  return entries;
}

/**
 * Exported for testing. Validates that a context string matches a known bitfield entry.
 *
 * Rules enforced:
 * 1. Context must contain 2-3 identifier parts after normalization.
 * 2. Each part must be a valid C identifier (no operators, parens, digits-only tokens, etc.).
 * 3. For 3-part contexts, the first two parts form the candidate register prefix.
 * 4. Verifies that corresponding _Pos or _Msk defines exist for the candidate prefix.
 *
 * This prevents false positives like `foo->bar->baz`, `ptr->member[index]`, `p+1->reg`.
 */
export function matchesContext(
  entry: BitfieldEntry,
  context: string,
  allDefines?: Map<string, string>
): boolean {
  const raw = context.trim();
  if (!raw) {
    return false;
  }

  // Normalize separators to underscore so contexts like:
  //   TIM1->CR1
  //   TIM1.CR1
  // become comparable.
  const normalizedContext = raw.replace(/->|\./g, "_");

  const accessParts = normalizedContext.split("_").filter(Boolean);
  if (accessParts.length < 2) {
    return false;
  }

  // Strong filter: do not accept contexts that include extra chaining parts.
  if (accessParts.length > 3) {
    return false;
  }

  // REQUIRE: each token must be a valid C identifier.
  // Reject tokens containing non-identifier characters: e.g. `arr[`, `(p`, `ptr)`, `0x1`, etc.
  const identifierRx = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const part of accessParts) {
    if (!identifierRx.test(part)) {
      return false;
    }
  }

  // Build candidate register prefix from the context.
  // Examples:
  //   "TIM1->CR2"     → accessParts = ["TIM1", "CR2"]     → candidatePrefix = "TIM1_CR2"
  //   "TIM1->CR2->CEN" → accessParts = ["TIM1", "CR2", "CEN"] → candidatePrefix = "TIM1_CR2"
  const candidatePrefix =
    accessParts.length === 3 ? accessParts.slice(0, 2).join("_") : accessParts.join("_");

  // Determine which prefix to use for define validation.
  let matchedPrefix: string | null = null;

  if (allDefines && allDefines.size > 0) {
    matchedPrefix = resolveDefinePrefix(accessParts[0], accessParts[1], allDefines) ?? null;
  } else {
    const strippedFirstToken = accessParts[0].replace(/\d+$/, "");
    const candidatePrefixAlt = accessParts.length === 3
      ? `${strippedFirstToken}_${accessParts[1]}`
      : `${strippedFirstToken}_${accessParts.slice(1).join("_")}`;

    matchedPrefix =
      entry.registerPrefix === candidatePrefix || entry.registerPrefix === candidatePrefixAlt
        ? entry.registerPrefix
        : null;
  }

  if (!matchedPrefix) {
    return false;
  }

  if (allDefines && allDefines.size > 0) {
    const hasDefines = hasPositionalOrMaskDefines(matchedPrefix, allDefines);
    if (!hasDefines) {
      return false;
    }
  }

  // FINAL FILTER:
  // the entry itself MUST belong to the resolved register prefix.
  return entry.registerPrefix === matchedPrefix;
}

/**
 * Checks whether any define exists for the given register prefix.
 *
 * Accepts:
 *   TIM_CR2_CCPC
 *   TIM_CR2_CCPC_Msk
 *   TIM_CR2_CCPC_Pos
 * etc.
 */
function hasPositionalOrMaskDefines(
  prefix: string,
  allDefines: Map<string, string>
): boolean {
  const normalizedPrefix = prefix.endsWith("_")
    ? prefix
    : `${prefix}_`;

  const rx = new RegExp(
    `^${escapeRegexForPrefix(normalizedPrefix)}[A-Za-z0-9_]+(?:_(?:Pos|pos|Msk|msk))?$`
  );

  for (const name of allDefines.keys()) {
    if (rx.test(name)) {
      return true;
    }
  }

  return false;
}

/**
 * Strips a trailing numeric suffix from an identifier segment.
 * e.g. "TIM2" → "TIM", "GPIO1" → "GPIO", "ADC" → "ADC" (invariant)
 */
function stripTrailingNumber(name: string): string {
  return name.replace(/\d+$/, "");
}

/**
 * Resolves which define prefix to use for a register access like "TIM2->CR3".
 *
 * Priority:
 *  1. Exact match:   "TIM2_CR3_*"  — instance-specific defines
 *  2. Generic match: "TIM_CR3_*"   — family-wide defines (strip trailing digits)
 *  3. No match:       undefined    — treat as false bitfield, skip
 *
 * Returns the resolved prefix string, or undefined if nothing matches.
 */
function resolveDefinePrefix(
  instanceName: string,   // e.g. "TIM2"
  registerName: string,   // e.g. "CR3"
  allDefines: Map<string, string>
): string | undefined {
  const exactPrefix = `${instanceName}_${registerName}`;
  if (hasPositionalOrMaskDefines(exactPrefix, allDefines)) {
    return exactPrefix;
  }

  const genericInstance = stripTrailingNumber(instanceName);
  if (genericInstance !== instanceName) {              // only if there was actually a number
    const genericPrefix = `${genericInstance}_${registerName}`;
    if (hasPositionalOrMaskDefines(genericPrefix, allDefines)) {
      return genericPrefix;
    }
  }

  return undefined; // false bitfield
}


/**
 * Escapes special regex characters in a prefix string for safe use in RegExp construction.
 */
function escapeRegexForPrefix(prefix: string): string {
  return prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function decodeBitfieldValue(
  value: number,
  allDefines: Map<string, string>,
  state: CalcDocsState,
  context?: string
): BitfieldDecodeResult | null {
  const entries = buildBitfieldEntries(allDefines, state);
  if (entries.length === 0) {
    return null;
  }

  const contextIdentifier = context ? context.trim() : "";
  const candidates = contextIdentifier
    ? entries.filter((entry) => matchesContext(entry, contextIdentifier, allDefines))
    : entries;

  // When a context was explicitly provided, NEVER fall back to all entries
  // if no candidate matched. This prevents false decodings like `screen.state`
  // (which normalizes to `screen_state` and has no _Pos/_Msk defines, but would
  // previously fall back to showing every known bitfield).
  const selectedEntries = contextIdentifier
    ? (candidates.length > 0 ? candidates : [])
    : (candidates.length > 0 ? candidates : entries);
  if (selectedEntries.length === 0) {
    return null;
  }

  const fields = selectedEntries
    .sort((left, right) => {
      if (left.registerPrefix !== right.registerPrefix) {
        return left.registerPrefix.localeCompare(right.registerPrefix);
      }
      const leftBit = left.kind === "flag" ? left.bit : left.shift;
      const rightBit = right.kind === "flag" ? right.bit : right.shift;
      return leftBit - rightBit;
    })
    .map((entry) => {
      if (entry.kind === "flag") {
        const active = (value & entry.mask) !== 0;
        return {
          name: entry.name,
          kind: "flag" as const,
          value: active ? 1 : 0,
          active,
          registerPrefix: entry.registerPrefix,
          mask: entry.mask,
          shift: entry.bit,
          comment: entry.comment,
        };
      }

      const rawValue = (value & entry.mask) >>> entry.shift;
      return {
        name: entry.name,
        kind: "field" as const,
        value: rawValue,
        active: rawValue !== 0,
        registerPrefix: entry.registerPrefix,
        mask: entry.mask,
        shift: entry.shift,
        members: entry.members,
        comment: entry.comment,
      };
    });

  if (fields.length === 0) {
    return null;
  }

  return {
    target: contextIdentifier || null,
    value,
    fields,
    activeFields: fields.filter((field) => field.active).map((field) => field.name),
    inactiveFields: fields.filter((field) => !field.active).map((field) => field.name),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeMarkdownCode(value: string): string {
  return value.replace(/`/g, "'");
}

function clampText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function getHighestSetBit(value: number): number {
  return value <= 0 ? -1 : Math.floor(Math.log2(value));
}

function normalizeComment(comment: string | undefined): string | null {
  if (!comment) {
    return null;
  }

  const normalized = comment
    .replace(/^\s*[!*<]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > 0 ? normalized : null;
}

function formatNumberList(numbers: number[]): string {
  if (numbers.length === 0) {
    return "";
  }

  const sorted = [...numbers].sort((left, right) => left - right);
  const isContiguous = sorted.every(
    (value, index) => index === 0 || value === sorted[index - 1] + 1
  );

  if (isContiguous && sorted.length > 1) {
    return `${sorted[0]}..${sorted[sorted.length - 1]}`;
  }

  return sorted.join(", ");
}

function mergeBitNumberComments(comments: string[]): string | null {
  const parsed = comments.map((comment) => {
    const trailingBitMatch = comment.match(/^(.*?)\bbits?\s+(\d+)\s*$/i);
    if (trailingBitMatch) {
      return {
        prefix: trailingBitMatch[1].trim(),
        bit: Number(trailingBitMatch[2]),
      };
    }

    const leadingBitMatch = comment.match(/^bit\s+(\d+)\s+(?:of\s+)?(.+)$/i);
    if (leadingBitMatch) {
      return {
        prefix: leadingBitMatch[2].trim(),
        bit: Number(leadingBitMatch[1]),
      };
    }

    return null;
  });

  if (parsed.some((item) => item === null)) {
    return null;
  }

  const first = parsed[0]!;
  if (!parsed.every((item) => item!.prefix === first.prefix)) {
    return null;
  }

  const bits = parsed.map((item) => item!.bit);
  const label = first.prefix ? `${first.prefix} bits` : "bits";
  return `${label} ${formatNumberList(bits)}`;
}

function mergeCommonPrefixComments(comments: string[]): string | null {
  if (comments.length < 2) {
    return null;
  }

  const tokenized = comments.map((comment) => comment.split(/\s+/));
  const shortestLength = Math.min(...tokenized.map((tokens) => tokens.length));
  let prefixLength = 0;

  while (
    prefixLength < shortestLength &&
    tokenized.every((tokens) => tokens[prefixLength] === tokenized[0][prefixLength])
  ) {
    prefixLength += 1;
  }

  if (prefixLength < 3) {
    return null;
  }

  const prefix = tokenized[0].slice(0, prefixLength).join(" ");
  const suffixes = tokenized
    .map((tokens) => tokens.slice(prefixLength).join(" ").trim())
    .filter((suffix) => suffix.length > 0);

  if (suffixes.length !== comments.length) {
    return null;
  }

  return `${prefix} (${suffixes.join(", ")})`;
}

function mergeComments(comments: Array<string | undefined>): string {
  const uniqueComments = Array.from(
    new Set(
      comments
        .map(normalizeComment)
        .filter((comment): comment is string => Boolean(comment))
    )
  );

  if (uniqueComments.length === 0) {
    return "";
  }

  if (uniqueComments.length === 1) {
    return uniqueComments[0];
  }

  return (
    mergeBitNumberComments(uniqueComments) ??
    mergeCommonPrefixComments(uniqueComments) ??
    uniqueComments.join(" / ")
  );
}

function mergeMemberComments(members: BitfieldMember[]): string | undefined {
  const merged = mergeComments(members.map((member) => member.comment));
  return merged.length > 0 ? merged : undefined;
}

function collectFieldComment(
  field: BitfieldDecodeResult["fields"][number]
): string {
  if (field.kind === "field" && field.members && field.members.length > 0) {
    const merged = mergeComments(field.members.map((member) => member.comment));
    if (merged) {
      return merged;
    }
  }

  return normalizeComment(field.comment) ?? "";
}

function buildMembersDetailText(
  field: BitfieldDecodeResult["fields"][number],
  decodeValue: number
): string {
  if (field.kind !== "field" || !field.members || field.members.length === 0) {
    return "";
  }
  // Use only the numeric suffix (e.g. "0", "1", "2"), never the full symbol name.
  return field.members.map((member) => {
    const bitSet = (decodeValue & member.mask) !== 0;
    return `${member.suffix}=${bitSet ? 1 : 0}`;
  }).join(" ");
}

function buildBitRangeText(field: BitfieldDecodeResult["fields"][number]): string {
  const high = getHighestSetBit(field.mask);
  if (high < 0) {
    return "";
  }

  return high === field.shift ? `b${field.shift}` : `b${high}:${field.shift}`;
}

function formatSummaryList(fields: string[]): string {
  if (fields.length === 0) {
    return "`none`";
  }

  return fields
    .map((field) => `\`${escapeMarkdownCode(field)}\``)
    .join(", ");
}

function getSvgPalette(theme: BitfieldDecodeTheme) {
  if (theme === "dark") {
    return {
      title: "#F8FAFC",
      valueLabel: "#CBD5E1",
      separator: "#334155",
      activeBadgeFill: "#22C55E",
      activeBadgeText: "#052E16",
      inactiveBadgeFill: "#475569",
      inactiveBadgeText: "#E2E8F0",
      activeName: "#86EFAC",
      inactiveName: "#CBD5E1",
      activeValue: "#6EE7B7",
      inactiveValue: "#94A3B8",
      activeBits: "#34D399",
      inactiveBits: "#94A3B8",
      comment: "#94A3B8",
    };
  }

  return {
    title: "#0F172A",
    valueLabel: "#475569",
    separator: "#CBD5E1",
    activeBadgeFill: "#16A34A",
    activeBadgeText: "#FFFFFF",
    inactiveBadgeFill: "#CBD5E1",
    inactiveBadgeText: "#334155",
    activeName: "#065F46",
    inactiveName: "#475569",
    activeValue: "#047857",
    inactiveValue: "#64748B",
    activeBits: "#059669",
    inactiveBits: "#64748B",
    comment: "#334155",
  };
}

function buildBitfieldDecodeSvg(
  decode: BitfieldDecodeResult,
  theme: BitfieldDecodeTheme
): string {
  const rows = decode.fields.map((field) => ({
    active: field.active,
    name: field.name,
    value: String(field.value),
    bits: buildMembersDetailText(field, decode.value) || buildBitRangeText(field),
    comment: collectFieldComment(field),
  }));

  const width = 860;
  const headerHeight = 44;
  const rowHeight = 26;
  const footerHeight = 14;
  const height = headerHeight + rows.length * rowHeight + footerHeight;
  const commentMaxChars = 58;
  const palette = getSvgPalette(theme);

  const title = decode.target ? `${decode.target} decoded` : "Value decoded";
  const valueLabel = `${decode.value} / 0x${Math.trunc(decode.value).toString(16).toUpperCase()}`;

  const rowSvg = rows.map((row, index) => {
    const rowY = headerHeight + index * rowHeight;
    const textY = rowY + 17;
    const badgeFill = row.active ? palette.activeBadgeFill : palette.inactiveBadgeFill;
    const badgeText = row.active ? palette.activeBadgeText : palette.inactiveBadgeText;
    const nameColor = row.active ? palette.activeName : palette.inactiveName;
    const valueColor = row.active ? palette.activeValue : palette.inactiveValue;
    const bitsColor = row.active ? palette.activeBits : palette.inactiveBits;
    const badgeLabel = row.active ? "ON" : "zero";
    const comment = clampText(row.comment, commentMaxChars);

    return [
      `<rect x="18" y="${rowY + 5}" width="42" height="16" rx="8" fill="${badgeFill}"/>`,
      `<text x="39" y="${textY - 1}" text-anchor="middle" fill="${badgeText}" font-size="10" font-weight="700">${badgeLabel}</text>`,
      `<text x="74" y="${textY}" fill="${nameColor}" font-size="13" font-weight="${row.active ? "700" : "600"}">${escapeHtml(clampText(row.name, 18))}</text>`,
      `<text x="214" y="${textY}" fill="${valueColor}" font-size="13" font-weight="${row.active ? "700" : "500"}">= ${escapeHtml(row.value)}</text>`,
      `<text x="276" y="${textY}" fill="${bitsColor}" font-size="12" font-family="Consolas, Menlo, monospace">${escapeHtml(clampText(row.bits, 20))}</text>`,
      comment
        ? `<text x="410" y="${textY}" fill="${palette.comment}" font-size="12" font-style="italic">${escapeHtml(comment)}</text>`
        : "",
      index < rows.length - 1
        ? `<line x1="14" y1="${rowY + rowHeight}" x2="${width - 14}" y2="${rowY + rowHeight}" stroke="${palette.separator}" stroke-width="1" opacity="0.65"/>`
        : "",
    ].join("");
  }).join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<text x="14" y="26" fill="${palette.title}" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700">${escapeHtml(title)}</text>`,
    `<text x="${width - 14}" y="26" text-anchor="end" fill="${palette.valueLabel}" font-family="Consolas, Menlo, monospace" font-size="12">${escapeHtml(valueLabel)}</text>`,
    `<g font-family="Segoe UI, Arial, sans-serif">${rowSvg}</g>`,
    `</svg>`,
  ].join("");
}

function encodeSvgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function buildBitfieldFallbackMarkdown(decode: BitfieldDecodeResult): string {
  const rows = decode.fields.map((field) => {
    const marker = field.active ? "**ON**" : "zero";
    const bits = buildMembersDetailText(field, decode.value) || buildBitRangeText(field);
    const comment = collectFieldComment(field);
    const commentText = comment ? ` - _${comment}_` : "";
    return `- ${marker} \`${field.name}\` = \`${field.value}\`${bits ? ` (${bits})` : ""}${commentText}`;
  });

  return (
    `**Active:** ${formatSummaryList(decode.activeFields)}  \n` +
    `Inactive: ${formatSummaryList(decode.inactiveFields)}\n\n` +
    rows.join("\n")
  );
}

export function formatBitfieldDecodeMarkdown(
  decode: BitfieldDecodeResult,
  options: BitfieldDecodeFormatOptions = {}
): string | null {
  if (!decode || decode.fields.length === 0) {
    return null;
  }

  const targetLabel = decode.target
    ? `${escapeHtml(decode.target)} decoded:`
    : "Value decoded:";
  const lines: string[] = [`### ${targetLabel}`];

  try {
    const svg = buildBitfieldDecodeSvg(decode, options.theme ?? "light");
    lines.push(`![${targetLabel}](${encodeSvgDataUri(svg)})`);
  } catch {
    lines.push(buildBitfieldFallbackMarkdown(decode));
  }

  return lines.join("\n");
}

export function parseRegisterAssignment(
  lineText: string
): { lhs: string; rhs: string } | null {
  const match = lineText.match(
    /^(?:\s*)([A-Za-z_][A-Za-z0-9_]*(?:\s*(?:->|\.)\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*=\s*(.+?);?\s*$/
  );
  if (!match) {
    return null;
  }

  const lhs = match[1].replace(/\s+/g, "");
  const rhs = match[2].trim();
  if (!rhs) {
    return null;
  }

  return { lhs, rhs };
}
