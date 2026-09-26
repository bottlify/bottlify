/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The translator, one instruction at a time: each opcode is given in
 * bytecode and the statement it becomes is checked as text. The text is the
 * contract -- a reader can put the line next to the disassembly -- and it is
 * what the renderer will hand the GPU.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { END_TOKEN, OPCODE, REGISTER, SHADER_KIND, parseShader, versionToken } from './shader.js';
import {
    FOG_RANGE_LOCATION, HYBRID_CONSTANTS, fixedVertexStage, translateShader, varyingLocation,
} from './wgsl.js';
import { D3DDECLUSAGE } from './declaration.js';
import { D3DFOG } from './constants.js';
import { FOG_SOURCE } from '../webgpu/internal/pipeline.js';

/** @param {number} type @param {number} index @param {number} writeMask @param {number} result */
const dst = (type, index, writeMask = 0xf, result = 0)=>(0x80000000 | ((type & 7) << 28)
    | ((type & 0x18) << 8) | (result << 20) | (writeMask << 16) | index) >>> 0;
/** @param {number} type @param {number} index @param {number} swizzle @param {number} modifier */
const src = (type, index, swizzle = 0xe4, modifier = 0)=>(0x80000000 | ((type & 7) << 28)
    | ((type & 0x18) << 8) | (modifier << 24) | (swizzle << 16) | index) >>> 0;
/** @param {number} opcode @param {number} length @param {number} control */
const op = (opcode, length, control = 0)=>((length << 24) | (control << 16) | opcode) >>> 0;
const RELATIVE = 1 << 13;

const VS_2_0 = versionToken(SHADER_KIND.VERTEX, 2, 0);
const VS_3_0 = versionToken(SHADER_KIND.VERTEX, 3, 0);
const PS_2_0 = versionToken(SHADER_KIND.PIXEL, 2, 0);
const PS_3_0 = versionToken(SHADER_KIND.PIXEL, 3, 0);
const PS_1_1 = versionToken(SHADER_KIND.PIXEL, 1, 1);

/** dcl_position v0, or whichever usage and register. */
const dclInput = (/** @type {number} */ usage, /** @type {number} */ register, index = 0)=>[
    op(OPCODE.DCL, 2), (0x80000000 | (index << 16) | usage) >>> 0, dst(REGISTER.INPUT, register),
];
/** dcl_2d s#. */
const dclSampler = (/** @type {number} */ register, type = 2)=>[
    op(OPCODE.DCL, 2), ((type << 27) | 0x80000000) >>> 0, dst(REGISTER.SAMPLER, register),
];

/**
 * The body a vertex shader of one instruction produces, with the position
 * written so the module is whole.
 *
 * @param {number[]} tokens
 */
const vertexBody = tokens=>{
    const parsed = parseShader([VS_2_0, ...dclInput(0, 0), ...tokens,
        op(OPCODE.MOV, 2), dst(REGISTER.RASTOUT, 0), src(REGISTER.INPUT, 0), END_TOKEN]);
    assert.equal(parsed.error, null);
    return translateShader(parsed);
};

/** @param {number[]} tokens */
const pixelBody = tokens=>{
    const parsed = parseShader([PS_2_0, ...dclSampler(0), ...tokens,
        op(OPCODE.MOV, 2), dst(REGISTER.COLOROUT, 0), src(REGISTER.TEMP, 0), END_TOKEN]);
    assert.equal(parsed.error, null);
    return translateShader(parsed);
};

/** @param {string} wgsl @param {string} line */
const assertLine = (wgsl, line)=>assert.ok(wgsl.split('\n').some(one=>one.trim() === line),
    `expected the line\n    ${line}\nin\n${wgsl}`);

