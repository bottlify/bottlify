/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHADER_KIND } from './dxbc.js';
import {
    CUSTOMDATA, MODIFIER, OPCODE, OPERAND, RESOURCE_DIMENSION, RETURN_TYPE, SELECTION,
    decodeOperand, decodeSm4, registerName,
} from './sm4.js';
import { parseDxbc } from './dxbc.js';
import {
    add, assemble, cb, dclConstantBuffer, dclResource, dclSampler, dclTemps, ifNz, imul,
    immediateConstantBuffer, indexedBy, l, lu, mad, modified, mov, nullDest, o, r, ret, s, sample,
    t, v,
} from './shader-fixtures.js';

/** @param {(import('./shader-fixtures.js').AsmInstruction | { customData: number[] })[]} instructions */
function decode(instructions){
    const parsed = parseDxbc(assemble({ kind: SHADER_KIND.PIXEL, instructions }));
    assert.ok(parsed && parsed.shader);
    return decodeSm4(parsed.shader.tokens);
}

test('a destination carries a write mask and a source a swizzle', ()=>{
    const [instruction] = decode([mov(r(0, 'xz'), v(1, 'wzyx'))]);
    assert.equal(instruction.opcode, OPCODE.MOV);
    assert.equal(instruction.name, 'mov');
    assert.equal(instruction.length, 5);
    const [dest, source] = instruction.operands;
    assert.equal(dest.type, OPERAND.TEMP);
    assert.equal(dest.selection, SELECTION.MASK);
    assert.equal(dest.mask, 0b0101);
    assert.deepEqual(dest.indices, [{ value: 0, relative: null }]);
    assert.equal(source.type, OPERAND.INPUT);
    assert.equal(source.selection, SELECTION.SWIZZLE);
    assert.deepEqual(source.swizzle, [3, 2, 1, 0]);
    assert.equal(registerName(dest), 'r0');
    assert.equal(registerName(source), 'v1');
});

test('a short swizzle repeats its last component, as the assembler writes .xyxx', ()=>{
    const [instruction] = decode([mov(r(0), v(0, 'xy'))]);
    assert.deepEqual(instruction.operands[1].swizzle, [0, 1, 1, 1]);
});

test('an immediate carries its dwords, one or four of them', ()=>{
    const [four, one] = decode([mov(r(0), l(1, 0.5, 0, -1)), mov(r(1), lu(7))]);
    assert.equal(four.operands[1].type, OPERAND.IMMEDIATE32);
    assert.equal(four.operands[1].componentCount, 4);
    assert.deepEqual(four.operands[1].immediate, [0x3f800000, 0x3f000000, 0, 0xbf800000]);
    assert.equal(one.operands[1].componentCount, 1);
    assert.deepEqual(one.operands[1].immediate, [7]);
});

test('a modifier arrives through an extended operand token', ()=>{
    const [instruction] = decode([add(r(0), modified(r(1), MODIFIER.NEG),
        modified(r(2), MODIFIER.ABS))]);
    assert.equal(instruction.operands[1].modifier, MODIFIER.NEG);
    assert.equal(instruction.operands[2].modifier, MODIFIER.ABS);
    assert.equal(instruction.operands[0].modifier, MODIFIER.NONE);
    assert.equal(instruction.length, 1 + 2 + 3 + 3);
});

test('a constant buffer operand has two indices and the second may be relative', ()=>{
    const [direct, relative] = decode([
        mov(r(0), cb(1, 5)),
        mov(r(0), indexedBy(cb(0, 2), r(3, 'y'))),
    ]);
    assert.deepEqual(direct.operands[1].indices,
        [{ value: 1, relative: null }, { value: 5, relative: null }]);
    const index = relative.operands[1].indices[1];
    assert.equal(index.value, 2);
    assert.ok(index.relative);
    assert.equal(index.relative.type, OPERAND.TEMP);
    assert.equal(index.relative.swizzle[0], 1, 'the y component');
    assert.equal(registerName(relative.operands[1]), 'cb0');
});

