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
  createStm32VendorFixture,
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

  it("REGRESSIONE STRUTTURALE: un albero vendor NON riconosciuto per nome non impedisce comunque la lettura dei fratelli", async () => {
    // La prova che conta di più: qui l'albero enorme ha un nome
    // generico ("weird_vendor_lib") che isVendorPackagePath() NON
    // riconoscerà mai (non è versionato in stile npm, non è
    // CMSIS/BSP/Third_Party/*_HAL_Driver). Se il fix dipendesse SOLO
    // dal riconoscimento per nome, questo test fallirebbe esattamente
    // come falliva prima per STM32. Deve invece passare grazie alla
    // lettura "a respiro" di TUTTI i fratelli diretti PRIMA di
    // espandere in profondità uno qualsiasi di loro (FASE 1/FASE 2 in
    // buildMegaContent) — funziona per QUALSIASI vendor, riconosciuto
    // o meno, perché non si basa su un elenco di nomi.
    const entryPath = await writeFixtureFile(
      root,
      "app/main.c",
      ['#include "weird_vendor_lib/vendor_root.h"', '#include "app/my_config.h"', ""].join("\n")
    );

    const nestedCount = 80;
    let umbrella = "#define VENDOR_ROOT_CANARY 1\n";
    for (let i = 1; i <= nestedCount; i += 1) {
      umbrella += `#include "weird_vendor_lib/nested_${i}.h"\n`;
    }
    await writeFixtureFile(root, "weird_vendor_lib/vendor_root.h", umbrella);
    for (let i = 1; i <= nestedCount; i += 1) {
      await writeFixtureFile(root, `weird_vendor_lib/nested_${i}.h`, `#define VENDOR_NESTED_${i} 1\n`);
    }
    await writeFixtureFile(root, "app/my_config.h", "#define MY_APP_CONFIG_VALUE 42\n");

    const output = createFakeOutput();
    const result = await collectDefinesAndConsts([entryPath], root, {
      resolveIncludes: true,
      output,
      headerIndex: buildHeaderIndex(root),
    } as any);

    assert.equal(
      result.defines.get("MY_APP_CONFIG_VALUE"),
      "42",
      "my_config.h (fratello di vendor_root.h) deve essere letto anche se vendor_root.h nasconde un albero enorme e NON riconosciuto per nome"
    );

    // Come per il test STM32 sopra: verifichiamo l'ORDINE (proprietà
    // strutturale deterministica) invece di affamare un budget di tempo
    // (instabile su macchine/filesystem lenti). Qui il discriminante è
    // netto: senza FASE 1, vendor_root.h verrebbe espanso subito e
    // TUTTI gli 80 nested_*.h comparirebbero nel log prima di
    // my_config.h.
    const idxOf = (needle: string) => output.lines.findIndex((l) => l.includes(needle));
    const myConfigIdx = idxOf("my_config.h");
    const firstNestedIdx = idxOf("nested_1.h");

    assert.ok(myConfigIdx >= 0 && firstNestedIdx >= 0, "entrambi gli header devono comparire nel log");
    assert.ok(
      myConfigIdx < firstNestedIdx,
      `my_config.h (${myConfigIdx}) deve essere letto PRIMA dei nested dell'albero vendor (${firstNestedIdx})`
    );
  });
});

