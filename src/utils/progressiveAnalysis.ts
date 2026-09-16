/**
 * Fallback progressivo per analisi che possono richiedere troppo tempo
 * su progetti enormi (dove anche clangd può andare in difficoltà):
 * invece di far restare la UI "working" a tempo indeterminato, mostra
 * dopo un breve ritardo un risultato ridotto/best-effort, continua ad
 * aggiornarlo a intervalli crescenti mentre l'analisi completa prosegue
 * in background, e infine RINUNCIA DAVVERO (non solo "smette di
 * aspettare") se impiega troppo.
 *
 * Punto critico: "rinunciare" deve fermare per davvero il lavoro
 * sottostante, non solo ignorarne il risultato. Un'analisi completa
 * abbandonata-ma-non-cancellata continua a interrogare clangd in
 * background (vero traffico LSP verso un processo esterno, con una coda
 * condivisa) — se nel frattempo arrivano NUOVI trigger (salvataggi,
 * cambi file, scan periodico), ognuno avvia una NUOVA analisi completa
 * senza fermare quelle precedenti: si accumulano analisi "zombie" che
 * competono tutte per la stessa coda di clangd, mettendo in crisi anche
 * l'hover interattivo reale dell'utente. Per questo runFull() deve
 * essere davvero interrompibile (controlla isCancelled() spesso, non
 * solo il proprio budget di tempo) e cancel() va chiamato al momento
 * del troncamento, non lasciato implicito.
 *
 * Estratto in un modulo a parte (nessuna dipendenza da vscode) apposta
 * per poter testare la logica di timing/race con fake timer, dato che
 * non è realisticamente possibile riprodurre "un progetto così grande
 * da mettere in crisi clangd" in un ambiente di test.
 */

export type ProgressiveAnalysisNotice =
  | { kind: "partial"; elapsedMs: number }
  | { kind: "truncated"; elapsedMs: number };

type ProgressiveAnalysisCallbacks = {
  /**
   * Avvia l'analisi completa. Deve risolversi (o rigettare) esattamente
   * una volta, e DEVE controllare frequentemente un segnale di
   * cancellazione equivalente a isStale()/cancel() qui sotto - altrimenti
   * il troncamento sotto non fa niente di utile, si limita a smettere di
   * aspettarla mentre continua a consumare risorse (e la coda di clangd)
   * per conto suo.
   */
  runFull: () => Promise<void>;
  /** Analisi rapida a scope ridotto, invocata ad ogni checkpoint mentre runFull è ancora pendente, e una volta in più al momento del troncamento. */
  runShallow: () => Promise<void>;
  /** True se questo tentativo è stato superato da uno più recente: da quel momento in poi non va più toccata la UI. */
  isStale: () => boolean;
  /**
   * Da chiamare al momento del troncamento per far cessare per davvero
   * runFull() (es. inoltrata fino al ciclo di richieste hover a clangd
   * e al parsing #include, entrambi devono controllarla). Idempotente:
   * può essere chiamata anche se isStale() diventerà vero comunque.
   */
  cancel: () => void;
  /** Chiamata dopo ogni passata shallow applicata (kind "partial") e una volta al troncamento (kind "truncated"). */
  onNotice: (notice: ProgressiveAnalysisNotice) => void;
  /** Chiamata quando il risultato dell'analisi COMPLETA va considerato autorevole e applicato (solo se arriva entro i checkpoint, prima di un eventuale troncamento - dopo il troncamento runFull() è stata cancellata e non produrrà più un risultato migliore). */
  onResolved: () => void;
  /** In ms. Default: [5000, 10000, 20000, 30000] (l'ultimo si ripete). */
  checkpointsMs?: number[];
  /** Tempo totale (ms) oltre il quale si rinuncia (e si cancella) l'analisi completa per questo giro. */
  timeoutMs: number;
};

const DEFAULT_PROGRESSIVE_CHECKPOINTS_MS = [5_000, 10_000, 20_000, 30_000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Aspetta che `promise` si risolva OPPURE che passino `ms` millisecondi, quale dei due arriva prima - e dice quale ha vinto. */
async function waitForEither(promise: Promise<void>, ms: number): Promise<"resolved" | "timeout"> {
  const TIMEOUT = Symbol("timeout");
  const result = await Promise.race([
    promise.then(() => "resolved" as const),
    delay(ms).then(() => TIMEOUT),
  ]);
  return result === TIMEOUT ? "timeout" : "resolved";
}

export async function runProgressiveAnalysis(
  callbacks: ProgressiveAnalysisCallbacks
): Promise<void> {
  const { runFull, runShallow, isStale, cancel, onNotice, onResolved, timeoutMs } = callbacks;
  const checkpoints = callbacks.checkpointsMs ?? DEFAULT_PROGRESSIVE_CHECKPOINTS_MS;
  if (checkpoints.length === 0) {
    throw new Error("runProgressiveAnalysis: checkpointsMs non può essere vuoto");
  }

  const fullPromise = runFull();
  // Se runFull() rigetta (non dovrebbe: la convenzione è che logghi e
  // non lanci mai, esattamente come runActiveCppFileAnalysis fa
  // internamente) evitiamo comunque un unhandled rejection quando, dopo
  // il troncamento, smettiamo di fare await esplicito su di essa.
  fullPromise.catch(() => undefined);

  let elapsedMs = 0;
  let checkpointIndex = 0;

  while (true) {
    const stepMs = checkpoints[Math.min(checkpointIndex, checkpoints.length - 1)];
    checkpointIndex++;

    const outcome = await waitForEither(fullPromise, stepMs);
    elapsedMs += stepMs;

    if (isStale()) {
      // Una richiesta più recente ha già preso il sopravvento: non
      // chiamiamo più nessuna callback per questo tentativo superato.
      // Non serve chiamare cancel() esplicitamente qui: chi ha reso
      // stale questo token si assume che lo faccia lui stesso (vedi
      // extension.ts, dove una nuova generazione cancella sempre la
      // precedente sulla stessa guardia).
      return;
    }

    if (outcome === "resolved") {
      onResolved();
      return;
    }

    if (elapsedMs >= timeoutMs) {
      // Rinuncia DAVVERO — ma PRIMA facciamo comunque un'ultima passata
      // shallow, POI cancelliamo. L'ordine conta: se runShallow() è
      // cablata sullo stesso token di cancellazione di runFull() (come
      // fa extension.ts), chiamare cancel() già PRIMA la farebbe
      // fallire immediatamente (runActiveCppFileAnalysis controlla
      // isCancelled() in testa e ritorna subito senza fare nulla) — il
      // messaggio "troncato" comparirebbe nella status bar ma i ghost
      // value non verrebbero affatto aggiornati al risultato ridotto
      // che quel messaggio promette di mostrare. Il ritardo di qualche
      // istante nel fermare davvero runFull() è trascurabile: è comunque
      // già stata data la possibilità di risolversi per tutto timeoutMs.
      await runShallow();
      cancel();
      if (isStale()) return;
      onNotice({ kind: "truncated", elapsedMs });
      return;
    }

    await runShallow();
    if (isStale()) return;
    onNotice({ kind: "partial", elapsedMs });
  }
}
