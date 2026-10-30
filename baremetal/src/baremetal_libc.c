/*
 * Minimal C library functions for bare-metal QuickJS
 */

#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>
#include <time.h>
#include <setjmp.h>

#include "uart.h"
#include "timer.h"
#include "heap.h"

/* Forward declarations for dtoa functions */
extern char *u32toa(char *buf, uint32_t val);
extern char *i32toa(char *buf, int32_t val);
extern char *i64toa(char *buf, int64_t val);

/* Memory operations */
void *memset(void *s, int c, size_t n) {
    uint8_t *p = (uint8_t *)s;
    while (n--) {
        *p++ = (uint8_t)c;
    }
    return s;
}

/* Memory allocation */
void *malloc(size_t size) {
    return heap_alloc(size);
}

void *calloc(size_t nmemb, size_t size) {
    void *ptr = heap_alloc(nmemb * size);
    if (ptr) {
        memset(ptr, 0, nmemb * size);
    }
    return ptr;
}

void *realloc(void *ptr, size_t size) {
    return heap_realloc(ptr, size);
}

void free(void *ptr) {
    heap_free(ptr);
}

void *memcpy(void *dest, const void *src, size_t n) {
    uint8_t *d = (uint8_t *)dest;
    const uint8_t *s = (const uint8_t *)src;
    while (n--) {
        *d++ = *s++;
    }
    return dest;
}

void *memmove(void *dest, const void *src, size_t n) {
    uint8_t *d = (uint8_t *)dest;
    const uint8_t *s = (const uint8_t *)src;
    
    if (d < s) {
        while (n--) {
            *d++ = *s++;
        }
    } else {
        d += n;
        s += n;
        while (n--) {
            *--d = *--s;
        }
    }
    return dest;
}

int memcmp(const void *s1, const void *s2, size_t n) {
    const uint8_t *p1 = (const uint8_t *)s1;
    const uint8_t *p2 = (const uint8_t *)s2;
    while (n--) {
        if (*p1 != *p2) {
            return *p1 - *p2;
        }
        p1++;
        p2++;
    }
    return 0;
}

/* String operations */
size_t strlen(const char *s) {
    const char *p = s;
    while (*p) p++;
    return p - s;
}

/* abs function for dtoa */
int abs(int x) {
    return x < 0 ? -x : x;
}

char *strchr(const char *s, int c) {
    while (*s) {
        if (*s == (char)c) return (char *)s;
        s++;
    }
    return (c == 0) ? (char *)s : NULL;
}

char *strrchr(const char *s, int c) {
    const char *last = NULL;
    while (*s) {
        if (*s == (char)c) last = s;
        s++;
    }
    if (c == 0) return (char *)s;
    return (char *)last;
}

int strcmp(const char *s1, const char *s2) {
    while (*s1 && *s1 == *s2) {
        s1++;
        s2++;
    }
    return (unsigned char)*s1 - (unsigned char)*s2;
}

void *memchr(const void *s, int c, size_t n) {
    const uint8_t *p = (const uint8_t *)s;
    while (n--) {
        if (*p == (uint8_t)c) {
            return (void *)p;
        }
        p++;
    }
    return NULL;
}

char *strstr(const char *haystack, const char *needle) {
    if (!*needle) return (char *)haystack;
    
    for (; *haystack; haystack++) {
        const char *h = haystack;
        const char *n = needle;
        
        while (*h && *n && *h == *n) {
            h++;
            n++;
        }
        
        if (!*n) return (char *)haystack;
    }
    return NULL;
}

