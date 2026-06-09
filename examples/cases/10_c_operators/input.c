#include <stdint.h>

// Test case for all C operators supported by CalcDocs
// Arithmetic operators
#define ADD (5 + 3)
#define SUB (10 - 3)
#define MUL (4 * 5)
#define DIV (20 / 4)
#define MOD (17 % 5)
#define NEG (-5)

// Arithmetic operators with hexadecimal operands
#define HEX_ADD (0x10 + 0x05)
#define HEX_SUB (0x20 - 0x0A)
#define HEX_MUL (0x04 * 0x05)
#define HEX_DIV (0x40 / 0x08)
#define HEX_MOD (0x11 % 0x05)
#define HEX_NEG (-0x0A)

// Bitwise operators
#define LSHIFT (1 << 4)
#define RSHIFT (32 >> 2)
#define BITAND (0xFF & 0x0F)
#define BITOR (0xF0 | 0x0F)
#define BITXOR (0xFF ^ 0x0F)
#define BITNOT (~0x0F)

// Bitwise operators with decimal operands
#define DEC_LSHIFT (5 << 2)
#define DEC_RSHIFT (80 >> 3)
#define DEC_BITAND (170 & 85)
#define DEC_BITOR (170 | 85)
#define DEC_BITXOR (170 ^ 85)
#define DEC_BITNOT (~85)

// Relational operators
#define EQ (5 == 5)
#define NE (5 != 3)
#define LT (3 < 5)
#define GT (5 > 3)
#define LE (5 <= 5)
#define GE (5 >= 3)

// Logical operators
#define LAND (1 && 0)
#define LOR (0 || 1)
#define LNOT (!1)

// Ternary operator
#define TERNARY (1 ? 42 : 2)

// Cast operator
#define CAST_INT ((int)5.7)
#define CAST_INT16 ((int8_t)50000)
#define CAST_UINT16 ((uint16_t)50000)

// Precedence and combination
#define PRECEDENCE (2 + 3 * 4)
#define PARENS ((2 + 3) * 4)
#define COMBO ((int)(5.5 + 2) * 3)

// @test T1 ADD = 8
int t1001 = ADD;
// @test T2 SUB = 7
int t1002 = SUB;
// @test T3 MUL = 20
int t1003 = MUL;
// @test T4 DIV = 5
int t1004 = DIV;
// @test T5 MOD = 2
int t1005 = MOD;
// @test ABS_INT_NEG = 7 (abs/int semantics)
int t1040 = (int)(-6 < 0 ? -7 : 7);
// @test ABS_INT_POS = 7 (abs/int semantics)
int t1041 = (int)(6 < 0 ? -7 : 7);
// @test MOD_MATH_POS = 2 (mod semantics)
int t1042 = (-17 + 5 * (int)(-17 / 5));
// @test MOD_MATH_NEG = 3 (mod semantics)
int t1043 = (-17 - 5 * (int)(-17 / 5));
// @test T6 NEG = -5
int t1006 = NEG;
// @test T7 LSHIFT = 16
int t1007 = LSHIFT;
// @test T8 RSHIFT = 8
int t1008 = RSHIFT;
// @test T9 BITAND = 15
int t1009 = BITAND;
// @test T10 BITOR = 255
int t1010 = BITOR;
// @test T11 BITXOR = 240
int t1011 = BITXOR;
// @test T12 BITNOT = -16
int t1012 = BITNOT;
// @test T13 EQ = 1
int t1013 = EQ;
// @test T14 NE = 1
int t1014 = NE;
// @test T15 LT = 1
int t1015 = LT;
// @test T16 GT = 1
int t1016 = GT;
// @test T17 LE = 1
int t1017 = LE;
// @test T18 GE = 1
int t1018 = GE;
// @test T19 LAND = 0
int t1019 = LAND;
// @test T20 LOR = 1
int t1020 = LOR;
// @test T21 LNOT = 0
int t1021 = LNOT;
// @test T22 TERNARY = 42
int t1022 = TERNARY;
// @test T23 CAST_INT = 5
int t1023 = CAST_INT;
// @test T24 CAST_UINT16 = 50000
int t1024 = CAST_UINT16;
// @test T25 PRECEDENCE = 14
int t1025 = PRECEDENCE;
// @test T26 PARENS = 20
int t1026 = PARENS;
// @test T27 COMBO = 21
int t1027 = COMBO;
// @test T28 HEX_ADD = 21
int t1028 = HEX_ADD;
// @test T29 HEX_SUB = 22
int t1029 = HEX_SUB;
// @test T30 HEX_MUL = 20
int t1030 = HEX_MUL;
// @test T31 HEX_DIV = 8
int t1031 = HEX_DIV;
// @test T32 HEX_MOD = 2
int t1032 = HEX_MOD;
// @test T33 HEX_NEG = -10
int t1033 = HEX_NEG;
// @test T34 DEC_LSHIFT = 20
int t1034 = DEC_LSHIFT;
// @test T35 DEC_RSHIFT = 10
int t1035 = DEC_RSHIFT;
// @test T36 DEC_BITAND = 0
int t1036 = DEC_BITAND;
// @test T37 DEC_BITOR = 255
int t1037 = DEC_BITOR;
// @test T38 DEC_BITXOR = 255
int t1038 = DEC_BITXOR;
// @test T39 DEC_BITNOT = -86
int t1039 = DEC_BITNOT;
