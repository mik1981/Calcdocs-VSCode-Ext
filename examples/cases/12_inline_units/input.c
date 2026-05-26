#include <stdint.h>

// === Electrical ===
// @vin = 12 V
// @r = 4.7 kOhm

// @test I_mA @vin / @r -> mA 
// = @vin / @r -> mA
// @test P_W @vin * (@vin / @r) -> W 
// = @vin * (@vin / @r) -> W
// @test U_mv @vin -> mV 
// = @vin -> mV

// === Geometry ===
// @width = 0.95m
// @height = 0.9m

// @test A_m2 @width * @height -> m2 
// = @width * @height -> m2

// === Mass ===
// @mass = 2.5 lb

// @test M_g @mass -> g 
// = @mass -> g

// === Pressure ===
// @p1 = 1 atm
// @p2 = 1 bar

// @test P_mbar @p1 -> mbar
// = @p1 -> mbar
// @test P_Pa @p1 -> Pa
// = @p1 -> Pa

// @test P_atm @p1 + @p2 -> atm 
// = @p1 + @p2 -> atm

// === Flow rate ===
// @flow = 4.74 L/min

// @test Q_m3s @flow -> m3/s 
// = @flow -> m3/s

// === Temperature ===
// @test T_K 25 degC -> K 
// = 25 degC -> K

// === Time ===
// @period = 1.5 h

// @test T_s @period -> s 
// = @period -> s

// === Ratio ===
// @ratio = 0.25

// @test R_pct @ratio * 100% -> % 
// = @ratio * 100% -> %

// === Velocity ===
// @distance = 4.024 m
// @time = 100 s

// @test V_mps @distance / @time -> mps 
// = @distance / @time -> mps

// @rpm = 3000 rpm
// @test V_rads @rpm -> rad/s
// = @rpm -> rad/s

int inline_units_demo(void) {
  (void)0;
  return 0;
}