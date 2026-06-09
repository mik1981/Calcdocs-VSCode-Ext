/**
 * Case 16: Integer cast behaviour and overflow detection
 *
 * Tests that safeEval / buildCompositeExpressionPreview correctly models:
 *   - unsigned wrapping  (uint8_t, uint16_t, uint32_t)
 *   - signed truncation  (int8_t, int16_t)
 *   - cast-overflow detection (value outside signed range)
 *   - no-op casts that stay inside range
 *
 * The engine in expression.ts uses buildUnsignedIntegerCast (wraps via modulo)
 * and buildIntegerCast (throws CalcDocsCastOverflowError when out of range).
 *
 * "error" entries exercise the cast-overflow path; numeric entries confirm
 * that valid casts pass through unchanged.
 */

/* ── uint8 wrapping: 256 mod 256 = 0 ───────────────────────────── */
#define U8_WRAP    ((uint8_t)(256U))     /* 0   — wraps                */
#define U8_VALID   ((uint8_t)(200U))     /* 200 — fits in [0..255]     */

/* ── uint16 wrapping ────────────────────────────────────────────── */
#define U16_WRAP   ((uint16_t)(65536U))  /* 0   — wraps                */
#define U16_VALID  ((uint16_t)(50000U))  /* 50000 — fits in [0..65535] */

/* ── int8 overflow (range −128..127) ───────────────────────────── */
#define I8_OK      ((int8_t)(100))       /* 100 — fits                 */
#define I8_OVF     ((int8_t)(200))       /* overflow: 200 > 127        */

/* ── int16 overflow (range −32768..32767) ───────────────────────── */
#define I16_OK     ((int16_t)(30000))    /* 30000 — fits               */
#define I16_OVF    ((int16_t)(40000))    /* overflow: 40000 > 32767    */

/* ── compound: valid cast in a larger expression ────────────────── */
/* (uint8_t)(100) + (uint8_t)(50) = 100 + 50 = 150                  */
#define CAST_SUM   ((uint8_t)(100U) + (uint8_t)(50U))
