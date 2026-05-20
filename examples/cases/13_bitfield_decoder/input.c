#include <stdint.h>
#include "input.h"

void example13(void) {
    // ═══════════════════════════════════════════════════════════════
    // 1. SEMANTIC GUESS: Register family recognition
    //    When CR1, CR2, CR3 are grouped, decoder recognizes TIM as family
    // ═══════════════════════════════════════════════════════════════

    // @test SG1 TIM_CR1_CEN | TIM_CR1_CMS_0 | TIM_CR1_CMS_1 = 97
    TIM1->CR1 = TIM_CR1_CEN | TIM_CR1_CMS_0 | TIM_CR1_CMS_1;

    // @test SG2 TIM_CR2_MMS_0 | TIM_CR2_MMS_1 = 48
    TIM1->CR2 = TIM_CR2_MMS_0 | TIM_CR2_MMS_1;

    // @test SG3 TIM_CR3_DIRC | TIM_CR3_DMAP = 9
    TIM1->CR3 = TIM1_CR3_DIRC | TIM1_CR3_DMAP;

    #define TIM1__CR3   (TIM_CR3_DIRC | TIM_CR3_DMAP)

    // ═══════════════════════════════════════════════════════════════
    // 2. REGISTER AWARENESS: Correct decoder selection by context
    //    Hover on TIM1->CR1 should decode CMS as 2-bit field
    // ═══════════════════════════════════════════════════════════════

    // @test RA1 TIM_CR1_CEN | TIM_CR1_OPM | TIM_CR1_URS = 13
    #define RA1 (TIM_CR1_CEN | TIM_CR1_OPM | TIM_CR1_URS)

    // @test RA2 TIM_CR2_CCPC | TIM_CR2_CCUS = 5
    #define RA2 (TIM_CR2_CCPC | TIM_CR2_CCUS)

    // ═══════════════════════════════════════════════════════════════
    // 3. CONFLICT DETECTION: Warn when bits overlap
    //    CMS_0 (0x20) and CMS_1 (0x40) shouldn't both set bit 5
    // ═══════════════════════════════════════════════════════════════

    // @test CD1 TIM_CR1_CMS_0 | TIM_CR1_CMS_1 = 96
    #define CD1 (TIM_CR1_CMS_0 | TIM_CR1_CMS_1)

    // ═══════════════════════════════════════════════════════════════
    // 4. LIVE DECODING OUTPUT
    //    Hover over assignments to see bitfield decode in hover tooltip
    // ═══════════════════════════════════════════════════════════════

    // TIM_TypeDef* TIM1_BASE = (TIM_TypeDef*)0x40012C00;
    // struct TIM_TypeDef { uint16_t CR1; uint16_t CR2; uint16_t CR3; } tim1;
    TIM_TypeDef tim1;

    // Hover over the 0x61 value to see inline bitfield decode
    // CR1 decoded: CEN=1, CMS=3, DIR=0, OPM=0, URS=0, CKD=0
    tim1.CR1 = 0x61;
}
