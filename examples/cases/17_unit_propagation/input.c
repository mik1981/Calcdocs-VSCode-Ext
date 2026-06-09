/**
 * Case 17: Inline unit calculations
 *
 * Tests the @var = expr and = expr -> unit comment syntax evaluated by
 * evaluateInlineCalcs().  Each @test marker binds an ID to a result so
 * the integration test runner can match it against expected.yaml.
 *
 * All conversions are physically correct:
 *   12 V / 4.7 kΩ = 2.553 mA
 *   12 V * 2.553 mA = 30.638 mW
 *   1 atm = 1013.25 mbar
 *   25 degC = 298.15 K
 */

// @test I_mA    12V / 4.7kohm -> mA
// @test P_mW    12V * (12V / 4.7kohm) -> mW
// @test P_mbar  1 atm -> mbar
// @test T_K     25 degC -> K
// @test L_mm    1.5 m -> mm
// @test V_kmh   72 m/s -> km/h
