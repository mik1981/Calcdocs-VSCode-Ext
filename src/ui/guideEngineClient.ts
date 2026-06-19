/**
 * guideEngineClient.ts
 * 
 * Client-side bridge between the guide_webview.html and the TS engine.
 * All calculations use computeGuideScenario() from guideModel.ts,
 * which delegates to the real engine functions (normalizeUncertainty,
 * computeStdDev, propagate, runMonteCarlo).
 * 
 * No duplicated PRNG, Box-Muller, or sampling logic here — the guide
 * HTML delegates all computation to this module via initGuideEngineClient().
 */
import type { GuideComputed } from "./guideModel";
import { computeGuideScenario } from "./guideModel";

type InputDistribution = "uniform" | "normal" | "triangular";
type FormulaKind = "linear" | "square" | "sum" | "product";
type PropagationMethod = "worst_case" | "rss" | "monte_carlo";

type ScenarioUI = {
  nominal: number;
  uncertaintyType: "percent";
  uncertaintyValue: number;
  distribution: InputDistribution;
  sigmaLevel: number;
  propagation: PropagationMethod;
  confidence: number;
  seed: number;
  samples: number;
  formulaKind: FormulaKind;
};

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}

function setText(id: string, value: string): void {
  const node = el(id);
  if (node instanceof HTMLElement) node.textContent = value;
}

function fmtNum(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '—';
  return parseFloat(v.toPrecision(digits)).toString();
}

// ── Canvas helpers ──────────────────────────────────────────────────────────

function setupCanvas(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ctx: null as null, W: 0, H: 0 };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W: rect.width, H: rect.height };
}

function getCSSVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Draw a simple PDF curve for a uniform/normal/triangular distribution */
function drawPDF(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  lower: number, upper: number,
  type: InputDistribution,
  stdDev: number,
  color: string,
  alpha = 0.8
): void {
  const nom = (lower + upper) / 2;
  const margin = 40;
  const plotW = W - 2 * margin;
  const span = upper - lower;
  const xMin = lower - span * 0.4;
  const xMax = upper + span * 0.4;
  const toX = (x: number) => margin + (x - xMin) / (xMax - xMin) * plotW;

  const N_EVAL = 200;
  let maxPDF = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= N_EVAL; i++) {
    const x = xMin + (xMax - xMin) * i / N_EVAL;
    let pdf = 0;
    if (type === 'uniform') {
      pdf = (x >= lower && x <= upper) ? 1 / (upper - lower) : 0;
    } else if (type === 'normal') {
      const mu = nom;
      pdf = Math.exp(-0.5 * ((x - mu) / stdDev) ** 2) / (stdDev * Math.sqrt(2 * Math.PI));
    } else if (type === 'triangular') {
      if (x < lower || x > upper) pdf = 0;
      else if (x < nom) pdf = 2 * (x - lower) / ((upper - lower) * (nom - lower));
      else pdf = 2 * (upper - x) / ((upper - lower) * (upper - nom));
    }
    xs.push(x); ys.push(pdf);
    if (pdf > maxPDF) maxPDF = pdf;
  }
  if (maxPDF === 0) return;

  const toY = (pdf: number) => H - margin - (pdf / maxPDF) * (H - 2 * margin);
  ctx.beginPath();
  ctx.moveTo(toX(xs[0]), toY(ys[0]));
  for (let i = 1; i <= N_EVAL; i++) ctx.lineTo(toX(xs[i]), toY(ys[i]));
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Fill under curve
  ctx.lineTo(toX(xs[N_EVAL]), H - margin);
  ctx.lineTo(toX(xs[0]), H - margin);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha * 0.18;
  ctx.fill();
  ctx.globalAlpha = 1;

  // lower/upper markers
  const fg = getCSSVar('--vscode-descriptionForeground') || '#888';
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  ctx.beginPath(); ctx.moveTo(toX(lower), H - margin); ctx.lineTo(toX(lower), margin / 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(toX(upper), H - margin); ctx.lineTo(toX(upper), margin / 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Axis
  ctx.strokeStyle = fg;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.3;
  ctx.beginPath(); ctx.moveTo(margin, H - margin); ctx.lineTo(W - margin, H - margin); ctx.stroke();
  ctx.globalAlpha = 1;

  // Labels
  ctx.font = '10px monospace';
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.globalAlpha = 0.7;
  ctx.fillText(fmtNum(lower), toX(lower), H - margin + 12);
  ctx.fillText(fmtNum(nom), toX(nom), H - margin + 12);
  ctx.fillText(fmtNum(upper), toX(upper), H - margin + 12);
  ctx.globalAlpha = 1;
}

/** Draw a range bar with min-nominal-max markers */
function drawRangeBar(
  canvas: HTMLCanvasElement,
  min: number, nominal: number, max: number,
  color?: string
): void {
  const result = setupCanvas(canvas);
  const ctx = result.ctx;
  if (!ctx) return;

  const W = result.W;
  const H = result.H;
  ctx.clearRect(0, 0, W, H);
  const margin = 16;
  const x0 = margin;
  const x1 = W - margin;
  const span = max - min || 1;
  const toX = (x: number) => x0 + ((x - min) / span) * (x1 - x0);

  const barColor = color || getCSSVar('--vscode-focusBorder') || '#007acc';

  // baseline
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, H / 2);
  ctx.lineTo(x1, H / 2);
  ctx.stroke();

  // filled range
  ctx.fillStyle = barColor;
  ctx.globalAlpha = 0.15;
  ctx.fillRect(toX(min), H / 2 - 6, Math.max(0, toX(max) - toX(min)), 12);
  ctx.globalAlpha = 1;

  // nominal marker
  ctx.strokeStyle = barColor;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(toX(nominal), H / 2 - 10);
  ctx.lineTo(toX(nominal), H / 2 + 10);
  ctx.stroke();
}

