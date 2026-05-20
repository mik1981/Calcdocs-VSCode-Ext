// ============================================================
// CalcDocs Full Showcase
// Optimized for README screenshots and demo recordings
// ============================================================


// ============================================================
// BASIC MACRO EXPANSION
// ============================================================

#define PWM_FREQ_HZ       20000
#define PWM_PERIOD_US     (1000000 / PWM_FREQ_HZ)

#define ADC_MAX           4095
#define ADC_TO_VOLT(x)    ((x) * 3.3f / ADC_MAX)

float phaseVoltage = ADC_TO_VOLT(2048);


// ============================================================
// CONDITIONAL CONFIGURATION
// ============================================================

#define HW_REV_B

#ifdef HW_REV_B
    #define CURRENT_GAIN 0.010f
#else
    #define CURRENT_GAIN 0.020f
#endif

float motorCurrent = 1500 * CURRENT_GAIN;


// ============================================================
// FUNCTION MACROS
// ============================================================

#define FILTER_ALPHA   (0.85f)
#define LPF(x, y)      ((FILTER_ALPHA * (x)) + ((1.0f - FILTER_ALPHA) * (y)))

float filteredCurrent = LPF(12.5f, 8.0f);


// ============================================================
// INLINE ENGINEERING NOTES
// ============================================================

// @rpm = 3000 rpm
// = @rpm -> rad/s
// = 24 V * 3 A -> W
// = 120 km/h -> m/s
// = 3.3 V / 470 ohm -> mA


// ============================================================
// YAML FORMULA SYSTEM
// ============================================================

#define FS_VIN         24.0f
#define FS_CURRENT     2.5f

float power = power;
float efficiency = efficiency;
float ntcTemperature = ntc_temperature;


// ============================================================
// BITFIELD DECODER
// ============================================================

typedef struct
{
    unsigned enabled   : 1;
    unsigned fault     : 1;
    unsigned overtemp  : 1;
    unsigned direction : 1;

} MOTOR_STATUS_t;

MOTOR_STATUS_t status =
{
    .enabled = 1,
    .fault = 0,
    .overtemp = 1,
    .direction = 0
};


// ============================================================
// ADVANCED EXPRESSIONS
// ============================================================

#define MOTOR_SPEED_RPM      3000
#define RPM_TO_RAD_S(x)      ((x) * 0.10472f)

float mechanicalSpeed = RPM_TO_RAD_S(MOTOR_SPEED_RPM);


// ============================================================
// GENERATED VALUES
// ============================================================

#include "../inc/macro_generate.h"

float generatedPower = GENERATED_POWER_W;
float generatedSpeed = GENERATED_SPEED_RAD_S;
float generatedCurrent = GENERATED_CURRENT_A;
