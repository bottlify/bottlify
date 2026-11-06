/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Shader Model 4 compiler against the tree interpreter (`gate4.fixture.js`): random
 * programs made by a generator seeded with the test's number, so a failure names a program
 * that can be made again, and programs written for what random ones rarely reach - the
 * layout of constant buffers, relative indexing, the texture methods, the system values.
 *
 * One family uses only operations both paths compute identically and must agree bit for
 * bit; one is all integers - signed and unsigned arithmetic, division, the bitwise operators
 * and shifts, conversions both ways, loops whose count a constant buffer holds - and must
 * agree bit for bit too; one adds the operations a machine approximates and is compared with
 * a tolerance. `HLSL4_FUZZ=12` makes twelve times as many.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generator, runGate4 } from './gate4.fixture.js';

/**
 * @param {number} seed @param {'float' | 'int' | 'approx'} family @param {'ps' | 'vs'} kind
 */
function program(seed, family, kind){
    const next = generator(seed * 104729 + (family === 'int' ? 17 : family === 'approx' ? 29 : 7));
    /** @param {number} n */
    const pick = n=>Math.floor(next() * n);
    /** @template T @param {T[]} list @returns {T} */
    const choose = list=>list[pick(list.length)];
    const lanes = 'xyzw';
    const integer = family === 'int';
    /** @type {{ name: string, size: number, base: string }[]} */
    const scope = integer
        ? [{ name: 'a', size: 4, base: 'int' }, { name: 'b', size: 4, base: 'uint' },
            { name: 'u0', size: 4, base: 'int' }, { name: 'u1', size: 4, base: 'uint' },
            { name: 'k', size: 1, base: 'int' }, { name: 'f', size: 4, base: 'float' }]
        : [{ name: 'a', size: 4, base: 'float' }, { name: 'b', size: 4, base: 'float' },
            { name: 'c', size: 4, base: 'float' }, { name: 'u0', size: 4, base: 'float' },
            { name: 'u1', size: 4, base: 'float' }, { name: 'k', size: 1, base: 'float' }];
    /** @param {string} base @param {number} n */
    const typeName = (base, n)=>(n === 1 ? base : `${base}${n}`);
    /** @param {string} base @param {number} n */
    const literal = (base, n)=>{
        const one = ()=>(base === 'float' ? choose(['0.5', '2.0', '-1.5', '0.25', '3.0', '-0.75'])
            : base === 'uint' ? choose(['1u', '3u', '7u', '12u', '0xffu', '2u'])
                : choose(['1', '3', '-2', '5', '-7', '2']));
        return n === 1 ? one()
            : `${typeName(base, n)}(${Array.from({ length: n }, one).join(', ')})`;
    };
    /** @param {string} base @param {number} n */
    const leaf = (base, n)=>{
        if (next() < 0.15)
        {
            return literal(base, n);
        }
        const options = scope.filter(v=>v.size >= n && v.base === base);
        if (options.length === 0)
        {
            const other = choose(scope.filter(v=>v.size >= n));
            return `(${typeName(base, n)})(${other.name}${other.size === n ? ''
                : `.${lanes.slice(0, n)}`})`;
        }
        const v = choose(options);
        if (v.size === n)
        {
            return next() < 0.5 ? v.name : `${v.name}.${[...lanes.slice(0, n)]
                .sort(()=>next() - 0.5).join('')}`;
        }
        return `${v.name}.${Array.from({ length: n }, ()=>lanes[pick(v.size)]).join('')}`;
    };
    /** @param {string} base @param {number} n @param {number} depth @returns {string} */
    const expr = (base, n, depth)=>{
        if (depth <= 0)
        {
            return leaf(base, n);
        }
        const d = depth - 1;
        if (base !== 'float')
        {
            const kinds = ['arith', 'arith', 'bits', 'shift', 'divide', 'select', 'minmax',
                'convert', 'not'];
            switch (choose(kinds))
            {
                case 'arith': return `(${expr(base, n, d)} ${choose(['+', '-', '*'])} ${
                    expr(base, n, d)})`;
                case 'bits': return `(${expr(base, n, d)} ${choose(['&', '|', '^'])} ${
                    expr(base, n, d)})`;
                case 'shift': return `(${expr(base, n, d)} ${choose(['<<', '>>'])} (${
                    expr(base, n, d)} & ${base === 'uint' ? '15u' : '15'}))`;
                case 'divide': {
                    const one = base === 'uint' ? 'u' : '';
                    return `(${expr(base, n, d)} ${choose(['/', '%'])} ((${expr(base, n, d)} & 7${
                        one}) + 1${one}))`;
                }
                case 'select': return `(${expr(base, 1, d)} ${choose(['<', '>', '==', '!=', '>='])
                } ${expr(base, 1, d)} ? ${expr(base, n, d)} : ${expr(base, n, d)})`;
                case 'minmax': return `${choose(['min', 'max'])}(${expr(base, n, d)}, ${
                    expr(base, n, d)})`;
                case 'convert': return `(${typeName(base, n)})(${expr('float', n, d)} * 3.0)`;
                default: return `(~${expr(base, n, d)})`;
            }
        }
        const kinds = ['bin', 'bin', 'bin', 'unary', 'minmax', 'lerp', 'select', 'step', 'mad'];
        if (n === 1)
        {
            kinds.push('dot', 'cmp');
        }
        if (n > 1)
        {
            kinds.push('build');
        }
        if (integer)
        {
            kinds.push('fromint', 'fromint');
        }
        if (family === 'approx')
        {
            kinds.push('approx', 'approx', 'approx');
        }
        switch (choose(kinds))
        {
            case 'bin': {
                const scalar = n > 1 && next() < 0.3;
                return `(${expr(base, n, d)} ${choose(['+', '-', '*'])} ${
                    expr(base, scalar ? 1 : n, d)})`;
            }
            case 'unary': {
                const f = choose(['-', 'abs', 'saturate', 'frac', 'floor', 'trunc', 'ceil']);
                return f === '-' ? `(-(${expr(base, n, d)}))` : `${f}(${expr(base, n, d)})`;
            }
            case 'minmax': return `${choose(['min', 'max'])}(${expr(base, n, d)}, ${
                expr(base, n, d)})`;
            case 'lerp': return `lerp(${expr(base, n, d)}, ${expr(base, n, d)}, ${
                expr(base, next() < 0.5 ? 1 : n, d)})`;
            case 'select': return `(${expr(base, 1, d)} ${choose(['<', '>', '<=', '>=', '!='])} ${
                expr(base, 1, d)} ? ${expr(base, n, d)} : ${expr(base, n, d)})`;
            case 'step': return `step(${expr(base, n, d)}, ${expr(base, n, d)})`;
            case 'mad': return `(${expr(base, n, d)} * ${expr(base, n, d)} + ${expr(base, n, d)})`;
            case 'dot': {
                const k = 2 + pick(3);
                return `dot(${expr(base, k, d)}, ${expr(base, k, d)})`;
            }
            case 'cmp': return `((float)(${expr(base, 1, d)} ${choose(['<', '>', '==', '!='])} ${
                expr(base, 1, d)}) + (float)(${expr(base, 1, d)} >= ${expr(base, 1, d)}))`;
            case 'build': {
                const first = 1 + pick(n - 1);
                return `float${n}(${expr(base, first, d)}, ${expr(base, n - first, d)})`;
            }
            case 'fromint': return `(${typeName('float', n)})(${expr(choose(['int', 'uint']), n,
                d)})`;
            default: {
                const x = expr(base, n, d);
                switch (pick(6))
                {
                    case 0: return `(${x} / (abs(${expr(base, 1, d)}) + 0.5))`;
                    case 1: return `sqrt(abs(${x}) + 0.25)`;
                    case 2: return `rsqrt(abs(${x}) + 0.25)`;
                    case 3: return `pow(abs(${x}) + 0.25, 1.5)`;
                    case 4: return `sin(${x} * 0.5)`;
                    default: return `exp2(saturate(${x}) * 2)`;
                }
            }
        }
    };
    /** @type {string[]} */
    const lines = [];
    let count = 0;
    /** @param {number} indent @param {number} budget */
    const statements = (indent, budget)=>{
        const pad = ' '.repeat(indent);
        for (let i = 0; i < budget; i++)
        {
            const roll = next();
            const base = integer ? choose(['int', 'uint', 'float']) : 'float';
            if (roll < 0.15 && indent < 12)
            {
                lines.push(`${pad}if (${expr(base, 1, 1)} ${choose(['<', '>'])} ${
                    expr(base, 1, 1)})`);
                const mark = scope.length;
                lines.push(`${pad}{`);
                statements(indent + 4, 2);
                scope.length = mark;
                lines.push(`${pad}}`);
                lines.push(`${pad}else`);
                lines.push(`${pad}{`);
                statements(indent + 4, 1);
                scope.length = mark;
                lines.push(`${pad}}`);
            }
            else if (roll < 0.25 && indent < 8)
            {
                // A count the program knows, or one the constant buffer holds.
                const bound = integer && next() < 0.5 ? '(k & 3)' : `${2 + pick(3)}`;
                lines.push(`${pad}for (int j${count} = 0; j${count} < ${bound}; j${count}++)`);
                lines.push(`${pad}{`);
                const mark = scope.length;
                scope.push({ name: `j${count}`, size: 1, base: 'int' });
                count++;
                statements(indent + 4, 2);
                scope.length = mark;
                lines.push(`${pad}}`);
            }
            else
            {
                const existing = scope.filter(v=>/^v\d+$/.test(v.name));
                if (existing.length > 0 && next() < 0.4)
                {
                    const v = choose(existing);
                    const lane = v.size > 1 && next() < 0.4 ? `.${lanes[pick(v.size)]}` : '';
                    const ops = v.base === 'float' ? ['=', '+=', '-=', '*=']
                        : ['=', '+=', '-=', '*=', '&=', '|=', '^='];
                    lines.push(`${pad}${v.name}${lane} ${choose(ops)} ${
                        expr(v.base, lane ? 1 : v.size, 2)};`);
                }
                else
                {
                    const size = 1 + pick(4);
                    const name = `v${count++}`;
                    lines.push(`${pad}${typeName(base, size)} ${name} = ${expr(base, size, 3)};`);
                    scope.push({ name, size, base });
                }
            }
        }
    };
    statements(4, 6 + pick(5));
    const locals = scope.filter(v=>/^v\d+$/.test(v.name));
    /** @param {string} base */
    const combine = base=>{
        const parts = locals.filter(v=>v.base === base).slice(-4)
            .map(v=>(v.size === 1 ? v.name : `${v.name}.x`));
        while (parts.length < 4)
        {
            parts.push(base === 'uint' ? '0u' : '0');
        }
        return `${typeName(base, 4)}(${parts.join(', ')})`;
    };
    if (integer)
    {
        const head = 'int4 u0; uint4 u1; int k;';
        if (kind === 'ps')
        {
            return `${head}
struct O { float4 f : SV_Target0; int4 i : SV_Target1; uint4 u : SV_Target2; };
O main(int4 a : TEXCOORD0, uint4 b : TEXCOORD1, float4 f : TEXCOORD2)
{
${lines.join('\n')}
    O o;
    o.f = ${combine('float')}; o.i = ${combine('int')}; o.u = ${combine('uint')};
    return o;
}`;
        }
        return `${head}
struct O { float4 pos : SV_Position; int4 i : TEXCOORD0; uint4 u : TEXCOORD1;
    float4 f : TEXCOORD2; };
O main(int4 a : TEXCOORD0, uint4 b : TEXCOORD1, float4 f : TEXCOORD2)
{
${lines.join('\n')}
    O o;
    o.pos = ${combine('float')}; o.i = ${combine('int')}; o.u = ${combine('uint')};
    o.f = ${combine('float')}.wzyx;
    return o;
}`;
    }
    const head = 'float4 u0; float4 u1; float k;';
    if (kind === 'ps')
    {
        return `${head}
float4 main(float4 a : TEXCOORD0, float4 b : TEXCOORD1, float4 c : COLOR0) : SV_Target
{
${lines.join('\n')}
    return ${combine('float')};
}`;
    }
    return `${head}
struct O { float4 pos : SV_Position; float4 o0 : TEXCOORD0; float4 col : COLOR0; };
O main(float4 p : POSITION, float4 a : TEXCOORD0, float4 b : TEXCOORD1, float4 c : COLOR0)
{
${lines.join('\n')}
    O o;
    o.pos = p; o.o0 = ${combine('float')}; o.col = ${combine('float')}.wzyx;
    return o;
}`;
}

