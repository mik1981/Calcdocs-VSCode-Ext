/**
 * Guardia generica anti-race per operazioni asincrone sovrapponibili in
 * cui deve sempre "vincere" l'ultima richiesta avviata, indipendentemente
 * dall'ordine in cui le richieste in volo finiscono di risolversi.
 *
 * Caso d'uso originale: runAnalysisAndRefreshUi() in extension.ts poteva
 * essere invocata più volte in rapida successione (es. toggle
 * disable→enable ravvicinato). Se la chiamata più vecchia (es. il
 * cleanup del disable, rapido) si risolveva DOPO quella più recente (es.
 * la ri-analisi dell'enable, più lenta per via di vera I/O), il suo
 * risultato sovrascriveva quello — più fresco — della chiamata
 * successiva: i ghost value apparivano e sparivano subito dopo.
 *
 * Uso:
 *   const guard = createLatestWinsGuard();
 *   async function doWork() {
 *     const { isStale } = guard.start();
 *     await qualcheOperazioneAsincrona();
 *     if (isStale()) return; // un'altra chiamata più recente ha già preso il sopravvento
 *     applicaRisultato();
 *   }
 */

export type LatestWinsToken = {
  /** true se, da quando start() è stato chiamato, un'altra chiamata a
   * start() sulla STESSA guardia è avvenuta nel frattempo — cioè questa
   * non è più la richiesta più recente. */
  isStale: () => boolean;
  /** Numero di generazione catturato al momento di start(), utile per debug/log. */
  readonly generation: number;
};

export type LatestWinsGuard = {
  /** Da chiamare all'inizio di ogni operazione che deve competere per
   * "l'ultima vince". Ogni chiamata invalida (rende stale) i token
   * precedentemente emessi da start(). */
  start: () => LatestWinsToken;
  /** Generazione corrente, utile per debug/log. */
  readonly currentGeneration: number;
};

export function createLatestWinsGuard(): LatestWinsGuard {
  let generation = 0;

  return {
    start(): LatestWinsToken {
      const myGeneration = ++generation;
      return {
        generation: myGeneration,
        isStale: () => myGeneration !== generation,
      };
    },
    get currentGeneration() {
      return generation;
    },
  };
}
