/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate as run } from './hlsl-gate.fixture.js';
import { parseShader } from '../../graphics/d3d9/shader.js';
import { translateShader } from '../../graphics/d3d9/wgsl.js';

/**
 * The gate, and then the check that the translator of bytecode to WGSL takes
 * what the compiler wrote.
 *
 * @param {string} source @param {string} profile
 * @param {import('./hlsl-gate.fixture.js').GateOptions} [options]
 */
async function runGate(source, profile, options){
    const result = await run(source, profile, options);
    const parsed = parseShader(result.tokens);
    assert.equal(parsed.error, null, `${profile}: the bytecode parses`);
    assert.equal(translateShader(parsed).error, null, `${profile}: it translates to WGSL`);
    return result;
}

const PS = ['ps_2_0', 'ps_2_a', 'ps_3_0'];
const VS = ['vs_1_1', 'vs_2_0', 'vs_3_0'];

/**
 * @typedef {Object} Case
 * @property {string} name
 * @property {string} body       Statements of the shader's entry; it ends by assigning `r`
 *           (a pixel shader) or the members of `o` (a vertex shader).
 * @property {string} [decls]    Declarations before the entry.
 * @property {string[]} [profiles]
 * @property {import('./hlsl-gate.fixture.js').GateOptions} [options]
 */

/** @param {Case} c */
function pixel(c){
    return `${c.decls ?? ''}
struct PSIn { float4 a : TEXCOORD0; float4 b : TEXCOORD1; float4 c : COLOR0; };
float4 main(PSIn i) : COLOR0
{
    float4 r = 0;
    ${c.body}
    return r;
}`;
}

/** @param {Case} c */
function vertex(c){
    return `${c.decls ?? ''}
struct VSIn { float4 p : POSITION; float4 a : TEXCOORD0; float4 b : TEXCOORD1; float4 c : COLOR0; };
struct VSOut { float4 pos : POSITION; float4 o0 : TEXCOORD0; float4 o1 : TEXCOORD1;
    float4 col : COLOR0; };
VSOut main(VSIn i)
{
    VSOut o = (VSOut)0;
    o.pos = i.p;
    ${c.body}
    return o;
}`;
}

/** @param {'ps' | 'vs'} kind @param {Case[]} cases */
function suite(kind, cases){
    for (const c of cases)
    {
        const source = kind === 'ps' ? pixel(c) : vertex(c);
        for (const profile of c.profiles ?? (kind === 'ps' ? PS : VS))
        {
            test(`${kind}: ${c.name} (${profile})`, async()=>{
                await runGate(source, profile, c.options);
            });
        }
    }
}


