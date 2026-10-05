/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileShader } from './hlsl-compile.js';
import { parseConstantTable } from './constants.js';
import { disassemble } from './d3d9-machine.fixture.js';

/** @param {string} source @param {string} profile @param {import('./hlsl-compile.js').CompileOptions} [more] */
const compile = (source, profile, more = { profile })=>compileShader(source,
    { ...more, profile });

/** @param {import('./hlsl-compile.js').CompileResult} result */
function constants(result){
    const block = /** @type {Uint8Array} */ (result.constantTable);
    return parseConstantTable(new DataView(block.buffer, block.byteOffset, block.byteLength), 0)
        .constants;
}

test('a file of an effect compiles one of its entry points and reads past the rest', async()=>{
    const source = `
float4x4 g_WorldViewProj : WORLDVIEWPROJECTION;
texture g_Diffuse < string name = "diffuse.tga"; >;
sampler DiffuseSampler = sampler_state { Texture = <g_Diffuse>; MinFilter = LINEAR; };
struct VS_OUTPUT { float4 Pos : POSITION; float2 Tex : TEXCOORD0; float4 Color : COLOR0; };
VS_OUTPUT VS(float4 Pos : POSITION, float2 Tex : TEXCOORD0, float4 Color : COLOR0)
{
    VS_OUTPUT Out = (VS_OUTPUT)0;
    Out.Pos = mul(Pos, g_WorldViewProj);
    Out.Tex = Tex; Out.Color = Color;
    return Out;
}
float4 PS(VS_OUTPUT In) : COLOR0 { return tex2D(DiffuseSampler, In.Tex) * In.Color; }
technique Main
{
    pass P0
    {
        VertexShader = compile vs_2_0 VS();
        PixelShader = compile ps_2_0 PS();
        AlphaBlendEnable = true;
    }
}`;
    const vs = await compile(source, 'vs_2_0', { profile: 'vs_2_0', entry: 'VS' });
    const ps = await compile(source, 'ps_2_0', { profile: 'ps_2_0', entry: 'PS' });
    assert.equal(vs.ok, true, vs.messages);
    assert.equal(ps.ok, true, ps.messages);
    assert.deepEqual(constants(vs).map(c=>c.name), ['g_WorldViewProj']);
    assert.deepEqual(constants(ps).map(c=>[c.name, c.set, c.index]), [['DiffuseSampler', 3, 0]]);
});

test('constants take registers in declaration order, a named register is kept', async()=>{
    const result = await compile(`
float4 A; float4x4 B : register(c10); float C[3]; float4 D;
float4 main(float4 p : POSITION) : POSITION { return p * A + mul(p, B) + C[1] + D; }`, 'vs_2_0');
    assert.equal(result.ok, true, result.messages);
    assert.deepEqual(constants(result).map(c=>[c.name, c.index, c.count]),
        [['A', 0, 1], ['B', 10, 4], ['C', 1, 3], ['D', 4, 1]]);
});

test('a constant that is never read is left out of the table', async()=>{
    const result = await compile('float4 Used; float4 Unused;\nfloat4 main() : COLOR0'
        + '{ return Used; }', 'ps_2_0');
    assert.deepEqual(constants(result).map(c=>c.name), ['Used']);
});

test('defaults are kept, and a structure lists its members', async()=>{
    const result = await compile(`
struct Light { float4 color; float power; };
Light L; float4 Tint = float4(0.25, 0.5, 0.75, 1);
float4 main() : COLOR0 { return L.color * L.power + Tint; }`, 'ps_2_0');
    assert.equal(result.ok, true, result.messages);
    const table = constants(result);
    const tint = /** @type {any} */ (table.find(c=>c.name === 'Tint'));
    const block = /** @type {Uint8Array} */ (result.constantTable);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    assert.deepEqual([0, 1, 2, 3].map(i=>view.getFloat32(tint.defaultAt + i * 4, true)),
        [0.25, 0.5, 0.75, 1]);
    const light = /** @type {any} */ (table.find(c=>c.name === 'L'));
    assert.deepEqual(light.members.map((/** @type {any} */ m)=>[m.name, m.index]),
        [['color', 0], ['power', 1]]);
});

test('matrices are packed by column unless the row-major flag, modifier or pragma says so',
    async()=>{
        const source = 'float3x4 M;\nfloat4 main(float3 v : TEXCOORD0) : COLOR0'
            + '{ return mul(v, M); }';
        const column = constants(await compile(source, 'ps_2_0'))[0];
        assert.deepEqual([column.cls, column.count, column.rows, column.columns], [3, 4, 3, 4]);
        const flagged = constants(await compile(source, 'ps_2_0',
            { profile: 'ps_2_0', flags: 1 << 3 }))[0];
        assert.deepEqual([flagged.cls, flagged.count], [2, 3]);
        const pragma = constants(await compile(`#pragma pack_matrix(row_major)\n${source}`,
            'ps_2_0'))[0];
        assert.deepEqual([pragma.cls, pragma.count], [2, 3]);
        const modifier = constants(await compile(`row_major ${source}`, 'ps_2_0'))[0];
        assert.deepEqual([modifier.cls, modifier.count], [2, 3]);
    });

test('a sampler takes the register it is given, or the next one free', async()=>{
    const result = await compile(`
sampler2D A; sampler2D B : register(s3); sampler2D C;
float4 main(float2 t : TEXCOORD0) : COLOR0 { return tex2D(A, t) + tex2D(B, t) + tex2D(C, t); }`,
    'ps_2_0');
    assert.deepEqual(constants(result).map(c=>[c.name, c.index]), [['A', 0], ['B', 3], ['C', 1]]);
});

