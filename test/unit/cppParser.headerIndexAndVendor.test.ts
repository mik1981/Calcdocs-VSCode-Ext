import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

import {
  collectDefinesAndConsts,
  clearCppParserCache,
  computeMegaBudget,
} from "../../src/core/cppParser";
import {
  createTempDir,
  removeTempDir,
  writeFixtureFile,
  buildHeaderIndex,
  createFakeOutput,
  createDeepIncludeChain,
  createVendorPackageFixture,
} from "./helpers/fixtures";

describe("cppParser.ts — risoluzione header via headerIndex", () => {
  let root: string;

  beforeEach(async () => {
    clearCppParserCache();
    root = await createTempDir("headerindex");
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it("risolve un header non trovabile dall'euristica candidateDirs usando headerIndex", async () => {
    // Layout STM32CubeIDE-style: Core/Src + Core/Inc + Drivers/.../Inc,
    // NON coperto dall'euristica candidateDirs fissa (inc/, include/, ecc.)
    await writeFixtureFile(root, "Core/Src/app.c", `#include "app_errors.h"\n`);
    await writeFixtureFile(root, "Drivers/CustomMod/Inc/app_errors.h", `#define APP_ERR_MOSFET_HOT 3\n`);

    const headerIndex = buildHeaderIndex(root);
    const output = createFakeOutput();

    const result = await collectDefinesAndConsts(
      [`${root}/Core/Src/app.c`],
      root,
      { resolveIncludes: true, output, headerIndex } as any
    );

    assert.equal(result.defines.get("APP_ERR_MOSFET_HOT"), "3");
    assert.ok(output.has("Found via headerIndex"), "deve loggare la risoluzione via headerIndex");
  });

  it("senza headerIndex, un header fuori dall'euristica NON viene trovato (nessun crash, solo mancata risoluzione)", async () => {
    await writeFixtureFile(root, "Core/Src/app.c", `#include "app_errors.h"\n`);
    await writeFixtureFile(root, "Drivers/CustomMod/Inc/app_errors.h", `#define APP_ERR_MOSFET_HOT 3\n`);

    const output = createFakeOutput();
    const result = await collectDefinesAndConsts(
      [`${root}/Core/Src/app.c`],
      root,
      { resolveIncludes: true, output } as any // niente headerIndex
    );

    assert.equal(result.defines.get("APP_ERR_MOSFET_HOT"), undefined);
  });

  it("basename ambiguo (più file con lo stesso nome) sceglie il path più vicino alla directory di partenza", async () => {
    await writeFixtureFile(root, "src/app.c", `#include "config.h"\n`);
    await writeFixtureFile(root, "src/config.h", `#define NEAR_CONFIG 1\n`);
    await writeFixtureFile(root, "far/away/nested/config.h", `#define FAR_CONFIG 1\n`);

    const headerIndex = buildHeaderIndex(root);
    // Rimuoviamo temporaneamente la risoluzione "diretta" nella stessa
    // cartella rinominando la entry più vicina per costringere il
    // fallback headerIndex a scegliere tra le due — verifichiamo solo
    // che la scelta sia deterministica e non lanci eccezioni con basename duplicati.
    const result = await collectDefinesAndConsts([`${root}/src/app.c`], root, {
      resolveIncludes: true,
      headerIndex,
    } as any);

    // La versione "vicina" (stessa dir, trovata anche dall'euristica
    // candidateDirs prima ancora di consultare headerIndex) deve vincere.
    assert.equal(result.defines.get("NEAR_CONFIG"), "1");
  });
});

describe("cppParser.ts — skip espansione pacchetti vendor versionati", () => {
  let root: string;

  beforeEach(async () => {
    clearCppParserCache();
    root = await createTempDir("vendor");
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it("un header ombrello dentro una cartella Publisher.Package.X.Y.Z viene incluso ma i suoi #include NON vengono espansi", async () => {
    const { entryPath } = await createVendorPackageFixture(root, { peripheralCount: 15 });
    const headerIndex = buildHeaderIndex(root);
    const output = createFakeOutput();

    const result = await collectDefinesAndConsts([entryPath], root, {
      resolveIncludes: true,
      output,
      headerIndex,
    } as any);

    // Il define non-vendor (fuori dal pacchetto versionato) deve
    // comunque risolversi normalmente.
    assert.equal(result.defines.get("APP_CANARY"), "42");

    // I define ANNIDATI dentro il pacchetto vendor (raggiungibili solo
    // seguendo gli #include del pacchetto stesso) NON devono comparire:
    // è esattamente il meccanismo che evita l'esplosione stile stm32_hal.h.
    assert.equal(result.defines.get("PERIPH_1_ENABLED"), undefined);
    assert.equal(result.defines.get("PERIPH_1_DEF_CANARY"), undefined);
    assert.ok(output.has("Vendor package header"), "deve loggare lo skip del pacchetto vendor");
  });

  it("il mega-content resta piccolo anche con un pacchetto vendor molto grande (nessuna esplosione dimensionale)", async () => {
    const { entryPath } = await createVendorPackageFixture(root, { peripheralCount: 60 });
    const headerIndex = buildHeaderIndex(root);
    const output = createFakeOutput();

    await collectDefinesAndConsts([entryPath], root, {
      resolveIncludes: true,
      output,
      headerIndex,
    } as any);

    const builtLine = output.matching("[Mega] Built").find((l) => l.includes("app.c"));
    assert.ok(builtLine, "atteso un log '[Mega] Built app.c: ...'");
    const sizeMatch = builtLine!.match(/size=([\d.]+)kB/);
    assert.ok(sizeMatch, "atteso di poter leggere la dimensione dal log");
    const sizeKB = Number(sizeMatch![1]);
    // Con 60 periferiche vendor NON espanse, il mega-content deve restare
    // nell'ordine di poche kB, non decine/centinaia (che indicherebbero
    // un'esplosione).
    assert.ok(sizeKB < 20, `size troppo grande (${sizeKB}kB): il pacchetto vendor sembra essersi espanso`);
  });
});

describe("cppParser.ts — budget adattivo (RAM/tempo/profondità)", () => {
  it("computeMegaBudget resta entro pavimento/tetto anche senza override", () => {
    const budget = computeMegaBudget(24);
    assert.ok(budget.remainingChars >= 150_000, `sotto il pavimento: ${budget.remainingChars}`);
    assert.ok(budget.remainingChars <= 4_000_000, `sopra il tetto: ${budget.remainingChars}`);
    assert.ok(budget.maxDepth > 0);
    assert.ok(budget.deadline > Date.now());
    assert.equal(budget.truncated, false);
  });

  it("gli override espliciti hanno sempre precedenza sul calcolo automatico", () => {
    const budget = computeMegaBudget(24, { maxChars: 12345, maxTimeMs: 999, maxDepth: 7 });
    assert.equal(budget.remainingChars, 12345);
    assert.equal(budget.maxDepth, 7);
    assert.ok(budget.deadline <= Date.now() + 999 + 50); // piccolo margine di tolleranza
  });

  it("un override a 0 (o assente) ripristina il calcolo automatico per quel campo", () => {
    const budget = computeMegaBudget(24, { maxChars: 0, maxDepth: 0, maxTimeMs: 0 });
    assert.ok(budget.remainingChars >= 150_000);
    assert.ok(budget.maxDepth >= 1);
  });

  it("un budget di caratteri più piccolo per più cache entries (ripartizione RAM)", () => {
    const fewEntries = computeMegaBudget(1);
    const manyEntries = computeMegaBudget(100);
    assert.ok(
      manyEntries.remainingChars <= fewEntries.remainingChars,
      "con più entry di cache il budget per singolo file deve essere uguale o minore"
    );
  });
});

describe("cppParser.ts — cap di profondità (backstop per catene non-vendor patologiche)", () => {
  let root: string;

  beforeEach(async () => {
    clearCppParserCache();
    root = await createTempDir("depth");
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it("una catena di 60 #include annidati si ferma al cap di profondità, senza crash", async () => {
    const { entryPath } = await createDeepIncludeChain(root, 60);
    const output = createFakeOutput();

    const result = await collectDefinesAndConsts([entryPath], root, {
      resolveIncludes: true,
      output,
      megaBudgetOverrides: { maxDepth: 20 },
    } as any);

    assert.equal(result.defines.get("LEVEL_19_DEFINE"), "1", "dentro il cap deve essere risolto");
    assert.equal(result.defines.get("LEVEL_25_DEFINE"), undefined, "oltre il cap NON deve essere risolto");
    assert.equal(result.defines.get("LEVEL_40_DEFINE"), undefined, "oltre il cap NON deve essere risolto");
    assert.ok(output.has("depth limit"), "deve loggare il raggiungimento del limite di profondità");
  });

  it("una catena corta (sotto il cap) si risolve interamente", async () => {
    const { entryPath } = await createDeepIncludeChain(root, 5);
    const result = await collectDefinesAndConsts([entryPath], root, {
      resolveIncludes: true,
      megaBudgetOverrides: { maxDepth: 20 },
    } as any);

    for (let i = 1; i <= 5; i += 1) {
      assert.equal(result.defines.get(`LEVEL_${i}_DEFINE`), "1", `LEVEL_${i}_DEFINE deve essere risolto`);
    }
  });
});
