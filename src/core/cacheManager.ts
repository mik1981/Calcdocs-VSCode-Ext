import {
  clearCppParserCache,
  clearMegaContentDiskCache,
  cancelPendingMegaContentDiskWrites,
} from "./cppParser";
import { clearScopedYamlAnalysisCache } from "./scopedYamlAnalysis";
import { clearGhostPriorityCache } from "./ghostPolicy";
import { invalidateHeaderIndex } from "./analysis";
import { CalcDocsState } from "./state";

type CacheInvalidationOptions = {
  /**
   * true = anche i file di cache persistiti su disco (mega-content-cache,
   * header-index-cache.json) vengono cancellati, non solo la RAM.
   * "Force Recompute" e "Restart CalcDocs" la usano entrambi a true.
   */
  includeDisk?: boolean;
  /**
   * true SOLO per "Restart CalcDocs": dimentica anche i flag "fatto una
   * volta per sessione" (es. refresh live dell'header index già
   * pianificato in questa sessione di VS Code). "Force Recompute" non lo
   * fa: vuole solo dati freschi, non simulare un riavvio.
   */
  resetSessionFlags?: boolean;
};

/**
 * Unico punto di invalidazione per TUTTE le cache di CalcDocs (RAM e,
 * opzionalmente, disco). Usato da "Force Recompute" (calcdocs.recompute)
 * e "Restart CalcDocs" (calcdocs.restart) — vedi commands.ts.
 *
 * Perché questo file esiste: prima le due azioni chiamavano a mano
 * clearCppParserCache(), che pulisce SOLO la mega-content cache in RAM —
 * non la sua copia su disco, non le altre cache del progetto
 * (scopedYamlAnalysis, ghostPolicy, header index, symbol location cache).
 * "Force Recompute" quindi poteva restituire risultati non davvero
 * ricalcolati da zero se qualcosa era ancora caldo in una di quelle cache.
 *
 * Se in futuro si aggiunge una nuova cache al progetto, va agganciata QUI
 * e non nei singoli comandi, cosi' entrambi restano automaticamente
 * completi senza doverli tenere sincronizzati a mano.
 */
export async function invalidateAllCalcDocsCaches(
  state: CalcDocsState,
  options: CacheInvalidationOptions = {}
): Promise<void> {
  const { includeDisk = false, resetSessionFlags = false } = options;

  // --- RAM: cache di modulo ---
  clearCppParserCache();
  clearScopedYamlAnalysisCache();
  clearGhostPriorityCache();

  // --- RAM: cache "persistenti" tenute su state (documentate come tali
  // in core/state.ts, ma escluse da clearComputedState() perché quella
  // pulisce i RISULTATI dell'ultima analisi, non le scorciatoie di
  // performance riusate tra un'analisi e l'altra) ---
  state.yamlSymbolLocations.clear();
  state.configVarsSourceFiles.clear();

  if (includeDisk) {
    // Le scritture debounced in coda vanno annullate, non esaudite:
    // eseguirle ora ricreerebbe pochi istanti dopo un file che stiamo
    // per cancellare, vanificando l'invalidazione appena richiesta.
    cancelPendingMegaContentDiskWrites();
  }

  await Promise.all([
    invalidateHeaderIndex(state, { includeDisk, resetSessionFlags }),
    includeDisk
      ? clearMegaContentDiskCache(state.megaContentCacheDir, state.output)
      : Promise.resolve(),
  ]);
}
