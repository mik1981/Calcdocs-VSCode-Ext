/**
 * Case 20: Conditional #define branches
 *
 * Exercises the two-pass conditional-aware parser (cppParser.ts).
 * Pattern mirrors case 02 but with richer branching:
 *   - include guard transparently handled
 *   - #if !defined → active #else branch
 *   - #elif chain selects exactly one value
 *   - #undef inside active branch replaces a symbol
 *   - COMPOUND depends on all three active-branch symbols
 *
 * INACTIVE_SYM comes from a dead branch and must NOT resolve.
 */

/* ── include guard (must be transparent to the parser) ─────────── */
#ifndef CASE15_H
#define CASE15_H

/* ── branch A ───────────────────────────────────────────────────── */
/* FEATURE_DISABLED is never defined → #else branch is active        */
#if defined(FEATURE_DISABLED)
  #define INACTIVE_SYM   (9999)
#else
  #define ACTIVE_BASE    (100U)
  #define ACTIVE_DOUBLE  (ACTIVE_BASE * 2U)      /* 200 */
#endif

/* ── branch B: #elif chain ──────────────────────────────────────── */
#define SELECTOR   (2U)

#if   (SELECTOR == 1)
  #define CHAIN_VAL  (10U)
#elif (SELECTOR == 2)
  #define CHAIN_VAL  (20U)    /* active */
#elif (SELECTOR == 3)
  #define CHAIN_VAL  (30U)
#else
  #define CHAIN_VAL  (99U)
#endif

/* ── branch C: #undef inside active branch ──────────────────────── */
#define TEMP_SYM   (77U)
#if !defined(FEATURE_DISABLED)
  #undef  TEMP_SYM
  #define TEMP_SYM   (55U)    /* replaces 77 with 55 */
#endif

/* ── compound: uses all three active-branch results ─────────────── */
#define COMPOUND   (ACTIVE_DOUBLE + CHAIN_VAL + TEMP_SYM)  /* 200+20+55=275 */

#endif /* CASE15_H */
