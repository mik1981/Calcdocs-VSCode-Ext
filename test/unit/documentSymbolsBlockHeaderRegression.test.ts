import { describe, expect, it } from "vitest";

import {
  collectDocumentSymbolDefinitions,
  collectDocumentSymbolDefinitionsInLineRanges,
} from "../../src/core/documentSymbols";

function names(defs: ReturnType<typeof collectDocumentSymbolDefinitions>): string[] {
  return defs.map((d) => d.parsed.name).filter((n) => n !== "");
}

describe("documentSymbols: block-header merge bug regression", () => {
  it("1) if/else with assignments inside both branches", () => {
    const src = `
if (x > 0)
{
    A = 1;
}
else
{
    B = 2;
}
`.trim();

    const defs = collectDocumentSymbolDefinitions(src);
    expect(names(defs)).toEqual(["A", "B"]);
  });

  it("2) else if with a complex, nested-call condition (the exact reported case)", () => {
    const src = `
else if (DCPre < (fDC_to_nDC(f_DC_MIN1)*KPRECKX))
{
    DCPre = fDC_to_nDC(f_DC_MIN1)*KPRECKX;
    T_on_req = (uint8)fDC_to_nDC(f_DC_MIN1);
    // T_off_req = KDC - T_on_req;
}
else
{
    DC = (uint16)DCPre >> E_KPRECKX;
    T_on_req = (uint8)(DC);
    // T_off_req = KDC - T_on_req;
}
`.trim();

    const defs = collectDocumentSymbolDefinitions(src);
    expect(names(defs)).toEqual(["DCPre", "T_on_req", "DC", "T_on_req"]);

    // The specific regression: DC must be resolvable even when only a
    // narrow viewport range around the second block is scanned (this is
    // what ghost-value/CodeLens scanning actually does in the editor).
    const lines = src.split("\n");
    const source = {
      lineCount: lines.length,
      lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    };
    // 0-indexed: "else" is line 6, its body spans 7-10.
    const rangedDefs = collectDocumentSymbolDefinitionsInLineRanges(source, [
      { startLine: 6, endLine: 10 },
    ]);
    expect(names(rangedDefs)).toContain("DC");
  });

  it("3) C-style cast on the right-hand side", () => {
    const src = `
void fn(void)
{
    result = (uint16)raw_value;
}
`.trim();

    const defs = collectDocumentSymbolDefinitions(src);
    expect(names(defs)).toContain("result");
    expect(defs.find((d) => d.parsed.name === "result")?.parsed.expr).toBe("(uint16)raw_value");
  });

  it("4) shift operator on the right-hand side", () => {
    const src = `
void fn(void)
{
    shifted = raw_value >> 4;
}
`.trim();

    const defs = collectDocumentSymbolDefinitions(src);
    expect(defs.find((d) => d.parsed.name === "shifted")?.parsed.expr).toBe("raw_value >> 4");
  });

  it("5) function call nested inside the assigned expression", () => {
    const src = `
void fn(void)
{
    scaled = fDC_to_nDC(f_DC_MIN1) * 2;
}
`.trim();

    const defs = collectDocumentSymbolDefinitions(src);
    expect(defs.find((d) => d.parsed.name === "scaled")?.parsed.expr).toBe(
      "fDC_to_nDC(f_DC_MIN1) * 2"
    );
  });

  it("6) multiple assignments on the same physical line", () => {
    const src = `
void fn(void)
{
    a = 1; b = 2; c = a + b;
}
`.trim();

    const defs = collectDocumentSymbolDefinitions(src);
    expect(names(defs)).toEqual(["a", "b", "c"]);
  });

  it("does not regress genuinely incomplete multi-line conditions (still merges correctly)", () => {
    const src = `
if (a > 0 &&
    b > 0)
{
    result = a + b;
}
`.trim();

    const defs = collectDocumentSymbolDefinitions(src);
    expect(names(defs)).toEqual(["result"]);
  });

  it("does not regress a bare 'else' immediately followed by an inline statement (no braces)", () => {
    const src = `
if (x > 0)
    A = 1;
else
    B = 2;
`.trim();

    const defs = collectDocumentSymbolDefinitions(src);
    expect(names(defs)).toEqual(["A", "B"]);
  });

  it("7) 'else if(cond)' shows its condition as a ghost, same as plain 'if(cond)'", () => {
    const src = `
if (A > 0)
{
    x = 1;
}
else if (DCPre < (fDC_to_nDC(f_DC_MIN1)*KPRECKX))
{
    y = 2;
}
`.trim();

    const defs = collectDocumentSymbolDefinitions(src);
    const anonymous = defs.filter((d) => d.parsed.name === "");
    expect(anonymous.map((d) => d.parsed.expr)).toEqual([
      "A > 0",
      "DCPre < (fDC_to_nDC(f_DC_MIN1)*KPRECKX)",
    ]);
  });

  it("8) compound assignment operators are recognized and expanded correctly", () => {
    const src = `
void fn(void)
{
    a += 1;
    b -= x;
    c *= 2;
    d /= 4;
    e %= 3;
    f &= 0xFF;
    g |= FLAG_BIT;
    h ^= mask;
    i <<= 2;
    j >>= E_KPRECKX;
}
`.trim();

    const defs = collectDocumentSymbolDefinitions(src);
    const byName = new Map(defs.map((d) => [d.parsed.name, d.parsed.expr]));

    expect(byName.get("a")).toBe("a + (1)");
    expect(byName.get("b")).toBe("b - (x)");
    expect(byName.get("c")).toBe("c * (2)");
    expect(byName.get("d")).toBe("d / (4)");
    expect(byName.get("e")).toBe("e % (3)");
    expect(byName.get("f")).toBe("f & (0xFF)");
    expect(byName.get("g")).toBe("g | (FLAG_BIT)");
    expect(byName.get("h")).toBe("h ^ (mask)");
    expect(byName.get("i")).toBe("i << (2)");
    expect(byName.get("j")).toBe("j >> (E_KPRECKX)");
  });

  it("does not regress comparison operators (==, <=, >=, !=) as false compound-assignment matches", () => {
    const src = `
void fn(void)
{
    if (a == b)
    {
        x = 1;
    }
    if (a <= b)
    {
        y = 2;
    }
    if (a >= b)
    {
        z = 3;
    }
    if (a != b)
    {
        w = 4;
    }
}
`.trim();

    const defs = collectDocumentSymbolDefinitions(src);
    const byName = new Map(defs.map((d) => [d.parsed.name, d.parsed.expr]));
    // Only the plain assignments inside the blocks should show up as "x/y/z/w"
    // assignments; the comparisons themselves must not be mistaken for
    // compound-assignment statements.
    expect(byName.get("x")).toBe("1");
    expect(byName.get("y")).toBe("2");
    expect(byName.get("z")).toBe("3");
    expect(byName.get("w")).toBe("4");
  });
});