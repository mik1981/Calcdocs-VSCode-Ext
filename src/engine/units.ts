export type DimensionVector = {
  M: number;
  L: number;
  T: number;
  I: number;
  K: number;
};


export function isDimensionless(dim: DimensionVector): boolean {
  return (
    dim.M === 0 &&
    dim.L === 0 &&
    dim.T === 0 &&
    dim.I === 0 &&
    dim.K === 0
  );
}

export function formatDimension(dim: DimensionVector): string {
  if (isDimensionless(dim)) {
    return '1';
  }

  return Object.entries(dim)
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => `${key}^${value}`)
    .join(' ');
}

export function multiplyDimensions(
  a: DimensionVector,
  b: DimensionVector
): DimensionVector {
  return {
    M: a.M + b.M,
    L: a.L + b.L,
    T: a.T + b.T,
    I: a.I + b.I,
    K: a.K + b.K,
  };
}

export function divideDimensions(
  a: DimensionVector,
  b: DimensionVector
): DimensionVector {
  return {
    M: a.M - b.M,
    L: a.L - b.L,
    T: a.T - b.T,
    I: a.I - b.I,
    K: a.K - b.K,
  };
}

export type UnitSpec = {
  token: string;
  canonical: string;
  factorToSi: number;
  dimension: DimensionVector;
  family?: string;
  aliases?: string[];
  toSi?: (value: number) => number;
  fromSi?: (valueSi: number) => number;
};

export type ParsedUnit = {
  token: string;
  factor: number;
  factorToSi: number;
  unit: UnitSpec;
  displayUnit: string;
};

export type Quantity = {
  valueSi: number;
  dimension: DimensionVector;
  preferredUnit?: string;
  displayUnit?: string;
};

export type UnitResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type UnitDefinition = Omit<UnitSpec, "dimension"> & {
  dimension: DimensionVector;
  prefixable?: boolean;
  prefixBase?: string;
  prefixCanonicalBase?: string;
  prefixes?: readonly string[];
};

type SiPrefix = {
  symbol: string;
  factor: number;
};

const EPSILON = 1e-12;

export const DIMENSIONLESS: DimensionVector = dim(0, 0, 0, 0);

const SI_PREFIXES: readonly SiPrefix[] = [
  { symbol: "q", factor: 1e-30 },
  { symbol: "r", factor: 1e-27 },
  { symbol: "y", factor: 1e-24 },
  { symbol: "z", factor: 1e-21 },
  { symbol: "a", factor: 1e-18 },
  { symbol: "f", factor: 1e-15 },
  { symbol: "p", factor: 1e-12 },
  { symbol: "n", factor: 1e-9 },
  { symbol: "u", factor: 1e-6 },
  { symbol: "m", factor: 1e-3 },
  { symbol: "c", factor: 1e-2 },
  { symbol: "d", factor: 1e-1 },
  { symbol: "da", factor: 1e1 },
  { symbol: "h", factor: 1e2 },
  { symbol: "k", factor: 1e3 },
  { symbol: "M", factor: 1e6 },
  { symbol: "G", factor: 1e9 },
  { symbol: "T", factor: 1e12 },
  { symbol: "P", factor: 1e15 },
  { symbol: "E", factor: 1e18 },
  { symbol: "Z", factor: 1e21 },
  { symbol: "Y", factor: 1e24 },
  { symbol: "R", factor: 1e27 },
  { symbol: "Q", factor: 1e30 },
];

const COMMON_ENGINEERING_PREFIXES = [
  "p",
  "n",
  "u",
  "m",
  "c",
  "d",
  "k",
  "M",
  "G",
  "T",
] as const;

const ELECTRICAL_PREFIXES = [
  "p",
  "n",
  "u",
  "m",
  "k",
  "M",
  "G",
  "T",
] as const;

function dim(M: number, L: number, T: number, I: number, K: number = 0): DimensionVector {
  return { M, L, T, I, K };
}

function cloneDimension(source: DimensionVector): DimensionVector {
  return {
    M: source.M,
    L: source.L,
    T: source.T,
    I: source.I,
    K: source.K,
  };
}

export function addDimensions(
  left: DimensionVector,
  right: DimensionVector
): DimensionVector {
  return {
    M: left.M + right.M,
    L: left.L + right.L,
    T: left.T + right.T,
    I: left.I + right.I,
    K: left.K + right.K,
  };
}

export function subtractDimensions(
  left: DimensionVector,
  right: DimensionVector
): DimensionVector {
  return {
    M: left.M - right.M,
    L: left.L - right.L,
    T: left.T - right.T,
    I: left.I - right.I,
    K: left.K - right.K,
  };
}

export function dimensionsEqual(
  left: DimensionVector,
  right: DimensionVector
): boolean {
  return (
    Math.abs(left.M - right.M) < EPSILON &&
    Math.abs(left.L - right.L) < EPSILON &&
    Math.abs(left.T - right.T) < EPSILON &&
    Math.abs(left.I - right.I) < EPSILON &&
    Math.abs(left.K - right.K) < EPSILON
  );
}

function formatExponent(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(6).replace(/\.?0+$/, "");
}


