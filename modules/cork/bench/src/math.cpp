/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A frame of vertex work done on the processor, as programs did before
 * hardware transform took it over and long after for their animation:
 * bones interpolated as quaternions, vertices skinned by up to four of them,
 * transformed, normals renormalised, lit by four lights, and triangles culled
 * against the view and by facing.
 */

#include "rt.h"

namespace {

struct Vec3 {
    float x, y, z;
};

struct Quat {
    float x, y, z, w;
};

struct Mat4 {
    float m[16];
};

struct Vertex {
    Vec3 p, n;
    u8 bone[4];
    float weight[4];
};

struct Light {
    Vec3 dir;
    float r, g, b;
};

const u32 BONES = 48;
const u32 VERTICES = 3072;
const u32 TRIANGLES = 4096;

static inline Vec3 add(Vec3 a, Vec3 b) { return { a.x + b.x, a.y + b.y, a.z + b.z }; }
static inline Vec3 scale(Vec3 a, float s) { return { a.x * s, a.y * s, a.z * s }; }
static inline float dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static inline Vec3 cross(Vec3 a, Vec3 b)
{
    return { a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x };
}

static Vec3 normalize(Vec3 v)
{
    float d = dot(v, v);
    if (d < 1e-12f)
    {
        return { 0.0f, 0.0f, 1.0f };
    }
    return scale(v, 1.0f / fsqrt(d));
}

static Quat slerp(Quat a, Quat b, float t)
{
    float c = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    if (c < 0.0f)
    {
        c = -c;
        b = { -b.x, -b.y, -b.z, -b.w };
    }
    float ka, kb;
    if (c > 0.9995f)
    {
        ka = 1.0f - t;
        kb = t;
    }
    else
    {
        // The angle from its cosine by a few Newton steps on cos, no acos.
        float angle = 1.5707963f - c * (1.0f + c * c * 0.16666667f);
        for (int i = 0; i < 3; i++)
        {
            angle += (fcos(angle) - c) / (fsin(angle) + 1e-6f);
        }
        float s = fsin(angle);
        ka = fsin((1.0f - t) * angle) / s;
        kb = fsin(t * angle) / s;
    }
    Quat q = { a.x * ka + b.x * kb, a.y * ka + b.y * kb, a.z * ka + b.z * kb, a.w * ka + b.w * kb };
    float n = 1.0f / fsqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    return { q.x * n, q.y * n, q.z * n, q.w * n };
}

static Mat4 fromQuat(Quat q, Vec3 t)
{
    float xx = q.x * q.x, yy = q.y * q.y, zz = q.z * q.z;
    float xy = q.x * q.y, xz = q.x * q.z, yz = q.y * q.z;
    float wx = q.w * q.x, wy = q.w * q.y, wz = q.w * q.z;
    Mat4 m;
    m.m[0] = 1 - 2 * (yy + zz);
    m.m[1] = 2 * (xy + wz);
    m.m[2] = 2 * (xz - wy);
    m.m[3] = 0;
    m.m[4] = 2 * (xy - wz);
    m.m[5] = 1 - 2 * (xx + zz);
    m.m[6] = 2 * (yz + wx);
    m.m[7] = 0;
    m.m[8] = 2 * (xz + wy);
    m.m[9] = 2 * (yz - wx);
    m.m[10] = 1 - 2 * (xx + yy);
    m.m[11] = 0;
    m.m[12] = t.x;
    m.m[13] = t.y;
    m.m[14] = t.z;
    m.m[15] = 1;
    return m;
}

static Mat4 multiply(const Mat4 &a, const Mat4 &b)
{
    Mat4 r;
    for (int i = 0; i < 4; i++)
    {
        for (int j = 0; j < 4; j++)
        {
            float s = 0;
            for (int k = 0; k < 4; k++)
            {
                s += a.m[k * 4 + j] * b.m[i * 4 + k];
            }
            r.m[i * 4 + j] = s;
        }
    }
    return r;
}

static inline Vec3 transformPoint(const Mat4 &m, Vec3 p)
{
    return { m.m[0] * p.x + m.m[4] * p.y + m.m[8] * p.z + m.m[12],
        m.m[1] * p.x + m.m[5] * p.y + m.m[9] * p.z + m.m[13],
        m.m[2] * p.x + m.m[6] * p.y + m.m[10] * p.z + m.m[14] };
}

static inline Vec3 transformVector(const Mat4 &m, Vec3 v)
{
    return { m.m[0] * v.x + m.m[4] * v.y + m.m[8] * v.z, m.m[1] * v.x + m.m[5] * v.y + m.m[9] * v.z,
        m.m[2] * v.x + m.m[6] * v.y + m.m[10] * v.z };
}

static float clamp01(float v)
{
    return v < 0.0f ? 0.0f : v > 1.0f ? 1.0f : v;
}

} // namespace

