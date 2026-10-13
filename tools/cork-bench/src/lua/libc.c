/* The libc Lua 5.1 needs, freestanding: an allocator over a fixed heap, the string,
 * character and formatting routines, x87 mathematics and stubs for files. */
#include <stddef.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <math.h>
#include <locale.h>

int errno;
FILE *stdin = (FILE *)1, *stdout = (FILE *)2, *stderr = (FILE *)3;
/* Where text goes: nowhere on the bench's host; a native build of the same program
 * gives a strong definition that writes it. */
__attribute__((weak)) void __write(int fd, const char *s, size_t n){ (void)fd; (void)s; (void)n; }

/* Segregated power-of-two classes, an 8-byte header holding the class, over the heap the
 * link places (link.ld). */
extern char __heap_start[], __heap_end[];
static char *top_;
static void *free_[32];
static int class_of(size_t n){ size_t s = 16; int c = 4; while (s < n + 8) { s <<= 1; c++; } return c; }
void *malloc(size_t n){
    int c = class_of(n);
    void *p = free_[c];
    if (p) { free_[c] = *(void **)p; return p; }
    if (!top_) top_ = __heap_start;
    size_t s = (size_t)1 << c;
    if (top_ + s > __heap_end) return 0;
    char *b = top_; top_ += s; *(int *)b = c; return b + 8;
}
void free(void *p){ if (!p) return; int c = ((int *)p)[-2]; *(void **)p = free_[c]; free_[c] = p; }
void *realloc(void *p, size_t n){
    if (!p) return malloc(n);
    if (n == 0) { free(p); return 0; }
    int c = ((int *)p)[-2];
    if (n + 8 <= ((size_t)1 << c)) return p;
    void *q = malloc(n); if (!q) return 0;
    memcpy(q, p, ((size_t)1 << c) - 8); free(p); return q;
}
void *calloc(size_t n, size_t s){ void *p = malloc(n * s); if (p) memset(p, 0, n * s); return p; }

void *memcpy(void *d, const void *s, size_t n){ char *a = d; const char *b = s; while (n--) *a++ = *b++; return d; }
void *memmove(void *d, const void *s, size_t n){ char *a = d; const char *b = s; if (a < b) { while (n--) *a++ = *b++; } else { a += n; b += n; while (n--) *--a = *--b; } return d; }
void *memset(void *d, int c, size_t n){ unsigned char *a = d; while (n--) *a++ = (unsigned char)c; return d; }
int memcmp(const void *x, const void *y, size_t n){ const unsigned char *a = x, *b = y; for (; n; n--, a++, b++) if (*a != *b) return *a - *b; return 0; }
void *memchr(const void *s, int c, size_t n){ const unsigned char *p = s; for (; n; n--, p++) if (*p == (unsigned char)c) return (void *)p; return 0; }
size_t strlen(const char *s){ const char *p = s; while (*p) p++; return p - s; }
int strcmp(const char *a, const char *b){ while (*a && *a == *b) { a++; b++; } return (unsigned char)*a - (unsigned char)*b; }
int strncmp(const char *a, const char *b, size_t n){ for (; n; n--, a++, b++) { if (*a != *b) return (unsigned char)*a - (unsigned char)*b; if (!*a) return 0; } return 0; }
int strcoll(const char *a, const char *b){ return strcmp(a, b); }
char *strchr(const char *s, int c){ for (;; s++) { if (*s == (char)c) return (char *)s; if (!*s) return 0; } }
char *strrchr(const char *s, int c){ const char *r = 0; for (;; s++) { if (*s == (char)c) r = s; if (!*s) return (char *)r; } }
char *strpbrk(const char *s, const char *set){ for (; *s; s++) if (strchr(set, *s)) return (char *)s; return 0; }
size_t strspn(const char *s, const char *set){ size_t n = 0; while (s[n] && strchr(set, s[n])) n++; return n; }
size_t strcspn(const char *s, const char *set){ size_t n = 0; while (s[n] && !strchr(set, s[n])) n++; return n; }
char *strcpy(char *d, const char *s){ char *r = d; while ((*d++ = *s++)); return r; }
char *strncpy(char *d, const char *s, size_t n){ size_t i = 0; for (; i < n && s[i]; i++) d[i] = s[i]; for (; i < n; i++) d[i] = 0; return d; }
char *strcat(char *d, const char *s){ strcpy(d + strlen(d), s); return d; }
char *strncat(char *d, const char *s, size_t n){ char *e = d + strlen(d); while (n-- && *s) *e++ = *s++; *e = 0; return d; }
char *strstr(const char *h, const char *n){ size_t k = strlen(n); for (; *h; h++) if (!strncmp(h, n, k)) return (char *)h; return k ? 0 : (char *)h; }
char *strerror(int e){ (void)e; return "error"; }
char *getenv(const char *n){ (void)n; return 0; }
int abs(int v){ return v < 0 ? -v : v; }
long labs(long v){ return v < 0 ? -v : v; }
static unsigned seed_ = 1;
int rand(void){ seed_ = seed_ * 1103515245 + 12345; return (seed_ >> 16) & RAND_MAX; }
void srand(unsigned s){ seed_ = s; }
void abort(void){ for (;;) __asm__ volatile("hlt"); }
void exit(int c){ (void)c; abort(); }
static struct lconv lconv_ = { "." };
struct lconv *localeconv(void){ return &lconv_; }

