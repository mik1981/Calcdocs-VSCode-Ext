/**
 * guideWebviewProvider.ts
 *
 * Provider per la guida interattiva CalcDocs.
 * Espone un WebviewViewProvider che si registra come vista nell'Explorer di VS Code.
 *
 * Registrazione in extension.ts:
 *
 *   import { GuideWebviewProvider } from "./ui/guideWebviewProvider";
 *
 *   // In activate():
 *   const guideProvider = new GuideWebviewProvider(context.extensionUri);
 *   context.subscriptions.push(
 *     vscode.window.registerWebviewViewProvider(
 *       GuideWebviewProvider.VIEW_ID,
 *       guideProvider,
 *       { webviewOptions: { retainContextWhenHidden: true } }
 *     )
 *   );
 *
 * In package.json aggiungere:
 *
 *   "contributes": {
 *     "viewsContainers": {
 *       "activitybar": [
 *         {
 *           "id": "calcdocs-guide-container",
 *           "title": "CalcDocs Guide",
 *           "icon": "resources/guide_icon.svg"
 *         }
 *       ]
 *     },
 *     "views": {
 *       "calcdocs-guide-container": [
 *         {
 *           "type": "webview",
 *           "id": "calcdocs.guideView",
 *           "name": "CalcDocs Guide",
 *           "icon": "resources/guide_icon.svg"
 *         }
 *       ]
 *     }
 *   }
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export class GuideWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly VIEW_ID = "calcdocs.guideView";

  private _view?: vscode.WebviewView;
  private readonly _extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this._extensionUri = extensionUri;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, "resources"),
      ],
    };

    webviewView.webview.html = this._getHtmlContent(webviewView.webview);

    // Gestione messaggi dalla webview (navigazione sezioni, ecc.)
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "openExternal":
          vscode.env.openExternal(vscode.Uri.parse(message.url));
          break;
        case "openFile":
          vscode.commands.executeCommand(
            "vscode.open",
            vscode.Uri.file(message.path)
          );
          break;
      }
    });
  }

  /**
   * Apre la guida come pannello standalone (finestra separata dalla sidebar).
   * Usa questo comando per aprire la guida in modalità full-screen.
   */
  public static openAsPanel(context: vscode.ExtensionContext): void {
    const panel = vscode.window.createWebviewPanel(
      "calcdocs.guideFull",
      "CalcDocs — Guida Interattiva",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "resources"),
        ],
      }
    );

    panel.webview.html = GuideWebviewProvider._buildHtml(
      panel.webview,
      context.extensionUri
    );
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    return GuideWebviewProvider._buildHtml(webview, this._extensionUri);
  }

  private static _buildHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri
  ): string {
    // Carica il template HTML
    const htmlPath = vscode.Uri.joinPath(
      extensionUri,
      "resources",
      "guide_webview.html"
    );

    let html: string;
    try {
      html = fs.readFileSync(htmlPath.fsPath, "utf-8");
    } catch {
      // Fallback inline se il file non esiste ancora
      html = GuideWebviewProvider._fallbackHtml();
    }

    // Genera un nonce per la CSP
    const nonce = GuideWebviewProvider._generateNonce();

    // Sostituisce i placeholder
    html = html
      .replace(/PLACEHOLDER_NONCE/g, nonce)
      .replace(/PLACEHOLDER_CSP_SOURCE/g, webview.cspSource);

    return html;
  }

  private static _generateNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private static _fallbackHtml(): string {
    return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-PLACEHOLDER_NONCE';">
<title>CalcDocs Guide</title>
<style>body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }</style>
</head>
<body>
<h2>CalcDocs Guide</h2>
<p>Il file <code>resources/guide_webview.html</code> non è stato trovato.</p>
<p>Assicurarsi che sia incluso nel bundle dell'estensione.</p>
</body>
</html>`;
  }
}

/**
 * Snippet di registrazione da aggiungere in extension.ts:
 *
 * ─── Nel metodo activate() ────────────────────────────────────────────────────
 *
 * // Registra la guida interattiva nella Activity Bar
 * const guideProvider = new GuideWebviewProvider(context.extensionUri);
 * context.subscriptions.push(
 *   vscode.window.registerWebviewViewProvider(
 *     GuideWebviewProvider.VIEW_ID,
 *     guideProvider,
 *     { webviewOptions: { retainContextWhenHidden: true } }
 *   )
 * );
 *
 * // Comando opzionale per aprire la guida come pannello standalone
 * context.subscriptions.push(
 *   vscode.commands.registerCommand("calcdocs.openGuide", () => {
 *     GuideWebviewProvider.openAsPanel(context);
 *   })
 * );
 *
 * ─── package.json ─────────────────────────────────────────────────────────────
 *
 * Aggiungere in "contributes":
 *
 * "viewsContainers": {
 *   "activitybar": [{
 *     "id": "calcdocs-guide-container",
 *     "title": "CalcDocs Guide",
 *     "icon": "resources/guide_icon.svg"
 *   }]
 * },
 * "views": {
 *   "calcdocs-guide-container": [{
 *     "type": "webview",
 *     "id": "calcdocs.guideView",
 *     "name": "CalcDocs Guide"
 *   }]
 * },
 * "commands": [{
 *   "command": "calcdocs.openGuide",
 *   "title": "CalcDocs: Open Interactive Guide",
 *   "icon": "$(question)"
 * }]
 */
