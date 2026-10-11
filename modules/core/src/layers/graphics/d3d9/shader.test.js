/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The bytecode reader, driven with streams assembled by hand: there is no
 * compiler here, and the token layout is the contract anyway.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DERR_INVALIDCALL, D3D_OK } from './constants.js';
import { createReferenceCount } from './resources.js';
import {
    CONSTANT_FILE, END_TOKEN, OPCODE, REGISTER, SHADER_KIND, createConstantFile, createShader,
    functionOf, parseShader, validateShader, versionOf, versionToken,
} from './shader.js';

/** @param {number} type @param {number} index @param {number} writeMask */
const dst = (type, index, writeMask = 0xf)=>(0x80000000 | ((type & 7) << 28)
    | ((type & 0x18) << 8) | (writeMask << 16) | index) >>> 0;
/** @param {number} type @param {number} index @param {number} swizzle @param {number} modifier */
const src = (type, index, swizzle = 0xe4, modifier = 0)=>(0x80000000 | ((type & 7) << 28)
    | ((type & 0x18) << 8) | (modifier << 24) | (swizzle << 16) | index) >>> 0;
/** @param {number} opcode @param {number} length @param {number} control */
const op = (opcode, length, control = 0)=>((length << 24) | (control << 16) | opcode) >>> 0;
const RELATIVE = 1 << 13;
const PREDICATED = 1 << 28;

const VS_2_0 = versionToken(SHADER_KIND.VERTEX, 2, 0);
const VS_1_1 = versionToken(SHADER_KIND.VERTEX, 1, 1);
const PS_2_0 = versionToken(SHADER_KIND.PIXEL, 2, 0);

/** The whole of a vs_2_0 that moves its position through a matrix. */
const TRANSFORM_VS = [
    VS_2_0,
    // dcl_position v0
    op(OPCODE.DCL, 2), 0x80000000, dst(REGISTER.INPUT, 0),
    // def c4, 1.0, 0.5, 0.0, 2.0
    op(OPCODE.DEF, 5), dst(REGISTER.CONST, 4), 0x3f800000, 0x3f000000, 0, 0x40000000,
    // dp4 oPos.x, v0, c0
    op(OPCODE.DP4, 3), dst(REGISTER.RASTOUT, 0, 0x1), src(REGISTER.INPUT, 0),
    src(REGISTER.CONST, 0),
    // mov r0, c4.xxxx (with a relative address on the constant)
    op(OPCODE.MOV, 3), dst(REGISTER.TEMP, 0), (src(REGISTER.CONST, 4, 0x00) | RELATIVE) >>> 0,
    src(REGISTER.ADDR, 0, 0x00),
    END_TOKEN,
];

test('the version token says the kind and version, and nothing else does', ()=>{
    assert.deepEqual(versionOf(VS_2_0), { kind: SHADER_KIND.VERTEX, major: 2, minor: 0 });
    assert.deepEqual(versionOf(versionToken(SHADER_KIND.PIXEL, 3, 0)),
        { kind: SHADER_KIND.PIXEL, major: 3, minor: 0 });
    assert.equal(versionOf(0x00000001), null);
    assert.equal(versionOf(END_TOKEN), null);
});

test('a model-2 stream is read by its length fields, operand by operand', ()=>{
    const parsed = parseShader(TRANSFORM_VS);
    assert.equal(parsed.error, null);
    assert.equal(parsed.instructions.length, 4);

    const [dcl, def, dp4, mov] = parsed.instructions;
    assert.equal(dcl.name, 'dcl');
    assert.deepEqual(dcl.declaration, { usage: 0, usageIndex: 0 });
    assert.equal(dcl.dest?.type, REGISTER.INPUT);

    assert.equal(def.name, 'def');
    assert.equal(def.dest?.index, 4);
    assert.deepEqual(def.literals, [0x3f800000, 0x3f000000, 0, 0x40000000]);

    assert.equal(dp4.name, 'dp4');
    assert.equal(dp4.dest?.type, REGISTER.RASTOUT);
    assert.equal(dp4.dest?.writeMask, 0x1, 'only x is written');
    assert.equal(dp4.sources.length, 2);
    assert.equal(dp4.sources[0].type, REGISTER.INPUT);
    assert.equal(dp4.sources[1].type, REGISTER.CONST);
    assert.equal(dp4.sources[1].swizzle, 0xe4, 'the identity swizzle');

    // From model 2 a relative address is a token of its own.
    assert.equal(mov.sources.length, 1);
    assert.equal(mov.sources[0].relative?.type, REGISTER.ADDR);
    assert.equal(mov.sources[0].swizzle, 0x00, 'c4.xxxx');
});