test('the arithmetic instructions become the statements they mean', ()=>{
    const r = REGISTER.TEMP;
    const c = REGISTER.CONST;
    const cases = /** @type {[string, number[], string][]} */ ([
        ['mov', [op(OPCODE.MOV, 2), dst(r, 0), src(c, 1)], 'r0 = c[1];'],
        ['add', [op(OPCODE.ADD, 3), dst(r, 0), src(c, 1), src(c, 2)], 'r0 = (c[1] + c[2]);'],
        ['sub', [op(OPCODE.SUB, 3), dst(r, 0), src(c, 1), src(c, 2)], 'r0 = (c[1] - c[2]);'],
        ['mul', [op(OPCODE.MUL, 3), dst(r, 0), src(c, 1), src(c, 2)], 'r0 = (c[1] * c[2]);'],
        ['mad', [op(OPCODE.MAD, 4), dst(r, 0), src(c, 1), src(c, 2), src(c, 3)],
            'r0 = (c[1] * c[2] + c[3]);'],
        ['min', [op(OPCODE.MIN, 3), dst(r, 0), src(c, 1), src(c, 2)], 'r0 = min(c[1], c[2]);'],
        ['max', [op(OPCODE.MAX, 3), dst(r, 0), src(c, 1), src(c, 2)], 'r0 = max(c[1], c[2]);'],
        ['rcp', [op(OPCODE.RCP, 2), dst(r, 0), src(c, 1)], 'r0 = vec4f(1.0 / c[1].x);'],
        ['rsq', [op(OPCODE.RSQ, 2), dst(r, 0), src(c, 1)],
            'r0 = vec4f(inverseSqrt(abs(c[1].x)));'],
        ['exp', [op(OPCODE.EXP, 2), dst(r, 0), src(c, 1)], 'r0 = vec4f(exp2(c[1].x));'],
        ['log', [op(OPCODE.LOG, 2), dst(r, 0), src(c, 1)], 'r0 = vec4f(log2(abs(c[1].x)));'],
        ['frc', [op(OPCODE.FRC, 2), dst(r, 0), src(c, 1)], 'r0 = fract(c[1]);'],
        ['dp3', [op(OPCODE.DP3, 3), dst(r, 0), src(c, 1), src(c, 2)],
            'r0 = vec4f(dot(c[1].xyz, c[2].xyz));'],
        ['dp4', [op(OPCODE.DP4, 3), dst(r, 0), src(c, 1), src(c, 2)],
            'r0 = vec4f(dot(c[1], c[2]));'],
        ['dp2add', [op(OPCODE.DP2ADD, 4), dst(r, 0), src(c, 1), src(c, 2), src(c, 3)],
            'r0 = vec4f(dot(c[1].xy, c[2].xy) + c[3].x);'],
        ['slt', [op(OPCODE.SLT, 3), dst(r, 0), src(c, 1), src(c, 2)],
            'r0 = select(vec4f(0.0), vec4f(1.0), c[1] < c[2]);'],
        ['sge', [op(OPCODE.SGE, 3), dst(r, 0), src(c, 1), src(c, 2)],
            'r0 = select(vec4f(0.0), vec4f(1.0), c[1] >= c[2]);'],
        ['lit', [op(OPCODE.LIT, 2), dst(r, 0), src(c, 1)],
            'r0 = vec4f(1.0, max(c[1].x, 0.0), select(0.0, pow(max(c[1].y, 0.0),'
            + ' clamp(c[1].w, -128.0, 128.0)), c[1].x > 0.0), 1.0);'],
        ['dst', [op(OPCODE.DST, 3), dst(r, 0), src(c, 1), src(c, 2)],
            'r0 = vec4f(1.0, c[1].y * c[2].y, c[1].z, c[2].w);'],
        ['lrp', [op(OPCODE.LRP, 4), dst(r, 0), src(c, 1), src(c, 2), src(c, 3)],
            'r0 = mix(c[3], c[2], c[1]);'],
        ['m4x4', [op(OPCODE.M4x4, 3), dst(r, 0), src(c, 1), src(c, 4)],
            'r0 = vec4f(dot(c[1], c[4]), dot(c[1], c[5]), dot(c[1], c[6]), dot(c[1], c[7]));'],
        ['m4x3', [op(OPCODE.M4x3, 3), dst(r, 0), src(c, 1), src(c, 4)],
            'r0 = vec4f(dot(c[1], c[4]), dot(c[1], c[5]), dot(c[1], c[6]), 0.0);'],
        ['m3x4', [op(OPCODE.M3x4, 3), dst(r, 0), src(c, 1), src(c, 4)],
            'r0 = vec4f(dot(c[1].xyz, c[4].xyz), dot(c[1].xyz, c[5].xyz),'
            + ' dot(c[1].xyz, c[6].xyz), dot(c[1].xyz, c[7].xyz));'],
        ['m3x3', [op(OPCODE.M3x3, 3), dst(r, 0), src(c, 1), src(c, 4)],
            'r0 = vec4f(dot(c[1].xyz, c[4].xyz), dot(c[1].xyz, c[5].xyz),'
            + ' dot(c[1].xyz, c[6].xyz), 0.0);'],
        ['m3x2', [op(OPCODE.M3x2, 3), dst(r, 0), src(c, 1), src(c, 4)],
            'r0 = vec4f(dot(c[1].xyz, c[4].xyz), dot(c[1].xyz, c[5].xyz), 0.0, 0.0);'],
        ['pow', [op(OPCODE.POW, 3), dst(r, 0), src(c, 1), src(c, 2)],
            'r0 = vec4f(pow(abs(c[1].x), c[2].x));'],
        ['crs', [op(OPCODE.CRS, 3), dst(r, 0), src(c, 1), src(c, 2)],
            'r0 = vec4f(cross(c[1].xyz, c[2].xyz), 0.0);'],
        ['sgn', [op(OPCODE.SGN, 4), dst(r, 0), src(c, 1), src(r, 1), src(r, 2)],
            'r0 = sign(c[1]);'],
        ['abs', [op(OPCODE.ABS, 2), dst(r, 0), src(c, 1)], 'r0 = abs(c[1]);'],
        ['nrm', [op(OPCODE.NRM, 2), dst(r, 0), src(c, 1)],
            'r0 = vec4f(normalize(c[1].xyz), 0.0);'],
        ['sincos', [op(OPCODE.SINCOS, 4), dst(r, 0), src(c, 1), src(c, 2), src(c, 3)],
            'r0 = vec4f(cos(c[1].x), sin(c[1].x), 0.0, 0.0);'],
        ['mova', [op(OPCODE.MOVA, 2), dst(REGISTER.ADDR, 0), src(c, 1)], 'a0 = round(c[1]);'],
        ['expp', [op(OPCODE.EXPP, 2), dst(r, 0), src(c, 1)], 'r0 = vec4f(exp2(c[1].x));'],
        ['logp', [op(OPCODE.LOGP, 2), dst(r, 0), src(c, 1)], 'r0 = vec4f(log2(abs(c[1].x)));'],
    ]);
    for (const [name, tokens, line] of cases)
    {
        const translated = vertexBody(tokens);
        assert.equal(translated.error, null, `${name} translates`);
        assertLine(translated.wgsl, line);
    }
});

test('the pixel-stage instructions become the statements they mean', ()=>{
    const r = REGISTER.TEMP;
    const t = REGISTER.TEXTURE;
    const s = REGISTER.SAMPLER;
    const cases = /** @type {[string, number[], string][]} */ ([
        ['texld', [op(OPCODE.TEX, 3), dst(r, 0), src(t, 0), src(s, 0)],
            'r0 = textureSample(tex0, samp0, in.t0.xy);'],
        ['texldp', [op(OPCODE.TEX, 3, 1), dst(r, 0), src(t, 0), src(s, 0)],
            'r0 = textureSample(tex0, samp0, (in.t0.xy / in.t0.w));'],
        ['texldb', [op(OPCODE.TEX, 3, 2), dst(r, 0), src(t, 0), src(s, 0)],
            'r0 = textureSampleBias(tex0, samp0, in.t0.xy, in.t0.w);'],
        ['texldl', [op(OPCODE.TEXLDL, 3), dst(r, 0), src(t, 0), src(s, 0)],
            'r0 = textureSampleLevel(tex0, samp0, in.t0.xy, in.t0.w);'],
        ['texldd', [op(OPCODE.TEXLDD, 5), dst(r, 0), src(t, 0), src(s, 0), src(r, 1), src(r, 2)],
            'r0 = textureSampleGrad(tex0, samp0, in.t0.xy, r1.xy, r2.xy);'],
        ['texkill', [op(OPCODE.TEXKILL, 1), dst(r, 1)],
            'if (any(r1.xyz < vec3f(0.0))) { discard; }'],
        ['cmp', [op(OPCODE.CMP, 4), dst(r, 0), src(r, 1), src(r, 2), src(r, 3)],
            'r0 = select(r3, r2, r1 >= vec4f(0.0));'],
        ['cnd', [op(OPCODE.CND, 4), dst(r, 0), src(r, 1), src(r, 2), src(r, 3)],
            'r0 = select(r3, r2, r1 > vec4f(0.5));'],
        ['dsx', [op(OPCODE.DSX, 2), dst(r, 0), src(r, 1)], 'r0 = dpdx(r1);'],
        ['dsy', [op(OPCODE.DSY, 2), dst(r, 0), src(r, 1)], 'r0 = dpdy(r1);'],
    ]);
    for (const [name, tokens, line] of cases)
    {
        const translated = pixelBody(tokens);
        assert.equal(translated.error, null, `${name} translates`);
        assertLine(translated.wgsl, line);
    }
});

test('a cube sampler takes three coordinates, and a sampler read without a dcl is refused', ()=>{
    const parsed = parseShader([PS_2_0, ...dclSampler(1, 3),
        op(OPCODE.TEX, 3), dst(REGISTER.TEMP, 0), src(REGISTER.TEXTURE, 0),
        src(REGISTER.SAMPLER, 1),
        op(OPCODE.MOV, 2), dst(REGISTER.COLOROUT, 0), src(REGISTER.TEMP, 0), END_TOKEN]);
    const translated = translateShader(parsed);
    assert.equal(translated.error, null);
    assertLine(translated.wgsl, 'r0 = textureSample(tex1, samp1, in.t0.xyz);');
    assertLine(translated.wgsl, '@group(2) @binding(0) var tex1: texture_cube<f32>;');
    assertLine(translated.wgsl, '@group(2) @binding(1) var samp1: sampler;');
    assert.deepEqual(translated.samplers, [{ index: 1, type: 'texture_cube<f32>' }]);

    const undeclared = translateShader(parseShader([PS_2_0,
        op(OPCODE.TEX, 3), dst(REGISTER.TEMP, 0), src(REGISTER.TEXTURE, 0),
        src(REGISTER.SAMPLER, 2),
        END_TOKEN]));
    assert.match(undeclared.error ?? '', /s2 is read without a declaration/);
});