export const BASE_UNITS: UnitDefinition[] = [
  { token: "count", canonical: "count", factorToSi: 1, dimension: dim(0, 0, 0, 0), family: "dimensionless" },
  { token: "ratio", canonical: "ratio", factorToSi: 1, dimension: dim(0, 0, 0, 0), family: "dimensionless" },
  { token: "%", canonical: "%", factorToSi: 0.01, dimension: dim(0, 0, 0, 0), family: "ratio" },
  { token: "pct", canonical: "pct", factorToSi: 0.01, dimension: dim(0, 0, 0, 0), family: "ratio" },
  { token: "ppm", canonical: "ppm", factorToSi: 1e-6, dimension: dim(0, 0, 0, 0), family: "ratio" },
  { token: "ppb", canonical: "ppb", factorToSi: 1e-9, dimension: dim(0, 0, 0, 0), family: "ratio" },
  { token: "ppt", canonical: "ppt", factorToSi: 1e-12, dimension: dim(0, 0, 0, 0), family: "ratio" },
  { token: "rad", canonical: "rad", factorToSi: 1, dimension: dim(0, 0, 0, 0), family: "angle" },
  { token: "deg", canonical: "deg", factorToSi: Math.PI / 180, dimension: dim(0, 0, 0, 0), family: "angle" },
  { token: "dB", canonical: "dB", factorToSi: 1, dimension: dim(0, 0, 0, 0), family: "logarithmic" },
  { token: "dBm", canonical: "dBm", factorToSi: 1, dimension: dim(0, 0, 0, 0), family: "logarithmic" },
  { token: "dBV", canonical: "dBV", factorToSi: 1, dimension: dim(0, 0, 0, 0), family: "logarithmic" },
  { token: "bit", canonical: "bit", factorToSi: 1, dimension: dim(0, 0, 0, 0), family: "data" },
  { token: "byte", canonical: "byte", factorToSi: 8, dimension: dim(0, 0, 0, 0), family: "data" },
  { token: "baud", canonical: "baud", factorToSi: 1, dimension: dim(0, 0, -1, 0), family: "frequency" },

  { token: "s", canonical: "s", factorToSi: 1, dimension: dim(0, 0, 1, 0), family: "time", prefixable: true, prefixes: COMMON_ENGINEERING_PREFIXES },
  { token: "min", canonical: "min", factorToSi: 60, dimension: dim(0, 0, 1, 0), family: "time" },
  { token: "h", canonical: "h", factorToSi: 3600, dimension: dim(0, 0, 1, 0), family: "time" },
  { token: "day", canonical: "day", factorToSi: 86400, dimension: dim(0, 0, 1, 0), family: "time" },

  { token: "m", canonical: "m", factorToSi: 1, dimension: dim(0, 1, 0, 0), family: "length", prefixable: true },
  { token: "in", canonical: "in", factorToSi: 0.0254, dimension: dim(0, 1, 0, 0), family: "length" },
  { token: "uin", canonical: "uin", factorToSi: 0.0254e-6, dimension: dim(0, 1, 0, 0), family: "length" },
  { token: "mil", canonical: "mil", factorToSi: 0.0254e-3, dimension: dim(0, 1, 0, 0), family: "length" },
  { token: "thou", canonical: "thou", factorToSi: 0.0254e-3, dimension: dim(0, 1, 0, 0), family: "length" },
  { token: "ft", canonical: "ft", factorToSi: 0.3048, dimension: dim(0, 1, 0, 0), family: "length" },
  { token: "yd", canonical: "yd", factorToSi: 0.9144, dimension: dim(0, 1, 0, 0), family: "length" },
  { token: "mi", canonical: "mi", factorToSi: 1609.344, dimension: dim(0, 1, 0, 0), family: "length" },
  { token: "nmi", canonical: "nmi", factorToSi: 1852, dimension: dim(0, 1, 0, 0), family: "length" },

  { token: "m2", canonical: "m2", factorToSi: 1, dimension: dim(0, 2, 0, 0), family: "area", prefixable: true, prefixBase: "m2", prefixCanonicalBase: "m2" },
  { token: "in2", canonical: "in2", factorToSi: 0.0254 ** 2, dimension: dim(0, 2, 0, 0), family: "area" },
  { token: "ft2", canonical: "ft2", factorToSi: 0.3048 ** 2, dimension: dim(0, 2, 0, 0), family: "area" },
  { token: "yd2", canonical: "yd2", factorToSi: 0.9144 ** 2, dimension: dim(0, 2, 0, 0), family: "area" },
  { token: "ac", canonical: "ac", factorToSi: 4046.8564224, dimension: dim(0, 2, 0, 0), family: "area" },
  { token: "ha", canonical: "ha", factorToSi: 10000, dimension: dim(0, 2, 0, 0), family: "area" },

  { token: "m3", canonical: "m3", factorToSi: 1, dimension: dim(0, 3, 0, 0), family: "volume", prefixable: true, prefixBase: "m3", prefixCanonicalBase: "m3" },
  { token: "L", canonical: "L", factorToSi: 1e-3, dimension: dim(0, 3, 0, 0), family: "volume", prefixable: true, prefixes: COMMON_ENGINEERING_PREFIXES },
  { token: "in3", canonical: "in3", factorToSi: 0.0254 ** 3, dimension: dim(0, 3, 0, 0), family: "volume" },
  { token: "ft3", canonical: "ft3", factorToSi: 0.3048 ** 3, dimension: dim(0, 3, 0, 0), family: "volume" },
  { token: "gal", canonical: "gal", factorToSi: 0.003785411784, dimension: dim(0, 3, 0, 0), family: "volume" },
  { token: "qt", canonical: "qt", factorToSi: 0.000946352946, dimension: dim(0, 3, 0, 0), family: "volume" },
  { token: "pt", canonical: "pt", factorToSi: 0.000473176473, dimension: dim(0, 3, 0, 0), family: "volume" },
  { token: "cup", canonical: "cup", factorToSi: 0.0002365882365, dimension: dim(0, 3, 0, 0), family: "volume" },
  { token: "floz", canonical: "fl oz", factorToSi: 2.95735295625e-5, dimension: dim(0, 3, 0, 0), family: "volume" },
  { token: "bbl", canonical: "bbl", factorToSi: 0.158987, dimension: dim(0, 3, 0, 0), family: "volume" },

  { token: "g", canonical: "g", factorToSi: 1e-3, dimension: dim(1, 0, 0, 0), family: "mass", prefixable: true },
  { token: "t", canonical: "t", factorToSi: 1000, dimension: dim(1, 0, 0, 0), family: "mass" },
  { token: "tonne", canonical: "tonne", factorToSi: 1000, dimension: dim(1, 0, 0, 0), family: "mass" },
  { token: "lb", canonical: "lb", factorToSi: 0.45359237, dimension: dim(1, 0, 0, 0), family: "mass" },
  { token: "oz", canonical: "oz", factorToSi: 0.028349523125, dimension: dim(1, 0, 0, 0), family: "mass" },
  { token: "st", canonical: "st", factorToSi: 6.35029318, dimension: dim(1, 0, 0, 0), family: "mass" },
  { token: "slug", canonical: "slug", factorToSi: 14.5939029, dimension: dim(1, 0, 0, 0), family: "mass" },
  { token: "gr", canonical: "gr", factorToSi: 64.79891e-6, dimension: dim(1, 0, 0, 0), family: "mass" },
  { token: "tonus", canonical: "ton(US)", factorToSi: 907.18474, dimension: dim(1, 0, 0, 0), family: "mass" },
  { token: "tonuk", canonical: "ton(UK)", factorToSi: 1016.0469088, dimension: dim(1, 0, 0, 0), family: "mass" },

  { token: "N", canonical: "N", factorToSi: 1, dimension: dim(1, 1, -2, 0), family: "force", prefixable: true, prefixes: COMMON_ENGINEERING_PREFIXES },
  { token: "lbf", canonical: "lbf", factorToSi: 4.4482216152605, dimension: dim(1, 1, -2, 0), family: "force" },
  { token: "ozf", canonical: "ozf", factorToSi: 0.27801385, dimension: dim(1, 1, -2, 0), family: "force" },
  { token: "Pa", canonical: "Pa", factorToSi: 1, dimension: dim(1, -1, -2, 0), family: "pressure", prefixable: true, prefixes: COMMON_ENGINEERING_PREFIXES },
  { token: "bar", canonical: "bar", factorToSi: 1e5, dimension: dim(1, -1, -2, 0), family: "pressure", prefixable: true, prefixes: ["m"] },
  { token: "atm", canonical: "atm", factorToSi: 101325, dimension: dim(1, -1, -2, 0), family: "pressure" },
  { token: "torr", canonical: "torr", factorToSi: 133.322368421, dimension: dim(1, -1, -2, 0), family: "pressure" },
  { token: "mmHg", canonical: "mmHg", factorToSi: 133.322, dimension: dim(1, -1, -2, 0), family: "pressure" },
  { token: "inHg", canonical: "inHg", factorToSi: 3386.389, dimension: dim(1, -1, -2, 0), family: "pressure" },
  { token: "psi", canonical: "psi", factorToSi: 6894.757293168, dimension: dim(1, -1, -2, 0), family: "pressure" },
  { token: "ksi", canonical: "ksi", factorToSi: 6_894_757.293168, dimension: dim(1, -1, -2, 0), family: "pressure" },
  { token: "Nmt", canonical: "N*m", factorToSi: 1, dimension: dim(1, 2, -2, 0), family: "torque" },
  { token: "lbfft", canonical: "lbf*ft", factorToSi: 1.3558179483314004, dimension: dim(1, 2, -2, 0), family: "torque" },
  { token: "lbfin", canonical: "lbf*in", factorToSi: 0.112984829, dimension: dim(1, 2, -2, 0), family: "torque" },
  { token: "ozfin", canonical: "ozf*in", factorToSi: 0.0070615518, dimension: dim(1, 2, -2, 0), family: "torque" },

  { token: "J", canonical: "J", factorToSi: 1, dimension: dim(1, 2, -2, 0), family: "energy", prefixable: true, prefixes: COMMON_ENGINEERING_PREFIXES },
  { token: "eV", canonical: "eV", factorToSi: 1.602176634e-19, dimension: dim(1, 2, -2, 0), family: "energy", prefixable: true, prefixes: ELECTRICAL_PREFIXES },
  { token: "cal", canonical: "cal", factorToSi: 4.184, dimension: dim(1, 2, -2, 0), family: "energy", prefixable: true, prefixes: ["k"] },
  { token: "BTU", canonical: "BTU", factorToSi: 1055.05585262, dimension: dim(1, 2, -2, 0), family: "energy" },
  { token: "Wh", canonical: "Wh", factorToSi: 3600, dimension: dim(1, 2, -2, 0), family: "energy", prefixable: true, prefixes: ELECTRICAL_PREFIXES },
  { token: "W", canonical: "W", factorToSi: 1, dimension: dim(1, 2, -3, 0), family: "power", prefixable: true, prefixes: ELECTRICAL_PREFIXES },
  { token: "hp", canonical: "hp", factorToSi: 745.6998715822702, dimension: dim(1, 2, -3, 0), family: "power" },
  { token: "btuh", canonical: "BTU/h", factorToSi: 1055.05585262 / 3600, dimension: dim(1, 2, -3, 0), family: "power" },
  { token: "Hz", canonical: "Hz", factorToSi: 1, dimension: dim(0, 0, -1, 0), family: "frequency", prefixable: true, prefixes: COMMON_ENGINEERING_PREFIXES },

  { token: "mps", canonical: "m/s", factorToSi: 1, dimension: dim(0, 1, -1, 0), family: "speed" },
  { token: "kmh", canonical: "km/h", factorToSi: 1000 / 3600, dimension: dim(0, 1, -1, 0), family: "speed" },
  { token: "mph", canonical: "mph", factorToSi: 1609.344 / 3600, dimension: dim(0, 1, -1, 0), family: "speed" },
  { token: "fps", canonical: "ft/s", factorToSi: 0.3048, dimension: dim(0, 1, -1, 0), family: "speed" },
  { token: "ips", canonical: "in/s", factorToSi: 0.0254, dimension: dim(0, 1, -1, 0), family: "speed" },
  { token: "knot", canonical: "knot", factorToSi: 1852 / 3600, dimension: dim(0, 1, -1, 0), family: "speed" },
  { token: "mps2", canonical: "m/s2", factorToSi: 1, dimension: dim(0, 1, -2, 0), family: "acceleration" },
  { token: "g0", canonical: "g0", factorToSi: 9.80665, dimension: dim(0, 1, -2, 0), family: "acceleration" },
  { token: "rpm", canonical: "rpm", factorToSi: (2 * Math.PI) / 60, dimension: dim(0, 0, -1, 0), family: "angular_velocity" },
  { token: "radps", canonical: "rad/s", factorToSi: 1, dimension: dim(0, 0, -1, 0), family: "angular_velocity" },
  { token: "radps2", canonical: "rad/s2", factorToSi: 1, dimension: dim(0, 0, -2, 0), family: "angular_acceleration" },
  { token: "degps2", canonical: "deg/s2", factorToSi: Math.PI / 180, dimension: dim(0, 0, -2, 0), family: "angular_acceleration" },
  { token: "rpmps", canonical: "rpm/s", factorToSi: (2 * Math.PI) / 60, dimension: dim(0, 0, -2, 0), family: "angular_acceleration" },

  { token: "Lpm", canonical: "L/min", factorToSi: 1e-3 / 60, dimension: dim(0, 3, -1, 0), family: "flow" },
  { token: "mLpm", canonical: "mL/min", factorToSi: 1e-6 / 60, dimension: dim(0, 3, -1, 0), family: "flow" },
  { token: "gpm", canonical: "gal/min", factorToSi: 0.003785411784 / 60, dimension: dim(0, 3, -1, 0), family: "flow" },
  { token: "m3s", canonical: "m3/s", factorToSi: 1, dimension: dim(0, 3, -1, 0), family: "flow" },
  { token: "cfm", canonical: "ft3/min", factorToSi: (0.3048 ** 3) / 60, dimension: dim(0, 3, -1, 0), family: "flow" },

  { token: "A", canonical: "A", factorToSi: 1, dimension: dim(0, 0, 0, 1), family: "current", prefixable: true, prefixes: ELECTRICAL_PREFIXES },
  { token: "C", canonical: "C", factorToSi: 1, dimension: dim(0, 0, 1, 1), family: "charge", prefixable: true, prefixes: ELECTRICAL_PREFIXES },
  { token: "Ah", canonical: "Ah", factorToSi: 3600, dimension: dim(0, 0, 1, 1), family: "charge", prefixable: true, prefixes: ELECTRICAL_PREFIXES },
  { token: "V", canonical: "V", factorToSi: 1, dimension: dim(1, 2, -3, -1), family: "voltage", prefixable: true, prefixes: ELECTRICAL_PREFIXES },
  { token: "Ohm", canonical: "Ohm", factorToSi: 1, dimension: dim(1, 2, -3, -2), family: "resistance", prefixable: true, prefixBase: "Ohm", prefixCanonicalBase: "Ohm", prefixes: ELECTRICAL_PREFIXES },
  { token: "S", canonical: "S", factorToSi: 1, dimension: dim(-1, -2, 3, 2), family: "conductance", prefixable: true, prefixes: ELECTRICAL_PREFIXES },
  { token: "F", canonical: "F", factorToSi: 1, dimension: dim(-1, -2, 4, 2), family: "capacitance", prefixable: true, prefixes: ELECTRICAL_PREFIXES },
  { token: "H", canonical: "H", factorToSi: 1, dimension: dim(1, 2, -2, -2), family: "inductance", prefixable: true, prefixes: ELECTRICAL_PREFIXES },
  { token: "Wb", canonical: "Wb", factorToSi: 1, dimension: dim(1, 2, -2, -1), family: "magnetic_flux", prefixable: true, prefixes: ELECTRICAL_PREFIXES },
  { token: "T", canonical: "T", factorToSi: 1, dimension: dim(1, 0, -2, -1), family: "magnetic_flux_density", prefixable: true, prefixes: ELECTRICAL_PREFIXES },
  { token: "gauss", canonical: "G", factorToSi: 1e-4, dimension: dim(1, 0, -2, -1), family: "magnetic_flux_density" },

  { token: "kgm3", canonical: "kg/m3", factorToSi: 1, dimension: dim(1, -3, 0, 0), family: "density" },
  { token: "gcm3", canonical: "g/cm3", factorToSi: 1000, dimension: dim(1, -3, 0, 0), family: "density" },
  { token: "lbft3", canonical: "lb/ft3", factorToSi: 16.01846337396014, dimension: dim(1, -3, 0, 0), family: "density" },
  { token: "Pas", canonical: "Pa*s", factorToSi: 1, dimension: dim(1, -1, -1, 0), family: "viscosity" },
  { token: "cP", canonical: "cP", factorToSi: 1e-3, dimension: dim(1, -1, -1, 0), family: "viscosity" },

  { token: "K", canonical: "K", factorToSi: 1, dimension: dim(0, 0, 0, 0, 1), family: "temperature", prefixable: true, prefixes: ELECTRICAL_PREFIXES },
  {
    token: "degC",
    canonical: "degC",
    factorToSi: 1,
    dimension: dim(0, 0, 0, 0, 1),
    family: "temperature",
    toSi: (value) => value + 273.15,
    fromSi: (valueSi) => valueSi - 273.15,
  },
  {
    token: "degF",
    canonical: "degF",
    factorToSi: 5 / 9,
    dimension: dim(0, 0, 0, 0, 1),
    family: "temperature",
    toSi: (value) => (value + 459.67) * 5 / 9,
    fromSi: (valueSi) => valueSi * 9 / 5 - 459.67,
  },
  { token: "rankine", canonical: "R", factorToSi: 5 / 9, dimension: dim(0, 0, 0, 0, 1), family: "temperature" },

  { token: "Npm", canonical: "N/m", factorToSi: 1, dimension: dim(1, 0, -2, 0), family: "stiffness" },
  { token: "kNpm", canonical: "kN/m", factorToSi: 1e3, dimension: dim(1, 0, -2, 0), family: "stiffness" },
  { token: "mNpm", canonical: "mN/m", factorToSi: 1e-3, dimension: dim(1, 0, -2, 0), family: "stiffness" },
  { token: "lbfpin", canonical: "lbf/in", factorToSi: 4.4482216152605 / 0.0254, dimension: dim(1, 0, -2, 0), family: "stiffness" },
  { token: "kgps", canonical: "kg/s", factorToSi: 1, dimension: dim(1, 0, -1, 0), family: "mass_flow" },
  { token: "gps", canonical: "g/s", factorToSi: 1e-3, dimension: dim(1, 0, -1, 0), family: "mass_flow" },
  { token: "kgpm", canonical: "kg/min", factorToSi: 1 / 60, dimension: dim(1, 0, -1, 0), family: "mass_flow" },
  { token: "kgph", canonical: "kg/h", factorToSi: 1 / 3600, dimension: dim(1, 0, -1, 0), family: "mass_flow" },
  { token: "kgm2", canonical: "kg*m2", factorToSi: 1, dimension: dim(1, 2, 0, 0), family: "moment_of_inertia" },
  { token: "kgcm2", canonical: "kg*cm2", factorToSi: 1e-4, dimension: dim(1, 2, 0, 0), family: "moment_of_inertia" },
  { token: "gcm2", canonical: "g*cm2", factorToSi: 1e-7, dimension: dim(1, 2, 0, 0), family: "moment_of_inertia" },
  { token: "m2ps", canonical: "m2/s", factorToSi: 1, dimension: dim(0, 2, -1, 0), family: "kinematic_viscosity" },
  { token: "mm2ps", canonical: "mm2/s", factorToSi: 1e-6, dimension: dim(0, 2, -1, 0), family: "kinematic_viscosity" },
  { token: "stk", canonical: "St", factorToSi: 1e-4, dimension: dim(0, 2, -1, 0), family: "kinematic_viscosity" },
  { token: "cstk", canonical: "cSt", factorToSi: 1e-6, dimension: dim(0, 2, -1, 0), family: "kinematic_viscosity" },
  { token: "Jpkg", canonical: "J/kg", factorToSi: 1, dimension: dim(0, 2, -2, 0), family: "specific_energy" },
  { token: "kJpkg", canonical: "kJ/kg", factorToSi: 1e3, dimension: dim(0, 2, -2, 0), family: "specific_energy" },
  { token: "MJpkg", canonical: "MJ/kg", factorToSi: 1e6, dimension: dim(0, 2, -2, 0), family: "specific_energy" },
  { token: "Whpkg", canonical: "Wh/kg", factorToSi: 3600, dimension: dim(0, 2, -2, 0), family: "specific_energy" },
  { token: "kWhpkg", canonical: "kWh/kg", factorToSi: 3_600_000, dimension: dim(0, 2, -2, 0), family: "specific_energy" },
  { token: "KpW", canonical: "K/W", factorToSi: 1, dimension: dim(-1, -2, 3, 0, 1), family: "thermal_resistance" },
  { token: "degCpW", canonical: "degC/W", factorToSi: 1, dimension: dim(-1, -2, 3, 0, 1), family: "thermal_resistance" },
  { token: "WpmK", canonical: "W/(m*K)", factorToSi: 1, dimension: dim(1, 1, -3, 0, -1), family: "thermal_conductivity" },
  { token: "mWpmK", canonical: "mW/(m*K)", factorToSi: 1e-3, dimension: dim(1, 1, -3, 0, -1), family: "thermal_conductivity" },
  { token: "WpcmK", canonical: "W/(cm*K)", factorToSi: 100, dimension: dim(1, 1, -3, 0, -1), family: "thermal_conductivity" },
  { token: "JpkgK", canonical: "J/(kg*K)", factorToSi: 1, dimension: dim(0, 2, -2, 0, -1), family: "specific_heat" },
  { token: "kJpkgK", canonical: "kJ/(kg*K)", factorToSi: 1e3, dimension: dim(0, 2, -2, 0, -1), family: "specific_heat" },
  { token: "Wpm2", canonical: "W/m2", factorToSi: 1, dimension: dim(1, 0, -3, 0), family: "heat_flux" },
  { token: "kWpm2", canonical: "kW/m2", factorToSi: 1e3, dimension: dim(1, 0, -3, 0), family: "heat_flux" },
  { token: "mWpm2", canonical: "mW/m2", factorToSi: 1e-3, dimension: dim(1, 0, -3, 0), family: "heat_flux" },
  { token: "Wpcm2", canonical: "W/cm2", factorToSi: 1e4, dimension: dim(1, 0, -3, 0), family: "heat_flux" },
  { token: "Apm2", canonical: "A/m2", factorToSi: 1, dimension: dim(0, -2, 0, 1), family: "current_density" },
  { token: "kApm2", canonical: "kA/m2", factorToSi: 1e3, dimension: dim(0, -2, 0, 1), family: "current_density" },
  { token: "Apmm2", canonical: "A/mm2", factorToSi: 1e6, dimension: dim(0, -2, 0, 1), family: "current_density" },
  { token: "mApmm2", canonical: "mA/mm2", factorToSi: 1e3, dimension: dim(0, -2, 0, 1), family: "current_density" },
  { token: "Vpm", canonical: "V/m", factorToSi: 1, dimension: dim(1, 1, -3, -1), family: "electric_field" },
  { token: "kVpm", canonical: "kV/m", factorToSi: 1e3, dimension: dim(1, 1, -3, -1), family: "electric_field" },
  { token: "mVpm", canonical: "mV/m", factorToSi: 1e-3, dimension: dim(1, 1, -3, -1), family: "electric_field" },
];