unsigned long strtoul(const char *s, char **end, int base){
    const char *p = s; unsigned long v = 0; int any = 0;
    while (isspace(*p)) p++;
    if ((base == 0 || base == 16) && p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) { p += 2; base = 16; }
    if (base == 0) base = 10;
    for (;; p++) {
        int d = isdigit(*p) ? *p - '0' : islower(*p) ? *p - 'a' + 10 : isupper(*p) ? *p - 'A' + 10 : 99;
        if (d >= base) break;
        v = v * base + d; any = 1;
    }
    if (end) *end = (char *)(any ? p : s);
    return v;
}
long strtol(const char *s, char **end, int base){
    const char *p = s; while (isspace(*p)) p++;
    int neg = *p == '-'; if (*p == '-' || *p == '+') p++;
    char *e; unsigned long v = strtoul(p, &e, base);
    if (end) *end = e == p ? (char *)s : e;
    return neg ? -(long)v : (long)v;
}
static long double pow10l_(int e){ long double r = 1, b = 10; int n = e < 0 ? -e : e; while (n) { if (n & 1) r *= b; b *= b; n >>= 1; } return e < 0 ? 1 / r : r; }
double strtod(const char *s, char **end){
    const char *p = s; while (isspace(*p)) p++;
    int neg = 0; if (*p == '-' || *p == '+') neg = *p++ == '-';
    long double m = 0; int any = 0, scale = 0;
    while (isdigit(*p)) { m = m * 10 + (*p++ - '0'); any = 1; }
    if (*p == '.') { p++; while (isdigit(*p)) { m = m * 10 + (*p++ - '0'); scale--; any = 1; } }
    if (!any) { if (end) *end = (char *)s; return 0; }
    if (*p == 'e' || *p == 'E') {
        const char *q = p + 1; int en = 0, ex = 0;
        if (*q == '-' || *q == '+') en = *q++ == '-';
        if (isdigit(*q)) { while (isdigit(*q)) ex = ex * 10 + (*q++ - '0'); scale += en ? -ex : ex; p = q; }
    }
    if (end) *end = (char *)p;
    double v = (double)(m * pow10l_(scale));
    return neg ? -v : v;
}

