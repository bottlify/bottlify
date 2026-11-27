/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Effects the compiler writes, read back by the reader the effect runtime uses
 * (`d3d10/effect.js`), and held to what fxc wrote where Wine's d3d10 tests carry fxc's blob
 * for the same declarations: the constant buffers and their layout, the state blocks field by
 * field with the type each constant is stored as, the order a pass's calls come out in, the
 * per-target blend of fx_4_1, an element of a numeric array counted in dwords. The expected
 * assignments are written `state[index]=type:bits`, `=variable`, `=variable[element]`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileEffect, isEffectProfile } from './fx-compile.js';
import { ASSIGNMENT, FX_VERSION, parseEffect } from '../d3d10/effect.js';
import { parseDxbc } from '../d3d10/dxbc.js';

/**
 * @param {string} source @param {string} [profile]
 * @returns {Promise<import('../d3d10/effect.js').EffectData>}
 */
async function effectOf(source, profile = 'fx_4_0'){
    const result = await compileEffect(source, { profile });
    assert.ok(result.ok, result.messages);
    const read = parseEffect(/** @type {Uint8Array} */ (result.bytes));
    if ('error' in read)
    {
        assert.fail(read.error);
    }
    return read.effect;
}

/** @param {string} source @param {string} [profile] */
async function refusal(source, profile = 'fx_4_0'){
    const result = await compileEffect(source, { profile });
    assert.equal(result.ok, false, `compiled: ${source}`);
    assert.equal(result.bytes, null);
    return result.messages;
}

/** @param {import('../d3d10/effect.js').FxAssignment} a */
function written(a){
    const head = `${a.state}[${a.index}]`;
    switch (a.kind)
    {
        case ASSIGNMENT.CONSTANT:
            return `${head}=${(a.constants ?? []).map(c=>`${c.type}:${c.bits >>> 0}`).join(',')}`;
        case ASSIGNMENT.VARIABLE: return `${head}=${a.variable}`;
        case ASSIGNMENT.CONSTANT_INDEX: return `${head}=${a.variable}[${a.element}]`;
        case ASSIGNMENT.ANONYMOUS_SHADER: return `${head}=shader`;
        default: return `${head}=kind ${a.kind}`;
    }
}

/** @param {import('../d3d10/effect.js').EffectData} effect */
function statesOf(effect){
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const object of effect.objects)
    {
        if (object.elements.some(e=>e.assignments))
        {
            out[object.name] = object.elements.map(e=>(e.assignments ?? []).map(written)
                .join(' '));
        }
    }
    for (const technique of effect.techniques)
    {
        for (const pass of technique.passes)
        {
            out[`${technique.name}.${pass.name}`] = [pass.assignments.map(written).join(' ')];
        }
    }
    return out;
}

test('the effect profiles are fx_4_0 and fx_4_1, and the version each writes', async()=>{
    assert.ok(isEffectProfile('fx_4_0'));
    assert.ok(isEffectProfile('fx_4_1'));
    assert.ok(!isEffectProfile('fx_5_0'));
    assert.ok(!isEffectProfile('ps_4_0'));
    assert.equal((await effectOf('technique10 {};')).counts.version, FX_VERSION.FX_4_0);
    assert.equal((await effectOf('technique10 {};', 'fx_4_1')).counts.version,
        FX_VERSION.FX_4_1);
    assert.match(await refusal('technique10 {};', 'fx_5_0'),
        /error X3506: 'fx_5_0': invalid compiler target/);
});

