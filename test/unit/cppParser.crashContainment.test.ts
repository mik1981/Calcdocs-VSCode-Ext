import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

import { collectDefinesAndConsts, clearCppParserCache } from "../../src/core/cppParser";
import { createTempDir, removeTempDir, writeFixtureFile, createFakeOutput } from "./helpers/fixtures";

/**
 * Copre il crash "RangeError: Invalid string length" scoperto durante
 * l'analisi di alberi CMSIS/RA-FSP molto annidati: combineConditions()
 * concatenava senza limiti la condizione del genitore ad ogni livello di
 * #ifdef annidato ("(parent) && (branch)"), e su alberi patologicamente
 * profondi la stringa poteva crescere fino a superare il limite di V8.
 * Un'eccezione non gestita lì risaliva fino al catch generale attorno a
 * runYamlAnalysis, interrompendo l'analisi per l'INTERO workspace (non
 * solo per il file incriminato) — da cui la sparizione di tutti i ghost
 * value delle formule.
 */

/** Genera N livelli di #ifdef annidati, tutti condizionati da macro MAI
 * definite (quindi sempre "false"), che è esattamente lo scenario che
 * fa crescere combineConditions senza il cap: né il genitore né il ramo
 * sono mai "1", quindi ogni livello concatena una nuova clausola. */
function buildPathologicalIfdefTree(levels: number): string {
  let out = "";
  for (let i = 0; i < levels; i += 1) {
    out += `#ifdef NEVER_DEFINED_SYMBOL_${i}\n`;
  }
  out += `#define DEEPLY_NESTED_DEFINE 1\n`;
  for (let i = 0; i < levels; i += 1) {
    out += `#endif\n`;
  }
  out += `#define AFTER_TREE_DEFINE 1\n`;
  return out;
}

describe("cppParser.ts — contenimento crash su alberi #ifdef patologici", () => {
  let root: string;

  beforeEach(async () => {
    clearCppParserCache();
    root = await createTempDir("crashcontainment");
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it("un albero di 2000 #ifdef annidati (sempre falsi) non lancia eccezioni e completa l'analisi", async () => {
    const content = buildPathologicalIfdefTree(2000);
    const filePath = await writeFixtureFile(root, "src/pathological.c", content);
    const output = createFakeOutput();

    await assert.doesNotReject(
      collectDefinesAndConsts([filePath], root, { resolveIncludes: false, output } as any),
      "un albero #ifdef patologico non deve mai lanciare (RangeError o altro)"
    );
  });

  it("il define DENTRO l'albero patologico (sempre falso) resta correttamente escluso, quello DOPO è incluso", async () => {
    const content = buildPathologicalIfdefTree(2000);
    const filePath = await writeFixtureFile(root, "src/pathological.c", content);

    const result = await collectDefinesAndConsts([filePath], root, { resolveIncludes: false } as any);

    assert.equal(
      result.defines.get("DEEPLY_NESTED_DEFINE"),
      undefined,
      "il define dentro rami sempre-falsi non deve mai risultare attivo"
    );
    assert.equal(
      result.defines.get("AFTER_TREE_DEFINE"),
      "1",
      "il define dopo l'albero patologico deve comunque risolversi normalmente"
    );
  });

  it("un albero MOLTO più profondo (10000 livelli) resta comunque entro tempi ragionevoli e non crasha", async () => {
    const content = buildPathologicalIfdefTree(10_000);
    const filePath = await writeFixtureFile(root, "src/extreme.c", content);

    const start = Date.now();
    await assert.doesNotReject(collectDefinesAndConsts([filePath], root, { resolveIncludes: false } as any));
    const elapsedMs = Date.now() - start;

    // Nessun limite di tempo stringente qui (dipende dalla macchina): la
    // cosa che vogliamo sigillare è che TERMINA, non un tetto assoluto.
    assert.ok(elapsedMs < 30_000, `troppo lento (${elapsedMs}ms): il cap sulla stringa potrebbe non star funzionando`);
  });
});

describe("cppParser.ts — resilienza multi-file (un file problematico non deve fermare l'analisi degli altri)", () => {
  let root: string;

  beforeEach(async () => {
    clearCppParserCache();
    root = await createTempDir("multifile");
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it("un file inesistente nella lista non impedisce l'analisi degli altri file validi", async () => {
    const goodFile = await writeFixtureFile(root, "src/good.c", `#define GOOD_DEFINE 1\n`);
    const missingFile = `${root}/src/does_not_exist.c`;

    const output = createFakeOutput();
    const result = await collectDefinesAndConsts([missingFile, goodFile], root, {
      resolveIncludes: false,
      output,
    } as any);

    assert.equal(result.defines.get("GOOD_DEFINE"), "1", "il file valido deve comunque essere analizzato");
  });

  it("un file con un albero #ifdef patologico non impedisce l'analisi di un secondo file valido nello stesso batch", async () => {
    const badFile = await writeFixtureFile(root, "src/bad.c", buildPathologicalIfdefTree(2000));
    const goodFile = await writeFixtureFile(root, "src/good.c", `#define GOOD_DEFINE 1\n`);

    const result = await collectDefinesAndConsts([badFile, goodFile], root, { resolveIncludes: false } as any);

    assert.equal(
      result.defines.get("GOOD_DEFINE"),
      "1",
      "il file buono deve risultare analizzato correttamente anche se un altro file nel batch è patologico"
    );
  });
});
