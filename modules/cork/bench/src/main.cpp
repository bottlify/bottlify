/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The entry point: `bench <workload> [iterations]` runs one workload, writes
 * `<workload> <iterations> <checksum>` and exits with the checksum.
 */

#include "rt.h"

extern "C" {

/* The compiler may emit calls to these for an aggregate copy or clear. */
void *memcpy(void *to, const void *from, u32 count)
{
    u8 *d = (u8 *)to;
    const u8 *s = (const u8 *)from;
    while (count >= 4)
    {
        *(u32 *)d = *(const u32 *)s;
        d += 4;
        s += 4;
        count -= 4;
    }
    while (count--)
    {
        *d++ = *s++;
    }
    return to;
}

void *memset(void *to, int value, u32 count)
{
    u8 *d = (u8 *)to;
    u32 word = (u8)value * 0x01010101u;
    while (count >= 4)
    {
        *(u32 *)d = word;
        d += 4;
        count -= 4;
    }
    while (count--)
    {
        *d++ = (u8)value;
    }
    return to;
}

void *memmove(void *to, const void *from, u32 count)
{
    u8 *d = (u8 *)to;
    const u8 *s = (const u8 *)from;
    if (d <= s || d >= s + count)
    {
        return memcpy(to, from, count);
    }
    while (count--)
    {
        d[count] = s[count];
    }
    return to;
}

/* The marker the compiler references when a program uses floating point. */
int _fltused = 0;
}

void say(const char *text)
{
    u32 length = 0, written;
    while (text[length])
    {
        length++;
    }
    WriteFile(GetStdHandle((u32)-11), text, length, &written, 0);
}

void sayNumber(u32 value)
{
    char text[12];
    int at = 11;
    text[at] = 0;
    do
    {
        text[--at] = (char)('0' + value % 10);
        value /= 10;
    } while (value);
    say(text + at);
}

void sayHex(u32 value)
{
    char text[9];
    for (int i = 7; i >= 0; i--)
    {
        text[i] = "0123456789abcdef"[value & 15];
        value >>= 4;
    }
    text[8] = 0;
    say(text);
}

static u8 arena[48 << 20];
static u32 arenaUsed;

void *arenaTake(u32 bytes)
{
    u32 at = (arenaUsed + 15) & ~15u;
    if (at + bytes > sizeof arena)
    {
        say("arena exhausted\r\n");
        ExitProcess(0xdead0001u);
    }
    arenaUsed = at + bytes;
    memset(arena + at, 0, bytes);
    return arena + at;
}

void arenaReset()
{
    arenaUsed = 0;
}

static const float PI = 3.14159265358979f;

float fsin(float x)
{
    // Into [-pi, pi], then an odd polynomial good to a few ulps there.
    float k = x * (1.0f / (2.0f * PI));
    int n = (int)(k + (k >= 0 ? 0.5f : -0.5f));
    x -= (float)n * (2.0f * PI);
    float x2 = x * x;
    return x * (1.0f + x2 * (-1.6666667e-1f + x2 * (8.3333310e-3f + x2 * (-1.9840874e-4f
        + x2 * (2.7525562e-6f + x2 * -2.3889859e-8f)))));
}

float fcos(float x)
{
    return fsin(x + 0.5f * PI);
}

float fsqrt(float x)
{
    return __builtin_sqrtf(x);
}

struct Workload {
    const char *name;
    u32 (*run)(u32 iterations);
    u32 iterations;
};

static const Workload WORKLOADS[] = {
    { "vm", workVm, 4 },
    { "entities", workEntities, 200 },
    { "math", workMath, 120 },
    { "path", workPath, 300 },
    { "lz", workLz, 6 },
    { "containers", workContainers, 4 },
    { "spread", workSpread, 100 },
    { "api", workApi, 40 },
};

static bool same(const char *a, const char *b, u32 length)
{
    for (u32 i = 0; i < length; i++)
    {
        if (a[i] != b[i])
        {
            return false;
        }
    }
    return b[length] == 0;
}

/* The next space-separated word of the command line, a quoted one whole. */
static const char *word(const char *at, const char **start, u32 *length)
{
    while (*at == ' ' || *at == '\t')
    {
        at++;
    }
    if (*at == '"')
    {
        *start = ++at;
        while (*at && *at != '"')
        {
            at++;
        }
        *length = (u32)(at - *start);
        return *at ? at + 1 : at;
    }
    *start = at;
    while (*at && *at != ' ' && *at != '\t')
    {
        at++;
    }
    *length = (u32)(at - *start);
    return at;
}

extern "C" void mainCRTStartup()
{
    // What a Windows thread starts with: double precision, round to nearest,
    // every exception masked.
    u16 control = 0x027f;
    __asm__ volatile("fldcw %0" : : "m"(control));

    const char *line = GetCommandLineA();
    const char *start;
    u32 length;
    line = word(line, &start, &length); // the program's own name
    line = word(line, &start, &length);
    const Workload *chosen = 0;
    for (const Workload &w : WORKLOADS)
    {
        if (same(start, w.name, length))
        {
            chosen = &w;
        }
    }
    if (!chosen)
    {
        say("usage: bench <vm|entities|math|path|lz|containers|spread|api> [iterations]\r\n");
        ExitProcess(0xdead0000u);
    }
    u32 iterations = chosen->iterations;
    line = word(line, &start, &length);
    if (length)
    {
        iterations = 0;
        for (u32 i = 0; i < length; i++)
        {
            iterations = iterations * 10 + (u32)(start[i] - '0');
        }
    }
    arenaReset();
    u32 sum = chosen->run(iterations);
    say(chosen->name);
    say(" ");
    sayNumber(iterations);
    say(" ");
    sayHex(sum);
    say("\r\n");
    ExitProcess(sum);
}