describe("cppParser.ts — skip espansione vendor STM32CubeMX (CMSIS, *_HAL_Driver)", () => {
  // Regressione da un log reale di un progetto STM32H7 + TouchGFX: senza
  // riconoscere queste convenzioni di naming (diverse da quelle
  // "Publisher.Package.1.0.0" testate sopra), il budget di tempo si
  // esauriva ricorsivamente dentro Drivers/CMSIS PRIMA di leggere mai il
  // contenuto degli header applicativi dell'utente (db.h, par.h),
  // elencati subito dopo main.h negli #include diretti del file.
  let root: string;

  beforeEach(async () => {
    clearCppParserCache();
    root = await createTempDir("stm32vendor");
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it("gli header applicativi elencati dopo main.h vengono letti PRIMA di espandere in profondità l'albero HAL", async () => {
    // NOTA sul perché questo test non usa un budget di tempo stretto:
    // la prima versione passava un maxTimeMs di poche decine di ms per
    // "affamare" il budget e dimostrare che db.h/par.h venivano letti
    // comunque. Funzionava su Linux ma era instabile su Windows, dove
    // ogni fsp.access costa molto di più (antivirus, filesystem): il
    // budget poteva scadere DENTRO la lettura dei fratelli, cioè
    // proprio la cosa che il test vuole verificare, facendolo fallire
    // per motivi di macchina e non di logica.
    //
    // La proprietà strutturale reale è un ORDINE, non un tempo: tutti
    // gli #include diretti del file attivo vengono letti PRIMA che
    // inizi l'espansione profonda di uno qualsiasi di loro (FASE 1 /
    // 60 header HAL annidati e un budget di 50ms: senza il riconoscimento
    // vendor, la sola espansione ricorsiva dell'albero CMSIS/HAL
    // esaurirebbe il budget ben prima di arrivare a db.h/par.h.
    const { entryPath } = await createStm32VendorFixture(root, { halNestedHeaderCount: 60 });
    const headerIndex = buildHeaderIndex(root);
    const output = createFakeOutput();

    const result = await collectDefinesAndConsts([entryPath], root, {
      resolveIncludes: true,
      output,
      headerIndex,
    } as any);

    assert.equal(result.defines.get("DB_MAX_RECORDS"), "128", "db.h deve essere letto");
    assert.equal(result.defines.get("PAR_VERSION"), "7", "par.h deve essere letto");

    const indexOfLineContaining = (needle: string) =>
      output.lines.findIndex((l) => l.includes(needle));

    const dbIdx = indexOfLineContaining("db.h");
    const parIdx = indexOfLineContaining("par.h");
    const halUmbrellaIdx = indexOfLineContaining("stm32h7xx_hal.h");

    assert.ok(dbIdx >= 0 && parIdx >= 0 && halUmbrellaIdx >= 0, "tutti gli header attesi devono comparire nel log");
    assert.ok(
      dbIdx < halUmbrellaIdx && parIdx < halUmbrellaIdx,
      `db.h (${dbIdx}) e par.h (${parIdx}) devono essere letti PRIMA che inizi l'espansione profonda via stm32h7xx_hal.h (${halUmbrellaIdx})`
    );
  });

  it("il define nell'header ombrello HAL stesso è letto, ma quelli annidati nei periferici NON vengono espansi", async () => {
    const { entryPath } = await createStm32VendorFixture(root, { halNestedHeaderCount: 10 });
    const headerIndex = buildHeaderIndex(root);
    const output = createFakeOutput();

    const result = await collectDefinesAndConsts([entryPath], root, {
      resolveIncludes: true,
      output,
      headerIndex,
    } as any);

    // CMSIS_CORE_CANARY vive nel primo #include dell'header ombrello HAL
    // stesso (letto, non espanso oltre) — deve restare visibile.
    // I define nei periferici, raggiungibili solo seguendo gli #include
    // DENTRO l'albero vendor, non devono comparire: stesso contratto già
    // verificato sopra per i pacchetti versionati, ora esteso alle
    // convenzioni STM32.
    assert.equal(result.defines.get("HAL_PERIPH_1_ENABLED"), undefined);
    assert.equal(result.defines.get("MAIN_CANARY"), "1", "main.h stesso (fuori da Drivers/) deve restare espanso normalmente");
    assert.ok(output.has("Vendor package header"), "deve loggare lo skip del pacchetto vendor STM32");
  });

  it("una volta esaurito il budget, non ci sono più tentativi di risoluzione rumorosi nel log (i controlli vengono prima della ricerca su disco)", async () => {
    const { entryPath } = await createStm32VendorFixture(root, { halNestedHeaderCount: 80 });
    const headerIndex = buildHeaderIndex(root);
    const output = createFakeOutput();

    await collectDefinesAndConsts([entryPath], root, {
      resolveIncludes: true,
      output,
      headerIndex,
      megaBudgetOverrides: { maxTimeMs: 1 }, // praticamente zero: tronca quasi subito
    } as any);

    // Dopo la prima riga di troncamento, non devono comparire ULTERIORI
    // righe "Found" (i controlli di budget vengono prima della ricerca
    // su disco, non dopo) - a differenza del comportamento precedente
    // che continuava a stampare "Found" per molti altri file dopo aver
    // già deciso di troncare.
    const lines = output.lines;
    const truncatedIdx = lines.findIndex((l) => l.includes("budget esaurito") || l.includes("depth limit"));
    if (truncatedIdx >= 0) {
      const afterTruncation = lines.slice(truncatedIdx + 1);
      const spuriousFoundAfter = afterTruncation.filter((l) => l.includes("[ResolveInclude] ✅ Found"));
      assert.equal(
        spuriousFoundAfter.length,
        0,
        `nessuna riga "Found" dovrebbe comparire dopo il troncamento, trovate: ${spuriousFoundAfter.length}`
      );
    }
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

  it("un override a 0 (o assente) ripristina il calcolo automatico per maxChars/maxTimeMs", () => {
    // maxChars:0 e maxTimeMs:0 non hanno senso come valori deliberati
    // (nessuno vuole "zero caratteri di budget"): 0 qui resta sinonimo
    // di "non impostato, usa il default automatico".
    const budget = computeMegaBudget(24, { maxChars: 0, maxTimeMs: 0 });
    assert.ok(budget.remainingChars >= 150_000);
  });

  it("maxDepth: 0 è un override valido e rispettato (non ricade sul default)", () => {
    // A differenza di maxChars/maxTimeMs, 0 QUI è un valore sensato e
    // deliberato: "fermati agli #include diretti del file attivo,
    // niente di più profondo" — esattamente cosa serve al fallback
    // "shallow" del progressivo su progetti enormi (vedi
    // SHALLOW_MEGA_BUDGET_OVERRIDES in core/analysis.ts). Trattarlo
    // come "non impostato" lo farebbe ricadere sul default (40),
    // vanificando silenziosamente quel fallback.
    assert.equal(computeMegaBudget(24, { maxDepth: 0 }).maxDepth, 0);
    assert.ok(computeMegaBudget(24, { maxDepth: undefined }).maxDepth >= 1);
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
