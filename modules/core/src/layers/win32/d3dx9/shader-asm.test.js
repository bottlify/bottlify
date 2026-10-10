/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleShader, disassembleShader } from './shader-asm.js';
import { assemble as referenceAssemble, disassemble as referenceDisassemble }
    from './d3d9-machine.fixture.js';

/**
 * Assembles text that must be valid.
 * @param {string} text
 * @returns {number[]}
 */
function words(text){
    const { tokens, errors } = assembleShader(text);
    assert.deepEqual(errors, [], `assembling:\n${text}`);
    assert.ok(tokens);
    return [...tokens];
}

/** @param {number[]} list */
function hex(list){
    return list.map(w=>`0x${(w >>> 0).toString(16).padStart(8, '0')}`).join(' ');
}

/**
 * @param {string} text
 * @param {number[]} expected
 */
function expectTokens(text, expected){
    assert.equal(hex(words(text)), hex(expected), text);
}

/**
 * The messages and lines of what the assembler rejects.
 * @param {string} text
 */
function errorsOf(text){
    const { tokens, errors } = assembleShader(text);
    assert.equal(tokens, null);
    assert.ok(errors.length > 0);
    return errors;
}

/* ------------------------------------------------- hand-computed token layouts */

test('the version tokens', ()=>{
    /** @type {[string, number][]} */
    const versions = [
        ['vs_1_0', 0xfffe0100], ['vs_1_1', 0xfffe0101], ['vs_2_0', 0xfffe0200],
        ['vs_2_x', 0xfffe0201], ['vs_2_sw', 0xfffe02ff], ['vs_3_0', 0xfffe0300],
        ['vs_3_sw', 0xfffe03ff], ['ps_1_0', 0xffff0100], ['ps_1_1', 0xffff0101],
        ['ps_1_2', 0xffff0102], ['ps_1_3', 0xffff0103], ['ps_1_4', 0xffff0104],
        ['ps_2_0', 0xffff0200], ['ps_2_x', 0xffff0201], ['ps_2_sw', 0xffff02ff],
        ['ps_3_0', 0xffff0300], ['ps_3_sw', 0xffff03ff],
    ];
    for (const [name, token] of versions)
    {
        // D3DX writes a 1_0 source as 1_1; the listing of a 1_0 stream still names 1_0.
        const written = token === 0xfffe0100 || token === 0xffff0100 ? token + 1 : token;
        expectTokens(`${name}\nnop`, [written, 0, 0xffff]);
        expectTokens(`${name.toUpperCase()}\n`, [written, 0xffff]);
    }
    expectTokens('vs.1.1\nnop', [0xfffe0101, 0, 0xffff]);
});

test('vs_1_1: every register class, with no length in the instruction token', ()=>{
    expectTokens([
        'vs_1_1',
        'dcl_position v0',
        'dcl_texcoord2 v5',
        'def c4, 1, 2, 3, 4',
        'mov r2, v5',
        'mov a0.x, r2.x',
        'mov oPos, c[a0.x + 4]',
        'mov oD1.xy, c4.wzyx',
        'mov oT3, -c4',
        'mov oFog, c5.x',
        'mov oPts, c6.y',
    ].join('\n'), [
        0xfffe0101,
        0x1f, 0x80000000, 0x900f0000,
        0x1f, 0x80020005, 0x900f0005,
        0x51, 0xa00f0004, 0x3f800000, 0x40000000, 0x40400000, 0x40800000,
        0x01, 0x800f0002, 0x90e40005,
        0x01, 0xb0010000, 0x80000002,
        0x01, 0xc00f0000, 0xa0e42004,
        0x01, 0xd0030001, 0xa01b0004,
        0x01, 0xe00f0003, 0xa1e40004,
        0x01, 0xc00f0001, 0xa0000005,
        0x01, 0xc00f0002, 0xa0550006,
        0xffff,
    ]);
});

test('vs_2_0: lengths, i# and b# and their defs, mova, relative addressing, loops, if', ()=>{
    expectTokens([
        'vs_2_0',
        'dcl_position v0',
        'defi i1, 3, 0, 1, 0',
        'defb b2, true',
        'def c3, 0.5, -0.5, 1.5, 2',
        'mova a0.x, v0.x',
        'mov r1.xy, c[a0.x+3].wzyx',
        'loop aL, i1',
        'add r0, r0, c[aL+1]',
        'endloop',
        'if b2',
        'rcp r0.w, c3.z',
        'endif',
        'mov oPos, r0',
    ].join('\n'), [
        0xfffe0200,
        0x0200001f, 0x80000000, 0x900f0000,
        0x05000030, 0xf00f0001, 3, 0, 1, 0,
        0x0200002f, 0xe00f0802, 1,
        0x05000051, 0xa00f0003, 0x3f000000, 0xbf000000, 0x3fc00000, 0x40000000,
        0x0200002e, 0xb0010000, 0x90000000,
        0x03000001, 0x80030001, 0xa01b2003, 0xb0000000,
        0x0200001b, 0xf0e40800, 0xf0e40001,
        0x04000002, 0x800f0000, 0x80e40000, 0xa0e42001, 0xf0e40800,
        0x0000001d,
        0x01000028, 0xe0e40802,
        0x02000006, 0x80080000, 0xa0aa0003,
        0x0000002b,
        0x02000001, 0xc00f0000, 0x80e40000,
        0xffff,
    ]);
});

test('vs_2_0: the address register has four components, each addressing on its own', ()=>{
    // fxc writes a whole vector into it and reads c[a0.y]: the relative token's swizzle
    // replicates the component. vs_1_1's address register is a0.x alone.
    expectTokens([
        'vs_2_0',
        'dcl_position v0',
        'mova a0, v0.yxzw',
        'mov oPos, c[a0.y+2]',
    ].join('\n'), [
        0xfffe0200,
        0x0200001f, 0x80000000, 0x900f0000,
        0x0200002e, 0xb00f0000, 0x90e10000,
        0x03000001, 0xc00f0000, 0xa0e42002, 0xb0550000,
        0xffff,
    ]);
    assert.match(disassembleShader(words('vs_2_0\nmova a0.w, c0\nmov oPos, c[a0.w + 1]\n')),
        /mov oPos, c1\[a0\.w\]/);
    assert.match(errorsOf('vs_1_1\nmov a0.y, c0\nmov oPos, c0\n')[0].message,
        /address register is written as a0.x in vs_1_1/);
    assert.match(errorsOf('vs_1_1\nmov a0.x, c0\nmov oPos, c[a0.y]\n')[0].message,
        /vs_1_1 addresses relatively through a0.x only/);
});

test('ps_3_0: dcl forms, half precision, centroid, saturation, abs, oC and oDepth', ()=>{
    expectTokens([
        'ps_3_0',
        'dcl_texcoord0_pp v0.xy',
        'dcl_color1_centroid v1',
        'dcl_2d s0',
        'dcl_cube s1',
        'dcl_volume s2',
        'dcl vPos.xy',
        'dcl vFace',
        'texld_pp r0, v0, s0',
        'texldl r1, r0, s1',
        'mul_sat r2, r0, -r1_abs',
        'mov oC1, r2',
        'mov oDepth, r2.x',
    ].join('\n'), [
        0xffff0300,
        0x0200001f, 0x80000005, 0x90230000,
        0x0200001f, 0x8001000a, 0x904f0001,
        0x0200001f, 0x90000000, 0xa00f0800,
        0x0200001f, 0x98000000, 0xa00f0801,
        0x0200001f, 0xa0000000, 0xa00f0802,
        0x0200001f, 0x80000000, 0x90031000,
        0x0200001f, 0x80000000, 0x900f1001,
        0x03000042, 0x802f0000, 0x90e40000, 0xa0e40800,
        0x0300005f, 0x800f0001, 0x80e40000, 0xa0e40801,
        0x03000005, 0x801f0002, 0x80e40000, 0x8ce40001,
        0x02000001, 0x800f0801, 0x80e40002,
        0x02000001, 0x900f0800, 0x80000002,
        0xffff,
    ]);
});

test('ps_2_0: sampler dcl, the texld family, dp2add, cmp, sincos with its scratch registers', ()=>{
    expectTokens([
        'ps_2_0',
        'dcl t0',
        'dcl v1',
        'dcl_2d s0',
        'texld r0, t0, s0',
        'texldp r1, t0, s0',
        'texldb r2, t0, s0',
        'texkill r1',
        'dp2add r0.x, r0, r1, r2.z',
        'cmp r0, r0, r1, -r2',
        'sincos r3.xy, r0.x, c0, c1',
        'mad_pp r0, r0, r1, r2',
        'mov oC0, r0',
    ].join('\n'), [
        0xffff0200,
        0x0200001f, 0x80000000, 0xb00f0000,
        0x0200001f, 0x80000000, 0x900f0001,
        0x0200001f, 0x90000000, 0xa00f0800,
        0x03000042, 0x800f0000, 0xb0e40000, 0xa0e40800,
        0x03010042, 0x800f0001, 0xb0e40000, 0xa0e40800,
        0x03020042, 0x800f0002, 0xb0e40000, 0xa0e40800,
        0x01000041, 0x800f0001,
        0x0400005a, 0x80010000, 0x80e40000, 0x80e40001, 0x80aa0002,
        0x04000058, 0x800f0000, 0x80e40000, 0x80e40001, 0x81e40002,
        0x04000025, 0x80030003, 0x80000000, 0xa0e40000, 0xa0e40001,
        0x04000004, 0x802f0000, 0x80e40000, 0x80e40001, 0x80e40002,
        0x02000001, 0x800f0800, 0x80e40000,
        0xffff,
    ]);
});

