# Analisi completa del flusso probabilistico CalcDocs

> Documento analitico — codici sorgente citati puntualmente.

---

## FASE 1 — Mappa del flusso dei dati probabilistici (9 stadi)

```
YAML file
  ↓ parseFormulaYamlText / normalizeFormulaYamlNode   [formulaYaml.ts]
ParsedFormulaYamlEntry  { tolerance: FormulaToleranceSpec }
  ↓ evaluateYamlDocument                               [yamlEngine.ts]
EvaluatedYamlSymbol     { range: PropagationResult & {source} }
  ↓ rebuildFormulaIndexWithEngine                      [analysis.ts]
FormulaEntry (core)     { toleranceResult: PropagationResult & {source} }
  ↓ buildInteractiveFormulaEntries / createFormulaEntry [interactiveFormulaEngine.ts]
FormulaEntry (webview)  { range: {min,max,source,method?,nominalValue?,stddev?,distribution?} }
  ↓ postMessage / JSON.stringify                        [interactiveView.ts]
JSON → window
  ↓ renderDistributionPanel / renderDistHistogram       [interactive_webview_class.html]
SVG istogramma
```

| Stadio | File | Funzione/Classe | Input | Output |
|--------|------|-----------------|-------|--------|
| 1. Parse YAML | `src/core/formulaYaml.ts` | `parseToleranceSpec` | Record `string,unknown` nodo `FormulaToleranceSpec` | — |
| 2. Normalizza incertezza | `src/core/formulaYaml.ts` | `convertLegacyToleranceToNew`, `parseUncertaintySpec`, `parseDistributionSpec` | nodo YAML | `ParsedInputTolerance {uncertainty, distribution}` |
| 3. Valutazione simbolo | `src/engine/yamlEngine.ts` | `evaluateYamlDocument → evaluateSymbol` | `ParsedSymbol` | `EvaluatedYamlSymbol {range}` |
| 4. Propagazione output | `src/engine/yamlEngine.ts` | blocco `if (symbol.tolerance?.output)` | `UnifiedInput[]`, `evalFn` | `PropagationResult` via `propagate()` |
| 5. Motore MC/RSS/WC | `src/engine/monteCarlo.ts` | `propagate`, `runMonteCarlo`, `runRss`, `runWorstCase` | `UnifiedInput[]` | `PropagationResult {method, min, max, distribution?}` |
| 6. Campionamento | `src/engine/monteCarlo.ts` | `fillSamples` | `McSampleSpec {distribution, lower, upper, stdDev}` | `Float64Array` campioni |
| 7. Indice formule | `src/core/analysis.ts` | `rebuildFormulaIndexWithEngine` | `EvaluatedYamlSymbol` | `FormulaEntry.toleranceResult` |
| 8. Engine interattivo | `src/ui/interactiveFormulaEngine.ts` | `createFormulaEntry`, `buildTree` | `CoreFormulaEntry` | `FormulaEntry` (webview) con `.range` completo |
| 9. Rendering | `resources/interactive_webview_class.html` | `renderDistributionPanel`, `renderDistHistogram` | `FormulaTreeNode.result.range` | SVG istogramma |

---

## FASE 2 — Analisi delle distribuzioni dichiarate negli YAML

Dal file `examples/formulas_model_modes_expected.yaml`:

| Variabile | Distribuzione YAML | Parametri | Distribuzione teorica attesa |
|-----------|-------------------|-----------|------------------------------|
| X_TOL | `distribution.type: uniform` | hw=5 | Uniforme [95, 105] |
| X_RSS | `distribution.type: normal, sigma_level: 2` | hw=5, σ=2.5 | Normale μ=100, σ=2.5 |
| X_GAUSS | `distribution.type: normal, sigma_level: 2` | hw=5, σ=2.5 | Normale μ=100, σ=2.5 |
| X_RANGE_ASYM | `distribution.type: uniform` | min=92, max=108 | Uniforme [92, 108] |
| A_UNIF_1/2 | `distribution.type: uniform` | hw=5 | Uniforme [95, 105] |
| A_NORM_2S_1/2 | `distribution.type: normal, sigma_level: 2` | σ=2.5 | Normale μ=100, σ=2.5 |
| A_NORM_3S_1/2 | `distribution.type: normal, sigma_level: 3` | σ≈1.667 | Normale μ=100, σ≈1.667 |
| X_LEGACY_TOL | (legacy tol: 5) | → percent+uniform | Uniforme [95, 105] |
| X_LEGACY_GAUSSIAN | (legacy tol_mode: gaussian, sigma: 2) | → percent+normal(sl=2) | Normale μ=100, σ=2.5 |

