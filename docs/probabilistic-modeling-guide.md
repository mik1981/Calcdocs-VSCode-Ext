# Probabilistic Modeling Guide

Questa guida spiega come usare il modello probabilistico di CalcDocs e come interpretare correttamente la webview di distribuzione.

## 1. Cosa rappresenta la webview

La webview non mostra una misura reale. Mostra una stima ottenuta dal modello dichiarato negli input.

- `Nominal value`: il valore centrale dichiarato nel YAML.
- `Output distribution`: la forma approssimativa della distribuzione simulata.
- `Tolerance interval`: l’intervallo finale calcolato dal motore.

### Attenzione

La distribuzione mostrata rappresenta la popolazione Monte Carlo simulata.

Non rappresenta:

- una misura reale.
- una distribuzione certificata.
- una garanzia fisica.

È una stima ottenuta dal modello dichiarato negli input.

> Quando vedi una gaussiana nella webview, non significa che il sistema “garantisce” una gaussiana.

## 2. Quando usare `uniform`

### Sintassi tipica

```yaml
R1:
  value: 1000
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: uniform
```

### Significato fisico

Uniform significa che il costruttore garantisce solamente che il valore sia compreso entro il limite.

Questo modello è adatto quando la specifica è:

- un componente discreto con tolleranza dati foglio caratteristica,
- un condensatore con classe di tolleranza,
- una resistenza con tolleranza ±x%,
- un induttore con range garantito.

### Quando usare

- resistenze
- condensatori
- induttori
- componenti discreti con tolleranza datasheet

## 3. Quando NON usare `uniform`

Errore tipico:

```yaml
temperature:
  distribution:
    type: uniform
```

Non usare uniform quando la variabilità deriva da:

- un processo fisico,
- rumore,
- misura,
- segnali statistici reali.

In questi casi è preferibile usare `normal`.

## 4. Quando usare `normal`

### Esempi

- errori di misura,
- rumore ADC,
- rumore sensori,
- variabili ottenute da molte sorgenti indipendenti.

### Sintassi

```yaml
TEMP_SENSOR:
  value: 25.0
  uncertainty:
    type: percent
    value: 1
  distribution:
    type: normal
    sigma_level: 2
```

### Significato fisico

Normal è un modello per distribuzioni che si avvicinano a una curva a campana. È utile quando il valore è generato da molti contributi indipendenti o da un processo di misura con errore statistico.

## 5. Quando NON usare `normal`

Caso molto comune:

```yaml
R1:
  value: 1000
  tol: 5%
  distribution:
    type: normal
```

Questo è discutibile perché:

- il costruttore non dichiara sigma,
- dichiara limiti (`tol`, `min`, `max`) ma non una densità.

Se il dato è davvero una tolleranza dati foglio, `uniform` è spesso più corretto.

> La forma della distribuzione non è un dettaglio secondario: è parte del modello.

## 6. Quando usare `triangular`

Usa `triangular` quando il valore nominale è più probabile degli estremi.

Esempi:

- trimmer,
- potenziometro,
- taratura manuale,
- variabili con un valore centrale preferenziale.

### Sintassi

```yaml
TRIMMER:
  value: 50
  uncertainty:
    type: percent
    value: 10
  distribution:
    type: triangular
```

## 7. RSS vs MonteCarlo

| Caso | RSS | MonteCarlo |
|------|-----|------------|
| Lineare | Ottimo | Ottimo |
| Debolmente non lineare | Buono | Ottimo |
| Molto non lineare | Scarso | Ottimo |
| Distribuzioni miste | Scarso | Ottimo |
| Performance | Migliore | Peggiore |

### Regola pratica

Per nuovi progetti usare `monte_carlo` quando la formula è non lineare, quando ci sono distribuzioni miste o quando vuoi rappresentare la forma reale della distribuzione.

### Quando `rss` rimane utile

- formule quasi lineari,
- quando serve una stima rapida,
- per confronti veloci su catene di propagazione semplici.

## 8. Casi limite

Un buon modo per capire la webview è guardare esempi controintuitivi.

### Caso 1 — distribuzione uniforme + quadrato

```yaml
A:
  value: 100
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: uniform

Y:
  formula: A * A
  propagation: monte_carlo
```

Output: input uniforme, output non uniforme.

### Caso 2 — somma di uniformi

```yaml
A:
  value: 100
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: uniform

B:
  value: 100
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: uniform

Y:
  formula: A + B
  propagation: monte_carlo
```

Output: distribuzione trapezoidale/triangolare.

### Caso 3 — prodotto

```yaml
A:
  value: 100
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: uniform

B:
  value: 50
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: uniform

Y:
  formula: A * B
  propagation: monte_carlo
```

Output: forte distorsione della forma.

### Caso 4 — divisione con denominatore vicino a zero

```yaml
A:
  value: 1
  uncertainty:
    type: percent
    value: 10
  distribution:
    type: uniform

B:
  value: 0.1
  min: 0.01
  max: 0.19
  distribution:
    type: uniform

Y:
  formula: A / B
  propagation: monte_carlo
```

Output: code molto lunghe e forte asimmetria.

### Caso 5 — distribuzioni miste

```yaml
A:
  value: 100
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: normal
    sigma_level: 2

B:
  value: 100
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: uniform

C:
  value: 100
  uncertainty:
    type: percent
    value: 5
  distribution:
    type: triangular

Y:
  formula: A + B + C
  propagation: monte_carlo
```

Output: forma mista che riflette i tre contributi.

> Vedi anche `examples/cases/21_probabilistic_edge_cases` per casi pratici e contro-intuitivi.

## 9. Interpretazione corretta dell’istogramma

L’istogramma serve a visualizzare la forma approssimativa della distribuzione simulata.

Non usare il numero di barre come informazione statistica.

Per le verifiche progettuali utilizza:

- `min`
- `max`
- `mean`
- `stddev`
- percentili

### Nota importante

L’istogramma è un supporto visivo. La verifica dei requisiti deve basarsi sui dati numerici calcolati dal motore, non solo sulla forma grafica.
