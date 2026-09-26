/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DECLARATION_END, constantsWithin, declarationLength, declaredShader, parseDeclaration,
    readableByFixedFunction, registerOf,
} from './declaration.js';
import { D3DDECLTYPE, D3DDECLUSAGE } from '../d3d9/declaration.js';
import { OPCODE, REGISTER, parseShader } from '../d3d9/shader.js';

/** D3DVSD_STREAM(stream). */
const stream = (/** @type {number} */ index)=>((1 << 29) | index) >>> 0;
/** D3DVSD_REG(register, type). */
const reg = (/** @type {number} */ register, /** @type {number} */ type)=>
    ((2 << 29) | (type << 16) | register) >>> 0;
/** D3DVSD_SKIP(dwords). */
const skip = (/** @type {number} */ dwords)=>((2 << 29) | 0x10000000 | (dwords << 16)) >>> 0;
/** D3DVSD_CONST(register, count). */
const constants = (/** @type {number} */ register, /** @type {number} */ count)=>
    ((4 << 29) | (count << 25) | register) >>> 0;

test('a declaration loads each register from its stream at the running offset', ()=>{
    const declaration = parseDeclaration([
        stream(0),
        reg(0, D3DDECLTYPE.FLOAT3),
        skip(1),
        reg(5, D3DDECLTYPE.D3DCOLOR),
        stream(1),
        reg(7, D3DDECLTYPE.FLOAT2),
        reg(3, D3DDECLTYPE.FLOAT3),
        DECLARATION_END,
        0x12345678,
    ]);
    assert.equal(declaration.error, null);
    assert.deepEqual(declaration.elements.map(element=>[element.Stream, element.Offset,
        element.Type, element.Usage, element.UsageIndex]), [
        [0, 0, D3DDECLTYPE.FLOAT3, D3DDECLUSAGE.POSITION, 0],
        [0, 16, D3DDECLTYPE.D3DCOLOR, D3DDECLUSAGE.COLOR, 0],
        [1, 0, D3DDECLTYPE.FLOAT2, D3DDECLUSAGE.TEXCOORD, 0],
        [1, 8, D3DDECLTYPE.FLOAT3, D3DDECLUSAGE.NORMAL, 0],
    ], 'a skip moves the offset on; a new stream starts it again');
    assert.equal(declaration.tokens.length, 8, 'the tokens end at the end token');
    assert.deepEqual(declaration.elements.map(registerOf), [0, 5, 7, 3]);
});

test('a declaration\'s constants are read beside it, whatever bits they hold', ()=>{
    const declaration = parseDeclaration([
        stream(0), reg(0, D3DDECLTYPE.FLOAT3),
        constants(4, 2), 0x3f800000, 0x40000000, 0x40400000, 0x40800000,
        DECLARATION_END, 0, 0, 0,
        DECLARATION_END,
    ]);
    assert.equal(declaration.error, null);
    assert.equal(declaration.constants.length, 1);
    assert.equal(declaration.constants[0].register, 4);
    assert.deepEqual([...declaration.constants[0].values.subarray(0, 4)], [1, 2, 3, 4]);
    assert.ok(Number.isNaN(declaration.constants[0].values[4]),
        'an end token\'s bits among the values are a value');
    assert.equal(declaration.tokens.length, 12);
    assert.equal(declarationLength(index=>[
        stream(0), constants(0, 1), DECLARATION_END, 0, 0, 0, DECLARATION_END,
    ][index] ?? 0), 7, 'and a reader one token at a time skips them the same way');
    assert.equal(declarationLength(()=>0), -1, 'no end token, no declaration');
});

test('a declaration that is not one says why', ()=>{
    assert.match(parseDeclaration([reg(0, D3DDECLTYPE.FLOAT3), DECLARATION_END]).error ?? '',
        /before any stream/);
    assert.match(parseDeclaration([stream(0), reg(0, 8), DECLARATION_END]).error ?? '',
        /type 8/, 'past the eight types this version names');
    assert.match(parseDeclaration([stream(0), reg(0, 2), reg(0, 2), DECLARATION_END]).error
        ?? '', /v0/, 'a register loaded twice');
    assert.match(parseDeclaration([stream(0), reg(0, 2)]).error ?? '', /no end token/);
    assert.match(parseDeclaration([(1 << 29 | 0x10000000) >>> 0, DECLARATION_END]).error ?? '',
        /tessellator/);
    assert.match(parseDeclaration([stream(0), constants(0, 1), 0, 0]).error ?? '',
        /past the end/);
});

test('a declaration made alone reads its normal as three floats', ()=>{
    // Wine's d3d8 test_shader: a normal in two or four floats, or a colour,
    // is refused without a function and accepted with one.
    for (const [type, readable] of [[D3DDECLTYPE.FLOAT3, true], [D3DDECLTYPE.FLOAT2, false],
        [D3DDECLTYPE.FLOAT4, false], [D3DDECLTYPE.D3DCOLOR, false]])
    {
        const declaration = parseDeclaration([
            stream(0), reg(0, D3DDECLTYPE.FLOAT3), reg(3, /** @type {number} */ (type)),
            DECLARATION_END,
        ]);
        assert.equal(readableByFixedFunction(declaration), readable, `normal of type ${type}`);
    }
});

test('a vs_1_1 function reads every input register as the usage its number names', ()=>{
    const parsed = parseShader([
        0xfffe0101,
        0x0000001f, 0x80000005, 0x900f0000,       // dcl_texcoord v0, the shader's own
        0x00000001, 0xc00f0000, 0x90e40000,       // mov oPos, v0
        0x00000001, 0xd00f0000, 0x90e40005,       // mov oD0, v5
        0x0000ffff,
    ]);
    assert.equal(parsed.error, null);
    const declared = declaredShader(parsed);
    const inputs = declared.instructions.filter(instruction=>
        instruction.opcode === OPCODE.DCL && instruction.dest?.type === REGISTER.INPUT);
    assert.equal(inputs.length, 16, 'v0 to v15, and the shader\'s own left out');
    assert.deepEqual(inputs[0].declaration, { usage: D3DDECLUSAGE.POSITION, usageIndex: 0 });
    assert.deepEqual(inputs[5].declaration, { usage: D3DDECLUSAGE.COLOR, usageIndex: 0 });
    assert.deepEqual(inputs[14].declaration, { usage: D3DDECLUSAGE.TEXCOORD, usageIndex: 7 });
    assert.deepEqual(inputs[15].declaration, { usage: D3DDECLUSAGE.POSITION, usageIndex: 1 });
    assert.equal(declared.instructions.length, 18, 'the body follows as it was');
});

test('a function naming a constant past the file is not one the device makes', ()=>{
    // Wine's d3d8 test_unsupported_shaders: on a device of 256, c255 is and
    // c256 is not.
    /** @param {number} register */
    const using = register=>parseShader([
        0xfffe0101,
        0x00000051, (0xa00f0000 | register) >>> 0, 0x3f800000, 0x3f800000, 0x3f800000,
        0x3f800000,
        0x00000002, 0x800f0000, 0x90e40000, (0xa0e40000 | register) >>> 0,
        0x00000001, 0xc00f0000, 0x80e40000,
        0x0000ffff,
    ]);
    assert.equal(constantsWithin(using(255), 256), true);
    assert.equal(constantsWithin(using(256), 256), false);
});