/* Formatting. */
typedef struct { char *s; size_t n, at; } Out;
static void put(Out *o, char c){ if (o->at + 1 < o->n) o->s[o->at] = c; o->at++; }
static void puts_(Out *o, const char *s, size_t k){ while (k--) put(o, *s++); }
static void pad(Out *o, char c, int k){ while (k-- > 0) put(o, c); }
/* The decimal digits of v rounded to `digits` significant ones, and its exponent. */
static int digits_of(long double v, int digits, char *buf){
    int e = 0;
    if (v != 0) { while (v >= 10) { v /= 10; e++; } while (v < 1) { v *= 10; e--; } }
    unsigned long long m = (unsigned long long)(v * pow10l_(digits - 1) + 0.5L);
    if (m >= (unsigned long long)pow10l_(digits)) { m /= 10; e++; }
    for (int i = digits - 1; i >= 0; i--) { buf[i] = '0' + m % 10; m /= 10; }
    return e;
}
static int fmt_float(char *b, double x, int prec, char conv, int alt){
    char *p = b; long double v = x;
    if (v != v) return strcpy(b, "nan"), 3;
    if (v < 0) { *p++ = '-'; v = -v; }
    if (v > 1e308L * 10) { strcpy(p, "inf"); return p - b + 3; }
    if (prec < 0) prec = 6;
    char lower = conv | 32;
    if (lower == 'g') {
        int P = prec == 0 ? 1 : prec; char d[24];
        int e = digits_of(v, P > 18 ? 18 : P, d);
        if (P > e && e >= -4) { conv = 'f'; prec = P - 1 - e; }
        else { conv = conv == 'G' ? 'E' : 'e'; prec = P - 1; }
        int n = fmt_float(p, (double)v, prec, conv, alt) + (p - b);
        b[n] = 0;
        if (!alt) {
            char *dot = strchr(b, '.');
            if (dot) {
                char *ex = strpbrk(b, "eE"); char tail[8] = ""; if (ex) { strcpy(tail, ex); *ex = 0; }
                char *z = b + strlen(b) - 1; while (*z == '0') *z-- = 0; if (*z == '.') *z = 0;
                strcat(b, tail); n = strlen(b);
            }
        }
        return n;
    }
    if (lower == 'e') {
        char d[24]; int k = prec + 1 > 18 ? 18 : prec + 1;
        int e = digits_of(v, k, d);
        *p++ = d[0]; if (prec || alt) *p++ = '.';
        for (int i = 1; i <= prec; i++) *p++ = i < k ? d[i] : '0';
        *p++ = conv; *p++ = e < 0 ? '-' : '+'; if (e < 0) e = -e;
        if (e >= 100) *p++ = '0' + e / 100;
        *p++ = '0' + e / 10 % 10; *p++ = '0' + e % 10;
        return p - b;
    }
    /* f: the integer part, then prec digits */
    long double r = v * pow10l_(prec) + 0.5L;
    if (r < 1.8e19L) {
        unsigned long long m = (unsigned long long)r; char t[32]; int n = 0;
        do { t[n++] = '0' + m % 10; m /= 10; } while (m || n <= prec);
        for (int i = n - 1; i >= prec; i--) *p++ = t[i];
        if (prec || alt) *p++ = '.';
        for (int i = prec - 1; i >= 0; i--) *p++ = t[i];
        return p - b;
    }
    return (p - b) + fmt_float(p, (double)v, prec, 'e', alt);
}
int vsnprintf(char *s, size_t n, const char *f, va_list ap){
    Out o = { s, n, 0 };
    for (; *f; f++) {
        if (*f != '%') { put(&o, *f); continue; }
        f++;
        int left = 0, plus = 0, space = 0, alt = 0, zero = 0, width = 0, prec = -1, lng = 0;
        for (;; f++) { if (*f == '-') left = 1; else if (*f == '+') plus = 1; else if (*f == ' ') space = 1; else if (*f == '#') alt = 1; else if (*f == '0') zero = 1; else break; }
        if (*f == '*') { width = va_arg(ap, int); f++; } else while (isdigit(*f)) width = width * 10 + (*f++ - '0');
        if (*f == '.') { f++; prec = 0; if (*f == '*') { prec = va_arg(ap, int); f++; } else while (isdigit(*f)) prec = prec * 10 + (*f++ - '0'); }
        while (*f == 'l' || *f == 'h' || *f == 'L') { if (*f == 'l') lng++; f++; }
        char buf[400]; const char *str = buf; int len = 0, num = 0; char sign = 0;
        switch (*f) {
        case 'd': case 'i': {
            long long v = lng > 1 ? va_arg(ap, long long) : va_arg(ap, int);
            unsigned long long u = v < 0 ? -(unsigned long long)v : v; sign = v < 0 ? '-' : plus ? '+' : space ? ' ' : 0;
            char t[24]; int k = 0; do { t[k++] = '0' + u % 10; u /= 10; } while (u);
            while (k < prec) t[k++] = '0';
            for (int i = 0; i < k; i++) buf[i] = t[k - 1 - i]; len = k; num = 1; break; }
        case 'u': case 'x': case 'X': case 'o': case 'p': {
            unsigned long long u = *f == 'p' ? (unsigned long)va_arg(ap, void *) : lng > 1 ? va_arg(ap, unsigned long long) : va_arg(ap, unsigned);
            int base = *f == 'u' ? 10 : *f == 'o' ? 8 : 16; const char *dg = *f == 'X' ? "0123456789ABCDEF" : "0123456789abcdef";
            char t[24]; int k = 0; do { t[k++] = dg[u % base]; u /= base; } while (u);
            while (k < prec) t[k++] = '0';
            if (*f == 'p' || (alt && base == 16)) { t[k++] = *f == 'X' ? 'X' : 'x'; t[k++] = '0'; }
            for (int i = 0; i < k; i++) buf[i] = t[k - 1 - i]; len = k; num = 1; break; }
        case 'c': buf[0] = (char)va_arg(ap, int); len = 1; break;
        case 's': str = va_arg(ap, const char *); if (!str) str = "(null)"; len = strlen(str); if (prec >= 0 && len > prec) len = prec; break;
        case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': {
            double v = va_arg(ap, double); len = fmt_float(buf, v, prec, *f, alt);
            if (buf[0] != '-' && (plus || space)) { memmove(buf + 1, buf, len++); buf[0] = plus ? '+' : ' '; }
            num = 2; break; }
        case '%': buf[0] = '%'; len = 1; break;
        default: buf[0] = *f; len = 1; break;
        }
        int total = len + (sign ? 1 : 0);
        if (!left && !(zero && num)) pad(&o, ' ', width - total);
        if (sign) put(&o, sign);
        if (!left && zero && num) { if (num == 2 && (str[0] == '-' || str[0] == '+')) { put(&o, *str++); len--; } pad(&o, '0', width - total); }
        puts_(&o, str, len);
        if (left) pad(&o, ' ', width - total);
    }
    if (o.n) o.s[o.at < o.n ? o.at : o.n - 1] = 0;
    return o.at;
}
int vsprintf(char *s, const char *f, va_list ap){ return vsnprintf(s, (size_t)-1 >> 1, f, ap); }
int sprintf(char *s, const char *f, ...){ va_list ap; va_start(ap, f); int n = vsprintf(s, f, ap); va_end(ap); return n; }
int snprintf(char *s, size_t n, const char *f, ...){ va_list ap; va_start(ap, f); int k = vsnprintf(s, n, f, ap); va_end(ap); return k; }
int fprintf(FILE *fp, const char *f, ...){ char b[1024]; va_list ap; va_start(ap, f); int n = vsnprintf(b, sizeof b, f, ap); va_end(ap); fputs(b, fp); return n; }
int printf(const char *f, ...){ char b[1024]; va_list ap; va_start(ap, f); int n = vsnprintf(b, sizeof b, f, ap); va_end(ap); fputs(b, stdout); return n; }
int fputs(const char *s, FILE *f){ __write(f == stderr ? 2 : 1, s, strlen(s)); return 0; }
int fputc(int c, FILE *f){ char ch = (char)c; __write(f == stderr ? 2 : 1, &ch, 1); return c; }
int putchar(int c){ return fputc(c, stdout); }
size_t fwrite(const void *p, size_t s, size_t n, FILE *f){ __write(f == stderr ? 2 : 1, p, s * n); return n; }
size_t fread(void *p, size_t s, size_t n, FILE *f){ (void)p; (void)s; (void)n; (void)f; return 0; }
int fflush(FILE *f){ (void)f; return 0; }
FILE *fopen(const char *p, const char *m){ (void)p; (void)m; return 0; }
FILE *freopen(const char *p, const char *m, FILE *f){ (void)p; (void)m; (void)f; return 0; }
int fclose(FILE *f){ (void)f; return 0; }
int getc(FILE *f){ (void)f; return EOF; }
int ungetc(int c, FILE *f){ (void)f; return c; }
int feof(FILE *f){ (void)f; return 1; }
int ferror(FILE *f){ (void)f; return 0; }
char *fgets(char *s, int n, FILE *f){ (void)s; (void)n; (void)f; return 0; }