test('swizzles, source modifiers, write masks and saturation are honoured', ()=>{
    const r = REGISTER.TEMP;
    const c = REGISTER.CONST;
    const cases = /** @type {[string, number[], string][]} */ ([
        ['swizzle', [op(OPCODE.MOV, 2), dst(r, 0), src(c, 1, 0x00)], 'r0 = c[1].xxxx;'],
        ['swizzle', [op(OPCODE.MOV, 2), dst(r, 0), src(c, 1, 0x1b)], 'r0 = c[1].wzyx;'],
        ['neg', [op(OPCODE.MOV, 2), dst(r, 0), src(c, 1, 0xe4, 1)], 'r0 = (-c[1]);'],
        ['bias', [op(OPCODE.MOV, 2), dst(r, 0), src(c, 1, 0xe4, 2)], 'r0 = (c[1] - vec4f(0.5));'],
        ['sign', [op(OPCODE.MOV, 2), dst(r, 0), src(c, 1, 0xe4, 4)],
            'r0 = (c[1] * 2.0 - vec4f(1.0));'],
        ['comp', [op(OPCODE.MOV, 2), dst(r, 0), src(c, 1, 0xe4, 6)], 'r0 = (vec4f(1.0) - c[1]);'],
        ['x2', [op(OPCODE.MOV, 2), dst(r, 0), src(c, 1, 0xe4, 7)], 'r0 = (c[1] * 2.0);'],
        ['abs', [op(OPCODE.MOV, 2), dst(r, 0), src(c, 1, 0xe4, 11)], 'r0 = abs(c[1]);'],
        ['absneg', [op(OPCODE.MOV, 2), dst(r, 0), src(c, 1, 0xe4, 12)], 'r0 = (-abs(c[1]));'],
        ['mask', [op(OPCODE.MOV, 2), dst(r, 0, 0x5), src(c, 1)],
            '{ let _t = c[1]; r0 = vec4f(_t.x, r0.y, _t.z, r0.w); }'],
        ['saturate', [op(OPCODE.MOV, 2), dst(r, 0, 0xf, 1), src(c, 1)],
            'r0 = clamp(c[1], vec4f(0.0), vec4f(1.0));'],
        ['both', [op(OPCODE.MOV, 2), dst(r, 0, 0x8, 1), src(c, 1)],
            '{ let _t = clamp(c[1], vec4f(0.0), vec4f(1.0));'
            + ' r0 = vec4f(r0.x, r0.y, r0.z, _t.w); }'],
        ['relative', [op(OPCODE.MOV, 3), dst(r, 0), (src(c, 4) | RELATIVE) >>> 0,
            src(REGISTER.ADDR, 0, 0x00)], 'r0 = c[4 + i32(a0.xxxx.x)];'],
    ]);
    for (const [name, tokens, line] of cases)
    {
        const translated = vertexBody(tokens);
        assert.equal(translated.error, null, `${name} translates`);
        assertLine(translated.wgsl, line);
    }
});

test('a defined constant shadows the register file for the shader\'s own reads', ()=>{
    const translated = vertexBody([
        op(OPCODE.DEF, 5), dst(REGISTER.CONST, 9), 0x3f800000, 0x3f000000, 0, 0xc0000000,
        op(OPCODE.DEFI, 5), dst(REGISTER.CONSTINT, 2), 3, 0xffffffff, 0, 0,
        op(OPCODE.DEFB, 2), dst(REGISTER.CONSTBOOL, 4), 1,
        op(OPCODE.MOV, 2), dst(REGISTER.TEMP, 0), src(REGISTER.CONST, 9),
        op(OPCODE.MOV, 2), dst(REGISTER.TEMP, 1), src(REGISTER.CONST, 8),
    ]);
    assert.equal(translated.error, null);
    assertLine(translated.wgsl, 'let k9 = vec4f(1.0, 0.5, 0.0, -2.0);');
    assertLine(translated.wgsl, 'let ki2 = vec4i(3, -1, 0, 0);');
    assertLine(translated.wgsl, 'let kb4 = true;');
    assertLine(translated.wgsl, 'r0 = k9;');
    assertLine(translated.wgsl, 'r1 = c[8];');
});

test('flow control maps onto WGSL\'s own, and the loop register steps', ()=>{
    const translated = vertexBody([
        op(OPCODE.IF, 1), src(REGISTER.CONSTBOOL, 3),
        op(OPCODE.MOV, 2), dst(REGISTER.TEMP, 0), src(REGISTER.CONST, 1),
        op(OPCODE.ELSE, 0),
        op(OPCODE.IFC, 2, 1), src(REGISTER.TEMP, 0), src(REGISTER.CONST, 2),
        op(OPCODE.MOV, 2), dst(REGISTER.TEMP, 0), src(REGISTER.CONST, 3),
        op(OPCODE.ENDIF, 0),
        op(OPCODE.ENDIF, 0),
        op(OPCODE.REP, 1), src(REGISTER.CONSTINT, 0),
        op(OPCODE.BREAKC, 2, 4), src(REGISTER.TEMP, 0), src(REGISTER.CONST, 2),
        op(OPCODE.ENDREP, 0),
        op(OPCODE.LOOP, 2), src(REGISTER.LOOP, 0), src(REGISTER.CONSTINT, 1),
        op(OPCODE.MOV, 3), dst(REGISTER.TEMP, 1), (src(REGISTER.CONST, 10) | RELATIVE) >>> 0,
        src(REGISTER.LOOP, 0, 0x00),
        op(OPCODE.BREAK, 0),
        op(OPCODE.ENDLOOP, 0),
    ]);
    assert.equal(translated.error, null);
    assertLine(translated.wgsl, 'if ((cb[0][3] != 0u)) {');
    assertLine(translated.wgsl, '} else {');
    assertLine(translated.wgsl, 'if (r0.x > c[2].x) {');
    assertLine(translated.wgsl, 'for (var _rep0 = 0; _rep0 < ci[0].x; _rep0++) {');
    assertLine(translated.wgsl, 'if (r0.x < c[2].x) { break; }');
    assertLine(translated.wgsl, 'aL = ci[1].y;');
    assertLine(translated.wgsl, 'for (var _loop0 = 0; _loop0 < ci[1].x; _loop0++) {');
    assertLine(translated.wgsl, 'r1 = c[10 + i32(aL.xxxx.x)];');
    assertLine(translated.wgsl, 'break;');
    assertLine(translated.wgsl, 'aL += ci[1].z;');
    const fnBody = translated.wgsl.slice(translated.wgsl.indexOf('fn vs_main'));
    assert.equal((fnBody.match(/^\s*}\s*$/gm) ?? []).length, 5,
        'four blocks and the function close');

    const open = vertexBody([op(OPCODE.IF, 1), src(REGISTER.CONSTBOOL, 0)]);
    assert.match(open.error ?? '', /left open/);
    const stray = vertexBody([op(OPCODE.ENDIF, 0)]);
    assert.match(stray.error ?? '', /closes nothing/);
});

