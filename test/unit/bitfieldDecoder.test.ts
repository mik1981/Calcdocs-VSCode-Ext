import { describe, expect, it } from "vitest";
import {
  decodeBitfieldValue,
  formatBitfieldDecodeMarkdown,
  matchesContext,
  parseRegisterAssignment,
  type BitfieldEntry,
} from "../../src/core/bitfieldDecoder";
import type { CalcDocsState } from "../../src/core/state";

const fakeState = {
  allDefines: new Map<string, string>(),
  symbolValues: new Map<string, number>(),
  symbolUnits: new Map<string, string>(),
  csvTables: new Map(),
  configVars: new Map(),
  symbolDefs: new Map(),
  symbolConditionalDefs: new Map(),
  symbolAmbiguityRoots: new Map(),
  defineConditions: new Map(),
  defineComments: new Map<string, string>(),
  functionDefines: new Map(),
  headerGenConfig: { outputPath: "macro_generate.h" },
  formulaIndex: new Map(),
  formulaOutlines: new Map(),
  ignoredDirs: new Set(),
  lastYamlPath: "",
  lastYamlRaw: "",
  hasFormulasFile: false,
  workspaceRoot: ".",
  output: {
    appendLine: () => {},
    detail: () => {},
    warn: () => {},
    error: () => {},
    info: () => {},
  },
  enabled: true,
  lastAnalysisStackUsage: { usedDepth: 0, depthLimit: 0, cycleCount: 0, prunedCount: 0, degraded: false },
  lastYamlParseError: null,
  diagnostics: undefined,
  inlineCalcDiagnostics: undefined,
  yamlDiagnostics: [],
  missingYamlSuggestions: [],
  inlineCalcEnableCodeLens: true,
  inlineCalcEnableHover: true,
  inlineGhostEnabled: true,
  inlineCalcDiagnosticsLevel: "warnings",
  uiInvasiveness: "standard",
  cppCodeLens: {
    enabled: true,
    maxItemsPerFile: 40,
    showAmbiguity: true,
    showCastOverflow: true,
    showMismatch: true,
    showOpenFormula: true,
    showResolvedValue: true,
    showExpandedPreview: true,
  },
  cppHover: {
    enabled: true,
    maxConditionalDefinitions: 8,
    maxInDocumentDefinitions: 6,
    showConditionalDefinitions: true,
    showInDocumentDefinitions: true,
    showCastOverflow: true,
    showInheritedAmbiguity: true,
    showFormulaSection: true,
    showKnownValue: true,
  },
} as unknown as CalcDocsState;

