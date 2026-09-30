/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A game world's update: thousands of objects of two dozen kinds, each kind a
 * class with its own virtual update, think and collide, stepped every frame in
 * an order that mixes the kinds -- so every call is an indirect one whose
 * target changes from one object to the next -- then bucketed into a grid and
 * tested pairwise within each cell.
 */

#include "rt.h"

namespace {

const u32 KINDS = 24;
const u32 GRID = 32;
const float SIZE = 256.0f;
const float CELL = SIZE / GRID;

struct World;

struct Entity {
    float x, y, vx, vy, heading, energy;
    u32 id, kind, hits, target, state;
    virtual void update(World &w, float dt) = 0;
    virtual u32 think(World &w) = 0;
    virtual u32 collide(Entity &other) = 0;
};

struct World {
    Entity **all;
    u32 count;
    u32 *cellCount;
    u32 *cellStart;
    u32 *order;
    u32 frame;
    Rng rng;
};

static inline float wrap(float v)
{
    if (v < 0.0f)
    {
        v += SIZE;
    }
    else if (v >= SIZE)
    {
        v -= SIZE;
    }
    return v;
}

template <int K> struct Actor final : Entity {
    static constexpr float SPEED = 0.5f + (float)K * 0.125f;
    static constexpr float RADIUS = 1.0f + (float)(K % 5) * 0.25f;

    void update(World &w, float dt) override
    {
        switch (K & 3)
        {
        case 0:
            x = wrap(x + vx * dt * SPEED);
            y = wrap(y + vy * dt * SPEED);
            break;
        case 1: {
            heading += dt * (0.05f + (float)K * 0.01f);
            float s = fsin(heading), c = fcos(heading);
            x = wrap(x + c * SPEED * dt);
            y = wrap(y + s * SPEED * dt);
            vx = c;
            vy = s;
            break;
        }
        case 2: {
            Entity *t = w.all[target];
            float dx = t->x - x, dy = t->y - y;
            float d2 = dx * dx + dy * dy + 0.0001f;
            float inv = SPEED / fsqrt(d2);
            vx = vx * 0.9f + dx * inv * 0.1f;
            vy = vy * 0.9f + dy * inv * 0.1f;
            x = wrap(x + vx * dt);
            y = wrap(y + vy * dt);
            break;
        }
        default:
            vy -= 0.02f * dt * (float)(K + 1);
            x += vx * dt;
            y += vy * dt;
            if (y < 0.0f)
            {
                y = -y;
                vy = -vy * (0.6f + (float)K * 0.01f);
            }
            if (x < 0.0f || x >= SIZE)
            {
                vx = -vx;
                x = x < 0.0f ? -x : 2.0f * SIZE - x - 0.001f;
            }
            if (y >= SIZE)
            {
                y = SIZE - 0.001f;
                vy = -vy;
            }
            break;
        }
        energy = energy * (0.999f - (float)K * 0.0001f) + (float)(hits & 3) * 0.01f;
    }

    u32 think(World &w) override
    {
        if ((w.frame + id) % (u32)(K + 2) == 0)
        {
            target = (id * (u32)(K + 7) + w.frame * 13) % w.count;
            state = (state * 5 + (u32)K) & 0xff;
        }
        if (energy < 0.25f)
        {
            energy += 0.5f;
            state ^= 0x100;
        }
        return state + (hits << K % 8);
    }

    u32 collide(Entity &o) override
    {
        float dx = o.x - x, dy = o.y - y;
        float r = RADIUS + 1.0f;
        if (dx * dx + dy * dy >= r * r)
        {
            return 0;
        }
        hits++;
        o.hits++;
        if (K & 1)
        {
            float tx = vx;
            vx = o.vx;
            o.vx = tx;
        }
        else
        {
            float ty = vy;
            vy = o.vy;
            o.vy = ty;
        }
        return (u32)K + 1 + o.kind;
    }
};

template <int K> Entity *make(void *at)
{
    return new (at) Actor<K>();
}

typedef Entity *(*Maker)(void *);
#define M4(n) make<n>, make<n + 1>, make<n + 2>, make<n + 3>
const Maker MAKERS[KINDS] = { M4(0), M4(4), M4(8), M4(12), M4(16), M4(20) };
#undef M4

} // namespace

u32 workEntities(u32 iterations)
{
    World w = { 0, 4096, 0, 0, 0, 0, Rng(0x5eed0002u) };
    w.all = take<Entity *>(w.count);
    w.cellCount = take<u32>(GRID * GRID);
    w.cellStart = take<u32>(GRID * GRID + 1);
    w.order = take<u32>(w.count);
    u8 *storage = take<u8>(w.count * 64);
    for (u32 i = 0; i < w.count; i++)
    {
        u32 kind = (i * 7 + (i >> 3)) % KINDS;
        Entity *e = MAKERS[kind](storage + i * 64);
        e->x = w.rng.unit() * SIZE;
        e->y = w.rng.unit() * SIZE;
        e->vx = w.rng.unit() - 0.5f;
        e->vy = w.rng.unit() - 0.5f;
        e->heading = w.rng.unit() * 6.28f;
        e->energy = 1.0f;
        e->id = i;
        e->kind = kind;
        e->hits = 0;
        e->target = w.rng.below(w.count);
        e->state = kind;
        w.all[i] = e;
    }
    u32 sum = 0;
    for (u32 it = 0; it < iterations; it++, w.frame++)
    {
        for (u32 i = 0; i < w.count; i++)
        {
            w.all[i]->update(w, 1.0f);
        }
        for (u32 i = 0; i < w.count; i++)
        {
            sum = mix(sum, w.all[i]->think(w));
        }
        // Bucket by cell: count, prefix, place.
        memset(w.cellCount, 0, GRID * GRID * sizeof(u32));
        for (u32 i = 0; i < w.count; i++)
        {
            Entity *e = w.all[i];
            u32 cx = (u32)(i32)(e->x * (1.0f / CELL)) & (GRID - 1);
            u32 cy = (u32)(i32)(e->y * (1.0f / CELL)) & (GRID - 1);
            e->state = (e->state & 0xffff) | (cy * GRID + cx) << 16;
            w.cellCount[cy * GRID + cx]++;
        }
        u32 run = 0;
        for (u32 c = 0; c < GRID * GRID; c++)
        {
            w.cellStart[c] = run;
            run += w.cellCount[c];
        }
        w.cellStart[GRID * GRID] = run;
        memset(w.cellCount, 0, GRID * GRID * sizeof(u32));
        for (u32 i = 0; i < w.count; i++)
        {
            u32 c = w.all[i]->state >> 16;
            w.order[w.cellStart[c] + w.cellCount[c]++] = i;
        }
        u32 contacts = 0;
        for (u32 c = 0; c < GRID * GRID; c++)
        {
            u32 from = w.cellStart[c], to = w.cellStart[c + 1];
            for (u32 a = from; a < to; a++)
            {
                Entity *ea = w.all[w.order[a]];
                for (u32 b = a + 1; b < to; b++)
                {
                    contacts += ea->collide(*w.all[w.order[b]]);
                }
            }
        }
        sum = mix(sum, contacts);
    }
    for (u32 i = 0; i < w.count; i++)
    {
        Entity *e = w.all[i];
        sum = mix(sum, bitsOf(e->x) ^ bitsOf(e->y) * 3 ^ e->hits);
    }
    return sum;
}
