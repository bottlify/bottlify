/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The containers the compiler writes, read back by the readers the device and the reflection
 * use (`d3d10/dxbc.js`, `d3d10/sm4.js`, `d3d10/reflection.js`), and held to what fxc wrote for
 * the same source where Wine's tests carry fxc's blob beside it: the program's tokens, the
 * checksum, the layout of constant buffers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileShader4 } from './compile.js';
import { dxbcChecksum } from './dxbc-write.js';
import { parseDxbc } from '../d3d10/dxbc.js';
import { OPCODE, decodeSm4 } from '../d3d10/sm4.js';
import { reflectShader } from '../d3d10/reflection.js';

/** @param {number[]} words */
const bytesOf = words=>{
    const bytes = new Uint8Array(words.length * 4);
    const view = new DataView(bytes.buffer);
    words.forEach((word, i)=>view.setUint32(i * 4, word >>> 0, true));
    return bytes;
};

/** @param {string} source @param {string} profile @param {object} [more] */
async function compiled(source, profile, more = {}){
    const result = await compileShader4(source, { profile, ...more });
    assert.ok(result.ok, result.messages);
    return /** @type {Uint8Array} */ (result.bytes);
}

/**
 * fxc's pixel shader for `float4 color; float4 main() : SV_TARGET { return color; }`, from
 * Wine's d3d10core tests.
 */
const FXC_COLOR = [0x43425844, 0x80f1c810, 0xdacbbc8b, 0xe07b133e, 0x3059cbfa, 0x00000001,
    0x000000b8, 0x00000003, 0x0000002c, 0x0000003c, 0x00000070, 0x4e475349, 0x00000008,
    0x00000000, 0x00000008, 0x4e47534f, 0x0000002c, 0x00000001, 0x00000008, 0x00000020,
    0x00000000, 0x00000000, 0x00000003, 0x00000000, 0x0000000f, 0x545f5653, 0x45475241,
    0xabab0054, 0x52444853, 0x00000040, 0x00000040, 0x00000010, 0x04000059, 0x00208e46,
    0x00000000, 0x00000001, 0x03000065, 0x001020f2, 0x00000000, 0x06000036, 0x001020f2,
    0x00000000, 0x00208e46, 0x00000000, 0x00000000, 0x0100003e];

test('the checksum is the one fxc wrote', ()=>{
    const bytes = bytesOf(FXC_COLOR);
    assert.deepEqual([...dxbcChecksum(bytes)], FXC_COLOR.slice(1, 5));
});

test('a container this compiler writes carries its own checksum', async()=>{
    const bytes = await compiled('float4 c; float4 main() : SV_Target { return c * 2; }', 'ps_4_0');
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    assert.deepEqual([...dxbcChecksum(bytes)], [1, 2, 3, 4].map(i=>view.getUint32(i * 4, true)));
});

test('the program fxc wrote for the same source, token for token', async()=>{
    const ours = /** @type {any} */ (parseDxbc(await compiled(
        'float4 color;\nfloat4 main() : SV_TARGET\n{\n    return color;\n}', 'ps_4_0')));
    const theirs = /** @type {any} */ (parseDxbc(bytesOf(FXC_COLOR)));
    assert.deepEqual([...ours.shader.tokens], [...theirs.shader.tokens]);
    assert.deepEqual(ours.outputs, theirs.outputs);
    assert.deepEqual(ours.inputs, theirs.inputs);
});

