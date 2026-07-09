import { describe, expect, it } from "vitest";
import { collectDocumentSymbolDefinitions } from "../../src/core/documentSymbols";

describe("else block parsing bug", () => {
  it("CASO A: else block with assignment DC = (uint16)DCPre >> E_KPRECKX should be found", () => {
    const text = [
      'else if (DCPre < (fDC_to_nDC(f_DC_MIN1)*KPRECKX))',
      '{',
      '    DCPre = fDC_to_nDC(f_DC_MIN1)*KPRECKX;',
      '    T_on_req = (uint8)fDC_to_nDC(f_DC_MIN1);',
      '    // T_off_req = KDC - T_on_req;',
      '}',
      'else',
      '{',
      '    DC = (uint16)DCPre >> E_KPRECKX;',
      '    T_on_req = (uint8)(DC);',
      '    // T_off_req = KDC - T_on_req;',
      '}',
      '',
    ].join("\n");

    const definitions = collectDocumentSymbolDefinitions(text);
    
    // Debug: print all definitions
    console.log("All definitions:");
    for (const d of definitions) {
      console.log(`  line=${d.line} name="${d.parsed.name}" expr="${d.parsed.expr}" isAssignment=${d.isAssignment}`);
    }

    // DCPre should be found
    const dcPreDefs = definitions.filter(d => d.parsed.name === "DCPre");
    expect(dcPreDefs.length).toBeGreaterThanOrEqual(1);
    expect(dcPreDefs[0].parsed.expr).toBe("fDC_to_nDC(f_DC_MIN1)*KPRECKX");

    // DC should be found
    const dcDefs = definitions.filter(d => d.parsed.name === "DC");
    expect(dcDefs.length).toBeGreaterThanOrEqual(1);
    expect(dcDefs[0].parsed.expr).toBe("(uint16)DCPre >> E_KPRECKX");
  });

  it("CASO B: with # before else if, DC should also be found", () => {
    const text = [
      '#',
      'else if (DCPre < (fDC_to_nDC(f_DC_MIN1)*KPRECKX))',
      '{',
      '    DCPre = fDC_to_nDC(f_DC_MIN1)*KPRECKX;',
      '    T_on_req = (uint8)fDC_to_nDC(f_DC_MIN1);',
      '    // T_off_req = KDC - T_on_req;',
      '}',
      'else',
      '{',
      '    DC = (uint16)DCPre >> E_KPRECKX;',
      '    T_on_req = (uint8)(DC);',
      '    // T_off_req = KDC - T_on_req;',
      '}',
      '',
    ].join("\n");

    const definitions = collectDocumentSymbolDefinitions(text);
    
    console.log("All definitions (with #):");
    for (const d of definitions) {
      console.log(`  line=${d.line} name="${d.parsed.name}" expr="${d.parsed.expr}" isAssignment=${d.isAssignment}`);
    }

    const dcDefs = definitions.filter(d => d.parsed.name === "DC");
    expect(dcDefs.length).toBeGreaterThanOrEqual(1);
    expect(dcDefs[0].parsed.expr).toBe("(uint16)DCPre >> E_KPRECKX");
  });

  it("simple assignment with cast and shift should be found", () => {
    const text = 'DC = (uint16)DCPre >> E_KPRECKX;\n';
    const definitions = collectDocumentSymbolDefinitions(text);
    
    console.log("Simple assignment:");
    for (const d of definitions) {
      console.log(`  name="${d.parsed.name}" expr="${d.parsed.expr}"`);
    }

    expect(definitions.length).toBeGreaterThanOrEqual(1);
    expect(definitions[0].parsed.name).toBe("DC");
    expect(definitions[0].parsed.expr).toBe("(uint16)DCPre >> E_KPRECKX");
  });

  it("else { on same line should not break parsing of next assignment", () => {
    const text = [
      '}',
      'else {',
      '    DC = (uint16)DCPre >> E_KPRECKX;',
      '    T_on_req = (uint8)(DC);',
      '}',
      '',
    ].join("\n");

    const definitions = collectDocumentSymbolDefinitions(text);
    
    console.log("else { on same line:");
    for (const d of definitions) {
      console.log(`  line=${d.line} name="${d.parsed.name}" expr="${d.parsed.expr}"`);
    }

    const dcDefs = definitions.filter(d => d.parsed.name === "DC");
    expect(dcDefs.length).toBeGreaterThanOrEqual(1);
  });
});