test('vs_3_0 sincos takes one source and sgn takes one or three', ()=>{
    expectTokens('vs_3_0\nsincos r0.xy, r1.x\nsgn r0, r1, r2, r3\nsgn r0, r1', [
        0xfffe0300,
        0x02000025, 0x80030000, 0x80000001,
        0x04000022, 0x800f0000, 0x80e40001, 0x80e40002, 0x80e40003,
        0x02000022, 0x800f0000, 0x80e40001,
        0xffff,
    ]);
    assert.equal(errorsOf('vs_3_0\nsincos r0.xy, r1.x, c0, c1')[0].line, 2);
    // vs_3_0 has four samplers, for texldl.
    expectTokens('vs_3_0\ndcl_2d s3\ntexldl r0, v0, s3', [
        0xfffe0300, 0x0200001f, 0x90000000, 0xa00f0803, 0x0300005f, 0x800f0000, 0x90e40000,
        0xa0e40803, 0xffff,
    ]);
    assert.equal(errorsOf('vs_2_0\nsincos r0.xy, r1.x')[0].line, 2);
});

test('predication: setp, the predicate token after the destination, breakp, (!p0.w)', ()=>{
    expectTokens([
        'vs_3_0',
        'setp_gt p0.xy, c0, c1',
        '(p0.x) add r0, r0, c0',
        '(!p0.w) mov r0, c0',
        '(p0) mul r1, r0, r0',
        'breakp p0.x',
        '(p0.z) break',
        'if p0.y',
        'endif',
    ].join('\n'), [
        0xfffe0300,
        0x0301005e, 0xb0031000, 0xa0e40000, 0xa0e40001,
        0x14000002, 0x800f0000, 0xb0001000, 0x80e40000, 0xa0e40000,
        0x13000001, 0x800f0000, 0xbdff1000, 0xa0e40000,
        0x14000005, 0x800f0001, 0xb0e41000, 0x80e40000, 0x80e40000,
        0x01000060, 0xb0001000,
        0x1100002c, 0xb0aa1000,
        0x01000028, 0xb0551000,
        0x0000002b,
        0xffff,
    ]);
    // Predication starts with shader model 2.x.
    assert.equal(errorsOf('vs_2_0\n(p0.x) mov r0, c0')[0].line, 2);
    assert.equal(errorsOf('ps_2_0\nsetp_lt p0, r0, r1')[0].line, 2);
    expectTokens('ps_2_x\n(!p0.x) mov r0, c0', [
        0xffff0201, 0x13000001, 0x800f0000, 0xbd001000, 0xa0e40000, 0xffff,
    ]);
});

test('flow control: comparisons, labels, calls, boolean tests', ()=>{
    const compare = ['gt', 'eq', 'ge', 'lt', 'ne', 'le'];
    const text = ['vs_3_0'];
    /** @type {number[]} */
    const want = [0xfffe0300];
    compare.forEach((cc, k)=>{
        text.push(`if_${cc} r0, c0`, `break_${cc} r1, r2`, `setp_${cc} p0, r0, r1`);
        want.push(
            0x02000029 | ((k + 1) << 16), 0x80e40000, 0xa0e40000,
            0x0200002d | ((k + 1) << 16), 0x80e40001, 0x80e40002,
            0x0300005e | ((k + 1) << 16), 0xb00f1000, 0x80e40000, 0x80e40001,
        );
    });
    text.push(
        'call l3', 'callnz l1, b0', 'label l3', 'ret', 'if !b1', 'else', 'endif', 'break',
        'rep i2', 'endrep', 'loop aL, i3', 'endloop', 'callnz l2, !p0.x',
    );
    want.push(
        0x01000019, 0xa0e41003,
        0x0200001a, 0xa0e41001, 0xe0e40800,
        0x0100001e, 0xa0e41003,
        0x0000001c,
        0x01000028, 0xede40801,
        0x0000002a,
        0x0000002b,
        0x0000002c,
        0x01000026, 0xf0e40002,
        0x00000027,
        0x0200001b, 0xf0e40800, 0xf0e40003,
        0x0000001d,
        0x0200001a, 0xa0e41002, 0xbd001000,
        0xffff,
    );
    expectTokens(text.join('\n'), want);
});

test('ps_1_x texture-addressing instructions', ()=>{
    expectTokens([
        'ps_1_3',
        'tex t0', 'texcoord t1', 'texkill t2',
        'texbem t1, t0', 'texbeml t1, t0', 'texreg2ar t1, t0', 'texreg2gb t1, t0',
        'texm3x2pad t1, t0', 'texm3x2tex t2, t0', 'texm3x3pad t1, t0', 'texm3x3tex t3, t0',
        'texm3x3spec t3, t0, c0', 'texm3x3vspec t3, t0', 'texreg2rgb t1, t0',
        'texdp3tex t1, t0', 'texm3x2depth t2, t0', 'texdp3 t1, t0', 'texm3x3 t2, t0',
        'cnd r0, r0.a, v0, c0', 'cmp r0, r0, v0, c0',
    ].join('\n'), [
        0xffff0103,
        0x42, 0xb00f0000, 0x40, 0xb00f0001, 0x41, 0xb00f0002,
        0x43, 0xb00f0001, 0xb0e40000, 0x44, 0xb00f0001, 0xb0e40000,
        0x45, 0xb00f0001, 0xb0e40000, 0x46, 0xb00f0001, 0xb0e40000,
        0x47, 0xb00f0001, 0xb0e40000, 0x48, 0xb00f0002, 0xb0e40000,
        0x49, 0xb00f0001, 0xb0e40000, 0x4a, 0xb00f0003, 0xb0e40000,
        0x4c, 0xb00f0003, 0xb0e40000, 0xa0e40000, 0x4d, 0xb00f0003, 0xb0e40000,
        0x52, 0xb00f0001, 0xb0e40000, 0x53, 0xb00f0001, 0xb0e40000,
        0x54, 0xb00f0002, 0xb0e40000, 0x55, 0xb00f0001, 0xb0e40000,
        0x56, 0xb00f0002, 0xb0e40000,
        0x50, 0x800f0000, 0x80ff0000, 0x90e40000, 0xa0e40000,
        0x58, 0x800f0000, 0x80e40000, 0x90e40000, 0xa0e40000,
        0xffff,
    ]);
    // texm3x2depth is ps_1_3 only; texreg2rgb starts at ps_1_2.
    assert.equal(errorsOf('ps_1_2\ntexm3x2depth t2, t0')[0].line, 2);
    assert.equal(errorsOf('ps_1_1\ntexreg2rgb t1, t0')[0].line, 2);
});

test('ps_1_4: texld and texcrd, phase, co-issue, bem, texdepth, _dz and _dw', ()=>{
    expectTokens([
        'ps_1_4',
        'texcrd r1.rgb, t1',
        'texcrd r2, t2_dz.xyz',
        'texld r0, t0',
        'texld r3, t1_dw.xyw',
        'mul r0.rgb, r0, r1',
        '+mov r0.a, r0.a',
        '+ add r5.a, r0.a, c0.a',
        'bem r1.rg, r2, r3',
        'phase',
        'texld r2, r0',
        'texkill t4',
        'texdepth r5',
        'mov_sat r0, r2',
    ].join('\n'), [
        0xffff0104,
        0x40, 0x80070001, 0xb0e40001,
        0x40, 0x80070002, 0xb9a40002,
        0x42, 0x800f0000, 0xb0e40000,
        0x42, 0x800f0003, 0xbaf40001,
        0x05, 0x80070000, 0x80e40000, 0x80e40001,
        0x40000001, 0x80080000, 0x80ff0000,
        0x40000002, 0x80080005, 0x80ff0000, 0xa0ff0000,
        0x59, 0x80030001, 0x80e40002, 0x80e40003,
        0xfffd,
        0x42, 0x800f0002, 0x80e40000,
        0x41, 0xb00f0004,
        0x57, 0x800f0005,
        0x01, 0x801f0000, 0x80e40002,
        0xffff,
    ]);
    assert.equal(errorsOf('ps_1_3\nphase')[0].line, 2);
    assert.equal(errorsOf('ps_1_3\nmov r0, r1\n+mov r0.a, r1.a\nphase')[0].line, 4);
});

test('ps_1_x source modifiers and result shifts', ()=>{
    /** @type {[string, number][]} */
    const sources = [
        ['-r1', 0x81], ['r1_bias', 0x82], ['-r1_bias', 0x83], ['r1_bx2', 0x84],
        ['-r1_bx2', 0x85], ['1-r1', 0x86], ['r1_x2', 0x87], ['-r1_x2', 0x88],
        ['r1_dz', 0x89], ['r1_dw', 0x8a],
    ];
    expectTokens(['ps_1_4', ...sources.map(([s])=>`mov r0, ${s}`)].join('\n'), [
        0xffff0104, ...sources.flatMap(([, m])=>[1, 0x800f0000, (m << 24) | 0xe40001]), 0xffff,
    ]);
    /** @type {[string, number][]} */
    const shifts = [['x2', 1], ['x4', 2], ['x8', 3], ['d8', 13], ['d4', 14], ['d2', 15]];
    expectTokens(['ps_1_4', ...shifts.map(([s])=>`mul_${s} r0, r1, r2`)].join('\n'), [
        0xffff0104, ...shifts.flatMap(([, f])=>[5, 0x800f0000 | (f << 24), 0x80e40001, 0x80e40002]),
        0xffff,
    ]);
    expectTokens('ps_1_4\nmul_x2_sat r0, r1, r2\nmul_sat_x2 r0, r1, r2', [
        0xffff0104, 5, 0x811f0000, 0x80e40001, 0x80e40002, 5, 0x811f0000, 0x80e40001, 0x80e40002,
        0xffff,
    ]);
    // x8, d4, d8 and the x2 source are ps_1_4 only.
    assert.equal(errorsOf('ps_1_3\nmul_x8 r0, r1, r2')[0].line, 2);
    assert.equal(errorsOf('ps_1_3\nmov r0, r1_x2')[0].line, 2);
    assert.equal(errorsOf('ps_1_3\nmov r0, r1_abs')[0].line, 2);
    assert.equal(errorsOf('ps_2_0\nmul_x2 r0, r1, r2')[0].line, 2);
});