// ── Scenario selection helpers ─────────────────────────────────────────────

function readDistUI(): ScenarioUI {
  return {
    nominal: +((el("sl-nominal") as HTMLInputElement).value),
    uncertaintyType: "percent",
    uncertaintyValue: +((el("sl-hw") as HTMLInputElement).value),
    distribution: (el("dist-type") as HTMLSelectElement).value as InputDistribution,
    sigmaLevel: +((el("sl-sigma") as HTMLInputElement).value),
    propagation: (el("dist-prop") as HTMLSelectElement).value as PropagationMethod,
    confidence: 95,
    seed: 42,
    samples: 5000,
    formulaKind: (el("dist-formula") as HTMLSelectElement).value as FormulaKind,
  };
}

function readMCUI(): ScenarioUI {
  return {
    nominal: 100,
    uncertaintyType: "percent",
    uncertaintyValue: +((el("mc-hw") as HTMLInputElement).value),
    distribution: (el("mc-dist") as HTMLSelectElement).value as InputDistribution,
    sigmaLevel: 3,
    propagation: "monte_carlo",
    confidence: +((el("mc-confidence") as HTMLInputElement).value),
    seed: +((el("mc-seed") as HTMLInputElement).value),
    samples: 2000,
    formulaKind: (el("mc-formula") as HTMLSelectElement).value as FormulaKind,
  };
}

function readCmpUI(): { hw: number; sl: number } {
  return {
    hw: +((el("cmp-hw") as HTMLInputElement).value),
    sl: +((el("cmp-sl") as HTMLInputElement).value),
  };
}

// ── Redraw functions ──────────────────────────────────────────────────────