test('$Globals comes first, empty or not, then the buffers as declared', async()=>{
    // D3D10CompileEffectFromMemory's effects count it always (Wine: 3 buffers for 2 declared).
    const effect = await effectOf([
        'cbuffer first : register(b1) { float a : SV_POSITION; float b : COLOR0; };',
        'cbuffer second : register(b0) { float c : packoffset(c2); };',
    ].join('\n'));
    assert.deepEqual(effect.buffers.map(b=>[b.name, b.size, b.bindPoint, b.variables.length]),
        [['$Globals', 0, -1, 0], ['first', 16, 1, 2], ['second', 48, 0, 1]]);
    const [a, b] = effect.buffers[1].variables;
    assert.deepEqual([a.name, a.semantic, a.bufferOffset, b.semantic, b.bufferOffset],
        ['a', 'SV_POSITION', 0, 'COLOR0', 4]);
    const [c] = effect.buffers[2].variables;
    assert.deepEqual([c.bufferOffset, c.flags], [32, 4], 'packoffset: the explicit flag');
    assert.equal(effect.counts.numericVariables, 3);

    const globals = await effectOf('float4 x; int y; cbuffer z { float w; };');
    assert.deepEqual(globals.buffers.map(one=>[one.name, one.size]),
        [['$Globals', 32], ['z', 16]]);
});

test('constant buffers pack as fxc packs them', async()=>{
    // Wine's packing test: the size of each buffer as D3D10CompileEffectFromMemory laid it.
    const effect = await effectOf([
        'cbuffer p1 { float a1; float b1; float c1; float d1; };',
        'cbuffer p2 { float a2; float2 b2; };',
        'cbuffer p3 { float2 a3; float3 b3; };',
        'cbuffer p4 { float2 a4; float3 b4; float2 c4; };',
        'cbuffer p5 { float2 a5; float2 b5; float3 c5; };',
        'cbuffer p6 { float2 a6 : packoffset(c0); float3 b6 : packoffset(c1);',
        '    float2 c6 : packoffset(c0.z); };',
        'cbuffer p7 { float2 a7 : packoffset(c0); float3 b7 : packoffset(c1);',
        '    float2 c7 : packoffset(c2); };',
        'cbuffer p8 { float2 a8 : packoffset(c0); float3 b8 : packoffset(c0.y);',
        '    float4 c8 : packoffset(c2); };',
        'cbuffer p9 { float2 a9 : packoffset(c0); float2 b9 : packoffset(c0.y);',
        '    float2 c9 : packoffset(c0.z); };',
        'cbuffer p10 { float4 a10 : packoffset(c2); };',
        'cbuffer p11 { struct { float4 a11; float b11; } s11; float c11; };',
        'cbuffer p12 { float c12; struct { float b12; float4 a12; } s12; };',
        'cbuffer p13 { float a13; struct { float b13; } s13; };',
        'cbuffer p14 { struct { float a14; } s14; struct { float b14; } t14; };',
        'cbuffer p15 { float2 a15[2] : packoffset(c0); };',
    ].join('\n'));
    assert.deepEqual(effect.buffers.slice(1).map(b=>b.size),
        [16, 16, 32, 48, 32, 32, 48, 48, 16, 48, 32, 48, 32, 32, 32]);
    const offsets = Object.fromEntries(effect.buffers.flatMap(b=>b.variables)
        .map(v=>[v.name, v.bufferOffset]));
    assert.deepEqual([offsets.b2, offsets.b3, offsets.b5, offsets.c5, offsets.c6, offsets.b8,
        offsets.c11, offsets.s12, offsets.s13, offsets.t14],
    [4, 16, 8, 16, 8, 4, 20, 16, 16, 16]);
});