**Verifica parser** — `src/core/formulaYaml.ts`, `parseDistributionSpec`:

```typescript
const spec: DistributionSpec = { type };
if (raw["sigma_level"] !== undefined) spec.sigma_level = toFiniteNumber(raw["sigma_level"]);
if (raw["mode_value"]  !== undefined) spec.mode_value  = toFiniteNumber(raw["mode_value"]);
```

Il campo `type` e `sigma_level` vengono conservati correttamente in `ParsedInputTolerance.distribution`. Il parser non perde informazioni in questo stadio.

---

## FASE 3 — Analisi del motore Monte Carlo

**Punto di generazione campioni** — `src/engine/monteCarlo.ts`, funzione `fillSamples`:

```typescript
function fillSamples(out: Float64Array, spec: McSampleSpec, prng: Prng): void {
  const { lower, upper, nominal, distribution, stdDev } = spec;
  switch (distribution) {
    case "uniform":
      for (let i = 0; i < n; i++) out[i] = lower + prng() * (upper - lower);
    case "normal": {
      const mu = (lower + upper) / 2;  // ← usa il punto medio, non il nominal
      for (...) { ... out[i] = mu + z0 * stdDev; ... }
    }
    case "triangular": { ... }
  }
}
```

**PRNG:** xoshiro128\*\* con SplitMix32 warm-up — deterministico se seed fornito, altrimenti `Date.now()`.

**Costruzione McSampleSpec in `propagate()`** — `src/engine/monteCarlo.ts`:

```typescript
const specs: McSampleSpec[] = [];
for (const inp of inputs) {
  const norm = normalizeUncertainty(inp.uncertainty, inp.nominal);
  const dk = inp.distribution.type === "normal" ? "normal"
           : inp.distribution.type === "triangular" ? "triangular" : "uniform";
  specs.push({
    name: inp.name, nominal: inp.nominal,
    lower: norm.lower, upper: norm.upper,
    distribution: dk,
    sigmaLevel: inp.distribution.type === "normal" ? (inp.distribution.sigma_level ?? 3) : 1,
    stdDev: computeStdDev(norm, inp.distribution)
  });
}
```

Il campo `distribution` in `McSampleSpec` viene settato correttamente ("normal" per normal, "uniform" per uniform). Lo `stdDev` viene calcolato da `computeStdDev` (in `src/types/toleranceModel.ts`):

```typescript
case "normal":     return norm.halfWidth / sigmaLevel;      // hw/sl
case "uniform":    return norm.halfWidth / Math.sqrt(3);   // hw/√3
case "triangular": return norm.halfWidth / Math.sqrt(6);
```

**Fino a questo stadio il tipo di distribuzione è corretto e non si perde.**

---

## FASE 4 — Tracciatura completa di un caso reale

**Caso:** `Y_linear_rss_normal2s` (formula `X_RSS`, propagation `rss`)

### Passo 1 — YAML

```yaml
X_RSS:
  type: const
  value: 100
  uncertainty: { type: percent, value: 5 }
  distribution: { type: normal, sigma_level: 2 }

Y_linear_rss_normal2s:
  formula: X_RSS
  propagation: rss
```

### Passo 2 — Parser (`src/core/formulaYaml.ts`)

```
parseUncertaintySpec → { type: "percent", value: 5 }
parseDistributionSpec → { type: "normal", sigma_level: 2 }
ParsedInputTolerance per X_RSS: { uncertainty: {type:"percent",value:5}, distribution: {type:"normal",sigma_level:2} }
```