function expandUnitDefinitions(definitions: readonly UnitDefinition[]): UnitSpec[] {
  const specs: UnitSpec[] = [];
  const seenTokens = new Set<string>();

  const add = (definition: UnitDefinition): void => {
    if (seenTokens.has(definition.token)) {
      return;
    }

    seenTokens.add(definition.token);
    specs.push({
      token: definition.token,
      canonical: definition.canonical,
      factorToSi: definition.factorToSi,
      dimension: cloneDimension(definition.dimension),
      family: definition.family,
      aliases: definition.aliases,
      toSi: definition.toSi,
      fromSi: definition.fromSi,
    });
  };

  for (const definition of definitions) {
    add(definition);

    if (!definition.prefixable) {
      continue;
    }

    const prefixes = new Set(definition.prefixes ?? SI_PREFIXES.map((prefix) => prefix.symbol));
    const baseToken = definition.prefixBase ?? definition.token;
    const baseCanonical = definition.prefixCanonicalBase ?? definition.canonical;

    for (const prefix of SI_PREFIXES) {
      if (!prefixes.has(prefix.symbol)) {
        continue;
      }

      const power =
        definition.token === "m2" ? 2 :
        definition.token === "m3" ? 3 :
        1;

      add({
        token: `${prefix.symbol}${baseToken}`,
        canonical: `${prefix.symbol}${baseCanonical}`,
        factorToSi: definition.factorToSi * prefix.factor ** power,
        dimension: definition.dimension,
        family: definition.family,
      });
    }
  }

  return specs;
}

