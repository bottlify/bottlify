/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A large program's shape rather than a hot loop's: five hundred and twelve
 * functions, each its own code with its own constants and one of eight
 * bodies, calling one another directly and through a table in an order the
 * data decides. What it measures is how the translator copes with a lot of
 * code each run a moderate number of times -- the forming, the entries, the
 * transfers between them -- which is where a real program spends its time
 * outside its few hottest loops.
 */

#include "rt.h"

namespace {

const u32 COUNT = 512;

typedef u32 (*Fn)(u32 x, u32 depth);
extern const Fn TABLE[COUNT];

static u32 data[1024];

template <int N> static u32 body(u32 x)
{
    constexpr u32 A = 0x9e3779b1u * (u32)(N + 1);
    constexpr u32 B = (u32)(N * 2654435761u) >> 7 | 1u;
    constexpr u32 S = (u32)(N % 29) + 1;
    switch (N % 8)
    {
    case 0:
        x = (x ^ A) * B;
        x ^= x >> S;
        break;
    case 1:
        for (u32 i = 0; i < 3 + (u32)N % 5; i++)
        {
            x = x * 5 + data[(x >> 3) & 1023] + i;
        }
        break;
    case 2:
        x = (x << S | x >> (32 - S)) + A;
        if (x & 0x100)
        {
            x -= B;
        }
        else
        {
            x ^= B << 1;
        }
        break;
    case 3: {
        u32 lo = x & 0xffff, hi = x >> 16;
        lo = lo * (A & 0xffff) + hi;
        hi = hi * (B & 0xffff) + lo;
        x = hi << 16 ^ lo;
        break;
    }
    case 4: {
        i32 s = (i32)x;
        s = s < 0 ? -s : s;
        x = (u32)s / ((B & 0xff) + 1) + (u32)s % ((A & 0xff) + 3);
        break;
    }
    case 5:
        data[(x + (u32)N) & 1023] ^= x;
        x += data[(x >> 11) & 1023];
        break;
    case 6: {
        u32 bits = 0;
        u32 v = x;
        while (v)
        {
            v &= v - 1;
            bits++;
        }
        x = x * (bits | 1) + A;
        break;
    }
    default:
        x = x > A ? x - A : A - x;
        x = x < B ? x * 3 : x >> 1;
        break;
    }
    return x;
}

template <int N> static u32 fn(u32 x, u32 depth)
{
    x = body<N>(x);
    if (depth == 0)
    {
        return x;
    }
    // A direct call to a neighbour, and an indirect one wherever the value says.
    if (x & 1)
    {
        x ^= fn<(N * 37 + 11) % COUNT>(x >> 1, depth - 1);
    }
    if (x & 6)
    {
        x += TABLE[(x >> 4) % COUNT](x, depth - 1);
    }
    return x;
}

} // namespace

// The table spelled out, eight to a row.
#define ROW(b)                                                                                     \
    fn<b + 0>, fn<b + 1>, fn<b + 2>, fn<b + 3>, fn<b + 4>, fn<b + 5>, fn<b + 6>, fn<b + 7>
#define ROWS(b) ROW(b), ROW(b + 8), ROW(b + 16), ROW(b + 24), ROW(b + 32), ROW(b + 40), ROW(b + 48), ROW(b + 56)

namespace {
const Fn TABLE[COUNT] = { ROWS(0), ROWS(64), ROWS(128), ROWS(192), ROWS(256), ROWS(320), ROWS(384),
    ROWS(448) };
}

#undef ROWS
#undef ROW

u32 workSpread(u32 iterations)
{
    Rng rng(0x5eed0007u);
    for (u32 i = 0; i < 1024; i++)
    {
        data[i] = rng.next();
    }
    u32 sum = 0;
    for (u32 it = 0; it < iterations; it++)
    {
        for (u32 k = 0; k < COUNT * 8; k++)
        {
            u32 start = rng.below(COUNT);
            sum = mix(sum, TABLE[start](rng.next(), 3));
        }
    }
    for (u32 i = 0; i < 1024; i++)
    {
        sum = mix(sum, data[i]);
    }
    return sum;
}
