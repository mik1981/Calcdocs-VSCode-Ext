import * as fs from "fs/promises";
import * as fssync from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Helper minimale per creare/distruggere alberi di file temporanei nei
 * test, e per catturare i log emessi da ColoredOutput senza dipendere da
 * vscode.OutputChannel (che non esiste fuori dall'extension host).
 */

export type FakeOutput = {
  lines: string[];
  appendLine: (msg: string) => void;
  detail: (msg: string) => void;
  warn: (msg: string) => void;
  info: (msg: string) => void;
  /** True se almeno una riga registrata contiene la sottostringa data. */
  has: (substring: string) => boolean;
  /** Tutte le righe che contengono la sottostringa data. */
  matching: (substring: string) => string[];
};

export function createFakeOutput(): FakeOutput {
  const lines: string[] = [];
  const push = (msg: string) => lines.push(msg);
  return {
    lines,
    appendLine: push,
    detail: push,
    warn: (msg: string) => push(`WARN: ${msg}`),
    info: push,
    has: (substring: string) => lines.some((l) => l.includes(substring)),
    matching: (substring: string) => lines.filter((l) => l.includes(substring)),
  };
}

/**
 * Crea una directory temporanea univoca sotto os.tmpdir(), da ripulire
 * esplicitamente a fine test con removeTempDir(). Ogni test dovrebbe
 * usare la PROPRIA directory (mai condividerla tra test) per evitare
 * interferenze dovute alla cache in-memory di cppParser.ts, che è a
 * livello di modulo e quindi condivisa tra tutti i test nello stesso
 * processo — vedi anche clearCppParserCache() da chiamare in beforeEach.
 */
export async function createTempDir(prefix: string): Promise<string> {
  // NB: evitiamo deliberatamente la sottostringa "test" nel nome della
  // directory temporanea. cppParser.ts ha un'euristica preesistente
  // (buildMegaContent: if (sourcePath.includes('test')) { forza clear
  // della cache in-memory }) pensata per gli scenari reali di test del
  // progetto — se il nostro path temporaneo la contenesse, ogni singola
  // chiamata verrebbe trattata come "file di test" e la cache in-memory
  // risulterebbe sempre azzerata, falsando i test che verificano
  // esplicitamente il comportamento di cache HIT.
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `calcdocs-fixture-${prefix}-`));
  return base;
}