/**
 * @param {number} count @param {'float' | 'int' | 'approx'} family @param {'ps' | 'vs'} kind
 * @param {string[]} profiles
 */
function familyOf(count, family, kind, profiles){
    for (let seed = 1; seed <= count; seed++)
    {
        for (const profile of profiles)
        {
            const source = program(seed + (kind === 'vs' ? 500 : 0), family, kind);
            test(`random ${family} ${kind} #${seed} (${profile})`, async()=>{
                try
                {
                    await runGate4(source, profile, { trials: 5, seed,
                        ...(family === 'approx' ? { absolute: 2e-3, relative: 2e-5 } : {}) });
                }
                catch (e){
                    throw new Error(`${/** @type {Error} */ (e).message}\n--- source:\n${source}`,
                        { cause: e });
                }
            });
        }
    }
}

const MORE = Number(process.env.HLSL4_FUZZ ?? 1);
familyOf(30 * MORE, 'float', 'ps', ['ps_4_0']);
familyOf(30 * MORE, 'float', 'vs', ['vs_4_0']);
familyOf(30 * MORE, 'int', 'ps', ['ps_4_0']);
familyOf(30 * MORE, 'int', 'vs', ['vs_4_1']);
familyOf(15 * MORE, 'approx', 'ps', ['ps_4_0', 'ps_5_0']);

