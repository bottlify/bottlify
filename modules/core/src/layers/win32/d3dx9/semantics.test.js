/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShaderSemantics } from './semantics.js';
import { assembleShader } from './shader-asm.js';

// What Windows answers, as Wine's conformance test (d3dx9_36 test_shader_semantics) has it.

const VS_1_1 = [
    0xfffe0101,
    0x0000001f, 0x80000000, 0x900f0000,
    0x0000001f, 0x80000003, 0x900f0001,
    0x0000001f, 0x8001000a, 0x900f0002,
    0x0000001f, 0x80000005, 0x900f0003,
    0x00000001, 0xc00f0000, 0x90e40000,
    0x00000001, 0xd00f0001, 0x90e40002,
    0x00000001, 0xe0070000, 0x90e40001,
    0x00000001, 0xc00f0001, 0x90ff0002,
    0x00000001, 0xc00f0002, 0x90ff0001,
    0x0000ffff,
];
const VS_2_0 = [
    0xfffe0200,
    0x0200001f, 0x80000000, 0x900f0000,
    0x0200001f, 0x80000003, 0x900f0001,
    0x0200001f, 0x8001000a, 0x900f0002,
    0x0200001f, 0x80000005, 0x900f0003,
    0x02000001, 0xc00f0000, 0x90e40000,
    0x02000001, 0xd00f0001, 0x90e40002,
    0x02000001, 0xe0070000, 0x90e40003,
    0x02000001, 0xc00f0001, 0x90ff0002,
    0x02000001, 0xc00f0002, 0x90ff0001,
    0x0000ffff,
];
const VS_3_0 = [
    0xfffe0300,
    0x0002fffe, 0x0200000f, 0x00000000,
    0x0200001f, 0x80000000, 0x900f0000,
    0x0200001f, 0x80000003, 0x900f0001,
    0x0200001f, 0x8001000a, 0x900f0002,
    0x0200001f, 0x80000005, 0x900f0003,
    0x0200001f, 0x80000000, 0xe00f0000,
    0x0200001f, 0x8001000a, 0xe00f0001,
    0x0200001f, 0x80000005, 0xe00f0002,
    0x0200001f, 0x8000000b, 0xe00f0003,
    0x0200001f, 0x80000004, 0xe00f0004,
    0x02000001, 0xe00f0000, 0x90e40000,
    0x02000001, 0xe00f0001, 0x90e40002,
    0x02000001, 0xe0070002, 0x90e40003,
    0x02000001, 0xe00f0003, 0x90ff0002,
    0x02000001, 0xe00f0004, 0x90ff0001,
    0x0000ffff,
];
const PS_1_1 = [
    0xffff0101,
    0x00000042, 0xb00f0000,
    0x00000002, 0x800f0000, 0x90e40000, 0xb0e40000,
    0x0000ffff,
];
const PS_2_0 = [
    0xffff0200,
    0x0200001f, 0x80000000, 0x900f0000,
    0x0200001f, 0x80000000, 0xb00f0000,
    0x02000001, 0x800f0800, 0x90e40000,
    0x0000ffff,
];
const PS_3_0 = [
    0xffff0300,
    0x0200001f, 0x8001000a, 0x900f0000,
    0x0200001f, 0x80000003, 0x900f0001,
    0x0200001f, 0x80000005, 0x900f0002,
    0x0200001f, 0x8000000b, 0x900f0003,
    0x0200001f, 0x80000000, 0x90031000,
    0x0200001f, 0x80000000, 0x900f1001,
    0x05000051, 0xa00f0000, 0x00000000, 0x00000000, 0x00000000, 0x00000000,
    0x02000001, 0x800f0000, 0x90e40000,
    0x03000002, 0x800f0800, 0x80e40000, 0x90e40003,
    0x02000001, 0x800f0001, 0x90e40001,
    0x03000005, 0x800f0801, 0x80e40001, 0x90e40002,
    0x02000001, 0x800f0802, 0x90441000,
    0x04000058, 0x800f0803, 0x90e41001, 0x90e40000, 0xa0e40000,
    0x02000001, 0x900f0800, 0x90ff0001,
    0x0000ffff,
];

const VS_INPUT = [[0, 0], [3, 0], [10, 1], [5, 0]];
const CASES = [
    { name: 'vs_1_1', code: VS_1_1, input: VS_INPUT,
        output: [[5, 0], [10, 1], [0, 0], [11, 0], [4, 0]] },
    { name: 'vs_2_0', code: VS_2_0, input: VS_INPUT,
        output: [[5, 0], [10, 1], [0, 0], [11, 0], [4, 0]] },
    { name: 'vs_3_0', code: VS_3_0, input: VS_INPUT,
        output: [[0, 0], [10, 1], [5, 0], [11, 0], [4, 0]] },
    { name: 'ps_1_1', code: PS_1_1, input: [[5, 0], [10, 0]], output: [[10, 0]] },
    { name: 'ps_2_0', code: PS_2_0, input: [[10, 0], [5, 0]], output: [[10, 0]] },
    { name: 'ps_3_0', code: PS_3_0, input: [[10, 1], [3, 0], [5, 0], [11, 0]],
        output: [[10, 0], [10, 1], [10, 2], [10, 3], [12, 0]] },
];