/* Simple vsnprintf implementation */
int vsnprintf(char *str, size_t size, const char *format, va_list ap) {
    size_t pos = 0;
    
    while (*format && pos < size - 1) {
        if (*format == '%') {
            format++;
            
            // Handle width and precision (simplified)
            while (*format >= '0' && *format <= '9') format++;
            if (*format == '.') {
                format++;
                while (*format >= '0' && *format <= '9') format++;
            }
            
            switch (*format) {
                case 'd':
                case 'i': {
                    int val = va_arg(ap, int);
                    char buf[12];
                    char *p = buf;
                    
                    if (val < 0) {
                        if (pos < size - 1) str[pos++] = '-';
                        val = -val;
                    }
                    
                    p = u32toa(buf, (uint32_t)val);
                    size_t len = p - buf;
                    for (size_t i = 0; i < len && pos < size - 1; i++) {
                        str[pos++] = buf[i];
                    }
                    break;
                }
                
                case 'u': {
                    uint32_t val = va_arg(ap, uint32_t);
                    char buf[11];
                    char *p = u32toa(buf, val);
                    size_t len = p - buf;
                    for (size_t i = 0; i < len && pos < size - 1; i++) {
                        str[pos++] = buf[i];
                    }
                    break;
                }
                
                case 'x':
                case 'X': {
                    uint32_t val = va_arg(ap, uint32_t);
                    const char *hex = (*format == 'x') ? "0123456789abcdef" : "0123456789ABCDEF";
                    char buf[9];
                    int i = 8;
                    buf[i] = '\0';
                    
                    if (val == 0) {
                        buf[--i] = '0';
                    } else {
                        while (val > 0) {
                            buf[--i] = hex[val & 0xf];
                            val >>= 4;
                        }
                    }
                    
                    for (; buf[i] && pos < size - 1; i++) {
                        str[pos++] = buf[i];
                    }
                    break;
                }
                
                case 's': {
                    const char *s = va_arg(ap, const char *);
                    if (!s) s = "(null)";
                    while (*s && pos < size - 1) {
                        str[pos++] = *s++;
                    }
                    break;
                }
                
                case 'c': {
                    char c = (char)va_arg(ap, int);
                    if (pos < size - 1) str[pos++] = c;
                    break;
                }
                
                case 'p': {
                    void *p = va_arg(ap, void *);
                    if (pos < size - 1) str[pos++] = '0';
                    if (pos < size - 1) str[pos++] = 'x';
                    char buf[17];
                    char *bp = buf;
                    bp = u32toa(buf, (uint32_t)(uintptr_t)p);
                    size_t len = bp - buf;
                    for (size_t i = 0; i < len && pos < size - 1; i++) {
                        str[pos++] = buf[i];
                    }
                    break;
                }
                
                case '%':
                    if (pos < size - 1) str[pos++] = '%';
                    break;
            }
        } else {
            str[pos++] = *format;
        }
        format++;
    }
    
    if (pos < size) str[pos] = '\0';
    return pos;
}

int snprintf(char *str, size_t size, const char *format, ...) {
    va_list ap;
    va_start(ap, format);
    int ret = vsnprintf(str, size, format, ap);
    va_end(ap);
    return ret;
}

int printf(const char *format, ...) {
    char buf[256];
    va_list ap;
    va_start(ap, format);
    int len = vsnprintf(buf, sizeof(buf), format, ap);
    va_end(ap);
    
    for (int i = 0; i < len && i < (int)sizeof(buf) - 1; i++) {
        uart_putc(buf[i]);
    }
    
    return len;
}

/* Math functions */
double trunc(double x) {
    return (x > 0) ? (double)(int)x : (double)(int)x;
}

double floor(double x) {
    double t = (double)(long long)x;
    return (x < t) ? t - 1.0 : t;
}

double ceil(double x) {
    double t = (double)(long long)x;
    return (x > t) ? t + 1.0 : t;
}

double copysign(double x, double y) {
    union { double d; uint64_t u; } ux = {x}, uy = {y};
    ux.u = (ux.u & 0x7FFFFFFFFFFFFFFFULL) | (uy.u & 0x8000000000000000ULL);
    return ux.d;
}

double frexp(double x, int *exp) {
    if (x == 0.0) {
        *exp = 0;
        return 0.0;
    }
    union { double d; uint64_t u; } u = {x};
    int e = ((u.u >> 52) & 0x7FF) - 1022;
    *exp = e;
    u.u = (u.u & 0x800FFFFFFFFFFFFFULL) | 0x3FE0000000000000ULL;
    return u.d;
}

double scalbn(double x, int n) {
    if (n > 1023) {
        x *= 8.98846567431158e+307;
        n -= 1023;
        if (n > 1023) {
            x *= 8.98846567431158e+307;
            n -= 1023;
            if (n > 1023) n = 1023;
        }
    } else if (n < -1022) {
        x *= 1.1125369292536007e-308;
        n += 1022;
        if (n < -1022) {
            x *= 1.1125369292536007e-308;
            n += 1022;
            if (n < -1022) n = -1022;
        }
    }
    union { double d; uint64_t u; } u;
    u.u = (uint64_t)(0x3FF + n) << 52;
    return x * u.d;
}

