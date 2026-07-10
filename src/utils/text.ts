/**
 * Removes inline C-style comments from expression strings.
 * Example: "A + 1 // note" -> "A + 1"
 */
export function stripComments(text: string): string {
  let output = "";
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const current = text[i];
    const next = i + 1 < text.length ? text[i + 1] : "";

    if (inLineComment) {
      if (current === "\n" || current === "\r") {
        inLineComment = false;
        output += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
        // Preserve token separation where comment removal would merge symbols.
        output += " ";
        continue;
      }

      if (current === "\n" || current === "\r") {
        output += current;
      }
      continue;
    }

    if (inString) {
      output += current;
      if (current === "\\") {
        if (i + 1 < text.length) {
          output += text[i + 1];
          i += 1;
        }
        continue;
      }

      if (current === inString) {
        inString = null;
      }
      continue;
    }

    if (current === '"' || current === "'" || current === "`") {
      inString = current;
      output += current;
      continue;
    }

    if (current === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    output += current;
  }

  return output.trim();
}

/**
 * Creates a stateful comment stripper for streaming (line-by-line) processing.
 * Use this when stripping comments from a sequence of lines that may contain
 * multi-line block comments spanning several physical lines.
 *
 * The returned object tracks only `inBlockComment` state across calls.
 * String literals and line comments are reset on each call since they
 * cannot span physical lines in valid C/C++.
 *
 * Usage:
 *   const stripper = createCommentStripper();
 *   // then call stripper.strip(line) for each line
 */
export function createCommentStripper(): { strip(text: string): string } {
  let inBlockComment = false;

  return {
    strip(text: string): string {
      let output = "";
      let inString: string | null = null;
      let inLineComment = false;

      for (let i = 0; i < text.length; i += 1) {
        const current = text[i];
        const next = i + 1 < text.length ? text[i + 1] : "";

        if (inLineComment) {
          if (current === "\n" || current === "\r") {
            inLineComment = false;
            output += current;
          }
          continue;
        }

        if (inBlockComment) {
          if (current === "*" && next === "/") {
            inBlockComment = false;
            i += 1;
            output += " ";
            continue;
          }

          if (current === "\n" || current === "\r") {
            output += current;
          }
          continue;
        }

        if (inString) {
          output += current;
          if (current === "\\") {
            if (i + 1 < text.length) {
              output += text[i + 1];
              i += 1;
            }
            continue;
          }

          if (current === inString) {
            inString = null;
          }
          continue;
        }

        if (current === '"' || current === "'" || current === "`") {
          inString = current;
          output += current;
          continue;
        }

        if (current === "/" && next === "/") {
          inLineComment = true;
          i += 1;
          continue;
        }

        if (current === "/" && next === "*") {
          inBlockComment = true;
          i += 1;
          continue;
        }

        output += current;
      }

      return output.trim();
    },
  };
}

/**
 * Removes backslash line continuations from C/C++ source code.
 * In C, a backslash at the end of a line joins that line with the next.
 * Example: "#define A \\\n  1" -> "#define A   1"
 * 
 * @param text - Source text with potential line continuations
 * @returns Text with line continuations resolved
 */
export function stripLineContinuations(text: string): string {
  // Match backslash followed by newline (CRLF or LF)
  return text.replace(/\\\r?\n/g, "");
}

/**
 * Truncates long strings for UI safety.
 */
export function clampLen(text: string, max = 5000): string {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max)} ...`;
}