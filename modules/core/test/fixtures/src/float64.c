/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Floating-point arguments and results across the system's functions in a
 * 64-bit process: the x64 convention passes a float or a double among the
 * first four arguments in the XMM register of its position -- XMM1 for the
 * second whatever the first is -- and returns one in XMM0. The runtime's
 * double functions answered on the host, its float forms, one in the guest's
 * own code, one taking a structure by its address, and arguments mixing
 * integers and doubles. Every call goes through a pointer, so the compiler
 * cannot answer it itself. Each check prints a line; the exit code counts
 * the checks that failed.
 */

typedef unsigned long DWORD;
typedef void *HANDLE;

__declspec(dllimport) void __stdcall ExitProcess(unsigned code);
__declspec(dllimport) HANDLE __stdcall GetStdHandle(DWORD which);
__declspec(dllimport) int __stdcall WriteFile(HANDLE file, const void *bytes, DWORD count,
    DWORD *written, void *overlapped);

struct complex { double x, y; };

/* The marker that says the program uses floating point, which the C
 * runtime's static library would have supplied; nothing reads it. */
int _fltused = 0;

__declspec(dllimport) double __cdecl sqrt(double);
__declspec(dllimport) double __cdecl pow(double, double);
__declspec(dllimport) double __cdecl fmod(double, double);
__declspec(dllimport) double __cdecl _hypot(double, double);
__declspec(dllimport) double __cdecl ldexp(double, int);
__declspec(dllimport) double __cdecl _jn(int, double);
__declspec(dllimport) double __cdecl atof(const char *);
__declspec(dllimport) double __cdecl strtod(const char *, char **);
__declspec(dllimport) double __cdecl fabs(double);
__declspec(dllimport) double __cdecl floor(double);
__declspec(dllimport) double __cdecl _copysign(double, double);
__declspec(dllimport) double __cdecl _cabs(struct complex);
__declspec(dllimport) char *__cdecl _gcvt(double, int, char *);
__declspec(dllimport) float __cdecl sqrtf(float);
__declspec(dllimport) float __cdecl powf(float, float);
__declspec(dllimport) float __cdecl atan2f(float, float);

static void say(const char *text)
{
    DWORD length = 0, written;
    while (text[length])
    {
        length++;
    }
    WriteFile(GetStdHandle((DWORD)-11), text, length, &written, 0);
}

static int failures = 0;
static void check(const char *what, int ok)
{
    say(ok ? "ok   " : "FAIL ");
    say(what);
    say("\r\n");
    failures += !ok;
}

static int same(const char *a, const char *b)
{
    while (*a && *a == *b)
    {
        a++;
        b++;
    }
    return *a == *b;
}

static double (*volatile unary)(double);
static double (*volatile binary)(double, double);
static float (*volatile unaryf)(float);
static float (*volatile binaryf)(float, float);

int mainCRTStartup(void)
{
    unary = sqrt;
    check("sqrt takes XMM0 and answers in XMM0", unary(2.0) == 1.4142135623730951);
    binary = pow;
    check("pow takes its second double in XMM1", binary(2.0, 10.0) == 1024.0
        && binary(1.5, -2.0) == 1.0 / 2.25);
    binary = fmod;
    check("fmod", binary(7.5, 2.0) == 1.5);
    binary = _hypot;
    check("_hypot", binary(3.0, 4.0) == 5.0);

    double (*volatile scale)(double, int) = ldexp;
    check("ldexp: a double in XMM0, then an int in EDX", scale(3.0, 4) == 48.0);
    double (*volatile bessel)(int, double) = _jn;
    double j = bessel(1, 2.5);
    check("_jn: an int in ECX, then a double in XMM1",
        j > 0.497094102464274 && j < 0.497094102464275);

    double (*volatile parse)(const char *) = atof;
    check("atof answers a double in XMM0", parse("2.75") == 2.75);
    double (*volatile parse2)(const char *, char **) = strtod;
    char *end = 0;
    const char *text = "-1e3 rest";
    check("strtod", parse2(text, &end) == -1000.0 && end == text + 4);

    unary = fabs;
    check("fabs, the runtime's own x86-64 code", unary(-3.5) == 3.5);
    unary = floor;
    check("floor, likewise", unary(2.7) == 2.0 && unary(-2.5) == -3.0);
    binary = _copysign;
    check("_copysign, answered on the host from its code's own description",
        binary(3.0, -1.0) == -3.0);

    double (*volatile magnitude)(struct complex) = _cabs;
    struct complex z = { 3.0, 4.0 };
    check("_cabs takes its structure by address", magnitude(z) == 5.0);

    char *(*volatile print)(double, int, char *) = _gcvt;
    char buffer[32];
    check("_gcvt: a double, an int and a pointer",
        print(1.25, 3, buffer) == buffer && same(buffer, "1.25"));

    unaryf = sqrtf;
    check("sqrtf takes and answers a float", unaryf(9.0f) == 3.0f);
    binaryf = powf;
    check("powf", binaryf(2.0f, 3.0f) == 8.0f);
    binaryf = atan2f;
    float angle = binaryf(1.0f, 1.0f);
    check("atan2f answers a float rounded from the double", angle == 0.785398185253143310546875f);

    ExitProcess(failures);
    return 0;
}