test('declarations keep what follows their operand', ()=>{
    const [temps, buffer, sampler, resource] = decode([
        dclTemps(3),
        dclConstantBuffer(2, 8),
        dclSampler(1),
        dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.FLOAT),
    ]);
    assert.equal(temps.opcode, OPCODE.DCL_TEMPS);
    assert.deepEqual(temps.extra, [3]);
    assert.equal(buffer.operands[0].indices[0].value, 2);
    assert.equal(buffer.operands[0].indices[1].value, 8);
    assert.equal(sampler.operands[0].type, OPERAND.SAMPLER);
    assert.equal(sampler.operands[0].componentCount, 0);
    assert.equal(resource.control, RESOURCE_DIMENSION.TEXTURE2D);
    assert.equal(resource.extra[0] & 0xf, RETURN_TYPE.FLOAT);
});

test('the conditional forms carry their test in the opcode token', ()=>{
    const [branch] = decode([ifNz(r(0, 'x'))]);
    assert.equal(branch.opcode, OPCODE.IF);
    assert.equal(branch.testNonZero, true);
    assert.equal(branch.operands.length, 1);
});

test('a two-destination instruction and a null destination decode as such', ()=>{
    const [instruction] = decode([imul(nullDest(), r(0), r(1), r(2))]);
    assert.equal(instruction.operands.length, 4);
    assert.equal(instruction.operands[0].type, OPERAND.NULL);
    assert.equal(instruction.operands[1].type, OPERAND.TEMP);
});

test('a sample names its texture with a swizzle and its sampler without one', ()=>{
    const [instruction] = decode([sample(r(0), v(1, 'xy'), t(0, 'wzyx'), s(0))]);
    assert.equal(instruction.operands[2].type, OPERAND.RESOURCE);
    assert.deepEqual(instruction.operands[2].swizzle, [3, 2, 1, 0]);
    assert.equal(instruction.operands[3].type, OPERAND.SAMPLER);
    assert.equal(registerName(instruction.operands[3]), 's0');
});

test('an immediate constant buffer is a customdata block with its own length', ()=>{
    const [block, after] = decode([
        immediateConstantBuffer([[1, 2, 3, 4], [5, 6, 7, 8]]),
        mov(o(0), lu(0)),
    ]);
    assert.equal(block.opcode, OPCODE.CUSTOMDATA);
    assert.equal(block.control, CUSTOMDATA.IMMEDIATE_CONSTANT_BUFFER);
    assert.deepEqual(block.customData, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(block.length, 10);
    assert.equal(after.opcode, OPCODE.MOV, 'decoding resumes after the block');
});

test('an unknown opcode is skipped by its length and named by its number', ()=>{
    // Opcode 200 is beyond anything Shader Model 4 defines; length 3 with two
    // dwords of whatever, then a mov that must still be found.
    const tokens = Uint32Array.from([
        (3 << 24) | 200, 0xdeadbeef, 0xcafebabe,
        ...decodeAsTokens([mad(r(0), r(1), r(2), r(3)), ret()]),
    ]);
    const decoded = decodeSm4(tokens);
    assert.equal(decoded.length, 3);
    assert.equal(decoded[0].name, 'opcode_200');
    assert.equal(decoded[1].opcode, OPCODE.MAD);
    assert.equal(decoded[1].operands.length, 4);
    assert.equal(decoded[2].opcode, OPCODE.RET);
});

test('an operand can be decoded on its own from any position', ()=>{
    const tokens = Uint32Array.from(decodeAsTokens([mov(r(2, 'w'), l(0.25))]));
    const { operand, next } = decodeOperand(tokens, 1);
    assert.equal(operand.type, OPERAND.TEMP);
    assert.equal(operand.mask, 0b1000);
    assert.equal(next, 3);
    const source = decodeOperand(tokens, next);
    assert.deepEqual(source.operand.immediate, [0x3e800000]);
    assert.equal(source.next, tokens.length);
});

/** @param {import('./shader-fixtures.js').AsmInstruction[]} instructions */
function decodeAsTokens(instructions){
    const parsed = parseDxbc(assemble({ kind: SHADER_KIND.PIXEL, instructions }));
    assert.ok(parsed && parsed.shader);
    return [...parsed.shader.tokens];
}