double strtod(const char *nptr, char **endptr) {
    double result = 0.0;
    int sign = 1;
    
    while (*nptr == ' ' || *nptr == '\t') nptr++;
    
    if (*nptr == '-') {
        sign = -1;
        nptr++;
    } else if (*nptr == '+') {
        nptr++;
    }
    
    while (*nptr >= '0' && *nptr <= '9') {
        result = result * 10.0 + (*nptr - '0');
        nptr++;
    }
    
    if (*nptr == '.') {
        nptr++;
        double factor = 0.1;
        while (*nptr >= '0' && *nptr <= '9') {
            result += (*nptr - '0') * factor;
            factor *= 0.1;
            nptr++;
        }
    }
    
    if (endptr) *endptr = (char *)nptr;
    return sign * result;
}

/* Additional math functions for QuickJS */
double round(double x) {
    return (x >= 0.0) ? floor(x + 0.5) : ceil(x - 0.5);
}

double fabs(double x) {
    return (x < 0.0) ? -x : x;
}

double fmod(double x, double y) {
    if (y == 0.0) return 0.0;
    return x - ((long long)(x / y)) * y;
}

double pow(double base, double exp) {
    if (exp == 0.0) return 1.0;
    if (base == 0.0) return 0.0;
    
    double result = 1.0;
    int neg = 0;
    
    if (exp < 0) {
        neg = 1;
        exp = -exp;
    }
    
    for (long long i = 0; i < (long long)exp; i++) {
        result *= base;
    }
    
    return neg ? 1.0 / result : result;
}

double sqrt(double x) {
    if (x < 0.0) return -1.0;
    if (x == 0.0) return 0.0;
    
    double guess = x / 2.0;
    for (int i = 0; i < 20; i++) {
        guess = (guess + x / guess) / 2.0;
    }
    return guess;
}

long lrint(double x) {
    return (long)round(x);
}

double modf(double x, double *iptr) {
    double integer = (x >= 0.0) ? floor(x) : ceil(x);
    *iptr = integer;
    return x - integer;
}

/* Trigonometric functions (simplified implementations) */
double sin(double x) {
    // Taylor series approximation for small angles
    x = fmod(x, 6.28318530718);
    if (x > 3.14159265359) x -= 6.28318530718;
    
    double x2 = x * x;
    double x3 = x2 * x;
    double x5 = x3 * x2;
    double x7 = x5 * x2;
    
    return x - x3/6.0 + x5/120.0 - x7/5040.0;
}

double cos(double x) {
    return sin(x + 1.57079632679);
}

double tan(double x) {
    return sin(x) / cos(x);
}

double asin(double x) {
    if (x < -1.0 || x > 1.0) return 0.0;
    if (x == 1.0) return 1.57079632679;
    if (x == -1.0) return -1.57079632679;
    
    // Approximation
    return x + (x*x*x)/6.0 + (3.0*x*x*x*x*x)/40.0;
}

double acos(double x) {
    return 1.57079632679 - asin(x);
}

double atan(double x) {
    if (x == 0.0) return 0.0;
    
    // Approximation for |x| <= 1
    if (fabs(x) <= 1.0) {
        double x2 = x * x;
        return x - x2*x/3.0 + x2*x2*x/5.0;
    }
    
    // For |x| > 1, use identity: atan(x) = pi/2 - atan(1/x)
    return (x > 0 ? 1.57079632679 : -1.57079632679) - atan(1.0/x);
}

double hypot(double x, double y) {
    return sqrt(x*x + y*y);
}

/* Additional math functions for QuickJS */
double cbrt(double x) {
    if (x == 0.0) return 0.0;
    int neg = x < 0;
    if (neg) x = -x;
    double guess = x / 3.0;
    for (int i = 0; i < 30; i++) {
        guess = (2.0 * guess + x / (guess * guess)) / 3.0;
    }
    return neg ? -guess : guess;
}