export const UNIT_SPEC_LIST: UnitSpec[] = expandUnitDefinitions(BASE_UNITS);

export const UNIT_SPECS = new Map<string, UnitSpec>(
  UNIT_SPEC_LIST.map((spec) => [spec.token, spec])
);

export const SCALABLE_UNIT_FAMILY = new Map<string, string>(
  UNIT_SPEC_LIST
    .filter((spec) => spec.family)
    .map((spec) => [spec.token, spec.family as string])
);

export const UNIT_ALIASES = new Map<string, string>();

function trimUnitBrackets(rawUnit: string): string {
  return rawUnit.trim().replace(/^\[+/, "").replace(/\]+$/, "").trim();
}

function normalizeUnitGlyphs(rawUnit: string): string {
  return trimUnitBrackets(rawUnit)
    .replace(/[\u00B5\u03BC]/g, "u")
    .replace(/[\u03A9\u03C9]/g, "Ohm")
    .replace(/\u00B2/g, "2")
    .replace(/\u00B3/g, "3")
    .replace(/\u00B7/g, "*")
    .replace(/\s+/g, "");
}

function addAlias(alias: string, token: string): void {
  if (!UNIT_SPECS.has(token)) {
    return;
  }

  const normalizedAlias = normalizeUnitGlyphs(alias);
  if (!normalizedAlias || UNIT_ALIASES.has(normalizedAlias)) {
    return;
  }

  UNIT_ALIASES.set(normalizedAlias, token);
}

for (const spec of UNIT_SPEC_LIST) {
  addAlias(spec.token, spec.token);
  if (spec.canonical !== spec.token) {
    addAlias(spec.canonical, spec.token);
  }
}

