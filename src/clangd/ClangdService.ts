import * as vscode from "vscode";

import { ClangdStatus } from "./ClangdClient";

export type ClangdAstNode = {
  kind: string;
  label: string;
  role?: string;
  detail?: string;
  arcana?: string;
  range?: vscode.Range;
  children: ClangdAstNode[];
};

export type ClangdAst = {
  root: ClangdAstNode;
  source: "clangd-json" | "clangd-text";
};

export interface IClangdBackend {
  isAvailable(): boolean;
  getStatus(): ClangdStatus;
  getHover(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Hover | null>;
  getDefinition(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location | null>;
  getDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]>;
  getAst(uri: vscode.Uri): Promise<ClangdAst | null>;
  stop?(): Promise<void> | void;
  dispose?(): void;
}

type HoverPayload =
  | {
      contents: unknown;
      range?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }
  | null
  | undefined;

function markupToText(contents: unknown): string {
  if (typeof contents === "string") {
    return contents;
  }

  if (!contents) {
    return "";
  }

  if (Array.isArray(contents)) {
    return contents
      .map((entry) => markupToText(entry))
      .filter((text) => text.length > 0)
      .join("\n\n");
  }

  if (typeof contents === "object") {
    const asRecord = contents as Record<string, unknown>;
    const language = typeof asRecord.language === "string" ? asRecord.language : "";
    const value = typeof asRecord.value === "string" ? asRecord.value : "";
    if (language && value) {
      return `\`\`\`${language}\n${value}\n\`\`\``;
    }

    if (value) {
      return value;
    }

    const kind = typeof asRecord.kind === "string" ? asRecord.kind : "";
    if (kind && value) {
      return value;
    }
  }

  return "";
}

export class ClangdService {
  constructor(private backend: IClangdBackend) {}

  async stop(): Promise<void> {
    const current = this.backend;
    if (current.stop) {
      await current.stop();
    }
    if (current.dispose) {
      current.dispose();
    }
  }

  async setBackend(backend: IClangdBackend): Promise<void> {
    const previous = this.backend;
    if (previous.stop) {
      try {
        await previous.stop();
      } catch {
        // ignore backend shutdown errors
      }
    }
    if (previous.dispose) {
      try {
        previous.dispose();
      } catch {
        // ignore backend dispose errors
      }
    }

    this.backend = backend;
  }

  isAvailable(): boolean {
    return this.backend.isAvailable();
  }

  getStatus(): ClangdStatus {
    return this.backend.getStatus();
  }

  getHover(uri: vscode.Uri, position: vscode.Position) {
    return this.backend.getHover(uri, position);
  }

  getDefinition(uri: vscode.Uri, position: vscode.Position) {
    return this.backend.getDefinition(uri, position);
  }

  getDocumentSymbols(uri: vscode.Uri) {
    return this.backend.getDocumentSymbols(uri);
  }

  getAst(uri: vscode.Uri) {
    return this.backend.getAst(uri);
  }
}
