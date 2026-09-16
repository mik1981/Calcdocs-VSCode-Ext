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
 * isStale() da solo basta per decidere "non applicare più questo
 * risultato", ma NON ferma il lavoro sottostante ancora in corso. Su
 * un'analisi che può includere vere chiamate LSP a clangd (lente, con
 * un server esterno che ha una coda condivisa), lasciarla proseguire
 * "per conto suo" dopo essere stata superata continua a intasare quella
 * coda — compresa la richiesta di hover REALE dell'utente, che finisce
 * dietro decine di richieste ormai inutili. isCancelled() esiste per
 * questo: le operazioni costose (in particolare ogni chiamata a
 * clangd, e i cicli di parsing su file enormi) lo controllano spesso e
 * si fermano SUBITO quando true, invece di limitarsi a scartare il
 * risultato alla fine.
 *
 * Uso:
 *   const guard = createLatestWinsGuard();
 *   async function doWork() {
 *     const { isStale, isCancelled } = guard.start();
 *     await qualcheOperazioneCostosaCheControllaIsCancelledSpesso();
 *     if (isStale()) return; // un'altra chiamata più recente ha già preso il sopravvento
 *     applicaRisultato();
 *   }
 */

export type LatestWinsToken = {
  /** true se, da quando start() è stato chiamato, un'altra chiamata a
   * start() sulla STESSA guardia è avvenuta nel frattempo — cioè questa
   * non è più la richiesta più recente. */
  isStale: () => boolean;
  /** true se isStale() è true, OPPURE se cancel() è stato chiamato
   * esplicitamente su QUESTO token (es. un timeout interno ha deciso di
   * arrendersi senza che una richiesta più recente lo abbia superato).
   * Le operazioni costose vanno interrotte appena questo diventa true,
   * non solo isStale(). */
  isCancelled: () => boolean;
  /** Segna il lavoro di QUESTO token come abbandonato, senza aspettare
   * che una generazione più recente lo superi. Es.: il fallback
   * progressivo rinuncia da solo dopo il timeout configurato. */
  cancel: () => void;
  /** Numero di generazione catturato al momento di start(), utile per debug/log. */
  readonly generation: number;
};

type LatestWinsGuard = {
  /** Da chiamare all'inizio di ogni operazione che deve competere per
   * "l'ultima vince". Ogni chiamata invalida (rende stale e cancellata)
   * i token precedentemente emessi da start(). */
  start: () => LatestWinsToken;
  /** Generazione corrente, utile per debug/log. */
  readonly currentGeneration: number;
};

export function createLatestWinsGuard(): LatestWinsGuard {
  let generation = 0;

  return {
    start(): LatestWinsToken {
      const myGeneration = ++generation;
      let explicitlyCancelled = false;
      const isStale = () => myGeneration !== generation;
      return {
        generation: myGeneration,
        isStale,
        isCancelled: () => explicitlyCancelled || isStale(),
        cancel: () => {
          explicitlyCancelled = true;
        },
      };
    },
    get currentGeneration() {
      return generation;
    },
  };
}