suite('ps', [
    {
        name: 'scalar arithmetic',
        body: 'r = float4(i.a.x + i.b.y, i.a.y - i.b.x, i.a.z * i.b.w, i.a.w + 3.0);',
    },
    {
        name: 'vector arithmetic',
        body: 'r = i.a * i.b + i.c - i.a;',
    },
    {
        name: 'swizzles and write masks',
        body: 'r = i.a.wzyx; r.xy = i.b.yx; r.zw += i.c.xx;',
    },
    {
        name: 'negation and compound assignment',
        body: 'r = -i.a; r *= i.b; r -= -i.c; r += 1; r /= 2;',
        options: { ulp: 2 },
    },
    {
        name: 'division',
        body: 'r = i.a / (abs(i.b) + 0.5); r.x = i.c.x / i.b.w;',
        options: { ulp: 3 },
    },
    {
        name: 'a scalar spread over a vector',
        body: 'r = i.a * i.b.x + i.c.y; r.w = 2 * i.c.w;',
    },
    {
        name: 'comparisons of vectors',
        body: `r = (float4)(i.a < i.b); r += 2 * (float4)(i.a >= i.c); r -= 4 *
(float4)(i.b
            == i.b);`,
    },
    {
        name: 'all six comparisons',
        body: `r.x = (i.a.x < i.b.x) + (i.a.x <= i.b.x) * 2 + (i.a.x > i.b.x) * 4; r.y =
            (i.a.y >= i.b.y) + (i.a.y == i.b.y) * 2 + (i.a.y != i.b.y) * 4; r.zw = (i.a.zw
            == i.a.zw) + (i.a.zw != i.b.zw);`,
    },
    {
        name: 'logical operators',
        body: `r.x = (i.a.x > 0 && i.b.x < 0) ? 1 : 0; r.y = (i.a.y > 0 || i.b.y > 0) ? 1 :
            0; r.z = !(i.a.z > 0) ? 3 : 4; r.w = (i.a.w > 0 && !(i.b.w > 0)) + 5;`,
    },
    {
        name: 'ternary on a scalar and on whole vectors',
        body: 'r = i.a.x > i.b.x ? i.a : i.b; r.w = i.c.x < 0 ? 7 : i.c.w;',
    },
    {
        name: 'if and else assign in both arms',
        body: 'if (i.a.x > i.b.x) { r = i.a; r.y = 5; } else { r = i.b; r.z = -5; }',
    },
    {
        name: 'if without else, else if chains',
        body: `r = i.c; if (i.a.x > 0.5) r.x = 1; if (i.a.y > 0) r.y = 2; else if
(i.a.z > 0)
            r.y = 3; else if (i.a.w > 0) r.y = 4; else r.y = 5;`,
    },
    {
        name: 'nested if',
        body: `if (i.a.x > 0) { if (i.b.x > 0) r = i.a; else r = i.b; } else { r =
i.c; }`,
    },
    {
        name: 'a function with early returns',
        decls: `float4 f(float4 x) { if (x.x > 0) return x * 2; if (x.y > 0) return
x.yzwx;
            return -x; }`,
        body: 'r = f(i.a) + f(i.b);',
    },
    {
        name: 'return inside both arms and after',
        decls: `float g(float x, float y) { if (x > y) { if (x > 1) return 1; return 2;
} else
            return 3; }`,
        body: `r = float4(g(i.a.x, i.b.x), g(i.a.y, i.b.y), g(i.a.z, 0.5), g(i.b.w, i.a.w));`,
    },
    {
        name: 'in, out and inout parameters',
        decls: `void h(in float4 x, out float4 y, inout float4 z) { y = x * 2; z += x; }`,
        body: 'float4 y, z = i.b; h(i.a, y, z); r = y - z;',
    },
    {
        name: 'out parameter written in a branch',
        decls: 'void k(float x, out float y) { y = 1; if (x > 0) y = 2; }',
        body: 'float y0, y1; k(i.a.x, y0); k(i.b.x, y1); r = float4(y0, y1, 0, 1);',
    },
    {
        name: 'for loop with a constant count',
        body: 'for (int k = 0; k < 4; k++) r += i.a * k + i.b;',
    },
    {
        name: 'nested loops',
        body: `for (int k = 0; k < 3; k++) for (int j = 0; j < 2; j++) r.x += k * j +
i.a.x;`,
    },
    {
        name: 'while and do-while',
        body: `int k = 0; while (k < 3) { r += i.a; k++; } do { r -= i.b; k--; } while
(k >
            1);`,
    },
    {
        name: 'break and continue with known conditions',
        body: `for (int k = 0; k < 6; k++) { if (k == 4) break; if (k % 2 == 1)
continue; r
            += i.a * k; }`,
    },
    {
        name: 'a struct local with nested members',
        decls: `struct Light { float3 dir; float4 color; }; struct Rig { Light key;
Light
            fill; float gain; };`,
        body: `Rig rig; rig.key.dir = i.a.xyz; rig.key.color = i.b; rig.fill.dir = i.c.xyz;
            rig.fill.color = rig.key.color.wzyx; rig.gain = 2; r = rig.fill.color *
            rig.gain + float4(rig.key.dir + rig.fill.dir, 0);`,
    },
    {
        name: 'a local array with constant indices',
        body: `float4 t[3]; t[0] = i.a; t[1] = i.b; t[2] = i.c; r = t[0] + t[1] * t[2];`,
    },
    {
        name: 'a local array indexed by a computed value',
        body: `float4 t[3] = { i.a, i.b, i.c }; int k = (int)(abs(i.a.x) * 1.5); r = t[k %
            3];`,
    },
    {
        name: 'uniform arrays with constant indices',
        decls: 'float4 L[4]; float W[3];',
        body: 'r = L[0] * W[1] + L[3] * W[2] + i.a;',
    },
    {
        name: 'uniform array in an unrolled loop',
        decls: 'float4 L[4];',
        body: 'for (int k = 0; k < 4; k++) r += L[k] * i.a.x;',
    },
    {
        name: 'constructors and casts',
        body: `r = float4(i.a.xy, 0.5, 1); r.xy = (float2)i.b; r.z = (int)(i.c.z * 3);
r.w =
            (bool)i.c.w;`,
    },
    {
        name: 'a vector truncated by a cast and an assignment',
        body: `float3 t = (float3)i.a; float2 u = i.b.xy; r = float4(t + float3(u,
            0),
(float)i.c);`,
    },
    {
        name: 'integer variables',
        body: `int a = 7; int b = 2; r.x = a * b + (int)i.a.x; r.y = a - b; r.z =
(float)a /
            2;`,
    },
    {
        name: 'static const and global initialisers',
        decls: `static const float K = 2.5; static float4 S = float4(1, 2, 3, 4);
static const
            int N = 3;`,
        body: 'r = i.a * K + S; for (int k = 0; k < N; k++) r.x += 1;',
    },
    {
        name: 'uniform scalars, vectors, booleans and integers',
        decls: 'float s; float3 v; bool flag; int n;',
        body: 'r.xyz = v * s; r.w = flag ? 1 : 2; if (flag) r += i.a; r.x += n;',
    },
]);