test('types: sizes, strides, members, as the effect reader takes them', async()=>{
    const effect = await effectOf([
        'struct inner { float f3 : SV_POSITION; float f4 : COLOR0; float f5 : COLOR1; };',
        'struct outer { float f1; float f2[3]; inner t[2]; };',
        'cbuffer cb { outer t1; };',
        'cbuffer m { float4x4 m0; row_major int2x3 m1; bool3x2 m2[2]; };',
    ].join('\n'));
    const [t1] = effect.buffers[1].variables;
    assert.deepEqual([t1.type.name, t1.type.unpackedSize, t1.type.stride, t1.type.packedSize],
        ['outer', 92, 96, 40]);
    assert.deepEqual(t1.type.members.map(m=>[m.name, m.bufferOffset, m.type.elements,
        m.type.unpackedSize, m.type.packedSize]),
    [['f1', 0, 0, 4, 4], ['f2', 16, 3, 36, 12], ['t', 64, 2, 28, 24]]);
    assert.deepEqual(t1.type.members[2].type.members.map(m=>m.semantic),
        ['SV_POSITION', 'COLOR0', 'COLOR1']);
    const [m0, m1, m2] = effect.buffers[2].variables;
    assert.deepEqual([m0.type.name, m0.type.svc, m0.type.unpackedSize], ['float4x4', 3, 64]);
    assert.deepEqual([m1.bufferOffset, m1.type.name, m1.type.svc, m1.type.unpackedSize,
        m1.type.stride], [64, 'int2x3', 2, 28, 32]);
    assert.deepEqual([m2.bufferOffset, m2.type.name, m2.type.elements, m2.type.unpackedSize,
        m2.type.packedSize], [96, 'bool3x2', 2, 60, 48]);
});

