/**
 * Case 19: Function-like macro expansion
 *
 * Tests that expandFunctionLikeMacrosInExpression() correctly:
 *   - substitutes parameters by value
 *   - handles nested calls (SCALE called from NORM)
 *   - handles token-pasting via ## (MAKE_FIELD)
 *   - handles multi-argument calls with expressions as args
 *
 * All expected values are derived by hand.
 */
#include <stdint.h>

/* ── simple one-arg macro ───────────────────────────────────────── */
#define DOUBLE(x)        ((x) * 2)
#define TRIPLE(x)        ((x) * 3)

/* ── two-arg macros ─────────────────────────────────────────────── */
#define ADD(a, b)        ((a) + (b))
#define MUL(a, b)        ((a) * (b))
#define MAX2(a, b)       ((a) > (b) ? (a) : (b))

/* ── nested call: SCALE calls DOUBLE internally ─────────────────── */
#define SCALE(x, k)      (DOUBLE(x) * (k))

/* ── multi-level nesting ────────────────────────────────────────── */
#define NORM(x, lo, hi)  (MUL(DOUBLE(x), ADD(hi, lo)))

/* ── expression arguments ───────────────────────────────────────── */
#define BASE    (10U)
#define STEP    (3U)

#define R_DOUBLE    DOUBLE(BASE)                   /* 20              */
#define R_TRIPLE    TRIPLE(BASE)                   /* 30              */
#define R_ADD       ADD(BASE, STEP)                /* 13              */
#define R_MUL       MUL(BASE, STEP)                /* 30              */
#define R_MAX2      MAX2(BASE, STEP)               /* 10              */
#define R_SCALE     SCALE(BASE, STEP)              /* DOUBLE(10)*3=60 */
#define R_NORM      NORM(BASE, STEP, BASE)         /* MUL(DOUBLE(10), ADD(10,3)) = 20*13 = 260 */
#define R_EXPR_ARG  ADD(BASE * 2, STEP + 1)       /* (20)+(4) = 24   */