const LEGACY_ALIASES: Array<[string, string]> = [
  ["counts", "count"],
  ["percent", "%"],
  ["percentage", "%"],
  ["degree", "deg"],
  ["degrees", "deg"],
  ["radian", "rad"],
  ["radians", "rad"],
  ["db", "dB"],
  ["dbm", "dBm"],
  ["dbv", "dBV"],
  ["bits", "bit"],
  ["bytes", "byte"],
  ["bps", "baud"],
  ["Bd", "baud"],

  ["sec", "s"],
  ["secs", "s"],
  ["second", "s"],
  ["seconds", "s"],
  ["us", "us"],
  ["mins", "min"],
  ["minute", "min"],
  ["minutes", "min"],
  ["hr", "h"],
  ["hrs", "h"],
  ["hour", "h"],
  ["hours", "h"],
  ["days", "day"],

  ["meter", "m"],
  ["meters", "m"],
  ["metre", "m"],
  ["metres", "m"],
  ["micron", "um"],
  ["microns", "um"],
  ["nanometer", "nm"],
  ["picometer", "pm"],
  ["inch", "in"],
  ["inches", "in"],
  ["microinch", "uin"],
  ["microinches", "uin"],
  ["mils", "mil"],
  ["foot", "ft"],
  ["feet", "ft"],
  ["yard", "yd"],
  ["yards", "yd"],
  ["mile", "mi"],
  ["miles", "mi"],
  ["nauticalmile", "nmi"],
  ["nauticalmiles", "nmi"],

  ["m^2", "m2"],
  ["cm^2", "cm2"],
  ["mm^2", "mm2"],
  ["in^2", "in2"],
  ["ft^2", "ft2"],
  ["yd^2", "yd2"],
  ["acre", "ac"],
  ["acres", "ac"],
  ["hectare", "ha"],
  ["hectares", "ha"],
  ["m^3", "m3"],
  ["cm^3", "cm3"],
  ["mm^3", "mm3"],
  ["in^3", "in3"],
  ["ft^3", "ft3"],
  ["l", "L"],
  ["liter", "L"],
  ["liters", "L"],
  ["litre", "L"],
  ["litres", "L"],
  ["ml", "mL"],
  ["milliliter", "mL"],
  ["milliliters", "mL"],
  ["millilitre", "mL"],
  ["millilitres", "mL"],
  ["ul", "uL"],
  ["microliter", "uL"],
  ["microliters", "uL"],
  ["microlitre", "uL"],
  ["microlitres", "uL"],
  ["gallon", "gal"],
  ["gallons", "gal"],
  ["quart", "qt"],
  ["quarts", "qt"],
  ["pint", "pt"],
  ["pints", "pt"],
  ["cups", "cup"],
  ["fl_oz", "floz"],
  ["fl-oz", "floz"],
  ["fluidounce", "floz"],
  ["fluidounces", "floz"],
  ["barrel", "bbl"],
  ["barrels", "bbl"],

  ["kg", "kg"],
  ["kilogram", "kg"],
  ["kilograms", "kg"],
  ["gram", "g"],
  ["grams", "g"],
  ["metric-ton", "tonne"],
  ["mt", "tonne"],
  ["lbs", "lb"],
  ["pound", "lb"],
  ["pounds", "lb"],
  ["ounce", "oz"],
  ["ounces", "oz"],
  ["stone", "st"],
  ["stones", "st"],
  ["slugs", "slug"],
  ["grain", "gr"],
  ["grains", "gr"],
  ["ton_us", "tonus"],
  ["ton_uk", "tonuk"],

  ["n", "N"],
  ["newton", "N"],
  ["newtons", "N"],
  ["kn", "kN"],
  ["pa", "Pa"],
  ["pascal", "Pa"],
  ["pascals", "Pa"],
  ["hpa", "hPa"],
  ["hectopascal", "hPa"],
  ["hectopascals", "hPa"],
  ["kpa", "kPa"],
  ["kilopascal", "kPa"],
  ["kilopascals", "kPa"],
  ["mpa", "MPa"],
  ["megapascal", "MPa"],
  ["megapascals", "MPa"],
  ["bars", "bar"],
  ["mbar", "mbar"],
  ["millibar", "mbar"],
  ["millibars", "mbar"],
  ["atmosphere", "atm"],
  ["atmospheres", "atm"],
  ["mmhg", "mmHg"],
  ["inhg", "inHg"],
  ["nmt", "Nmt"],
  ["n*m", "Nmt"],
  ["newtonmeter", "Nmt"],
  ["newtonmeters", "Nmt"],
  ["lbf*ft", "lbfft"],
  ["lbf*in", "lbfin"],
  ["ozf*in", "ozfin"],

  ["j", "J"],
  ["joule", "J"],
  ["joules", "J"],
  ["kj", "kJ"],
  ["mj", "MJ"],
  ["ev", "eV"],
  ["electronvolt", "eV"],
  ["electronvolts", "eV"],
  ["kcal", "kcal"],
  ["btu", "BTU"],
  ["wh", "Wh"],
  ["kwh", "kWh"],
  ["w", "W"],
  ["watt", "W"],
  ["watts", "W"],
  ["mw", "mW"],
  ["kw", "kW"],
  ["mwatt", "MW"],
  ["horsepower", "hp"],
  ["btu/h", "btuh"],
  ["hz", "Hz"],
  ["khz", "kHz"],
  ["mhz", "MHz"],
  ["ghz", "GHz"],

  ["m/s", "mps"],
  ["km/h", "kmh"],
  ["kph", "kmh"],
  ["mi/h", "mph"],
  ["ft/s", "fps"],
  ["in/s", "ips"],
  ["knots", "knot"],
  ["m/s2", "mps2"],
  ["m/s^2", "mps2"],
  ["rad/s", "radps"],
  ["rad per s", "radps"],
  ["rad*s", "radps"],
  ["rad/s2", "radps2"],
  ["rad/s^2", "radps2"],
  ["deg/s2", "degps2"],
  ["rpm/s", "rpmps"],

  ["lpm", "Lpm"],
  ["l/min", "Lpm"],
  ["mlpm", "mLpm"],
  ["ml/min", "mLpm"],
  ["gal/min", "gpm"],
  ["m3/s", "m3s"],
  ["ft3/min", "cfm"],

  ["a", "A"],
  ["amp", "A"],
  ["amps", "A"],
  ["ampere", "A"],
  ["amperes", "A"],
  ["ma", "mA"],
  ["ua", "uA"],
  ["c", "C"],
  ["ah", "Ah"],
  ["mah", "mAh"],
  ["v", "V"],
  ["volt", "V"],
  ["volts", "V"],
  ["mv", "mV"],
  ["kv", "kV"],
  ["ohm", "Ohm"],
  ["ohms", "Ohm"],
  ["kohm", "kOhm"],
  ["mohm", "MOhm"],
  ["siemens", "S"],
  ["msiemens", "mS"],
  ["usiemens", "uS"],
  ["f", "F"],
  ["farad", "F"],
  ["farads", "F"],
  ["mf", "mF"],
  ["uf", "uF"],
  ["nf", "nF"],
  ["pf", "pF"],
  ["hry", "H"],
  ["henry", "H"],
  ["mhenry", "mH"],
  ["uhenry", "uH"],
  ["nhenry", "nH"],
  ["mh", "mH"],
  ["uh", "uH"],
  ["nh", "nH"],
  ["wb", "Wb"],
  ["tesla", "T"],
  ["gss", "gauss"],

  ["kg/m3", "kgm3"],
  ["g/cm3", "gcm3"],
  ["lb/ft3", "lbft3"],
  ["pas", "Pas"],
  ["pa*s", "Pas"],
  ["cp", "cP"],

  ["k", "K"],
  ["kelvin", "K"],
  ["degc", "degC"],
  ["celsius", "degC"],
  ["degf", "degF"],
  ["fahrenheit", "degF"],
  ["r", "rankine"],

  ["npm", "Npm"],
  ["n/m", "Npm"],
  ["knpm", "kNpm"],
  ["kn/m", "kNpm"],
  ["mnpm", "mNpm"],
  ["mn/m", "mNpm"],
  ["lbf/in", "lbfpin"],
  ["kg/s", "kgps"],
  ["g/s", "gps"],
  ["kg/min", "kgpm"],
  ["kg/h", "kgph"],
  ["kg*m2", "kgm2"],
  ["kg*m^2", "kgm2"],
  ["kg*cm2", "kgcm2"],
  ["kg*cm^2", "kgcm2"],
  ["g*cm2", "gcm2"],
  ["m2/s", "m2ps"],
  ["m^2/s", "m2ps"],
  ["mm2/s", "mm2ps"],
  ["mm^2/s", "mm2ps"],
  ["stokes", "stk"],
  ["cst", "cstk"],
  ["centistokes", "cstk"],
  ["jpkg", "Jpkg"],
  ["j/kg", "Jpkg"],
  ["kjpkg", "kJpkg"],
  ["kj/kg", "kJpkg"],
  ["mjpkg", "MJpkg"],
  ["mj/kg", "MJpkg"],
  ["whpkg", "Whpkg"],
  ["wh/kg", "Whpkg"],
  ["kwhpkg", "kWhpkg"],
  ["kwh/kg", "kWhpkg"],
  ["kpw", "KpW"],
  ["k/w", "KpW"],
  ["degcpw", "degCpW"],
  ["c/w", "degCpW"],
  ["wpmk", "WpmK"],
  ["w/mk", "WpmK"],
  ["w/(m*k)", "WpmK"],
  ["mwpmk", "mWpmK"],
  ["mw/mk", "mWpmK"],
  ["mw/(m*k)", "mWpmK"],
  ["wpcmk", "WpcmK"],
  ["w/(cm*k)", "WpcmK"],
  ["jpkgk", "JpkgK"],
  ["j/kgk", "JpkgK"],
  ["j/(kg*k)", "JpkgK"],
  ["kjpkgk", "kJpkgK"],
  ["kj/kgk", "kJpkgK"],
  ["kj/(kg*k)", "kJpkgK"],
  ["wpm2", "Wpm2"],
  ["w/m2", "Wpm2"],
  ["w/m^2", "Wpm2"],
  ["kwpm2", "kWpm2"],
  ["kw/m2", "kWpm2"],
  ["mwpm2", "mWpm2"],
  ["mw/m2", "mWpm2"],
  ["wpcm2", "Wpcm2"],
  ["w/cm2", "Wpcm2"],
  ["apm2", "Apm2"],
  ["a/m2", "Apm2"],
  ["a/m^2", "Apm2"],
  ["kapm2", "kApm2"],
  ["ka/m2", "kApm2"],
  ["apmm2", "Apmm2"],
  ["a/mm2", "Apmm2"],
  ["mapmm2", "mApmm2"],
  ["ma/mm2", "mApmm2"],
  ["vpm", "Vpm"],
  ["v/m", "Vpm"],
  ["kvpm", "kVpm"],
  ["kv/m", "kVpm"],
  ["mvpm", "mVpm"],
  ["mv/m", "mVpm"],
];

