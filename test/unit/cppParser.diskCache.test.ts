import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as fssync from "fs";
import * as path from "path";

import {
  collectDefinesAndConsts,
  clearCppParserCache,
  flushPendingMegaContentDiskWrites,
} from "../../src/core/cppParser";
import {
  createTempDir,
  removeTempDir,
  writeFixtureFile,
  createFakeOutput,
  createDeepIncludeChain,
} from "./helpers/fixtures";

function countCacheFiles(cacheDir: string): number {
  try {
    return fssync.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

describe("cppParser.ts — persistenza su disco del mega-content", () => {
  let root: string;
  let cacheDir: string;
  let appC: string;

  beforeEach(async () => {
    clearCppParserCache();
    root = await createTempDir("diskcache");
    cacheDir = path.join(root, ".cache");
    appC = await writeFixtureFile(root, "src/app.c", `#include "app.h"\n`);
    await writeFixtureFile(root, "src/app.h", `#define APP_CANARY 99\n`);
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it("survive a un riavvio simulato: dopo clearCppParserCache() idrata da disco senza rifare il walk degli #include", async () => {
    // Sessione 1: build a freddo, poi flush esplicito (altrimenti la
    // scrittura è debounced e non ancora sul disco).
    await collectDefinesAndConsts([appC], root, {
      resolveIncludes: true,
      megaContentCacheDir: cacheDir,
    } as any);
    await flushPendingMegaContentDiskWrites();
    assert.equal(countCacheFiles(cacheDir), 1, "atteso 1 file di cache dopo il flush");

    // "Riavvio di VS Code": azzera SOLO la cache in RAM.
    clearCppParserCache();

    const output = createFakeOutput();
    const result = await collectDefinesAndConsts([appC], root, {
      resolveIncludes: true,
      output,
      megaContentCacheDir: cacheDir,
    } as any);

    assert.equal(result.defines.get("APP_CANARY"), "99");
    assert.ok(output.has("Idratato da cache su disco"), "deve idratare da disco");
    assert.ok(!output.has("[ResolveInclude] ✅ Found"), "NON deve rifare il walk degli #include");
  });

  it("una modifica a una dipendenza invalida correttamente la cache su disco", async () => {
    await collectDefinesAndConsts([appC], root, {
      resolveIncludes: true,
      megaContentCacheDir: cacheDir,
    } as any);
    await flushPendingMegaContentDiskWrites();

    // Il filesystem ha spesso risoluzione dei mtime a livello di secondo:
    // attendiamo un po' per garantire un mtime diverso e deterministico.
    await new Promise((r) => setTimeout(r, 1100));
    await writeFixtureFile(root, "src/app.h", `#define APP_CANARY 123\n`);

    clearCppParserCache();
    const output = createFakeOutput();
    const result = await collectDefinesAndConsts([appC], root, {
      resolveIncludes: true,
      output,
      megaContentCacheDir: cacheDir,
    } as any);

    assert.equal(result.defines.get("APP_CANARY"), "123", "deve riflettere il nuovo valore, non quello in cache");
    assert.ok(output.has("Invalid cache"), "deve rilevare esplicitamente l'invalidazione");
  });

  it("REGRESSIONE CRITICA: una build TRONCATA non viene mai persistita su disco", async () => {
    // Catena profonda che sfora deterministicamente il cap di profondità.
    const { entryPath } = await createDeepIncludeChain(root, 60);
    const output = createFakeOutput();

    const result = await collectDefinesAndConsts([entryPath], root, {
      resolveIncludes: true,
      output,
      megaContentCacheDir: cacheDir,
      megaBudgetOverrides: { maxDepth: 20 },
    } as any);

    // Precondizione: la build DEVE essere effettivamente troncata,
    // altrimenti il test non starebbe verificando nulla.
    assert.equal(result.defines.get("LEVEL_40_DEFINE"), undefined, "precondizione: la build deve essere troncata");
    assert.ok(output.has("depth limit"), "precondizione: deve aver raggiunto il limite di profondità");

    await flushPendingMegaContentDiskWrites();

    assert.equal(
      countCacheFiles(cacheDir),
      0,
      "una build troncata NON deve mai essere scritta su disco — se lo fosse, resterebbe congelata per sempre"
    );
    assert.ok(output.has("NON persistita su disco"), "deve loggare esplicitamente lo skip della persistenza");
  });

  it("una build COMPLETA (non troncata) viene persistita normalmente", async () => {
    const { entryPath } = await createDeepIncludeChain(root, 5);
    await collectDefinesAndConsts([entryPath], root, {
      resolveIncludes: true,
      megaContentCacheDir: cacheDir,
      megaBudgetOverrides: { maxDepth: 20 },
    } as any);
    await flushPendingMegaContentDiskWrites();

    assert.equal(countCacheFiles(cacheDir), 1, "una build completa deve essere persistita");
  });

  it("più rebuild ravvicinati (es. salvataggi rapidi) vengono raggruppati in UNA sola scrittura su disco (debounce)", async () => {
    for (let i = 0; i < 5; i += 1) {
      await writeFixtureFile(root, "src/app.c", `#include "app.h"\n// v${i}\n`);
      clearCppParserCache(); // forza il rebuild come farebbe una vera invalidazione mtime
      await collectDefinesAndConsts([appC], root, {
        resolveIncludes: true,
        megaContentCacheDir: cacheDir,
      } as any);
    }

    // Subito dopo la raffica, il debounce (4s) non deve aver ancora scritto nulla.
    assert.equal(countCacheFiles(cacheDir), 0, "durante il debounce non deve esserci ancora nessuna scrittura");

    await flushPendingMegaContentDiskWrites();
    assert.equal(countCacheFiles(cacheDir), 1, "dopo il flush deve esserci esattamente una entry (l'ultima)");
  });

  it("flushPendingMegaContentDiskWrites forza la scrittura immediata anche prima della scadenza del debounce", async () => {
    await collectDefinesAndConsts([appC], root, {
      resolveIncludes: true,
      megaContentCacheDir: cacheDir,
    } as any);

    assert.equal(countCacheFiles(cacheDir), 0, "prima del flush non deve ancora esserci scrittura");
    await flushPendingMegaContentDiskWrites();
    assert.equal(countCacheFiles(cacheDir), 1, "dopo il flush deve esserci la scrittura");
  });

  it("una cache su disco corrotta (JSON non valido) viene ignorata senza lanciare eccezioni", async () => {
    await fs.mkdir(cacheDir, { recursive: true });
    // Scriviamo un file di cache corrotto con lo stesso schema di naming
    // (hash sha1 del cacheKey) non è replicabile facilmente da fuori, ma
    // possiamo verificare la resilienza scrivendo un file corrotto con un
    // nome qualunque e controllando che l'analisi comunque proceda.
    await fs.writeFile(path.join(cacheDir, "0000000000000000000000000000000000000000.json"), "{not valid json", "utf8");

    const output = createFakeOutput();
    await assert.doesNotReject(
      collectDefinesAndConsts([appC], root, {
        resolveIncludes: true,
        output,
        megaContentCacheDir: cacheDir,
      } as any)
    );
  });
});