test('boolean and integer uniforms live in float registers', async()=>{
    const result = await compile('bool On; int Count;\nfloat4 main(float4 c : COLOR0) : COLOR0 '
        + '{ return On ? c * Count : c; }', 'ps_2_0');
    assert.equal(result.ok, true, result.messages);
    assert.deepEqual(constants(result).map(c=>[c.name, c.set, c.type]), [['On', 2, 1],
        ['Count', 2, 2]]);
});

test('errors read as fxc prints them, with the position of the offending token', async()=>{
    /** @type {[string, RegExp][]} */
    const cases = [
        ['float4 main() : COLOR0 { return float4(1, 2, 3); }', /^memory\(1,\d+\): error X3014:/],
        ['float4 main() : COLOR0 { float x = y; return 0; }',
            /^memory\(1,\d+\): error X3004: undeclared identifier 'y'/],
        ['float4 main(float3 v : TEXCOORD0) : COLOR0 { return mul(v, v, v); }',
            /error X3013: 'mul': no matching 3 parameter intrinsic function/],
        ['struct S { float a; };\nfloat4 main() : COLOR0 {\n  S s;\n  float3 v = s;\n  return 0; }',
            /^memory\(4,\d+\): error X3017: cannot convert from 'S' to 'float3'/],
        ['float4 main() { return 0; }', /error X3502|missing a semantic/],
    ];
    for (const [source, pattern] of cases)
    {
        const result = await compile(source, 'ps_2_0');
        assert.equal(result.ok, false, source);
        assert.match(result.messages, pattern, source);
    }
});

test('a shader the target cannot hold is refused with the numbers', async()=>{
    const body = Array.from({ length: 70 }, (_, i)=>`r = r * c + ${i}.5;`).join(' ');
    const source = `float4 main(float4 c : COLOR0, float4 d : TEXCOORD0) : COLOR0
{ float4 r = d; ${body} return r; }`;
    const small = await compile(source, 'ps_2_0');
    assert.equal(small.ok, false);
    assert.match(small.messages, /error X5608: Compiled shader code uses too many arithmetic/);
    assert.equal((await compile(source, 'ps_2_b')).ok, true);
});

test('a loop that cannot be unrolled is reported', async()=>{
    const result = await compile('int n;\nfloat4 main(float4 c : COLOR0) : COLOR0 '
        + '{ float4 r = 0; for (int i = 0; i < n; i++) r += c; return r; }', 'ps_3_0');
    assert.equal(result.ok, false);
    assert.match(result.messages, /error X3511: unable to unroll loop/);
});

test('a profile the compiler does not target is refused', async()=>{
    for (const profile of ['ps_1_0', 'vs_4_0', 'xx_2_0'])
    {
        const result = await compile('float4 main() : COLOR0 { return 0; }', profile);
        assert.equal(result.ok, false, profile);
        assert.match(result.messages, new RegExp(`X3506: '${profile}': invalid compiler target`),
            profile);
    }
});

test('a fault inside the compiler is a failed compile with its cause named', async()=>{
    const result = await compileShader('float4 main() : COLOR0 { return 0; }',
        /** @type {any} */ ({ profile: 'ps_2_0', defines: 5 }));
    assert.equal(result.ok, false);
    assert.match(result.messages, /error X0000: internal compiler error/);
});

test('the output reads: the program disassembles to what the source says', async()=>{
    const result = await compile('float4 main(float4 a : TEXCOORD0, float4 b : COLOR0) : COLOR0'
        + '{ return a * b + 1; }', 'ps_2_0');
    const lines = disassemble(/** @type {Uint32Array} */ (result.tokens)).trim().split('\n');
    assert.deepEqual(lines, ['ps_2_0', 'def c0, 1, 0, 0, 0', 'dcl t0', 'dcl v0',
        'mad oC0, t0, v0, c0.x']);
});

test('pixel shader model 1 compiles what it can hold and reports the rest', async()=>{
    const simple = 'sampler2D S;\nfloat4 main(float2 uv : TEXCOORD0, float4 c : COLOR0) : COLOR0'
        + '{ return tex2D(S, uv) * c; }';
    for (const profile of ['ps_1_1', 'ps_1_2', 'ps_1_3', 'ps_1_4'])
    {
        const result = await compile(simple, profile);
        assert.equal(result.ok, true, `${profile}: ${result.messages}`);
        assert.deepEqual(constants(result).map(c=>[c.name, c.set, c.index]), [['S', 3, 0]]);
    }
    /** @type {[string, RegExp][]} */
    const refused = [
        ['sampler2D S;\nfloat4 main(float2 uv : TEXCOORD0) : COLOR0 { return tex2D(S, uv * 2); }',
            /X4523.*own stage/],
        ['float4 main(float4 c : COLOR0) : COLOR0 { return c * 3; }',
            /X4532: the constant 3 is outside the range -1 to 1/],
        ['float4 main(float4 c : COLOR0) : COLOR0 { return c.yzwx; }', /X4533.*read as/],
        ['float4 main(float4 c : COLOR0) : COLOR0 { return sqrt(c); }', /X4532/],
        ['float4 main(float4 c : COLOR0) : COLOR0 { clip(c.x - 0.5); return c; }',
            /X4532: discard and clip are not available in ps_1_1/],
        ['sampler2D A; sampler2D B;\nfloat4 main(float2 t : TEXCOORD0) : COLOR0'
            + '{ return tex2D(B, tex2D(A, t).xy); }', /X4523/],
    ];
    for (const [source, pattern] of refused)
    {
        const result = await compile(source, 'ps_1_1');
        assert.equal(result.ok, false, source);
        assert.match(result.messages, pattern, source);
    }
});