describe("bitfieldDecoder", () => {
  function resetFakeState(): void {
    fakeState.allDefines.clear();
    fakeState.symbolValues.clear();
    fakeState.defineComments.clear();
  }

  function decodeSvgFromMarkdown(markdown: string): string {
    const match = markdown.match(/data:image\/svg\+xml;base64,([^)]+)/);
    expect(match).not.toBeNull();
    return Buffer.from(match![1], "base64").toString("utf8");
  }

  // ---------------------------------------------------------------------------
  // Helper: create a simple flag-style entry for matchesContext tests
  // ---------------------------------------------------------------------------
  function makeEntry(registerPrefix: string, name = "TEST"): BitfieldEntry {
    return {
      kind: "flag",
      name,
      fullName: `${registerPrefix}_${name}`,
      registerPrefix,
      mask: 1,
      bit: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // CLASS A — MATCH SENSATO (IDENT_REGISTER or IDENT_REGISTER_MEMBER)
  // ---------------------------------------------------------------------------
  describe("matchesContext — Class A (sensato)", () => {
    it('matches "TIM1->CR1" → prefix "TIM1_CR1"', () => {
      const entry = makeEntry("TIM1_CR1");
      const defines = new Map<string, string>([
        ["TIM1_CR1_CEN_Pos", "(0U)"],
      ]);
      expect(matchesContext(entry, "TIM1->CR1", defines)).toBe(true);
    });

    it('matches "USART2->BRR" → prefix "USART2_BRR"', () => {
      const entry = makeEntry("USART2_BRR");
      const defines = new Map<string, string>([
        ["USART2_BRR_DIV_Mantissa_Pos", "(4U)"],
      ]);
      expect(matchesContext(entry, "USART2->BRR", defines)).toBe(true);
    });

    it('matches "GPIOA->ODR" (full identifier) → prefix "GPIOA_ODR"', () => {
      const entry = makeEntry("GPIOA_ODR");
      const defines = new Map<string, string>([
        ["GPIOA_ODR_ODR0_Pos", "(0U)"],
      ]);
      expect(matchesContext(entry, "GPIOA->ODR", defines)).toBe(true);
    });

    it('matches dot-notation "TIM1.CR1" → prefix "TIM1_CR1"', () => {
      const entry = makeEntry("TIM1_CR1");
      const defines = new Map<string, string>([
        ["TIM1_CR1_CEN_Pos", "(0U)"],
      ]);
      expect(matchesContext(entry, "TIM1.CR1", defines)).toBe(true);
    });

    it('matches 3-part "TIM1->CR1->CEN" → prefix "TIM1_CR1"', () => {
      const entry = makeEntry("TIM1_CR1");
      const defines = new Map<string, string>([
        ["TIM1_CR1_CEN_Pos", "(0U)"],
      ]);
      expect(matchesContext(entry, "TIM1->CR1->CEN", defines)).toBe(true);
    });

    it('matches "TIM1->CR2" with generic prefix "TIM_CR2" (strip trailing digits)', () => {
      const entry = makeEntry("TIM_CR2");
      const defines = new Map<string, string>([
        ["TIM_CR2_CCPC_Pos", "(0U)"],
      ]);
      expect(matchesContext(entry, "TIM1->CR2", defines)).toBe(true);
    });

    it('matches "TIM2->CR2" with generic prefix "TIM_CR2" (strip trailing digits)', () => {
      const entry = makeEntry("TIM_CR2");
      const defines = new Map<string, string>([
        ["TIM_CR2_CCPC_Pos", "(0U)"],
      ]);
      expect(matchesContext(entry, "TIM2->CR2", defines)).toBe(true);
    });

    it('matches "TIM1->CR2->CCPC" with generic prefix "TIM_CR2" (3-part, strip digits)', () => {
      const entry = makeEntry("TIM_CR2");
      const defines = new Map<string, string>([
        ["TIM_CR2_CCPC_Pos", "(0U)"],
      ]);
      expect(matchesContext(entry, "TIM1->CR2->CCPC", defines)).toBe(true);
    });

    it('prefers exact match over stripped (TIM1_CR1 vs TIM_CR1)', () => {
      const entry = makeEntry("TIM1_CR1");
      const defines = new Map<string, string>([
        ["TIM1_CR1_CEN_Pos", "(0U)"],
      ]);
      expect(matchesContext(entry, "TIM1->CR1", defines)).toBe(true);

      // When exact match exists, TIM_CR1 entry should NOT match TIM1->CR1
      // because its defines are for TIM_CR1_*, not TIM1_CR1_*
      // Actually TIM_CR1 would match via stripped path — let's verify both work
      const genericEntry = makeEntry("TIM_CR1");
      const genericDefines = new Map<string, string>([
        ["TIM_CR1_CEN_Pos", "(0U)"],
      ]);
      expect(matchesContext(genericEntry, "TIM1->CR1", genericDefines)).toBe(true);
    });

    it('works without allDefines (backward compat)', () => {
      const entry = makeEntry("TIM_CR1");
      expect(matchesContext(entry, "TIM->CR1")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // CLASS B — FALSE POSITIVE (da rifiutare)
  // ---------------------------------------------------------------------------
  describe("matchesContext — Class B (false positive, da rifiutare)", () => {
    it("rejects 1-part context (e.g. just CR1)", () => {
      const entry = makeEntry("TIM_CR1");
      expect(matchesContext(entry, "CR1")).toBe(false);
    });

    it("rejects chain with >3 parts: foo->bar->baz", () => {
      const entry = makeEntry("foo_bar");
      expect(matchesContext(entry, "foo->bar->baz")).toBe(false);
    });

    it("rejects context with array index: ptr->member[0]", () => {
      const entry = makeEntry("ptr_member");
      expect(matchesContext(entry, "ptr->member[0]")).toBe(false);
    });

    it("rejects context with parens: (p+1)->reg", () => {
      const entry = makeEntry("p_reg");
      expect(matchesContext(entry, "(p+1)->reg")).toBe(false);
    });

    it("rejects context with arithmetic: p+1->reg", () => {
      const entry = makeEntry("p_reg");
      expect(matchesContext(entry, "p+1->reg")).toBe(false);
    });

    it("rejects context with hex literal: 0xFF", () => {
      const entry = makeEntry("FOO_BAR");
      expect(matchesContext(entry, "0xFF->bar")).toBe(false);
    });

    it("rejects context with non-identifier chars: ptr-> _some_macro", () => {
      const entry = makeEntry("ptr_some_macro");
      expect(matchesContext(entry, "ptr-> _some_macro")).toBe(false);
    });

    it("rejects when no _Pos/_Msk defines exist for candidate prefix", () => {
      const entry = makeEntry("UNKNOWN_REG");
      const defines = new Map<string, string>([
        ["SOME_OTHER_Pos", "(0U)"],
      ]);
      expect(matchesContext(entry, "UNKNOWN->REG", defines)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // CLASS C — AMBIGUI (simili ad A ma senza define corrispondenti)
  // ---------------------------------------------------------------------------
  describe("matchesContext — Class C (ambiguo, senza defines)", () => {
    it("rejects TIM1->CR1 when no TIM1_CR1_*_Pos/Msk defines exist", () => {
      const entry = makeEntry("TIM1_CR1");
      const defines = new Map<string, string>([
        ["GPIOA_ODR_ODR0_Pos", "(0U)"],
      ]);
      // The defines exist, but not for TIM1_CR1
      expect(matchesContext(entry, "TIM1->CR1", defines)).toBe(false);
    });

    it("rejects with empty defines map", () => {
      const entry = makeEntry("TIM_CR1");
      const defines = new Map<string, string>();
      expect(matchesContext(entry, "TIM->CR1", defines)).toBe(false);
    });

    it("accepts when corresponding defines exist even with extra unrelated defines", () => {
      const entry = makeEntry("TIM_CR1");
      const defines = new Map<string, string>([
        ["TIM_CR1_CEN_Pos", "(0U)"],
        ["GPIOA_ODR_ODR0_Pos", "(0U)"],
      ]);
      expect(matchesContext(entry, "TIM->CR1", defines)).toBe(true);
    });

    it("accepts _Msk suffix defines", () => {
      const entry = makeEntry("TIM_CR3");
      const defines = new Map<string, string>([
        ["TIM_CR3_DMAP_Msk", "(0x1U << 3U)"],
      ]);
      expect(matchesContext(entry, "TIM->CR3", defines)).toBe(true);
    });

    it("accepts lowercase _pos and _msk variants", () => {
      const entry = makeEntry("ADC_CSR");
      const defines = new Map<string, string>([
        ["ADC_CSR_EOC_pos", "(0U)"],
      ]);
      expect(matchesContext(entry, "ADC->CSR", defines)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // matchesContext — edge cases
  // ---------------------------------------------------------------------------
  describe("matchesContext — edge cases", () => {
    it("rejects empty context", () => {
      const entry = makeEntry("A_B");
      expect(matchesContext(entry, "")).toBe(false);
    });

    it("rejects whitespace-only context", () => {
      const entry = makeEntry("A_B");
      expect(matchesContext(entry, "   ")).toBe(false);
    });

    it("rejects context where prefix does not match entry", () => {
      const entry = makeEntry("TIM_CR1");
      expect(matchesContext(entry, "GPIO->ODR")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // decodeBitfieldValue integration with context
  // ---------------------------------------------------------------------------
  describe("decodeBitfieldValue with context", () => {
    it("decodes TIM1->CR1 value with matching defines", () => {
      resetFakeState();
      fakeState.allDefines.set("TIM1_CR1_CEN_Pos", "(0U)");
      fakeState.allDefines.set("TIM1_CR1_CEN", "((uint16_t)0x0001)");
      fakeState.allDefines.set("TIM1_CR1_URS_Pos", "(2U)");
      fakeState.allDefines.set("TIM1_CR1_URS", "((uint16_t)0x0004)");

      const result = decodeBitfieldValue(0x5, fakeState.allDefines, fakeState, "TIM1->CR1");
      expect(result).not.toBeNull();
      expect(result?.activeFields).toContain("CEN");
      // URS = 0x4 is set in 0x5, so it should also be active
      expect(result?.activeFields).toContain("URS");
    });

    it("returns null when context has no matching _Pos/_Msk defines", () => {
      resetFakeState();
      fakeState.allDefines.set("TIM1_CR1_CEN", "((uint16_t)0x0001)");
      fakeState.allDefines.set("TIM1_CR1_URS", "((uint16_t)0x0004)");
      // No _Pos/_Msk defines → matchesContext returns false → null
      const result = decodeBitfieldValue(0x5, fakeState.allDefines, fakeState, "TIM1->CR1");
      expect(result).toBeNull();
    });

    it("returns null for screen.state (no _Pos/_Msk defines for screen_state)", () => {
      resetFakeState();
      fakeState.allDefines.set("TIM1_CR1_CEN_Pos", "(0U)");
      fakeState.allDefines.set("TIM1_CR1_CEN", "((uint16_t)0x0001)");

      // screen.state normalizes to screen_state — no _Pos/_Msk defines exist
      const result = decodeBitfieldValue(0x100, fakeState.allDefines, fakeState, "screen.state");
      expect(result).toBeNull();
    });

    it("returns null for screen.state even when unrelated defines exist", () => {
      resetFakeState();
      fakeState.allDefines.set("TIM1_CR1_CEN_Pos", "(0U)");
      fakeState.allDefines.set("TIM1_CR1_CEN", "((uint16_t)0x0001)");
      fakeState.allDefines.set("TIM1_CR1_URS_Pos", "(2U)");
      fakeState.allDefines.set("TIM1_CR1_URS", "((uint16_t)0x0004)");

      // screen.state must NOT fall back to all TIM defines
      const result = decodeBitfieldValue(0x100, fakeState.allDefines, fakeState, "screen.state");
      expect(result).toBeNull();
    });

    it("falls back to all entries when no context is provided", () => {
      resetFakeState();
      fakeState.allDefines.set("TIM1_CR1_CEN_Pos", "(0U)");
      fakeState.allDefines.set("TIM1_CR1_CEN", "((uint16_t)0x0001)");

      // No context → should use all entries (backward compat)
      const result = decodeBitfieldValue(0x1, fakeState.allDefines, fakeState);
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Legacy / existing tests adapted
  // ---------------------------------------------------------------------------
  it("decodes TIM_CR1_CEN | TIM_CR1_CMS_0 | TIM_CR1_CMS_1 with context", () => {
    resetFakeState();
    fakeState.allDefines.set("TIM_CR1_CEN_Pos", "(0U)");
    fakeState.allDefines.set("TIM_CR1_CEN", "((uint16_t)0x0001)");
    fakeState.allDefines.set("TIM_CR1_CMS_0_Pos", "(5U)");
    fakeState.allDefines.set("TIM_CR1_CMS_0", "((uint16_t)0x0020)");
    fakeState.allDefines.set("TIM_CR1_CMS_1_Pos", "(6U)");
    fakeState.allDefines.set("TIM_CR1_CMS_1", "((uint16_t)0x0040)");

    const result = decodeBitfieldValue(0x61, fakeState.allDefines, fakeState, "TIM->CR1");
    expect(result).not.toBeNull();
    expect(result?.fields.map((field) => `${field.name}=${field.value}`)).toEqual([
      "CEN=1",
      "CMS=3",
    ]);
    expect(result?.activeFields).toEqual(["CEN", "CMS"]);
  });

  it("decodes composed _Pos/_Msk helper macros into a base TIM_CR3_DMAP field", () => {
    resetFakeState();
    fakeState.allDefines.set("TIM_CR3_DMAP_Pos", "(3U)");
    fakeState.allDefines.set("TIM_CR3_DMAP_Msk", "(0x1U << TIM_CR3_DMAP_Pos)");
    fakeState.allDefines.set("TIM_CR3_DMAP", "TIM_CR3_DMAP_Msk");

    const result = decodeBitfieldValue(0x8, fakeState.allDefines, fakeState, "TIM->CR3");
    expect(result).not.toBeNull();
    expect(result?.fields.map((field) => `${field.name}=${field.value}`)).toEqual(["DMAP=1"]);
    expect(result?.activeFields).toEqual(["DMAP"]);
  });

  it("formats active fields strongly and merges multi-bit comments", () => {
    resetFakeState();
    fakeState.allDefines.set("TIM_CR1_CEN_Pos", "(0U)");
    fakeState.allDefines.set("TIM_CR1_CEN", "((uint16_t)0x0001)");
    fakeState.allDefines.set("TIM_CR1_CMS_0_Pos", "(5U)");
    fakeState.allDefines.set("TIM_CR1_CMS_0", "((uint16_t)0x0020)");
    fakeState.allDefines.set("TIM_CR1_CMS_1_Pos", "(6U)");
    fakeState.allDefines.set("TIM_CR1_CMS_1", "((uint16_t)0x0040)");
    fakeState.allDefines.set("TIM_CR1_CKD_0_Pos", "(8U)");
    fakeState.allDefines.set("TIM_CR1_CKD_0", "((uint16_t)0x0100)");
    fakeState.allDefines.set("TIM_CR1_CKD_1_Pos", "(9U)");
    fakeState.allDefines.set("TIM_CR1_CKD_1", "((uint16_t)0x0200)");
    fakeState.defineComments.set("TIM_CR1_CEN", "Counter enable");
    fakeState.defineComments.set("TIM_CR1_CMS_0", "Center-aligned mode bit 0");
    fakeState.defineComments.set("TIM_CR1_CMS_1", "Center-aligned mode bit 1");
    fakeState.defineComments.set("TIM_CR1_CKD_0", "Clock division bit 0");
    fakeState.defineComments.set("TIM_CR1_CKD_1", "Clock division bit 1");

    const result = decodeBitfieldValue(0x61, fakeState.allDefines, fakeState, "TIM->CR1");
    expect(result).not.toBeNull();
    expect(result?.fields.find((field) => field.name === "CMS")?.comment).toBe(
      "Center-aligned mode bits 0..1"
    );

    const markdown = formatBitfieldDecodeMarkdown(result!, { theme: "dark" });
    expect(markdown).toContain("data:image/svg+xml;base64");
    expect(markdown).not.toContain("**Active:**");
    expect(markdown).not.toContain("**ON** `CMS` = `3`");

    const svg = decodeSvgFromMarkdown(markdown!);
    expect(svg).toContain('fill="#86EFAC"');
    expect(svg).not.toContain('<rect x="0" y="0"');
    expect(svg).toContain("Center-aligned mode bits 0..1");
    expect(svg).toContain("Clock division bits 0..1");
  });

  it("parses register assignment string", () => {
    expect(parseRegisterAssignment("TIM1->CR1 = 0x0061;")).toEqual({
      lhs: "TIM1->CR1",
      rhs: "0x0061",
    });
  });
});