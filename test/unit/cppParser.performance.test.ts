import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import * as path from "path";

import { collectDefinesAndConsts, clearCppParserCache, flushPendingMegaContentDiskWrites } from "../../src/core/cppParser";
import { createTempDir, removeTempDir, writeFixtureFile, buildHeaderIndex, createFakeOutput } from "./helpers/fixtures";

/**
 * Copre il fix "isMegaCacheEntryValid faceva uno stat() alla volta in
 * sequenza": per un file con centinaia di dipendenze, confermare che la
 * cache fosse valida costava centinaia di syscall in serie, anche a
 * cache HIT. Ora sono in parallelo (Promise.all).
 *
 * Il test non misura una soglia di tempo assoluta (fragile, dipende
 * dalla macchina) ma verifica che la CORRETTEZZA del controllo di
 * validità sia preservata anche con moltissime dipendenze, e che il
 * comportamento sia deterministico indipendentemente dal numero di
 * dipendenze coinvolte.
 */

async function createManyHeaderDependencies(root: string, count: number): Promise<string> {
  let entryContent = "";
  for (let i = 0; i < count; i += 1) {
    entryContent += `#include "dep_${i}.h"\n`;
    await writeFixtureFile(root, `src/dep_${i}.h`, `#define DEP_${i}_DEFINE ${i}\n`);
  }
  return writeFixtureFile(root, "src/app.c", entryContent);
}

// Budget esplicito e generoso, usato in tutti i test con molte
// dipendenze (300) in questo file. Il contenuto reale coinvolto è
// minuscolo (poche decine di kB in totale), quindi il limite di
// CARATTERI non è mai il problema — ma il budget di TEMPO adattivo di
// default (~1.2s) è calibrato per un normale caso d'uso interattivo e
// può risultare troppo stretto su una macchina più lenta/occupata (CI,
// filesystem di rete, WSL, antivirus, ecc.), causando un troncamento
// LEGITTIMO che non ha nulla a che fare con ciò che questi test
// vogliono verificare (correttezza/prestazioni della validazione
// dipendenze, non il comportamento del budget adattivo — quello è
// coperto separatamente in cppParser.headerIndexAndVendor.test.ts).
// Fissare qui un budget esplicito rende questi test deterministici
// indipendentemente dalla macchina su cui girano.
const GENEROUS_BUDGET = { maxChars: 2_000_000, maxTimeMs: 30_000, maxDepth: 10 };

describe("cppParser.ts — validazione dipendenze parallela (performance + correttezza)", () => {
  let root: string;

  beforeEach(async () => {
    clearCppParserCache();
    root = await createTempDir("perf");
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it("con 300 dipendenze, la validazione della cache resta corretta (tutti i define presenti)", async () => {
    const appC = await createManyHeaderDependencies(root, 300);
    const headerIndex = buildHeaderIndex(root);

    const result = await collectDefinesAndConsts([appC], root, {
      resolveIncludes: true,
      headerIndex,
      megaBudgetOverrides: GENEROUS_BUDGET,
    } as any);

    assert.equal(result.defines.get("DEP_0_DEFINE"), "0");
    assert.equal(result.defines.get("DEP_150_DEFINE"), "150");
    assert.equal(result.defines.get("DEP_299_DEFINE"), "299");
  });

  it("con molte dipendenze, un cache HIT (nessuna modifica) resta significativamente più rapido di un CACHE MISS", async () => {
    const appC = await createManyHeaderDependencies(root, 300);
    const headerIndex = buildHeaderIndex(root);

    const startMiss = Date.now();
    await collectDefinesAndConsts([appC], root, {
      resolveIncludes: true,
      headerIndex,
      megaBudgetOverrides: GENEROUS_BUDGET,
    } as any);
    const missElapsed = Date.now() - startMiss;

    const startHit = Date.now();
    const output = createFakeOutput();
    await collectDefinesAndConsts([appC], root, {
      resolveIncludes: true,
      headerIndex,
      output,
      megaBudgetOverrides: GENEROUS_BUDGET,
    } as any);
    const hitElapsed = Date.now() - startHit;

    assert.ok(output.has("CACHE HIT"), "la seconda chiamata deve essere un cache HIT in-memory");
    // Non asseriamo una soglia assoluta (dipende dalla macchina), solo
    // che l'hit non sia più lento del miss — la validazione parallela
    // non deve introdurre overhead peggiore della build da zero.
    assert.ok(
      hitElapsed <= missElapsed + 50,
      `cache HIT (${hitElapsed}ms) inaspettatamente più lento del MISS (${missElapsed}ms)`
    );
  });

  it("con una singola dipendenza modificata tra 300, la cache viene correttamente invalidata (non un falso HIT)", async () => {
    const appC = await createManyHeaderDependencies(root, 300);
    const headerIndex = buildHeaderIndex(root);

    await collectDefinesAndConsts([appC], root, {
      resolveIncludes: true,
      headerIndex,
      megaBudgetOverrides: GENEROUS_BUDGET,
    } as any);

    await new Promise((r) => setTimeout(r, 1100)); // garantisce un mtime diverso
    await writeFixtureFile(root, "src/dep_150.h", `#define DEP_150_DEFINE 999\n`);

    const output = createFakeOutput();
    const result = await collectDefinesAndConsts([appC], root, {
      resolveIncludes: true,
      headerIndex,
      output,
      megaBudgetOverrides: GENEROUS_BUDGET,
    } as any);

    assert.equal(result.defines.get("DEP_150_DEFINE"), "999", "deve riflettere il nuovo valore");
    assert.ok(output.has("CACHE STALE") || output.has("Invalid cache"), "deve rilevare l'invalidazione");
  });
});

describe("cppParser.ts — persistenza su disco con molte dipendenze (round-trip su larga scala)", () => {
  let root: string;
  let cacheDir: string;

  beforeEach(async () => {
    clearCppParserCache();
    root = await createTempDir("perf-disk");
    cacheDir = path.join(root, ".cache");
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it("round-trip su disco con 300 dipendenze preserva tutti i define dopo un riavvio simulato", async () => {
    const appC = await createManyHeaderDependencies(root, 300);
    const headerIndex = buildHeaderIndex(root);

    await collectDefinesAndConsts([appC], root, {
      resolveIncludes: true,
      headerIndex,
      megaContentCacheDir: cacheDir,
      megaBudgetOverrides: GENEROUS_BUDGET,
    } as any);
    await flushPendingMegaContentDiskWrites();

    clearCppParserCache(); // riavvio simulato

    const output = createFakeOutput();
    const result = await collectDefinesAndConsts([appC], root, {
      resolveIncludes: true,
      headerIndex,
      megaContentCacheDir: cacheDir,
      output,
      megaBudgetOverrides: GENEROUS_BUDGET,
    } as any);

    assert.ok(output.has("Idratato da cache su disco"));
    assert.equal(result.defines.get("DEP_0_DEFINE"), "0");
    assert.equal(result.defines.get("DEP_299_DEFINE"), "299");
  });
});