test('a whole vertex shader declares its inputs by location and its outputs by semantic', ()=>{
    const parsed = parseShader([VS_2_0,
        ...dclInput(D3DDECLUSAGE.POSITION, 0),
        ...dclInput(D3DDECLUSAGE.TEXCOORD, 3, 1),
        ...dclInput(D3DDECLUSAGE.NORMAL, 1),
        op(OPCODE.M4x4, 3), dst(REGISTER.RASTOUT, 0), src(REGISTER.INPUT, 0),
        src(REGISTER.CONST, 0),
        op(OPCODE.MOV, 2), dst(REGISTER.OUTPUT, 2), src(REGISTER.INPUT, 3),
        op(OPCODE.MOV, 2), dst(REGISTER.ATTROUT, 1), src(REGISTER.INPUT, 1),
        op(OPCODE.MOV, 2), dst(REGISTER.RASTOUT, 1, 0x1), src(REGISTER.CONST, 4),
        END_TOKEN]);
    const translated = translateShader(parsed);
    assert.equal(translated.error, null);
    assert.equal(translated.entry, 'vs_main');
    assert.deepEqual(translated.inputs, [
        { location: 0, usage: D3DDECLUSAGE.POSITION, usageIndex: 0, register: 0 },
        { location: 1, usage: D3DDECLUSAGE.TEXCOORD, usageIndex: 1, register: 3 },
        { location: 2, usage: D3DDECLUSAGE.NORMAL, usageIndex: 0, register: 1 },
    ]);
    assertLine(translated.wgsl, '@location(0) v0: vec4<f32>,');
    assertLine(translated.wgsl, '@location(1) v3: vec4<f32>,');
    assertLine(translated.wgsl, '@builtin(position) @invariant oPos: vec4f,');
    assertLine(translated.wgsl, `@location(${varyingLocation(D3DDECLUSAGE.COLOR, 1)}) oD1: vec4f,`);
    assertLine(translated.wgsl,
        `@location(${varyingLocation(D3DDECLUSAGE.TEXCOORD, 2)}) oT2: vec4f,`);
    assertLine(translated.wgsl, `@location(${varyingLocation(D3DDECLUSAGE.FOG, 0)}) oFog: vec4f,`);
    // The float file is declared only as far as the shader reaches: c0..c3
    // for the matrix and c4 for the fog, and c5 past them for the viewport.
    assertLine(translated.wgsl, '@group(0) @binding(0) var<uniform> c: array<vec4f, 6>;');
    assert.equal(translated.constants, 6);
    assertLine(translated.wgsl, 'fn vs_main(in: VsIn) -> VsOut {');
    assertLine(translated.wgsl, 'let v3 = in.v3;');
    assertLine(translated.wgsl, 'out.oT2 = v3;');
    assertLine(translated.wgsl, 'out.oD1 = v1;');
    assertLine(translated.wgsl, 'return out;');
});

test('a whole pixel shader reads the varyings the vertex shader wrote and writes its colour', ()=>{
    const parsed = parseShader([PS_2_0,
        ...dclSampler(0),
        op(OPCODE.DCL, 2), 0x80000000, dst(REGISTER.TEXTURE, 2),
        op(OPCODE.DCL, 2), 0x80000000, dst(REGISTER.INPUT, 1),
        op(OPCODE.TEX, 3), dst(REGISTER.TEMP, 0), src(REGISTER.TEXTURE, 2),
        src(REGISTER.SAMPLER, 0),
        op(OPCODE.MUL, 3), dst(REGISTER.COLOROUT, 0), src(REGISTER.TEMP, 0), src(REGISTER.INPUT, 1),
        op(OPCODE.MOV, 2), dst(REGISTER.DEPTHOUT, 0), src(REGISTER.TEMP, 0),
        END_TOKEN]);
    const translated = translateShader(parsed);
    assert.equal(translated.error, null);
    assert.equal(translated.entry, 'ps_main');
    assertLine(translated.wgsl,
        `@location(${varyingLocation(D3DDECLUSAGE.TEXCOORD, 2)}) t2: vec4f,`);
    assertLine(translated.wgsl, `@location(${varyingLocation(D3DDECLUSAGE.COLOR, 1)}) v1: vec4f,`);
    assertLine(translated.wgsl, '@location(0) oC0: vec4f,');
    assertLine(translated.wgsl, '@builtin(frag_depth) oDepth: f32,');
    assertLine(translated.wgsl, '@group(1) @binding(0) var<uniform> c: array<vec4f, 1>;');
    assertLine(translated.wgsl, 'oC0 = (r0 * in.v1);');
    assertLine(translated.wgsl, 'out.oC0 = oC0;');
    assertLine(translated.wgsl, 'out.oDepth = oDepth.x;');
});

test('a vertex shader below model 3 hands on its colours held to [0, 1]', ()=>{
    // Wine's d3d9 test_color_clamping: vs_1_1 and vs_2_0 write 2.0 to oD0 and
    // oD1, a ps_1_1 / ps_2_0 adds the two and quarters the sum, and Windows
    // draws 0x7f7f7f -- each colour arrived as one. Under vs_3_0 and ps_3_0
    // the same arithmetic draws white: a model 3 output is not clamped.
    const vs2 = translateShader(parseShader([VS_2_0, ...dclInput(0, 0),
        op(OPCODE.MOV, 2), dst(REGISTER.RASTOUT, 0), src(REGISTER.INPUT, 0),
        op(OPCODE.ADD, 3), dst(REGISTER.ATTROUT, 0), src(REGISTER.CONST, 0),
        src(REGISTER.CONST, 0),
        op(OPCODE.ADD, 3), dst(REGISTER.ATTROUT, 1), src(REGISTER.CONST, 0),
        src(REGISTER.CONST, 0),
        op(OPCODE.MOV, 2), dst(REGISTER.OUTPUT, 0), src(REGISTER.CONST, 0), END_TOKEN]));
    assert.equal(vs2.error, null);
    const lines = vs2.wgsl.split('\n').map(line=>line.trim());
    const held = [lines.indexOf('out.oD0 = saturate(out.oD0);'),
        lines.indexOf('out.oD1 = saturate(out.oD1);')];
    assert.ok(held.every(at=>at > lines.indexOf('out.oD1 = (c[0] + c[0]);')), vs2.wgsl);
    assert.ok(!vs2.wgsl.includes('saturate(out.oT0)'), 'a coordinate set is not a colour');

    const vs3 = translateShader(parseShader([VS_3_0,
        ...dclInput(D3DDECLUSAGE.POSITION, 0),
        op(OPCODE.DCL, 2), (0x80000000 | D3DDECLUSAGE.POSITION) >>> 0, dst(REGISTER.OUTPUT, 0),
        op(OPCODE.DCL, 2), (0x80000000 | D3DDECLUSAGE.COLOR) >>> 0, dst(REGISTER.OUTPUT, 1),
        op(OPCODE.MOV, 2), dst(REGISTER.OUTPUT, 0), src(REGISTER.INPUT, 0),
        op(OPCODE.ADD, 3), dst(REGISTER.OUTPUT, 1), src(REGISTER.CONST, 0),
        src(REGISTER.CONST, 0),
        END_TOKEN]));
    assert.equal(vs3.error, null);
    assert.ok(!vs3.wgsl.includes('saturate'), vs3.wgsl);
});