suite('ps', [
    {
        name: 'sqrt, rsqrt and length',
        body: `r = float4(sqrt(i.a.x), rsqrt(i.a.y), length(i.a.xyz), length(i.a.w));`,
        options: { range: { lo: 0.25, hi: 3 }, ulp: 2 },
    },
    {
        name: 'pow, exp, exp2, log, log2, log10',
        body: `r = float4(pow(i.a.x, i.b.y), exp(i.b.z), exp2(i.a.w), log(i.b.x)
            +
log2(i.a.y) + log10(i.c.z));`,
        options: { range: { lo: 0.25, hi: 3 }, ulp: 4, absolute: 0.000002 },
    },
    {
        name: 'floor, ceil, frac, trunc, round',
        body: `r = floor(i.a) + ceil(i.b) * 10 + frac(i.c) * 100; r.w += trunc(i.a.x)
+
            round(i.b.y);`,
        options: { range: { lo: -3.3, hi: 3.3 }, absolute: 0.00001 },
    },
    {
        name: 'abs, sign, saturate, clamp, min, max',
        body: `r = abs(i.a) + sign(i.b) + saturate(i.c) + clamp(i.a, -0.5, 0.75) +
min(i.a,
            i.b) + max(i.b, i.c);`,
    },
    {
        name: 'lerp, step, smoothstep',
        body: 'r = lerp(i.a, i.b, i.c) + step(i.a, i.b) + smoothstep(-1, 1, i.c);',
        options: { ulp: 3 },
    },
    {
        name: 'sin and cos',
        body: 'r.xy = sin(i.a.xy) + cos(i.b.xy) * 2; r.zw = cos(i.c.zw);',
        profiles: ['ps_2_a', 'ps_3_0'],
        options: { absolute: 0.00003, range: { lo: -3, hi: 3 } },
    },
    {
        name: 'sin and cos of one value',
        body: 'r = sin(i.a.x) + cos(i.b.y) * 2;',
        profiles: ['ps_2_0'],
        options: { absolute: 0.00003, range: { lo: -3, hi: 3 } },
    },
    {
        name: 'sincos',
        body: 'float4 s, c; sincos(i.a, s, c); r = s * c + c;',
        options: { absolute: 0.00003, range: { lo: -3, hi: 3 } },
    },
    {
        name: 'tan',
        body: 'r = tan(i.a * 0.4);',
        options: { absolute: 0.0002, range: { lo: -1, hi: 1 } },
    },
    {
        name: 'atan, atan2',
        body: `r = float4(atan(i.a.x), atan(i.a.y * 5), atan2(i.b.x, i.b.y),
atan2(i.c.z,
            i.a.w));`,
        profiles: ['ps_2_a', 'ps_3_0'],
        options: { absolute: 0.000005 },
    },
    {
        name: 'acos and asin',
        body: 'r = float4(acos(i.a.x), asin(i.a.y), acos(i.b.z), asin(i.b.w));',
        profiles: ['ps_2_a', 'ps_3_0'],
        options: { range: { lo: -1, hi: 1 }, absolute: 0.000005 },
    },
    {
        name: 'sinh, cosh, tanh',
        body: 'r = float4(sinh(i.a.x), cosh(i.a.y), tanh(i.a.z), tanh(i.a.w * 4));',
        options: { absolute: 0.00002, ulp: 6 },
    },
    {
        name: 'dot, cross, normalize, distance',
        body: `r = float4(dot(i.a.xy, i.b.xy), dot(i.a.xyz, i.b.xyz), dot(i.a,
            i.b),
distance(i.a, i.b)); r.xyz += cross(i.a.xyz, i.c.xyz) +
            normalize(i.b.xyz);`,
        options: { ulp: 4 },
    },
    {
        name: 'reflect, refract and faceforward',
        body: `float3 n = normalize(i.b.xyz); r.xyz = reflect(i.a.xyz, n)
            +
refract(normalize(i.a.xyz), n, 0.7) + faceforward(n, i.c.xyz, i.a.xyz);`,
        options: { absolute: 0.000003 },
    },
    {
        name: 'lit',
        body: 'r = lit(i.a.x, i.b.y, abs(i.c.z) + 1);',
        options: { ulp: 6 },
    },
    {
        name: 'fmod, degrees, radians',
        body: `r = float4(fmod(i.a.x * 3.7, 1.3), degrees(i.a.y), radians(i.a.z),
fmod(-i.b.x
            * 2.9, 1.1));`,
        options: { ulp: 4, absolute: 0.00001 },
    },
    {
        name: 'any and all',
        body: `r.x = any(i.a > 0) + all(i.b > 0) * 2 + any(i.c.xy) * 4; r.y =
all(i.a.zw <
            1);`,
    },
    {
        name: 'modf',
        body: 'float4 ip; r = modf(i.a * 2, ip) + ip;',
        options: { absolute: 0.00001 },
    },
    {
        name: 'matrix constants with mul in both orders',
        decls: 'float4x4 M; float3x3 N;',
        body: `r = mul(i.a, M) + mul(M, i.b); r.xyz += mul(i.c.xyz, N) + mul(N,
i.a.xyz);`,
        options: { ulp: 4 },
    },
    {
        name: 'row-major matrices',
        decls: 'row_major float4x4 M; row_major float3x4 P;',
        body: 'r = mul(i.a, M) + mul(M, i.b); r.xyz += mul(P, i.c);',
        options: { ulp: 4 },
    },
    {
        name: 'matrix product, transpose, rows and elements',
        decls: 'float4x4 M; float4x4 N;',
        body: `float4x4 T = mul(M, N); r = T[1] + transpose(T)[2] + float4(T._m00,
T._22,
            T._m13, M._11);`,
        options: { ulp: 6 },
    },
    {
        name: 'matrix arithmetic and constructors',
        decls: 'float2x2 M;',
        body: `float2x2 A = M * 2 + float2x2(i.a.xy, i.b.xy); r.xy = A[0] + A[1]; r.zw
=
            mul(A, i.c.xy);`,
    },
    {
        name: 'determinant',
        decls: 'float3x3 M; float2x2 K;',
        body: 'r.x = determinant(M); r.y = determinant(K);',
        options: { ulp: 8 },
    },
    {
        name: 'a matrix cast to a smaller one',
        decls: 'float4x4 M;',
        body: 'float3x3 N = (float3x3)M; r.xyz = mul(i.a.xyz, N);',
    },
    {
        name: 'structure uniforms',
        decls: 'struct Mat { float4 diffuse; float power; float3 tint; }; Mat m;',
        body: 'r = m.diffuse * i.a; r.xyz *= m.tint; r.w += m.power;',
    },
]);