### Passo 3 — `evaluateYamlDocument → evaluateSymbol("X_RSS")`

Il simbolo è `const`, quindi in `src/engine/yamlEngine.ts`, blocco "const":

```typescript
const norm = normalizeUncertainty(uncertainty, result.value!);
// norm = { nominal:100, lower:95, upper:105, halfWidth:5 }
result.range = {
  min: norm.lower,        // 95
  max: norm.upper,        // 105
  nominalValue: result.value,
  stddev: computeStdDev(norm, distribution),  // 5/2 = 2.5
  contributingInputs: [],
  method: "worst_case",   // ← PROBLEMA #3: hardcoded!
  source: "declared",
};
```

### Passo 4 — `evaluateSymbol("Y_linear_rss_normal2s")`

La formula ha `tolerance.output = { method: "rss" }`. Entra nel blocco di propagazione output in `src/engine/yamlEngine.ts`:

```typescript
// blocco "propagation output"
unifiedInputs.push({
  name: "X_RSS",
  nominal: dep?.yamlValue ?? 0,      // 100
  uncertainty: inputSpec.uncertainty,   // {type:"percent",value:5}
  distribution: inputSpec.distribution  // {type:"normal",sigma_level:2}
});
Poi chiama propagate(unifiedInputs, evalFn, nominalOutput, "rss", options).
```

### Passo 5 — `propagate() → runRss()`

In `src/engine/monteCarlo.ts`:

```typescript
const rssInputs = inputs.map(inp => {
  const hw = hws[inp.name];              // 5
  const vP = { X_RSS: 105 };
  const vM = { X_RSS: 95 };
  const dfdx = (evaluate(vP) - evaluate(vM)) / (2 * hw);  // (105-95)/10 = 1
  return { name:"X_RSS", sensitivity: dfdx * sds["X_RSS"], stdDev: sds["X_RSS"] };
  // sds["X_RSS"] = computeStdDev({halfWidth:5}, {type:"normal",sigma_level:2}) = 5/2 = 2.5
  // sensitivity = 1 * 2.5 = 2.5
});
return runRss(rssInputs, 100, 3);
// stddev = sqrt(2.5²) = 2.5, delta = 3*2.5 = 7.5 → [92.5, 107.5]
```

`PropagationResult` restituito:

```typescript
{ method: "rss", min: 92.5, max: 107.5, nominalValue: 100, stddev: 2.5,
  contributingInputs: ["X_RSS"] }
// distribution: undefined ← assente per RSS (solo MC lo produce)
```

### Passo 6 — `rebuildFormulaIndexWithEngine` (`src/core/analysis.ts`)

```typescript
entry.toleranceResult = evaluated.range
  ? { ...evaluated.range, source: evaluated.range.source }
  : undefined;
```

Il `toleranceResult` di `Y_linear_rss_normal2s`:

```typescript
{ method: "rss", min: 92.5, max: 107.5, nominalValue: 100, stddev: 2.5,
  source: "propagated", contributingInputs: ["X_RSS"] }
```

### Passo 7 — `createFormulaEntry` (`src/ui/interactiveFormulaEngine.ts`)

```typescript
const range = liveRange(entry.toleranceResult, value) ?? tree.result?.range;
```

`liveRange()` verifica se il `source` è `"propagated"`, il `nominal` è non-zero, e scala.
Qui i valori coincidono con il nominal (nessun override), quindi restituisce il range invariato.

`FormulaEntry` webview:
```typescript
range: { method: "rss", min: 92.5, max: 107.5, nominalValue: 100, stddev: 2.5,
         source: "propagated"
         // distribution: undefined  ← CHIAVE
       }
```

### Passo 8 — Rendering webview — **PUNTO DI ROTTURA**

In `interactive_webview_class.html`, `renderDistributionPanel`:

