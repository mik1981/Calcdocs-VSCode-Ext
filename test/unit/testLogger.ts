/**
 * testLogger.ts
 *
 * Lightweight structured logger for CalcDocs integration tests.
 *
 * Usage
 * ─────
 * import { createTestLogger, summariseLog } from "./testLogger";
 *
 * const log = createTestLogger("my_case");
 * log.symbol("FOO", 42, 42, true);
 * log.symbol("BAR", null, 7, false);
 * console.log(summariseLog(log));
 *
 * Design goals
 * ────────────
 * 1. Zero runtime dependencies — plain TypeScript, no extra packages.
 * 2. Structured entries so callers can query pass/fail counts
 *    programmatically (e.g. in a custom reporter).
 * 3. Human-readable summary suitable for CI logs.
 * 4. Does NOT import from src/ so it never breaks due to source changes.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = "pass" | "fail" | "skip" | "info" | "warn";

export type LogEntry = {
  /** ISO timestamp */
  timestamp: string;
  level: LogLevel;
  /** The test case name passed to createTestLogger */
  caseName: string;
  /** Short message describing what was checked */
  message: string;
  /** Optional structured payload for machine consumption */
  payload?: Record<string, unknown>;
};

export type TestLogger = {
  /** The case name this logger was created for */
  caseName: string;
  /** All recorded entries in insertion order */
  entries: LogEntry[];

  /**
   * Log a symbol resolution result.
   *
   * @param name     Symbol name
   * @param actual   Resolved numeric value (null = unresolved)
   * @param expected Expected value from expected.yaml (null = "error" case)
   * @param passed   Whether the assertion passed
   */
  symbol(
    name: string,
    actual: number | null,
    expected: number | null,
    passed: boolean
  ): void;

  /**
   * Log an inline calc result.
   *
   * @param id       @test marker id
   * @param actual   Computed value
   * @param expected Expected value
   * @param passed   Whether the assertion passed
   */
  inline(
    id: string,
    actual: number | null,
    expected: number | null,
    passed: boolean
  ): void;

  /**
   * Log an expansion result.
   *
   * @param functionName Function whose call-site expansion was checked
   * @param actual       Expanded string(s) found
   * @param expected     Expected expansion string
   * @param passed       Whether the assertion passed
   */
  expansion(
    functionName: string,
    actual: string[],
    expected: string,
    passed: boolean
  ): void;

  /**
   * Log a generic informational message (timing, file paths, etc.)
   */
  info(message: string, payload?: Record<string, unknown>): void;

  /**
   * Log a warning (e.g. a symbol expected to be an error was actually resolved).
   */
  warn(message: string, payload?: Record<string, unknown>): void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a new TestLogger for the given case name.
 *
 * Example:
 *   const log = createTestLogger("14_complex_formulas");
 *   log.symbol("ADC_FS", 4096, 4096, true);
 */
export function createTestLogger(caseName: string): TestLogger {
  const entries: LogEntry[] = [];

  function push(
    level: LogLevel,
    message: string,
    payload?: Record<string, unknown>
  ): void {
    entries.push({
      timestamp: new Date().toISOString(),
      level,
      caseName,
      message,
      payload,
    });
  }

  return {
    caseName,
    entries,

    symbol(name, actual, expected, passed) {
      const level: LogLevel = passed ? "pass" : "fail";
      const msg = passed
        ? `✓ ${name} = ${actual}`
        : `✗ ${name}: expected ${expected ?? "error"}, got ${actual ?? "unresolved"}`;
      push(level, msg, { name, actual, expected, passed });
    },

    inline(id, actual, expected, passed) {
      const level: LogLevel = passed ? "pass" : "fail";
      const msg = passed
        ? `✓ @test ${id} = ${actual}`
        : `✗ @test ${id}: expected ${expected ?? "error"}, got ${actual ?? "unresolved"}`;
      push(level, msg, { id, actual, expected, passed });
    },

    expansion(functionName, actual, expected, passed) {
      const level: LogLevel = passed ? "pass" : "fail";
      const msg = passed
        ? `✓ expansion ${functionName} = "${expected}"`
        : `✗ expansion ${functionName}: expected "${expected}", got ${JSON.stringify(actual)}`;
      push(level, msg, { functionName, actual, expected, passed });
    },

    info(message, payload) {
      push("info", message, payload);
    },

    warn(message, payload) {
      push("warn", message, payload);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary helpers
// ─────────────────────────────────────────────────────────────────────────────

export type LogSummary = {
  caseName: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: LogEntry[];
};

/**
 * Returns a structured summary of all entries in the logger.
 */
export function summariseLog(logger: TestLogger): LogSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: LogEntry[] = [];

  for (const entry of logger.entries) {
    if (entry.level === "pass") {
      passed += 1;
    } else if (entry.level === "fail") {
      failed += 1;
      failures.push(entry);
    } else if (entry.level === "skip") {
      skipped += 1;
    }
  }

  return {
    caseName: logger.caseName,
    total: passed + failed + skipped,
    passed,
    failed,
    skipped,
    failures,
  };
}

/**
 * Formats the summary as a human-readable string suitable for CI logs.
 *
 * Example output:
 *   [14_complex_formulas] PASS 6/6
 *
 *   [15_conditional_defines] FAIL 4/6
 *     ✗ INACTIVE_SYM: expected error, got 9999
 *     ✗ COMPOUND: expected 275, got unresolved
 */
export function formatLogSummary(summary: LogSummary): string {
  const status = summary.failed === 0 ? "PASS" : "FAIL";
  const header = `[${summary.caseName}] ${status} ${summary.passed}/${summary.total}`;

  if (summary.failures.length === 0) {
    return header;
  }

  const failureLines = summary.failures
    .map((e) => `  ${e.message}`)
    .join("\n");

  return `${header}\n${failureLines}`;
}

/**
 * Returns true when all assertions in the logger passed.
 */
export function allPassed(logger: TestLogger): boolean {
  return logger.entries.every((e) => e.level !== "fail");
}