for (const [alias, token] of LEGACY_ALIASES) {
  addAlias(alias, token);
}

for (const spec of UNIT_SPEC_LIST) {
  const lowerToken = normalizeUnitGlyphs(spec.token).toLowerCase();
  if (!UNIT_ALIASES.has(lowerToken)) {
    addAlias(lowerToken, spec.token);
  }
}

export const UNIT_SCALE_FACTORS = new Map<string, number>(
  UNIT_SPEC_LIST.map((spec) => [spec.token, spec.factorToSi])
);

export const UNITS = Array.from(UNIT_SPECS.keys());

export const UNIT_DIM = new Map<string, DimensionVector>(
  UNIT_SPEC_LIST.map((spec) => [spec.token, spec.dimension])
);

const NON_SI_NORMALIZATION_TOKENS = new Set<string>([
  "in",
  "uin",
  "mil",
  "thou",
  "ft",
  "yd",
  "mi",
  "nmi",
  "lb",
  "oz",
  "st",
  "slug",
  "gr",
  "tonus",
  "tonuk",
  "lbf",
  "ozf",
  "atm",
  "torr",
  "mmHg",
  "inHg",
  "psi",
  "ksi",
  "BTU",
  "hp",
  "btuh",
  "gal",
  "qt",
  "pt",
  "cup",
  "floz",
  "bbl",
]);

const NON_ENGINEERING_SI_PREFIXES = ["da", "h", "d", "c"] as const;

function resolveUnitToken(rawUnit: string): string | undefined {
  const trimmed = trimUnitBrackets(rawUnit);
  if (!trimmed) {
    return undefined;
  }

  if (UNIT_SPECS.has(trimmed)) {
    return trimmed;
  }

  const glyphNormalized = normalizeUnitGlyphs(trimmed);
  if (UNIT_SPECS.has(glyphNormalized)) {
    return glyphNormalized;
  }

  const alias = UNIT_ALIASES.get(glyphNormalized);
  if (alias) {
    return alias;
  }

  const lowerAlias = UNIT_ALIASES.get(glyphNormalized.toLowerCase());
  if (lowerAlias) {
    return lowerAlias;
  }

  return undefined;
}

export function normalizeUnitToken(rawUnit: string): string {
  const directToken = resolveUnitToken(rawUnit);
  if (directToken) {
    return directToken;
  }

  const trimmed = trimUnitBrackets(rawUnit);
  return trimmed.replace(/[A-Za-z%][A-Za-z0-9_%]*/g, (token) => {
    const resolved = resolveUnitToken(token);
    return resolved ?? normalizeUnitGlyphs(token).toLowerCase();
  });
}

export function getUnitSpec(rawUnit: string): UnitSpec | undefined {
  const token = resolveUnitToken(rawUnit);
  return token ? UNIT_SPECS.get(token) : undefined;
}

export function getUnitFamily(rawUnit: string): string | undefined {
  const spec = getUnitSpec(rawUnit);
  return spec ? SCALABLE_UNIT_FAMILY.get(spec.token) : undefined;
}

function specValueToSi(value: number, spec: UnitSpec): number {
  return spec.toSi ? spec.toSi(value) : value * spec.factorToSi;
}

function specSiToValue(valueSi: number, spec: UnitSpec): number {
  return spec.fromSi ? spec.fromSi(valueSi) : valueSi / spec.factorToSi;
}

export function convertUnitValueToSi(value: number, rawUnit: string): UnitResult<number> {
  const spec = getUnitSpec(rawUnit);
  if (spec) {
    return {
      ok: true,
      value: specValueToSi(value, spec),
    };
  }

  const parsed = parseUnitToQuantity(rawUnit);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `unknown unit '${rawUnit}'`,
    };
  }

  return {
    ok: true,
    value: value * parsed.value.valueSi,
  };
}

export function convertSiToUnit(valueSi: number, rawUnit: string): UnitResult<number> {
  const spec = getUnitSpec(rawUnit);
  if (spec) {
    return {
      ok: true,
      value: specSiToValue(valueSi, spec),
    };
  }

  const parsed = parseUnitToQuantity(rawUnit);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `unknown unit '${rawUnit}'`,
    };
  }

  return {
    ok: true,
    value: valueSi / parsed.value.valueSi,
  };
}

function displayUnitForRaw(rawUnit: string, spec: UnitSpec): string {
  const cleaned = trimUnitBrackets(rawUnit)
    .replace(/\u00B5/g, "\u03BC")
    .replace(/\u03C9/g, "\u03A9");

  if (/[\u03BC\u03A9]/.test(cleaned)) {
    return cleaned;
  }

  return spec.canonical;
}

export function parseUnitToken(token: string): ParsedUnit {
  const spec = getUnitSpec(token);
  if (!spec) {
    throw new Error(`unknown unit '${token}'`);
  }

  return {
    token: spec.token,
    factor: spec.factorToSi,
    factorToSi: spec.factorToSi,
    unit: spec,
    displayUnit: displayUnitForRaw(token, spec),
  };
}

export function createDimensionlessQuantity(value: number): Quantity {
  return {
    valueSi: value,
    dimension: cloneDimension(DIMENSIONLESS),
  };
}