function redrawDistCanvas(): void {
  const s = readDistUI();
  const hw = s.nominal * s.uncertaintyValue / 100;
  
  // Show/hide sigma_level row
  const rowSl = document.getElementById("row-sl");
  if (rowSl) {
    rowSl.style.display = s.distribution === "normal" ? "flex" : "none";
  }

  // Update display values
  setText("disp-nominal", fmtNum(s.nominal));
  setText("disp-hw", s.uncertaintyValue.toFixed(1) + "%");
  setText("disp-sigma", String(s.sigmaLevel));

  // Delegate computation to the engine via computeGuideScenario
  const computed: GuideComputed = computeGuideScenario({
    nominal: s.nominal,
    uncertainty: { type: "percent", value: s.uncertaintyValue },
    distribution: {
      type: s.distribution === "normal" ? "normal" : s.distribution === "triangular" ? "triangular" : "uniform",
      sigma_level: s.distribution === "normal" ? s.sigmaLevel : undefined,
    },
    propagation: s.propagation,
    confidence: s.confidence,
    seed: s.seed,
    samples: s.samples,
    formulaKind: s.formulaKind,
  });

  // Draw PDF of the input distribution (uses the input bounds)
  const canvas = document.getElementById("dist-canvas") as HTMLCanvasElement;
  const result = setupCanvas(canvas);
  if (result.ctx) {
    result.ctx.clearRect(0, 0, result.W, result.H);
    const lower = computed.nominal - hw;
    const upper = computed.nominal + hw;
    const distColor = 
      s.distribution === "uniform"     ? getCSSVar('--col-uni') || '#569cd6' :
      s.distribution === "normal"      ? getCSSVar('--col-norm') || '#c88b3a' :
                                          getCSSVar('--col-tri') || '#2aabb8';
    const stdDev = s.distribution === "normal" ? hw / s.sigmaLevel :
                   s.distribution === "uniform" ? hw / Math.sqrt(3) :
                   hw / Math.sqrt(6);
    drawPDF(result.ctx, result.W, result.H, lower, upper, s.distribution, stdDev, distColor);
  }

  // Update stats
  const stats = document.getElementById("dist-stats");
  if (stats) {
    const delta = computed.nominal - computed.range.min;
    const pct = s.nominal !== 0 ? (delta / s.nominal * 100).toFixed(2) : "—";
    stats.innerHTML =
      `<span class="dist-stat-item">Range = <strong>[${fmtNum(computed.range.min)}, ${fmtNum(computed.range.max)}]</strong></span>` +
      `<span class="dist-stat-item">Metodo = <strong>${computed.method}</strong></span>` +
      `<span class="dist-stat-item">±<strong>${pct}%</strong></span>` +
      (computed.stddev !== undefined
        ? `<span class="dist-stat-item">σ = <strong>${fmtNum(computed.stddev)}</strong></span>`
        : ``);
  }
}

function redrawMCCanvas(): void {
  const s = readMCUI();
  setText("mc-hw-disp", s.uncertaintyValue.toFixed(1) + "%");
  setText("mc-confidence-disp", s.confidence.toFixed(1) + "%");
  setText("mc-seed-disp", String(s.seed));

  // Delegate to engine via computeGuideScenario
  const computed = computeGuideScenario({
    nominal: s.nominal,
    uncertainty: { type: "percent", value: s.uncertaintyValue },
    distribution: {
      type: s.distribution === "normal" ? "normal" : s.distribution === "triangular" ? "triangular" : "uniform",
      sigma_level: s.distribution === "normal" ? s.sigmaLevel : undefined,
    },
    propagation: s.propagation,
    confidence: s.confidence,
    seed: s.seed,
    samples: s.samples,
    formulaKind: s.formulaKind,
  });

  const canvas = document.getElementById("mc-canvas") as HTMLCanvasElement;
  drawRangeBar(canvas, computed.range.min, computed.nominal, computed.range.max, "#9d6de0");

  // Update stats from computed distribution
  const stats = document.getElementById("mc-stats");
  if (stats) {
    const d = computed.distribution;
    if (d) {
      stats.innerHTML =
        `<span class="dist-stat-item">N = <strong>${d.samples}</strong></span>` +
        `<span class="dist-stat-item">mean = <strong>${fmtNum(d.mean)}</strong></span>` +
        `<span class="dist-stat-item">σ = <strong>${fmtNum(d.stddev)}</strong></span>` +
        `<span class="dist-stat-item">p2.5 = <strong>${fmtNum(d.p025)}</strong></span>` +
        `<span class="dist-stat-item">p97.5 = <strong>${fmtNum(d.p975)}</strong></span>` +
        `<span class="dist-stat-item">metodo = <strong>${computed.method}</strong></span>`;
    } else {
      stats.innerHTML =
        `<span class="dist-stat-item">Range = [<strong>${fmtNum(computed.range.min)}, ${fmtNum(computed.range.max)}</strong>]</span>` +
        `<span class="dist-stat-item">metodo = <strong>${computed.method}</strong></span>`;
    }
  }
}

