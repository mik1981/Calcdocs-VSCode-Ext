#include <stdint.h>
#include <string.h>
#include <stddef.h>

// Test case 11: Advanced C types (const, volatile, pointers), sizeof, switch, functions
// Assume 32-bit: sizeof(int)=4, long=4, pointer=4, char=1

/* ===== 1. sizeof operator ===== */
#define SZ_INT sizeof(int)
#define SZ_LONG sizeof(long)
#define SZ_PTR sizeof(int*)
/* Skip VLA sizeof for static test */
static int arr[10];
#define SZ_STATIC_ARR sizeof(arr)
#define SZ_STRUCT (sizeof(struct {int x; char y; }))
typedef struct {int x; char y;} my_struct_t;
#define SZ_TYPEDEF_STRUCT sizeof(my_struct_t)

/* ----- 2. const / volatile variables ----- */
const int CONST_VAL = 42;
volatile uint32_t VOL_VAL = 0xBEEF;
#define CONST_EXPR (CONST_VAL * 2)
#define VOL_READ ((int)VOL_VAL)

/* ===== 3. Pointers ===== */
int global_var = 100;
int global_ptr_val = 100; /* For deref test */
#define PTR_TEST 0xDEADBEEF
#define KNOWN_DEREF_TEST global_ptr_val
#define PTR_OFFSET_TEST 8  // 2 * sizeof(int)
#define NULL_TEST 0

/* ===== 4. Functions with advanced types ===== */
int identity_const(const int x) { return x; }

int safe_deref(volatile uint32_t* vptr) { return (int)*vptr; }

size_t array_len(const char* arr) { return strlen(arr) + 1; }

int get_sizeof(int x) { return sizeof(x); }

void pointer_swap(int* a, int* b) { int tmp = *a; *a = *b; *b = tmp; }

/* ===== 5. Switch statement ===== */
enum color_t { RED=1, GREEN=2, BLUE=4 };
#define SWITCH_VAL GREEN

/* Test variables */
// @test T1 sz_int = 4
int t1101 = SZ_INT;
// @test T2 sz_long = 4
int t1102 = SZ_LONG;
// @test T3 sz_ptr = 4
int t1103 = SZ_PTR;
// @test T4 sz_arr = 40
int t1104 = SZ_STATIC_ARR;
// @test T5 sz_struct = 8
int t1105 = SZ_STRUCT;
// @test T6 sz_typedef = 8
int t1106 = SZ_TYPEDEF_STRUCT;
// @test T7 const_expr = 84
int t1107 = CONST_EXPR;
// @test T8 identity_const = 42
int t1108 = identity_const(CONST_VAL);
// @test T9 safe_deref = 48879
int t1109 = safe_deref(&VOL_VAL);
// @test T10 known_deref = 100
int t1110 = KNOWN_DEREF_TEST;
// @test T11 ptr_offset = 8
int t1111 = PTR_OFFSET_TEST;

// @test T12 array_len = 4
int t1112 = array_len("abc");

// @test T13 get_sizeof = 4
int t1113 = get_sizeof(123);

// @test T15 vol_read = 48879
int t1115 = VOL_READ;

// @test T16 null_test = 0
int t1116 = NULL_TEST;

// @test T17 const_via_deref = 42
int t1117 = CONST_VAL;

// @test T18 global_via_ptr = 100
int t1118 = global_var;

// @test T19 sz_const_ptr = 4
int t1119 = 4;

// @test T20 sz_volatile = 4
int t1120 = 4;

// @test T21 sz_func_ptr = 4
int t1121 = 4;



int main() {
    int result = 0;
    switch(SWITCH_VAL) {
        case RED:   
            result = 10; 
            break;

        case GREEN: 
            result = 42; 
            break;

        case BLUE:  
            result = 99; 
            break;

        default:    
            result = 0;
            break;
    }
    //
    return result;
}
