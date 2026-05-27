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

  // Dividi sull'operatore di accesso (->, .) preservando i confini dei token.
  //
  // Vecchio approccio:  replace("->"|".", "_") poi split("_")
  //   → "ADC1_COMMON->CCR" diventava ["ADC1","COMMON","CCR"]  ← SBAGLIATO
  //   → la variabile "ADC1_COMMON" veniva spezzata internamente
  //
  // Nuovo approccio:  split sul solo operatore
  //   → "ADC1_COMMON->CCR"     → ["ADC1_COMMON", "CCR"]       ← CORRETTO
  //   → "TIM2->CR1"            → ["TIM2", "CR1"]
  //   → "handle->Instance->CR1"→ ["handle", "Instance", "CR1"]
  //   → "my_timer.CR1"         → ["my_timer", "CR1"]
  const accessChain = raw.split(/->|\./).map((s) => s.trim()).filter(Boolean);

  if (accessChain.length < 2 || accessChain.length > 3) {
    return false;
  }

  const identifierRx = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const part of accessChain) {
    if (!identifierRx.test(part)) {
      return false;
    }
  }

  const hasDefineContext = allDefines !== undefined;

  // ── Risoluzione del prefisso ────────────────────────────────────────────

  let matchedPrefix: string | null = null;

  if (hasDefineContext) {
    if (accessChain.length === 2) {
      // Caso semplice: instance->register  o  instance.register
      const [instanceName, registerName] = accessChain;
      matchedPrefix =
        resolveDefinePrefix(instanceName, registerName, allDefines) ?? null;
    } else {
      // Catena a 3 livelli, es. "handle->Instance->CR1".
      // Interpretazione A: instance = chain[0]_chain[1], register = chain[2]
      const [p0, p1, p2] = accessChain;
      matchedPrefix =
        resolveDefinePrefix(`${p0}_${p1}`, p2, allDefines) ?? null;

      // Interpretazione B: instance = chain[0], register = chain[1]
      // (chain[2] è un nome di campo già estratto, es. in un'espressione composta)
      if (!matchedPrefix) {
        matchedPrefix =
          resolveDefinePrefix(p0, p1, allDefines) ?? null;
      }
    }
  } else {
    // ── Fallback senza define: matching puramente testuale ──────────────────
    // Fallback without define context: pure string matching.
    const [instanceName, registerName] = accessChain;

    // Same uppercase normalisation: define-derived prefixes are always uppercase.
    const inst = instanceName.toUpperCase();
    const reg  = registerName.toUpperCase();

    const strippedFirst    = stripInstanceSuffix(inst);
    const candidateExact   = `${inst}_${reg}`;
    const candidateGeneric = `${strippedFirst}_${reg}`;

    return (
      entry.registerPrefix === candidateExact ||
      entry.registerPrefix === candidateGeneric
    );
  }

  if (!matchedPrefix) {
    return false;
  }

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
    `^${escapeRegexForPrefix(normalizedPrefix)}[A-Za-z0-9_]+_(?:Pos|pos|Msk|msk)$`
  );

  for (const name of allDefines.keys()) {
    if (rx.test(name)) {
      return true;
    }
  }

  return false;
}

/**
 * Ricava il "tipo" del periferico eliminando il suffisso istanza dal nome
 * della variabile, per confrontarlo con i prefissi delle #define.
 *
 *   TIM2    → TIM       (cifre finali – la maggior parte delle famiglie MCU)
 *   USART1  → USART
 *   ADC3    → ADC
 *   LPUART1 → LPUART
 *   GPIOA   → GPIO      (singola lettera finale – nomi di porta STM32)
 *   GPIOB   → GPIO
 *   CAN     → CAN       (nome corto senza suffisso, lasciato intatto)
 */
function stripInstanceSuffix(name: string): string {
  // 1. Cifre finali (caso più comune: TIM2, SPI1, USART3, ADC1 …)
  const noDigits = name.replace(/\d+$/, "");
  if (noDigits !== name && noDigits.length > 0) {
    return noDigits;
  }
  // 2. Singola lettera maiuscola finale (GPIOA → GPIO).
  //    Guardia: il risultato deve avere almeno 3 caratteri per evitare
  //    over-stripping su nomi corti (es. CAN → CA non viene prodotto).
  if (name.length >= 4 && /[A-Z]$/.test(name)) {
    return name.slice(0, -1);
  }
  return name;
}

/**
 * Verifica se un dato prefisso è associato a define di bitfield,
 * riconoscendo i tre stili prevalenti nelle famiglie MCU:
 *
 *  1. CMSIS moderno (STM32 LL / CMSIS-Core):
 *       PREFIX_CAMPO_Pos  /  PREFIX_CAMPO_Msk
 *
 *  2. Bit numerati (STM32 HAL per campi multi-bit):
 *       PREFIX_CAMPO_0, PREFIX_CAMPO_1, PREFIX_CAMPO_2 …
 *
 *  3. Maschere dirette vecchio stile (STM8, CMSIS pre-v5):
 *       PREFIX_CAMPO  (richiede ≥ 3 define distinti per ridurre i falsi positivi
 *                      rispetto a costanti generiche a due token)
 */