/* x87 mathematics, as a 2004 compiler's runtime computes it. */
static double round_with(double x, int mode){
    unsigned short cw, nw; double r;
    __asm__ volatile("fnstcw %0" : "=m"(cw));
    nw = (cw & ~0x0c00) | mode;
    __asm__ volatile("fldcw %1\n\tfrndint\n\tfldcw %2" : "=t"(r) : "m"(nw), "m"(cw), "0"(x));
    return r;
}
double floor(double x){ return round_with(x, 0x0400); }
double ceil(double x){ return round_with(x, 0x0800); }
double fabs(double x){ double r; __asm__("fabs" : "=t"(r) : "0"(x)); return r; }
double sqrt(double x){ double r; __asm__("fsqrt" : "=t"(r) : "0"(x)); return r; }
double fmod(double x, double y){ double r; __asm__("1: fprem\n\tfnstsw %%ax\n\tsahf\n\tjp 1b" : "=t"(r) : "0"(x), "u"(y) : "ax", "cc"); return r; }
double sin(double x){ double r; __asm__("fsin" : "=t"(r) : "0"(x)); return r; }
double cos(double x){ double r; __asm__("fcos" : "=t"(r) : "0"(x)); return r; }
double tan(double x){ double r; __asm__("fptan\n\tfstp %%st(0)" : "=t"(r) : "0"(x)); return r; }
double atan2(double y, double x){ double r; __asm__("fpatan" : "=t"(r) : "0"(x), "u"(y) : "st(1)"); return r; }
double atan(double x){ return atan2(x, 1); }
double asin(double x){ return atan2(x, sqrt((1 - x) * (1 + x))); }
double acos(double x){ return atan2(sqrt((1 - x) * (1 + x)), x); }
static double exp2_(double x){
    double i, r;
    __asm__("frndint" : "=t"(i) : "0"(x));
    __asm__("f2xm1" : "=t"(r) : "0"(x - i));
    r += 1;
    __asm__("fscale" : "=t"(r) : "0"(r), "u"(i));
    return r;
}
static double log2_(double x){ double r; __asm__("fld1\n\tfxch\n\tfyl2x" : "=t"(r) : "0"(x)); return r; }
double exp(double x){ return exp2_(x * 1.4426950408889634); }
double log(double x){ return log2_(x) * 0.6931471805599453; }
double log10(double x){ return log2_(x) * 0.30102999566398120; }
double pow(double x, double y){
    if (y == 0) return 1;
    if (x == 0) return y > 0 ? 0 : HUGE_VAL;
    if (x < 0) { double i = floor(y); if (i != y) return 0.0 / 0.0; double r = exp2_(y * log2_(-x)); return fmod(i, 2) != 0 ? -r : r; }
    return exp2_(y * log2_(x));
}
double sinh(double x){ double e = exp(x); return (e - 1 / e) / 2; }
double cosh(double x){ double e = exp(x); return (e + 1 / e) / 2; }
double tanh(double x){ double e = exp(2 * x); return (e - 1) / (e + 1); }
double modf(double x, double *ip){ double i = x < 0 ? ceil(x) : floor(x); *ip = i; return x - i; }
double ldexp(double x, int e){ double r; double ed = e; __asm__("fscale" : "=t"(r) : "0"(x), "u"(ed)); return r; }
double frexp(double x, int *e){
    if (x == 0) { *e = 0; return 0; }
    int k = 0; double a = fabs(x);
    while (a >= 1) { a /= 2; k++; }
    while (a < 0.5) { a *= 2; k--; }
    *e = k; return x < 0 ? -a : a;
}

/* 64-bit division, which i386 code calls out for: shift and subtract. */
unsigned long long __udivmoddi4(unsigned long long n, unsigned long long d, unsigned long long *rem){
    unsigned long long q = 0, r = 0;
    for (int i = 63; i >= 0; i--) { r = (r << 1) | ((n >> i) & 1); if (r >= d) { r -= d; q |= 1ULL << i; } }
    if (rem) *rem = r;
    return q;
}
unsigned long long __udivdi3(unsigned long long n, unsigned long long d){ return __udivmoddi4(n, d, 0); }
unsigned long long __umoddi3(unsigned long long n, unsigned long long d){ unsigned long long r; __udivmoddi4(n, d, &r); return r; }
long long __divdi3(long long n, long long d){ int neg = (n < 0) ^ (d < 0); unsigned long long q = __udivmoddi4(n < 0 ? -n : n, d < 0 ? -d : d, 0); return neg ? -(long long)q : (long long)q; }
long long __moddi3(long long n, long long d){ unsigned long long r; __udivmoddi4(n < 0 ? -n : n, d < 0 ? -d : d, &r); return n < 0 ? -(long long)r : (long long)r; }