export function parseUnitToQuantity(raw: string): UnitResult<Quantity> {
  try {
    const parser = new UnitParser(raw);
    return parser.parse();
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * Decompone un token unità come "A2" in base "A" + esponente 2.
 * Restituisce undefined se il token è già un'unità conosciuta o se la base non è valida.
 */
function decomposeUnitToken(token: string): { base: Quantity; exponent: number } | undefined {
  const match = token.match(/^([A-Za-z%][A-Za-z%]*?)(\d+)$/);
  if (!match) return undefined;

  const baseToken = match[1];
  const exponent = parseFloat(match[2]);
  if (isNaN(exponent)) return undefined;

  const spec = getUnitSpec(baseToken);
  if (!spec) return undefined;

  return {
    base: {
      valueSi: spec.factorToSi,
      dimension: cloneDimension(spec.dimension),
      preferredUnit: spec.token,
      displayUnit: spec.canonical,
    },
    exponent,
  };
}

class UnitParser {
  private tokens: string[];
  private cursor = 0;

  constructor(input: string) {
    const trimmed = trimUnitBrackets(input).trim();
    const regex = /([A-Za-z%][A-Za-z0-9_%]*|[\*\/^()]|-?\d+(?:\.\d+)?)/g;
    this.tokens = trimmed.match(regex) || [];
  }

  private peek(): string | undefined {
    return this.tokens[this.cursor];
  }

  private next(): string | undefined {
    return this.tokens[this.cursor++];
  }

  parse(): UnitResult<Quantity> {
    if (this.tokens.length === 0) {
      return { ok: true, value: createDimensionlessQuantity(1) };
    }
    try {
      const result = this.parseExpression();
      if (this.cursor < this.tokens.length) {
        throw new Error(`Unexpected token '${this.peek()}'`);
      }
      return { ok: true, value: result };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  private parseExpression(): Quantity {
    let left = this.parseTerm();
    while (
      this.peek() === "*" ||
      this.peek() === "/" ||
      (this.peek() && !["*", "/", "^", ")"].includes(this.peek()!))
    ) {
      const op = this.peek();
      if (op === "*" || op === "/") {
        this.next();
        const right = this.parseTerm();
        const res =
          op === "*"
            ? multiplyQuantities(left, right)
            : divideQuantities(left, right);
        if (!res.ok) {
          throw new Error(res.error);
        }
        left = res.value;
      } else {
        const right = this.parseTerm();
        const res = multiplyQuantities(left, right);
        if (!res.ok) {
          throw new Error(res.error);
        }
        left = res.value;
      }
    }
    return left;
  }

  private parseTerm(): Quantity {
    let q = this.parseFactor();
    if (this.peek() === "^") {
      this.next();
      const exponentToken = this.next();
      if (!exponentToken) {
        throw new Error("Expected exponent after '^'");
      }
      const exponent = parseFloat(exponentToken);
      if (isNaN(exponent)) {
        throw new Error(`Invalid exponent '${exponentToken}'`);
      }
      q = this.powerQuantity(q, exponent);
    }
    return q;
  }

  private parseFactor(): Quantity {
    const token = this.next();
    if (!token) {
      throw new Error("Unexpected end of unit expression");
    }

    if (token === "(") {
      const q = this.parseExpression();
      if (this.next() !== ")") {
        throw new Error("Expected ')'");
      }
      return q;
    }

    if (token === "1") {
      return createDimensionlessQuantity(1);
    }

    const spec = getUnitSpec(token);
    if (!spec) {
      // Prova a decomporre "A2" → "A^2", "V3" → "V^3" (unità base + esponente)
      const decomposed = decomposeUnitToken(token);
      if (decomposed) {
        return this.powerQuantity(decomposed.base, decomposed.exponent);
      }

      const num = parseFloat(token);
      if (!isNaN(num)) {
        return createDimensionlessQuantity(num);
      }
      throw new Error(`Unknown unit '${token}'`);
    }

    return {
      valueSi: spec.factorToSi,
      dimension: cloneDimension(spec.dimension),
      preferredUnit: spec.token,
      displayUnit: spec.canonical,
    };
  }

  private powerQuantity(q: Quantity, exponent: number): Quantity {
    return {
      valueSi: Math.pow(q.valueSi, exponent),
      dimension: {
        M: q.dimension.M * exponent,
        L: q.dimension.L * exponent,
        T: q.dimension.T * exponent,
        I: q.dimension.I * exponent,
        K: q.dimension.K * exponent,
      },
      displayUnit: q.displayUnit ? `${q.displayUnit}^${exponent}` : undefined,
    };
  }
}

export function createQuantity(value: number, rawUnit?: string): UnitResult<Quantity> {
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      error: `non-finite numeric value: ${value}`,
    };
  }

  if (!rawUnit || rawUnit.trim().length === 0) {
    return {
      ok: true,
      value: createDimensionlessQuantity(value),
    };
  }

  const parsedUnit = parseUnitToQuantity(rawUnit);
  if (!parsedUnit.ok) {
    return {
      ok: false,
      error: parsedUnit.error,
    };
  }

  const unitQ = parsedUnit.value;

  const singleSpec = getUnitSpec(rawUnit);
  if (singleSpec && (singleSpec.toSi || singleSpec.fromSi)) {
    return {
      ok: true,
      value: {
        valueSi: specValueToSi(value, singleSpec),
        dimension: cloneDimension(singleSpec.dimension),
        preferredUnit: singleSpec.token,
        displayUnit: displayUnitForRaw(rawUnit, singleSpec),
      },
    };
  }

  return {
    ok: true,
    value: {
      valueSi: value * unitQ.valueSi,
      dimension: unitQ.dimension,
      preferredUnit: unitQ.preferredUnit,
      displayUnit: unitQ.displayUnit ?? rawUnit,
    },
  };
}

/**
 * Creates a quantity from a plain data value that is already expressed in
 * `rawUnit` (CSV/table/lookup cells, YAML constants, external symbols).
 * It shares the same internal representation as unit literals: valueSi is
 * converted once on input, while preferredUnit/displayUnit preserve the
 * original unit for presentation.
 */
export function createQuantityFromData(
  value: number,
  rawUnit: string
): UnitResult<Quantity> {
  return createQuantity(value, rawUnit);
}

export function convertQuantityToUnit(
  quantity: Quantity,
  rawUnit: string
): UnitResult<number> {
  const parsedUnit = parseUnitToQuantity(rawUnit);
  if (!parsedUnit.ok) {
    return {
      ok: false,
      error: parsedUnit.error,
    };
  }

  const unitQ = parsedUnit.value;

  if (!dimensionsEqual(quantity.dimension, unitQ.dimension)) {
    return {
      ok: false,
      error:
        `unit mismatch: expression has ${formatDimension(quantity.dimension)} ` +
        `but '${rawUnit}' expects ${formatDimension(unitQ.dimension)}`,
    };
  }

  const singleSpec = getUnitSpec(rawUnit);
  if (singleSpec && (singleSpec.toSi || singleSpec.fromSi)) {
    return {
      ok: true,
      value: specSiToValue(quantity.valueSi, singleSpec),
    };
  }

  return {
    ok: true,
    value: quantity.valueSi / unitQ.valueSi,
  };
}

function buildCompositeUnit(
  left: string | undefined,
  right: string | undefined,
  operator: "*" | "/"
): string | undefined {
  if (!left && !right) {
    return undefined;
  }

  if (!left) {
    return operator === "*" ? right : `1/${right}`;
  }

  if (!right) {
    return left;
  }

  return operator === "*" ? `${left}*${right}` : `${left}/${right}`;
}

function unitText(quantity: Quantity): string | undefined {
  if (quantity.displayUnit) {
    return quantity.displayUnit;
  }

  if (quantity.preferredUnit) {
    const spec = UNIT_SPECS.get(quantity.preferredUnit);
    return spec?.canonical;
  }

  return undefined;
}

function linearPreferredUnit(quantity: Quantity): string | undefined {
  if (!quantity.preferredUnit) {
    return undefined;
  }

  const spec = UNIT_SPECS.get(quantity.preferredUnit);
  return spec && !spec.toSi && !spec.fromSi ? spec.token : undefined;
}

export function addQuantities(left: Quantity, right: Quantity): UnitResult<Quantity> {
  if (!dimensionsEqual(left.dimension, right.dimension)) {
    return {
      ok: false,
      error:
        `cannot add incompatible units: ${formatDimension(left.dimension)} ` +
        `and ${formatDimension(right.dimension)}`,
    };
  }

  const preferredUnit = linearPreferredUnit(left) ?? linearPreferredUnit(right);
  const displayUnit = preferredUnit
    ? unitText(left) ?? unitText(right)
    : undefined;

  return {
    ok: true,
    value: {
      valueSi: left.valueSi + right.valueSi,
      dimension: cloneDimension(left.dimension),
      preferredUnit,
      displayUnit,
    },
  };
}

export function subtractQuantities(
  left: Quantity,
  right: Quantity
): UnitResult<Quantity> {
  if (!dimensionsEqual(left.dimension, right.dimension)) {
    return {
      ok: false,
      error:
        `cannot subtract incompatible units: ${formatDimension(left.dimension)} ` +
        `and ${formatDimension(right.dimension)}`,
    };
  }

  const preferredUnit = linearPreferredUnit(left) ?? linearPreferredUnit(right);
  const displayUnit = preferredUnit
    ? unitText(left) ?? unitText(right)
    : undefined;

  return {
    ok: true,
    value: {
      valueSi: left.valueSi - right.valueSi,
      dimension: cloneDimension(left.dimension),
      preferredUnit,
      displayUnit,
    },
  };
}

export function multiplyQuantities(
  left: Quantity,
  right: Quantity
): UnitResult<Quantity> {
  if (!Number.isFinite(left.valueSi) || !Number.isFinite(right.valueSi)) {
    return {
      ok: false,
      error: "non-finite multiplication operand",
    };
  }

  if (isDimensionless(left.dimension)) {
    return {
      ok: true,
      value: {
        valueSi: left.valueSi * right.valueSi,
        dimension: cloneDimension(right.dimension),
        preferredUnit: right.preferredUnit,
        displayUnit: right.displayUnit,
      },
    };
  }

  if (isDimensionless(right.dimension)) {
    return {
      ok: true,
      value: {
        valueSi: left.valueSi * right.valueSi,
        dimension: cloneDimension(left.dimension),
        preferredUnit: left.preferredUnit,
        displayUnit: left.displayUnit,
      },
    };
  }

  return {
    ok: true,
    value: {
      valueSi: left.valueSi * right.valueSi,
      dimension: addDimensions(left.dimension, right.dimension),
      displayUnit: buildCompositeUnit(unitText(left), unitText(right), "*"),
    },
  };
}

export function divideQuantities(left: Quantity, right: Quantity): UnitResult<Quantity> {
  if (!Number.isFinite(left.valueSi) || !Number.isFinite(right.valueSi)) {
    return {
      ok: false,
      error: "non-finite division operand",
    };
  }

  if (Math.abs(right.valueSi) < EPSILON) {
    return {
      ok: false,
      error: "division by zero",
    };
  }

  if (isDimensionless(right.dimension)) {
    return {
      ok: true,
      value: {
        valueSi: left.valueSi / right.valueSi,
        dimension: cloneDimension(left.dimension),
        preferredUnit: left.preferredUnit,
        displayUnit: left.displayUnit,
      },
    };
  }

  return {
    ok: true,
    value: {
      valueSi: left.valueSi / right.valueSi,
      dimension: subtractDimensions(left.dimension, right.dimension),
      displayUnit: buildCompositeUnit(unitText(left), unitText(right), "/"),
    },
  };
}

export function negateQuantity(input: Quantity): Quantity {
  return {
    ...input,
    valueSi: -input.valueSi,
  };
}

export function toDisplayValue(quantity: Quantity): number {
  if (!quantity.preferredUnit) {
    return quantity.valueSi;
  }

  const spec = UNIT_SPECS.get(quantity.preferredUnit);
  if (!spec) {
    return quantity.valueSi;
  }

  return specSiToValue(quantity.valueSi, spec);
}

export function toDisplayUnit(quantity: Quantity): string | undefined {
  if (quantity.displayUnit) {
    return quantity.displayUnit;
  }

  if (quantity.preferredUnit) {
    const spec = UNIT_SPECS.get(quantity.preferredUnit);
    return spec?.canonical;
  }

  if (isDimensionless(quantity.dimension)) {
    return undefined;
  }

  return formatDimension(quantity.dimension);
}

function scoreNormalizedMagnitude(absValue: number): number {
  if (!Number.isFinite(absValue) || absValue === 0) {
    return 0;
  }

  const logMagnitude = Math.log10(absValue);
  let score = Math.abs(logMagnitude - 1.5);
  if (absValue < 1 || absValue >= 1000) {
    score += 2;
  }

  return score;
}

function scoreNormalizationUnitPenalty(spec: UnitSpec): number {
  if (NON_SI_NORMALIZATION_TOKENS.has(spec.token)) {
    return 2.5;
  }

  for (const definition of BASE_UNITS) {
    if (!definition.prefixable) {
      continue;
    }

    const baseToken = definition.prefixBase ?? definition.token;
    for (const prefix of NON_ENGINEERING_SI_PREFIXES) {
      if (spec.token === `${prefix}${baseToken}`) {
        return 2;
      }
    }
  }

  return 0;
}

export function normalizeUnit(
  value: number,
  rawUnit?: string
): { value: number; unit?: string } {
  if (!Number.isFinite(value)) {
    return {
      value,
      unit: rawUnit?.trim(),
    };
  }

  if (!rawUnit || rawUnit.trim().length === 0) {
    return {
      value,
    };
  }

  const cleanedUnit = trimUnitBrackets(rawUnit);
  const sourceSpec = getUnitSpec(cleanedUnit);
  if (!sourceSpec) {
    return {
      value,
      unit: cleanedUnit || undefined,
    };
  }

  if (sourceSpec.toSi || sourceSpec.fromSi) {
    return {
      value,
      unit: sourceSpec.canonical,
    };
  }

  const family = SCALABLE_UNIT_FAMILY.get(sourceSpec.token);
  if (!family) {
    return {
      value,
      unit: sourceSpec.canonical,
    };
  }

  const valueSi = specValueToSi(value, sourceSpec);
  let bestSpec = sourceSpec;
  let bestScore =
    scoreNormalizedMagnitude(Math.abs(value)) +
    scoreNormalizationUnitPenalty(sourceSpec);

  for (const candidate of UNIT_SPEC_LIST) {
    if (candidate.toSi || candidate.fromSi) {
      continue;
    }

    if (SCALABLE_UNIT_FAMILY.get(candidate.token) !== family) {
      continue;
    }

    if (!dimensionsEqual(candidate.dimension, sourceSpec.dimension)) {
      continue;
    }

    const candidateValue = specSiToValue(valueSi, candidate);
    if (!Number.isFinite(candidateValue)) {
      continue;
    }

    const score =
      scoreNormalizedMagnitude(Math.abs(candidateValue)) +
      scoreNormalizationUnitPenalty(candidate);
    if (score + EPSILON < bestScore) {
      bestScore = score;
      bestSpec = candidate;
    }
  }

  return {
    value: specSiToValue(valueSi, bestSpec),
    unit: bestSpec.canonical,
  };
}

export function applyOutputUnit(
  quantity: Quantity,
  rawUnit: string
): UnitResult<{ quantity: Quantity; displayValue: number; displayUnit: string }> {
  const parsedUnit = parseUnitToQuantity(rawUnit);
  if (!parsedUnit.ok) {
    return {
      ok: false,
      error: parsedUnit.error,
    };
  }

  const unitQ = parsedUnit.value;

  if (!dimensionsEqual(quantity.dimension, unitQ.dimension)) {
    return {
      ok: false,
      error:
        `unit mismatch: expression has ${formatDimension(quantity.dimension)} ` +
        `but output unit '${rawUnit}' requires ${formatDimension(unitQ.dimension)}`,
    };
  }

  const singleSpec = getUnitSpec(rawUnit);
  if (singleSpec && (singleSpec.toSi || singleSpec.fromSi)) {
    const displayValue = specSiToValue(quantity.valueSi, singleSpec);
    const displayUnit = displayUnitForRaw(rawUnit, singleSpec);
    return {
      ok: true,
      value: {
        quantity: {
          ...quantity,
          preferredUnit: singleSpec.token,
          displayUnit,
        },
        displayValue,
        displayUnit,
      },
    };
  }

  const displayValue = quantity.valueSi / unitQ.valueSi;
  const displayUnit = unitQ.displayUnit ?? rawUnit;

  return {
    ok: true,
    value: {
      quantity: {
        ...quantity,
        preferredUnit: unitQ.preferredUnit,
        displayUnit,
      },
      displayValue,
      displayUnit,
    },
  };
}

export function getUnit(symbol: string): UnitSpec | undefined {
  return getUnitSpec(symbol);
}

export function hasUnit(symbol: string): boolean {
  return Boolean(getUnitSpec(symbol));
}

export function getAllUnits(): UnitSpec[] {
  return UNIT_SPEC_LIST;
}

export function debugParse(token: string): void {
  const parsed = parseUnitToken(token);

  console.log({
    token,
    normalizedToken: parsed.token,
    factor: parsed.factorToSi,
    display: parsed.displayUnit,
  });
}