test('model 3 names its outputs and inputs by declared semantic', ()=>{
    const vs = translateShader(parseShader([VS_3_0,
        ...dclInput(D3DDECLUSAGE.POSITION, 0),
        op(OPCODE.DCL, 2), (0x80000000 | D3DDECLUSAGE.POSITION) >>> 0, dst(REGISTER.OUTPUT, 0),
        op(OPCODE.DCL, 2), (0x80000000 | (2 << 16) | D3DDECLUSAGE.TEXCOORD) >>> 0,
        dst(REGISTER.OUTPUT, 1),
        op(OPCODE.MOV, 2), dst(REGISTER.OUTPUT, 0), src(REGISTER.INPUT, 0),
        op(OPCODE.MOV, 2), dst(REGISTER.OUTPUT, 1), src(REGISTER.INPUT, 0),
        END_TOKEN]));
    assert.equal(vs.error, null);
    assertLine(vs.wgsl, 'out.oPos = v0;');
    assertLine(vs.wgsl, 'out.o1 = v0;');
    assertLine(vs.wgsl, `@location(${varyingLocation(D3DDECLUSAGE.TEXCOORD, 2)}) o1: vec4f,`);

    const ps = translateShader(parseShader([PS_3_0,
        op(OPCODE.DCL, 2), (0x80000000 | (2 << 16) | D3DDECLUSAGE.TEXCOORD) >>> 0,
        dst(REGISTER.INPUT, 5),
        op(OPCODE.MOV, 2), dst(REGISTER.COLOROUT, 0), src(REGISTER.INPUT, 5),
        op(OPCODE.MOV, 2), dst(REGISTER.COLOROUT, 1), src(REGISTER.MISCTYPE, 1),
        END_TOKEN]));
    assert.equal(ps.error, null);
    assertLine(ps.wgsl, `@location(${varyingLocation(D3DDECLUSAGE.TEXCOORD, 2)}) v5: vec4f,`);
    assertLine(ps.wgsl, 'oC1 = vec4f(select(-1.0, 1.0, in.vFace));');
    assertLine(ps.wgsl, '@location(1) oC1: vec4f,');
});

test('a 1.x pixel shader\'s tex and texcoord translate, and its addressing modes do not', ()=>{
    const legacy = translateShader(parseShader([PS_1_1,
        op(OPCODE.TEX, 0), dst(REGISTER.TEXTURE, 0),
        op(OPCODE.TEXCOORD, 0), dst(REGISTER.TEXTURE, 1),
        op(OPCODE.MUL, 0), dst(REGISTER.TEMP, 0), src(REGISTER.TEXTURE, 0),
        src(REGISTER.TEXTURE, 1),
        END_TOKEN]));
    assert.equal(legacy.error, null);
    assertLine(legacy.wgsl, 't0 = textureSample(tex0, samp0, in.t0.xy);');
    assertLine(legacy.wgsl, 't1 = in.t1;');
    assertLine(legacy.wgsl, 'r0 = (t0 * t1);');
    assertLine(legacy.wgsl, 'oC0 = r0;');
    assertLine(legacy.wgsl, 'out.oC0 = oC0;');
    assert.deepEqual(legacy.samplers, [{ index: 0, type: 'texture_2d<f32>' }]);

    // Once filled, a 1.x texture register is written like a temporary: the
    // write goes to the local, never to the stage's immutable input.
    const rewritten = translateShader(parseShader([PS_1_1,
        op(OPCODE.TEX, 0), dst(REGISTER.TEXTURE, 1),
        op(OPCODE.MUL, 0), dst(REGISTER.TEXTURE, 2), src(REGISTER.TEXTURE, 1),
        src(REGISTER.INPUT, 0),
        op(OPCODE.MOV, 0), dst(REGISTER.TEMP, 0), src(REGISTER.TEXTURE, 2),
        END_TOKEN]));
    assert.equal(rewritten.error, null);
    assertLine(rewritten.wgsl, 't2 = (t1 * in.v0);');
    assert.ok(!rewritten.wgsl.includes('in.t2 ='), 'the input is never assigned');
    assertLine(rewritten.wgsl, 'var t2: vec4f = vec4f(0.0);');

    const bumped = translateShader(parseShader([PS_1_1,
        op(OPCODE.TEXBEM, 0), dst(REGISTER.TEXTURE, 1), src(REGISTER.TEXTURE, 0),
        END_TOKEN]));
    assert.match(bumped.error ?? '', /texbem is not translated/);
});

test('what is not translated is reported rather than emitted wrong', ()=>{
    const predicated = vertexBody([
        (op(OPCODE.MOV, 3) | (1 << 28)) >>> 0, src(REGISTER.PREDICATE, 0), dst(REGISTER.TEMP, 0),
        src(REGISTER.CONST, 0),
    ]);
    assert.match(predicated.error ?? '', /predicated/);
    const called = vertexBody([op(OPCODE.CALL, 1), src(REGISTER.LABEL, 3)]);
    assert.match(called.error ?? '', /subroutines/);
    const setp = vertexBody([op(OPCODE.SETP, 3, 1), dst(REGISTER.PREDICATE, 0),
        src(REGISTER.CONST, 0), src(REGISTER.CONST, 1)]);
    assert.match(setp.error ?? '', /predicated/);
});

test('a declared input takes the shape the declaration gives, and a missing one the default', ()=>{
    const parsed = parseShader([VS_2_0,
        ...dclInput(D3DDECLUSAGE.POSITION, 0),
        ...dclInput(D3DDECLUSAGE.COLOR, 1),
        ...dclInput(D3DDECLUSAGE.BLENDINDICES, 2),
        ...dclInput(D3DDECLUSAGE.TEXCOORD, 3),
        ...dclInput(D3DDECLUSAGE.NORMAL, 4),
        op(OPCODE.MOV, 2), dst(REGISTER.RASTOUT, 0), src(REGISTER.INPUT, 0),
        op(OPCODE.ADD, 3), dst(REGISTER.ATTROUT, 0), src(REGISTER.INPUT, 1), src(REGISTER.INPUT, 2),
        op(OPCODE.ADD, 3), dst(REGISTER.OUTPUT, 0), src(REGISTER.INPUT, 3), src(REGISTER.INPUT, 4),
        END_TOKEN]);
    const translated = translateShader(parsed, { inputs: new Map([
        [0, { components: 3, scalar: 'f32', bgra: false }],
        [1, { components: 4, scalar: 'f32', bgra: true }],
        [2, { components: 4, scalar: 'u32', bgra: false }],
        [3, { components: 2, scalar: 'f32', bgra: false }],
    ]) });
    assert.equal(translated.error, null);
    assertLine(translated.wgsl, '@location(0) v0: vec3<f32>,');
    assertLine(translated.wgsl, 'let v0 = vec4f(in.v0, 1.0);');
    assertLine(translated.wgsl, '@location(1) v1: vec4<f32>,');
    assertLine(translated.wgsl, 'let v1 = in.v1.zyxw;');
    assertLine(translated.wgsl, '@location(2) v2: vec4<u32>,');
    assertLine(translated.wgsl, 'let v2 = vec4f(in.v2);');
    assertLine(translated.wgsl, '@location(3) v3: vec2<f32>,');
    assertLine(translated.wgsl, 'let v3 = vec4f(in.v3, 0.0, 1.0);');
    // The normal is declared and not supplied: the default vertex, and no
    // input field for the pipeline to bind.
    assertLine(translated.wgsl, 'let v4 = vec4f(0.0, 0.0, 0.0, 1.0);');
    assert.ok(!translated.wgsl.includes('@location(4)'));
});

