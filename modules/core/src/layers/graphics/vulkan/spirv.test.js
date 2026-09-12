/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    EXECUTION_MODELS, NAMED_CAPABILITIES, Op, SPIRV_MAGIC, SUPPORTED_CAPABILITIES, decodeSpirv,
    literalString, unsupportedCapabilities, versionString,
} from './spirv.js';

/** @param {number} opcode @param {number[]} operands */
const instruction = (opcode, operands)=>[((operands.length + 1) << 16) | opcode, ...operands];

/** A string as SPIR-V words: UTF-8, NUL-terminated, padded to a word. */
const words = (/** @type {string} */ text)=>{
    const bytes = [...new TextEncoder().encode(text), 0];
    while (bytes.length % 4 !== 0)
    {
        bytes.push(0);
    }
    const out = [];
    for (let at = 0; at < bytes.length; at += 4)
    {
        out.push((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
            | (bytes[at + 3] << 24)) >>> 0);
    }
    return out;
};

/** @param {number[]} body @param {number} [magic] */
const encode = (body, magic = SPIRV_MAGIC)=>{
    const all = [magic, 0x00010300, 0x000d000a, 20, 0, ...body];
    const bytes = new Uint8Array(all.length * 4);
    const view = new DataView(bytes.buffer);
    all.forEach((word, index)=>view.setUint32(index * 4, word >>> 0, true));
    return bytes;
};

const OpMemoryModel = 14;
const OpTypeVoid = 19;

test('a literal string ends at its NUL, whether that falls inside a word or in a pad word', ()=>{
    assert.deepEqual(literalString([...words('abc'), 7], 0), { text: 'abc', next: 1 });
    assert.deepEqual(literalString([...words('main'), 7], 0), { text: 'main', next: 2 });
    assert.deepEqual(literalString([5, ...words('main'), 7, 8], 1), { text: 'main', next: 3 });
    assert.deepEqual(literalString([0], 0), { text: '', next: 1 });
});

test('the header and the instruction stream decode, with capabilities and entry points', ()=>{
    const decoded = decodeSpirv(encode([
        ...instruction(Op.Capability, [1]),
        ...instruction(Op.Capability, [0]),
        ...instruction(OpMemoryModel, [0, 1]),
        ...instruction(Op.EntryPoint, [0, 4, ...words('main'), 9, 11]),
        ...instruction(Op.EntryPoint, [4, 5, ...words('frag'), 12]),
        ...instruction(OpTypeVoid, [2]),
    ]));
    assert.ok('module' in decoded);
    const { module } = decoded;
    assert.equal(versionString(module.version), '1.3');
    assert.equal(module.bound, 20);
    assert.deepEqual(module.capabilities, [1, 0]);
    assert.deepEqual(module.entryPoints, [
        { model: 0, id: 4, name: 'main', interfaces: [9, 11] },
        { model: 4, id: 5, name: 'frag', interfaces: [12] },
    ]);
    assert.equal(module.instructions.length, 6);
    assert.deepEqual(module.instructions[5], { opcode: OpTypeVoid, operands: [2] });
    assert.equal(EXECUTION_MODELS[module.entryPoints[0].model], 'Vertex');
    assert.deepEqual(unsupportedCapabilities(module), []);
});

test('what is not a module is said: the size, the magic, a length that overruns', ()=>{
    assert.deepEqual(decodeSpirv(new Uint8Array(19)),
        { error: '19 bytes is not a whole number of words with a header' });
    assert.deepEqual(decodeSpirv(encode([], 0x12345678)),
        { error: "the magic number is 0x12345678, not SPIR-V's" });
    assert.deepEqual(decodeSpirv(encode([(9 << 16) | Op.Capability, 1])),
        { error: 'instruction at word 5 claims 9 words; 2 remain' });
    assert.deepEqual(decodeSpirv(encode([Op.Capability])),
        { error: 'instruction at word 5 claims 0 words; 1 remain' });
    assert.ok('module' in decodeSpirv(encode([])), 'a header alone is a module');
});

test('a capability WebGPU cannot honour is named; an unknown one is numbered', ()=>{
    const decoded = decodeSpirv(encode([
        ...instruction(Op.Capability, [1]),
        ...instruction(Op.Capability, [2]),
        ...instruction(Op.Capability, [10]),
        ...instruction(Op.Capability, [4439]),
        ...instruction(Op.Capability, [9999]),
    ]));
    assert.ok('module' in decoded);
    assert.deepEqual(unsupportedCapabilities(decoded.module),
        ['Geometry', 'Float64', 'MultiView', 'capability 9999']);
    // Every supported capability is also named, and the two tables agree.
    for (const [number, name] of Object.entries(SUPPORTED_CAPABILITIES))
    {
        assert.equal(NAMED_CAPABILITIES[Number(number)], name);
    }
    assert.equal(NAMED_CAPABILITIES[3], 'Tessellation');
    assert.equal(NAMED_CAPABILITIES[34], 'ImageCubeArray');
    assert.equal(NAMED_CAPABILITIES[40], 'InputAttachment');
});