test('constant buffers are laid out as fxc lays them out', async()=>{
    // Wine's reflection test: c1's variables at 0, 16, 36 and 48, 64 bytes in all.
    const bytes = await compiled(`cbuffer c1
{
    float a;
    float b[2];
    int i;
    struct s {
        float a;
        float b;
    } t;
};
float4 PS(float2 uv : TEXCOORD0) : sv_target
{
    float4 q = float4(uv, uv.x + uv.y, 0);
    q.x = q.x + t.a;
    return q;
}`, 'ps_4_0', { entry: 'PS' });
    const reflection = /** @type {any} */ (reflectShader(bytes));
    const [c1] = reflection.constantBuffers;
    assert.equal(c1.name, 'c1');
    assert.equal(c1.size, 64);
    assert.deepEqual(c1.variableList.map((/** @type {any} */ v)=>[v.name, v.startOffset, v.size,
        v.flags]), [['a', 0, 4, 0], ['b', 16, 20, 0], ['i', 36, 4, 0], ['t', 48, 8, 2]]);
    const t = c1.variableList[3].type;
    assert.deepEqual([t.class, t.type, t.rows, t.columns, t.elements], [5, 0, 1, 2, 0]);
    assert.deepEqual(t.members.map((/** @type {any} */ m)=>[m.name, m.offset, m.type.class,
        m.type.type]), [['a', 0, 0, 3], ['b', 4, 0, 3]]);
    const b = c1.variableList[1].type;
    assert.deepEqual([b.class, b.type, b.rows, b.columns, b.elements], [0, 3, 1, 1, 2]);
    assert.deepEqual(reflection.bindings.map((/** @type {any} */ x)=>[x.name, x.type, x.bindPoint,
        x.bindCount]), [['c1', 0, 0, 1]]);
    assert.equal(reflection.desc.Flags & 0x100, 0x100, 'no preshader, as fxc says for model 4');
});

test('packoffset places a variable, and a buffer is a whole number of registers', async()=>{
    // Wine's effect test: cb is 16 bytes, cb2 (f3 at c2) 48.
    const bytes = await compiled(`cbuffer cb : register(b1) { float f1; float f2; };
cbuffer cb2 : register(b0) { float f3 : packoffset(c2); float4 g : packoffset(c0); };
float4 main() : SV_Target { return float4(f1, f2, f3, g.y); }`, 'ps_4_0');
    const reflection = /** @type {any} */ (reflectShader(bytes));
    assert.deepEqual(reflection.constantBuffers.map((/** @type {any} */ b)=>[b.name, b.size]),
        [['cb', 16], ['cb2', 48]]);
    assert.deepEqual(reflection.constantBuffers[1].variableList.map((/** @type {any} */ v)=>
        [v.name, v.startOffset]), [['f3', 32], ['g', 0]]);
    assert.deepEqual(reflection.bindings.map((/** @type {any} */ x)=>[x.name, x.bindPoint,
        x.flags]).sort(), [['cb', 1, 1], ['cb2', 0, 1]]);
});

test('signatures, declarations and reflection of a vertex and a pixel shader', async()=>{
    const vs = /** @type {any} */ (parseDxbc(await compiled(`
float4x4 wvp;
struct V { float4 pos : SV_Position; float2 uv : TEXCOORD0;
    nointerpolation int id : BLENDINDICES; };
V main(float3 p : POSITION, float2 uv : TEXCOORD0, uint vid : SV_VertexID)
{ V o; o.pos = mul(float4(p, 1), wvp); o.uv = uv; o.id = vid; return o; }`, 'vs_4_0')));
    assert.deepEqual(vs.inputs.map((/** @type {any} */ e)=>[e.name, e.index, e.systemValue,
        e.componentType, e.register, e.mask]),
    [['POSITION', 0, 0, 3, 0, 7], ['TEXCOORD', 0, 0, 3, 1, 3], ['SV_VertexID', 0, 6, 1, 2, 1]]);
    assert.deepEqual(vs.outputs.map((/** @type {any} */ e)=>[e.name, e.systemValue,
        e.componentType, e.register, e.mask, e.readWriteMask]),
    [['SV_Position', 1, 3, 0, 15, 0], ['TEXCOORD', 0, 3, 1, 3, 0],
        ['BLENDINDICES', 0, 2, 2, 1, 0]]);
    const program = decodeSm4(vs.shader.tokens);
    assert.equal(program.reduce((n, i)=>n + i.length, 0), vs.shader.tokens.length);
    assert.deepEqual(program.filter(i=>i.opcode >= OPCODE.DCL_RESOURCE).map(i=>i.name),
        ['dcl_constant_buffer', 'dcl_input', 'dcl_input', 'dcl_input_sgv', 'dcl_output_siv',
            'dcl_output', 'dcl_output', 'dcl_temps']);
    assert.equal(program.at(-1)?.opcode, OPCODE.RET);

    const ps = /** @type {any} */ (parseDxbc(await compiled(`
Texture2D diffuse : register(t2); SamplerState linear : register(s1);
float4 main(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target
{ return diffuse.Sample(linear, uv) * pos.z; }`, 'ps_4_0')));
    assert.deepEqual(ps.inputs.map((/** @type {any} */ e)=>[e.name, e.systemValue, e.register,
        e.readWriteMask]), [['SV_Position', 1, 0, 4], ['TEXCOORD', 0, 1, 3]]);
    const reflected = /** @type {any} */ (reflectShader(new Uint8Array([])) ?? null);
    assert.equal(reflected, null);
});