test('source and destination modifiers of the later models', ()=>{
    expectTokens([
        'ps_3_0',
        'mov r0, |r1|', 'mov r0, -|r1|', 'mov r0, r1_abs', 'mov r0, -r1_abs', 'mov r0, -r1',
        'mov_sat r0, r1', 'mov_pp r0, r1', 'mov_sat_pp r0, r1', 'mov_pp_centroid r0, r1',
    ].join('\n'), [
        0xffff0300,
        0x02000001, 0x800f0000, 0x8be40001, 0x02000001, 0x800f0000, 0x8ce40001,
        0x02000001, 0x800f0000, 0x8be40001, 0x02000001, 0x800f0000, 0x8ce40001,
        0x02000001, 0x800f0000, 0x81e40001, 0x02000001, 0x801f0000, 0x80e40001,
        0x02000001, 0x802f0000, 0x80e40001, 0x02000001, 0x803f0000, 0x80e40001,
        0x02000001, 0x806f0000, 0x80e40001,
        0xffff,
    ]);
    assert.equal(errorsOf('vs_1_1\nmov_sat r0, v0')[0].line, 2);
    assert.equal(errorsOf('vs_1_1\nmov r0, |v0|')[0].line, 2);
    assert.equal(errorsOf('ps_2_0\nmov r0, |r1|')[0].line, 2);
    assert.equal(errorsOf('ps_3_0\nmov r0, !r1')[0].line, 2);
});

test('rgba and xyzw spell the same masks and swizzles', ()=>{
    const a = words('ps_1_4\nmov r0.rgb, r1.bgra\nmov r0.a, r1.a\nmov r0.gb, c0.rrgg');
    const b = words('ps_1_4\nmov r0.xyz, r1.zyxw\nmov r0.w, r1.w\nmov r0.yz, c0.xxyy');
    assert.equal(hex(a), hex(b));
    expectTokens('ps_1_4\nmov r0.rgb, r1.bgra', [0xffff0104, 1, 0x80070000, 0x80c60001, 0xffff]);
    assert.equal(hex(words('vs_2_0\nmov r0.rgba, v0.abgr')),
        hex(words('vs_2_0\nmov r0.xyzw, v0.wzyx')));
    // Fewer swizzle letters repeat the last one.
    expectTokens('vs_1_1\nmov r0, v0.x\nmov r1, v0.xy\nmov r2, v0.xyz', [
        0xfffe0101, 1, 0x800f0000, 0x90000000, 1, 0x800f0001, 0x90540000, 1, 0x800f0002,
        0x90a40000, 0xffff,
    ]);
    assert.ok(errorsOf('vs_1_1\nmov r0.xg, v0')[0].message.includes('write mask'));
    assert.ok(errorsOf('vs_1_1\nmov r0.zx, v0')[0].message.includes('order'));
    assert.ok(errorsOf('vs_1_1\nmov r0, v0.xyzwx')[0].message.includes('swizzle'));
});

test('def, defi and defb literals', ()=>{
    expectTokens([
        'ps_2_x',
        'def c0, 0x3f800000, 1e2, -.5, 2.',
        'def c1, 1.5f, +3, 0, -0.0',
        'defi i0, -1, 0x10, 255, 7',
        'defb b3, false',
        'defb b4, True',
        'defb b5, 1',
        'def c2, 3.4028235e38, 1e-45, 16777217, 0.1',
    ].join('\n'), [
        0xffff0201,
        0x05000051, 0xa00f0000, 0x3f800000, 0x42c80000, 0xbf000000, 0x40000000,
        0x05000051, 0xa00f0001, 0x3fc00000, 0x40400000, 0, 0x80000000,
        0x05000030, 0xf00f0000, 0xffffffff, 0x10, 0xff, 7,
        0x0200002f, 0xe00f0803, 0,
        0x0200002f, 0xe00f0804, 1,
        0x0200002f, 0xe00f0805, 1,
        0x05000051, 0xa00f0002, 0x7f7fffff, 0x00000001, 0x4b800000, 0x3dcccccd,
        0xffff,
    ]);
    assert.ok(errorsOf('vs_2_0\ndef c0, 1, 2, three, 4')[0].message.includes('three'));
    assert.ok(errorsOf('vs_2_0\ndef c0, 1, 2, 3')[0].message.includes('def'));
    assert.ok(errorsOf('vs_2_0\ndefi i0, 1, 2, 3, 4294967296')[0].message.includes('32 bits'));
    assert.equal(errorsOf('vs_1_1\ndefi i0, 1, 2, 3, 4')[0].line, 2);
});

test('constants beyond c2047 use the three further register types', ()=>{
    expectTokens([
        'vs_2_sw',
        'mov r0, c2048', 'mov r0, c2049.x', 'mov r0, c4096', 'mov r0, c6144', 'mov r0, c8191',
        'def c3000, 1, 2, 3, 4',
    ].join('\n'), [
        0xfffe02ff,
        0x02000001, 0x800f0000, 0xb0e40800, 0x02000001, 0x800f0000, 0xb0000801,
        0x02000001, 0x800f0000, 0xc0e40800, 0x02000001, 0x800f0000, 0xd0e40800,
        0x02000001, 0x800f0000, 0xd0e40fff,
        0x05000051, 0xb00f0bb8, 0x3f800000, 0x40000000, 0x40400000, 0x40800000,
        0xffff,
    ]);
    assert.equal(errorsOf('vs_2_0\nmov r0, c256')[0].line, 2);
    assert.equal(errorsOf('vs_2_sw\nmov r0, c8192')[0].line, 2);
});

test('vs_3_0 relative addressing of inputs and outputs, and aL as a source', ()=>{
    expectTokens([
        'vs_3_0',
        'dcl_position v0',
        'dcl_position o0',
        'loop aL, i0',
        'mov r0, v[aL + 1]',
        'mov o[a0.x + 2], r0',
        'mov r1, c[a0.x]',
        'mov r2, aL',
        'endloop',
    ].join('\n'), [
        0xfffe0300,
        0x0200001f, 0x80000000, 0x900f0000,
        0x0200001f, 0x80000000, 0xe00f0000,
        0x0200001b, 0xf0e40800, 0xf0e40000,
        0x03000001, 0x800f0000, 0x90e42001, 0xf0e40800,
        0x03000001, 0xe00f2002, 0xb0000000, 0x80e40000,
        0x03000001, 0x800f0001, 0xa0e42000, 0xb0000000,
        0x02000001, 0x800f0002, 0xf0e40800,
        0x0000001d,
        0xffff,
    ]);
    // The base register is written before the bracket or inside it, not both.
    assert.ok(errorsOf('vs_2_0\nmov r0, c3[a0.x + 2]')[0].message.includes('before the bracket'));
    expectTokens('vs_2_0\nmov r0, c3[a0.x]', [0xfffe0200, 0x03000001, 0x800f0000, 0xa0e42003,
        0xb0000000, 0xffff]);
    // vs_1_1 has no relative-address token: a0.x is implied.
    expectTokens('vs_1_1\nmov r0, c[a0.x + 3]', [0xfffe0101, 1, 0x800f0000, 0xa0e42003, 0xffff]);
    assert.equal(errorsOf('vs_1_1\nmov r0, c[aL + 3]')[0].line, 2);
    assert.equal(errorsOf('vs_2_0\nmov r0, v[a0.x]')[0].line, 2);
    assert.equal(errorsOf('ps_3_0\nmov r0, c[a0.x]')[0].line, 2);
    expectTokens('ps_3_0\nmov r0, c[aL + 2]', [0xffff0300, 0x03000001, 0x800f0000, 0xa0e42002,
        0xf0e40800, 0xffff]);
});

test('comments in all three spellings, and the line numbers errors report', ()=>{
    expectTokens([
        '; leading comment',
        '// another',
        'vs_1_1 ; trailing',
        '/* a block',
        '   spanning lines */ mov r0, v0 // and a tail',
        'mov /* inline */ r1, v1',
    ].join('\n'), [0xfffe0101, 1, 0x800f0000, 0x90e40000, 1, 0x800f0001, 0x90e40001, 0xffff]);
    const errors = errorsOf(['vs_1_1', '/* two', 'lines */', 'frob r0', '', 'mov r0'].join('\n'));
    assert.deepEqual(errors.map(e=>e.line), [4, 6]);
    expectTokens('vs_1_1\r\nmov r0, v0\r\n', [0xfffe0101, 1, 0x800f0000, 0x90e40000, 0xffff]);
});

test('sub in a vertex shader is add with the second source negated; a pixel shader keeps it', ()=>{
    expectTokens('vs_1_1\nsub r5, r5, r4\nsub r0, r1, -r2', [
        0xfffe0101, 2, 0x800f0005, 0x80e40005, 0x81e40004, 2, 0x800f0000, 0x80e40001,
        0x80e40002, 0xffff,
    ]);
    expectTokens('ps_1_1\nsub r0, r1, c2', [0xffff0101, 3, 0x800f0000, 0x80e40001, 0xa0e40002,
        0xffff]);
});

/* ---------------------------------------------------------------- the errors */

test('every offending line is one error, with its 1-based line', ()=>{
    assert.deepEqual(assembleShader(''), {
        tokens: null, errors: [{ line: 1, message: 'no shader version' }],
    });
    assert.equal(errorsOf('mov r0, v0')[0].line, 1);
    assert.equal(errorsOf('\n\n; c\nmov r0, v0')[0].line, 4);
    assert.equal(errorsOf('vs_1_1\nvs_1_1')[0].line, 2);
    const result = assembleShader([
        'vs_1_1', 'mov r0, v0', 'bogus r0', 'mov r1, v1', 'add r0, r1', 'mov r12, v0',
        'mov t0, v0', 'add r0, r0, c96', 'mov oPos, v0',
    ].join('\n'));
    assert.equal(result.tokens, null);
    assert.deepEqual(result.errors.map(e=>e.line), [3, 5, 6, 7, 8]);
    for (const e of result.errors)
    {
        assert.equal(typeof e.message, 'string');
        assert.ok(e.message.length > 0);
    }
});

