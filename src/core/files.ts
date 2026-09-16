import * as fsp from "fs/promises";
import * as path from "path";
import { Dirent } from "fs";
import { CalcDocsState } from "./state";

/**
 * Recursively lists files under root, skipping directories matched by callback.
 * Example: `(name) => name === "node_modules"` avoids scanning dependencies.
 *
 * @param isCancelled - Controllato prima di scendere in ogni directory:
 *   se true, interrompe la scansione appena possibile e restituisce
 *   quello che ha raccolto fin qui, invece di continuare a leggere il
 *   filesystem per un'analisi ormai abbandonata (es. superata da un
 *   trigger più recente, o rinunciata dal fallback progressivo).
 */
export async function listFilesRecursive(
  root: string,
  isIgnoredDir: (absoluteDirPath: string, dirName: string) => boolean,
  state: CalcDocsState,
  isCancelled?: () => boolean
): Promise<string[]> {
  const collectedFiles: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    if (isCancelled?.()) {
      return;
    }

    let entries: Dirent[];

    try {
      entries = (await fsp.readdir(currentDir, {
        withFileTypes: true,
      })) as Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      if (isCancelled?.()) {
        return;
      }

      const entryName = String(entry.name);
      const absolutePath = path.join(currentDir, entryName);

      if (entry.isDirectory()) {
        if (!isIgnoredDir(absolutePath, entryName)) {
          await walk(absolutePath);
        // } else {
        }
        continue;
      }

      collectedFiles.push(absolutePath);
    }
  }

  await walk(root);
  return collectedFiles;
}

/**
 * Returns first formulas YAML candidate (formula*.yml|yaml) from file list.
 */
export function findFormulaYamlFile(files: string[]): string | undefined {
  return files.find((file) => {
    const basename = path.basename(file).toLowerCase();

    return (
      (basename.startsWith("formula") || basename.startsWith("formulas")) &&
      (basename.endsWith(".yaml") || basename.endsWith(".yml"))
    );
  });
}
