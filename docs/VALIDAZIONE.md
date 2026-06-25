# CalcDocs — Rapporto di Validazione

## Verifica Matematica

Tutti i valori `expected` nel file `formulas_model_modes_expected.yaml` sono stati
verificati analiticamente. Tolleranza applicata: max(1.0, |valore| × 0.5%).

| Simbolo                    | Metodo      | Expected [min, max] | Calcolato [min, max] | Esito |
|----------------------------|-------------|----------------------|----------------------|-------|
| Y_linear_wc                | worst_case  | [95.0, 105.0]        | [95.0, 105.0]        | ✓     |
| Y_linear_rss_uniform       | rss         | [91.34, 108.66]      | [91.34, 108.66]      | ✓     |
| Y_linear_rss_normal2s      | rss         | [92.5, 107.5]        | [92.5, 107.5]        | ✓     |
| Y_nonlinear_wc             | worst_case  | [9000, 11000]        | [9000.0, 11000.0]    | ✓     |
| Y_nonlinear_rss_uniform    | rss         | [8268, 11732]        | [8267.9, 11732.1]    | ✓     |
| Y_nonlinear_rss_normal2s   | rss         | [8500, 11500]        | [8500.0, 11500.0]    | ✓     |
| Y_two_wc                   | worst_case  | [190, 210]           | [190.0, 210.0]       | ✓     |
| Y_two_rss                  | rss         | [188.5, 211.5]       | [188.54, 211.46]     | ✓     |
| Y_total_worst_case         | worst_case  | [570, 630]           | [570.0, 630.0]       | ✓     |
| Y_total_rss                | rss         | [582, 618]           | [582.32, 617.68]     | ✓     |
| Y_with_override            | worst_case  | [36000, 44000]       | [36000.0, 44000.0]   | ✓     |
| Y_legacy_wc                | worst_case  | [95, 105]            | [95.0, 105.0]        | ✓     |
| Y_legacy_rss               | rss         | [92.5, 107.5]        | [92.5, 107.5]        | ✓     |

**Stato: PASS — tutti gli expected verificati**

---

## Verifica Sintassi YAML

| File                                         | Stato   |
|----------------------------------------------|---------|
| examples/formulas_model_modes_expected.yaml  | ✓ valido |
| examples/formulas_model_modes_expected_2.yaml| ✓ valido (preesistente, non modificato) |

---

## Errori Corretti in formulas_model_modes_expected.yaml

### Prima delle correzioni (file originale)

| Simbolo            | Problema                                                   | Impatto                          |
|--------------------|------------------------------------------------------------|----------------------------------|
| Y_total_worst_case | `mode: worst_case` → ignorato da parsePropagationMethod   | Nessuna propagazione             |
| Y_total_rss        | `mode: rss` → ignorato da parsePropagationMethod          | Nessuna propagazione             |
| Y_total_gaussian   | `mode: gaussian` → non è PropagationMethod                | Nessuna propagazione + errore    |
| X_TOL_PROB         | `probabilistic.mode` ignorato come output propagation     | Distribution input solo          |
| X_RSS_PROB         | `probabilistic` senza `tol` → uncertainty undefined       | range = undefined                |
| X_GAUSS_PROB       | `probabilistic.mode: gaussian` ignorato                   | Distribution input solo          |
| Y_linear_mixed_wc  | `probabilistic` senza `tol` → uncertainty undefined       | range = undefined                |
| Y_linear_mixed_gauss | `probabilistic` senza `tol` → uncertainty undefined     | range = undefined                |
| Y_total_gaussian   | Expected [570,630] calibrato su vecchio modello           | Valori non riproducibili         |

### Dopo le correzioni

Il file è stato **riscritto completamente** con:
- Utilizzo esclusivo del nuovo formato (`uncertainty:`, `distribution:`, `propagation:`)
- Rimozione di tutti i campi legacy `mode:` e `probabilistic:`
- Aggiunta di casi di test più chiari e sistematici
- Expected calcolati analiticamente e verificati

---

## File Prodotti

