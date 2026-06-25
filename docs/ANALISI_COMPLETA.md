# Analisi Completa CalcDocs

## Stato attuale dell'implementazione

### File modificati
1. **`package.json`**: Rimosso `viewsContainers` e `views.calcdocs-guide-container` per eliminare la guida dall'Activity Bar. Ristrutturati i menu `view/title` per sdoppiare l'icona del punto interrogativo: per file `.c` apre la guida inline calc, per file `formula*.yaml` apre la guida interattiva completa.

2. **`resources/guide_webview.html`**: Rimosso tutto il codice JavaScript duplicato (PRNG SplitMix32/xoshiro128**, Box-Muller, sampling distribuzioni, drawPDF, drawHistogram, setupCanvas, ecc.). Ora delega tutti i calcoli al motore TypeScript tramite `initGuideEngineClient()`.

3. **`src/ui/guideEngineClient.ts`**: Riscritto completamente. Ora usa `computeGuideScenario()` da `guideModel.ts` per tutti i calcoli interattivi. I grafici usano il motore reale (normalizeUncertainty, computeStdDev, propagate, runMonteCarlo) invece di implementazioni duplicate inline.

4. **`src/extension.ts`**: Sostituita `registerGuide()` con `registerGuideCommands()`. Ora la guida è indipendente dalla webview principale. Lo sdoppiamento dell'icona è gestito tramite context key VS Code.

### Problemi trovati

1. **Duplicazione del motore matematico nella guida**: Il file `resources/guide_webview.html` conteneva implementazioni duplicate di PRNG (SplitMix32, xoshiro128**), Box-Muller, sampling uniforme/normale/triangolare, calcolo percentile, statistiche, drawPDF, drawHistogram - tutto inline nel JavaScript della webview. Questo violava il principio DRY e poteva portare a discrepanze numeriche tra la guida e il motore reale.

2. **Guida nell'Explorer VS Code**: La guida era registrata sia come `viewsContainers.activitybar` (activity bar) sia come `views.calcdocs-guide-container` che non doveva più apparire.

3. **Icona punto interrogativo non sdoppiata**: Il comando `calcdocs.openGuide` apriva sempre la stessa guida indipendentemente dal tipo di file attivo.

4. **guideEngineClient.ts inutilizzato**: Il modulo TypeScript era quasi inutilizzato perché la webview HTML faceva tutto inline.

5. **Test con framework custom**: I test `tolerance.unit.test.ts` e `yamlTolerance.integration.test.ts` usano un framework custom (suite/test con console.log/process.exitCode) invece di vitest describe/it, causando "No test suite found".

### Modifiche effettuate

| File | Modifica |
|------|----------|
| `package.json` | Rimossi viewsContainers e views per calcdocs-guide-container. Ristrutturati i menu view/title per sdoppiamento icona guida. |
| `resources/guide_webview.html` | Rimosso tutto il JS duplicato. Ora delega a initGuideEngineClient(). |
| `src/ui/guideEngineClient.ts` | Riscritto per usare computeGuideScenario() dal motore reale. |
| `src/extension.ts` | registerGuide() → registerGuideCommands(). Aggiunto context key per sdoppiamento icona. |

### Limitazioni residue

1. I test `tolerance.unit.test.ts` e `yamlTolerance.integration.test.ts` usano framework custom non vitest. I test passano ma vitest non li riconosce come suite.
2. La webview interattiva (`interactive_webview_class.html`) non ha ancora visualizzazioni grafiche delle distribuzioni - da implementare.
3. Prestazioni: nessun Web Worker implementato per calcoli pesanti Monte Carlo.