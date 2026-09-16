import * as fs from 'fs';
import * as path from 'path';

// -----------------------------------------------------------------------------
// UTILS
// -----------------------------------------------------------------------------

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

function toAbsolute(p: string): string {
  return normalize(path.resolve(p));
}

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

interface Configuration {
  projectRoot: string;
  exclusions: string[];
  compileFlags: string[];
}

interface CompileCommand {
  directory: string;
  command: string;
  file: string;
}

interface GenerationResult {
  commands: CompileCommand[];
  processedFiles: number;
  includeDirectories: number;
}

// -----------------------------------------------------------------------------
// EXCLUSIONS
// -----------------------------------------------------------------------------

function isExcluded(testPath: string, config: Configuration): boolean {
  const rel = normalize(path.relative(config.projectRoot, testPath));
  return config.exclusions.some(excl => rel.startsWith(excl));
}

// -----------------------------------------------------------------------------
// WALK DIRECTORY
// -----------------------------------------------------------------------------

function* walkDirectory(
  rootDir: string,
  config: Configuration
): IterableIterator<{ absDir: string; files: string[] }> {
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop()!;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const dirs: string[] = [];
    const files: string[] = [];

    for (const entry of entries) {
      const absPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!isExcluded(absPath, config)) {
          dirs.push(absPath);
        }
      } else {
        files.push(entry.name);
      }
    }

    yield { absDir: currentDir, files };

    stack.push(...dirs.reverse());
  }
}

// -----------------------------------------------------------------------------
// YAML (simple parser)
// -----------------------------------------------------------------------------

function findFormulaYamlFiles(root: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const e of entries) {
      const full = path.join(dir, e.name);

      if (e.isDirectory()) {
        walk(full);
      } else if (/formulas.*\.ya?ml$/.test(e.name)) {
        results.push(full);
      }
    }
  }

  walk(root);
  return results;
}

/**
 * Parser YAML super leggero (key: value)
 * Nota: assume struttura semplice come nel tuo caso
 */
function parseFormulaYaml(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  const result: Record<string, string> = {};

  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (match) {
      const key = match[1];
      const value = match[2]?.trim();
      if (key && value && !value.endsWith(':')) {
        result[key] = value;
      }
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

/**
 * Genera i comandi di compilazione per clangd a partire dalla configurazione fornita
 * Questa è la funzione pubblica che viene chiamata dall'interno dell'estensione VS Code
 * 
 * @param config Configurazione completa fornita dal chiamante
 * @returns Risultato della generazione con lista dei comandi e statistiche
 */
export function generateCompileCommands(config: Configuration): GenerationResult {
  const commands: CompileCommand[] = [];

  const projectRootAbs = toAbsolute(config.projectRoot);

  // -----------------------------------------------------------------
  // 1. FORMULAS
  // -----------------------------------------------------------------
  const yamlFiles = findFormulaYamlFiles(config.projectRoot);

//   const macroBlocks: string[] = [];

//   for (const yamlFile of yamlFiles) {
//     const formulas = parseFormulaYaml(yamlFile);

//     const rel = normalize(path.relative(config.projectRoot, yamlFile));

//     macroBlocks.push(`// ----------------------------`);
//     macroBlocks.push(`// FORMULAS FROM: ${rel}`);
//     macroBlocks.push(`// ----------------------------`);

//     for (const [key, value] of Object.entries(formulas)) {
//       if (!key || !value) continue;
//       macroBlocks.push(`#define ${key} (${value})`);
//     }
//   }

//   const macroEscaped = macroBlocks
//     .join('\n')
//     .replace(/\\/g, '\\\\')
//     .replace(/\n/g, '\\n')
//     .replace(/"/g, '\\"');

  // -----------------------------------------------------------------
  // 2. C FILES
  // -----------------------------------------------------------------
  const cFiles: string[] = [];

  for (const { absDir, files } of walkDirectory(config.projectRoot, config)) {
    for (const file of files) {
      if (file.endsWith('.c')) {
        const absFile = path.join(absDir, file);

        if (!isExcluded(absFile, config)) {
          cFiles.push(toAbsolute(absFile));
        }
      }
    }
  }

  // -----------------------------------------------------------------
  // 3. INCLUDE DIRS (RELATIVE)
  // -----------------------------------------------------------------
  const includeDirsSet = new Set<string>();

  for (const { absDir, files } of walkDirectory(config.projectRoot, config)) {
    if (files.some(f => f.endsWith('.h'))) {
      const rel = normalize(path.relative(config.projectRoot, absDir));

      if (rel && rel !== ".") {
        includeDirsSet.add(rel);
      }
    }
  }

  const includeDirs = Array.from(includeDirsSet).sort();

  const includeFlagsStr = includeDirs
    .map(p => `-I${p}`)
    .join(' ');

  const baseFlags = config.compileFlags.join(' ');

  // -----------------------------------------------------------------
  // 4. COMMANDS (HYBRID MODE)
  // -----------------------------------------------------------------
  for (const absFile of cFiles) {
    // const relFile = normalize(path.relative(config.projectRoot, absFile));
    const relFile = path.normalize(absFile);

    commands.push({
      directory: projectRootAbs,
      command: `clang -c ${includeFlagsStr} ${baseFlags} ${relFile.replace(/\\/g, '/')}`,
      file: relFile
    });
  }

  return {
    commands,
    processedFiles: commands.length,
    includeDirectories: includeDirs.length
  };
}

// -----------------------------------------------------------------------------
// WRITE FILE
// -----------------------------------------------------------------------------

function writeCompileCommandsToFile(
  result: GenerationResult,
  outputPath: string
): void {
  fs.writeFileSync(outputPath, JSON.stringify(result.commands, null, 2), 'utf8');
}

// -----------------------------------------------------------------------------
// BACKWARD COMPATIBILITY: Modalità CLI standalone
// -----------------------------------------------------------------------------

if (require.main === module) {
  const config: Configuration = {
    projectRoot: process.argv[2] ?? process.cwd(),

    exclusions: [
      "Bitmap/_Old",
      "Drivers/STM32F0xx_HAL_Driver/Src/stm32f0xx_hal_old.c",
      "Tools",
      ".git",
      "build",
      "dist",
      "node_modules"
    ],

    compileFlags: [
      "-std=c99",
      "-DSTM32F0"
    ]
  };

  console.log(`🔍 Project: ${config.projectRoot}`);

  const result = generateCompileCommands(config);

  const outputPath = path.join(process.cwd(), 'compile_commands.json');
  writeCompileCommandsToFile(result, outputPath);

  console.log(`✅ Generated: ${outputPath}`);
  console.log(`   C files: ${result.processedFiles}`);
  console.log(`   Includes: ${result.includeDirectories}`);
}
