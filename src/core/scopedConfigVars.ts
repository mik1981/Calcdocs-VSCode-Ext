import * as fsp from "fs/promises";
import * as path from "path";

import { getConfig, isIgnoredFsPath, refreshIgnoredDirs } from "./config";
import { extractConfigVarsFromFile } from "./configParser";
import { listFilesRecursive } from "./files";
import { CalcDocsState } from "./state";

/**
 * scopedConfigVars
 * -----------------
 * Inline-calc's @config.<hint>.<var> references (see core/inlineCalc.ts's
 * resolveConfigReference) are answered entirely from state.configVars, which
 * used to be populated only inside the full-workspace runAnalysis() pass:
 * find every config.c/config.h file in the workspace, parse each with
 * extractConfigVarsFromFile(). That population step never runs on the
 * active-file-only C/C++ path (runActiveCppFileAnalysis), so any reference
 * to a config.c that the active file doesn't itself #include silently comes
 * back "missing" - the active file's own #include chain is genuinely the
 * wrong place to look here, since @config.<hint> is explicitly naming a
 * *different* file by convention (a file literally named config.c/config.h),
 * not something reached by the active file's own includes.
 *
 * This does the same targeted job, but scoped like everything else here:
 *   - The workspace search for config.c/config.h is filename-only (no file
 *     content is read during the search itself) and, per the project's own
 *     convention, matches only a handful of files even in a 1000+ file repo.
 *   - That search runs at most once per session: state.configVarsSourceFiles
 *     remembers exactly which files were found. Later calls just stat() the
 *     remembered files; only a changed/deleted one gets re-parsed or
 *     dropped, never triggering a fresh workspace-wide search from scratch
 *     unless a previously-known file disappeared.
 */

const CONFIG_FILE_RX = /[\\/]config\.[ch]$/i;

export async function ensureConfigVarsLoaded(state: CalcDocsState): Promise<void> {
  if (state.configVarsSourceFiles.size === 0) {
    await performWorkspaceSearch(state);
    return;
  }

  let anyMissing = false;

  for (const [filePath, rememberedMtime] of Array.from(state.configVarsSourceFiles)) {
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      // File deleted/moved - drop it and let a fresh search look for a
      // replacement (or simply find nothing, which is correct).
      state.configVarsSourceFiles.delete(filePath);
      state.configVars.delete(path.relative(state.workspaceRoot, filePath));
      anyMissing = true;
      continue;
    }

    if (stat.mtimeMs === rememberedMtime) {
      continue; // unchanged, nothing to do
    }

    const configVars = await extractConfigVarsFromFile(filePath, state.workspaceRoot, state);
    if (configVars) {
      state.configVars.set(path.relative(state.workspaceRoot, filePath), configVars);
    }
    state.configVarsSourceFiles.set(filePath, stat.mtimeMs);
  }

  if (anyMissing) {
    await performWorkspaceSearch(state, /* mergeOnly */ true);
  }
}

async function performWorkspaceSearch(
  state: CalcDocsState,
  mergeOnly = false
): Promise<void> {
  const config = getConfig();
  refreshIgnoredDirs(state, config);

  const allFiles = await listFilesRecursive(
    state.workspaceRoot,
    (absoluteDirPath) => isIgnoredFsPath(state, absoluteDirPath),
    state
  );

  const configFiles = allFiles.filter((file) => CONFIG_FILE_RX.test(file));

  if (!mergeOnly) {
    state.configVars.clear();
    state.configVarsSourceFiles.clear();
  }

  for (const configFile of configFiles) {
    if (state.configVarsSourceFiles.has(configFile)) {
      continue; // already tracked (mergeOnly path re-searching after a deletion)
    }

    const configVars = await extractConfigVarsFromFile(configFile, state.workspaceRoot, state);
    let mtimeMs = Date.now();
    try {
      mtimeMs = (await fsp.stat(configFile)).mtimeMs;
    } catch {
      continue;
    }

    if (configVars) {
      state.configVars.set(path.relative(state.workspaceRoot, configFile), configVars);
    }
    state.configVarsSourceFiles.set(configFile, mtimeMs);
  }

  state.output.info(
    `[Config] ${mergeOnly ? "Re-searched" : "Searched"} workspace: ${configFiles.length} config.c/config.h file(s) tracked.`
  );
}