test('a model-1 stream has no length fields and takes its operand counts from the opcode', ()=>{
    const parsed = parseShader([
        VS_1_1,
        // mov r0, c3 with the implicit a0.x relative address
        op(OPCODE.MOV, 0), dst(REGISTER.TEMP, 0), (src(REGISTER.CONST, 3) | RELATIVE) >>> 0,
        // mad oD0, r0, c1, c2
        op(OPCODE.MAD, 0), dst(REGISTER.ATTROUT, 0), src(REGISTER.TEMP, 0),
        src(REGISTER.CONST, 1), src(REGISTER.CONST, 2),
        END_TOKEN,
    ]);
    assert.equal(parsed.error, null);
    assert.equal(parsed.instructions.length, 2);
    const [mov, mad] = parsed.instructions;
    assert.equal(mov.sources[0].relative?.type, REGISTER.ADDR, 'a0.x, implied');
    assert.equal(mad.sources.length, 3);
});

test('a register type split across the token is put back together', ()=>{
    // A boolean constant is type 14: 6 in the low three bits, 1 in the high two.
    const parsed = parseShader([
        VS_2_0,
        op(OPCODE.IF, 1), src(REGISTER.CONSTBOOL, 3),
        op(OPCODE.ENDIF, 0),
        END_TOKEN,
    ]);
    assert.equal(parsed.error, null);
    assert.equal(parsed.instructions[0].sources[0].type, REGISTER.CONSTBOOL);
    assert.equal(parsed.instructions[0].sources[0].index, 3);
});

test('a predicated instruction reads its predicate after its destination', ()=>{
    // (p0) mov r1, c0: the order D3DXAssembleShader writes and Wine's
    // visual tests carry (0x14000001, r, p0, c).
    const parsed = parseShader([
        VS_2_0,
        (op(OPCODE.MOV, 3) | PREDICATED) >>> 0, dst(REGISTER.TEMP, 1), src(REGISTER.PREDICATE, 0),
        src(REGISTER.CONST, 0),
        END_TOKEN,
    ]);
    assert.equal(parsed.error, null);
    const [mov] = parsed.instructions;
    assert.equal(mov.predicated, true);
    assert.equal(mov.dest?.type, REGISTER.TEMP);
    assert.equal(mov.predicate?.type, REGISTER.PREDICATE);
    assert.equal(mov.sources.length, 1, 'the predicate is not one of the sources');
    assert.equal(mov.sources[0].type, REGISTER.CONST);
});

test('a sampler declaration says what kind of texture it samples', ()=>{
    const parsed = parseShader([
        PS_2_0,
        // dcl_2d s0: the sampler type sits in bits 27-30 of the info token.
        op(OPCODE.DCL, 2), (2 << 27) >>> 0, dst(REGISTER.SAMPLER, 0),
        // texld r0, t0, s0
        op(OPCODE.TEX, 3), dst(REGISTER.TEMP, 0), src(REGISTER.TEXTURE, 0),
        src(REGISTER.SAMPLER, 0),
        END_TOKEN,
    ]);
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.instructions[0].declaration, { samplerType: 2 });
    assert.equal(parsed.instructions[1].sources.length, 2);
});

test('comments are stepped over by their own length', ()=>{
    const parsed = parseShader([
        VS_2_0,
        (2 << 16) | 0xfffe, 0x12345678, 0x9abcdef0,
        op(OPCODE.NOP, 0),
        END_TOKEN,
    ]);
    assert.equal(parsed.error, null);
    assert.equal(parsed.instructions.length, 1);
    assert.equal(parsed.instructions[0].name, 'nop');
});

test('a stream that cannot be read says where it stopped', ()=>{
    assert.match(parseShader([]).error ?? '', /version token/);
    assert.match(parseShader([0x12345678]).error ?? '', /version token/);
    assert.match(parseShader([VS_2_0, op(OPCODE.NOP, 0)]).error ?? '', /no end token/);
    assert.match(parseShader([VS_2_0, op(999, 0), END_TOKEN]).error ?? '', /unknown opcode/);
    assert.match(parseShader([VS_2_0, op(OPCODE.MOV, 2), dst(REGISTER.TEMP, 0)]).error ?? '',
        /past the end/);
    assert.match(parseShader([VS_2_0, op(OPCODE.MOV, 2), 0x00000001, 0x00000002, END_TOKEN])
        .error ?? '', /without a destination/);
});