test('the bindings of textures and samplers, as reflection reads them', async()=>{
    const reflection = /** @type {any} */ (reflectShader(await compiled(`
Texture2D diffuse : register(t2); Texture2DArray<uint2> layers; SamplerState linear : register(s1);
SamplerComparisonState shadow;
float4 main(float3 uv : TEXCOORD0) : SV_Target
{ return diffuse.Sample(linear, uv.xy) + layers.Load(int4(uv, 0)).x
    + diffuse.SampleCmp(shadow, uv.xy, uv.z); }`, 'ps_4_0')));
    assert.deepEqual(reflection.bindings.map((/** @type {any} */ b)=>[b.name, b.type, b.returnType,
        b.dimension, b.bindPoint, b.bindCount, b.flags, b.sampleCount]), [
        ['linear', 3, 0, 0, 1, 1, 1, 0],
        ['shadow', 3, 0, 0, 0, 1, 2, 0],
        ['diffuse', 2, 5, 4, 2, 1, 1 | 12, 0xffffffff],
        ['layers', 2, 4, 5, 0, 1, 4, 0xffffffff],
    ]);
    assert.equal(reflection.desc.TextureNormalInstructions, 1);
    assert.equal(reflection.desc.TextureLoadInstructions, 1);
    assert.equal(reflection.desc.TextureCompInstructions, 1);
});

test('what the compiler refuses, it says in fxc\'s words', async()=>{
    const profile = await compileShader4('float4 main() : SV_Target { return 0; }',
        { profile: 'ps_9_9' });
    assert.equal(profile.ok, false);
    assert.match(profile.messages, /error X3506: 'ps_9_9': invalid compiler target/);
    const entry = await compileShader4('float4 f() : SV_Target { return 0; }',
        { profile: 'ps_4_0' });
    assert.match(entry.messages, /error X3501: 'main': entrypoint not found/);
    const syntax = await compileShader4('float4 main() : SV_Target {\n return 0 }',
        { profile: 'ps_4_0' });
    assert.match(syntax.messages, /^memory\(2,\d+\): error X3000/);
    const legacy = await compileShader4(
        'sampler2D s; float4 main(float2 uv : TEXCOORD0) : SV_Target { return tex2D(s, uv); }',
        { profile: 'ps_4_0' });
    assert.equal(legacy.ok, false);
    assert.match(legacy.messages, /tex2D/);
    const semantic = await compileShader4('float4 main() : COLOR { return 0; }',
        { profile: 'ps_4_0' });
    assert.match(semantic.messages, /error X4503: invalid ps_4_0 output semantic 'COLOR'/);
    const geometry = await compileShader4('void main() {}', { profile: 'gs_4_0' });
    assert.match(geometry.messages, /error X3506: 'gs_4_0': geometry and compute shaders/);
    const model5 = await compileShader4(
        'uint u; uint4 main() : SV_Target { return countbits(u); }', { profile: 'ps_4_0' });
    assert.match(model5.messages, /'countbits' is not available in ps_4_0/);
});

test('a matrix packs by column unless the flag or the modifier says rows', async()=>{
    const source = 'float4x4 m; row_major float2x3 r; float4 main(float4 p : POSITION) : '
        + 'SV_Position { return mul(p, m) + float4(mul(p.xy, r), 0); }';
    const columns = /** @type {any} */ (reflectShader(await compiled(source, 'vs_4_0')));
    const rows = /** @type {any} */ (reflectShader(await compiled(source, 'vs_4_0',
        { flags: 1 << 3 })));
    /** @param {any} r */
    const shape = r=>r.constantBuffers[0].variableList.map((/** @type {any} */ v)=>[v.name,
        v.startOffset, v.size, v.type.class]);
    assert.deepEqual(shape(columns), [['m', 0, 64, 3], ['r', 64, 28, 2]]);
    assert.deepEqual(shape(rows), [['m', 0, 64, 2], ['r', 64, 28, 2]]);
});