function redrawCmpCanvas(): void {
  const { hw, sl } = readCmpUI();
  setText("cmp-hw-disp", String(hw));
  setText("cmp-sl-disp", String(sl));

  const nominal = 100;
  const lower = nominal - hw;
  const upper = nominal + hw;
  const sigmaU = hw / Math.sqrt(3);
  const sigmaN = hw / sl;
  const sigmaT = hw / Math.sqrt(6);

  const canvas = document.getElementById("cmp-canvas") as HTMLCanvasElement;
  const result = setupCanvas(canvas);
  if (result.ctx) {
    result.ctx.clearRect(0, 0, result.W, result.H);
    drawPDF(result.ctx, result.W, result.H, lower, upper, "uniform", sigmaU, getCSSVar('--col-uni') || '#569cd6', 0.9);
    drawPDF(result.ctx, result.W, result.H, lower, upper, "normal", sigmaN, getCSSVar('--col-norm') || '#c88b3a', 0.9);
    drawPDF(result.ctx, result.W, result.H, lower, upper, "triangular", sigmaT, getCSSVar('--col-tri') || '#2aabb8', 0.9);
  }

  const fn = (v: number) => fmtNum(v, 4);
  const rows: Array<{id: string; s: number; r: number; d: number}> = [
    {id: 'cmp-row-u', s: sigmaU, r: sigmaU / hw, d: 3 * sigmaU},
    {id: 'cmp-row-n', s: sigmaN, r: sigmaN / hw, d: 3 * sigmaN},
    {id: 'cmp-row-t', s: sigmaT, r: sigmaT / hw, d: 3 * sigmaT},
  ];
  rows.forEach(({id, s, r, d}) => {
    const row = document.getElementById(id);
    if (row && row instanceof HTMLTableRowElement && row.cells.length >= 4) {
      row.cells[1].textContent = fn(s);
      row.cells[3].textContent = '±' + fn(d);
    }
  });
}

function redrawAll(): void {
  redrawDistCanvas();
  redrawMCCanvas();
  redrawCmpCanvas();
}

// ── Binding ────────────────────────────────────────────────────────────────

function bind(): void {
  const elements: Record<string, () => void> = {
    "dist-type": redrawDistCanvas,
    "dist-formula": redrawDistCanvas,
    "sl-nominal": redrawDistCanvas,
    "sl-hw": redrawDistCanvas,
    "sl-sigma": redrawDistCanvas,
    "dist-prop": redrawDistCanvas,
    "mc-hw": redrawMCCanvas,
    "mc-confidence": redrawMCCanvas,
    "mc-seed": redrawMCCanvas,
    "mc-dist": redrawMCCanvas,
    "mc-formula": redrawMCCanvas,
    "cmp-hw": redrawCmpCanvas,
    "cmp-sl": redrawCmpCanvas,
  };

  for (const [id, handler] of Object.entries(elements)) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.addEventListener("input", handler);
    node.addEventListener("change", handler);
  }

  // Resize observer for canvas redraws
  const content = document.querySelector('.content');
  if (content) {
    const ro = new ResizeObserver(() => redrawAll());
    ro.observe(content);
  }
}

export function initGuideEngineClient(): void {
  bind();
  redrawAll();
}