test('what a version does not have is an error naming the line', ()=>{
    const cases = [
        'vs_1_1\nlrp r0, r1, r2, r3', 'vs_1_1\nmova a0.x, v0.x', 'vs_2_0\nbreakp p0.x',
        'vs_2_0\nbreak', 'vs_2_0\nif_lt r0, r1', 'vs_2_0\nsetp_lt p0, r0, r1',
        'vs_3_0\nmov r0, c0\ndcl_2d s0\ntexldd r0, r1, s0, r1, r1',
        'ps_2_0\ndcl_2d s0\ntexldl r0, r1, s0',
        'ps_2_0\nmova a0.x, r0.x', 'ps_2_0\nlit r0, r1', 'ps_3_0\nmova a0.x, v0.x',
        'ps_1_1\nrcp r0, r1', 'ps_1_1\ntexld r0, t0', 'ps_1_4\ntex t0', 'ps_1_4\ntexcoord t0',
        'ps_1_3\ntexcrd r0, t0', 'ps_2_0\ntex t0', 'ps_2_0\nif b0', 'ps_2_0\ncall l0',
        'ps_2_0\ndefi i0, 1, 2, 3, 4', 'ps_2_0\ndsx r0, r1',
        'vs_1_1\ndef c0, 1, 2, 3, 4\ndsx r0, r1',
        'vs_1_1\ndcl_position v0\nmov r0, v0\nloop aL, i0', 'ps_3_0\nphase', 'vs_2_0\nphase',
        'ps_1_1\ndcl t0', 'vs_1_1\nmov r0, v0\n+mov r1, v1',
        'ps_2_0\nmov r0, r1\n+mov r0.a, r1.a',
    ];
    for (const text of cases)
    {
        const errors = errorsOf(text);
        const lines = text.split('\n');
        const last = lines.length;
        assert.ok(errors.some(e=>e.line === last),
            `${JSON.stringify(text)} should be rejected at line ${last}: `
            + JSON.stringify(errors));
    }
});

test('registers: the wrong stage, the wrong direction, out of range, malformed', ()=>{
    const bad = [
        ['vs_1_1', 'mov t0.x, v0.x'], ['vs_1_1', 'mov a0, v0'], ['ps_1_1', 'mov r0, a0'],
        ['vs_1_1', 'mov v0, r0'], ['vs_1_1', 'mov c0, r0'], ['ps_2_0', 'mov t0, r0'],
        ['vs_1_1', 'mov r12, v0'], ['vs_1_1', 'mov r0, v16'], ['vs_1_1', 'mov r0, c96'],
        ['ps_1_1', 'mov r2, v0'], ['ps_1_1', 'mov r0, v2'], ['ps_1_1', 'mov r0, c8'],
        ['ps_1_1', 'mov r0, t4'], ['ps_1_4', 'mov r0, t6'], ['ps_1_4', 'mov r6, t0'],
        ['ps_2_0', 'mov r12, v0'], ['ps_3_0', 'mov r0, t0'], ['ps_3_0', 'mov r0, v10'],
        ['vs_1_1', 'mov r0, oPos'], ['ps_2_0', 'mov oC4, r0'], ['vs_1_1', 'mov oD2, r0'],
        ['vs_1_1', 'mov o0, r0'], ['vs_3_0', 'mov oPos, r0'], ['vs_3_0', 'mov oD0, r0'],
        ['vs_2_0', 'mov oT0, r0\nmov oT8, r0'], ['ps_2_0', 'mov oC0, s0'],
        ['vs_1_1', 'mov r0, q0'], ['vs_1_1', 'mov r0, r'], ['vs_1_1', 'mov r0, oPos0'],
        ['vs_2_0', 'mov a1.x, r0'], ['vs_1_1', 'mov r0, c99999'], ['vs_1_1', 'mov r0,'],
        ['vs_1_1', 'mov , r0'], ['vs_1_1', 'mov r0.x.y, r0'], ['vs_1_1', 'mov r0, (r1)'],
        ['ps_2_0', 'add r0, r1, vPos'], ['vs_2_0', 'add r0, r1, i0'], ['vs_1_1', 'mov r0, b0'],
    ];
    for (const [version, body] of bad)
    {
        const text = `${version}\n${body}`;
        const errors = errorsOf(text);
        assert.equal(errors[errors.length - 1].line, text.split('\n').length, text);
    }
});

test('operand counts and kinds', ()=>{
    for (const body of ['mov r0', 'mov', 'mov r0, r1, r2', 'add r0, r1', 'mad r0, r1, r2',
        'nop r0', 'dp3 r0'])
    {
        assert.ok(errorsOf(`vs_1_1\n${body}`)[0].message.length > 0, body);
    }
    for (const body of ['loop r0, i0', 'loop aL, c0', 'rep c0', 'rep i99', 'call r0', 'call l9999',
        'callnz l0, r0', 'if r0', 'label i0', 'ret r0', 'breakp r0', 'texldl r0, r1, r2'])
    {
        assert.equal(errorsOf(`vs_3_0\n${body}`)[0].line, 2, body);
    }
    assert.ok(errorsOf('vs_1_1\nmov_foo r0, v0')[0].message.includes('mov_foo'));
    assert.ok(errorsOf('vs_1_1\nmov r0, v0 junk')[0].message.length > 0);
    assert.ok(errorsOf('vs_1_1\nm4x4 r0, v0')[0].message.length > 0);
    assert.equal(errorsOf('vs_3_0\nif r0.x, c0')[0].line, 2);
    assert.ok(errorsOf('vs_3_0\nif_xx r0, c0')[0].message.length > 0);
    assert.ok(errorsOf('vs_3_0\nsetp p0, r0, r1')[0].message.includes('comparison'));
    assert.ok(errorsOf('vs_3_0\nmov_gt r0, r1')[0].message.length > 0);
});

test('declarations', ()=>{
    for (const [version, body] of [
        ['vs_1_1', 'dcl v0'], ['vs_1_1', 'dcl_foo v0'], ['vs_1_1', 'dcl_position r0'],
        ['vs_1_1', 'dcl_position v0, v1'], ['vs_1_1', 'dcl_2d v0'], ['vs_1_1', 'dcl_position o0'],
        ['vs_3_0', 'dcl_position v0.x.y'], ['vs_3_0', 'dcl_position16 v0'],
        ['ps_3_0', 'dcl_position s0'], ['ps_3_0', 'dcl_2d v0'], ['ps_3_0', 'dcl v0'],
        ['ps_3_0', 'dcl_position vPos'], ['ps_3_0', 'dcl_2d s0_x'], ['ps_3_0', 'dcl_foo s0'],
        ['ps_2_0', 'dcl_cube t0'], ['ps_3_0', 'dcl t0'], ['vs_3_0', 'dcl_position_x v0'],
        ['ps_3_0', 'dcl s0'], ['ps_2_0', 'dcl s0'],
    ])
    {
        assert.equal(errorsOf(`${version}\n${body}`)[0].line, 2, `${version} ${body}`);
    }
});

/* ------------------------------------------------------------- the listing */

test('the listing: indentation, c#[a0.x], rgba shown as xyzw, floats, co-issue', ()=>{
    const flow = words([
        'vs_3_0', 'dcl_position v0', 'dcl_texcoord1 v1', 'defb b0, true', 'defi i0, 2, 0, 1, 0',
        'def c0, 1.0, 0.0, 0.5, -2.0', 'dcl_position o0', 'mov r0, v0', 'rep i0', 'if b0',
        'add r0, r0, c[a0.x + 3]', 'else', 'mul r0, r0, c0', 'endif', 'endrep',
        'if_gt r0.x, c0.y', 'loop aL, i0', 'add r0, r0, v[aL + 1]', 'endloop', 'endif',
        '(p0.x) mov r0.rgb, -r0_abs.a', 'mov o0, r0',
    ].join('\n'));
    assert.equal(disassembleShader(Uint32Array.from(flow)), [
        '    vs_3_0',
        '    dcl_position v0',
        '    dcl_texcoord1 v1',
        '    defb b0, true',
        '    defi i0, 2, 0, 1, 0',
        '    def c0, 1, 0, 0.5, -2',
        '    dcl_position o0',
        '    mov r0, v0',
        '    rep i0',
        '      if b0',
        '        add r0, r0, c3[a0.x]',
        '      else',
        '        mul r0, r0, c0',
        '      endif',
        '    endrep',
        '    if_gt r0.x, c0.y',
        '      loop aL, i0',
        '        add r0, r0, v1[aL]',
        '      endloop',
        '    endif',
        '    (p0.x) mov r0.xyz, -r0_abs.w',
        '    mov o0, r0',
        '',
    ].join('\n'));
    const ps = words([
        'ps_1_4', 'def c0, 1.0, 0.0, 0.25, -0.5', 'texcrd r1.rgb, t1', 'texld r0, t0',
        'mul_x2_sat r0.rgb, r0_bx2, 1-r1', '+mov r0.a, r0.a', 'phase', 'texld r2, r0',
        'mov r0, -r2_bias.b',
    ].join('\n'));
    assert.equal(disassembleShader(ps), [
        '    ps_1_4',
        '    def c0, 1, 0, 0.25, -0.5',
        '    texcrd r1.xyz, t1',
        '    texld r0, t0',
        '    mul_x2_sat r0.xyz, r0_bx2, 1-r1',
        '  + mov r0.w, r0.w',
        '    phase',
        '    texld r2, r0',
        '    mov r0, -r2_bias.z',
        '',
    ].join('\n'));
});

test('the listing: float constants print at nine digits and read back to the same bits', ()=>{
    const text = 'vs_2_0\ndef c0, -0.0, 0.0000001, 1234567, 3.1415927\n'
        + 'def c1, 100000000, 0.333333333, -1.5e-30, 65504\n'
        + 'def c2, 0x7f800000, 0x7fc00001, 0x00000001, 1e10\n';
    const tokens = Uint32Array.from(words(text));
    const listing = disassembleShader(tokens);
    assert.ok(listing.includes('def c0, -0, 1.00000001e-007, 1234567, 3.14159274'), listing);
    assert.ok(listing.includes('def c1, 100000000, 0.333333343, -1.5e-030, 65504'), listing);
    assert.ok(listing.includes('def c2, 0x7f800000, 0x7fc00001, 1.40129846e-045, 1e+010'), listing);
    assert.equal(hex([...assembleShader(listing).tokens ?? []]), hex([...tokens]));
});

