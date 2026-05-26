#include <stdint.h>



// ============================================================================
// Embedded use-case: Differential current measurement + motor current RMS
// This file is intentionally built to stress Interactive View:
// - many nested formulas
// - constants (shunt, ADC scaling, filter coefficients)
// - differential stages (I+ - I-)
// - RMS-like power aggregation (nested averaging)
// ============================================================================

// --- ADC & scaling constants ---
#define ADC_BITS            12
#define ADC_MAX_COUNTS     4095

// Assume a bipolar ADC front-end mapping current->counts with gain+offset.
#define ADC_COUNTS_PER_A  820.0   // counts/A (calibrated)
#define ADC_OFFSET_COUNTS 12.5    // counts offset (front-end)

// --- Shunt / differential sense ---
#define SHUNT_OHMS          0.0012   // 1.2 mOhm
#define AMP_GAIN           25.0      // differential amplifier gain

// --- Two current channels (from differential front-end) ---
// In practice these would be derived from ADC reads.
// Here we set them as firmware constants.
#define I_PLUS_RAW_A       3.40
#define I_MINUS_RAW_A      0.62

// --- Firmware calibration / compensations ---
#define CURRENT_BIAS_A     0.035

// Quadratic compensation model: I_est = I_lin + K2*(I_lin^2)
#define K2_A_PER_A2        0.0025

// --- Filter coefficients (pseudo DSP blocks) ---
#define ALPHA_Q31          0.05
#define BETA_Q31           0.90
#define GAMMA_Q31          0.20

// --- Sampling window for RMS-like computation ---
#define N_SAMPLES          4

// --- Stage 1: Differential current ---
// I_diff = (I+ - I-) 
// NOTE: in interactive view, this will appear as a chain of dependencies.
#define I_DIFF_A          (I_PLUS_RAW_A - I_MINUS_RAW_A)

// --- Stage 2: ADC counts simulation for both channels ---
// Convert current to ADC counts using a linear model:
// counts = ADC_COUNTS_PER_A * I + ADC_OFFSET_COUNTS
#define I_PLUS_COUNTS     (ADC_COUNTS_PER_A * I_PLUS_RAW_A + ADC_OFFSET_COUNTS)
#define I_MINUS_COUNTS    (ADC_COUNTS_PER_A * I_MINUS_RAW_A + ADC_OFFSET_COUNTS)

// Differential counts and then back to differential current
#define I_DIFF_COUNTS    (I_PLUS_COUNTS - I_MINUS_COUNTS)
#define I_DIFF_ADC_A      ((I_DIFF_COUNTS - ADC_OFFSET_COUNTS) / ADC_COUNTS_PER_A)

// --- Stage 3: Analog front-end modeled voltage and shunt current ---
// Model the shunt voltage from amplified differential current:
// V_shunt = (I_diff_ADC_A / AMP_GAIN) * SHUNT_OHMS
#define V_SHUNT_V         ((I_DIFF_ADC_A / AMP_GAIN) * SHUNT_OHMS)

// Recover current from modeled voltage to close a loop (adds depth)
#define I_SHUNT_A         (V_SHUNT_V / SHUNT_OHMS)

// --- Stage 4: Linear correction (bias + compensation polynomial) ---
#define I_LIN_A          (I_SHUNT_A - CURRENT_BIAS_A)
#define I_COMP_A        (I_LIN_A + (K2_A_PER_A2 * (I_LIN_A * I_LIN_A)))

// --- Stage 5: DSP-ish multi-stage nested computations ---
// Build multiple “samples” as nested operations to avoid having too few degrees of freedom.
// i0..i3 are generated from one corrected value using filter coefficients.
#define I_SAMPLE0_A     (I_COMP_A)
#define I_SAMPLE1_A     (BETA_Q31 * I_COMP_A + ALPHA_Q31 * (I_DIFF_A))
#define I_SAMPLE2_A     (BETA_Q31 * I_COMP_A + ALPHA_Q31 * (GAMMA_Q31 * I_DIFF_A))
#define I_SAMPLE3_A     (BETA_Q31 * I_COMP_A - ALPHA_Q31 * (I_DIFF_A))

// Square terms
#define I0_2             (I_SAMPLE0_A * I_SAMPLE0_A)
#define I1_2             (I_SAMPLE1_A * I_SAMPLE1_A)
#define I2_2             (I_SAMPLE2_A * I_SAMPLE2_A)
#define I3_2             (I_SAMPLE3_A * I_SAMPLE3_A)

// Average square (nested)
#define I2_AVG          ((I0_2 + I1_2 + I2_2 + I3_2) / N_SAMPLES)

// “RMS-like” approximation: avoid sqrt() so the C parser stays constant-evaluable.
// Use a fitted approximation around expected range.
// For this demo we use: RMS ≈ I2_AVG * 0.33 + 0.95
#define I_RMS_A         (I2_AVG * 0.33 + 0.95)


// --- Stage 6: Motor current with measurement window correction ---
// Apply a scaling factor that simulates calibration of the measurement chain.
#define MOTOR_CURRENT_A (I_RMS_A * 1.03)

// ===============================
// @test targets (will be in expected.yaml)
// ===============================
// @test STAGE_DIFF I_DIFF_A = 2.78
// @test STAGE_ADC  I_DIFF_ADC_A = 2.7647560975609755
// @test STAGE_COMP I_COMP_A = 0.0756045286148721
// @test MOTOR_RMS   MOTOR_CURRENT_A = 0.9838367804449185

// These assignments exist only so the parser has symbols to resolve.
static const float current_diff_a   = I_DIFF_A;
static const float current_rms_a    = I_RMS_A;
static const float motor_current_a  = MOTOR_CURRENT_A;