double log(double x) {
    if (x <= 0.0) return -1e308;
    if (x == 1.0) return 0.0;
    
    // Use the identity: log(x) = log(x/2^n) + n*log(2)
    int n = 0;
    while (x > 2.0) { x /= 2.0; n++; }
    while (x < 0.5) { x *= 2.0; n--; }
    
    // Approximate log(x) for 0.5 <= x <= 2.0 using Taylor series
    double y = (x - 1.0) / (x + 1.0);
    double y2 = y * y;
    double sum = y;
    double term = y;
    for (int i = 1; i < 10; i++) {
        term *= y2;
        sum += term / (2 * i + 1);
    }
    return 2.0 * sum + n * 0.6931471805599453;
}

double log10(double x) {
    return log(x) / 2.302585092994046;
}

double log2(double x) {
    return log(x) / 0.6931471805599453;
}

double log1p(double x) {
    if (fabs(x) < 0.01) {
        return x - x*x/2.0 + x*x*x/3.0;
    }
    return log(1.0 + x);
}

double exp(double x) {
    if (x == 0.0) return 1.0;
    if (x > 709.0) return 1e308;
    if (x < -709.0) return 0.0;
    
    // Use Taylor series
    double sum = 1.0;
    double term = 1.0;
    for (int i = 1; i < 30; i++) {
        term *= x / i;
        sum += term;
    }
    return sum;
}

double expm1(double x) {
    if (fabs(x) < 0.01) {
        return x + x*x/2.0;
    }
    return exp(x) - 1.0;
}

double atan2(double y, double x) {
    if (x > 0.0) return atan(y / x);
    if (x < 0.0 && y >= 0.0) return atan(y / x) + 3.14159265359;
    if (x < 0.0 && y < 0.0) return atan(y / x) - 3.14159265359;
    if (x == 0.0 && y > 0.0) return 1.57079632679;
    if (x == 0.0 && y < 0.0) return -1.57079632679;
    return 0.0;
}

double sinh(double x) {
    return (exp(x) - exp(-x)) / 2.0;
}

double cosh(double x) {
    return (exp(x) + exp(-x)) / 2.0;
}

double tanh(double x) {
    if (x > 20.0) return 1.0;
    if (x < -20.0) return -1.0;
    return sinh(x) / cosh(x);
}

double asinh(double x) {
    return log(x + sqrt(x * x + 1.0));
}

double acosh(double x) {
    if (x < 1.0) return 0.0;
    return log(x + sqrt(x * x - 1.0));
}

double atanh(double x) {
    if (fabs(x) >= 1.0) return (x > 0) ? 1e308 : -1e308;
    return 0.5 * log((1.0 + x) / (1.0 - x));
}

/* Additional string conversion functions are now provided by dtoa.c */

/* Time functions */
struct tm {
    int tm_sec, tm_min, tm_hour, tm_mday, tm_mon, tm_year;
    int tm_wday, tm_yday, tm_isdst;
};

struct tm *localtime_r(const time_t *timep, struct tm *result) {
    // Simple stub - return epoch
    memset(result, 0, sizeof(*result));
    return result;
}

struct tm *gmtime_r(const time_t *timep, struct tm *result) {
    return localtime_r(timep, result);
}

time_t mktime(struct tm *tm) {
    return 0;
}

double difftime(time_t end, time_t beginning) {
    return (double)(end - beginning);
}

/* I/O functions */
int putchar(int c) {
    uart_putc(c);
    return c;
}

int vfprintf(void *stream, const char *format, va_list ap) {
    (void)stream;
    char buf[256];
    int len = vsnprintf(buf, sizeof(buf), format, ap);
    for (int i = 0; i < len && i < (int)sizeof(buf) - 1; i++) {
        uart_putc(buf[i]);
    }
    return len;
}

int fprintf(void *stream, const char *format, ...) {
    va_list ap;
    va_start(ap, format);
    int ret = vfprintf(stream, format, ap);
    va_end(ap);
    return ret;
}

/* Atomic operation stubs for ARM64 */
int __aarch64_ldadd1_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int8_t *)ptr;
    *(volatile int8_t *)ptr = old + val;
    return old;
}

int __aarch64_ldadd2_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int16_t *)ptr;
    *(volatile int16_t *)ptr = old + val;
    return old;
}

int __aarch64_ldadd4_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int32_t *)ptr;
    *(volatile int32_t *)ptr = old + val;
    return old;
}

int64_t __aarch64_ldadd8_acq_rel(int64_t val, volatile void *ptr) {
    int64_t old = *(volatile int64_t *)ptr;
    *(volatile int64_t *)ptr = old + val;
    return old;
}

