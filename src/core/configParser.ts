import * as fsp from "fs/promises";
import * as path from "path";
import { CalcDocsState } from "./state";

type ConfigVarValue = {
  value: number | string;
  comment: string;
  line: number;
};

export type FileConfigVars = Map<string, ConfigVarValue>;

function parseConfigComments(
  text: string,
  relativePath: string,
  state: CalcDocsState
): FileConfigVars {
  const vars = new Map<string, ConfigVarValue>();
  const lines = text.split(/\r?\n/);
  // Supports both:
  // - // @vin = 22
  // - // @config.vin = 22   (legacy)
  const configRx = /^\s*\/\/\s*@(?:(?:config\.)?([A-Za-z_]\w*))\s*=\s*(.+?)\s*$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(configRx);
    if (!match) {
      continue;
    }

    const name = match[1].trim();
    const rawValue = match[2].trim();
    let value: number | string = rawValue;
    const comment = lines[i];

    // Try numeric parse
    const numValue = Number(rawValue);
    if (!Number.isNaN(numValue)) {
      value = numValue;
    }

    vars.set(name, { value, comment, line: i });
    state.output.detail(`[Config] ${relativePath}: @${name} = ${value}`);
  }

  return vars;
}

export async function extractConfigVarsFromFile(
  filePath: string,
  workspaceRoot: string,
  state: CalcDocsState
): Promise<FileConfigVars | null> {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    const relativePath = path.relative(workspaceRoot, filePath);
    return parseConfigComments(text, relativePath, state);
  } catch (err) {
    state.output.warn(`[Config] Failed to parse ${filePath}: ${err}`);
    return null;
  }
}