test('a relatively addressed constant file is declared whole', ()=>{
    const translated = vertexBody([
        op(OPCODE.MOV, 3), dst(REGISTER.TEMP, 0), (src(REGISTER.CONST, 4) | RELATIVE) >>> 0,
        src(REGISTER.ADDR, 0, 0x00),
    ]);
    // The whole file, and past it the register the viewport's scale rides in.
    assert.equal(translated.constants, 257);
    assert.equal(translated.viewportRegister, 256);
    assertLine(translated.wgsl, '@group(0) @binding(0) var<uniform> c: array<vec4f, 257>;');
});

test('a vertex stage\'s position is invariant, shader-written or fixed', ()=>{
    // Multipass over one mesh through two pipelines -- the same vertex shader
    // under two pixel shaders, or a hybrid's fixed stage under two -- is
    // compiled twice, and only @invariant makes WGSL promise the two the same
    // position from the same computation.
    const translated = vertexBody([]);
    assertLine(translated.wgsl, '@builtin(position) @invariant oPos: vec4f,');
    const fixed = fixedVertexStage([
        { usage: D3DDECLUSAGE.POSITION, usageIndex: 0, register: 0 },
    ], new Map([[0, { components: 3, scalar: 'f32', bgra: false }]]));
    assertLine(fixed.wgsl, '@builtin(position) @invariant oPos: vec4f,');
});

test('flat shading makes the two colour varyings flat on both sides, and nothing else', ()=>{
    // D3DSHADE_FLAT holds for shader-drawn geometry too (Wine's d3d9
    // test_shademode, vs_1_1 to vs_3_0 with and without a pixel shader), and
    // WebGPU requires the two stages to agree on a varying's interpolation.
    const vertex = translateShader(parseShader([VS_2_0, ...dclInput(0, 0),
        op(OPCODE.MOV, 2), dst(REGISTER.ATTROUT, 0), src(REGISTER.INPUT, 0),
        op(OPCODE.MOV, 2), dst(REGISTER.OUTPUT, 0), src(REGISTER.INPUT, 0),
        op(OPCODE.MOV, 2), dst(REGISTER.RASTOUT, 0), src(REGISTER.INPUT, 0), END_TOKEN]),
    { flatColours: true, alsoWrite: [1] });
    assertLine(vertex.wgsl, '@location(0) @interpolate(flat) oD0: vec4f,');
    assertLine(vertex.wgsl, '@location(1) @interpolate(flat) oX1: vec4f,');
    assertLine(vertex.wgsl, `@location(${varyingLocation(D3DDECLUSAGE.TEXCOORD, 0)}) oT0: vec4f,`);
    const pixel = translateShader(parseShader([PS_2_0,
        ...dclInput(0, 0),
        op(OPCODE.MOV, 2), dst(REGISTER.COLOROUT, 0), src(REGISTER.INPUT, 0), END_TOKEN]),
    { flatColours: true });
    assertLine(pixel.wgsl, '@location(0) @interpolate(flat) v0: vec4f,');
    const hybrid = fixedVertexStage([
        { usage: D3DDECLUSAGE.POSITION, usageIndex: 0, register: 0 },
        { usage: D3DDECLUSAGE.COLOR, usageIndex: 0, register: 1 },
    ], new Map([[0, { components: 3, scalar: 'f32', bgra: false }],
        [1, { components: 4, scalar: 'f32', bgra: true }]]), [1], [], 0, undefined,
    { flatColours: true });
    assertLine(hybrid.wgsl, '@location(0) @interpolate(flat) o0: vec4f,');
    assertLine(hybrid.wgsl, '@location(1) @interpolate(flat) o1: vec4f,');
    assert.ok(!translateShader(parseShader([PS_2_0, ...dclInput(0, 0),
        op(OPCODE.MOV, 2), dst(REGISTER.COLOROUT, 0), src(REGISTER.INPUT, 0), END_TOKEN]))
        .wgsl.includes('interpolate'), 'Gouraud declares nothing');
});

test('a vertex shader\'s position lands on the centre of the pixel it names', ()=>{
    // Direct3D 9 and before put a pixel's centre on its integer coordinate
    // and WebGPU half a pixel further on, so what the shader wrote to oPos is
    // moved by half a pixel -- half the viewport's scale, times w -- carried
    // in the register past the ones the shader reads.
    const translated = vertexBody([
        op(OPCODE.MOV, 2), dst(REGISTER.RASTOUT, 0), src(REGISTER.CONST, 2),
    ]);
    assert.equal(translated.error, null);
    assert.equal(translated.viewportRegister, 3);
    assert.equal(translated.constants, 4);
    const lines = translated.wgsl.split('\n').map(line=>line.trim());
    const fixup = lines.indexOf(
        'out.oPos = vec4f(out.oPos.xy + out.oPos.w * c[3].xy * 0.5, out.oPos.zw);');
    assert.ok(fixup > lines.findIndex(line=>line.startsWith('out.oPos = c[2]')),
        translated.wgsl);
    assert.equal(lines[fixup + 1], 'return out;');
    // A pixel shader has no position to move and no such register.
    assert.equal(translateShader(parseShader([PS_2_0, END_TOKEN])).viewportRegister, undefined);
});

