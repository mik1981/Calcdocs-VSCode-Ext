import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listFilesRecursive } from "../../src/core/files";
import { createCalcDocsState, type CalcDocsState } from "../../src/core/state";
import { ColoredOutput } from "../../src/utils/output";
import * as vscode from "vscode";

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

describe("listFilesRecursive", () => {
  let workspaceRoot: string;
  let state: CalcDocsState;

  beforeEach(async () => {
    workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "calcdocs-files-"));
    state = makeState(workspaceRoot);

    // dirA/1.c, dirB/2.c, dirC/3.c - tre sottodirectory con un file ciascuna,
    // cosi' un walk parziale (interrotto a metà) e' verificabile.
    for (const dir of ["dirA", "dirB", "dirC"]) {
      const full = path.join(workspaceRoot, dir);
      await fsp.mkdir(full, { recursive: true });
      await fsp.writeFile(path.join(full, `${dir}.c`), "// content\n", "utf8");
    }
  });

  afterEach(async () => {
    await fsp.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("lists every file when nothing is ignored and nothing is cancelled", async () => {
    const files = await listFilesRecursive(
      workspaceRoot,
      () => false,
      state
    );

    const names = files.map((f) => path.basename(f)).sort();
    expect(names).toEqual(["dirA.c", "dirB.c", "dirC.c"]);
  });

  it("skips directories the ignore callback rejects", async () => {
    const files = await listFilesRecursive(
      workspaceRoot,
      (_absPath, dirName) => dirName === "dirB",
      state
    );

    const names = files.map((f) => path.basename(f)).sort();
    expect(names).toEqual(["dirA.c", "dirC.c"]);
  });

  it("stops descending further once isCancelled() becomes true, instead of finishing the whole tree", async () => {
    // Regressione: prima non esisteva alcun modo per interrompere un
    // listFilesRecursive() in corso, quindi anche dopo aver rinunciato a
    // un'analisi (troncamento, disable, superata da un trigger più
    // recente) la scansione dell'intero workspace proseguiva comunque
    // fino alla fine.
    let visited = 0;
    const files = await listFilesRecursive(
      workspaceRoot,
      () => {
        visited += 1;
        return false;
      },
      state,
      () => visited >= 1 // si cancella dopo la prima directory guardata
    );

    expect(files.length).toBeLessThan(3);
  });

  it("with isCancelled() true from the very start, returns immediately with nothing", async () => {
    const files = await listFilesRecursive(
      workspaceRoot,
      () => false,
      state,
      () => true
    );

    expect(files).toEqual([]);
  });
});
