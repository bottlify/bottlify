/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * What every workload shares: the imports the program names, a few helpers,
 * and no C runtime. The same bytes run under the engine and, through
 * `native/peload.c`, on the processor itself, so nothing here may depend on
 * which of the two answered: no clock, no address, no handle value reaches a
 * checksum.
 */

#pragma once

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int i32;
typedef unsigned long long u64;
typedef long long i64;

extern "C" {
__declspec(dllimport) void __stdcall ExitProcess(u32 code);
__declspec(dllimport) void *__stdcall GetStdHandle(u32 which);
__declspec(dllimport) int __stdcall WriteFile(void *file, const void *bytes, u32 count,
    u32 *written, void *overlapped);
__declspec(dllimport) const char *__stdcall GetCommandLineA(void);

void *memcpy(void *to, const void *from, u32 count);
void *memset(void *to, int value, u32 count);
void *memmove(void *to, const void *from, u32 count);
}

void say(const char *text);
void sayNumber(u32 value);
void sayHex(u32 value);

/* xorshift32: every workload's data comes from one of these, seeded. */
struct Rng {
    u32 s;
    explicit Rng(u32 seed) : s(seed ? seed : 0x9e3779b9u) {}
    u32 next()
    {
        u32 x = s;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        return s = x;
    }
    u32 below(u32 n) { return next() % n; }
    float unit() { return (float)(next() >> 8) * (1.0f / 16777216.0f); }
};

static inline u32 mix(u32 h, u32 v)
{
    h ^= v + 0x9e3779b9u + (h << 6) + (h >> 2);
    return h;
}

static inline u32 bitsOf(float f)
{
    union {
        float f;
        u32 u;
    } c;
    c.f = f;
    return c.u;
}

static inline u32 bitsOf(double d)
{
    union {
        double d;
        u32 u[2];
    } c;
    c.d = d;
    return c.u[0] ^ c.u[1];
}

/* Placement new: what gives an object its vtable, with no runtime linked. */
inline void *operator new(unsigned int, void *where)
{
    return where;
}

/* A bump allocator over a static arena, reset by each workload. */
void *arenaTake(u32 bytes);
void arenaReset();

template <typename T> static inline T *take(u32 count)
{
    return (T *)arenaTake(count * (u32)sizeof(T));
}

/* Polynomial sine and cosine: the same bits wherever they run. */
float fsin(float x);
float fcos(float x);
float fsqrt(float x);

/* Workloads: each returns its checksum. */
u32 workVm(u32 iterations);
u32 workEntities(u32 iterations);
u32 workMath(u32 iterations);
u32 workPath(u32 iterations);
u32 workLz(u32 iterations);
u32 workContainers(u32 iterations);
u32 workSpread(u32 iterations);
u32 workApi(u32 iterations);