test('the fixed vertex stage of a hybrid transforms through c0..c3 and passes the varyings', ()=>{
    const stage = fixedVertexStage([
        { usage: D3DDECLUSAGE.POSITION, usageIndex: 0, register: 0 },
        { usage: D3DDECLUSAGE.COLOR, usageIndex: 0, register: 1 },
        { usage: D3DDECLUSAGE.TEXCOORD, usageIndex: 1, register: 2 },
    ], new Map([
        [0, { components: 3, scalar: 'f32', bgra: false }],
        [1, { components: 4, scalar: 'f32', bgra: true }],
        [2, { components: 2, scalar: 'f32', bgra: false }],
    ]));
    assert.equal(stage.error, null);
    assert.equal(stage.entry, 'vs_main');
    assert.equal(stage.constants, HYBRID_CONSTANTS.COUNT);
    assertLine(stage.wgsl, '@group(0) @binding(0) var<uniform> c: array<vec4f, 43>;');
    assertLine(stage.wgsl,
        'out.oPos = mat4x4f(c[0], c[1], c[2], c[3]) * vec4f(vec4f(in.v0, 1.0).xyz, 1.0);');
    assertLine(stage.wgsl, `out.o${varyingLocation(D3DDECLUSAGE.COLOR, 0)} = in.v1.zyxw;`);
    assertLine(stage.wgsl,
        `out.o${varyingLocation(D3DDECLUSAGE.TEXCOORD, 1)} = vec4f(in.v2, 0.0, 1.0);`);

    // A set the stage of its number generates from the vertex in camera
    // space is written from world-view (c5..c8) through the stage's
    // transform rows (c9.. two per stage), and the carried set of that
    // number is not what goes out.
    const generated = fixedVertexStage([
        { usage: D3DDECLUSAGE.POSITION, usageIndex: 0, register: 0 },
        { usage: D3DDECLUSAGE.NORMAL, usageIndex: 0, register: 1 },
        { usage: D3DDECLUSAGE.TEXCOORD, usageIndex: 0, register: 2 },
    ], new Map([
        [0, { components: 3, scalar: 'f32', bgra: false }],
        [1, { components: 3, scalar: 'f32', bgra: false }],
        [2, { components: 2, scalar: 'f32', bgra: false }],
    ]), [], [0x20000, 0x10000, 0, 0, 0x20000], 0, undefined, { normalizeNormals: true });
    assert.equal(generated.error, null);
    const t0 = varyingLocation(D3DDECLUSAGE.TEXCOORD, 0);
    const t1 = varyingLocation(D3DDECLUSAGE.TEXCOORD, 1);
    const t4 = varyingLocation(D3DDECLUSAGE.TEXCOORD, 4);
    assert.deepEqual(generated.outputs, [t0, t1, t4]);
    // A fifth set goes through the fifth stage's own rows: a terrain's
    // blend map is that far along the cascade, and a coordinate left raw
    // there moved with the camera.
    assertLine(generated.wgsl, `out.o${t4} = vec4f(dot(c[25], vec4f(cameraPosition, 1.0)),`
        + ' dot(c[26], vec4f(cameraPosition, 1.0)), dot(c[27], vec4f(cameraPosition, 1.0)),'
        + ' dot(c[28], vec4f(cameraPosition, 1.0)));');
    assertLine(generated.wgsl, 'let worldView = mat4x4f(c[5], c[6], c[7], c[8]);');
    assertLine(generated.wgsl,
        'let cameraPosition = (worldView * vec4f(vec4f(in.v0, 1.0).xyz, 1.0)).xyz;');
    assertLine(generated.wgsl,
        'let cameraNormal = normalize((worldView * vec4f(vec4f(in.v1, 1.0).xyz, 0.0)).xyz);');
    assertLine(generated.wgsl, `out.o${t0} = vec4f(dot(c[9], vec4f(cameraPosition, 1.0)),`
        + ' dot(c[10], vec4f(cameraPosition, 1.0)), dot(c[11], vec4f(cameraPosition, 1.0)),'
        + ' dot(c[12], vec4f(cameraPosition, 1.0)));');
    assertLine(generated.wgsl, `out.o${t1} = vec4f(dot(c[13], vec4f(cameraNormal, 1.0)),`
        + ' dot(c[14], vec4f(cameraNormal, 1.0)), dot(c[15], vec4f(cameraNormal, 1.0)),'
        + ' dot(c[16], vec4f(cameraNormal, 1.0)));');
    assert.ok(!generated.wgsl.includes(`out.o${t0} = vec4f(in.v2`), 'the carried set is not sent');

    // With D3DRS_NORMALIZENORMALS off -- its default -- the camera-space
    // normal keeps the length the transform gave it, as the fixed-function
    // stage's does.
    const unnormalized = fixedVertexStage([
        { usage: D3DDECLUSAGE.POSITION, usageIndex: 0, register: 0 },
        { usage: D3DDECLUSAGE.NORMAL, usageIndex: 0, register: 1 },
    ], new Map([
        [0, { components: 3, scalar: 'f32', bgra: false }],
        [1, { components: 3, scalar: 'f32', bgra: false }],
    ]), [], [0x10000]);
    assertLine(unnormalized.wgsl,
        'let cameraNormal = (worldView * vec4f(vec4f(in.v1, 1.0).xyz, 0.0)).xyz;');

    const transformed = fixedVertexStage([
        { usage: D3DDECLUSAGE.POSITIONT, usageIndex: 0, register: 0 },
    ], new Map([[0, { components: 4, scalar: 'f32', bgra: false }]]));
    assert.equal(transformed.error, null);
    assertLine(transformed.wgsl, 'out.oPos = viewportPosition(in.v0);');
    assertLine(transformed.wgsl, `let screen = (vertex.xy + c[${HYBRID_CONSTANTS.VIEWPORT}].xy)`
        + ` * c[${HYBRID_CONSTANTS.VIEWPORT}].zw;`);
    // Its RHW goes back in as the clip w, which is what the rasteriser
    // interpolates by; one of zero or less is taken as one.
    assertLine(transformed.wgsl, 'let clipW = select(1.0, 1.0 / vertex.w, vertex.w > 0.0);');
    assertLine(transformed.wgsl,
        'return vec4f(screen.x - 1.0, screen.y + 1.0, vertex.z, 1.0) * clipW;');
    // And, as every Direct3D position, half a pixel on to WebGPU's centres.
    assertLine(transformed.wgsl, `out.oPos = vec4f(out.oPos.xy + out.oPos.w`
        + ` * c[${HYBRID_CONSTANTS.VIEWPORT}].zw * 0.5, out.oPos.zw);`);
    assertLine(stage.wgsl, `out.oPos = vec4f(out.oPos.xy + out.oPos.w`
        + ` * c[${HYBRID_CONSTANTS.VIEWPORT}].zw * 0.5, out.oPos.zw);`);

    const none = fixedVertexStage([
        { usage: D3DDECLUSAGE.COLOR, usageIndex: 0, register: 0 },
    ], new Map());
    assert.match(none.error ?? '', /no position/);

    // Vertex fog: the stage computes the fixed function's factor over the
    // magnitude of the vertex's camera-space z -- not its clip w, which an
    // orthographic projection holds at one (Wine's d3d9 test_fog) -- and
    // carries it, with the fog colour, in the oFog varying a fogged pixel
    // shader reads.
    const fogged = fixedVertexStage([
        { usage: D3DDECLUSAGE.POSITION, usageIndex: 0, register: 0 },
    ], new Map([[0, { components: 3, scalar: 'f32', bgra: false }]]), [], [],
    D3DFOG.EXP2);
    assert.equal(fogged.error, null);
    const fogLocation = varyingLocation(D3DDECLUSAGE.FOG, 0);
    assert.ok(fogged.outputs.includes(fogLocation), 'the oFog varying is written');
    assertLine(fogged.wgsl, `@location(${fogLocation}) o${fogLocation}: vec4f,`);
    assertLine(fogged.wgsl, `out.o${fogLocation} = vec4f(fogFactorOf(abs((mat4x4f(c[5], c[6],`
        + ' c[7], c[8]) * vec4f(vec4f(in.v0, 1.0).xyz, 1.0)).z)),'
        + ` c[${HYBRID_CONSTANTS.FOG_COLOR}].rgb);`);
    assertLine(fogged.wgsl, `let scaled = c[${HYBRID_CONSTANTS.FOG}].z * dist;`);
    assert.ok(!fogged.wgsl.includes('fogFactorOf(out.oPos.w)'));
    // Range fog: the distance from the eye instead of the depth.
    const ranged = fixedVertexStage([
        { usage: D3DDECLUSAGE.POSITION, usageIndex: 0, register: 0 },
    ], new Map([[0, { components: 3, scalar: 'f32', bgra: false }]]), [], [],
    D3DFOG.LINEAR, FOG_SOURCE.VERTEX, { rangeFog: true });
    assertLine(ranged.wgsl, `out.o${fogLocation} = vec4f(fogFactorOf(length((mat4x4f(c[5],`
        + ' c[6], c[7], c[8]) * vec4f(vec4f(in.v0, 1.0).xyz, 1.0)).xyz)),'
        + ` c[${HYBRID_CONSTANTS.FOG_COLOR}].rgb);`);

    // With no mode set, or for a pre-transformed vertex, the factor is the
    // specular alpha the declaration carries, and no curve is declared.
    const specular = fixedVertexStage([
        { usage: D3DDECLUSAGE.POSITIONT, usageIndex: 0, register: 0 },
        { usage: D3DDECLUSAGE.COLOR, usageIndex: 1, register: 1 },
    ], new Map([
        [0, { components: 4, scalar: 'f32', bgra: false }],
        [1, { components: 4, scalar: 'f32', bgra: true }],
    ]), [], [], D3DFOG.LINEAR);
    assertLine(specular.wgsl, `out.o${fogLocation} = vec4f(in.v1.zyxw.w,`
        + ` c[${HYBRID_CONSTANTS.FOG_COLOR}].rgb);`);
    assert.ok(!specular.wgsl.includes('fogFactorOf'));

    // Table fog is the pixel's: the stage carries the colour, and the curve's
    // range with the affine flag beside it, flat, for the pixel shader.
    const table = fixedVertexStage([
        { usage: D3DDECLUSAGE.POSITION, usageIndex: 0, register: 0 },
    ], new Map([[0, { components: 3, scalar: 'f32', bgra: false }]]), [], [],
    D3DFOG.EXP, FOG_SOURCE.TABLE);
    assert.ok(table.outputs.includes(FOG_RANGE_LOCATION));
    assertLine(table.wgsl, `@location(${FOG_RANGE_LOCATION}) @interpolate(flat)`
        + ` o${FOG_RANGE_LOCATION}: vec4f,`);
    assertLine(table.wgsl, `out.o${FOG_RANGE_LOCATION} = c[${HYBRID_CONSTANTS.FOG}];`);
    assertLine(table.wgsl, `out.o${fogLocation} = vec4f(0.0,`
        + ` c[${HYBRID_CONSTANTS.FOG_COLOR}].rgb);`);
});

