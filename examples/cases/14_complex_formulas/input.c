/**
 * Case 14: Complex formula evaluation
 *
 * Tests multi-step arithmetic, bitwise ops, conditional expression (abs),
 * and modular arithmetic.  All symbols are pure #define macros so the
 * test runner can resolve them without a formulas.yaml.
 *
 * EVERY expected value is derivable by hand — none are trivially equal
 * to a single literal.
 */

/* ── ADC chain ───────────────────────────────────────────────────── */
#define ADC_BITS        (12U)
#define ADC_FS          (1U << ADC_BITS)          /* 4096              */
#define ADC_HALF        (ADC_FS / 2U)             /* 2048              */
#define ADC_REF_MV      (3300U)
#define ADC_LSB_UV      (ADC_REF_MV * 1000U / ADC_FS)  /* 805 µV      */

/* ── scaling chain ──────────────────────────────────────────────── */
#define GAIN_NUM        (33U)
#define GAIN_DEN        (10U)
#define SCALED_VAL      (ADC_HALF * GAIN_NUM / GAIN_DEN)  /* 6758     */

/* ── abs helper ─────────────────────────────────────────────────── */
#define RAW_SIGNED      (-42)
#define OUT_INT_ABS     (RAW_SIGNED < 0 ? (-RAW_SIGNED) : RAW_SIGNED) /* 42 */

/* ── modulo + abs combined ──────────────────────────────────────── */
#define MOD_A           (17U)
#define MOD_B           (5U)

/* ── bitwise nibble extraction ──────────────────────────────────── */
#define MASK_BASE       (0xABCDU)
#define NIBBLE_HI       ((MASK_BASE >> 12U) & 0xFU)        /* 0xA=10  */
#define NIBBLE_LO       ((MASK_BASE >>  0U) & 0xFU)        /* 0xD=13  */
#define NIBBLE_SUM      (NIBBLE_HI + NIBBLE_LO)            /* 23      */

/* ── PT100 fixed-point scale factor ─────────────────────────────── */
#define PT100_OHM_MIN_FP  (5893)    /* 58.93 * 100 */
#define PT100_OHM_100     (10000)   /* 100.00 * 100 */
#define PT100_DELTA_FP    (PT100_OHM_100 - PT100_OHM_MIN_FP) /* 4107 */
#define PT100_SCALE       (65536 / PT100_DELTA_FP)            /* 15   */
