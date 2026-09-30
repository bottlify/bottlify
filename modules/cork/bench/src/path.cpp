/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Path finding on a grid, the work a strategy game's units ask for: A* over
 * eight neighbours with a binary heap, integer costs and an octile estimate,
 * each query from a fresh start to a fresh goal on a map a third walls.
 */

#include "rt.h"

namespace {

const i32 W = 128;
const i32 H = 128;
const u32 CELLS = (u32)(W * H);

struct Heap {
    u32 *node;
    u32 *key;
    u32 size;

    void push(u32 n, u32 k)
    {
        u32 i = size++;
        while (i > 0)
        {
            u32 up = (i - 1) >> 1;
            if (key[up] <= k)
            {
                break;
            }
            node[i] = node[up];
            key[i] = key[up];
            i = up;
        }
        node[i] = n;
        key[i] = k;
    }

    u32 pop()
    {
        u32 top = node[0];
        u32 n = node[--size];
        u32 k = key[size];
        u32 i = 0;
        for (;;)
        {
            u32 child = i * 2 + 1;
            if (child >= size)
            {
                break;
            }
            if (child + 1 < size && key[child + 1] < key[child])
            {
                child++;
            }
            if (key[child] >= k)
            {
                break;
            }
            node[i] = node[child];
            key[i] = key[child];
            i = child;
        }
        node[i] = n;
        key[i] = k;
        return top;
    }
};

static inline u32 estimate(i32 x0, i32 y0, i32 x1, i32 y1)
{
    i32 dx = x0 > x1 ? x0 - x1 : x1 - x0;
    i32 dy = y0 > y1 ? y0 - y1 : y1 - y0;
    i32 lo = dx < dy ? dx : dy, hi = dx < dy ? dy : dx;
    return (u32)(lo * 14 + (hi - lo) * 10);
}

static const i32 DX[8] = { 1, -1, 0, 0, 1, 1, -1, -1 };
static const i32 DY[8] = { 0, 0, 1, -1, 1, -1, 1, -1 };
static const u32 COST[8] = { 10, 10, 10, 10, 14, 14, 14, 14 };

} // namespace

u32 workPath(u32 iterations)
{
    Rng rng(0x5eed0004u);
    u8 *wall = take<u8>(CELLS);
    u32 *g = take<u32>(CELLS);
    u32 *seen = take<u32>(CELLS);
    u32 *from = take<u32>(CELLS);
    Heap heap{ take<u32>(CELLS * 8), take<u32>(CELLS * 8), 0 };
    for (u32 i = 0; i < CELLS; i++)
    {
        wall[i] = rng.below(100) < 30;
    }
    // Corridors, so most queries have a way through.
    for (i32 y = 0; y < H; y += 8)
    {
        for (i32 x = 0; x < W; x++)
        {
            wall[y * W + x] = 0;
        }
    }
    for (i32 x = 0; x < W; x += 12)
    {
        for (i32 y = 0; y < H; y++)
        {
            wall[y * W + x] = 0;
        }
    }
    u32 sum = 0, stamp = 0;
    for (u32 q = 0; q < iterations; q++)
    {
        u32 start, goal;
        do
        {
            start = rng.below(CELLS);
        } while (wall[start]);
        do
        {
            goal = rng.below(CELLS);
        } while (wall[goal]);
        i32 gx = (i32)(goal % W), gy = (i32)(goal / W);
        stamp++;
        heap.size = 0;
        g[start] = 0;
        seen[start] = stamp;
        from[start] = start;
        heap.push(start, estimate((i32)(start % W), (i32)(start / W), gx, gy));
        u32 expanded = 0, found = 0;
        while (heap.size)
        {
            u32 n = heap.pop();
            if (n == goal)
            {
                found = 1;
                break;
            }
            expanded++;
            i32 x = (i32)(n % W), y = (i32)(n / W);
            u32 base = g[n];
            for (u32 d = 0; d < 8; d++)
            {
                i32 nx = x + DX[d], ny = y + DY[d];
                if (nx < 0 || ny < 0 || nx >= W || ny >= H)
                {
                    continue;
                }
                u32 m = (u32)(ny * W + nx);
                if (wall[m])
                {
                    continue;
                }
                if (d >= 4 && (wall[(u32)(y * W + nx)] || wall[(u32)(ny * W + x)]))
                {
                    continue; // no cutting corners
                }
                u32 cost = base + COST[d];
                if (seen[m] == stamp && g[m] <= cost)
                {
                    continue;
                }
                seen[m] = stamp;
                g[m] = cost;
                from[m] = n;
                heap.push(m, cost + estimate(nx, ny, gx, gy));
            }
        }
        u32 length = 0;
        if (found)
        {
            for (u32 n = goal; n != start; n = from[n])
            {
                length++;
            }
        }
        sum = mix(sum, found ? g[goal] * 131 + length : 0xffffffffu);
        sum = mix(sum, expanded);
    }
    return sum;
}