suite('ps', [
    {
        name: 'a texture read',
        decls: 'sampler2D S;',
        body: 'r = tex2D(S, i.a.xy) * i.c;',
    },
    {
        name: 'two samplers and a dependent read',
        decls: 'sampler2D A : register(s0); sampler2D B : register(s1);',
        body: 'float4 t = tex2D(A, i.a.xy); r = tex2D(B, t.xy * 0.5 + i.b.zw) + t;',
    },
    {
        name: 'projective, biased and cube reads',
        decls: 'sampler2D A; samplerCUBE C; sampler3D V;',
        body: `r = tex2Dproj(A, i.a) + tex2Dbias(A, i.b) + texCUBE(C, i.c.xyz) +
tex3D(V,
            i.a.xyz);`,
        options: { range: { lo: 0.25, hi: 3 }, ulp: 3 },
    },
    {
        name: 'a level of detail',
        decls: 'sampler2D A;',
        body: 'r = tex2Dlod(A, i.a);',
        profiles: ['ps_3_0'],
    },
    {
        name: 'gradients',
        decls: 'sampler2D A;',
        body: 'r = tex2Dgrad(A, i.a.xy, i.b.xy, i.c.xy);',
        profiles: ['ps_2_a', 'ps_3_0'],
    },
    {
        name: 'derivatives',
        body: 'r = ddx(i.a) + ddy(i.b) * 2; r.w = fwidth(i.c.x);',
        profiles: ['ps_2_a', 'ps_3_0'],
    },
    {
        name: 'discard under a condition',
        body: 'r = i.a; if (i.b.x < -1) discard; r *= 2;',
        options: { trials: 40 },
    },
    {
        name: 'clip',
        body: 'r = i.a; clip(i.b.x + 0.8); clip(i.c.xy);',
        options: { trials: 40 },
    },
]);