test('default values are packed without padding, a column at a time', async()=>{
    const effect = await effectOf([
        'float4 f4 = {1,2,3,4};',
        'float1 f1 = {1};',
        'int i = 10;',
        'int i2[2] = {9,12};',
        'float f = 0.2f;',
        'struct test { bool b1; float f2; bool b2; };',
        'test s1 = { true, -0.2f, false };',
        'matrix <uint, 2, 3> m1 = { 1, 2, 3, 4, 5, 6 };',
        'row_major matrix <uint, 2, 3> m2 = { 1, 2, 3, 4, 5, 6 };',
        'float2x2 m4 = { 1.0f, 2.0f, 3.0f, 4.0f };',
        'float none;',
    ].join('\n'));
    /** @param {string} name */
    const words = name=>{
        const variable = effect.buffers[0].variables.find(v=>v.name === name);
        const value = variable?.defaultValue;
        return value ? [...new Uint32Array(value.slice().buffer)] : null;
    };
    const float = (/** @type {number} */ x)=>new Uint32Array(Float32Array.of(x).buffer)[0];
    assert.deepEqual(words('f4'), [1, 2, 3, 4].map(float));
    assert.deepEqual(words('f1'), [float(1)]);
    assert.deepEqual(words('i'), [10]);
    assert.deepEqual(words('i2'), [9, 12]);
    assert.deepEqual(words('f'), [float(0.2)]);
    assert.deepEqual(words('s1'), [1, float(-0.2), 0]);
    assert.deepEqual(words('m1'), [1, 4, 2, 5, 3, 6], 'column-major: a column at a time');
    assert.deepEqual(words('m2'), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(words('m4'), [1, 3, 2, 4].map(float));
    assert.equal(words('none'), null);
    const offsets = effect.buffers[0].variables.map(v=>[v.name, v.bufferOffset]);
    assert.deepEqual(offsets.slice(0, 5), [['f4', 0], ['f1', 16], ['i', 20], ['i2', 32],
        ['f', 52]]);
});

test('state blocks, field by field, with the constant types fxc stores', async()=>{
    // The blocks of Wine's state group test, and what fxc wrote for them: an enumeration's name
    // as an int, a hexadecimal or `u` literal as a uint, a float as a float, a NULL as int 0.
    const effect = await effectOf([
        'RasterizerState rast { FillMode = wireframe; CullMode = front;',
        '    FrontCounterClockwise = true; DepthBias = -4; DepthBiasClamp = 0.5f;',
        '    SlopeScaledDepthBias = 0.25f; DepthClipEnable = false; ScissorEnable = true;',
        '    MultisampleEnable = true; AntialiasedLineEnable = true; };',
        'DepthStencilState depth { DepthEnable = true; DepthWriteMask = zero; DepthFunc = equal;',
        '    StencilEnable = true; StencilReadMask = 0x4; StencilWriteMask = 0x5;',
        '    FrontFaceStencilFail = invert; FrontFaceStencilDepthFail = incr;',
        '    FrontFaceStencilPass = decr; FrontFaceStencilFunc = less_equal;',
        '    BackFaceStencilFail = replace; BackFaceStencilDepthFail = incr_sat;',
        '    BackFaceStencilPass = decr_sat; BackFaceStencilFunc = greater_equal; };',
        'BlendState blend { AlphaToCoverageEnable = false; BlendEnable[0] = true;',
        '    BlendEnable[7] = false; SrcBlend = one; DestBlend = src_color; BlendOp = min;',
        '    SrcBlendAlpha = src_alpha; DestBlendAlpha = inv_src_alpha; BlendOpAlpha = max;',
        '    RenderTargetWriteMask[0] = 0x8; RenderTargetWriteMask[7] = 0x7; };',
        'SamplerState sampler0 { Filter = min_mag_mip_linear; AddressU = wrap;',
        '    AddressV = mirror; AddressW = clamp; MipLODBias = -1; MaxAnisotropy = 4u;',
        '    ComparisonFunc = always; BorderColor = float4(1.0, 2.0, 3.0, 4.0); MinLOD = 6u;',
        '    MaxLOD = 5u; Texture = NULL; };',
        'Texture2D t2; TextureCube tq_a[3];',
        'SamplerState by_name { Texture = t2; };',
        'SamplerState by_element { Texture = tq_a[2]; };',
        'technique10 tech0 {',
        '    pass pass0 {',
        '        SetBlendState(blend, float4(0.5f, 0.6f, 0.7f, 0.8f), 0xffff);',
        '        SetDepthStencilState(depth, 1.0f);',
        '        SetRasterizerState(rast);',
        '    }',
        '    pass pass2 {',
        '        SetDepthStencilState(NULL, 0);',
        '        SetBlendState(NULL, float4(0.0f, 0.0f, 0.0f, 0.0f), 0xffff);',
        '    }',
        '};',
    ].join('\n'));
    assert.deepEqual(statesOf(effect), {
        rast: ['12[0]=2:2 13[0]=2:2 14[0]=4:1 15[0]=2:4294967292 16[0]=1:1056964608 '
            + '17[0]=1:1048576000 18[0]=4:0 19[0]=4:1 20[0]=4:1 21[0]=4:1'],
        depth: ['22[0]=4:1 23[0]=2:0 24[0]=2:3 25[0]=4:1 26[0]=3:4 27[0]=3:5 28[0]=2:6 '
            + '29[0]=2:7 30[0]=2:8 31[0]=2:4 32[0]=2:3 33[0]=2:4 34[0]=2:5 35[0]=2:7'],
        blend: ['36[0]=4:0 37[0]=4:1 37[7]=4:0 38[0]=2:2 39[0]=2:3 40[0]=2:4 41[0]=2:5 '
            + '42[0]=2:6 43[0]=2:5 44[0]=3:8 44[7]=3:7'],
        sampler0: ['45[0]=2:21 46[0]=2:1 47[0]=2:2 48[0]=2:3 49[0]=2:4294967295 50[0]=3:4 '
            + '51[0]=2:8 52[0]=1:1065353216,1:1073741824,1:1077936128,1:1082130432 53[0]=3:6 '
            + '54[0]=3:5 55[0]=2:0'],
        by_name: ['55[0]=t2'],
        by_element: ['55[0]=tq_a[2]'],
        // A call's values come before its object.
        'tech0.pass0': ['10[0]=1:1056964608,1:1058642330,1:1060320051,1:1061997773 '
            + '11[0]=3:65535 2[0]=blend 9[0]=1:1065353216 1[0]=depth 0[0]=rast'],
        'tech0.pass2': ['9[0]=2:0 1[0]=2:0 10[0]=1:0,1:0,1:0,1:0 11[0]=3:65535 2[0]=2:0'],
    });
    assert.deepEqual([effect.counts.rasterizerStates, effect.counts.depthStencilStates,
        effect.counts.blendStates, effect.counts.samplers, effect.counts.shaderResources],
    [1, 1, 1, 3, 4], 'counted by element, as fxc counts them');
});

test('fx_4_1 blends each target its own way; fx_4_0 refuses it', async()=>{
    // fxc's fx_4_1: a 10.1 field without an index goes to all eight targets, and a field given
    // again replaces what it was given, at the end.
    const source = [
        'BlendState each {',
        ...[0, 1, 2, 3, 4, 5, 6, 7].map(i=>`    blendenable[${i}] = true;`),
        '    srcblend = one;',
        '    srcblend[0] = zero;',
        '};',
        'BlendState all { blendenable = true; srcblend = src_color; };',
    ].join('\n');
    const effect = await effectOf(source, 'fx_4_1');
    assert.deepEqual(statesOf(effect), {
        each: [[0, 1, 2, 3, 4, 5, 6, 7].map(i=>`37[${i}]=4:1`).join(' ') + ' '
            + [1, 2, 3, 4, 5, 6, 7].map(i=>`38[${i}]=2:2`).join(' ') + ' 38[0]=2:1'],
        all: [`37[0]=4:1 ${[0, 1, 2, 3, 4, 5, 6, 7].map(i=>`38[${i}]=2:3`).join(' ')}`],
    });
    // Wine's d3d10_1 test: E_FAIL from D3D10CompileEffectFromMemory, whose profile is fx_4_0.
    assert.match(await refusal('BlendState b { srcblend[0] = zero; };'),
        /memory\(1,16\): error X3000: 'srcblend\[\]': per render target srcblend is fx_4_1's/);
    assert.deepEqual(statesOf(await effectOf('BlendState b {};')), { b: [''] });
    assert.match(await refusal('RasterizerState r { CullMode[1] = none; };', 'fx_4_1'),
        /'CullMode\[\]': CullMode takes no index/);
});

test('a pass takes its values from variables, an array\'s element counted in dwords', async()=>{
    const effect = await effectOf([
        'uint i1;',
        'uint i1_a[2];',
        'float4 fv1 = {0.5f, 0.6f, 0.7f, 0.8f};',
        'float4 fv1_a[2];',
        'int i2 = 0x123;',
        'int i2_a[2];',
        'technique10 tech {',
        '    pass P0 { SetBlendState(NULL, fv1, i2); SetDepthStencilState(NULL, i1); }',
        '    pass P1 {',
        '        SetBlendState(NULL, fv1_a[1], i2_a[1]);',
        '        SetDepthStencilState(NULL, i1_a[1]);',
        '    }',
        '}',
    ].join('\n'));
    assert.deepEqual(statesOf(effect), {
        'tech.P0': ['10[0]=fv1 11[0]=i2 2[0]=2:0 9[0]=i1 1[0]=2:0'],
        'tech.P1': ['10[0]=fv1_a[4] 11[0]=i2_a[4] 2[0]=2:0 9[0]=i1_a[4] 1[0]=2:0'],
    });
});

test('shaders: compiled in a pass, in a variable, in an array, with uniform arguments',
    async()=>{
        const effect = await effectOf([
            'float4 color;',
            'Texture2D tex;',
            'SamplerState s { Filter = MIN_MAG_MIP_POINT; };',
            'float4 vs(float4 p : POSITION) : SV_POSITION { return p; }',
            'float4 vs2(int4 p : POSITION) : SV_POSITION { return p; }',
            'float4 ps(float4 p : SV_POSITION, uniform float k) : SV_TARGET',
            '{ return color * k + tex.Sample(s, p.xy); }',
            'VertexShader none = NULL;',
            'VertexShader v[2] = { CompileShader(vs_4_0, vs()), CompileShader(vs_4_0, vs2()) };',
            'PixelShader p = CompileShader(ps_4_0, ps(2.0));',
            'technique10 t {',
            '    pass inline {',
            '        SetVertexShader(CompileShader(vs_4_0, vs()));',
            '        SetGeometryShader(NULL);',
            '        SetPixelShader(CompileShader(ps_4_0, ps(0.5)));',
            '    }',
            '    pass named { SetVertexShader(v[1]); SetPixelShader(p); }',
            '    pass old { VertexShader = none; }',
            '}',
        ].join('\n'));
        assert.deepEqual(statesOf(effect)['t.inline'], ['6[0]=shader 8[0]=2:0 7[0]=shader']);
        assert.deepEqual(statesOf(effect)['t.named'], ['6[0]=v[1] 7[0]=p']);
        assert.deepEqual(statesOf(effect)['t.old'], ['6[0]=none']);
        const shaders = effect.objects.filter(o=>o.type.object === 'vertexshader'
            || o.type.object === 'pixelshader');
        assert.deepEqual(shaders.map(o=>[o.name, o.type.name, o.type.elements,
            o.elements.map(e=>(e.shader?.bytecode ? 'code' : 'none'))]),
        [['none', 'VertexShader', 0, ['none']], ['v', 'VertexShader', 2, ['code', 'code']],
            ['p', 'PixelShader', 0, ['code']]]);
        const inline = effect.techniques[0].passes[0].assignments;
        for (const a of [inline[0], inline[2]])
        {
            const code = /** @type {Uint8Array} */ (a.shader?.bytecode);
            assert.ok(parseDxbc(code)?.chunks.has('SHDR'), 'a model 4 container');
        }
        // Each element of a shader variable is counted, a NULL one too, and each shader a pass
        // compiles.
        assert.equal(effect.counts.shaders, 6);
        assert.equal(effect.counts.inlineShaders, 2);
    });

test('annotations: strings and numbers, on buffers, variables, objects, techniques, passes',
    async()=>{
        const effect = await effectOf([
            'cbuffer cb <string s = "cb_a"; >',
            '{ float f1 : COLOR0 <String s = "f1_a"; int n = 3;>; };',
            'BlendState bs <string s = "bs_a"; >;',
            'Texture2D tex <float2 q = {1, 2}; >;',
            'technique10 tech <string s = "tech_a"; > { pass P0 <bool b = true; > {} };',
        ].join('\n'));
        const text = (/** @type {number} */ at)=>{
            let end = at;
            while (effect.unstructured[end])
            {
                end++;
            }
            return String.fromCharCode(...effect.unstructured.subarray(at, end));
        };
        /** @param {import('../d3d10/effect.js').FxAnnotation[]} list */
        const read = list=>list.map(a=>[a.name, a.type.name, a.strings.length > 0
            ? a.strings.map(text).join() : [...new Uint32Array(
                /** @type {Uint8Array} */ (a.value).slice().buffer)].join()]);
        assert.deepEqual(read(effect.buffers[1].annotations), [['s', 'String', 'cb_a']]);
        assert.deepEqual(read(effect.buffers[1].variables[0].annotations),
            [['s', 'String', 'f1_a'], ['n', 'int', '3']]);
        assert.deepEqual(read(effect.objects[0].annotations), [['s', 'String', 'bs_a']]);
        assert.deepEqual(read(effect.objects[1].annotations),
            [['q', 'float2', '1065353216,1073741824']]);
        assert.deepEqual(read(effect.techniques[0].annotations), [['s', 'String', 'tech_a']]);
        assert.deepEqual(read(effect.techniques[0].passes[0].annotations), [['b', 'bool', '1']]);
    });

test('objects come in the order they were written, whatever declares them', async()=>{
    const effect = await effectOf([
        'RasterizerState r {};',
        'Texture2D t;',
        'SamplerState s {};',
        'DepthStencilState d;',
        'SamplerState plain;',
        'RenderTargetView rtv;',
        'DepthStencilView dsv;',
        'GeometryShader g[2];',
        'Texture2DMS <float4, 4> ms;',
        'string name = "text";',
    ].join('\n'));
    assert.deepEqual(effect.objects.map(o=>[o.name, o.type.name, o.type.elements]), [
        ['r', 'RasterizerState', 0], ['t', 'Texture2D', 0], ['s', 'SamplerState', 0],
        ['d', 'DepthStencilState', 0], ['plain', 'SamplerState', 0],
        ['rtv', 'RenderTargetView', 0], ['dsv', 'DepthStencilView', 0],
        ['g', 'GeometryShader', 2], ['ms', 'Texture2DMS', 0], ['name', 'String', 0]]);
    assert.deepEqual([effect.counts.renderTargetViews, effect.counts.depthStencilViews,
        effect.counts.strings, effect.counts.shaders], [1, 1, 1, 2]);
});

test('macros and included files, and messages placed in the file they came from', async()=>{
    const include = (/** @type {string} */ name)=>({
        'states.fxh': 'BlendState b { SrcBlend = MODE; };\nRasterizerState r { CullMode = none; };',
        'bad.fxh': '\nBlendState b { SrcBlend[2] = one; };',
    })[name] ?? null;
    const result = await compileEffect('#include "states.fxh"\ntechnique10 t {}',
        { profile: 'fx_4_0', defines: [['MODE', 'inv_src_alpha']], include });
    assert.ok(result.ok, result.messages);
    const read = parseEffect(/** @type {Uint8Array} */ (result.bytes));
    assert.ok('effect' in read);
    assert.deepEqual(statesOf(read.effect), { b: ['38[0]=2:6'], r: ['13[0]=2:1'] });
    assert.deepEqual(read.effect.techniques.map(t=>t.name), ['t']);
    const refused = await compileEffect('// one\n#include "bad.fxh"', { profile: 'fx_4_0',
        include });
    assert.match(refused.messages, /^bad\.fxh\(2,16\): error X3000: 'SrcBlend\[\]'/);
});

test('what the effect compiler refuses, it says, and writes nothing', async()=>{
    // An index or a value computed when the effect runs needs the effect's expression code.
    assert.match(await refusal([
        'float4 g; BlendState b[2] { {}, {} };',
        'technique10 t { pass p { SetBlendState(b[g.w], float4(0, 0, 0, 0), 0xffff); } }',
    ].join('\n')), /memory\(2,26\): error X3000: 'SetBlendState': a state computed by an expression/);
    assert.match(await refusal([
        'float f;',
        'technique10 t { pass p { SetBlendState(NULL, f, 0); } }',
    ].join('\n')), /'f': 1 values for a state that takes 4/);
    // A geometry shader's program (and stream output) is not compiled here.
    assert.match(await refusal([
        'float4 vs(float4 p : POSITION) : SV_POSITION { return p; }',
        'technique10 t { pass p { SetGeometryShader(CompileShader(gs_4_0, vs())); } }',
    ].join('\n')), /error X3506: 'gs_4_0'/);
    assert.match(await refusal([
        'float4 gs(float4 p : POSITION) : SV_POSITION { return p; }',
        'GeometryShader g = ConstructGSWithSO(CompileShader(gs_4_0, gs()), "SV_POSITION.x");',
    ].join('\n')), /a geometry shader with stream output is not compiled here/);
    assert.match(await refusal('shared cbuffer c { float f; };'),
        /'shared': a variable an effect pool shares/);
    assert.match(await refusal('fxgroup g { technique11 t {} }'), /fx_5_0's/);
    assert.match(await refusal('BlendState b { Speed = 3; };'),
        /'Speed' is not a blend state/);
    assert.match(await refusal('BlendState b { SrcBlend = sideways; };'),
        /memory\(1,16\): error X3004: undeclared identifier 'sideways'/);
    assert.match(await refusal('BlendState b { SrcBlend = "one"; };'),
        /memory\(1,16\): error X3000: 'string' is not a value this state takes/);
    assert.match(await refusal('SamplerState s { Texture = missing; };'),
        /error X3004: undeclared identifier 'missing'/);
    // A shader that does not compile fails the effect, with the shader's own message.
    assert.match(await refusal([
        'float4 ps() : SV_TARGET { return undefinedThing; }',
        'technique10 t { pass p { SetPixelShader(CompileShader(ps_4_0, ps())); } }',
    ].join('\n')), /undefinedThing/);
    assert.match(await refusal('float4 x = ;'), /error X3000/);
});
