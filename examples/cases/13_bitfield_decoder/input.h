
#include <stdint.h>

// Bitfield decoding example for TIM1 CR1/CR2/CR3 register family.
// Individual bit macros are grouped into semantic fields like CMS and CKD.

#define __IO volatile

// ═══ TIM_CR1: Control Register 1 ═══
#define TIM_CR1_CEN   ((uint16_t)0x0001)  // Counter enable
#define TIM_CR1_URS   ((uint16_t)0x0004)  // Update request source
#define TIM_CR1_OPM   ((uint16_t)0x0008)  // One-pulse mode
#define TIM_CR1_DIR   ((uint16_t)0x0010)  // Direction
#define TIM_CR1_CMS_0 ((uint16_t)0x0020)  // Center-aligned mode bit 0
#define TIM_CR1_CMS_1 ((uint16_t)0x0040)  // Center-aligned mode bit 1
#define TIM_CR1_CKD_0 ((uint16_t)0x0100)  // Clock division bit 0
#define TIM_CR1_CKD_1 ((uint16_t)0x0200)  // Clock division bit 1

// ═══ TIM_CR2: Control Register 2 ═══
#define TIM_CR2_CCPC  ((uint16_t)0x0001)  // Commutation control preload enable
#define TIM_CR2_CCUS  ((uint16_t)0x0004)  // Commutation control update source
#define TIM_CR2_MMS_0 ((uint16_t)0x0010)  // Master mode selection bit 0
#define TIM_CR2_MMS_1 ((uint16_t)0x0020)  // Master mode selection bit 1
#define TIM_CR2_MMS_2 ((uint16_t)0x0040)  // Master mode selection bit 2

// ═══ TIM_CR3: Control Register 3 ═══
#define TIM1_CR3_DIRC  ((uint16_t)0x0001)  // Direction change

#define TIM1_CR3_DMAP_Pos                     (3U)                         
#define TIM1_CR3_DMAP_Msk                     (0x1U << TIM1_CR3_DMAP_Pos) /*!< 0x20000000 */
#define TIM1_CR3_DMAP                         TIM1_CR3_DMAP_Msk          /*!< Independent Watchdog reset flag */


// #define TIM_CR3_DMAP  ((uint16_t)0x0008)  // Debug mode alarm period


typedef struct
{
  __IO uint16_t CR1;         /*!< TIM control register 1,              Address offset: 0x00 */
  uint16_t      RESERVED0;   /*!< Reserved, 0x02                                            */
 __IO uint32_t CR2;          /*!< TIM control register 2,              Address offset: 0x04 */
 __IO uint32_t CR3;          /*!< TIM control register 3,              Address offset: 0x04 */
  __IO uint32_t SMCR;        /*!< TIM slave mode control register,     Address offset: 0x08 */
  __IO uint32_t DIER;        /*!< TIM DMA/interrupt enable register,   Address offset: 0x0C */
  __IO uint32_t SR;          /*!< TIM status register,                 Address offset: 0x10 */
  __IO uint32_t EGR;         /*!< TIM event generation register,       Address offset: 0x14 */
  __IO uint32_t CCMR1;       /*!< TIM capture/compare mode register 1, Address offset: 0x18 */
  __IO uint32_t CCMR2;       /*!< TIM capture/compare mode register 2, Address offset: 0x1C */
  __IO uint32_t CCER;        /*!< TIM capture/compare enable register, Address offset: 0x20 */
  __IO uint32_t CNT;         /*!< TIM counter register,                Address offset: 0x24 */
  __IO uint16_t PSC;         /*!< TIM prescaler,                       Address offset: 0x28 */
  uint16_t      RESERVED9;   /*!< Reserved, 0x2A                                            */
  __IO uint32_t ARR;         /*!< TIM auto-reload register,            Address offset: 0x2C */
  __IO uint16_t RCR;         /*!< TIM repetition counter register,     Address offset: 0x30 */
  uint16_t      RESERVED10;  /*!< Reserved, 0x32                                            */
  __IO uint32_t CCR1;        /*!< TIM capture/compare register 1,      Address offset: 0x34 */
  __IO uint32_t CCR2;        /*!< TIM capture/compare register 2,      Address offset: 0x38 */
  __IO uint32_t CCR3;        /*!< TIM capture/compare register 3,      Address offset: 0x3C */
  __IO uint32_t CCR4;        /*!< TIM capture/compare register 4,      Address offset: 0x40 */
  __IO uint32_t BDTR;        /*!< TIM break and dead-time register,    Address offset: 0x44 */
  __IO uint16_t DCR;         /*!< TIM DMA control register,            Address offset: 0x48 */
  uint16_t      RESERVED12;  /*!< Reserved, 0x4A                                            */
  __IO uint16_t DMAR;        /*!< TIM DMA address for full transfer,   Address offset: 0x4C */
  uint16_t      RESERVED13;  /*!< Reserved, 0x4E                                            */
  __IO uint16_t OR;          /*!< TIM option register,                 Address offset: 0x50 */
  __IO uint32_t CCMR3;       /*!< TIM capture/compare mode register 3, Address offset: 0x54 */
  __IO uint32_t CCR5;        /*!< TIM capture/compare register5,      Address offset: 0x58 */
  __IO uint32_t CCR6;        /*!< TIM capture/compare register 4,      Address offset: 0x5C */
} TIM_TypeDef;

#define PERIPH_BASE           ((uint32_t)0x40000000) /*!< Peripheral base address in the alias region                                  */
#define APB2PERIPH_BASE       (PERIPH_BASE + 0x00010000)
#define TIM1_BASE             (APB2PERIPH_BASE + 0x00002C00)
#define TIM1                ((TIM_TypeDef *) TIM1_BASE)