suite('ps', [
    {
        name: 'position and face',
        body: 'r = i.a;',
        profiles: ['ps_3_0'],
    },
]);

suite('vs', [
    {
        name: 'copies and arithmetic',
        body: 'o.o0 = i.a * 2 + i.b; o.o1 = i.a.wzyx - i.b; o.col = i.c;',
    },
    {
        name: 'a position through a matrix',
        decls: 'float4x4 WVP;',
        body: 'o.pos = mul(i.p, WVP); o.o0 = i.a; o.col = i.c * 0.5;',
        options: { ulp: 4 },
    },
    {
        name: 'a matrix palette indexed by an input',
        decls: 'float4x4 Bones[8];',
        body: `int k = (int)abs(i.a.x * 2.9); float4 t = mul(i.p, Bones[k]); o.pos =
t; o.o0
            = mul(i.b, Bones[(int)(abs(i.a.y) * 3)]);`,
        options: { ulp: 5, range: { lo: -1, hi: 1 } },
    },
    {
        name: 'vectors indexed by a computed value',
        decls: 'float4 Table[6];',
        body: `int k = (int)(abs(i.a.x) * 2.5); o.o0 = Table[k] + Table[k + 1]; o.o1
            =
Table[5 - k];`,
        options: { range: { lo: -1, hi: 1 } },
    },
    {
        name: 'lighting with a loop',
        decls: 'float4 LightDir[3]; float4 LightColor[3]; float4 Ambient;',
        body: `float4 sum = Ambient; for (int k = 0; k < 3; k++) sum += LightColor[k]
*
            saturate(dot(normalize(i.a.xyz), LightDir[k].xyz)); o.col = sum;`,
        options: { ulp: 6 },
    },
    {
        name: 'fog and point size outputs',
        decls: `struct O { float4 pos : POSITION; float fog : FOG; float size : PSIZE;
float2
            uv : TEXCOORD2; };O fogVs(float4 p : POSITION, float4 a : TEXCOORD0) { O o;
            o.pos = p;
o.fog = saturate(a.x); o.size = a.y * 2; o.uv = a.zw; return o; }`,
        body: 'o.o0 = i.a;',
        options: { entry: 'fogVs' },
    },
    {
        name: 'sine in a vertex shader',
        body: 'o.o0 = sin(i.a); o.o1 = cos(i.b * 0.5);',
        options: { absolute: 0.00003, range: { lo: -3, hi: 3 } },
    },
]);