export async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Scrive un file relativo alla root del fixture, creando le directory intermedie. */
export async function writeFixtureFile(root: string, relPath: string, content: string): Promise<string> {
  const full = path.join(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
  return full;
}

/** Elenca ricorsivamente tutti i file sotto una directory (per costruire headerIndex nei test). */
export function walkFilesSync(dir: string): string[] {
  let out: string[] = [];
  for (const entry of fssync.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walkFilesSync(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Costruisce un headerIndex (basename.toLowerCase() -> path[]) come farebbe scanWorkspace(). */
export function buildHeaderIndex(root: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const filePath of walkFilesSync(root)) {
    if (!filePath.toLowerCase().endsWith(".h")) continue;
    const key = path.basename(filePath).toLowerCase();
    const list = index.get(key) ?? [];
    list.push(filePath);
    index.set(key, list);
  }
  return index;
}

/** Crea N livelli di #include annidati (level_1.h -> level_2.h -> ... -> level_N.h), ciascuno con un #define proprio. Utile per testare i cap di profondità/tempo. */
export async function createDeepIncludeChain(
  root: string,
  levels: number,
  opts: { entryFile?: string } = {}
): Promise<{ entryPath: string }> {
  const entryFile = opts.entryFile ?? "src/deep.c";
  await writeFixtureFile(root, entryFile, `#include "level_1.h"\n`);
  for (let i = 1; i <= levels; i += 1) {
    const next = i + 1;
    const body =
      i < levels
        ? `#include "level_${next}.h"\n#define LEVEL_${i}_DEFINE 1\n`
        : `#define LEVEL_${i}_DEFINE 1\n`;
    await writeFixtureFile(root, `src/level_${i}.h`, body);
  }
  return { entryPath: path.join(root, entryFile) };
}

/**
 * Crea un albero che simula un progetto STM32CubeMX/STM32CubeIDE reale:
 * un file .c che include "main.h" (che a sua volta fa esplodere un
 * intero albero Drivers/CMSIS + Drivers/<Family>_HAL_Driver, come fa
 * davvero stm32h7xx_hal.h) SEGUITO da alcuni header applicativi
 * dell'utente inclusi direttamente (come db.h, par.h nel progetto
 * reale che ha fatto emergere questo problema). La convenzione di
 * naming vendor qui (CMSIS, *_HAL_Driver) è deliberatamente DIVERSA da
 * quella "Publisher.Package.1.0.0" di createVendorPackageFixture: è
 * proprio quella che isVendorPackagePath() non riconosceva prima del
 * fix, causando l'esaurimento del budget dentro l'albero vendor prima
 * di leggere mai il contenuto degli header applicativi.
 */
export async function createStm32VendorFixture(
  root: string,
  opts: { halNestedHeaderCount?: number } = {}
): Promise<{ entryPath: string }> {
  const halNestedHeaderCount = opts.halNestedHeaderCount ?? 20;

  const entryPath = await writeFixtureFile(
    root,
    "Macchina/macchina.c",
    [
      `#include "main.h"`,
      `#include "db.h"`,
      `#include "par.h"`,
      "",
    ].join("\n")
  );

  await writeFixtureFile(
    root,
    "Core/Inc/main.h",
    `#include "stm32h7xx_hal.h"\n#define MAIN_CANARY 1\n`
  );

  // L'header "ombrello" HAL, come stm32h7xx_hal.h nel progetto reale:
  // include CMSIS più una lunga serie di header dei singoli periferici.
  let halUmbrella = `#include "cmsis_core.h"\n`;
  for (let i = 1; i <= halNestedHeaderCount; i += 1) {
    halUmbrella += `#include "stm32h7xx_hal_periph_${i}.h"\n`;
  }
  await writeFixtureFile(
    root,
    "Drivers/STM32H7xx_HAL_Driver/Inc/stm32h7xx_hal.h",
    halUmbrella
  );

  await writeFixtureFile(
    root,
    "Drivers/CMSIS/Include/cmsis_core.h",
    `#define CMSIS_CORE_CANARY 1\n`
  );

  for (let i = 1; i <= halNestedHeaderCount; i += 1) {
    await writeFixtureFile(
      root,
      `Drivers/STM32H7xx_HAL_Driver/Inc/stm32h7xx_hal_periph_${i}.h`,
      `#define HAL_PERIPH_${i}_ENABLED 1\n`
    );
  }

  await writeFixtureFile(root, "Macchina/db.h", `#define DB_MAX_RECORDS 128\n`);
  await writeFixtureFile(root, "Macchina/par.h", `#define PAR_VERSION 7\n`);

  return { entryPath };
}

/** Crea un albero che simula un package manager vendor versionato, es. Publisher.Package.1.0.0/. */
export async function createVendorPackageFixture(
  root: string,
  opts: { peripheralCount?: number } = {}
): Promise<{ entryPath: string; vendorHeaderPath: string }> {
  const peripheralCount = opts.peripheralCount ?? 10;
  const entryPath = await writeFixtureFile(root, "src/app.c", `#include "app.h"\n`);
  await writeFixtureFile(root, "src/app.h", `#include "vendor_hal.h"\n#define APP_CANARY 42\n`);

  const vendorDir = "vendor/Publisher.HAL.1.0.0/hal";
  let umbrella = "";
  for (let i = 1; i <= peripheralCount; i += 1) {
    umbrella += `#include "periph_${i}.h"\n`;
    await writeFixtureFile(
      root,
      `${vendorDir}/periph_${i}.h`,
      `#include "periph_${i}_def.h"\n#define PERIPH_${i}_ENABLED 1\n`
    );
    await writeFixtureFile(root, `${vendorDir}/periph_${i}_def.h`, `#define PERIPH_${i}_DEF_CANARY 1\n`);
  }
  const vendorHeaderPath = await writeFixtureFile(root, `${vendorDir}/vendor_hal.h`, umbrella);

  return { entryPath, vendorHeaderPath };
}
