import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { appendHexToLargeIntegers } from "../../src/utils/nformat";

const state = {} as any;

describe("appendHexToLargeIntegers", () => {
  it("affianca l'esadecimale al valore grande dell'esempio reale", () => {
    const out = appendHexToLargeIntegers(state, "(T_ALL TYPE)2'156'920'832");
    console.log("OUT:", out);
    assert.ok(out.includes("(0x"));
  });
  it("non tocca i numeri piccoli", () => {
    const out = appendHexToLargeIntegers(state, "= 42");
    console.log("SMALL:", out);
    assert.equal(out, "= 42");
  });
  it("non tocca i letterali esadecimali", () => {
    const out = appendHexToLargeIntegers(state, "= 0x8086'0000");
    console.log("HEX:", out);
    assert.equal(out, "= 0x8086'0000");
  });
  it("non duplica se gia' annotato", () => {
    const first = appendHexToLargeIntegers(state, "2'156'920'832");
    const twice = appendHexToLargeIntegers(state, first);
    console.log("TWICE:", twice);
    assert.equal(first, twice);
  });
});