/** @param {string} source @param {string[]} profiles @param {string} name */
function whole(name, source, profiles, options = {}){
    for (const profile of profiles)
    {
        test(`whole: ${name} (${profile})`, async()=>{
            await runGate(source, profile, options);
        });
    }
}

whole('bump-mapped lighting', `
sampler2D Diffuse : register(s0);
sampler2D Normals : register(s1);
float4 LightPos; float4 LightColor; float4 Ambient; float Shininess;
struct VSOut { float4 pos : POSITION; float2 uv : TEXCOORD0; float3 light : TEXCOORD1;
    float3 view : TEXCOORD2; float4 color : COLOR0; };
float4 main(VSOut i) : COLOR0
{
    float3 n = tex2D(Normals, i.uv).xyz * 2 - 1;
    n = normalize(n);
    float3 l = normalize(i.light);
    float3 v = normalize(i.view);
    float3 h = normalize(l + v);
    float diff = saturate(dot(n, l));
    float spec = pow(saturate(dot(n, h)), Shininess * 8 + 1);
    float4 base = tex2D(Diffuse, i.uv) * i.color;
    return base * (Ambient + LightColor * diff) + LightColor * spec;
}`, ['ps_2_0', 'ps_2_b', 'ps_3_0'], { range: { lo: 0.2, hi: 2 }, ulp: 8, absolute: 5e-6 });

whole('skinned vertex shader', `
float4x4 World; float4x4 ViewProj; float4x3 Bones[16];
struct VSIn { float4 pos : POSITION; float3 nrm : NORMAL; float4 weights : BLENDWEIGHT;
    float4 indices : BLENDINDICES; float2 uv : TEXCOORD0; };
struct VSOut { float4 pos : POSITION; float3 nrm : TEXCOORD1; float2 uv : TEXCOORD0; };
VSOut main(VSIn i)
{
    int4 idx = D3DCOLORtoUBYTE4(i.indices);
    float3 p = 0; float3 n = 0;
    for (int k = 0; k < 4; k++)
    {
        float4x3 b = Bones[idx[k] % 16];
        p += mul(i.pos, b) * i.weights[k];
        n += mul(i.nrm, (float3x3)b) * i.weights[k];
    }
    VSOut o;
    o.pos = mul(float4(p, 1), mul(World, ViewProj));
    o.nrm = normalize(n);
    o.uv = i.uv;
    return o;
}`, ['vs_2_0', 'vs_3_0'], { range: { lo: 0, hi: 1 }, ulp: 12, absolute: 1e-5 });

whole('input structure with a member the pixel shader cannot have', `
struct In { float4 pos : POSITION; float4 a : TEXCOORD0; float4 c : COLOR0; };
float4 main(In i) : COLOR0 { return i.a * i.c; }`, ['ps_2_0', 'ps_3_0']);

whole('an output member that is never set', `
struct Out { float4 pos : POSITION; float4 a : TEXCOORD0; float4 c : COLOR0; };
Out main(float4 p : POSITION, float4 t : TEXCOORD0)
{
    Out o;
    o.pos = p;
    o.a = t * 2;
    return o;
}`, ['vs_1_1', 'vs_2_0', 'vs_3_0']);