```javascript
const collectRanges = (node) => {
    if (node.result && node.result.range) {
      ranges.push({ ..., range: node.result.range, isOutput: node.depth === 0 });
    }
    (node.children || []).forEach(collectRanges);
};
```

Il `node.result.range` arriva dal campo `result.range` di `FormulaTreeNode`, dichiarato in `src/ui/webview-types.ts`:

```typescript
result?: {
    value?: number; unit?: string; error?: string;
    range?: {
      min: number; max: number;
      source: 'declared' | 'propagated';
      method?: string;        // ← corretto, ma...
      nominalValue?: number;
      stddev?: number;
      distribution?: OutputDistribution;
    };
};
```

Il campo **`result.range`** include `method`, MA `collectRanges` lo usa.
Poi in `renderDistHistogram`:

```javascript
var method = range.method || 'worst_case';
```

Se `range.method` è `undefined` → fallback `'worst_case'`.

Poi il branch di rendering (`interactive_webview_class.html`, `renderDistHistogram`):

```javascript
if (method === 'rss') {
  shapeName = 'Gaussiana (RSS)'; shapeClass = 'shape-gaussian';
} else if (method === 'monte_carlo') {
  shapeName = dist ? 'Monte Carlo' : 'MC approx.'; shapeClass = 'shape-mc-approx';
} else {                                          // ← worst_case finisce qui
  shapeName = 'Uniforme'; shapeClass = 'shape-uniform';  // ← PROBLEMA #6
}
```

Perché per RSS il metodo viene perso? Perché il `node.result.range` assegnato in `buildTree` (`src/ui/interactiveFormulaEngine.ts`):

```typescript
result: {
  value: resultValue, unit: resultUnit, error: nodeErrors[0],
  range: entryRange,  // entryRange contiene method, stddev, distribution
},
```

Il tipo `FormulaTreeNode.result.range` include `method` dopo la correzione Fix #1, quindi il campo viene serializzato. **MA** — il campo `node.range` (top-level) è quello completo passato da `computeLiveRange` e non viene letto da `collectRanges`, che invece legge `node.result.range`.

Se per qualsiasi motivo `entryRange` fosse `undefined` o il campo `method` non popolato, il fallback è `'worst_case'` → label "Uniforme".

---

## FASE 5 — Analisi costruzione istogramma

**Percorso dati → istogramma** in `interactive_webview_class.html`, `renderDistHistogram`:

```javascript
if (dist && isFinite(dist.min) && /* ... */ ) {
  // Usa dati reali OutputDistribution (percentili CDF)
  // Solo presente per monte_carlo
} else {
  // Synthetic fallback: genera N campioni in JS browser con PRNG
  var samples = _distSamples(method, range.min, range.max, mu, sigma, N);
  // poi conta nei bin
}
```

Per RSS e worst_case, `range.distribution` è sempre `undefined`, quindi viene sempre usato il percorso sintetico.

Il PRNG browser (`_distPrng`) genera campioni:

```javascript
function _distSamples(method, min, max, mu, sigma, N) {
  var useGauss = (method === 'rss') || (method === 'monte_carlo' && sigma && ...);
  if (useGauss) { /* Box-Muller */ }
  else { /* uniforme */ }
}
```

Quindi per `method="rss"` con `sigma` definito, viene correttamente generata una gaussiana sintetica. Ma solo se `range.method` arriva correttamente come `"rss"`.

**Numero di bucket:**
```javascript
var BINS = isOutput ? 16 : 10;
```
Fisso. Nessuna normalizzazione per area, si usa la densità di conteggio relativa (`counts[i]/maxCnt`).

---

## FASE 6 — Analisi webview: perché compare "Uniform"

**Tracciatura del campo `method`:**

La webview riceve `FormulaEntry.range`, che viene da `FormulaTreeNode.result.range`:

In `buildTree` (`src/ui/interactiveFormulaEngine.ts`):

```typescript
const entryRange =
  options.liveRanges?.get(name) ??
  liveRange(entry?.toleranceResult, resultValue);

return {
  ...,
  result: {
    value: resultValue,
    unit: resultUnit,
    error: nodeErrors[0],
    range: entryRange,    // ← il campo result.range è set qui
  },
  range: entryRange,      // ← anche il campo top-level range
};
```

