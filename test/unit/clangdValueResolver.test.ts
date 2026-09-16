import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClangdService, type IClangdBackend } from "../../src/clangd/ClangdService";
import { runActiveCppFileAnalysis } from "../../src/core/analysis";
import { createCalcDocsState, type CalcDocsState } from "../../src/core/state";
import { ColoredOutput } from "../../src/utils/output";

function fakeOutputChannel() {
  return {
    appendLine: () => undefined,
    append: () => undefined,
    replace: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    clear: () => undefined,
    dispose: () => undefined,
    name: "test",
  } as unknown as vscode.OutputChannel;
}

function makeState(workspaceRoot: string): CalcDocsState {
  return createCalcDocsState(workspaceRoot, new ColoredOutput(fakeOutputChannel()));
}

class FakeClangdBackend implements IClangdBackend {
  constructor(
    private readonly configured: boolean,
    private readonly resolveHoverText: (lineText: string) => string | null
  ) {}

  isAvailable(): boolean {
    return true;
  }

  getStatus() {
    return {
      available: true,
      hasCompileCommands: this.configured,
      indexing: false,
    };
  }

  async getHover(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Hover | null> {
    const text = await fsp.readFile(uri.fsPath, "utf8");
    const lineText = text.split(/\r?\n/)[position.line] ?? "";
    const hoverText = this.resolveHoverText(lineText);
    return hoverText ? new vscode.Hover(new vscode.MarkdownString(hoverText)) : null;
  }

  async getDefinition(): Promise<vscode.Location | null> {
    return null;
  }

  async getDocumentSymbols(): Promise<vscode.DocumentSymbol[]> {
    return [];
  }

  async getAst() {
    return null;
  }
}

describe("clangd value resolution", () => {
  let workspaceRoot: string;
  let state: CalcDocsState;

  beforeEach(async () => {
    workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "calcdocs-clangd-values-"));
    state = makeState(workspaceRoot);
  });

  afterEach(async () => {
    await fsp.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("uses clangd as the primary source for active conditional defines", async () => {
    const sourcePath = path.join(workspaceRoot, "main.c");
    await fsp.writeFile(
      sourcePath,
      [
        "#ifdef BOARD_A",
        "#define SELECTED 10",
        "#else",
        "#define SELECTED 20",
        "#endif",
        "#define DERIVED (SELECTED + 1)",
        "",
      ].join("\n"),
      "utf8"
    );

    const clangd = new ClangdService(
      new FakeClangdBackend(true, (lineText) => {
        if (lineText.includes("#define SELECTED 10")) {
          return "```c\n#define SELECTED 10\n```";
        }
        if (lineText.includes("#define DERIVED")) {
          return "```c\n#define DERIVED (SELECTED + 1)\n```";
        }
        return null;
      })
    );

    await runActiveCppFileAnalysis(state, sourcePath, clangd);

    expect(state.symbolValues.get("SELECTED")).toBe(10);
    expect(state.symbolValues.get("DERIVED")).toBe(11);
    expect(state.symbolAmbiguityRoots.has("SELECTED")).toBe(false);
  });

  it("keeps the legacy parser fallback when clangd is not correctly configured", async () => {
    const sourcePath = path.join(workspaceRoot, "main.c");
    await fsp.writeFile(
      sourcePath,
      [
        "#ifdef BOARD_A",
        "#define SELECTED 10",
        "#else",
        "#define SELECTED 20",
        "#endif",
        "#define DERIVED (SELECTED + 1)",
        "",
      ].join("\n"),
      "utf8"
    );

    const clangd = new ClangdService(
      new FakeClangdBackend(false, (lineText) =>
        lineText.includes("#define SELECTED 10")
          ? "```c\n#define SELECTED 10\n```"
          : null
      )
    );

    await runActiveCppFileAnalysis(state, sourcePath, clangd);

    expect(state.symbolValues.get("SELECTED")).toBe(20);
    expect(state.symbolValues.get("DERIVED")).toBe(21);
  });

  it("uses clangd values for enum members when the parser cannot fold the initializer", async () => {
    const sourcePath = path.join(workspaceRoot, "main.c");
    await fsp.writeFile(
      sourcePath,
      [
        "enum Mode {",
        "  MODE_BASE = 3,",
        "  MODE_ACTIVE = MODE_BASE + 4,",
        "};",
        "",
      ].join("\n"),
      "utf8"
    );

    const clangd = new ClangdService(
      new FakeClangdBackend(true, (lineText) => {
        // Match on the identifier actually being *defined* on this line
        // (leading token), not merely referenced somewhere in it -- the
        // MODE_ACTIVE line also contains the substring "MODE_BASE" as part
        // of its initializer expression, so a plain `.includes()` check
        // here would misidentify which symbol is being hovered.
        const trimmed = lineText.trim();
        if (/^MODE_BASE\b/.test(trimmed)) {
          return "```c\nMODE_BASE = 3\n```";
        }
        if (/^MODE_ACTIVE\b/.test(trimmed)) {
          return "```c\nMODE_ACTIVE = 7\n```";
        }
        return null;
      })
    );

    await runActiveCppFileAnalysis(state, sourcePath, clangd);

    expect(state.symbolValues.get("MODE_BASE")).toBe(3);
    expect(state.symbolValues.get("MODE_ACTIVE")).toBe(7);
  });

  it("stops querying clangd immediately once isCancelled() becomes true, instead of working through the whole candidate list", async () => {
    // Regressione: un'analisi abbandonata (troncata dal fallback
    // progressivo, o superata da un trigger più recente) continuava a
    // interrogare clangd per OGNI candidato rimanente invece di fermarsi
    // subito, intasando la coda condivisa di clangd - compresa la
    // richiesta di hover REALE dell'utente, che finiva dietro decine di
    // richieste ormai inutili emesse da un'analisi già abbandonata.
    const sourcePath = path.join(workspaceRoot, "main.c");
    await fsp.writeFile(
      sourcePath,
      ["#define A 1", "#define B 2", "#define C 3", "#define D 4", "#define E 5", ""].join("\n"),
      "utf8"
    );

    let hoverCalls = 0;
    const clangd = new ClangdService(
      new FakeClangdBackend(true, (lineText) => {
        hoverCalls += 1;
        const match = lineText.match(/^#define (\w+) (\d+)/);
        return match ? `\`\`\`c\n#define ${match[1]} ${match[2]}\n\`\`\`` : null;
      })
    );

    // Si "cancella" subito dopo la primissima richiesta hover, come farebbe
    // un token superato o rinunciato a metà del ciclo.
    const isCancelled = () => hoverCalls >= 1;

    await runActiveCppFileAnalysis(state, sourcePath, clangd, "full", isCancelled);

    expect(hoverCalls).toBe(1);
  });

  it("skips clangd augmentation entirely if isCancelled() is already true before starting", async () => {
    const sourcePath = path.join(workspaceRoot, "main.c");
    await fsp.writeFile(sourcePath, "#define A 1\n", "utf8");

    let hoverCalls = 0;
    const clangd = new ClangdService(
      new FakeClangdBackend(true, () => {
        hoverCalls += 1;
        return "```c\n#define A 1\n```";
      })
    );

    await runActiveCppFileAnalysis(state, sourcePath, clangd, "full", () => true);

    expect(hoverCalls).toBe(0);
  });
});