u32 workMath(u32 iterations)
{
    Rng rng(0x5eed0003u);
    Vertex *vertices = take<Vertex>(VERTICES);
    Vec3 *positions = take<Vec3>(VERTICES);
    u32 *colours = take<u32>(VERTICES);
    u16 *indices = take<u16>(TRIANGLES * 3);
    Quat *poseA = take<Quat>(BONES);
    Quat *poseB = take<Quat>(BONES);
    Vec3 *offsets = take<Vec3>(BONES);
    Mat4 *bones = take<Mat4>(BONES);
    u8 *parent = take<u8>(BONES);
    for (u32 i = 0; i < VERTICES; i++)
    {
        Vertex &v = vertices[i];
        v.p = { rng.unit() * 4 - 2, rng.unit() * 4 - 2, rng.unit() * 4 - 2 };
        v.n = normalize({ rng.unit() - 0.5f, rng.unit() - 0.5f, rng.unit() - 0.5f });
        float total = 0;
        u32 used = 1 + rng.below(4);
        for (u32 k = 0; k < 4; k++)
        {
            v.bone[k] = (u8)rng.below(BONES);
            v.weight[k] = k < used ? 0.1f + rng.unit() : 0.0f;
            total += v.weight[k];
        }
        for (u32 k = 0; k < 4; k++)
        {
            v.weight[k] /= total;
        }
    }
    for (u32 i = 0; i < TRIANGLES * 3; i++)
    {
        indices[i] = (u16)rng.below(VERTICES);
    }
    for (u32 b = 0; b < BONES; b++)
    {
        float a = rng.unit() * 3.0f, c = rng.unit() * 3.0f;
        poseA[b] = { fsin(a) * 0.6f, 0.0f, fsin(a) * 0.8f, fcos(a) };
        poseB[b] = { 0.0f, fsin(c), 0.0f, fcos(c) };
        offsets[b] = { rng.unit() - 0.5f, rng.unit(), rng.unit() - 0.5f };
        parent[b] = (u8)(b == 0 ? 0 : rng.below(b));
    }
    Light lights[4];
    for (Light &l : lights)
    {
        l.dir = normalize({ rng.unit() - 0.5f, rng.unit() - 0.5f, rng.unit() - 0.5f });
        l.r = rng.unit();
        l.g = rng.unit();
        l.b = rng.unit();
    }

    u32 sum = 0;
    for (u32 it = 0; it < iterations; it++)
    {
        float t = (float)(it % 64) * (1.0f / 64.0f);
        for (u32 b = 0; b < BONES; b++)
        {
            Mat4 local = fromQuat(slerp(poseA[b], poseB[b], t), offsets[b]);
            bones[b] = b == 0 ? local : multiply(bones[parent[b]], local);
        }
        Mat4 view = fromQuat(slerp(poseA[it % BONES], poseB[(it * 7) % BONES], 0.5f),
            { 0.0f, 0.0f, -8.0f });
        for (u32 i = 0; i < VERTICES; i++)
        {
            const Vertex &v = vertices[i];
            Vec3 p = { 0, 0, 0 }, n = { 0, 0, 0 };
            for (u32 k = 0; k < 4; k++)
            {
                float w = v.weight[k];
                if (w == 0.0f)
                {
                    continue;
                }
                const Mat4 &m = bones[v.bone[k]];
                p = add(p, scale(transformPoint(m, v.p), w));
                n = add(n, scale(transformVector(m, v.n), w));
            }
            p = transformPoint(view, p);
            n = normalize(transformVector(view, n));
            float r = 0.1f, g = 0.1f, bl = 0.1f;
            for (const Light &l : lights)
            {
                float d = dot(n, l.dir);
                if (d > 0.0f)
                {
                    float s = d * d;
                    s = s * s;
                    r += l.r * (d + s * 0.5f);
                    g += l.g * (d + s * 0.5f);
                    bl += l.b * (d + s * 0.5f);
                }
            }
            positions[i] = p;
            colours[i] = (u32)(i32)(clamp01(r) * 255.0f) | (u32)(i32)(clamp01(g) * 255.0f) << 8
                | (u32)(i32)(clamp01(bl) * 255.0f) << 16;
        }
        u32 visible = 0, back = 0, clipped = 0;
        for (u32 tri = 0; tri < TRIANGLES; tri++)
        {
            Vec3 a = positions[indices[tri * 3]];
            Vec3 b = positions[indices[tri * 3 + 1]];
            Vec3 c = positions[indices[tri * 3 + 2]];
            if (a.z > -0.1f && b.z > -0.1f && c.z > -0.1f)
            {
                clipped++;
                continue;
            }
            Vec3 face = cross({ b.x - a.x, b.y - a.y, b.z - a.z }, { c.x - a.x, c.y - a.y, c.z - a.z });
            if (dot(face, a) >= 0.0f)
            {
                back++;
                continue;
            }
            visible++;
            sum = mix(sum, colours[indices[tri * 3]] ^ tri);
        }
        sum = mix(sum, visible * 65536 + back * 256 + clipped);
        sum = mix(sum, bitsOf(positions[it % VERTICES].x));
    }
    return sum;
}
