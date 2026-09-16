import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runProgressiveAnalysis } from "../../src/utils/progressiveAnalysis";

/** Promise that resolves once `advanceTimersByTimeAsync` reaches `ms`. */
function resolveAfter(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Promise that never resolves - simulates a genuinely hung full analysis. */
function neverResolves(): Promise<void> {
  return new Promise(() => {
    /* intentionally never settles */
  });
}

describe("runProgressiveAnalysis", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("common case: full analysis resolves before the first checkpoint - no shallow pass, no notice, never cancels", async () => {
    const runShallow = vi.fn(async () => undefined);
    const onNotice = vi.fn();
    const onResolved = vi.fn();
    const cancel = vi.fn();

    const promise = runProgressiveAnalysis({
      runFull: () => resolveAfter(100),
      runShallow,
      isStale: () => false,
      cancel,
      onNotice,
      onResolved,
      timeoutMs: 90_000,
    });

    await vi.advanceTimersByTimeAsync(200);
    await promise;

    expect(runShallow).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("shows one partial result then resolves before the next checkpoint - never cancels", async () => {
    const runShallow = vi.fn(async () => undefined);
    const onNotice = vi.fn();
    const onResolved = vi.fn();
    const cancel = vi.fn();

    const promise = runProgressiveAnalysis({
      runFull: () => resolveAfter(8_000), // dopo il 1° checkpoint (5s), prima del 2° (5+10=15s)
      runShallow,
      isStale: () => false,
      cancel,
      onNotice,
      onResolved,
      timeoutMs: 90_000,
    });

    await vi.advanceTimersByTimeAsync(20_000);
    await promise;

    expect(runShallow).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith({ kind: "partial", elapsedMs: 5_000 });
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("escalates checkpoint intervals correctly (5s, +10s, +20s, +30s, +30s...)", async () => {
    const runShallow = vi.fn(async () => undefined);
    const onNotice = vi.fn();
    const onResolved = vi.fn();
    const cancel = vi.fn();

    const promise = runProgressiveAnalysis({
      // Risolve dopo 6 checkpoint: 5, 15, 35, 65, 95, 125 -> risolviamo appena dopo il 5°
      runFull: () => resolveAfter(96_000),
      runShallow,
      isStale: () => false,
      cancel,
      onNotice,
      onResolved,
      timeoutMs: 10_000_000, // altissimo: qui testiamo solo la cadenza, non il troncamento
    });

    await vi.advanceTimersByTimeAsync(130_000);
    await promise;

    const elapsedSeenByNotice = onNotice.mock.calls.map(([n]) => n.elapsedMs);
    expect(elapsedSeenByNotice).toEqual([5_000, 15_000, 35_000, 65_000, 95_000]);
    expect(runShallow).toHaveBeenCalledTimes(5);
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("truncates after the configured timeout: cancels the full analysis for real, runs a final shallow pass, and does NOT apply a late result even if runFull() eventually settles anyway", async () => {
    const runShallow = vi.fn(async () => undefined);
    const onNotice = vi.fn();
    const onResolved = vi.fn();
    const cancel = vi.fn();

    let resolveFull!: () => void;
    const fullPromise = new Promise<void>((resolve) => {
      resolveFull = resolve;
    });

    const promise = runProgressiveAnalysis({
      runFull: () => fullPromise,
      runShallow,
      isStale: () => false,
      cancel,
      onNotice,
      onResolved,
      timeoutMs: 40_000, // checkpoint: 5, 15, 35 (<40) poi 65 (>=40) -> tronca al 4° checkpoint, elapsed=65000
    });

    await vi.advanceTimersByTimeAsync(70_000);
    await promise; // runProgressiveAnalysis stessa si risolve al momento del troncamento

    // cancel() va chiamato ESATTAMENTE al momento del troncamento: è quello
    // che deve far cessare per davvero runFull() (nel mondo reale,
    // propagato fino al ciclo di richieste hover a clangd), non solo farci
    // smettere di aspettarla.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith({ kind: "truncated", elapsedMs: 65_000 });
    expect(onResolved).not.toHaveBeenCalled();

    // Anche se runFull() si risolve comunque più tardi (es. non ha fatto
    // in tempo a controllare la cancellazione prima di finire per conto
    // suo), NON va più applicata: l'abbiamo cancellata attivamente, non
    // solo abbandonata, quindi non è più un risultato da usare per
    // aggiornare la UI.
    resolveFull();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(onResolved).not.toHaveBeenCalled();
  });

  it("stops touching callbacks once isStale() becomes true, and does not call cancel() itself (superseding is the caller's job)", async () => {
    const runShallow = vi.fn(async () => undefined);
    const onNotice = vi.fn();
    const onResolved = vi.fn();
    const cancel = vi.fn();
    let stale = false;

    const promise = runProgressiveAnalysis({
      runFull: () => resolveAfter(50_000),
      runShallow,
      isStale: () => stale,
      cancel,
      onNotice,
      onResolved,
      timeoutMs: 90_000,
    });

    // Primo checkpoint (5s): ancora fresco, ci si aspetta un notice "partial".
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onNotice).toHaveBeenCalledTimes(1);

    // Un trigger più recente prende il sopravvento prima del prossimo checkpoint.
    stale = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    // Nessuna ulteriore chiamata dopo che è diventato stale, e mai onResolved.
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onResolved).not.toHaveBeenCalled();
    // isStale() diventare true è già di per sé il segnale di cancellazione
    // per chi implementa runFull() (isCancelled() = isStale() || esplicito);
    // questo modulo non ha bisogno di chiamare cancel() separatamente in
    // questo caso.
    expect(cancel).not.toHaveBeenCalled();
  });

  it("respects a custom checkpointsMs schedule", async () => {
    const runShallow = vi.fn(async () => undefined);
    const onNotice = vi.fn();
    const onResolved = vi.fn();
    const cancel = vi.fn();

    const promise = runProgressiveAnalysis({
      runFull: () => neverResolves(),
      runShallow,
      isStale: () => false,
      cancel,
      onNotice,
      onResolved,
      checkpointsMs: [1_000, 2_000],
      timeoutMs: 4_000, // checkpoint: 1000, 3000 (<4000) poi 5000 (>=4000) -> tronca, elapsed=5000
    });

    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    const elapsedSeenByNotice = onNotice.mock.calls.map(([n]) => n.elapsedMs);
    expect(elapsedSeenByNotice).toEqual([1_000, 3_000, 5_000]);
    expect(onNotice.mock.calls[2][0]).toEqual({ kind: "truncated", elapsedMs: 5_000 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("regression: the final shallow pass at truncation must still produce a result, even though runShallow shares the same cancellation signal as runFull", async () => {
    // A differenza degli altri test, qui runShallow() si comporta come fa
    // DAVVERO in extension.ts: controlla lo stesso segnale di
    // cancellazione di runFull(). Se cancel() venisse chiamato PRIMA
    // dell'ultima passata shallow (bug reale trovato e corretto in
    // questa sessione), questo mock — a differenza di un mock "cieco"
    // che ignora la cancellazione — rileverebbe il problema restituendo
    // shallowRan = false invece di true.
    let cancelled = false;
    let shallowRan = false;

    const onNotice = vi.fn();
    const onResolved = vi.fn();

    const promise = runProgressiveAnalysis({
      runFull: () => neverResolves(),
      runShallow: async () => {
        if (cancelled) return; // replica isCancelled() controllato in testa a runActiveCppFileAnalysis
        shallowRan = true;
      },
      isStale: () => false,
      cancel: () => {
        cancelled = true;
      },
      onNotice,
      onResolved,
      timeoutMs: 5_000,
      checkpointsMs: [5_000],
    });

    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(shallowRan).toBe(true);
    expect(onNotice).toHaveBeenCalledWith({ kind: "truncated", elapsedMs: 5_000 });
  });
});
