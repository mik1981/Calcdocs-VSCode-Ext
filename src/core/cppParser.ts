import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

import { updateBraceDepth } from "../utils/braceDepth";
import { DEFINE_RX, SRC_EXTS, TOKEN_RX } from "../utils/regex";
import { stripComments, stripLineContinuations, createCommentStripper } from "../utils/text";
import { type FunctionMacroDefinition, safeEval } from "./expression";
import {
  SymbolConditionalDefinition,
  SymbolDefinitionLocation,
} from "./state";
import { type ColoredOutput } from "../utils/output";

export type CppSymbolDefinition = {
  name: string;
  expr: string;
  macroParams?: string[];
};

export type CollectedCppSymbols = {
  defines: Map<string, string>;
  defineConditions: Map<string, string>;
  defineComments: Map<string, string>;
  functionDefines: Map<string, FunctionMacroDefinition>;
  defineVariants: Map<string, SymbolConditionalDefinition[]>;
  consts: Map<string, number>;
  units: Map<string, string>;
  locations: Map<string, SymbolDefinitionLocation>;
};

export type CollectOptions = {
  resolveIncludes?: boolean;
  output?: ColoredOutput;
  workspaceRoot?: string;
  maxMegaCacheEntries?: number;
  /**
   * Indice basename(header).toLowerCase() -> path assoluti, costruito da
   * scanWorkspace()/ensureHeaderIndexPopulated() in analysis.ts. Usato da
   * resolveInclude() come fallback quando l'euristica a directory fisse
   * (Inc/, include/, headers/...) non trova l'header.
   */
  headerIndex?: Map<string, string[]>;
  /** 0/undefined su ciascun campo = calcolato automaticamente in base
   * alla macchina (RAM totale) invece di costanti fisse. */
  megaBudgetOverrides?: MegaBudgetOverrides;
  /** Directory (storage privato dell'estensione) dove persistere il
   * mega-content espanso tra una sessione di VS Code e l'altra.
   * undefined = nessuna persistenza su disco, solo cache in RAM. */
  megaContentCacheDir?: string;
};

type ParsedDefineDirective = {
  name: string;
  expr: string;
  params?: string[];
  comment?: string;
};

type ParsedValueDeclaration = {
  name: string;
  expr: string;
  isConst?: boolean;
  isStatic?: boolean;
  isDefinition?: boolean;
  comment?: string;
};

function extractCppLineComment(text: string): string | undefined {
  let inString: string | null = null;

  for (let i = 0; i < text.length - 1; i += 1) {
    const current = text[i];
    const next = text[i + 1];

    if (inString) {
      if (current === "\\") {
        i += 1;
        continue;
      }
      if (current === inString) {
        inString = null;
      }
      continue;
    }

    if (current === '"' || current === "'" || current === "`") {
      inString = current;
      continue;
    }

    if (current === "/" && next === "/") {
      return text.slice(i + 2).trim();
    }
    if (current === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end !== -1) {
        return text.slice(i + 2, end).trim();
      }
      return text.slice(i + 2).trim();
    }
  }

  return undefined;
}

type ConditionalFrame = {
  parentCondition: string | null;
  branchConditions: string[];
  activeCondition: string;
};

const IFDEF_RX = /^\s*#\s*ifdef\s+([A-Za-z_]\w*)\b/;
const IFNDEF_RX = /^\s*#\s*ifndef\s+([A-Za-z_]\w*)\b/;
const IF_RX = /^\s*#\s*if\b(.+)$/;
const ELIF_RX = /^\s*#\s*elif\b(.+)$/;
const ELSE_RX = /^\s*#\s*else\b/;
const ENDIF_RX = /^\s*#\s*endif\b/;
const UNDEF_RX = /^\s*#\s*undef\s+([A-Za-z_]\w*)\b/;
const CONTROL_FLOW_KEYWORD_RX =
  /^(?:if|else|for|while|switch|case|return|goto|do)\b/;
const UNIT_COMMENT_RX = /@unit=([a-zA-Z0-9^*/_%-]+)/;

/** Regex per catturare #include "file" o <file> */
const INCLUDE_RX = /^\s*#include\s+["<]([^">]+)[">]/i;

type FileStamp = {
  mtimeMs: number;
  size: number;
};

type MegaCacheEntry = {
  content: string;
  dependencies: Map<string, FileStamp>;
  byteSize: number;
  lastAccessed: number;
};

const DEFAULT_MEGA_CACHE_MAX_ENTRIES = 50; // Increased for test files
const MIN_MEGA_CACHE_ENTRIES = 1;
const megaCache = new Map<string, MegaCacheEntry>();

/**
 * Clears the in-RAM mega-content cache only (not the on-disk mirror, not
 * any of the other per-module caches elsewhere in the codebase). For a
 * complete "invalidate everything" (RAM + disk, all caches), use
 * invalidateAllCalcDocsCaches() in core/cacheManager.ts instead — that's
 * what "Force Recompute" and "Restart CalcDocs" actually call.
 */
export function clearCppParserCache(): void {
  megaCache.clear();
}

function normalizeCacheKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  // Solo Windows ha filesystem case-insensitive di default
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function getFileStamp(filePath: string, output?: ColoredOutput): Promise<FileStamp | null> {
  try {
    const stat = await fsp.stat(filePath);
    return {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch (err) {
    output?.warn(`[MegaStamp] ❌ Missing dep: ${path.relative(process.cwd(), filePath)}`);
    return null;
  }
}

async function isMegaCacheEntryValid(entry: MegaCacheEntry, output?: ColoredOutput): Promise<boolean> {
  // Le dipendenze vengono controllate in PARALLELO (non una alla volta):
  // per un file con centinaia di header coinvolti (tipico con HAL+CMSIS),
  // farlo in sequenza significava centinaia di syscall stat() una dopo
  // l'altra solo per confermare che la cache fosse valida — il costo
  // cresceva linearmente col numero di dipendenze anche a cache HIT.
  const checks = await Promise.all(
    Array.from(entry.dependencies, async ([dependencyPath, previousStamp]) => {
      const currentStamp = await getFileStamp(dependencyPath, output);
      if (!currentStamp) {
        return { dependencyPath, reason: "missing" as const };
      }
      if (
        currentStamp.mtimeMs !== previousStamp.mtimeMs ||
        currentStamp.size !== previousStamp.size
      ) {
        return { dependencyPath, reason: "changed" as const };
      }
      return null;
    })
  );

  const firstInvalid = checks.find((c) => c !== null);
  if (firstInvalid) {
    output?.appendLine(
      `[MegaValid] ❌ Invalid cache (${firstInvalid.reason}): ${path.basename(firstInvalid.dependencyPath)}`
    );
    return false;
  }

  return true;
}

function touchMegaCacheEntry(cacheKey: string, entry: MegaCacheEntry): void {
  entry.lastAccessed = Date.now();
  megaCache.delete(cacheKey);
  megaCache.set(cacheKey, entry);
}

function clampMegaCacheEntries(maxMegaCacheEntries: number | undefined): number {
  if (!Number.isFinite(maxMegaCacheEntries)) {
    return DEFAULT_MEGA_CACHE_MAX_ENTRIES;
  }

  return Math.max(MIN_MEGA_CACHE_ENTRIES, Math.floor(maxMegaCacheEntries!));
}

function evictOldMegaEntries(maxEntries: number, output?: ColoredOutput): void {
  while (megaCache.size > maxEntries) {
    const oldest = megaCache.keys().next();
    if (oldest.done) {
      break;
    }

    const oldestKey = oldest.value;
    const oldestEntry = megaCache.get(oldestKey);
    megaCache.delete(oldestKey);

    if (oldestEntry) {
      output?.detail(
        `[Mega] LRU evict ${path.basename(oldestKey)} (${(oldestEntry.byteSize / 1024).toFixed(1)}kB)`
      );
    }
  }
}

/**
 * ---------------------------------------------------------------------
 * Persistenza su disco del mega-content (non solo dell'elenco header).
 * ---------------------------------------------------------------------
 * L'in-memory megaCache sopra si svuota ad ogni riavvio di VS Code: se
 * riapri lo stesso file .c dopo un restart, si ricostruisce da zero
 * l'intera espansione #include anche se NESSUNA dipendenza è cambiata
 * dall'ultima sessione. Questo layer aggiunge un file JSON per sorgente
 * (dentro lo storage privato dell'estensione, mai nel workspace
 * dell'utente) con lo STESSO meccanismo di validità già usato in memoria
 * (mtime+size di ogni dipendenza) — se anche un solo header è cambiato,
 * la entry viene scartata e ricostruita normalmente.
 *
 * In più, un budgetSignature: se cambiano i parametri effettivi del
 * budget adattivo (RAM diversa, config utente modificata, ecc.) tra una
 * sessione e l'altra, la entry su disco viene invalidata anche se le
 * dipendenze non sono cambiate — evita di riusare per sempre un
 * mega-content tagliato con un budget più stretto di quello attuale.
 */

type MegaDiskCacheEntry = {
  version: number;
  content: string;
  dependencies: Array<[string, FileStamp]>;
  byteSize: number;
  savedAt: number;
  budgetSignature: string;
};

// v2: le build TRONCATE (budget adattivo esaurito a metà #include) non
// vengono più persistite su disco (vedi buildMegaContent). Il bump della
// versione invalida automaticamente qualunque entry scritta prima di
// questo fix, che potrebbe contenere una build incompleta "congelata" —
// nessun bisogno di svuotare la cache a mano.
const MEGA_DISK_CACHE_VERSION = 2;

function megaBudgetSignature(budget: MegaBudget): string {
  // remainingChars al momento della creazione del budget è il TOTALE
  // disponibile (non ancora consumato), quindi è stabile per sessione e
  // rappresentativo del "profilo" di budget usato per costruire l'entry.
  return `${MEGA_DISK_CACHE_VERSION}:${budget.remainingChars}:${budget.maxDepth}`;
}

function megaDiskCacheFilePath(cacheDir: string, cacheKey: string): string {
  const hash = crypto.createHash("sha1").update(cacheKey).digest("hex");
  return path.join(cacheDir, `${hash}.json`);
}

async function loadMegaContentFromDisk(
  cacheDir: string,
  cacheKey: string,
  expectedBudgetSignature: string,
  output?: ColoredOutput
): Promise<MegaCacheEntry | null> {
  const filePath = megaDiskCacheFilePath(cacheDir, cacheKey);
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return null; // nessuna entry su disco, normale
  }

  let parsed: MegaDiskCacheEntry;
  try {
    parsed = JSON.parse(raw) as MegaDiskCacheEntry;
  } catch {
    output?.warn(`[MegaDisk] ⚠️ Cache corrotta per ${path.basename(cacheKey)}, la ignoro.`);
    return null;
  }

  if (parsed.version !== MEGA_DISK_CACHE_VERSION || parsed.budgetSignature !== expectedBudgetSignature) {
    return null; // formato o budget diversi da quelli correnti: ricostruisci
  }

  const dependencies = new Map<string, FileStamp>(parsed.dependencies);
  const candidate: MegaCacheEntry = {
    content: parsed.content,
    dependencies,
    byteSize: parsed.byteSize,
    lastAccessed: Date.now(),
  };

  const isValid = await isMegaCacheEntryValid(candidate, output);
  if (!isValid) {
    return null; // una dipendenza è cambiata dall'ultima sessione
  }

  output?.appendLine(
    `[MegaDisk] 💾 Idratato da cache su disco: ${path.basename(cacheKey)} (${(candidate.byteSize / 1024).toFixed(1)}kB)`
  );
  return candidate;
}

// La scrittura su disco viene DEBOUNCED per singolo cacheKey, non
// eseguita subito ad ogni rebuild. Motivo: il file sorgente è tra le
// proprie dipendenze (dependencyTracker include sourcePath), quindi ogni
// singolo salvataggio del file attivo invalida la sua stessa entry su
// disco — senza debounce, ogni Ctrl+S durante l'editing attivo
// serializzerebbe e scriverebbe di nuovo un JSON potenzialmente da
// diversi MB, per un beneficio nullo (tanto verrebbe invalidato al
// prossimo salvataggio). Con il debounce, durante una sessione di editing
// continuo si scrive solo quando l'attività si placa per qualche secondo.
const MEGA_DISK_WRITE_DEBOUNCE_MS = 4000;
type PendingMegaDiskWrite = {
  timer: NodeJS.Timeout;
  perform: () => Promise<void>;
};
const megaDiskWriteTimers = new Map<string, PendingMegaDiskWrite>();

function scheduleMegaContentDiskWrite(
  cacheDir: string,
  cacheKey: string,
  entry: MegaCacheEntry,
  budgetSignature: string,
  maxDiskEntries: number,
  output?: ColoredOutput
): void {
  const existing = megaDiskWriteTimers.get(cacheKey);
  if (existing) {
    clearTimeout(existing.timer);
  }
  const perform = () => saveMegaContentToDisk(cacheDir, cacheKey, entry, budgetSignature, maxDiskEntries, output);
  const timer = setTimeout(() => {
    megaDiskWriteTimers.delete(cacheKey);
    void perform();
  }, MEGA_DISK_WRITE_DEBOUNCE_MS);
  megaDiskWriteTimers.set(cacheKey, { timer, perform });
}

/**
 * Da chiamare da deactivate(): scrive subito su disco tutte le entry che
 * erano in attesa nel debounce, cosi' l'ultima versione analizzata prima
 * della chiusura di VS Code non va persa per la prossima sessione.
 */
export async function flushPendingMegaContentDiskWrites(): Promise<void> {
  const pending = [...megaDiskWriteTimers.values()];
  megaDiskWriteTimers.clear();
  for (const { timer } of pending) {
    clearTimeout(timer);
  }
  await Promise.all(pending.map((p) => p.perform()));
}

/**
 * Da chiamare quando si sta per invalidare esplicitamente la cache su
 * disco ("Force Recompute"/"Restart CalcDocs"): annulla le scritture
 * debounced in attesa SENZA eseguirle. A differenza di
 * flushPendingMegaContentDiskWrites(), qui eseguirle sarebbe controproducente:
 * ricreerebbero pochi istanti dopo un file che l'utente ha appena chiesto
 * di cancellare, vanificando l'invalidazione.
 */
export function cancelPendingMegaContentDiskWrites(): void {
  for (const { timer } of megaDiskWriteTimers.values()) {
    clearTimeout(timer);
  }
  megaDiskWriteTimers.clear();
}

/**
 * Cancella tutte le entry della cache su disco per il mega-content
 * espanso. Usata da "Force Recompute"/"Restart CalcDocs" per garantire
 * un'invalidazione realmente completa (RAM + disco), non solo della
 * megaCache in memoria come faceva la vecchia clearCppParserCache() da
 * sola. Non fatale se la directory non esiste ancora: nessuna entry da
 * cancellare è uno stato normale, non un errore.
 */
export async function clearMegaContentDiskCache(
  cacheDir: string | undefined,
  output?: ColoredOutput
): Promise<void> {
  if (!cacheDir) {
    return;
  }

  let entries: string[];
  try {
    entries = (await fsp.readdir(cacheDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (name) => {
      try {
        await fsp.unlink(path.join(cacheDir, name));
      } catch {
        // non fatale: al più resta un file orfano su disco
      }
    })
  );

  if (entries.length > 0) {
    output?.detail(`[MegaDisk] 🧹 Cache su disco svuotata (${entries.length} file rimossi).`);
  }
}

async function saveMegaContentToDisk(
  cacheDir: string,
  cacheKey: string,
  entry: MegaCacheEntry,
  budgetSignature: string,
  maxDiskEntries: number,
  output?: ColoredOutput
): Promise<void> {
  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    const payload: MegaDiskCacheEntry = {
      version: MEGA_DISK_CACHE_VERSION,
      content: entry.content,
      dependencies: [...entry.dependencies.entries()],
      byteSize: entry.byteSize,
      savedAt: Date.now(),
      budgetSignature,
    };
    const filePath = megaDiskCacheFilePath(cacheDir, cacheKey);
    await fsp.writeFile(filePath, JSON.stringify(payload), "utf8");
    await pruneMegaDiskCache(cacheDir, maxDiskEntries, output);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    output?.warn(`[MegaDisk] ⚠️ Salvataggio fallito per ${path.basename(cacheKey)}: ${message}`);
  }
}

/**
 * Evizione LRU per la cache su disco, analoga a evictOldMegaEntries() ma
 * basata sull'mtime dei file invece che su un Map ordinato in memoria.
 * Usa lo stesso limite (maxMegaCacheEntries) della cache in RAM: non ha
 * senso persistere più entry di quante ne teniamo comunque "calde".
 */
async function pruneMegaDiskCache(cacheDir: string, maxEntries: number, output?: ColoredOutput): Promise<void> {
  let entries: string[];
  try {
    entries = (await fsp.readdir(cacheDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }

  if (entries.length <= maxEntries) {
    return;
  }

  const stamped = await Promise.all(
    entries.map(async (name) => {
      const full = path.join(cacheDir, name);
      try {
        const stat = await fsp.stat(full);
        return { full, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
  );

  const valid = stamped.filter((s): s is { full: string; mtimeMs: number } => s !== null);
  valid.sort((a, b) => a.mtimeMs - b.mtimeMs); // più vecchi prima

  const toDelete = valid.slice(0, valid.length - maxEntries);
  for (const { full } of toDelete) {
    try {
      await fsp.unlink(full);
    } catch {
      // non fatale: al più resta un file orfano su disco
    }
  }
  if (toDelete.length > 0) {
    output?.detail(`[MegaDisk] 🧹 Rimosse ${toDelete.length} entry vecchie dalla cache su disco.`);
  }
}


/**
 * Guard-rail contro l'esplosione del mega-content quando la catena di
 * #include raggiunge un header "ombrello" di un vendor SDK (es. HAL
 * STM32) che include, senza guardie #ifdef valutate da questo parser
 * testuale, decine di driver di periferica per volta.
 *
 * Il budget NON e' più una costante fissa "indovinata" su un singolo PC:
 * remainingChars e deadline sono calcolati da computeAdaptiveMegaBudget()
 * a partire dalla RAM totale della macchina e da un tempo massimo per
 * file. Questo si adatta automaticamente a hardware diversi: su una
 * macchina con poca RAM il budget in caratteri si restringe da solo; su
 * una CPU lenta il budget di tempo scade prima (in termini di lavoro
 * svolto) senza bisogno di ritoccare nessuna costante a mano.
 *
 * remainingChars/truncated/deadline/resolvedCount sono condivisi (stesso
 * oggetto) per tutta la ricorsione di un singolo buildMegaContent();
 * depth invece viaggia per-livello come parametro separato, cosi'
 * riflette la profondita' del ramo corrente e non quella globale.
 */
export type MegaBudget = {
  remainingChars: number;
  truncated: boolean;
  deadline: number;
  maxDepth: number;
  resolvedCount: number;
};

export type MegaBudgetOverrides = {
  /** 0/undefined = calcolato automaticamente dalla RAM disponibile. */
  maxChars?: number;
  /** 0/undefined = default adattivo (vedi DEFAULT_MEGA_TIME_BUDGET_MS). */
  maxTimeMs?: number;
  /** 0/undefined = default generoso (vedi DEFAULT_MEGA_INCLUDE_MAX_DEPTH). */
  maxDepth?: number;
};

// Pavimento/tetto di sicurezza per il budget in caratteri: anche il
// calcolo "adattivo" resta dentro questi limiti, cosi' non scende mai
// sotto una soglia che romperebbe progetti reali ne' sale abbastanza da
// vanificare lo scopo del guard-rail su una macchina con tantissima RAM.
const MEGA_CHARS_FLOOR = 150_000;
const MEGA_CHARS_CEILING = 4_000_000;
const MEGA_CHARS_RAM_FRACTION = 0.02; // usa al più il 2% della RAM totale
const BYTES_PER_JS_CHAR = 2; // stringhe JS in UTF-16

const DEFAULT_MEGA_TIME_BUDGET_MS = 1200;
const DEFAULT_MEGA_INCLUDE_MAX_DEPTH = 40;

// Ogni tot #include risolti, cede il controllo all'event loop invece di
// bloccarlo per l'intera durata del budget di tempo. Questo è ciò che
// impedisce a VS Code di mostrare "Extension host not responding" anche
// quando il lavoro (legittimo, dentro budget) richiede diverse centinaia
// di millisecondi: l'estensione resta reattiva ad hover/keystroke nel
// frattempo, invece di monopolizzare il thread.
const YIELD_EVERY_N_INCLUDES = 15;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Calcola un budget di caratteri "sicuro" per macchina, invece di una
 * costante fissa. cacheEntries tiene conto che possono coesistere fino a
 * quel numero di mega-content in cache contemporaneamente (megaCache),
 * quindi il budget per singolo file viene ripartito di conseguenza.
 */
function computeAdaptiveMegaCharBudget(cacheEntries: number): number {
  const totalMemBytes = os.totalmem() || 2 * 1024 * 1024 * 1024; // fallback 2GB
  const totalBudgetBytes = totalMemBytes * MEGA_CHARS_RAM_FRACTION;
  const perEntryBudgetBytes = totalBudgetBytes / Math.max(1, cacheEntries);
  const computedChars = Math.floor(perEntryBudgetBytes / BYTES_PER_JS_CHAR);
  return Math.min(MEGA_CHARS_CEILING, Math.max(MEGA_CHARS_FLOOR, computedChars));
}

/**
 * Punto unico da cui parte il budget di un buildMegaContent(). Espone il
 * calcolo adattivo separatamente cosi' e' testabile/ispezionabile senza
 * dover invocare l'intera pipeline di parsing.
 */
export function computeMegaBudget(
  cacheEntries: number,
  overrides?: MegaBudgetOverrides
): MegaBudget {
  const remainingChars =
    overrides?.maxChars && overrides.maxChars > 0
      ? overrides.maxChars
      : computeAdaptiveMegaCharBudget(cacheEntries);

  const timeBudgetMs =
    overrides?.maxTimeMs && overrides.maxTimeMs > 0
      ? overrides.maxTimeMs
      : DEFAULT_MEGA_TIME_BUDGET_MS;

  const maxDepth =
    overrides?.maxDepth && overrides.maxDepth > 0
      ? overrides.maxDepth
      : DEFAULT_MEGA_INCLUDE_MAX_DEPTH;

  return {
    remainingChars,
    truncated: false,
    deadline: Date.now() + timeBudgetMs,
    maxDepth,
    resolvedCount: 0,
  };
}

/**
 * Rileva directory "a pacchetto versionato" tipiche di package manager
 * (STM32Cube component packs, vcpkg, NuGet, ecc.), es:
 *   STMicroelectronics.CMSIS.6.3.0
 *   STMicroelectronics.stm32c5xx_hal_drivers.2.0.0
 * Un segmento e' considerato "vendor" se i suoi ultimi 3 token separati
 * da '.' sono tutti numerici (Major.Minor.Patch).
 */
function isVersionedPackageSegment(segment: string): boolean {
  const parts = segment.split('.');
  if (parts.length < 3) {
    return false;
  }
  return parts.slice(-3).every((p) => /^\d+$/.test(p));
}

function isVendorPackagePath(absPath: string): boolean {
  return absPath.split(path.sep).some(isVersionedPackageSegment);
}

/*
 * Adapted from analysis.ts createMegaSourceFile logic.
 */
async function resolveInclude(
  relIncludePath: string, 
  baseDir: string, 
  workspaceRoot: string,
  output: ColoredOutput | undefined,
  visited: Set<string>,
  dependencyTracker: Set<string>,
  budget: MegaBudget,
  depth: number,
  headerIndex?: Map<string, string[]>
): Promise<string> {
// FIXED: Prioritize inc/test/inc dirs for external headers
  // output?.appendLine(`[ResolveInclude] 🔍 Searching "${relIncludePath}" (baseDir="${path.relative(workspaceRoot, baseDir)}")`);
  
  const candidateDirs = [
    path.join(baseDir, '..', 'inc'),     // 0. Sibling inc/ (test/src → test/inc)
    path.join(workspaceRoot, 'test', 'inc'), // 1. Explicit test/inc
    path.join(workspaceRoot, 'inc'),     // 2. Workspace inc/
    path.join(workspaceRoot, 'include'), // 3. include/
    path.join(workspaceRoot, 'headers'), // 4. headers/
    baseDir,                             // 5. Source dir
    workspaceRoot,                       // 6. Root
    path.join(workspaceRoot, 'src')      // 7. src/
  ];
  
  let absIncludePath: string | null = null;
  let triedPaths: string[] = [];
  
  for (const dir of candidateDirs) {
    const candidatePath = path.resolve(dir, relIncludePath);
    triedPaths.push(path.relative(workspaceRoot || '.', candidatePath));
    try {
      await fsp.access(candidatePath);
      absIncludePath = candidatePath;
      output?.appendLine(`[ResolveInclude] ✅ Found: ${relIncludePath} → ${path.relative(workspaceRoot || '.', absIncludePath)} (in ${path.basename(path.dirname(absIncludePath))})`);
      break;
    } catch {
      // Continue to next directory
    }
  }
  
  if (!absIncludePath && headerIndex) {
    // FALLBACK: le candidateDirs sopra sono un elenco di convenzioni
    // indovinate (inc/, include/, headers/...) e non coprono layout
    // comuni come Core/Src + Core/Inc (STM32CubeIDE) o Drivers/<mod>/Inc.
    // Consultiamo l'indice reale del workspace prima di arrenderci.
    const basenameKey = path.basename(relIncludePath).toLowerCase();
    const candidates = headerIndex.get(basenameKey);

    if (candidates?.length === 1) {
      absIncludePath = candidates[0];
      output?.appendLine(
        `[ResolveInclude] ✅ Found via headerIndex: ${relIncludePath} → ${path.relative(workspaceRoot || '.', absIncludePath)}`
      );
    } else if (candidates && candidates.length > 1) {
      const sorted = [...candidates].sort((a, b) =>
        path.relative(baseDir, a).split(path.sep).length - path.relative(baseDir, b).split(path.sep).length
      );
      absIncludePath = sorted[0];
      output?.appendLine(
        `[ResolveInclude] ⚠️ Ambiguous via headerIndex: ${relIncludePath} has ${candidates.length} matches, using ${path.relative(workspaceRoot || '.', absIncludePath)}`
      );
    }
  }

  if (!absIncludePath) {
    // output?.appendLine(`[ResolveInclude] ❌ NOT FOUND: ${relIncludePath} (tried ${triedPaths.slice(0,5).join(' → ')}${triedPaths.length>5 ? '...' : ''})`);
    return '';
  }
  
  const key = normalizeCacheKey(absIncludePath);
  // output?.appendLine(`[ResolveInclude] Entry: ${relIncludePath} → ${key} (ext: ${path.extname(relIncludePath)})`);

  if (visited.has(key)) {
    // output?.appendLine(`[ResolveInclude] SKIP recursive include: ${path.basename(relIncludePath)}`);
    return '';
  }

  if (budget.truncated) {
    return '';
  }
  if (depth > budget.maxDepth) {
    budget.truncated = true;
    output?.appendLine(
      `[Mega] ⚠️ Include depth limit (${budget.maxDepth}) reached at "${relIncludePath}" — interrompo l'espansione di ulteriori #include.`
    );
    return '';
  }
  if (budget.remainingChars <= 0) {
    budget.truncated = true;
    output?.appendLine(
      `[Mega] ⚠️ Char budget esaurito prima di "${relIncludePath}" — interrompo l'espansione di ulteriori #include.`
    );
    return '';
  }
  if (Date.now() > budget.deadline) {
    budget.truncated = true;
    output?.appendLine(
      `[Mega] ⚠️ Time budget esaurito prima di "${relIncludePath}" — interrompo l'espansione di ulteriori #include (macchina lenta o albero #include molto ampio: normale, non è un errore).`
    );
    return '';
  }

  visited.add(key);
  dependencyTracker.add(absIncludePath);

  budget.resolvedCount += 1;
  if (budget.resolvedCount % YIELD_EVERY_N_INCLUDES === 0) {
    // Cede il controllo all'event loop cosi' VS Code resta reattivo
    // (hover, keystroke, ecc.) anche durante un'espansione legittima ma
    // corposa, invece di bloccare l'extension host per l'intera durata.
    await yieldToEventLoop();
  }

  let content: string;
  try {
    content = await fsp.readFile(absIncludePath, 'utf8');
    // output?.appendLine(`[ResolveInclude] Read ${relIncludePath}: lines=${content.split('\n').length}`);
  } catch (err) {
    // output?.appendLine(`[ResolveInclude] Failed read ${relIncludePath}: ${err}`);
    return '';
  }

  budget.remainingChars -= content.length;

  const skipNestedExpansion = isVendorPackagePath(absIncludePath);
  if (skipNestedExpansion) {
    output?.detail(
      `[Mega] 📦 Vendor package header "${path.relative(workspaceRoot || '.', absIncludePath)}": incluso ma i suoi #include annidati NON vengono espansi (evita l'esplosione dell'intero SDK per header ombrello tipo stm32_hal.h).`
    );
  }
  
  const lines = content.split(/\r?\n/);
  let processedContent = `\n`;
  
  for (const line of lines) {
  const includeMatch = line.match(INCLUDE_RX);
    if (includeMatch && !skipNestedExpansion) {
      // output?.appendLine(`[ResolveInclude] Found include match: ${includeMatch[1]}`);
      const nested = await resolveInclude(

        includeMatch[1], 
        path.dirname(absIncludePath), 
        workspaceRoot,
        output,
        visited,
        dependencyTracker,
        budget,
        depth + 1,
        headerIndex
      );
      processedContent += nested || line + '\n';
    } else {
      processedContent += line + '\n';
    }
  }
  
  return processedContent;
}

/**
 * Builds mega-content for main source file.
 */
async function buildMegaContent(
  sourcePath: string,
  workspaceRoot: string,
  output: ColoredOutput | undefined,
  maxMegaCacheEntries: number,
  headerIndex?: Map<string, string[]>,
  budgetOverrides?: MegaBudgetOverrides,
  cacheDir?: string
): Promise<string> {
  // Force clear cache for test files to avoid stale data
  if (sourcePath.includes('test')) {
    const testKey = normalizeCacheKey(sourcePath);
    if (megaCache.has(testKey)) {
      output?.appendLine(`[Mega] 🔄 Force clear test cache: ${path.basename(sourcePath)}`);
      megaCache.delete(testKey);
    }
  }
  
  const cacheKey = normalizeCacheKey(sourcePath);
  const cached = megaCache.get(cacheKey);
  if (cached) {
    const isValid = await isMegaCacheEntryValid(cached);
    if (isValid) {
      touchMegaCacheEntry(cacheKey, cached);
      output?.appendLine(
        `[Mega] CACHE HIT: ${path.basename(sourcePath)} (${(cached.byteSize / 1024).toFixed(1)}kB)`
      );
      return cached.content;
    }

    megaCache.delete(cacheKey);
    output?.appendLine(`[Mega] CACHE STALE: ${path.basename(sourcePath)} → rebuilding`);
  }

  // Il budget va calcolato PRIMA di poter controllare la cache su disco:
  // la firma del budget (budgetSignature) fa parte della validità di
  // un'eventuale entry persistita — vedi commento su MegaDiskCacheEntry.
  const budget: MegaBudget = computeMegaBudget(maxMegaCacheEntries, budgetOverrides);
  const budgetSignature = megaBudgetSignature(budget);

  if (cacheDir) {
    const fromDisk = await loadMegaContentFromDisk(cacheDir, cacheKey, budgetSignature, output);
    if (fromDisk) {
      touchMegaCacheEntry(cacheKey, fromDisk); // idrata anche la cache in RAM per i prossimi hit di questa sessione
      output?.appendLine(
        `[Mega] CACHE HIT (disco): ${path.basename(sourcePath)} (${(fromDisk.byteSize / 1024).toFixed(1)}kB)`
      );
      return fromDisk.content;
    }
  }

  output?.appendLine(`[Mega] CACHE MISS: ${path.basename(sourcePath)} → building fresh`);


  const visited = new Set<string>();
  const dependencyTracker = new Set<string>([path.resolve(sourcePath)]);
  const mainDir = path.dirname(sourcePath);
  output?.detail(
    `[Mega] 🧮 Budget adattivo per ${path.basename(sourcePath)}: ${(budget.remainingChars / 1000).toFixed(0)}k caratteri, profondità max ${budget.maxDepth}, tempo max ${Math.round(budget.deadline - Date.now())}ms (RAM totale macchina: ${(os.totalmem() / (1024 ** 3)).toFixed(1)}GB)`
  );
  
  let megaContent = `\n`;
  let mainContent: string;
  try {
    mainContent = await fsp.readFile(sourcePath, 'utf8');
  } catch (err) {
    output?.appendLine(`[Mega] Failed read main ${sourcePath}: ${err}`);
    return megaContent;
  }
  
  const mainLines = mainContent.split(/\r?\n/);
  
  for (const line of mainLines) {
    const includeMatch = line.match(INCLUDE_RX);
    if (includeMatch) {
      const included = await resolveInclude(
        includeMatch[1], 
        mainDir, 
        workspaceRoot,
        output,
        visited,
        dependencyTracker,
        budget,
        0,
        headerIndex
      );
      if (included) {
      output?.appendLine(`[Mega] included ${includeMatch[1]} in ${mainDir}`);
      }
      megaContent += included || line + '\n';
    } else {
      megaContent += line + '\n';
    }
  }

  if (budget.truncated) {
    output?.appendLine(
      `[Mega] ⚠️ ${path.basename(sourcePath)}: espansione #include troncata per limite di dimensione/profondità.`
    );
  }

  const lines = megaContent.split(/\r?\n/);
  const byteSize = Buffer.byteLength(megaContent);
  const sizeKB = (byteSize / 1024).toFixed(1);
  const dependencies = new Map<string, FileStamp>();
  for (const dependencyPath of dependencyTracker) {
    const stamp = await getFileStamp(dependencyPath);
    if (stamp) {
      dependencies.set(dependencyPath, stamp);
    }
  }

  const cacheEntry: MegaCacheEntry = {
    content: megaContent,
    dependencies,
    byteSize,
    lastAccessed: Date.now(),
  };
  megaCache.set(cacheKey, cacheEntry);
  evictOldMegaEntries(maxMegaCacheEntries, output);

  if (cacheDir && !budget.truncated) {
    // MAI persistere una build TRONCATA: se il budget adattivo scade a
    // metà (es. per un momento di carico elevato all'avvio, pura
    // sfortuna di timing), il risultato è incompleto — potrebbe mancare
    // un #include raggiunto tardi nella catena (es. l'header che
    // definisce una macro usata più avanti). Prima della cache su disco
    // una build troncata veniva ricostruita al prossimo trigger e
    // spesso "andava bene" la volta dopo; con la persistenza su disco,
    // se la salvassimo comunque, quel risultato incompleto resterebbe
    // "congelato" e riusato per sempre — anche tra sessioni diverse di
    // VS Code — perché dependency mtime e budgetSignature combaciano
    // comunque (il budget TOTALE disponibile è lo stesso, non riflette
    // se QUESTA build specifica lo ha effettivamente esaurito).
    // Debounced (non immediato): vedi commento su scheduleMegaContentDiskWrite.
    // Un mancato salvataggio su disco non deve mai rallentare o far
    // fallire l'analisi in corso, e' solo un'ottimizzazione per la
    // PROSSIMA sessione di VS Code.
    scheduleMegaContentDiskWrite(cacheDir, cacheKey, cacheEntry, budgetSignature, maxMegaCacheEntries, output);
  } else if (cacheDir && budget.truncated) {
    output?.appendLine(
      `[MegaDisk] ⏭️ ${path.basename(sourcePath)}: build troncata, NON persistita su disco (verrà ritentata al prossimo trigger).`
    );
  }

  output?.appendLine(`[Mega] Built ${path.basename(sourcePath)}: lines=${lines.length}, size=${sizeKB}kB`);
  return megaContent;
}


function findNextMeaningfulLine(
  lines: string[],
  startIndex: number
): string | null {
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const candidate = stripComments(lines[i]).trim();
    if (!candidate) {
      continue;
    }

    return candidate;
  }

  return null;
}

function isTopLevelIncludeGuard(
  lines: string[],
  lineIndex: number,
  guardSymbol: string,
  conditionalStackDepth: number
): boolean {
  if (conditionalStackDepth !== 0) {
    return false;
  }

  const nextMeaningfulLine = findNextMeaningfulLine(lines, lineIndex);
  if (!nextMeaningfulLine) {
    return false;
  }

  const defineMatch = nextMeaningfulLine.match(
    /^\s*#\s*define\s+([A-Za-z_]\w*)\b/
  );

  return Boolean(defineMatch && defineMatch[1] === guardSymbol);
}

function normalizeDirectiveCondition(raw: string): string {
  const cleaned = stripComments(raw).trim();
  return cleaned.length > 0 ? cleaned : "1";
}

function parseDefineNameDirective(line: string): string | undefined {
  const match = stripComments(line).match(/^\s*#\s*define\s+([A-Za-z_]\w*)\b/);
  return match?.[1];
}

function resolveCondition(
  rawCondition: string,
  defines: Map<string, string>,
  consts: Map<string, number>,
  definedSymbols: Set<string>,
  output?: ColoredOutput,
): string {
  const cleaned = stripComments(rawCondition).trim();
  if (!cleaned) {
    return "1";
  }

  rawCondition = rawCondition.replace(
    /defined\s*\(\s*(\w+)\s*\)/g,
    (_, name) => defines.has(name) ? "1" : "0"
  );

  let resolved = cleaned;
  // output?.appendLine(`resolveCondition input: "${rawCondition}" -> "${cleaned}"`); // TEMP DEBUG
  
  resolved = resolved.replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/gi, (_, symbol) => {
    return definedSymbols.has(symbol) || consts.has(symbol) ? "1" : "0";
  });
  
  resolved = resolved.replace(/!\s*defined\s*\(\s*([A-Za-z_]\w*)\s*\)/gi, (_, symbol) => {
    return definedSymbols.has(symbol) || consts.has(symbol) ? "0" : "1";
  });

  const tokenSet = new Set(resolved.match(TOKEN_RX) ?? []);
  const tokens = Array.from(tokenSet);

  for (const token of tokens) {
    if (token === "defined" || token === "sizeof" || token === "nullptr") {
      continue;
    }
    
    if (token === "not" || token === "and" || token === "or" ||
        token === "bitand" || token === "bitor" || token === "xor" ||
        token === "compl") {
      continue;
    }

    if (consts.has(token)) {
      const value = consts.get(token)!;
      resolved = resolved.replace(new RegExp(`\\b${token}\\b`, 'g'), String(value));
      continue;
    }

    if (definedSymbols.has(token) && !defines.has(token)) {
      resolved = resolved.replace(new RegExp(`\\b${token}\\b`, "g"), "1");
      continue;
    }

    if (defines.has(token)) {
      const expr = defines.get(token)!;

      try {
        const value = safeEval(expr);
        resolved = resolved.replace(new RegExp(`\\b${token}\\b`, 'g'), String(value));
      } catch {
        resolved = resolved.replace(new RegExp(`\\b${token}\\b`, 'g'), "1");
      }
      continue;
    }

    // In C preprocessor #if expressions, unknown identifiers are treated as 0.
    resolved = resolved.replace(new RegExp(`\\b${token}\\b`, "g"), "0");
  }

  try {
    const value = safeEval(resolved);
    output?.appendLine(`[resolveCondition] cleaned=${cleaned} resolved=${resolved} value=${value}`);
    return value !== 0 ? "1" : "0";
  } catch {
    output?.warn(`[resolveCondition] ⚠️ FAILED final eval (fallback 0): "${resolved}"`);
    return "0";
  }
}

const MAX_CONDITION_STRING_LENGTH = 4000;

function combineConditions(parent: string | null, branch: string): string {
  const normalizedBranch = branch.trim() || "1";

  if (!parent || parent === "1") {
    return normalizedBranch;
  }

  if (normalizedBranch === "1") {
    return parent;
  }

  const combined = `(${parent}) && (${normalizedBranch})`;
  if (combined.length > MAX_CONDITION_STRING_LENGTH) {
    return parent;
  }

  return combined;
}

function negateCondition(condition: string): string {
  const trimmed = condition.trim();
  if (!trimmed) {
    return "1";
  }

  if (trimmed === "1") {
    return "0";
  }

  const definedMatch = trimmed.match(/^defined\(\s*([A-Za-z_]\w*)\s*\)$/);
  if (definedMatch) {
    return `!defined(${definedMatch[1]})`;
  }

  const notDefinedMatch = trimmed.match(/^!defined\(\s*([A-Za-z_]\w*)\s*\)$/);
  if (notDefinedMatch) {
    return `defined(${notDefinedMatch[1]})`;
  }

  if (trimmed.startsWith("!(") && trimmed.endsWith(")")) {
    const inner = trimmed.slice(2, -1).trim();
    if (inner.length > 0) {
      return inner;
    }
  }

  return `!(${trimmed})`;
}

function buildElseCondition(branchConditions: string[]): string {
  if (branchConditions.length === 0) {
    return "1";
  }

  return branchConditions.map((condition) => negateCondition(condition)).join(" && ");
}

function normalizeVariantCondition(condition: string): string {
  const trimmed = condition.trim();
  if (!trimmed || trimmed === "1" || trimmed.toLowerCase() === "always") {
    return "always";
  }

  try {
    const value = safeEval(trimmed);
    if (Number.isFinite(value)) {
      return value !== 0 ? "always" : "0";
    }
  } catch {
    // keep raw symbolic condition when not directly evaluable
  }

  return trimmed.replace(/\s+/g, " ");
}

function normalizeVariantExpression(expr: string): string {
  return expr.trim().replace(/\s+/g, " ");
}

function buildVariantDedupKey(variant: SymbolConditionalDefinition): string {
  const normalizedCondition = normalizeVariantCondition(variant.condition);
  const normalizedExpression = normalizeVariantExpression(variant.expr);
  return `${normalizedCondition}::${normalizedExpression}`;
}

function dedupeDefineVariants(
  defineVariants: Map<string, SymbolConditionalDefinition[]>
): Map<string, SymbolConditionalDefinition[]> {
  const deduped = new Map<string, SymbolConditionalDefinition[]>();

  for (const [name, variants] of defineVariants) {
    const seenKeys = new Set<string>();
    const uniqueVariants: SymbolConditionalDefinition[] = [];

    for (const variant of variants) {
      const dedupKey = buildVariantDedupKey(variant);
      if (seenKeys.has(dedupKey)) {
        continue;
      }

      seenKeys.add(dedupKey);
      uniqueVariants.push({ ...variant });
    }

    if (uniqueVariants.length > 0) {
      deduped.set(name, uniqueVariants);
    }
  }

  return deduped;
}

function parseDefineDirective(line: string): ParsedDefineDirective | undefined {
  const directiveMatch = line.match(DEFINE_RX);
  if (!directiveMatch) {
    return undefined;
  }

  const name = directiveMatch[1];
  const rawTail = directiveMatch[2] ?? "";

  // Function-like macro: no space between name and '('
  // Object-like macro: expression may start with '(' but has leading whitespace
  if (rawTail.startsWith("(") && !rawTail.startsWith(" ")) {
    let depth = 0;
    let closeIndex = -1;

    for (let i = 0; i < rawTail.length; i += 1) {
      const char = rawTail[i];
      if (char === "(") {
        depth += 1;
        continue;
      }

      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          closeIndex = i;
          break;
        }
      }
    }

    if (closeIndex < 0) {
      return undefined;
    }

    const rawParams = rawTail.slice(1, closeIndex).trim();
    const params =
      rawParams.length === 0
        ? []
        : rawParams
            .split(",")
            .map((param) => param.trim())
            .filter((param) => param.length > 0);

    const comment = extractCppLineComment(rawTail.slice(closeIndex + 1));
    const expr = stripComments(rawTail.slice(closeIndex + 1)).trim();
    if (!expr) {
      return undefined;
    }

    return {
      name,
      expr,
      params,
      comment,
    };
  }

  const comment = extractCppLineComment(rawTail);
  const expr = stripComments(rawTail).trim();
  if (!expr) {
    return undefined;
  }

  return {
    name,
    expr,
    comment,
  };
}

function findAssignmentOperatorIndex(line: string): number {
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char !== "=") {
      continue;
    }

    const prev = i > 0 ? line[i - 1] : "";
    const next = i + 1 < line.length ? line[i + 1] : "";

    if (
      prev === "=" ||
      prev === "!" ||
      prev === "<" ||
      prev === ">" ||
      prev === "+" ||
      prev === "-" ||
      prev === "*" ||
      prev === "/" ||
      prev === "%" ||
      prev === "&" ||
      prev === "|" ||
      prev === "^" ||
      next === "="
    ) {
      continue;
    }

    return i;
  }

  return -1;
}

function parseValueDeclaration(
  line: string
): ParsedValueDeclaration | undefined {
  const cleaned = stripComments(line).trim();

  if (!cleaned || cleaned.startsWith("#")) {
    return undefined;
  }

  const semicolonIndex = cleaned.lastIndexOf(";");

  if (semicolonIndex < 0) {
    return undefined;
  }

  const comment = extractCppLineComment(line);
  const declaration = cleaned.slice(0, semicolonIndex).trim();

  if (!declaration) {
    return undefined;
  }

  const assignmentIndex = findAssignmentOperatorIndex(declaration);

  if (assignmentIndex <= 0) {
    return undefined;
  }

  const leftSide = declaration.slice(0, assignmentIndex).trim();
  const expr = declaration.slice(assignmentIndex + 1).trim();

  if (!leftSide || !expr || expr.startsWith("{")) {
    return undefined;
  }

  // Reject function calls / arrays / scopes
  if (
    leftSide.includes("(") ||
    leftSide.includes(")") ||
    leftSide.includes("[") ||
    leftSide.includes("]") ||
    leftSide.includes("{") ||
    leftSide.includes("}") ||
    leftSide.includes(".") ||
    leftSide.includes("->")
  ) {
    return undefined;
  }

  const leftTokens = leftSide
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (leftTokens.length < 2) {
    return undefined;
  }

  if (CONTROL_FLOW_KEYWORD_RX.test(leftTokens[0])) {
    return undefined;
  }

  // ------------------------------------------------------------------
  // Validate this is REALLY a declaration and not an assignment.
  //
  // VALID:
  //
  //   int value = 0;
  //   const uint32_t test = 1;
  //   MyType obj = ...
  //
  // INVALID:
  //
  //   value = 0;
  //   result = 10;
  // ------------------------------------------------------------------

  const TYPE_LIKE_TOKENS = new Set([
    "const",
    "constexpr",
    "volatile",
    "static",
    "extern",
    "register",
    "signed",
    "unsigned",
    "short",
    "long",
    "char",
    "int",
    "float",
    "double",
    "bool",
    "void",
    "auto",
    "size_t",
    "uint8_t",
    "uint16_t",
    "uint32_t",
    "uint64_t",
    "int8_t",
    "int16_t",
    "int32_t",
    "int64_t",
  ]);

  // Need at least:
  //   <type> <name>
  //
  // so plain:
  //   value = 1;
  // is rejected immediately.
  if (leftTokens.length < 2) {
    return undefined;
  }

  const variableToken = leftTokens[leftTokens.length - 1]
    .replace(/^[*&]+/, "");

  const typeTokens = leftTokens
    .slice(0, -1)
    .map((token) => token.replace(/[*&]+/g, ""));

  if (!/^[A-Za-z_]\w*$/.test(variableToken)) {
    return undefined;
  }

  const hasValidType = typeTokens.some((token) => {
    if (TYPE_LIKE_TOKENS.has(token)) {
      return true;
    }

    // Accept custom typedefs / structs:
    //
    // MyType value = ...
    // CONFIG_DATA cfg = ...
    //
    return /^[A-Z][A-Za-z0-9_]*$/.test(token);
  });

  if (!hasValidType) {
    return undefined;
  }

  let name = leftTokens[leftTokens.length - 1].replace(/^[*&]+/, "");

  if (!name && leftTokens.length >= 2) {
    const fallbackToken = leftTokens[leftTokens.length - 2];
    name = fallbackToken.replace(/^[*&]+/, "");
  }

  if (!/^[A-Za-z_]\w*$/.test(name)) {
    return undefined;
  }

  // Reject multiple declarations:
  //
  // int a = 1, b = 2;
  //
  if (/,\s*[A-Za-z_]\w*\s*=/.test(expr)) {
    return undefined;
  }

  const isConst =
    leftTokens.includes("const") ||
    leftTokens.includes("constexpr");

  const isStatic = leftTokens.includes("static");

  // ONLY true constants are treated as "symbol definitions"
  // for duplicate-definition / variant tracking.
  const isDefinition = isConst;

  return {
    name,
    expr,
    isConst,
    isStatic,
    isDefinition,
    comment,
  };
}

/**
 * Parses one C/C++ line and extracts either:
 * - "#define NAME EXPR"
 * - "#define NAME(P1,...) EXPR"
 * - scalar declaration with assignment ("TYPE NAME = EXPR;")
 * Returns undefined for non-matching lines.
 */
export function parseCppSymbolDefinition(
  line: string
): CppSymbolDefinition | undefined {
  const parsedDefine = parseDefineDirective(line);
  if (parsedDefine) {
    return {
      name: parsedDefine.name,
      expr: parsedDefine.expr,
      macroParams: parsedDefine.params,
    };
  }

  const parsedValueDeclaration = parseValueDeclaration(line);
  if (parsedValueDeclaration) {
    return {
      name: parsedValueDeclaration.name,
      expr: parsedValueDeclaration.expr,
    };
  }

  return undefined;
}

/**
 * Extracts enum member name/value pairs from comment-stripped C source text.
 * Handles explicit assignments and auto-increment (e.g. SCREEN_OFF = 0, SCREEN_ON).
 *
 * When an explicit initializer can't be folded eagerly (e.g. it references
 * another enum member, like `MODE_ACTIVE = MODE_BASE + 4`), we no longer
 * guess by silently reusing the previous member's auto-increment value.
 * Instead we keep the raw expression text so the caller can hand it to the
 * same recursive define resolver used for macros, which can fold it once
 * the referenced symbol is known. If it truly can't be resolved (e.g. an
 * external/unknown symbol), `value` and `expr` are both left undefined for
 * that member rather than reporting a fabricated number, and any implicit
 * (no-initializer) members that follow inherit that same "unresolved"
 * chain instead of quietly continuing from a wrong base.
 */
function extractEnumMembers(
  strippedText: string
): Array<{ name: string; value?: number; expr?: string; line: number }> {
  const results: Array<{ name: string; value?: number; expr?: string; line: number }> = [];
  const enumOpenRx = /\benum\b[^{;]*\{/g;
  let startMatch: RegExpExecArray | null;

  while ((startMatch = enumOpenRx.exec(strippedText)) !== null) {
    const openPos = strippedText.indexOf('{', startMatch.index);
    if (openPos === -1) continue;

    // Walk to the matching closing brace
    let depth = 1;
    let pos = openPos + 1;
    while (pos < strippedText.length && depth > 0) {
      const ch = strippedText[pos];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      pos++;
    }

    const blockText = strippedText.slice(openPos + 1, pos - 1);
    const baseLineNum = (strippedText.slice(0, openPos + 1).match(/\n/g) ?? []).length;

    // `knownValue` tracks the running auto-increment base once it is
    // actually known (starts at 0, per C semantics for an enum with no
    // explicit initializers). `unresolvedAnchor` names the most recent
    // member whose value we could NOT fold; while it is set, subsequent
    // implicit members are expressed relative to it (e.g. "NAME + 2")
    // instead of being guessed, so resolution can still succeed later if
    // that anchor eventually resolves.
    let knownValue: number | undefined = 0;
    let unresolvedAnchor: string | undefined;
    let stepsSinceAnchor = 0;
    const blockLines = blockText.split('\n');

    for (let li = 0; li < blockLines.length; li++) {
      // A line can have multiple comma-separated members (unusual but valid)
      for (const part of blockLines[li].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // IDENTIFIER  [= expression]
        const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*(.+))?$/);
        if (!m) continue;

        const name = m[1];
        if (/^(sizeof|typeof|__typeof__|__attribute__|typedef|struct|union|enum|const|volatile|static|extern|inline|if|else|while|for|do|return)$/.test(name)) {
          continue;
        }

        let value: number | undefined;
        let expr: string | undefined;

        if (m[2] !== undefined) {
          const rawExpr = m[2].trim();
          try {
            const val = safeEval(rawExpr);
            if (Number.isFinite(val)) {
              value = Math.trunc(val);
            }
          } catch {
            // Cannot fold eagerly (e.g. references another enum member).
          }

          if (value !== undefined) {
            knownValue = value;
            unresolvedAnchor = undefined;
            stepsSinceAnchor = 0;
          } else {
            // Defer resolution instead of fabricating a value: keep the raw
            // expression so the recursive define resolver can retry it once
            // its dependencies are known, and anchor subsequent implicit
            // members to this (currently unresolved) member.
            expr = rawExpr;
            knownValue = undefined;
            unresolvedAnchor = name;
            stepsSinceAnchor = 0;
          }
        } else if (knownValue !== undefined) {
          value = knownValue;
          knownValue += 1;
        } else if (unresolvedAnchor !== undefined) {
          stepsSinceAnchor += 1;
          expr = stepsSinceAnchor === 1
            ? unresolvedAnchor
            : `${unresolvedAnchor} + ${stepsSinceAnchor - 1}`;
        }

        results.push({ name, value, expr, line: baseLineNum + li });
      }
    }
  }

  return results;
}

/**
 * Scans source files and collects:
 * - raw object-like #define expressions
 * - function-like #define macros
 * - scalar declaration expressions (const/variables with one-line assignment)
 * - direct numeric values for declarations that can be evaluated immediately
 * - source locations for navigation
 * 
 * Uses two-pass approach:
 * 1. First pass: collect all defines and consts from all files
 * 2. Second pass: process conditional blocks using resolved conditions
 */
export async function collectDefinesAndConsts(
  files: string[],
  workspaceRoot: string,
  options: CollectOptions = {}
): Promise<CollectedCppSymbols> {

  const { resolveIncludes = false, output, maxMegaCacheEntries, headerIndex, megaBudgetOverrides, megaContentCacheDir } = options;
  const effectiveCacheLimit = clampMegaCacheEntries(maxMegaCacheEntries);

  output?.appendLine(
    `[CPP] entry files=${files.length}, resolveIncludes=${resolveIncludes ? "YES" : "NO"}, cacheLimit=${effectiveCacheLimit}`
  );

  
  const defines = new Map<string, string>();
  const defineConditions = new Map<string, string>();
  const defineComments = new Map<string, string>();
  const functionDefines = new Map<string, FunctionMacroDefinition>();
  const defineVariants = new Map<string, SymbolConditionalDefinition[]>();
  const consts = new Map<string, number>();
  const units = new Map<string, string>();
  const locations = new Map<string, SymbolDefinitionLocation>();
  const globallyDefinedSymbols = new Set<string>();

  const effectiveFiles = resolveIncludes 
    ? files.filter(f => SRC_EXTS.has(path.extname(f).toLowerCase()))
    : files;
  output?.appendLine(`[CPP] effectiveFiles (${effectiveFiles.length}): ${effectiveFiles.map(p => path.basename(p)).join(', ')}`);

  // ========== FIRST PASS: Collect unconditional defines/consts ==========
  for (const filePath of effectiveFiles) {
    const seenDefinesInFile = new Set<string>(); // Track defines per file

    let text: string;

    if (resolveIncludes) {
      text = await buildMegaContent(
        filePath,
        workspaceRoot,
        output,
        effectiveCacheLimit,
        headerIndex,
        megaBudgetOverrides,
        megaContentCacheDir
      );
    } else {
      try {
        text = await fsp.readFile(filePath, "utf8");
      } catch {
        continue;
      }
    }

    text = stripLineContinuations(text);

    const lines = text.split(/\r?\n/);

    let braceDepth = 0;
    let conditionalDepth = 0;
    const stripper = createCommentStripper();

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineWithoutComments = stripper.strip(line);
      const directive = lineWithoutComments.trim();

      // IMPORTANT:
      // Update brace depth BEFORE parsing.
      //
      // This prevents local variables / runtime assignments
      // inside functions from being treated as global definitions.
      braceDepth = updateBraceDepth(braceDepth, lineWithoutComments);

      // ---- track preprocessor conditionals ----
      if (/^\s*#\s*(if|ifdef|ifndef)\b/.test(directive)) {
        conditionalDepth++;
        continue;
      }

      if (/^\s*#\s*endif\b/.test(directive)) {
        conditionalDepth = Math.max(0, conditionalDepth - 1);
        continue;
      }

      if (/^\s*#\s*(else|elif)\b/.test(directive)) {
        continue;
      }

      // ---- ignore anything inside conditional blocks ----
      if (conditionalDepth > 0) {
        continue;
      }

      // ---- handle #undef ----
      const undefFirstPass = directive.match(UNDEF_RX);

      if (undefFirstPass) {
        const undefinedName = undefFirstPass[1];

        defines.delete(undefinedName);
        consts.delete(undefinedName);
        locations.delete(undefinedName);
        globallyDefinedSymbols.delete(undefinedName);
        // Also remove from seenDefinesInFile so a subsequent
        // #define of the same name in the same file is not skipped.
        seenDefinesInFile.delete(undefinedName);

        continue;
      }

      // ---- parse defines ----
      const defineName = parseDefineNameDirective(line);

      if (defineName) {
        globallyDefinedSymbols.add(defineName);
      }

      const parsedDefine = parseDefineDirective(line);

      if (parsedDefine && !seenDefinesInFile.has(parsedDefine.name)) {
        seenDefinesInFile.add(parsedDefine.name);

        const { name, expr, params } = parsedDefine;

        if (params) {
          if (!functionDefines.has(name)) {
            functionDefines.set(name, {
              params,
              body: expr,
            });
          }
        } else {
          // Allow overwrite in case later file redefines
          defines.set(name, expr);
            if (parsedDefine.comment) {
              defineComments.set(name, parsedDefine.comment);
            }

          defineConditions.set(name, "always");

          const location: SymbolDefinitionLocation = {
            file: path.relative(workspaceRoot, filePath),
            line: i + 1
          };

          locations.set(name, location);
        }

        continue;
      }

      // ------------------------------------------------------------------
      // ONLY collect GLOBAL constant definitions.
      //
      // Ignore:
      //   - local variables
      //   - runtime assignments
      //   - anything inside functions/scopes
      // ------------------------------------------------------------------

      if (braceDepth === 0) {
        const parsedValueDeclaration = parseValueDeclaration(line);

        if (
          parsedValueDeclaration &&
          parsedValueDeclaration.isDefinition &&
          !seenDefinesInFile.has(parsedValueDeclaration.name)
        ) {
          seenDefinesInFile.add(parsedValueDeclaration.name);

          const { name, expr, isStatic } = parsedValueDeclaration;

          // Ignore ALL static variables, including static const
          if (!isStatic) {
            defines.set(name, expr);
            if (parsedValueDeclaration.comment) {
              defineComments.set(name, parsedValueDeclaration.comment);
            }

            const unitMatch = line.match(UNIT_COMMENT_RX);
            if (unitMatch) {
              units.set(name, unitMatch[1]);
            }

            try {
              consts.set(name, safeEval(expr));
            } catch {}

            const location: SymbolDefinitionLocation = {
              file: path.relative(workspaceRoot, filePath),
              line: i + 1
            };

            locations.set(name, location);
          }
        }
      }

    }

    // Enum members are extracted once per file. Keeping this outside the
    // line loop avoids re-parsing the whole file for every line at startup.
    const strippedForEnums = stripComments(text);
    for (const member of extractEnumMembers(strippedForEnums)) {
      if (seenDefinesInFile.has(member.name)) {
        continue;
      }

      seenDefinesInFile.add(member.name);

      // Prefer the folded numeric value; otherwise fall back to the raw
      // (possibly symbolic) expression so the recursive define resolver can
      // retry it later once its dependencies are known. If neither is
      // available the member is left out of `defines`/`consts` entirely
      // instead of recording a fabricated value.
      const definitionExpr =
        member.value !== undefined ? String(member.value) : member.expr;

      if (definitionExpr !== undefined) {
        if (!defines.has(member.name)) {
          defines.set(member.name, definitionExpr);
        }

        if (member.value !== undefined && !consts.has(member.name)) {
          consts.set(member.name, member.value);   // consts SOLO se davvero piegato
        }

        defineConditions.set(member.name, "always");
      }

      if (!locations.has(member.name)) {
        locations.set(member.name, {
          file: path.relative(workspaceRoot, filePath),
          line: member.line + 1,
        });
      }
    }
  }

  // ========== SECOND PASS: Conditional-aware processing ==========
  for (const filePath of effectiveFiles) {
    const seenDefinesInFile = new Set<string>();

    let text: string;    
    if (resolveIncludes) {
      text = await buildMegaContent(
        filePath,
        workspaceRoot,
        output,
        effectiveCacheLimit,
        headerIndex,
        megaBudgetOverrides,
        megaContentCacheDir
      );
    } else {
      try {
        text = await fsp.readFile(filePath, "utf8");
      } catch {
        continue;
      }
    }

    text = stripLineContinuations(text);
    const lines = text.split(/\r?\n/);
    const conditionalStack: ConditionalFrame[] = [];
    let currentCondition: string | null = null;
    let braceDepth = 0;
    const seenVariants = new Set<string>();
    const activeDefinedSymbols = new Set<string>(globallyDefinedSymbols);
    const stripper2 = createCommentStripper();

    try {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const lineWithoutComments = stripper2.strip(line);
        const directiveLine = lineWithoutComments.trim();
        let isDirectiveLine = false;

        // Conditional directives...
        const ifdefMatch = directiveLine.match(IFDEF_RX);
        if (ifdefMatch) {
          const branchCondition = resolveCondition(
            `defined(${ifdefMatch[1]})`,
            defines,
            consts,
            activeDefinedSymbols,
            output
          );
          const activeCondition = combineConditions(currentCondition, branchCondition);

          conditionalStack.push({
            parentCondition: currentCondition,
            branchConditions: [branchCondition],
            activeCondition,
          });

          currentCondition = activeCondition;
          isDirectiveLine = true;
        } else {
          const ifndefMatch = directiveLine.match(IFNDEF_RX);

          if (ifndefMatch) {
            const branchCondition = isTopLevelIncludeGuard(
              lines,
              i,
              ifndefMatch[1],
              conditionalStack.length
            )
              ? "1"
              : resolveCondition(
                  `!defined(${ifndefMatch[1]})`,
                  defines,
                  consts,
                  activeDefinedSymbols,
                  output
                );
            const activeCondition = combineConditions(currentCondition, branchCondition);

            conditionalStack.push({
              parentCondition: currentCondition,
              branchConditions: [branchCondition],
              activeCondition,
            });

            currentCondition = activeCondition;
            isDirectiveLine = true;
          } else {
            const ifMatch = directiveLine.match(IF_RX);

            if (ifMatch) {
              const rawCondition = ifMatch[1];
              const branchCondition = resolveCondition(
                rawCondition,
                defines,
                consts,
                activeDefinedSymbols,
                output
              );
              const activeCondition = combineConditions(currentCondition, branchCondition);

              conditionalStack.push({
                parentCondition: currentCondition,
                branchConditions: [branchCondition],
                activeCondition,
              });

              currentCondition = activeCondition;
              isDirectiveLine = true;
            }
          }
        }

        if (!isDirectiveLine) {
          const elifMatch = directiveLine.match(ELIF_RX);
          if (elifMatch) {
            const frame = conditionalStack[conditionalStack.length - 1];

            if (frame) {
              const previousBranchesCondition = buildElseCondition(frame.branchConditions);
              const branchTestCondition = resolveCondition(
                normalizeDirectiveCondition(elifMatch[1]),
                defines,
                consts,
                activeDefinedSymbols,
                output
              );
              const branchCondition = combineConditions(
                previousBranchesCondition,
                branchTestCondition
              );
              const activeCondition = combineConditions(
                frame.parentCondition,
                branchCondition
              );

              frame.branchConditions.push(branchCondition);
              frame.activeCondition = activeCondition;
              currentCondition = activeCondition;
            }

            isDirectiveLine = true;
          } else if (ELSE_RX.test(directiveLine)) {
            const frame = conditionalStack[conditionalStack.length - 1];

            if (frame) {
              const branchCondition = buildElseCondition(frame.branchConditions);
              const activeCondition = combineConditions(
                frame.parentCondition,
                branchCondition
              );

              frame.branchConditions.push(branchCondition);
              frame.activeCondition = activeCondition;
              currentCondition = activeCondition;
            }

            isDirectiveLine = true;
          } else if (ENDIF_RX.test(directiveLine)) {
            const frame = conditionalStack.pop();
            currentCondition = frame?.parentCondition ?? null;
            isDirectiveLine = true;
          } else {
            const undefMatch = directiveLine.match(UNDEF_RX);

            if (undefMatch) {
              let isActiveDirective = true;

              if (currentCondition) {
                try {
                  isActiveDirective = safeEval(currentCondition) !== 0;
                } catch {
                  isActiveDirective = true;
                }
              }

              if (isActiveDirective) {
                const undefName = undefMatch[1];
                activeDefinedSymbols.delete(undefName);
                defines.delete(undefName);
                consts.delete(undefName);
                defineConditions.delete(undefName);
                locations.delete(undefName);
                // Remove from seenDefinesInFile so a subsequent #define
                // in the same file can be processed (e.g. #undef + #define
                // inside an active conditional branch).
                seenDefinesInFile.delete(undefName);
                defineVariants.delete(undefName);
              }


              isDirectiveLine = true;
            }
          }
        }

        // ------------------------------------------------------------------
        // Parse active content
        // ------------------------------------------------------------------

        if (!isDirectiveLine) {
          let isActiveBranch = true;

          if (currentCondition) {
            // output?.appendLine(`[CPP2] Eval condition "${currentCondition}"`);
            try {
              const evalResult = safeEval(currentCondition);
              // output?.appendLine(`[CPP2] condition eval = ${evalResult} (active=${evalResult !== 0})`);
              isActiveBranch = evalResult !== 0;
            } catch (e) {
              // output?.error(`[CPP2] condition eval FAILED: ${e}`);
              isActiveBranch = true;
            }
          }

          const definitionCondition = isActiveBranch
            ? (currentCondition && currentCondition !== "1" ? currentCondition : "always")
            : "0";

          if (!isActiveBranch) {
            continue;
          }

          const activeDefineName = parseDefineNameDirective(line);
          if (activeDefineName) {
            activeDefinedSymbols.add(activeDefineName);
          }

          const parsedDefine = parseDefineDirective(line);

          if (parsedDefine && !seenDefinesInFile.has(parsedDefine.name)) {
            seenDefinesInFile.add(parsedDefine.name);
            const { name, expr, params } = parsedDefine;
            // output?.appendLine(`[CPP2] Parsed define ${name}=${expr} cond=${definitionCondition} active=${isActiveBranch}`);

            if (params) {
              if (!functionDefines.has(name)) {
                functionDefines.set(name, {
                  params,
                  body: expr,
                });
              }
            } else {
              if (!defines.has(name)) {
                defines.set(name, expr);
              }

              const unitMatch = line.match(UNIT_COMMENT_RX);
              if (unitMatch) {
                units.set(name, unitMatch[1]);
              }

              defineConditions.set(name, definitionCondition);

              const location: SymbolDefinitionLocation = {
                file: path.relative(workspaceRoot ?? '.', filePath),
                line: i + 1 // 1-based
              };

              const variantKey = `${name}:${location.file}:${location.line}`;

              if (!seenVariants.has(variantKey)) {
                seenVariants.add(variantKey);

                const variants = defineVariants.get(name) ?? [];
                variants.push({
                  ...location,
                  expr,
                  condition: definitionCondition
                });
                defineVariants.set(name, variants);
              }

              if (!locations.has(name)) {
                locations.set(name, location);
              }
            }
          }

          // ------------------------------------------------------------------
          // ONLY collect GLOBAL constant definitions.
          // Ignore local/runtime variables.
          // ------------------------------------------------------------------

          else if (braceDepth === 0 && currentCondition === null) {
            const parsedValueDeclaration = parseValueDeclaration(line);

            if (
              parsedValueDeclaration &&
              parsedValueDeclaration.isDefinition &&
              !seenDefinesInFile.has(parsedValueDeclaration.name)
            ) {
              seenDefinesInFile.add(parsedValueDeclaration.name);

              const { name, expr, isStatic } = parsedValueDeclaration;

              // Ignore ALL static variables, including static const
              if (!isStatic) {
                if (!defines.has(name)) {
                  defines.set(name, expr);
                  if (parsedValueDeclaration.comment) {
                    defineComments.set(name, parsedValueDeclaration.comment);
                  }
                }

                const unitMatch = line.match(UNIT_COMMENT_RX);

                if (unitMatch) {
                  units.set(name, unitMatch[1]);
                }

                defineConditions.set(name, definitionCondition);

                try {
                  consts.set(name, safeEval(expr));
                } catch {}

                const location: SymbolDefinitionLocation = {
                  file: path.relative(workspaceRoot, filePath),
                  line: i + 1
                };

                const variantKey = `${location.file}:${location.line}`;

                if (!seenVariants.has(variantKey)) {
                  seenVariants.add(variantKey);

                  const variants = defineVariants.get(name) ?? [];

                  variants.push({
                    ...location,
                    expr,
                    condition: definitionCondition
                  });

                  defineVariants.set(name, variants);
                }

                if (!locations.has(name)) {
                  locations.set(name, location);
                }
              }
            }
          }
        }

        braceDepth = updateBraceDepth(braceDepth, lineWithoutComments);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output?.warn(`[CPP2] ⚠️ Skipping ${path.relative(workspaceRoot ?? '.', filePath)}: ${message}`);
    }
  }

  const dedupedDefineVariants = dedupeDefineVariants(defineVariants);

  augmentRegisterFamilyAliases(defines, defineConditions);

  return {
    defines,
    defineConditions,
    defineComments,
    functionDefines,
    defineVariants: dedupedDefineVariants,
    consts,
    units,
    locations
  };
}

function stripTrailingDigits(name: string): string {
  return name.replace(/\d+$/, "");
}

function augmentRegisterFamilyAliases(
  defines: Map<string, string>,
  defineConditions: Map<string, string>
): void {
  const aliasCandidates = new Map<string, Set<string>>();
  const identifierRegex = /[A-Za-z_]\w*/g;

  for (const [name, expr] of Array.from(defines.entries())) {
    const instanceMatch = name.match(/^([A-Za-z_][\w]*\d+)__(.+)$/);
    if (!instanceMatch) {
      continue;
    }

    const instanceName = instanceMatch[1];
    const registerName = instanceMatch[2];
    const familyName = stripTrailingDigits(instanceName);
    if (!familyName || familyName === instanceName) {
      continue;
    }

    const genericPrefix = `${familyName}_${registerName}_`;
    const specificPrefix = `${instanceName}_${registerName}_`;

    for (const token of expr.match(identifierRegex) ?? []) {
      if (!token.startsWith(genericPrefix)) {
        continue;
      }

      const genericName = token;
      if (defines.has(genericName)) {
        continue;
      }

      const specificName = `${specificPrefix}${genericName.slice(genericPrefix.length)}`;
      if (!defines.has(specificName)) {
        continue;
      }

      const candidates = aliasCandidates.get(genericName) ?? new Set<string>();
      candidates.add(specificName);
      aliasCandidates.set(genericName, candidates);
    }
  }

  for (const [genericName, candidates] of aliasCandidates.entries()) {
    if (defines.has(genericName) || candidates.size !== 1) {
      continue;
    }

    const [specificName] = Array.from(candidates);
    defines.set(genericName, specificName);
    defineConditions.set(genericName, "always");
  }
}