const CODE = 0x1000;
const OUT = 0x8000;
const COUNT = 0x9000;

/** A flat guest memory with the bytecode at CODE. @param {number[]} code */
function machine(code){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    code.forEach((word, i)=>view.setUint32(CODE + i * 4, word >>> 0, true));
    view.setUint32(COUNT, 0xdeadbeef, true);
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>memory.slice(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>memory.set(bytes, at),
    };
    return { api: createShaderSemantics(host), view };
}

/** @param {DataView} view @param {number} count */
function read(view, count){
    return Array.from({ length: count }, (_, i)=>[view.getUint32(OUT + i * 8, true),
        view.getUint32(OUT + i * 8 + 4, true)]);
}

for (const { name, code, input, output } of CASES)
{
    test(`semantics: ${name} inputs and outputs as Windows gives them`, ()=>{
        const { api, view } = machine(code);
        for (const [entry, expected] of /** @type {const} */ ([
            [api.D3DXGetShaderInputSemantics, input], [api.D3DXGetShaderOutputSemantics, output]]))
        {
            assert.equal(entry.handler([CODE, 0, COUNT]), 0);
            assert.equal(view.getUint32(COUNT, true), expected.length);
            assert.equal(entry.handler([CODE, OUT, COUNT]), 0);
            assert.deepEqual(read(view, expected.length), expected);
        }
    });
}

test('semantics: NULL code is INVALIDCALL, a stream that is no shader INVALIDDATA', ()=>{
    const { api } = machine([0x00000200]);
    assert.equal(api.D3DXGetShaderInputSemantics.handler([0, 0, 0]), 0x8876086c);
    assert.equal(api.D3DXGetShaderInputSemantics.handler([CODE, 0, 0]), 0x88760b59);
    assert.equal(api.D3DXGetShaderOutputSemantics.handler([CODE, 0, 0]), 0x88760b59);
});

test('semantics: an unknown version and an empty one answer D3D_OK with nothing', ()=>{
    for (const code of [[0xfffe0400, 0x0000ffff], [0xfffe0000, 0x0000ffff]])
    {
        const { api, view } = machine(code);
        assert.equal(api.D3DXGetShaderInputSemantics.handler([CODE, 0, COUNT]), 0);
        assert.equal(view.getUint32(COUNT, true), 0);
    }
});

test('semantics: neither out-pointer is needed', ()=>{
    const { api } = machine(VS_1_1);
    assert.equal(api.D3DXGetShaderInputSemantics.handler([CODE, 0, 0]), 0);
    assert.equal(api.D3DXGetShaderInputSemantics.handler([CODE, OUT, 0]), 0);
});

test('semantics: assembled vs_1_1 with definitions and a texture coordinate written twice', ()=>{
    const { tokens, errors } = assembleShader('vs_1_1\ndcl_position v0\ndcl_texcoord2 v1\n'
        + 'def c0, 1, 2, 3, 4\nmov oT3, v1\nmov oPos, v0\nmov oT1, v1\nmov oT3, v0\n');
    assert.deepEqual(errors, []);
    assert.ok(tokens);
    const { api, view } = machine([...tokens]);
    assert.equal(api.D3DXGetShaderInputSemantics.handler([CODE, OUT, COUNT]), 0);
    assert.deepEqual(read(view, view.getUint32(COUNT, true)), [[0, 0], [5, 2]]);
    assert.equal(api.D3DXGetShaderOutputSemantics.handler([CODE, OUT, COUNT]), 0);
    assert.deepEqual(read(view, view.getUint32(COUNT, true)), [[5, 1], [5, 3], [0, 0]]);
});

test('D3DXGetShaderVersion is the first token, and 0 for no shader', ()=>{
    // A vertex shader that opens with its constant table comment, as a
    // compiled one does: the version is still the word before it.
    const { api } = machine([0xfffe0101, 0x0002fffe, 0x42415443, 0x1c, 0x0000ffff]);
    assert.equal(api.D3DXGetShaderVersion.argBytes, 4);
    assert.equal(api.D3DXGetShaderVersion.handler([CODE]), 0xfffe0101);
    assert.equal(api.D3DXGetShaderVersion.handler([0]), 0);
    assert.equal(machine([0xffff0300]).api.D3DXGetShaderVersion.handler([CODE]), 0xffff0300);
});