test('the fog stage after a pixel shader mixes the shaded colour by the varying', ()=>{
    const parsed = parseShader([PS_2_0,
        ...dclSampler(0),
        op(OPCODE.DCL, 2), 0x80000000, dst(REGISTER.TEXTURE, 2),
        op(OPCODE.TEX, 3), dst(REGISTER.TEMP, 0), src(REGISTER.TEXTURE, 2),
        src(REGISTER.SAMPLER, 0),
        op(OPCODE.MUL, 3), dst(REGISTER.COLOROUT, 0), src(REGISTER.TEMP, 0),
        src(REGISTER.TEMP, 0),
        END_TOKEN]);
    assert.equal(parsed.error, null);

    const fogged = translateShader(parsed, { fog: D3DFOG.LINEAR });
    assert.equal(fogged.error, null);
    assert.equal(fogged.entry, 'ps_main');
    // The amount the vertex stage computed and the fog colour beside it, in
    // the oFog varying: Direct3D applies its fog stage after the pixel shader,
    // so the mix is the shader's own colour towards that colour.
    const fogLocation = varyingLocation(D3DDECLUSAGE.FOG, 0);
    assertLine(fogged.wgsl, `@location(${fogLocation}) fog: vec4f,`);
    assertLine(fogged.wgsl, 'oC0 = vec4f(mix(in.fog.yzw, oC0.rgb,'
        + ' clamp(in.fog.x, 0.0, 1.0)), oC0.a);');
    assert.ok(fogged.reads.includes(fogLocation), 'and it is a varying it reads');

    // The mix comes after the shader's own last instruction and before the
    // colour is written out: fog on the shaded colour, which is where the
    // fixed function applies it.
    const lines = fogged.wgsl.split('\n').map(line=>line.trim());
    const written = lines.indexOf('oC0 = (r0 * r0);');
    const mixed = lines.indexOf('oC0 = vec4f(mix(in.fog.yzw, oC0.rgb,'
        + ' clamp(in.fog.x, 0.0, 1.0)), oC0.a);');
    const out = lines.indexOf('out.oC0 = oC0;');
    assert.ok(written >= 0 && mixed > written, 'the mix is after the shader');
    assert.ok(out > mixed, 'and before the colour is written out');

    // A surface that is not fogged carries none of it.
    const plain = translateShader(parsed);
    assert.ok(!plain.wgsl.includes('fog: vec4f'), 'no fog varying');
    assert.ok(!plain.wgsl.includes('in.fog'), 'and no mix');

    // Fog enabled with no mode set is the specular alpha the vertex stage
    // carried in the same varying, so the mix is the same one.
    const specular = translateShader(parsed, { fog: 0, fogSource: FOG_SOURCE.SPECULAR });
    assertLine(specular.wgsl, 'oC0 = vec4f(mix(in.fog.yzw, oC0.rgb,'
        + ' clamp(in.fog.x, 0.0, 1.0)), oC0.a);');

    // Table fog is evaluated here, per pixel, over the pixel's z under an
    // affine projection and its w otherwise, with the range the vertex stage
    // carried flat.
    const table = translateShader(parsed, { fog: D3DFOG.EXP, fogSource: FOG_SOURCE.TABLE });
    assert.equal(table.error, null);
    assert.ok(table.reads.includes(FOG_RANGE_LOCATION));
    assertLine(table.wgsl, `@location(${FOG_RANGE_LOCATION}) @interpolate(flat)`
        + ' fogRange: vec4f,');
    assertLine(table.wgsl, 'var<private> fogRange: vec4f;');
    assertLine(table.wgsl, 'return clamp(exp(-fogRange.z * dist), 0.0, 1.0);');
    assertLine(table.wgsl, 'fogRange = in.fogRange;');
    assertLine(table.wgsl, 'oC0 = vec4f(mix(in.fog.yzw, oC0.rgb, clamp(fogFactorOf('
        + 'select(1.0 / in.vPos.w, in.vPos.z, fogRange.w != 0.0)), 0.0, 1.0)), oC0.a);');
});