test('the listing: comments, the constant table, and the leading text option', ()=>{
    const tokens = Uint32Array.from([
        0xffff0200,
        0x0002fffe, 0x42415443, 0, // a constant table: left out
        0x0002fffe, 0x6c6c6568, 0x6f, // "hello"
        0x0200001f, 0x80000000, 0xb00f0000,
        0x0002fffe, 0x630a6261, 0x64, // "ab\ncd"
        0x02000001, 0x800f0800, 0x90e40000,
        0x0003fffe, 0x00000001, 0x00000000, 0x00ff0000, // not text
        0xffff,
    ]);
    const listing = disassembleShader(tokens, { comments: 'made by a test\nsecond line' });
    assert.equal(listing, [
        '// made by a test', '// second line', '// hello', '    ps_2_0', '    dcl t0',
        '// ab', '// cd', '    mov oC0, v0', '// (12 bytes of binary data)', '',
    ].join('\n'));
    assert.deepEqual([...assembleShader(listing).tokens ?? []],
        [0xffff0200, 0x0200001f, 0x80000000, 0xb00f0000, 0x02000001, 0x800f0800, 0x90e40000,
            0xffff]);
});

test('bytecode that is not a shader is an error, not a guess', ()=>{
    assert.throws(()=>disassembleShader(new Uint32Array(0)), /version/);
    assert.throws(()=>disassembleShader(Uint32Array.from([0x12345678, 0xffff])), /version/);
    // Cut short: the length says 3 and the stream ends.
    assert.throws(()=>disassembleShader(Uint32Array.from([0xfffe0200, 0x03000001, 0x800f0000])),
        /past the end/);
    // The length field disagrees with what the operands take.
    assert.throws(()=>disassembleShader(Uint32Array.from([
        0xfffe0200, 0x04000001, 0x800f0000, 0x90e40000, 0x90e40001, 0xffff,
    ])), /length/);
    // An opcode the version does not have.
    assert.throws(()=>disassembleShader(Uint32Array.from([0xfffe0101, 0x5f, 0xffff])),
        /not an instruction/);
    // A source token where a destination should be is still a parameter token, but a plain
    // word is not.
    assert.throws(()=>disassembleShader(Uint32Array.from([0xfffe0101, 1, 0x1234, 0xffff])),
        /parameter/);
    // A missing END is tolerated: the stream simply ends.
    assert.equal(disassembleShader(Uint32Array.from([0xfffe0101, 1, 0x800f0000, 0x90e40000])),
        '    vs_1_1\n    mov r0, v0\n');
});

/* ---------------------------------------- generated programs: the round trip */

