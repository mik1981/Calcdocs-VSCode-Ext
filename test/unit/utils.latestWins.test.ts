import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { createLatestWinsGuard } from "../../src/utils/latestWins";

/**
 * Copre il fix del bug "i ghost value appaiono e scompaiono
 * immediatamente dopo un toggle enable/disable ravvicinato": due
 * chiamate asincrone sovrapposte a runAnalysisAndRefreshUi() potevano
 * risolversi in ordine diverso da quello di avvio, e quella più vecchia
 * (es. il cleanup del disable) sovrascriveva il risultato di quella più
 * recente (es. la ripopolazione dell'enable).
 */

describe("utils/latestWins.ts — guardia anti-race 'vince l'ultima richiesta'", () => {
  it("un singolo start() non è mai stale finché nessun altro lo segue", () => {
    const guard = createLatestWinsGuard();
    const token = guard.start();
    assert.equal(token.isStale(), false);
  });

  it("un token diventa stale non appena un nuovo start() viene chiamato", () => {
    const guard = createLatestWinsGuard();
    const first = guard.start();
    assert.equal(first.isStale(), false);

    const second = guard.start();
    assert.equal(first.isStale(), true, "il primo token deve diventare stale dopo il secondo start()");
    assert.equal(second.isStale(), false, "il secondo (più recente) token non deve essere stale");
  });

  it("simula la race reale: la richiesta A (lenta) si risolve DOPO la richiesta B (rapida) più recente — A deve risultare stale", async () => {
    const guard = createLatestWinsGuard();
    const results: string[] = [];

    async function slowRequestA() {
      const token = guard.start(); // A parte per prima
      await new Promise((r) => setTimeout(r, 30)); // ma è più lenta a risolversi
      if (token.isStale()) {
        results.push("A: scartata (stale)");
        return;
      }
      results.push("A: applicata");
    }

    async function fastRequestB() {
      await new Promise((r) => setTimeout(r, 5)); // parte dopo A ma è più rapida
      const token = guard.start();
      await new Promise((r) => setTimeout(r, 5));
      if (token.isStale()) {
        results.push("B: scartata (stale)");
        return;
      }
      results.push("B: applicata");
    }

    await Promise.all([slowRequestA(), fastRequestB()]);

    assert.deepEqual(
      results.sort(),
      ["A: scartata (stale)", "B: applicata"].sort(),
      "solo l'ultima richiesta avviata (B) deve applicare il proprio risultato"
    );
  });

  it("tre richieste in rapida successione: solo l'ultima applica il risultato, indipendentemente dall'ordine di risoluzione", async () => {
    const guard = createLatestWinsGuard();
    const applied: number[] = [];

    async function request(id: number, resolveDelayMs: number) {
      const token = guard.start();
      await new Promise((r) => setTimeout(r, resolveDelayMs));
      if (!token.isStale()) {
        applied.push(id);
      }
    }

    // La richiesta 1 (avviata per prima) è la più LENTA a risolversi,
    // quindi anche se finisce per ultima in senso temporale, non è
    // l'ultima ad essere stata AVVIATA — deve comunque risultare stale
    // perché richiesta 3 (avviata dopo) ha già invalidato tutto ciò che
    // la precede, indipendentemente dai tempi di risoluzione.
    await Promise.all([request(1, 50), request(2, 20), request(3, 1)]);

    assert.deepEqual(applied, [3], "deve applicare il risultato solo dell'ultima richiesta AVVIATA (3)");
  });

  it("currentGeneration riflette il numero di start() chiamati", () => {
    const guard = createLatestWinsGuard();
    assert.equal(guard.currentGeneration, 0);
    guard.start();
    assert.equal(guard.currentGeneration, 1);
    guard.start();
    guard.start();
    assert.equal(guard.currentGeneration, 3);
  });

  it("guardie diverse sono completamente indipendenti tra loro", () => {
    const guardA = createLatestWinsGuard();
    const guardB = createLatestWinsGuard();

    const tokenA = guardA.start();
    guardB.start();
    guardB.start();

    // Un secondo start() su guardB non deve influenzare la staleness dei
    // token emessi da guardA.
    assert.equal(tokenA.isStale(), false);
  });
});