/** Written programs, each through the gate. */
const WRITTEN = /** @type {[string, string, string][]} */ ([
    ['constant buffers packed by the rules', 'ps_4_0', `
cbuffer A : register(b1) { float x; float2 y; float z; float3 w; float4x3 m; float q; }
cbuffer B { row_major float3x2 r; int2 i; bool t; float arr[3]; float2 tail; }
float4 g; float h;
float4 main(float4 p : TEXCOORD0) : SV_Target
{
    float3 v = mul(p, m);
    float2 rv = mul(p.xyz, r);
    return float4(x + y.y * z, w.z + v.x + v.z, rv.x + rv.y * i.y + q, (t ? 1 : 2) + arr[1]
        + tail.y + g.w * h);
}`],
    ['an array of a constant buffer indexed by an input', 'vs_4_0', `
struct L { float4 colour; float3 dir; float power; };
cbuffer Lights { L lights[4]; float4x4 bones[3]; int count; }
struct O { float4 pos : SV_Position; float4 c : COLOR0; };
O main(float4 p : POSITION, int4 which : BLENDINDICES)
{
    O o;
    int n = which.x & 3;
    o.pos = mul(p, bones[which.y & 1]);
    o.c = lights[n].colour * lights[n].power + float4(lights[(n + 1) & 3].dir, 0);
    float4 sum = 0;
    for (int i = 0; i < count; i++)
        sum += lights[i & 3].colour;
    o.c += sum;
    return o;
}`],
    ['texture methods', 'ps_4_1', `
Texture2D t0; Texture2DArray t1 : register(t3); Texture3D t2; TextureCube t3;
Texture2D<float> depth; Buffer<float4> buf;
SamplerState s; SamplerComparisonState c;
float4 main(float4 uv : TEXCOORD0) : SV_Target
{
    float4 r = t0.Sample(s, uv.xy) + t0.Sample(s, uv.xy, int2(1, -2));
    r += t1.SampleLevel(s, uv.xyz, uv.w) + t2.SampleBias(s, uv.xyz, 0.5);
    r += t3.SampleGrad(s, uv.xyz, uv.xyz * 0.5, uv.zyx);
    r += depth.SampleCmp(c, uv.xy, uv.z) + depth.SampleCmpLevelZero(c, uv.yx, 0.25);
    r += t0.Load(int3(uv.xy * 4, 0)) + t0[uint2(2, 3)] + buf.Load((int)uv.x) + buf[3];
    r += t0.Gather(s, uv.xy);
    uint w, h, levels;
    t0.GetDimensions(1, w, h, levels);
    float fw, fh, fd;
    t2.GetDimensions(fw, fh, fd);
    return r + float4(w, h, levels, fw + fh * fd);
}`],
    ['system values and discard', 'ps_4_0', `
float4 main(float4 pos : SV_Position, bool front : SV_IsFrontFace, uint prim : SV_PrimitiveID,
    float4 c : COLOR0, out float d : SV_Depth) : SV_Target
{
    if (c.x < 0) discard;
    clip(c.y + 1);
    d = saturate(pos.z * 0.5);
    return front ? c + prim : -c;
}`],
    ['vertex and instance ids', 'vs_4_0', `
float4 main(uint v : SV_VertexID, uint i : SV_InstanceID, float4 p : POSITION) : SV_Position
{
    return p + float4(v & 7, i >> 1, (float)(v % 3), asfloat(asuint(p.w) ^ 0x80000000u));
}`],
    ['integer division by signs, and conversions at the ends', 'vs_4_0', `
int4 a; uint4 b;
struct O { float4 pos : SV_Position; int4 q : TEXCOORD0; uint4 r : TEXCOORD1;
    float4 f : TEXCOORD2; };
O main(float4 p : POSITION)
{
    O o;
    o.pos = p;
    o.q = int4(a.x / 3, a.y % -5, -a.z / 7, (a.w * -13) % 4);
    o.r = uint4(b.x / 3u, b.y % 5u, (b.z << 30) >> 29, ~b.w);
    o.f = float4((float)(uint)-1, (float)(int)(p.x * 1000), asfloat(0x3f800000), (uint)(-p.y));
    return o;
}`],
    ['matrices, packed by the flag and by modifiers', 'vs_4_0', `
float4x4 m; row_major float4x4 n; float3x4 k; column_major float2x3 q;
float4 main(float4 p : POSITION) : SV_Position
{
    float4 r = mul(p, m) + mul(n, p);
    float3 s = mul(k, p);
    float3 t = mul(p.xy, q);
    return r + float4(s + t, determinant(m)) + m[2] + n[1].wzyx + k._m21;
}`],
    ['a loop with a break and a counter not known', 'ps_4_0', `
int n; float4 step4;
float4 main(float4 p : TEXCOORD0) : SV_Target
{
    float4 acc = 0;
    for (int i = 0; i < n; i++)
    {
        acc += step4 * i;
        if (acc.x > p.x * 40) break;
    }
    int j = 0;
    while (j < n * 2) { acc.y += 0.5; j += 3; }
    return acc;
}`],
]);

for (const [name, profile, source] of WRITTEN)
{
    test(`written: ${name} (${profile})`, async()=>{
        await runGate4(source, profile, { trials: 6, seed: name.length });
    });
}

test('a model 5 profile writes SHEX and the model 5 functions of bits', async()=>{
    const { bytes } = await runGate4(`
uint4 u; int4 i;
struct O { uint4 a : SV_Target0; int4 b : SV_Target1; };
O main(float4 p : TEXCOORD0)
{
    O o;
    o.a = uint4(countbits(u.x), reversebits(u.y), firstbithigh(u.z), firstbitlow(u.w));
    o.b = int4(firstbithigh(i.x), firstbithigh(-i.y - 1), firstbitlow(i.z), firstbithigh(0));
    return o;
}`, 'ps_5_0', { trials: 6 });
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'DXBC');
    const text = String.fromCharCode(...bytes);
    assert.ok(text.includes('SHEX') && !text.includes('SHDR'));
});