```
calcdocs-deliverables/
├── ANALISI_COMPLETA.md                           ← documento architettura + problemi
├── VALIDAZIONE.md                                 ← questo file
├── examples/
│   └── formulas_model_modes_expected.yaml        ← FILE CORRETTO (sostituisce l'originale)
├── test/
│   ├── tolerance.unit.test.ts                    ← test unit motore tolleranza
│   └── yamlTolerance.integration.test.ts         ← test integrazione YAML
├── src/
│   ├── ui/
│   │   └── guideWebviewProvider.ts               ← provider webview guida
│   └── extension_guide_registration.ts           ← snippet registrazione in extension.ts
└── resources/
    ├── guide_icon.svg                             ← icona punto interrogativo
    └── guide_webview.html                         ← HTML guida interattiva con grafici
```

---

## Applicazione al Repository

### File da sostituire

```
CalcDocs/examples/formulas_model_modes_expected.yaml
  ← calcdocs-deliverables/examples/formulas_model_modes_expected.yaml
```

### File da aggiungere

```
CalcDocs/test/tolerance.unit.test.ts
  ← calcdocs-deliverables/test/tolerance.unit.test.ts

CalcDocs/test/yamlTolerance.integration.test.ts
  ← calcdocs-deliverables/test/yamlTolerance.integration.test.ts

CalcDocs/src/ui/guideWebviewProvider.ts
  ← calcdocs-deliverables/src/ui/guideWebviewProvider.ts

CalcDocs/resources/guide_icon.svg
  ← calcdocs-deliverables/resources/guide_icon.svg

CalcDocs/resources/guide_webview.html
  ← calcdocs-deliverables/resources/guide_webview.html
```

### Modifiche manuali richieste

**extension.ts** — aggiungere in `activate()`:

```typescript
import { GuideWebviewProvider } from "./ui/guideWebviewProvider";

// In activate():
const guideProvider = new GuideWebviewProvider(context.extensionUri);
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider(
    GuideWebviewProvider.VIEW_ID,
    guideProvider,
    { webviewOptions: { retainContextWhenHidden: true } }
  )
);
context.subscriptions.push(
  vscode.commands.registerCommand("calcdocs.openGuide", () => {
    GuideWebviewProvider.openAsPanel(context);
  })
);
```

**package.json** — aggiungere in `contributes`:

```json
"viewsContainers": {
  "activitybar": [{
    "id": "calcdocs-guide-container",
    "title": "CalcDocs Guide",
    "icon": "resources/guide_icon.svg"
  }]
},
"views": {
  "calcdocs-guide-container": [{
    "type": "webview",
    "id": "calcdocs.guideView",
    "name": "CalcDocs Guide",
    "icon": "resources/guide_icon.svg"
  }]
},
"commands": [{
  "command": "calcdocs.openGuide",
  "title": "CalcDocs: Open Interactive Guide",
  "icon": "$(question)"
}]
```

---

## Limitazioni Residue Documentate

1. **sigmaOut=3 hardcoded in `runRss()`**: il valore 3σ dell'output RSS non è esposto via YAML. Non introdotta modifica per non alterare il comportamento esistente senza evidenza che sia richiesta.

2. **Monte Carlo non disponibile nella webview interattiva**: la webview usa `computeLiveRange()` (approssimazione lineare). Monte Carlo è disponibile solo tramite `evaluateYamlDocument()`. La guida interattiva ne simula una versione client-side (2000 campioni) a scopo didattico.

3. **Test di integrazione `yamlTolerance.integration.test.ts`**: richiedono il metodo `evaluateYamlDocument()` (con la firma `(root, options)` rilevata in `yamlEngine.ts`). Se la firma reale differisce, adattare gli argomenti.

4. **Guida in modalità sidebar**: quando aperta come pannello laterale (WebviewView), il canvas potrebbe avere dimensioni ridotte. La classe `ResizeObserver` ridisegna automaticamente al resize. Per una visualizzazione ottimale usare il comando `calcdocs.openGuide` (pannello standalone).