test('a create refuses the wrong kind, a broken stream and a model past the device', ()=>{
    const two = { major: 2, minor: 0 };
    assert.equal(validateShader(TRANSFORM_VS, SHADER_KIND.VERTEX, two), D3D_OK);
    assert.equal(validateShader(TRANSFORM_VS, SHADER_KIND.PIXEL, two), D3DERR_INVALIDCALL,
        'a vertex shader is not a pixel shader');
    assert.equal(validateShader([VS_2_0, op(OPCODE.NOP, 0)], SHADER_KIND.VERTEX, two),
        D3DERR_INVALIDCALL, 'no end token');
    assert.equal(validateShader([versionToken(SHADER_KIND.VERTEX, 3, 0), END_TOKEN],
        SHADER_KIND.VERTEX, two), D3DERR_INVALIDCALL, 'vs_3_0 on a vs_2_0 device');
    // 2.1 is the 2_x profiles, model 2.0 with its extended caps: the ones a
    // card advertising 2.0 and more than its floor (GeForce FX, Radeon X800)
    // was made to run, and a compiler picks from those caps.
    assert.equal(validateShader([versionToken(SHADER_KIND.VERTEX, 2, 1), END_TOKEN],
        SHADER_KIND.VERTEX, two), D3D_OK, 'vs_2_x on a vs_2_0 device');
    assert.equal(validateShader([versionToken(SHADER_KIND.PIXEL, 2, 1), END_TOKEN],
        SHADER_KIND.PIXEL, two), D3D_OK, 'and ps_2_x');
    assert.equal(validateShader([VS_1_1, END_TOKEN], SHADER_KIND.VERTEX, two), D3D_OK,
        'an older shader on a newer device');
    assert.equal(validateShader([VS_1_1, END_TOKEN], SHADER_KIND.VERTEX, { major: 0, minor: 0 }),
        D3DERR_INVALIDCALL, 'any shader on a device that runs none');
});

test('the function a shader hands back ends at its end token, whatever followed it', ()=>{
    const padded = [...TRANSFORM_VS, 0xdeadbeef, 0xdeadbeef];
    assert.deepEqual([...functionOf(padded)], TRANSFORM_VS);

    const shader = createShader({
        kind: SHADER_KIND.VERTEX, tokens: padded, count: createReferenceCount(),
    });
    assert.equal(shader.version.major, 2);
    /** @type {{ bytes?: number, tokens?: Uint32Array }} */
    let out = {};
    assert.equal(shader.GetFunction(out), D3D_OK);
    assert.equal(out.bytes, TRANSFORM_VS.length * 4);
    assert.equal(out.tokens, undefined, 'asking the size copies nothing');
    out = {};
    assert.equal(shader.GetFunction(out, 4), D3DERR_INVALIDCALL);
    assert.equal(out.bytes, TRANSFORM_VS.length * 4, 'the size is reported with the refusal');
    out = {};
    assert.equal(shader.GetFunction(out, TRANSFORM_VS.length * 4), D3D_OK);
    assert.deepEqual([...(out.tokens ?? [])], TRANSFORM_VS);
    assert.equal(shader.release(), 0);
});

test('a constant file is bounded, and a range that reaches past it is refused whole', ()=>{
    const file = createConstantFile(CONSTANT_FILE.vertex);
    assert.equal(file.setF(0, [1, 2, 3, 4, 5, 6, 7, 8], 2), D3D_OK);
    /** @type {{ values?: Float32Array }} */
    const out = {};
    assert.equal(file.getF(1, 1, out), D3D_OK);
    assert.deepEqual([...(out.values ?? [])], [5, 6, 7, 8]);

    assert.equal(file.setF(255, [1, 2, 3, 4], 1), D3D_OK, 'the last register');
    assert.equal(file.setF(255, [1, 2, 3, 4, 5, 6, 7, 8], 2), D3DERR_INVALIDCALL,
        'one past the last');
    assert.equal(file.setF(256, [1, 2, 3, 4], 1), D3DERR_INVALIDCALL);
    assert.equal(file.getF(256, 1, out), D3DERR_INVALIDCALL);
    assert.equal(file.setF(0, /** @type {any} */ (null), 1), D3DERR_INVALIDCALL);
    assert.equal(file.setF(0, [], 0), D3D_OK, 'a count of zero does nothing and is accepted');
    // Nothing above was written by the refused calls.
    assert.equal(file.getF(255, 1, out), D3D_OK);
    assert.deepEqual([...(out.values ?? [])], [1, 2, 3, 4]);

    assert.equal(file.setI(15, [1, 2, 3, 4], 1), D3D_OK);
    assert.equal(file.setI(16, [1, 2, 3, 4], 1), D3DERR_INVALIDCALL);
    assert.equal(file.setB(15, [1], 1), D3D_OK);
    assert.equal(file.setB(15, [1, 1], 2), D3DERR_INVALIDCALL);

    // A pixel stage has fewer floats than a vertex stage.
    const pixel = createConstantFile(CONSTANT_FILE.pixel);
    assert.equal(pixel.setF(223, [0, 0, 0, 0], 1), D3D_OK);
    assert.equal(pixel.setF(224, [0, 0, 0, 0], 1), D3DERR_INVALIDCALL);

    // A copy is a snapshot, not a view.
    const copy = file.copy();
    file.setF(0, [9, 9, 9, 9], 1);
    copy.getF(0, 1, out);
    assert.deepEqual([...(out.values ?? [])], [1, 2, 3, 4]);
});
