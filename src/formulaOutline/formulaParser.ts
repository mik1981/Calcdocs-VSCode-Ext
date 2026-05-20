export type OutlineFormula = {
  id: string;
  expr: string;
  desc?: string;
  example?: Record<string, number>;
  unit?: string;
  value?: number; 
  lineStart: number;
  lineEnd: number;
  _filePath?: string;
  line?: number;
};

// export function isFormulaYamlDocument(document: vscode.TextDocument): boolean {
//     const fileName = document.fileName.toLowerCase();

//     return (
//         document.languageId === "yaml" &&
//         /(^|[\\/])formulas.*\.ya?ml$/i.test(fileName)
//     );
// }

/**
 * Lightweight line-based parser for formulas*.yaml.
 * Scans for `ID:
   expr/formula: ...
   unit?: ...
   value?: number
   example?: {key: val}
 */
export function parseFormulaDocument(lines: string[], filePath?: string): OutlineFormula[] {
  const formulas: OutlineFormula[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Match formula ID: (top-level key)
    if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*$/.test(line)) {
      const id = line.replace(/:\s*$/, '').trim();
      const lineStart = i;
      const example: Record<string, number> = {};
      let expr = '';
      let unit = '';
      let desc = '';
      let value: number | undefined;

      // Scan block
      i++;
      while (i < lines.length) {
        const blockLine = lines[i].trim();
        const indent = lines[i].match(/^\s*/)?.[0].length ?? 0;

        if (indent === 0) break; // End of block

        if (blockLine.startsWith('expr:')) {
          expr = blockLine.replace(/^expr:\s*/, '').trim();
        } else if (blockLine.startsWith('formula:')) {
          expr = blockLine.replace(/^formula:\s*/, '').trim();
        } else if (blockLine.startsWith('unit:')) {
          unit = blockLine.replace(/^unit:\s*/, '').trim();
        } else if (blockLine.startsWith('desc:')) {
          desc = blockLine.replace(/^desc:\s*/, '').trim();
        } else if (blockLine.startsWith('value:')) {
          // Campo dedicato: NON va nell'example map
          const v = parseFloat(blockLine.replace(/^value:\s*/, '').trim());
          if (!isNaN(v)) value = v;
        } else if (blockLine.startsWith('steps:') || blockLine.startsWith('- ')) {
          // Salta blocchi lista (steps, bullet points)
        } else if (blockLine.includes(':')) {
          // Parse coppie esempio: key: number
          const [key, valStr] = blockLine.split(':', 2);
          const v = parseFloat(valStr?.trim());
          if (!isNaN(v)) {
            example[key.trim()] = v;
          }
        }
        i++;
      }

      // Includi anche formule senza expr (costanti pure con solo value)
      if (expr || value !== undefined) {
        formulas.push({ id, expr, desc, example, unit, value, lineStart, lineEnd: i - 1, _filePath: filePath });
      }
    } else {
      i++;
    }
  }

  return formulas;
}