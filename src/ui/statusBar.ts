import * as vscode from "vscode";
import type { AnalysisStackUsage, YamlParseErrorInfo } from "../core/state";
import { localize } from "../utils/localize";
import type { ProgressiveAnalysisNotice } from "../utils/progressiveAnalysis";

/**
 * Colori della status bar per i diversi stati dell'estensione.
 * Utilizza i colori nativi di VSCode per compatibilità con tema chiaro/scuro.
 */
const StatusBarColors = {
  /** Colore per indicare che CalcDocs è attivo e funzionante correttamente */
  enabled: new vscode.ThemeColor("statusBarItem.prominentForeground"),
  /** Colore per indicare stati di warning: disabilitato, CPU elevata, stack usage degradato */
  warning: new vscode.ThemeColor("statusBarItem.warningForeground"),
  /** Colore per errori (es. errore di parsing YAML) */
  error: new vscode.ThemeColor("errorForeground"),
  /** Colore di default (usa il colore standard della status bar) */
  default: undefined,
} as const;

/**
 * Crea l'elemento della status bar runtime che mostra lo stato di abilitazione
 * dell'estensione e l'utilizzo delle risorse (CPU e RAM).
 * Clickando sull'icona si apre il menu rapido runtime (restart/toggle/profilo UI).
 * 
 * @param context - Contesto dell'estensione VSCode
 * @returns Elemento della status bar runtime configurato
 */
export function createRuntimeStatusBar(
  context: vscode.ExtensionContext
): vscode.StatusBarItem {
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99
  );

  statusBar.command = "calcdocs.runtimeMenu";
  statusBar.text = "$(pulse) " + localize("statusBar.runtimeInitializing");
  statusBar.tooltip = localize("statusBar.clickToOpenMenu");

  context.subscriptions.push(statusBar);

  return statusBar;
}

/**
 * Dettaglio mostrato al posto del generico "busy" quando l'analisi del
 * file attivo è entrata nel fallback progressivo per progetti enormi
 * (vedi runProgressiveCppAnalysis in extension.ts / utils/progressiveAnalysis.ts):
 * "partial" mentre si mostrano risultati ridotti in attesa che l'analisi
 * completa finisca, "truncated" quando ci si è arresi definitivamente
 * per questo giro.
 */

/**
 * Aggiorna la status bar runtime con lo stato corrente di abilitazione,
 * le statistiche di utilizzo delle risorse (CPU e RAM) e se un'analisi è
 * in corso ("working"). Cambia colore in base allo stato: enabled=verde,
 * disabled/cpu elevata=arancione.
 *
 * @param statusBar - Elemento della status bar runtime da aggiornare
 * @param enabled - True se l'estensione è attualmente abilitata
 * @param cpuPercent - Utilizzo CPU corrente in percentuale
 * @param memoryRssMb - Memoria RSS del processo in MB
 * @param cpuThreshold - Soglia CPU per mostrare warning
 * @param stackUsage - Statistiche sull'utilizzo dello stack
 * @param runtimeBackendLabel - Etichetta del backend attivo (clangd/legacy)
 * @param busy - True mentre un'analisi (foreground o background) è in corso
 * @param progressiveNotice - Se presente, sostituisce il generico "busy"
 *   con un messaggio più specifico su un fallback per progetto enorme
 */
export function updateRuntimeStatusBar(
  statusBar: vscode.StatusBarItem,
  enabled: boolean,
  cpuPercent: number,
  memoryRssMb: number,
  cpuThreshold: number,
  stackUsage: AnalysisStackUsage,
  runtimeBackendLabel?: string,
  busy?: boolean,
  progressiveNotice?: ProgressiveAnalysisNotice
): void {
  // Se l'estensione è disabilitata, mostra stato OFF: ha sempre priorità
  // visiva, anche su un eventuale "busy"/notice transitorio residuo.
  if (!enabled) {
    statusBar.text = "$(circle-slash) " + localize("statusBar.runtimeOff"); //+ backendText;
    statusBar.tooltip = localize("statusBar.clickToOpenMenu");
    statusBar.color = StatusBarColors.warning;
    return;
  }

  const cpuLabel = cpuPercent.toFixed(1);
  const memoryLabel = memoryRssMb.toFixed(0);
  const stackLabel =
    stackUsage.degraded
      ? localize("statusBar.stackUsage", stackUsage.usedDepth, stackUsage.depthLimit)
      : "";

  const backendText = runtimeBackendLabel ? `${runtimeBackendLabel}` : "No clangd.";
  const statsTooltip =
    stackUsage.degraded
      ? localize("statusBar.enabledDegradedDetails",
          cpuLabel, memoryLabel, stackLabel, cpuThreshold, stackUsage.usedDepth, stackUsage.depthLimit, stackUsage.cycleCount, stackUsage.prunedCount,
          backendText
        )
      : localize("statusBar.enabledDetails",
          cpuLabel, memoryLabel, stackLabel, cpuThreshold,
          backendText
        );

  if (progressiveNotice) {
    const elapsedSeconds = Math.round(progressiveNotice.elapsedMs / 1000);
    if (progressiveNotice.kind === "truncated") {
      statusBar.text = "$(warning) " + localize("statusBar.runtimeTruncated", elapsedSeconds);
      statusBar.tooltip = `${localize("statusBar.runtimeTruncatedTooltip", elapsedSeconds)}\n\n${statsTooltip}`;
      statusBar.color = StatusBarColors.warning;
      return;
    }
    statusBar.text = "$(sync~spin) " + localize("statusBar.runtimePartial", elapsedSeconds);
    statusBar.tooltip = `${localize("statusBar.runtimePartialTooltip")}\n\n${statsTooltip}`;
    statusBar.color = StatusBarColors.enabled;
    return;
  }

  statusBar.text = busy
    ? "$(sync~spin) " + localize("statusBar.runtimeWorking")
    : "$(pulse) " + localize("statusBar.runtimeOn");

  statusBar.tooltip = busy
    ? `${localize("statusBar.runtimeWorkingTooltip")}\n${statsTooltip}`
    : statsTooltip;

  // Colore: warning se CPU elevata o stack degradato, altrimenti enabled
  statusBar.color =
    cpuPercent >= cpuThreshold || stackUsage.degraded
      ? StatusBarColors.warning
      : StatusBarColors.enabled;
}