whole('position and face of a pixel', `
float4 main(float2 vpos : VPOS, float f : VFACE, float4 c : COLOR0) : COLOR0
{
    return float4(vpos * 0.01, f, 1) * c;
}`, ['ps_3_0']);

whole('unroll attribute, dynamic branch inside, known break', `
float4 W[8]; float Limit;
float4 main(float4 a : TEXCOORD0) : COLOR0
{
    float4 sum = 0;
    [unroll] for (int k = 0; k < 8; k++)
    {
        if (k >= 6) break;
        if (a.x * W[k].x > Limit) sum += W[k] * a.y; else sum -= W[k].wzyx;
    }
    return sum;
}`, ['ps_2_a', 'ps_3_0'], { ulp: 4 });

whole('comma, nested ternaries and increments', `
float4 main(float4 a : TEXCOORD0, float4 b : TEXCOORD1) : COLOR0
{
    float x = 1; float y = 2;
    float z = (x += 2, y *= 3, x + y);
    int n = 3; n++; ++n; n--;
    float4 r = a.x > 0 ? (a.y > 0 ? a : b) : (b.x > 0 ? b.wzyx : a.wzyx);
    return r * z + n;
}`, ['ps_2_0', 'ps_3_0']);

whole('two overloads and a helper that takes a structure', `
struct Surface { float3 n; float3 l; float4 color; };
float lambert(Surface s) { return saturate(dot(s.n, s.l)); }
float4 shade(Surface s) { return s.color * lambert(s); }
float4 shade(Surface s, float gain) { return shade(s) * gain; }
float4 main(float4 a : TEXCOORD0, float4 b : TEXCOORD1, float4 c : COLOR0) : COLOR0
{
    Surface s; s.n = normalize(a.xyz); s.l = normalize(b.xyz); s.color = c;
    return shade(s) + shade(s, 0.5);
}`, ['ps_2_0', 'ps_3_0'], { ulp: 6 });

whole('half precision types and rgba swizzles', `
half4 main(half4 a : TEXCOORD0, half4 b : TEXCOORD1) : COLOR0
{
    half3 t = a.rgb * b.abg; half k = dot(t, half3(0.3, 0.59, 0.11));
    return half4(t * k, a.a);
}`, ['ps_2_0', 'ps_3_0'], { ulp: 4 });

whole('a vertex shader with dynamic early returns', `
float4 Colors[3];
struct O { float4 pos : POSITION; float4 col : COLOR0; };
O main(float4 p : POSITION, float4 a : TEXCOORD0)
{
    O o; o.pos = p;
    if (a.x > 0.5) { o.col = Colors[0]; return o; }
    o.col = Colors[1];
    if (a.y > 0) { o.col += Colors[2]; return o; }
    o.col *= a.z;
    return o;
}`, ['vs_1_1', 'vs_2_0', 'vs_3_0']);

whole('boolean uniforms and conditional work', `
bool UseFog; bool UseTint; float4 Fog; float4 Tint;
float4 main(float4 c : COLOR0, float4 t : TEXCOORD0) : COLOR0
{
    float4 r = c;
    if (UseTint) r *= Tint;
    if (UseFog) r = lerp(r, Fog, saturate(t.x));
    return r;
}`, ['ps_2_0', 'ps_3_0']);

whole('saturated and unsaturated returns', `
float4 main(float4 a : TEXCOORD0) : COLOR0 { return saturate(a * 2 - 0.5); }`,
['ps_2_0', 'ps_3_0']);

whole('a transform used as a pixel shader input and passed on', `
float4x4 M;
void main(float4 p : POSITION, float4 uv : TEXCOORD0, out float4 pos : POSITION,
    out float4 o : TEXCOORD0)
{
    pos = mul(p, M);
    o = uv + pos.xxyy * 0.5;
}`, ['vs_1_1', 'vs_2_0', 'vs_3_0'], { ulp: 5 });