Il `FormulaTreeNode` ha due campi range distinti:
- `result.range` — usato da `renderDistributionPanel` (PUNTATORE SBAGLIATO)
- `range` (top-level) — contiene il range completo con `method`, `stddev`, `distribution`

`liveRange()` (`src/ui/interactiveFormulaEngine.ts`) preserva tutti i campi:

```typescript
return { ...toleranceResult, min: ..., max: ... };  // spread: method, stddev, distribution, nominalValue
```

Ma `node.result.range` dal tipo `FormulaTreeNode` in `webview-types.ts` ha un tipo incompleto (solo `min`, `max`, `source`, `method`, `nominalValue`, `stddev`, `distribution` — dopo Fix #1 corretto).

### Problema principale

La webview JavaScript in `renderDistributionPanel` legge `node.result.range`, che arriva serializzato tramite `JSON.stringify` dal TypeScript.

Se `node.result.range` include `method` (dopo Fix #1), allora `range.method` è `"rss"` → il rendering è corretto.

**Prima della correzione Fix #1**, il tipo era:
```typescript
range?: { min: number; max: number; source: ...; mode?: TolMode; sigma?: number; };
```

Il codice JS legge `range.method`, ma il campo si chiamava `mode` nel tipo → mismatch → `undefined` → fallback `'worst_case'` → label "Uniforme".

---

## FASE 7 — Verifica matematica caso reale

**Caso:** `X_RSS` con `distribution.normal`, `sigma_level:2`, `value:100`, `uncertainty.percent:5`.

| Parametro | Valore |
|-----------|--------|
| hw | 5 |
| σ (teorico) | hw / sl = 5/2 = 2.5 |
| Media μ | (lower+upper)/2 = 100 |
| Distribuzione teorica | N(100, 2.5²) |
| FWHM atteso | ≈ 2.35σ = 5.88 unità |
| 99.7% bounds | [100 ± 7.5] = [92.5, 107.5] |

**Risultato RSS (monteCarlo.ts → runRss):**
- `stddev = sqrt(2.5²) = 2.5`
- `delta = 3 × 2.5 = 7.5`
- Bounds: `[92.5, 107.5]` ✓

**Cosa arriva alla webview (prima delle correzioni):**

```typescript
FormulaTreeNode.result.range = {
  min: 92.5, max: 107.5,
  source: "propagated",
  method: undefined,     // ← mode vs method mismatch
  nominalValue: 100,
  stddev: 2.5,
  distribution: undefined
}
```

Di conseguenza `range.method` nel codice HTML è `undefined` → fallback `'worst_case'` → label "Uniforme" + campioni uniformi sintetici.

**Discrepanza:**
- Teoria: gaussiana centrata in 100, σ=2.5
- Visualizzato: uniforme sintetica tra i bound propagati

---

## FASE 8 — Elenco dei difetti

### Difetto #1 — Mismatch di nome campo `mode` vs `method` (CRITICO)

**Posizione:** `src/ui/webview-types.ts`, tipo `FormulaTreeNode.result.range`

**Causa:** Incongruenza di naming tra la definizione TypeScript del tipo e il codice JavaScript della webview. Il tipo usava `mode?: TolMode`, la webview legge `range.method`.

**Impatto:** `range.method` è sempre `undefined`, il fallback è sempre `'worst_case'`, la label è sempre "Uniforme" per tutti i risultati non-MC.

**Classificazione:** Errore di serializzazione + Errore UX.

**Riferimenti codice:**
```typescript
// webview-types.ts (PRIMA)
range?: { min: number; max: number; source: ...; mode?: TolMode; sigma?: number; };
// interactive_webview_class.html
var method = range.method || 'worst_case';  // ← range.method non esiste nel tipo
```

---

### Difetto #2 — `FormulaTreeNode.result.range` non trasporta campi completi (CRITICO)

**Posizione:** `src/ui/webview-types.ts`, `FormulaTreeNode.result.range`

**Causa:** Il tipo include solo `mode/sigma`, non `method/nominalValue/stddev/distribution`. Il field `range` top-level del nodo invece aveva la struttura completa.

**Impatto:** `renderDistributionPanel` raccoglie `node.result.range`, che è il campo povero. Il campo ricco (`node.range`) non viene usato.

**Classificazione:** Errore di serializzazione.

**Riferimenti codice:**
```typescript
// webview-types.ts
result?: { range?: { min, max, source, mode?, sigma? }; };  // campo povero
// ...
range?: { min, max, source, method?, nominalValue?, stddev?, distribution? };  // campo ricco
// interactive_webview_class.html
const collectRanges = (node) => {
  if (node.result && node.result.range) {   // ← usa il campo povero
    ranges.push({ ..., range: node.result.range, ... });
  }
};
```

---

### Difetto #3 — `method: "worst_case"` hardcoded per costanti dichiarate (MODERATO)

**Posizione:** `src/engine/yamlEngine.ts`, blocco "const":

```typescript
result.range = {
  ...
  method: "worst_case",  // ← hardcoded
  source: "declared",
};
```

**Causa:** Per le costanti `const` con uncertainty, il range "declared" viene creato con un method hardcoded che non riflette la distribuzione di input.

**Impatto:** Minore, perché per le costanti non si mostra il "Distribution" tab dell'output. Ma contribuisce a label errate negli input del tab.

**Classificazione:** Errore UX.

---

### Difetto #4 — `renderDistributionPanel` raccoglie `node.result.range` invece di `node.range` (CRITICO)

**Posizione:** `resources/interactive_webview_class.html`, `renderDistributionPanel`:

```javascript
const collectRanges = (node) => {
    if (node.result && node.result.range) {
      ranges.push({ ..., range: node.result.range, ... });
    }
};
```

**Causa:** `node.result.range` è il campo povero del tipo; `node.range` (top-level) contiene `method`, `stddev`, `distribution`.

**Impatto:** Non arriva mai `distribution` alla funzione di rendering, quindi il path "reale" dei dati MC non viene mai usato. L'istogramma è sempre sintetico.

**Classificazione:** Errore di visualizzazione.

---

### Difetto #5 — `computeLiveRange` sovrascrive il `toleranceResult` statico con metodo potenzialmente errato (MODERATO)

**Posizione:** `src/ui/interactiveFormulaEngine.ts`, `computeLiveRange()`:

```typescript
const method: PropagationMethod = (spec?.output?.method) ?? "worst_case";
```

**Causa:** `computeLiveRange` ri-esegue la propagazione in modo indipendente da `yamlEngine`, senza accedere al metodo configurato nell'output se la struttura `tolerance` non è disponibile nell'entry di core.

**Impatto:** Il metodo di propagazione nella `liveRange` non corrisponde a quello calcolato staticamente.

**Classificazione:** Errore statistico.

---

### Difetto #6 — Label "Uniform" hardcoded come fallback (UX)

**Posizione:** `resources/interactive_webview_class.html`, `renderDistHistogram`:

```javascript
else { shapeName = 'Uniforme'; shapeClass = 'shape-uniform'; }
```

**Causa:** `worst_case` non ha una label esplicita. Ma a causa dei difetti #1 e #4, anche RSS finisce qui.

**Classificazione:** Errore UX.

---

## FASE 9 — Piano di correzione

### Fix #1 — Allineare il campo `mode` → `method` nel tipo `FormulaTreeNode.result.range`

**File:** `src/ui/webview-types.ts`

```typescript
// PRIMA:
result?: {
  range?: { min: number; max: number; source: ...; mode?: TolMode; sigma?: number; };
};

// DOPO:
result?: {
  range?: {
    min: number; max: number;
    source: 'declared' | 'propagated';
    method?: string;        // ← rinominato da mode
    nominalValue?: number;  // ← aggiunto
    stddev?: number;        // ← aggiunto
    distribution?: OutputDistribution;  // ← aggiunto
  };
};
```

### Fix #2 — RebuildTree: propagare `method`, `stddev`, `distribution` nel passo di valutazione

**File:** `src/ui/interactiveFormulaEngine.ts`

Nel ciclo post-valutazione che aggiorna `step.range`:

```typescript
// PRIMA:
step.range = {
  min: live.min, max: live.max,
  source: live.source, method: live.method,
  nominalValue: live.nominalValue, stddev: live.stddev,
};

// DOPO:
step.range = {
  min: live.min, max: live.max,
  source: live.source, method: live.method,
  nominalValue: live.nominalValue, stddev: live.stddev,
  distribution: live.distribution,
};
```

### Fix #3 — `renderDistributionPanel`: usare `node.range` invece di `node.result.range`

**File:** `resources/interactive_webview_class.html`

```javascript
// PRIMA:
const collectRanges = (node) => {
  if (node.result && node.result.range) {
    ranges.push({ ..., range: node.result.range, ... });
  }
};

// DOPO:
const collectRanges = (node) => {
  const r = (node.range && isFinite(node.range.min)) ? node.range
          : (node.result && node.result.range && isFinite(node.result.range.min)) ? node.result.range
          : null;
  if (r && node.name) {
    ranges.push({ ..., range: r, ... });
  }
};
// Nota: node.range (campo top-level) contiene già method, stddev, distribution.
```

### Fix #4 — Rimuovere hardcode `method: "worst_case"` per costanti const

**File:** `src/engine/yamlEngine.ts`, blocco "const":

```typescript
// PRIMA:
result.range = {
  min: norm.lower, max: norm.upper,
  nominalValue: result.value,
  stddev: computeStdDev(norm, distribution),
  contributingInputs: [], method: "worst_case",
  source: "declared",
};

// DOPO:
result.range = {
  min: norm.lower, max: norm.upper,
  nominalValue: result.value,
  stddev: computeStdDev(norm, distribution),
  contributingInputs: [],
  source: "declared",
  // method rimosso: non è un metodo di propagazione, è un range dichiarato
};
```

### Fix #5 — `computeLiveRange`: preservare il method dal `toleranceResult` esistente

**File:** `src/ui/interactiveFormulaEngine.ts`, `computeLiveRange()`:

```typescript
// PRIMA:
const method: PropagationMethod = (spec?.output?.method) ?? "worst_case";

// DOPO:
const existingResult = this.state.formulaIndex.get(name)?.toleranceResult;
const method: PropagationMethod =
    (spec?.output?.method) ??
    (existingResult as any)?.method ??
    "worst_case";
```

### Fix #6 — Aggiungere label esplicita per `worst_case` nell'istogramma

**File:** `resources/interactive_webview_class.html`

```javascript
// PRIMA:
else { shapeName = 'Uniforme'; shapeClass = 'shape-uniform'; }

// DOPO:
else if (method === 'worst_case') {
  shapeName = 'Worst Case (uniforme)'; shapeClass = 'shape-uniform';
} else {
  shapeName = method || 'Uniforme'; shapeClass = 'shape-uniform';
}
```

---

## Riepilogo impatti

| Fix | Difetto corretto | Impatto atteso |
|-----|-------------------|-----------------|
| #1 | #1 (mode→method) | Il campo viene serializzato correttamente in JSON |
| #2 | — (completamento) | `step.range` include `distribution` per MC |
| #3 | #2, #4 | `collectRanges` legge il range completo con `method` |
| #4 | #3 | Elimina label "worst_case" errata per gli input |
| #5 | #5 | `computeLiveRange` preserva il metodo calcolato staticamente |
| #6 | #6 | Label corretta per worst_case invece di "Uniforme" generico |

**Risultato finale atteso per il caso `Y_linear_rss_normal2s`:**
- Badge: "Gaussiana (RSS)"
- Istogramma: gaussiano sintetico Box-Muller con σ=2.5, μ=100
- Bounds visualizzati: [92.5, 107.5] ✓