function hasAnyBitfieldDefines(
  prefix: string,
  allDefines: Map<string, string>
): boolean {
  // Stile 1 – _Pos / _Msk
  if (hasPositionalOrMaskDefines(prefix, allDefines)) {
    return true;
  }

  const normalizedPrefix = prefix.endsWith("_") ? prefix : `${prefix}_`;
  const esc = escapeRegexForPrefix(normalizedPrefix);

  // Stile 2 – bit numerati  PREFIX_CAMPO_N
  const numberedRx = new RegExp(`^${esc}[A-Za-z][A-Za-z0-9_]*_\\d+$`);
  for (const name of allDefines.keys()) {
    if (numberedRx.test(name)) {
      return true;
    }
  }

  // Stile 3 – maschere dirette  PREFIX_CAMPO  (≥ 3 occorrenze)
  const directRx = new RegExp(`^${esc}[A-Za-z][A-Za-z0-9]+$`);
  let directCount = 0;
  for (const name of allDefines.keys()) {
    if (directRx.test(name) && ++directCount >= 3) {
      return true;
    }
  }

  return false;
}

/**
 * Cerca in tutti i define il pattern  TIPO_NOMEREG_CAMPO_Pos/Msk
 * e restituisce i prefissi "TIPO_NOMEREG" trovati.
 *
 * Usato come fallback quando il nome della variabile prima del punto
 * non codifica il tipo del periferico (es. "my_timer.CR1"):
 * se un solo tipo possiede quel registro, la corrispondenza è non ambigua.
 *
 * Volutamente limitato allo stile _Pos/_Msk per massima precisione.
 */
function findPrefixesByRegisterName(
  registerName: string,
  allDefines: Map<string, string>
): string[] {
  const candidates = new Set<string>();
  const escapedReg = escapeRegexForPrefix(registerName);
  // es. "TIM_CR1_CEN_Pos" → cattura "TIM" come gruppo 1 → prefisso "TIM_CR1"
  const rx = new RegExp(
    `^([A-Za-z][A-Za-z0-9]*)_${escapedReg}_[A-Za-z][A-Za-z0-9_]*_(?:Pos|pos|Msk|msk)$`
  );
  for (const name of allDefines.keys()) {
    const m = name.match(rx);
    if (m) {
      candidates.add(`${m[1]}_${registerName}`);
    }
  }
  return Array.from(candidates);
}

/**
 * Risolve il prefisso register-define (es. "TIM_CR1") a partire dai
 * componenti dell'espressione di accesso.
 *
 * Strategia in ordine di priorità:
 *  1. Esatto:   INSTANCE_REGISTER         (es. TIM2_CR1 se i define usano quel prefisso)
 *  2. Generico: STRIPPED_INSTANCE_REGISTER (es. TIM_CR1 dopo TIM2→TIM o GPIOA→GPIO)
 *  3. Fallback dot-notation: cerca in tutti i define un prefisso *non ambiguo*
 *     TYPE_REGISTER — utile quando la variabile prima del punto ha un nome
 *     arbitrario che non corrisponde al tipo del periferico (es. "my_timer.CR1").
 *     Non viene applicato se più tipi condividono lo stesso nome di registro
 *     (es. CR1 è presente in TIM, SPI, USART, …): preferibile non decodificare
 *     anziché mostrare campi sbagliati.
 */
function resolveDefinePrefix(
  instanceName: string,
  registerName: string,
  allDefines: Map<string, string>
): string | undefined {
  // Normalise to uppercase: MCU peripheral defines are always uppercase,
  // while the source variable may use any case (tim1->cr1, TIM1->CR1, …).
  const inst = instanceName.toUpperCase();
  const reg  = registerName.toUpperCase();

  // 1. Exact prefix
  const exactPrefix = `${inst}_${reg}`;
  if (hasAnyBitfieldDefines(exactPrefix, allDefines)) {
    return exactPrefix;
  }

  // 2. Generic peripheral type (TIM2→TIM, GPIOA→GPIO)
  const genericInstance = stripInstanceSuffix(inst);
  if (genericInstance !== inst) {
    const genericPrefix = `${genericInstance}_${reg}`;
    if (hasAnyBitfieldDefines(genericPrefix, allDefines)) {
      return genericPrefix;
    }
  }

  // 3. Dot-notation fallback (unambiguous register name)
  const byRegName = findPrefixesByRegisterName(reg, allDefines);
  if (byRegName.length === 1) {
    return byRegName[0];
  }

  return undefined;
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
  // Senza contesto di accesso registro (nessun -> o .) non decodificare:
  // non sappiamo a quale registro il valore appartiene e mostreremmo
  // entry casuali estratti dall'intero set di #define.
  const contextIdentifier = context ? context.trim() : "";
  if (!contextIdentifier) {
    return null;
  }

  const entries = buildBitfieldEntries(allDefines, state);
  if (entries.length === 0) {
    return null;
  }

  const candidates = entries.filter(
    (entry) => matchesContext(entry, contextIdentifier, allDefines)
  );

  // Se il contesto è presente ma non corrisponde a nessun registro noto,
  // non fare fallback al set completo: restituire null è più corretto
  // che mostrare bitfield di periferici non correlati.
  if (candidates.length === 0) {
    return null;
  }

  const fields = candidates
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
    target: contextIdentifier,
    value,
    fields,
    activeFields:   fields.filter((f) => f.active).map((f) => f.name),
    inactiveFields: fields.filter((f) => !f.active).map((f) => f.name),
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
