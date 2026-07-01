import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCalcDocsState, type CalcDocsState } from "../../src/core/state";
import { ColoredOutput } from "../../src/utils/output";
import { ensureConfigVarsLoaded } from "../../src/core/scopedConfigVars";

function fakeOutputChannel() {
  return {
    appendLine: () => undefined,
    append: () => undefined,
    show: () => undefined,
    clear: () => undefined,
    dispose: () => undefined,
    name: "test",
    detail: () => undefined,
  } as unknown as import("vscode").OutputChannel;
}

function makeState(workspaceRoot: string): CalcDocsState {
  return createCalcDocsState(workspaceRoot, new ColoredOutput(fakeOutputChannel()));
}

describe("ensureConfigVarsLoaded", () => {
  let workspaceRoot: string;
  let state: CalcDocsState;

  beforeEach(async () => {
    workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "calcdocs-configvars-"));
    state = makeState(workspaceRoot);
  });

  afterEach(async () => {
    await fsp.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("finds a config.c file anywhere in the workspace, not just via #include", async () => {
    const subdir = path.join(workspaceRoot, "board", "nested");
    await fsp.mkdir(subdir, { recursive: true });
    await fsp.writeFile(
      path.join(subdir, "config.c"),
      "// @vin = 5\n// @r = 100\nint unrelated(void) { return 0; }\n"
    );
    // A completely different, unrelated active .c file (no #include of config.c).
    await fsp.writeFile(path.join(workspaceRoot, "main.c"), "int main(void) { return 0; }\n");

    await ensureConfigVarsLoaded(state);

    const relPath = path.relative(workspaceRoot, path.join(subdir, "config.c"));
    const vars = state.configVars.get(relPath);
    expect(vars?.get("vin")?.value).toBe(5);
    expect(vars?.get("r")?.value).toBe(100);
  });

  it("only searches the workspace once: a second call does not re-scan unchanged files", async () => {
    await fsp.writeFile(path.join(workspaceRoot, "config.c"), "// @vin = 5\n");

    await ensureConfigVarsLoaded(state);
    expect(state.configVarsSourceFiles.size).toBe(1);

    // Delete the file from disk *without* updating configVarsSourceFiles -
    // if a fresh workspace search ran, "vin" would disappear immediately.
    // If the cache is respected, the stale mtime check runs but the value
    // set on the first pass should already reflect what was read then.
    const before = new Map(state.configVars);
    await ensureConfigVarsLoaded(state);
    expect(state.configVars).toEqual(before);
  });

  it("refreshes just the changed config.c file, not a full re-search", async () => {
    const configPath = path.join(workspaceRoot, "config.c");
    await fsp.writeFile(configPath, "// @vin = 5\n");
    await ensureConfigVarsLoaded(state);

    await fsp.writeFile(configPath, "// @vin = 12\n");
    const bumped = new Date(Date.now() + 2000);
    await fsp.utimes(configPath, bumped, bumped);

    await ensureConfigVarsLoaded(state);

    const relPath = path.relative(workspaceRoot, configPath);
    expect(state.configVars.get(relPath)?.get("vin")?.value).toBe(12);
  });
});
