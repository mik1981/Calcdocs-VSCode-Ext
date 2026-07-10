import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { applyCppSymbols } from "../../src/core/analysis";
import { collectCppCodeLensItems } from "../../src/core/cppCodeLensItems";
import { collectDefinesAndConsts } from "../../src/core/cppParser";
import { createCalcDocsState } from "../../src/core/state";
import { createColoredOutput } from "../../src/utils/output";

function createMockDocument(filePath: string, text: string): any {
  const lines = text.split(/\r?\n/);
  return {
    uri: { scheme: "file", fsPath: filePath },
    languageId: "c",
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    positionAt: (offset: number) => {
      let line = 0;
      let char = 0;
      let current = 0;
      for (const lineText of lines) {
        const next = current + lineText.length + 1;
        if (offset < next) {
          char = offset - current;
          break;
        }
        line += 1;
        current = next;
      }
      return { line, character: char };
    },
    getText: () => text,
  };
}

describe("header-included enum ghost value resolution", () => {
  it("collects enum members from a header file passed directly as an analysis entry", async () => {
    const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "calcdocs-header-enum-"));

    try {
      const headerPath = path.join(workspaceRoot, "app_errors.h");
      await fsp.writeFile(
        headerPath,
        [
          "typedef enum {",
          "  APP_ERR_NONE = 0,",
          "  APP_ERR_MOSFET_HOT = 21",
          "} app_error_t;",
          "",
        ].join("\n"),
        "utf8"
      );

      const symbols = await collectDefinesAndConsts([headerPath], workspaceRoot, {
        resolveIncludes: true,
      });

      expect(symbols.consts.get("APP_ERR_MOSFET_HOT")).toBe(21);
    } finally {
      await fsp.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("resolves enum members from included headers for current-file ghost values", async () => {
    const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "calcdocs-header-enum-"));

    try {
      const sourcePath = path.join(workspaceRoot, "src", "file.c");
      await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
      await fsp.writeFile(
        path.join(workspaceRoot, "src", "app_errors.h"),
        [
          "typedef enum {",
          "  APP_ERR_NONE = 0,",
          "  APP_ERR_MOSFET_HOT = 21",
          "} app_error_t;",
          "",
        ].join("\n"),
        "utf8"
      );
      await fsp.writeFile(
        sourcePath,
        [
          '#include "app_errors.h"',
          "",
          "typedef struct {",
          "  app_error_t active_app_error;",
          "} safety_t;",
          "",
          "safety_t g_safety;",
          "g_safety.active_app_error = APP_ERR_MOSFET_HOT;",
          "",
        ].join("\n"),
        "utf8"
      );

      const symbols = await collectDefinesAndConsts([sourcePath], workspaceRoot, {
        resolveIncludes: true,
      });

      expect(symbols.consts.get("APP_ERR_MOSFET_HOT")).toBe(21);

      const state = createCalcDocsState(workspaceRoot, createColoredOutput({
        appendLine: () => undefined,
        append: () => undefined,
        replace: () => undefined,
        clear: () => undefined,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
        name: "",
      } as any));

      applyCppSymbols(state, symbols, {
        resetSymbolValues: true,
        applyConstsBeforeResolve: false,
        requireFiniteResolvedValues: true,
        symbolResolutionStats: { usedDepth: 0, depthLimit: 0, cycleCount: 0, prunedCount: 0, degraded: false },
      } as any);

      expect(state.symbolValues.get("APP_ERR_MOSFET_HOT")).toBe(21);

      const document = createMockDocument(sourcePath, [
        '#include "app_errors.h"',
        "",
        "typedef struct {",
        "  app_error_t active_app_error;",
        "} safety_t;",
        "",
        "safety_t g_safety;",
        "g_safety.active_app_error = APP_ERR_MOSFET_HOT;",
        "",
      ].join("\n"));

      const items = collectCppCodeLensItems(document, state, 10);
      const resolvedItem = items.find(
        (item: any) => item.kind === "resolvedValue" && item.title.includes("g_safety.active_app_error")
      );

      expect(resolvedItem).toBeDefined();
      expect(resolvedItem?.title).toContain("21");
    } finally {
      await fsp.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
