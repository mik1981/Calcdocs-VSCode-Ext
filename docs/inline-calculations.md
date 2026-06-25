# Inline Calculations

Inline calculations run directly from comments in C/C++ source files (*.c, *.h, *.cpp, *.hpp).

> **Note:** Inline calculations (`=calc` / `@assign` syntax) are only supported in C/C++ files. YAML files use a separate formula system via `formula*.yaml` files — see [Formulas in YAML](formulas-yaml.md).

## Syntax

```c
// @vin = 12V
// @r = 4.7kOhm
// = @vin / @r -> mA

// = 25% * 200W -> W
// = 100 bar + 10 kPa -> atm
```

## Capabilities

- Variable assignment via `@name = ...`
- Unit-aware evaluation and conversion (`-> unit`)
- Dimensional checks with warnings/errors
- CodeLens + hover output

## Ignore Directives

```c
// = BAD_EXPR #calcdocs-ignore-error
// = A + B #calcdocs-ignore-warning
// calcdocs-ignore-line; = anything
```

Supported directives:

- `#calcdocs-ignore`
- `#calcdocs-ignore-error`
- `#calcdocs-ignore-warning`
- `#calcdocs-ignore-info`
- `calcdocs-ignore-line;`

## Relevant Settings

- `calcdocs.inline.codeLens.enabled`
- `calcdocs.inline.hover.enabled`
- `calcdocs.inline.diagnostics.level`

## Supported Units & Quantities

CalcDocs natively supports **over 180 units of measurement** organized into 20 physical quantity families, with automatic dimensional verification and conversion between compatible units.

| Physical Quantity | Supported Units |
|---|---|
| ✅ **Dimensionless / Ratios / Angles** | `count`, `ratio`, `%`, `ppm`, `ppb`, `ppt`, `rad`, `deg` |
| ✅ **Time** | `ns`, `us`, `ms`, `s`, `min`, `h`, `day` |
| ✅ **Length** | `pm`, `nm`, `um`, `mm`, `cm`, `dm`, `m`, `km`, `uin`, `mil`, `thou`, `in`, `ft`, `yd`, `mi`, `nmi` |
| ✅ **Area** | `mm2`, `cm2`, `m2`, `in2`, `ft2`, `yd2`, `ac`, `ha` |
| ✅ **Volume** | `ul`, `ml`, `l`, `cm3`, `m3`, `in3`, `ft3`, `floz`, `cup`, `pt`, `qt`, `gal`, `bbl` |
| ✅ **Velocity** | `ips`, `fps`, `mps`, `kmh`, `mph`, `knot` |
| ✅ **Acceleration** | `mps2`, `g0` (Earth's gravity) |
| ✅ **Frequency** | `hz`, `khz`, `mhz`, `ghz`, `rpm` |
| ✅ **Mass** | `ug`, `mg`, `g`, `kg`, `tonne`, `gr`, `oz`, `lb`, `st`, `slug`, `tonus`, `tonuk` |
| ✅ **Force** | `n`, `kn`, `ozf`, `lbf` |
| ✅ **Pressure** | `pa`, `hpa`, `kpa`, `mpa`, `mbar`, `bar`, `atm`, `torr`, `mmhg`, `inhg`, `psi`, `ksi` |
| ✅ **Torque / Moment** | `nmt`, `ozfin`, `lbfin`, `lbfft` |
| ✅ **Energy / Work** | `j`, `kj`, `mj`, `ev`, `cal`, `kcal`, `btu`, `wh`, `kwh` |
| ✅ **Power** | `mw`, `w`, `kw`, `mwatt`, `hp`, `btuh` |
| ✅ **Volumetric Flow Rates** | `m3s`, `lpm`, `gpm`, `cfm` |
| ✅ **Electric Current** | `ua`, `ma`, `a` |
| ✅ **Electric Voltage** | `mv`, `v`, `kv` |
| ✅ **Electrical Resistance** | `ohm`, `kohm`, `mohm` |
| ✅ **Electrical Conductance** | `usiemens`, `msiemens`, `siemens` |
| ✅ **Electrical Capacitance** | `pf`, `nf`, `uf`, `mf`, `f` |
| ✅ **Electrical Inductance** | `nhry`, `uhry`, `mhry`, `hry` |
| ✅ **Magnetic Flux** | `wb` |
| ✅ **Magnetic Flux Density** | `gauss`, `mt`, `t` |
| ✅ **Density** | `kgm3`, `gcm3`, `lbft3` |
| ✅ **Dynamic Viscosity** | `cp`, `pas` |
| ✅ **Temperature** | `k`, `degc`, `degf`, `rankine` |

### Additional Notes

- All units are also available with extended aliases (e.g., `meter`, `volt`, `pascal`, `newton`, `kilogram`, etc.).
- Units can be combined using operators `*` and `/` to create compound quantities.
- The system automatically verifies dimensional compatibility during operations.
- Conversions between units of the same family are automatic and precise.
- **Extended metric prefixes (multiples & submultiples)** are supported automatically for many prefixable units (e.g. `mm`, `cm`, `km`, `mV`, `kOhm`, `uF`, …).
- For units based on powers (square/cubic), prefixes are propagated with the correct exponent (e.g. `mm2`, `cm3`, …).