/** @param {number} seed */
function rng(seed){
    let a = seed >>> 0;
    return ()=>{
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** @typedef {() => number} Rand */

/**
 * @template T
 * @param {Rand} r
 * @param {T[]} list
 * @returns {T}
 */
function pick(r, list){
    return list[Math.floor(r() * list.length)];
}

/** @param {Rand} r @param {number} n */
function below(r, n){
    return Math.floor(r() * n);
}

/**
 * What the generator knows of a version, written from the documentation and not read from the
 * assembler's table.
 * @typedef {Object} Model
 * @property {string} name
 * @property {boolean} vs
 * @property {number} major
 * @property {number} vnum      11 for x_1, 14 for ps_1_4, 21 for the x models, 30 for 3_0.
 * @property {number} temps
 * @property {number} consts
 * @property {number} inputs
 * @property {number} texcoords
 * @property {boolean} ps1
 */

/**
 * @param {string} version
 * @returns {Model}
 */
function modelOf(version){
    const [stage, major, minor] = version.split('_');
    const vs = stage === 'vs';
    const vnum = Number(major) * 10 + (minor === 'x' ? 1 : Number(minor));
    return {
        name: version, vs, major: Number(major), vnum, ps1: !vs && Number(major) === 1,
        temps: vs ? (vnum >= 21 ? 32 : 12) : vnum === 14 ? 6 : Number(major) === 1 ? 2
            : vnum === 20 ? 12 : 32,
        consts: vs ? (Number(major) === 1 ? 96 : 256) : Number(major) === 1 ? 8
            : vnum === 30 ? 224 : 32,
        inputs: vs ? 16 : vnum === 30 ? 10 : 2,
        texcoords: vs || vnum >= 30 ? 0 : Number(major) === 2 ? 8 : vnum === 14 ? 6 : 4,
    };
}

const GROUP_VS1 = [
    'mov:1', 'add:2', 'sub:2', 'mad:3', 'mul:2', 'rcp:1', 'rsq:1', 'dp3:2', 'dp4:2', 'min:2',
    'max:2', 'slt:2', 'sge:2', 'exp:1', 'log:1', 'lit:1', 'dst:2', 'frc:1', 'm4x4:2', 'm4x3:2',
    'm3x4:2', 'm3x3:2', 'm3x2:2', 'expp:1', 'logp:1',
];
const GROUP_VS2 = ['lrp:3', 'abs:1', 'nrm:1', 'pow:2', 'crs:2', 'sgn:3'];
const GROUP_PS1 = ['mov:1', 'add:2', 'sub:2', 'mad:3', 'mul:2', 'dp3:2', 'lrp:3', 'cnd:3'];
const GROUP_PS2 = [
    'mov:1', 'add:2', 'sub:2', 'mad:3', 'mul:2', 'rcp:1', 'rsq:1', 'dp3:2', 'dp4:2', 'min:2',
    'max:2', 'slt:2', 'sge:2', 'exp:1', 'log:1', 'frc:1', 'm4x4:2', 'm4x3:2', 'm3x4:2',
    'm3x3:2', 'm3x2:2', 'lrp:3', 'cmp:3', 'dp2add:3', 'abs:1', 'nrm:1', 'pow:2', 'crs:2',
];
/** The ps_1_x texture instructions: mnemonic, operand count after the destination. */
const TEX_PS1_3 = [
    'texcoord:0', 'tex:0', 'texkill:0', 'texbem:1', 'texbeml:1', 'texreg2ar:1', 'texreg2gb:1',
    'texm3x2pad:1', 'texm3x2tex:1', 'texm3x3pad:1', 'texm3x3tex:1', 'texm3x3spec:2',
    'texm3x3vspec:1',
];

/**
 * @param {Rand} r
 * @param {boolean} rgba
 * @returns {string}
 */
function letters(r, rgba){
    const set = rgba ? 'rgba' : 'xyzw';
    let out = '';
    for (let k = 1 + below(r, 4); k > 0; k--)
    {
        out += set[below(r, 4)];
    }
    return out;
}

/**
 * @param {Rand} r
 * @param {boolean} rgba
 * @returns {string}
 */
function genMask(r, rgba){
    const set = rgba ? 'rgba' : 'xyzw';
    const bits = 1 + below(r, 15);
    return bits === 15 && r() < 0.5 ? '' : `.${[...set].filter((_, k)=>bits & (1 << k)).join('')}`;
}

/**
 * A source operand every shader model of the model's stage accepts.
 * @param {Rand} r
 * @param {Model} m
 * @returns {string}
 */
function genSource(r, m){
    const rgba = m.ps1 && r() < 0.5;
    const swz = r() < 0.5 ? '' : `.${letters(r, rgba)}`;
    const bases = [`r${below(r, m.temps)}`, `c${below(r, m.consts)}`, `v${below(r, m.inputs)}`];
    if (m.texcoords)
    {
        bases.push(`t${below(r, m.texcoords)}`);
    }
    if (m.vs)
    {
        bases.push(`c[a0.x + ${below(r, 40)}]`, 'c[a0.x]');
        if (m.major >= 2)
        {
            bases.push(`c[aL + ${below(r, 40)}]`, 'c[aL]');
        }
        if (m.major === 3)
        {
            bases.push(`v[aL + ${below(r, 5)}]`, `v[a0.x + ${below(r, 5)}]`, 'aL');
        }
    }
    else if (m.vnum === 30)
    {
        bases.push(`c[aL + ${below(r, 40)}]`, 'aL', 'vPos', 'vFace');
    }
    const base = pick(r, bases);
    let kinds = ['plain', 'neg'];
    if (m.ps1)
    {
        kinds.push('comp', 'bias', 'negbias', 'bx2', 'negbx2');
        if (m.vnum === 14)
        {
            kinds.push('x2', 'negx2', 'dz', 'dw');
        }
    }
    else if (m.vs ? m.major >= 2 : m.vnum === 30)
    {
        kinds.push('bars', 'negbars', 'abs', 'negabs');
    }
    if (base === 'aL' || base === 'vPos' || base === 'vFace')
    {
        kinds = ['plain'];
    }
    switch (pick(r, kinds))
    {
        case 'neg': return `-${base}${swz}`;
        case 'comp': return `1-${base}${swz}`;
        case 'bias': return `${base}_bias${swz}`;
        case 'negbias': return `-${base}_bias${swz}`;
        case 'bx2': return `${base}_bx2${swz}`;
        case 'negbx2': return `-${base}_bx2${swz}`;
        case 'x2': return `${base}_x2${swz}`;
        case 'negx2': return `-${base}_x2${swz}`;
        case 'dz': return `${base}_dz${swz}`;
        case 'dw': return `${base}_dw${swz}`;
        case 'bars': return `|${base}${swz}|`;
        case 'negbars': return `-|${base}${swz}|`;
        case 'abs': return `${base}_abs${swz}`;
        case 'negabs': return `-${base}_abs${swz}`;
        default: return base + swz;
    }
}

/**
 * @param {Rand} r
 * @param {Model} m
 * @returns {string}
 */
function genDest(r, m){
    const rgba = m.ps1 && r() < 0.5;
    const regs = [`r${below(r, m.temps)}`];
    if (m.vs)
    {
        regs.push(...(m.major === 3 ? [`o${below(r, 12)}`]
            : ['oPos', 'oFog', 'oPts', `oD${below(r, 2)}`, `oT${below(r, 8)}`]));
    }
    else if (m.major >= 2)
    {
        regs.push(`oC${below(r, 4)}`, 'oDepth');
    }
    return pick(r, regs) + (r() < 0.5 ? genMask(r, rgba) : '');
}

/**
 * The modifiers that follow a mnemonic.
 * @param {Rand} r
 * @param {Model} m
 * @returns {string}
 */
function genSuffix(r, m){
    /** @type {string[]} */
    const parts = [];
    if (m.ps1 && r() < 0.4)
    {
        parts.push(pick(r, m.vnum === 14 ? ['x2', 'x4', 'x8', 'd2', 'd4', 'd8']
            : ['x2', 'x4', 'd2']));
    }
    if ((!m.vs || m.major >= 2) && r() < 0.3)
    {
        parts.push('sat');
    }
    if (m.major >= 2 && r() < 0.3)
    {
        parts.push('pp');
    }
    return parts.map(p=>`_${p}`).join('');
}

const COMPARES = ['gt', 'eq', 'ge', 'lt', 'ne', 'le'];

/**
 * One random instruction of the model, as a line.
 * @param {Rand} r
 * @param {Model} m
 * @returns {string}
 */
function genInstruction(r, m){
    const alu = m.vs ? [...GROUP_VS1, ...(m.major >= 2 ? GROUP_VS2 : [])]
        : m.ps1 ? [...GROUP_PS1, ...(m.vnum >= 12 ? ['dp4:2', 'cmp:3'] : [])] : GROUP_PS2;
    /** @type {(() => string)[]} */
    const makers = [];
    const arithmetic = ()=>{
        const [name, count] = pick(r, alu).split(':');
        const operands = [genDest(r, m)];
        for (let k = 0; k < Number(count); k++)
        {
            operands.push(genSource(r, m));
        }
        const line = `${name}${genSuffix(r, m)} ${operands.join(', ')}`;
        if (m.vnum >= 21 && r() < 0.25)
        {
            const pred = pick(r, ['p0', 'p0.x', '!p0', '!p0.y', 'p0.wzyx', 'p0.zzzz']);
            return `(${pred}) ${line}`;
        }
        return m.ps1 && r() < 0.2 ? `+${line}` : line;
    };
    for (let k = 0; k < 6; k++)
    {
        makers.push(arithmetic);
    }
    const sincos = ()=>`sincos${genSuffix(r, m)} ${genDest(r, m)}, ${genSource(r, m)}`
        + (m.vnum < 30 ? `, c${below(r, m.consts)}, c${below(r, m.consts)}` : '');
    if (m.vs ? m.major >= 2 : m.major >= 2)
    {
        makers.push(sincos);
    }
    if (m.vs && m.major >= 2)
    {
        makers.push(()=>`mova a0.x, ${genSource(r, m)}`);
        makers.push(()=>`sgn ${genDest(r, m)}, ${genSource(r, m)}`);
    }
    if (m.vs ? m.major >= 2 : m.vnum >= 21)
    {
        const bool = ()=>pick(r, [`b${below(r, 16)}`, `!b${below(r, 16)}`]);
        makers.push(
            ()=>`loop aL, i${below(r, 16)}`, ()=>'endloop', ()=>`rep i${below(r, 16)}`,
            ()=>'endrep', ()=>`if ${bool()}`, ()=>'else', ()=>'endif', ()=>`call l${below(r, 50)}`,
            ()=>`callnz l${below(r, 50)}, ${bool()}`, ()=>`label l${below(r, 50)}`, ()=>'ret',
        );
    }
    if (m.vnum >= 21 && m.vnum <= 30 && (m.vs || m.major >= 2))
    {
        makers.push(
            ()=>`if_${pick(r, COMPARES)} ${genSource(r, m)}, ${genSource(r, m)}`,
            ()=>`break_${pick(r, COMPARES)} ${genSource(r, m)}, ${genSource(r, m)}`,
            ()=>'break',
            ()=>`setp_${pick(r, COMPARES)} p0${r() < 0.5 ? genMask(r, false) : ''}, `
                + `${genSource(r, m)}, ${genSource(r, m)}`,
            ()=>`breakp p0${pick(r, ['', '.x', '.w', '.zyx'])}`,
            ()=>`if p0${pick(r, ['', '.x'])}`,
            ()=>`callnz l${below(r, 9)}, !p0.${pick(r, ['x', 'y', 'xyzw'])}`,
        );
    }
    if (!m.vs && m.major >= 2)
    {
        const sampler = ()=>`s${below(r, 16)}`;
        const coord = ()=>pick(r, [`t${below(r, 8)}`, `r${below(r, m.temps)}`, `v${below(r, 2)}`])
            .replace(/^t\d+$/, t=>(m.vnum === 30 ? `v${t.slice(1)}` : t));
        const texld = (/** @type {string} */ name)=>()=>`${name}${r() < 0.3 ? '_pp' : ''} `
            + `${genDest(r, m)}, ${coord()}, ${sampler()}`;
        makers.push(texld('texld'), texld('texldp'), texld('texldb'),
            ()=>{
                const temp = m.vnum === 30 || r() < 0.5;
                const reg = temp ? `r${below(r, m.temps)}` : `t${below(r, 8)}`;
                return `texkill ${reg}`;
            });
        if (m.vnum >= 21)
        {
            makers.push(
                ()=>`dsx ${genDest(r, m)}, ${genSource(r, m)}`,
                ()=>`dsy ${genDest(r, m)}, ${genSource(r, m)}`,
                ()=>`texldd ${genDest(r, m)}, ${coord()}, ${sampler()}, ${genSource(r, m)}, `
                    + `${genSource(r, m)}`,
            );
        }
        if (m.vnum === 30)
        {
            makers.push(()=>`texldl ${genDest(r, m)}, ${coord()}, ${sampler()}`);
        }
    }
    if (m.vs && m.vnum === 30)
    {
        makers.push(()=>`texldl ${genDest(r, m)}, ${genSource(r, m)}, s${below(r, 4)}`);
    }
    if (m.ps1)
    {
        const stageT = ()=>`t${below(r, m.texcoords)}`;
        if (m.vnum <= 13)
        {
            const more = m.vnum >= 12
                ? ['texreg2rgb:1', 'texdp3tex:1', 'texdp3:1', 'texm3x3:1'] : [];
            const depth = m.vnum === 13 ? ['texm3x2depth:1'] : [];
            for (const entry of [...TEX_PS1_3, ...more, ...depth])
            {
                const [name, count] = entry.split(':');
                makers.push(()=>`${name} ${[stageT(), ...Array.from({ length: Number(count) },
                    (_, k)=>(k === 1 ? `c${below(r, 8)}` : stageT()))].join(', ')}`);
            }
        }
        else
        {
            makers.push(
                ()=>`texld r${below(r, 6)}, ${pick(r, [stageT(), `r${below(r, 6)}`])}`,
                ()=>`texcrd r${below(r, 6)}${pick(r, ['', '.rgb', '.xyz', '.r', '.gb'])}, `
                    + `${pick(r, [stageT(), `${stageT()}_dz.xyz`, `${stageT()}_dw.xyw`])}`,
                ()=>`texkill ${stageT()}`, ()=>`texdepth r${below(r, 6)}`,
                ()=>`bem r${below(r, 6)}.rg, ${genSource(r, m)}, ${genSource(r, m)}`,
                ()=>'phase',
            );
        }
    }
    return pick(r, makers)();
}

/**
 * The lines every program of a version opens with.
 * @param {Rand} r
 * @param {Model} m
 * @returns {string[]}
 */
function genHeader(r, m){
    /** @type {string[]} */
    const lines = [];
    const usages = ['position', 'blendweight', 'blendindices', 'normal', 'psize', 'texcoord',
        'tangent', 'binormal', 'tessfactor', 'positiont', 'color', 'fog', 'depth', 'sample'];
    if (m.vs)
    {
        for (let k = 0; k < 4; k++)
        {
            const usage = pick(r, usages);
            lines.push(`dcl_${usage}${below(r, 3) || ''}${m.major >= 2 && r() < 0.2 ? '_pp' : ''} `
                + `v${below(r, 16)}${r() < 0.2 ? genMask(r, false) : ''}`);
            if (m.major === 3)
            {
                lines.push(`dcl_${usage}${below(r, 3) || ''} o${below(r, 12)}`);
            }
        }
    }
    else if (m.vnum === 30)
    {
        lines.push(`dcl_texcoord${below(r, 8) || ''}_pp v${below(r, 10)}`, 'dcl_color1 v1.xyz',
            'dcl_2d s0', 'dcl_cube s3', 'dcl_volume s15', 'dcl vPos.xy', 'dcl vFace');
    }
    else if (m.major === 2)
    {
        lines.push(`dcl t${below(r, 8)}`, `dcl_pp t${below(r, 8)}`, `dcl v${below(r, 2)}`,
            'dcl_2d s0', `dcl_cube s${1 + below(r, 15)}`, 'dcl_volume s2');
    }
    for (let k = 0; k < 3; k++)
    {
        const num = [0, 1, 0.5, -2, 0.125, 1e-7, 3.4028235e38, 123456.789, -0].map(String);
        const four = [0, 1, 2, 3].map(()=>pick(r, [...num, '0x3f800000', '-1e-30', '1.5f']));
        lines.push(`def c${below(r, m.vs ? 90 : m.consts)}, ${four.join(', ')}`);
    }
    if (m.vs ? m.major >= 2 : m.vnum >= 21)
    {
        lines.push(`defi i${below(r, 16)}, ${[0, 1, 2, 3].map(()=>below(r, 255) - 127).join(', ')}`,
            `defb b${below(r, 16)}, ${pick(r, ['true', 'false', '0', '1'])}`);
    }
    return lines;
}

const PROGRAM_VERSIONS = [
    'vs_1_0', 'vs_1_1', 'vs_2_0', 'vs_2_x', 'vs_3_0', 'ps_1_0', 'ps_1_1', 'ps_1_2', 'ps_1_3',
    'ps_1_4', 'ps_2_0', 'ps_2_x', 'ps_3_0',
];

/**
 * A program of one version, seeded.
 * @param {string} version
 * @param {number} seed
 * @param {number} length
 * @returns {string}
 */
function genProgram(version, seed, length){
    const r = rng(seed);
    const m = modelOf(version);
    const lines = [version, ...genHeader(r, m)];
    for (let k = 0; k < length; k++)
    {
        let line = genInstruction(r, m);
        if (k === 0 && line.startsWith('+'))
        {
            line = line.slice(1);
        }
        lines.push(line);
    }
    return `${lines.join('\n')}\n`;
}

test('round trip: assemble(disassemble(t)) is t, for seeded programs of every version', ()=>{
    let instructions = 0;
    for (const version of PROGRAM_VERSIONS)
    {
        for (let seed = 1; seed <= 12; seed++)
        {
            const text = genProgram(version, seed * 7919 + version.length, 60);
            const first = assembleShader(text);
            assert.deepEqual(first.errors, [], text);
            assert.ok(first.tokens);
            const listing = disassembleShader(first.tokens);
            const second = assembleShader(listing);
            assert.deepEqual(second.errors, [], `${listing}\n(from)\n${text}`);
            assert.equal(hex([...second.tokens ?? []]), hex([...first.tokens]),
                `${version} seed ${seed}:\n${text}\n(listing)\n${listing}`);
            // The listing is a fixed point: a second round changes nothing.
            assert.equal(disassembleShader(second.tokens ?? new Uint32Array(0)), listing);
            instructions += text.split('\n').length - 2;
        }
    }
    assert.ok(instructions > 5000, `${instructions} instructions`);
});

/* --------------------------- the differential gate against the reference assembler */

/**
 * The reference assembler, which has no vs_1_0 or ps_1_0: they are its x_1_1 with the version
 * token changed (the instruction sets differ only in what a shader may use, not in the tokens).
 * It spells abs as |r0| only, so r0_abs is rewritten to that.
 * @param {string} text
 * @returns {Uint32Array}
 */
function reference(text){
    const bars = text.replace(/(-?)((?:[a-z]+\d*|[cv]\[[^\]]*\]))_abs((?:\.[xyzw]+)?)/g, '$1|$2$3|');
    const m = /^(vs|ps)_1_0\n/.exec(bars);
    if (!m)
    {
        return referenceAssemble(bars, { validate: false });
    }
    // The upgrade to 1_1 is what D3DX does with the text.
    return referenceAssemble(`${m[1]}_1_1\n${bars.slice(m[0].length)}`, { validate: false });
}

/**
 * Where the two assemblers are known to differ, and the reason. Returns the reason when the
 * pair of token lists differs only as the reason says, else null.
 * @param {string} version
 * @param {string} line
 * @param {number[]} mine
 * @param {number[]} theirs
 * @returns {string | null}
 */
function knownDifference(version, line, mine, theirs){
    const out = [...theirs];
    /** @type {string[]} */
    const reasons = [];
    // A predicate's token sits between the destination and the sources.
    const guard = /^\(([^)]*)\)\s*/.exec(line);
    const bare = guard ? line.slice(guard[0].length) : line;
    const shift = guard ? 1 : 0;
    if (version.startsWith('vs') && /^sub[ _]/.test(bare))
    {
        // D3DX turns sub into add with the second source negated in a vertex shader; the
        // reference keeps opcode 3. The rewrite applied to the reference's tokens must give
        // the assembler's.
        out[1] = (out[1] & ~0xffff) | 2;
        const relative = (out[3 + shift] & (1 << 13)) !== 0 && !/^vs_1/.test(version);
        const second = (relative ? 5 : 4) + shift;
        const flips = new Map([[0, 1], [1, 0], [11, 12], [12, 11]]);
        const flipped = flips.get((out[second] >>> 24) & 15);
        if (flipped === undefined)
        {
            return null;
        }
        out[second] = ((out[second] & 0xf0ffffff) | (flipped << 24)) >>> 0;
        reasons.push('vs sub');
    }
    if (/\[aL/.test(line) && out.length === mine.length)
    {
        // The address-register token of aL carries the identity swizzle in the bytecode D3DX
        // writes; the reference leaves it zero.
        for (let k = 0; k < out.length; k++)
        {
            if (out[k] === 0xf0000800 && mine[k] === 0xf0e40800)
            {
                out[k] = mine[k];
                reasons.push('aL relative token swizzle');
            }
        }
    }
    return hex(out) === hex(mine) ? [...new Set(reasons)].join(' + ') : null;
}

test('differential gate: every line both assemblers accept gives identical tokens', ()=>{
    /** @type {Map<string, number>} */
    const outcomes = new Map();
    /** @param {string} key */
    const count = key=>outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    for (const version of PROGRAM_VERSIONS)
    {
        const m = modelOf(version);
        const r = rng(0x5eed + version.length * 31 + version.charCodeAt(version.length - 1));
        for (let n = 0; n < 400; n++)
        {
            let line = genInstruction(r, m);
            if (line.startsWith('+') && n === 0)
            {
                line = line.slice(1);
            }
            const prefix = line.startsWith('+') ? 'mov r0, c0\n' : '';
            const text = `${version}\n${prefix}${line}\n`;
            const mine = assembleShader(text);
            assert.deepEqual(mine.errors, [], `generated line rejected:\n${text}`);
            /** @type {Uint32Array} */
            let theirs;
            try
            {
                theirs = reference(text);
            }
            catch (e){
                const message = e instanceof Error ? e.message : String(e);
                // The reference has no relative destinations, no constants beyond c255
                // and no half-precision registers; its predication and ! are 2_x and
                // later only.
                const why = /p0/.test(text) ? 'predication' : /!b\d/.test(text) ? 'boolean not' : '';
                assert.ok(why, `unexpected reference rejection of:\n${text}\n${message}`);
                count(`reference rejects: ${why}`);
                continue;
            }
            const a = [...(mine.tokens ?? [])];
            const b = [...theirs];
            if (hex(a) === hex(b))
            {
                count('identical');
                continue;
            }
            const reason = knownDifference(version, line, a, b);
            assert.ok(reason, `tokens differ for:\n${text}\nmine   ${hex(a)}\ntheirs ${hex(b)}`);
            count(`known difference: ${reason}`);
        }
    }
    assert.ok((outcomes.get('identical') ?? 0) > 2500, JSON.stringify([...outcomes]));
});

test('differential gate: the hand-written constructs, one at a time', ()=>{
    // Every construct below is one both assemblers accept, except where the comment says.
    const programs = [
        'vs_1_1\ndcl_position v0\ndcl_texcoord3 v7\nm4x4 oPos, v0, c0\nmov oD0.xy, -c4.wzyx',
        'vs_2_0\nmova a0.x, v0.x\nmov r0, c[a0.x + 3]\nrep i0\nadd r0, r0, c1\nendrep',
        'vs_3_0\ndcl_position o0\nif_lt r0.x, c0.y\nbreak_ge r0, c0\nendif\nmov o0, |r0|',
        'ps_1_4\ntexcrd r1.rgb, t1\ntexld r0, t0\nmul r0.rgb, r0, r1\n+mov r0.a, r0.a\nphase\n'
            + 'texld r2, r0\nmov_sat r0, r2',
        'ps_1_3\ntex t0\ntexm3x3spec t3, t0, c0\ncnd r0, r0.a, v0, c0\nmul_x4_sat r0, r1_bx2, 1-r0',
        'ps_2_0\ndcl t0\ndcl_2d s0\ntexldp r1, t0, s0\nmad_pp r0, r0, r1, -r0\nmov oC0, r0',
        'ps_3_0\ndcl_texcoord v0\ndcl_2d s0\ndcl vPos.xy\ndcl vFace\ntexld r0, v0, s0\n'
            + 'mov oC0, -|r0|\nmov oDepth, r0.x',
        'ps_2_x\ndefb b0, true\ndefi i0, 1, 2, 3, 4\ndef c0, 0.5, -2, 1e3, 0x40490fdb\n'
            + 'loop aL, i0\nendloop\ntexkill r0',
    ];
    for (const text of programs)
    {
        const mine = words(text);
        const theirs = [...reference(text)];
        assert.equal(hex(mine), hex(theirs), text);
    }
});

test('differential gate: the listings agree with the reference where the formats do', ()=>{
    let compared = 0;
    for (const version of PROGRAM_VERSIONS.filter(v=>v !== 'vs_1_0' && !v.startsWith('ps_1')))
    {
        const m = modelOf(version);
        const r = rng(0xd15a + version.length * 13 + version.charCodeAt(version.length - 1));
        for (let n = 0; n < 300; n++)
        {
            const line = genInstruction(r, m);
            // The reference prints a relative address as c[a0.x + 3] and abs as |r0|, has no
            // predication, and keeps sub where a vertex shader assembles it to add.
            if (/\[|_abs|\||^\(|^sub|p0/.test(line))
            {
                continue;
            }
            const text = `${version}\n${line}\n`;
            const tokens = words(text);
            /** @type {string} */
            let theirs;
            try
            {
                theirs = referenceDisassemble(Uint32Array.from(tokens));
            }
            catch {
                // The reference decoder is strict about register files and nesting.
                continue;
            }
            const norm = (/** @type {string} */ s)=>s.split('\n').map(l=>l.trim())
                .filter(l=>l && !/^[vp]s_/.test(l));
            assert.deepEqual(norm(disassembleShader(Uint32Array.from(tokens))), norm(theirs), text);
            compared++;
        }
    }
    assert.ok(compared > 200, `${compared} listings compared`);
});

/* ------------------------------------------------------------- hostile input */

test('hostile text: assembling never throws, errors stay inside the text, accepted text rounds',
    ()=>{
        const r = rng(0xbad5eed);
        const sources = PROGRAM_VERSIONS.map((v, k)=>genProgram(v, 100 + k, 30));
        const noise = ',.[]()+-|!_ \n0123456789xyzwrgbalstcdpf;/*=';
        let accepted = 0;
        for (let n = 0; n < 1500; n++)
        {
            let text = pick(r, sources);
            for (let k = 1 + below(r, 3); k > 0; k--)
            {
                const at = below(r, text.length);
                const span = below(r, 6);
                switch (below(r, 4))
                {
                    case 0: text = text.slice(0, at) + text.slice(at + span); break;
                    case 1: text = text.slice(0, at) + text.slice(at, at + span)
                        + text.slice(at); break;
                    case 2: text = text.slice(0, at) + pick(r, [...noise]) + text.slice(at + 1);
                        break;
                    default: text = text.slice(0, at) + pick(r, [...noise]) + text.slice(at);
                }
            }
            const result = assembleShader(text);
            const lineCount = text.split(/\r\n|\n|\r/).length;
            if (result.tokens === null)
            {
                assert.ok(result.errors.length > 0, text);
                for (const e of result.errors)
                {
                    assert.ok(Number.isInteger(e.line) && e.line >= 1 && e.line <= lineCount, text);
                    assert.ok(typeof e.message === 'string' && e.message !== '');
                }
                continue;
            }
            accepted++;
            assert.equal(result.errors.length, 0);
            assert.equal(result.tokens[result.tokens.length - 1], 0xffff);
            const again = assembleShader(disassembleShader(result.tokens));
            assert.equal(hex([...again.tokens ?? []]), hex([...result.tokens]), text);
        }
        assert.ok(accepted > 50, `${accepted} mutated programs were still valid`);
    });

test('hostile bytecode: disassembling garbage gives text or an Error, never a crash', ()=>{
    const r = rng(0xc0ffee);
    let listed = 0;
    for (let n = 0; n < 1500; n++)
    {
        const version = pick(r, PROGRAM_VERSIONS);
        const base = [...words(genProgram(version, 500 + n % 40, 12))];
        for (let k = 1 + below(r, 3); k > 0; k--)
        {
            const at = 1 + below(r, base.length - 1);
            base[at] = pick(r, [
                base[at] ^ (1 << below(r, 32)), below(r, 0x100000), 0xffffffff, 0,
                (base[at] & 0xf0ffffff) | (below(r, 16) << 24),
            ]) >>> 0;
        }
        try
        {
            assert.equal(typeof disassembleShader(Uint32Array.from(base)), 'string');
            listed++;
        }
        catch (e){
            assert.ok(e instanceof Error && !(e instanceof TypeError || e instanceof RangeError),
                `${e}`);
        }
    }
    assert.ok(listed > 100, `${listed} corrupted streams still listed`);
});

/* ----------------------------------------------- which versions have which opcode */

/**
 * Every instruction of the D3D9 set with one valid spelling, and the versions (as vnum: 11 for
 * x_1, 14 for ps_1_4, 21 for the x models and the software models of shader model 2, 30 for
 * model 3) that have it, written from the shader-model documentation.
 * @type {[string, number[] | null, number[] | null][]}
 */
const AVAILABILITY = [
    ['nop', [10, 30], [10, 30]], ['mov r0, c0', [10, 30], [10, 30]],
    ['add r0, r1, c0', [10, 30], [10, 30]], ['sub r0, r1, c0', [10, 30], [10, 30]],
    ['mad r0, r1, r1, c0', [10, 30], [10, 30]], ['mul r0, r1, c0', [10, 30], [10, 30]],
    ['rcp r0, c0', [10, 30], [20, 30]], ['rsq r0, c0', [10, 30], [20, 30]],
    ['dp3 r0, r1, c0', [10, 30], [10, 30]], ['dp4 r0, r1, c0', [10, 30], [12, 30]],
    ['min r0, r1, c0', [10, 30], [20, 30]], ['max r0, r1, c0', [10, 30], [20, 30]],
    ['slt r0, r1, c0', [10, 30], [20, 30]], ['sge r0, r1, c0', [10, 30], [20, 30]],
    ['exp r0, c0', [10, 30], [20, 30]], ['log r0, c0', [10, 30], [20, 30]],
    ['lit r0, c0', [10, 30], null], ['dst r0, r1, c0', [10, 30], null],
    ['lrp r0, r1, r1, c0', [20, 30], [10, 30]], ['frc r0, c0', [10, 30], [20, 30]],
    ['m4x4 r0, r1, c0', [10, 30], [20, 30]], ['m4x3 r0, r1, c0', [10, 30], [20, 30]],
    ['m3x4 r0, r1, c0', [10, 30], [20, 30]], ['m3x3 r0, r1, c0', [10, 30], [20, 30]],
    ['m3x2 r0, r1, c0', [10, 30], [20, 30]], ['expp r0, c0', [10, 30], null],
    ['logp r0, c0', [10, 30], null],
    ['call l0', [20, 30], [21, 30]], ['callnz l0, b0', [20, 30], [21, 30]],
    ['loop aL, i0', [20, 30], [21, 30]], ['ret', [20, 30], [21, 30]],
    ['endloop', [20, 30], [21, 30]], ['label l0', [20, 30], [21, 30]],
    ['rep i0', [20, 30], [21, 30]], ['endrep', [20, 30], [21, 30]],
    ['if b0', [20, 30], [21, 30]], ['else', [20, 30], [21, 30]], ['endif', [20, 30], [21, 30]],
    ['if_lt r0, r1', [21, 30], [21, 30]], ['break', [21, 30], [21, 30]],
    ['break_lt r0, r1', [21, 30], [21, 30]], ['setp_lt p0, r0, r1', [21, 30], [21, 30]],
    ['breakp p0', [21, 30], [21, 30]],
    ['pow r0, r1, c0', [20, 30], [20, 30]], ['crs r0, r1, c0', [20, 30], [20, 30]],
    ['sgn r0, r1, r1, r1', [20, 30], null], ['abs r0, c0', [20, 30], [20, 30]],
    ['nrm r0, c0', [20, 30], [20, 30]], ['sincos r0, r1, c0, c1', [20, 21], [20, 21]],
    ['sincos r0, r1', [30, 30], [30, 30]], ['mova a0.x, r0', [20, 30], null],
    ['defb b0, true', [20, 30], [21, 30]], ['defi i0, 1, 2, 3, 4', [20, 30], [21, 30]],
    ['def c0, 1, 2, 3, 4', [10, 30], [10, 30]],
    ['dcl_position v0', [10, 30], [20, 30]], ['dcl_2d s0', [30, 30], [20, 30]],
    ['texkill t0', null, [10, 29]], ['texkill r0', null, [14, 30]],
    ['tex t0', null, [10, 13]], ['texcoord t0', null, [10, 13]],
    ['texld r0, t0', null, [14, 14]], ['texcrd r0, t0', null, [14, 14]],
    ['texbem t1, t0', null, [10, 13]], ['texbeml t1, t0', null, [10, 13]],
    ['texreg2ar t1, t0', null, [10, 13]], ['texreg2gb t1, t0', null, [10, 13]],
    ['texreg2rgb t1, t0', null, [12, 13]], ['texm3x2pad t0, t0', null, [10, 13]],
    ['texm3x2tex t1, t0', null, [10, 13]], ['texm3x2depth t1, t0', null, [13, 13]],
    ['texm3x3pad t0, t0', null, [10, 13]], ['texm3x3tex t2, t0', null, [10, 13]],
    ['texm3x3spec t2, t0, c0', null, [10, 13]], ['texm3x3vspec t2, t0', null, [10, 13]],
    ['texm3x3 t2, t0', null, [12, 13]], ['texdp3 t1, t0', null, [12, 13]],
    ['texdp3tex t1, t0', null, [12, 13]], ['texdepth r5', null, [14, 14]],
    ['cnd r0, r1, c0, c0', null, [10, 14]], ['cmp r0, r1, c0, c0', null, [12, 30]],
    ['bem r0.rg, r1, c0', null, [14, 14]], ['phase', null, [14, 14]],
    ['dp2add r0, r1, c0, c0', null, [20, 30]], ['dsx r0, r1', null, [21, 30]],
    ['dsy r0, r1', null, [21, 30]], ['texld r0, r1, s0', null, [20, 30]],
    ['texldp r0, r1, s0', null, [20, 30]], ['texldb r0, r1, s0', null, [20, 30]],
    ['texldd r0, r1, s0, r1, r1', null, [21, 30]], ['texldl r0, r1, s0', [30, 30], [30, 30]],
];

test('each instruction assembles in the versions that have it and in no other', ()=>{
    const versions = ['vs_1_0', 'vs_1_1', 'vs_2_0', 'vs_2_x', 'vs_2_sw', 'vs_3_0', 'vs_3_sw',
        'ps_1_0', 'ps_1_1', 'ps_1_2', 'ps_1_3', 'ps_1_4', 'ps_2_0', 'ps_2_x', 'ps_2_sw', 'ps_3_0',
        'ps_3_sw'];
    let accepted = 0;
    for (const [text, vsRange, psRange] of AVAILABILITY)
    {
        for (const version of versions)
        {
            const [stage, major, minor] = version.split('_');
            const vnum = Number(major) * 10 + (minor === 'x' || (minor === 'sw' && major === '2')
                ? 1 : minor === 'sw' ? 0 : Number(minor));
            const range = stage === 'vs' ? vsRange : psRange;
            const has = range !== null && vnum >= range[0] && vnum <= range[1];
            const { errors } = assembleShader(`${version}\n${text}\n`);
            assert.equal(errors.length === 0, has,
                `${text} in ${version}: ${has ? 'should assemble' : 'should be rejected'} `
                + JSON.stringify(errors));
            accepted += has ? 1 : 0;
        }
    }
    assert.ok(accepted > 700, `${accepted} accepted`);
});
