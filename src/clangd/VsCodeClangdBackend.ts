import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type { ClangdStatus } from "./ClangdClient";
import type { ClangdAst, IClangdBackend } from "./ClangdService";

const COMPILE_COMMANDS_FILE = "compile_commands.json";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findCompileCommandsInWorkspace(): Promise<boolean> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return false;
  }

  const candidates = [
    path.join(workspaceRoot, COMPILE_COMMANDS_FILE),
    path.join(workspaceRoot, "build", COMPILE_COMMANDS_FILE),
    path.join(workspaceRoot, "out", COMPILE_COMMANDS_FILE),
    path.join(workspaceRoot, ".vscode", COMPILE_COMMANDS_FILE),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return true;
    }
  }

  return false;
}

function hoverText(hover: vscode.Hover): string {
  return hover.contents
    .map((content) => {
      if (typeof content === "string") {
        return content;
      }

      if (content instanceof vscode.MarkdownString) {
        return content.value;
      }

      if (content && typeof content === "object" && "value" in content) {
        const value = (content as { value?: unknown }).value;
        return typeof value === "string" ? value : "";
      }

      return "";
    })
    .join("\n");
}

function isCalcDocsHover(hover: vscode.Hover): boolean {
  return hoverText(hover).toLowerCase().includes("calcdocs");
}

export class VsCodeClangdBackend implements IClangdBackend {
  private indexing = false;
  private hasCompileCommands = false;
  private hoverRequestInFlight = false;
  private disposable?: vscode.Disposable;

  async initialize(): Promise<void> {
    this.hasCompileCommands = await findCompileCommandsInWorkspace();

    // Intercetta index progress (clangd lo pubblica come progress LSP).
    this.disposable = vscode.window.onDidChangeWindowState(() => {
      // noop, serve solo a forzare activation timing-safe
    });

    vscode.languages.onDidChangeDiagnostics(() => {
      // Activity heuristic: presenza di attivita = indicizzazione.
      this.indexing = true;
      setTimeout(() => (this.indexing = false), 800);
    });
  }

  dispose(): void {
    this.disposable?.dispose();
  }

  isAvailable(): boolean {
    return true;
  }

  getStatus(): ClangdStatus {
    return {
      available: true,
      hasCompileCommands: this.hasCompileCommands,
      indexing: this.indexing,
    };
  }

  async getHover(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Hover | null> {
    if (this.hoverRequestInFlight) {
      return null;
    }

    this.hoverRequestInFlight = true;
    try {
      const result = await vscode.commands.executeCommand<vscode.Hover[] | vscode.Hover>(
        "vscode.executeHoverProvider",
        uri,
        position
      );
      const hovers = Array.isArray(result) ? result : result ? [result] : [];
      return hovers.find((hover) => !isCalcDocsHover(hover)) ?? null;
    } catch {
      return null;
    } finally {
      this.hoverRequestInFlight = false;
    }
  }

  async getDefinition(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location | null> {
    const res = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeDefinitionProvider",
      uri,
      position
    );
    return res?.[0] ?? null;
  }

  async getDocumentSymbols(uri: vscode.Uri) {
    return (
      (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri
      )) ?? []
    );
  }

  async getAst(_uri: vscode.Uri): Promise<ClangdAst | null> {
    // VSCode command API currently exposes symbols/hover/definition, but not
    // clangd's custom textDocument/ast request.
    return null;
  }
}
