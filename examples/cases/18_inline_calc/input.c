/**
 * Case 18: Multi-step inline calculation chain with @var assignments
 *
 * Exercises the sequential @var state machine in evaluateInlineCalcs():
 *   1. Assign @vin, @r1, @r2 from physical literals
 *   2. Compute intermediate @i and @p
 *   3. Verify final values via @test markers
 *
 * The runner accumulates variable state left-to-right within the file,
 * so each subsequent expression can reference previously assigned @vars.
 *
 * Expected numeric results (SI base units internally):
 *   @vin = 24 V  → 24
 *   @r1  = 10 kohm → 10000
 *   @r2  = 22 kohm → 22000
 *   @r_par = r1*r2/(r1+r2) = 10000*22000/32000 = 6875
 *   @i   = vin / r1 = 24/10000 = 0.0024 A
 *   @p   = vin * i  = 24 * 0.0024 = 0.0576 W
 */

// @vin  = 24V
// @r1   = 10 kohm
// @r2   = 22 kohm
// @r_par = @r1 * @r2 / (@r1 + @r2)
// @i    = @vin / @r1
// @p    = @vin * @i

// @test VIN_V    @vin -> V
// @test R1_K     @r1 -> kohm
// @test RPAR_OHM @r_par -> ohm
// @test I_UA     @i -> uA
// @test P_UW     @p -> uW