int __aarch64_cas1_acq_rel(int desired, int expected, volatile void *ptr) {
    int old = *(volatile int8_t *)ptr;
    if (old == expected) *(volatile int8_t *)ptr = desired;
    return old;
}

int __aarch64_cas2_acq_rel(int desired, int expected, volatile void *ptr) {
    int old = *(volatile int16_t *)ptr;
    if (old == expected) *(volatile int16_t *)ptr = desired;
    return old;
}

int __aarch64_cas4_acq_rel(int desired, int expected, volatile void *ptr) {
    int old = *(volatile int32_t *)ptr;
    if (old == expected) *(volatile int32_t *)ptr = desired;
    return old;
}

int64_t __aarch64_cas8_acq_rel(int64_t desired, int64_t expected, volatile void *ptr) {
    int64_t old = *(volatile int64_t *)ptr;
    if (old == expected) *(volatile int64_t *)ptr = desired;
    return old;
}

int __aarch64_swp1_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int8_t *)ptr;
    *(volatile int8_t *)ptr = val;
    return old;
}

int __aarch64_swp2_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int16_t *)ptr;
    *(volatile int16_t *)ptr = val;
    return old;
}

int __aarch64_swp4_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int32_t *)ptr;
    *(volatile int32_t *)ptr = val;
    return old;
}

int64_t __aarch64_swp8_acq_rel(int64_t val, volatile void *ptr) {
    int64_t old = *(volatile int64_t *)ptr;
    *(volatile int64_t *)ptr = val;
    return old;
}

int __aarch64_ldeor1_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int8_t *)ptr;
    *(volatile int8_t *)ptr = old ^ val;
    return old;
}

int __aarch64_ldeor2_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int16_t *)ptr;
    *(volatile int16_t *)ptr = old ^ val;
    return old;
}

int __aarch64_ldeor4_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int32_t *)ptr;
    *(volatile int32_t *)ptr = old ^ val;
    return old;
}

int64_t __aarch64_ldeor8_acq_rel(int64_t val, volatile void *ptr) {
    int64_t old = *(volatile int64_t *)ptr;
    *(volatile int64_t *)ptr = old ^ val;
    return old;
}

int __aarch64_ldclr1_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int8_t *)ptr;
    *(volatile int8_t *)ptr = old & ~val;
    return old;
}

int __aarch64_ldclr2_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int16_t *)ptr;
    *(volatile int16_t *)ptr = old & ~val;
    return old;
}

int __aarch64_ldclr4_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int32_t *)ptr;
    *(volatile int32_t *)ptr = old & ~val;
    return old;
}

int64_t __aarch64_ldclr8_acq_rel(int64_t val, volatile void *ptr) {
    int64_t old = *(volatile int64_t *)ptr;
    *(volatile int64_t *)ptr = old & ~val;
    return old;
}

int __aarch64_ldset1_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int8_t *)ptr;
    *(volatile int8_t *)ptr = old | val;
    return old;
}

int __aarch64_ldset2_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int16_t *)ptr;
    *(volatile int16_t *)ptr = old | val;
    return old;
}

int __aarch64_ldset4_acq_rel(int val, volatile void *ptr) {
    int old = *(volatile int32_t *)ptr;
    *(volatile int32_t *)ptr = old | val;
    return old;
}

int64_t __aarch64_ldset8_acq_rel(int64_t val, volatile void *ptr) {
    int64_t old = *(volatile int64_t *)ptr;
    *(volatile int64_t *)ptr = old | val;
    return old;
}

/* _impure_ptr for newlib compatibility */
struct _reent *_impure_ptr = NULL;

/* Time functions */
struct timeval {
    long tv_sec;
    long tv_usec;
};

int gettimeofday(struct timeval *tv, void *tz) {
    (void)tz;
    uint64_t us = timer_get_us();
    tv->tv_sec = us / 1000000;
    tv->tv_usec = us % 1000000;
    return 0;
}

/* Error handling */
void abort(void) {
    uart_puts("\r\nABORT\r\n");
    while (1) {
        __asm__ volatile("wfe");
    }
}

void __assert_func(const char *file, int line, const char *func, const char *expr) {
    printf("Assertion failed: %s, file %s, line %d, function %s\r\n", 
           expr, file, line, func ? func : "unknown");
    abort();
}

/* setjmp/longjmp for QuickJS error handling - using newlib */
