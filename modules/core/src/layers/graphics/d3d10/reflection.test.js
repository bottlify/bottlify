/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E_FAIL, E_INVALIDARG, IID, S_OK } from './constants.js';
import { parseDxbc } from './dxbc.js';
import {
    SHADER_DESC_FIELDS, containerOf, createBlob, createShaderReflection, debugInfoOf,
    reflectShader,
} from './reflection.js';
import { container, passThroughVertexShader, solidPixelShader } from './shader-fixtures.js';

const CREATOR = 'Microsoft (R) HLSL Shader Compiler 9.29.952.3111';

/**
 * @typedef {Object} Binding
 * @property {string} name
 * @property {number} type
 * @property {number} [returnType]
 * @property {number} [dimension]
 * @property {number} [samples]
 * @property {number} bindPoint
 * @property {number} [bindCount]
 * @property {number} [flags]
 */

/**
 * A resource-definition chunk laid out as a compiler lays it out: seven
 * dwords of header (constant buffer count and offset, binding count and
 * offset, target, flags, creator offset), the constant buffers at 24 bytes,
 * the bindings at 32, then the strings.
 *
 * @param {{ buffers?: { name: string, variables: number, size: number }[],
 *           bindings?: Binding[], target: number, flags: number, creator?: string }} spec
 */
function definitions(spec){
    const buffers = spec.buffers ?? [];
    const bindings = spec.bindings ?? [];
    const bindingsAt = 28;
    const buffersAt = bindingsAt + bindings.length * 32;
    let stringsAt = buffersAt + buffers.length * 24;
    /** @type {number[]} */
    const bytes = [];
    /** @type {Map<string, number>} */
    const strings = new Map();
    /** @param {string} text */
    const stringAt = text=>{
        if (!strings.has(text))
        {
            strings.set(text, stringsAt);
            stringsAt += text.length + 1;
        }
        return /** @type {number} */ (strings.get(text));
    };
    /** @param {number[]} words */
    const put = words=>{
        for (const word of words)
        {
            bytes.push(word & 0xff, word >>> 8 & 0xff, word >>> 16 & 0xff, word >>> 24 & 0xff);
        }
    };
    const bindingWords = bindings.map(entry=>[stringAt(entry.name), entry.type,
        entry.returnType ?? 0, entry.dimension ?? 0, entry.samples ?? 0, entry.bindPoint,
        entry.bindCount ?? 1, entry.flags ?? 0]);
    const bufferWords = buffers.map(entry=>[stringAt(entry.name), entry.variables, 0, entry.size,
        0, 0]);
    const creator = spec.creator === undefined ? 0 : stringAt(spec.creator);
    put([buffers.length, buffers.length ? buffersAt : 0, bindings.length, bindingsAt, spec.target,
        spec.flags, creator]);
    bindingWords.forEach(put);
    bufferWords.forEach(put);
    for (const text of strings.keys())
    {
        bytes.push(...[...text].map(char=>char.charCodeAt(0)), 0);
    }
    while (bytes.length % 4 !== 0)
    {
        bytes.push(0xab);
    }
    return Uint8Array.from(bytes);
}

/** @param {number[]} words */
function dwords(words){
    const bytes = new Uint8Array(words.length * 4);
    const view = new DataView(bytes.buffer);
    words.forEach((word, index)=>view.setUint32(index * 4, word, true));
    return bytes;
}

/**
 * A compiled program's chunks with the tools' chunks put back around them.
 *
 * @param {Uint8Array} program  A container from the assembler.
 * @param {{ name: string, bytes: Uint8Array }[]} before
 * @param {{ name: string, bytes: Uint8Array }[]} [after]
 */
function withChunks(program, before, after = []){
    const parsed = parseDxbc(program);
    assert.ok(parsed);
    const own = ['ISGN', 'OSGN', 'SHDR'].map(name=>({
        name, bytes: /** @type {Uint8Array} */ (parsed.chunks.get(name)),
    }));
    return container([...before, ...own, ...after]);
}

/** @param {Uint8Array} bytes @param {number} at */
const stringIn = (bytes, at)=>{
    let end = at;
    while (bytes[end] !== 0)
    {
        end++;
    }
    return String.fromCharCode(...bytes.subarray(at, end));
};

test('a reflection reports what the compiler recorded, and the program its signatures', ()=>{
    // The counts a compiler writes into STAT, in its order: 21 instructions,
    // 1 temp, 0 defs, 18 declarations, then float/int/uint, static and
    // dynamic flow, macros, temp arrays, array instructions, cut, emit, the
    // five texture counts; three more the Direct3D 10 description has no
    // field for follow. The expectations are Wine's d3dcompiler
    // test_reflection_desc_vs, for the statistics of its vs_4_1 program.
    const statistics = [21, 1, 0, 18, 0, 1, 1, 1, 0, 0, 5, 6, 0, 0, 0, 0, 0, 0, 0, 10, 0, 2,
        0, 0, 0, 0, 0, 0, 0];
    const bytes = withChunks(passThroughVertexShader(), [{
        name: 'RDEF', bytes: definitions({ target: 0xfffe0400, flags: 0x100, creator: CREATOR }),
    }], [{ name: 'STAT', bytes: dwords(statistics) }]);
    const reflection = reflectShader(bytes);
    assert.ok(reflection);
    const { desc } = reflection;
    assert.equal(desc.Version, 0x10040, 'a vertex program of model 4.0');
    assert.equal(stringIn(bytes, desc.Creator), CREATOR, 'where the creator string sits');
    assert.equal(desc.Flags, 0x100);
    assert.deepEqual([desc.ConstantBuffers, desc.BoundResources, desc.InputParameters,
        desc.OutputParameters], [0, 0, 1, 1]);
    assert.deepEqual([desc.InstructionCount, desc.TempRegisterCount, desc.TempArrayCount,
        desc.DefCount, desc.DclCount], [21, 1, 5, 0, 18]);
    assert.deepEqual([desc.FloatInstructionCount, desc.IntInstructionCount,
        desc.UintInstructionCount, desc.StaticFlowControlCount, desc.DynamicFlowControlCount,
        desc.MacroInstructionCount, desc.ArrayInstructionCount], [0, 1, 1, 1, 0, 0, 6]);
    assert.deepEqual([desc.GSOutputTopology, desc.GSMaxOutputVertexCount], [0, 0]);
    assert.deepEqual(Object.keys(desc).sort(), [...SHADER_DESC_FIELDS].sort(),
        'every field of D3D10_SHADER_DESC, and nothing else');

    const [input] = reflection.inputs;
    assert.equal(stringIn(bytes, input.nameAt), 'POSITION');
    assert.deepEqual([input.index, input.register, input.systemValue, input.mask,
        input.readWriteMask], [0, 0, 0, 0xf, 0xf]);
    const [output] = reflection.outputs;
    assert.equal(stringIn(bytes, output.nameAt), 'SV_POSITION');
    assert.equal(output.systemValue, 1, 'D3D10_NAME_POSITION');
});

test('the resources a program binds are reported with their slots and shapes', ()=>{
    // After Wine's d3dcompiler test_reflection_bound_resources: a sampler, a
    // two-slot texture array, a texture and two constant buffers.
    const bindings = [
        { name: 'sam', type: 3, bindPoint: 0 },
        { name: 'tex1', type: 2, returnType: 5, dimension: 4, samples: 0xffffffff, bindPoint: 0,
            bindCount: 2, flags: 12 },
        { name: 'tex2', type: 2, returnType: 5, dimension: 4, samples: 0xffffffff, bindPoint: 2,
            flags: 12 },
        { name: 'c1', type: 0, bindPoint: 0 },
        { name: 'c2', type: 0, bindPoint: 1 },
    ];
    const bytes = withChunks(solidPixelShader([1, 0, 0, 1]), [{
        name: 'RDEF', bytes: definitions({
            target: 0xffff0400, flags: 0x100, bindings,
            buffers: [
                { name: 'c1', variables: 3, size: 48 }, { name: 'c2', variables: 1, size: 16 },
            ],
        }),
    }]);
    const reflection = reflectShader(bytes);
    assert.ok(reflection);
    assert.equal(reflection.desc.Version, 0x40, 'a pixel program of model 4.0');
    assert.equal(reflection.desc.BoundResources, 5);
    assert.equal(reflection.desc.ConstantBuffers, 2);
    assert.equal(reflection.desc.Creator, -1, 'a creator offset of zero is no creator');
    assert.deepEqual(reflection.bindings.map(entry=>stringIn(bytes, entry.nameAt)),
        ['sam', 'tex1', 'tex2', 'c1', 'c2']);
    const tex1 = reflection.bindings[1];
    assert.deepEqual([tex1.type, tex1.bindPoint, tex1.bindCount, tex1.flags, tex1.returnType,
        tex1.dimension, tex1.sampleCount], [2, 0, 2, 12, 5, 4, 0xffffffff]);
    assert.deepEqual(reflection.constantBuffers.map(entry=>[entry.name, entry.variables,
        entry.size]), [['c1', 3, 48], ['c2', 1, 16]]);
    assert.equal(reflection.desc.InstructionCount, 0, 'no STAT chunk: no counts');
});

test('a geometry shader reports the topology and vertex count it declares', ()=>{
    // dcl_outputtopology trianglestrip, dcl_maxout 3, ret.
    const program = dwords([(2 << 16) | 0x40, 6, (92 | (5 << 11) | (1 << 24)) >>> 0,
        (94 | (2 << 24)) >>> 0, 3, (62 | (1 << 24)) >>> 0]);
    const reflection = reflectShader(container([{ name: 'SHDR', bytes: program }]));
    assert.ok(reflection);
    assert.equal(reflection.desc.Version, 0x20040);
    assert.equal(reflection.desc.GSOutputTopology, 5, 'D3D10_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP');
    assert.equal(reflection.desc.GSMaxOutputVertexCount, 3);
});

test('signature blobs are containers of the signature chunks alone', ()=>{
    // After Wine's d3dcompiler test_get_blob_part: the tag at dword 9 for one
    // chunk, at dwords 10 and 10 + the first chunk's dwords for two.
    const bytes = withChunks(passThroughVertexShader(), [{
        name: 'RDEF', bytes: definitions({ target: 0xfffe0400, flags: 0, creator: CREATOR }),
    }], [{ name: 'SDBG', bytes: dwords([7, 8]) }]);
    const parsed = parseDxbc(bytes);
    assert.ok(parsed);
    const inputs = /** @type {Uint8Array} */ (parsed.chunks.get('ISGN'));
    const outputs = /** @type {Uint8Array} */ (parsed.chunks.get('OSGN'));
    const word = (/** @type {Uint8Array} */ blob, /** @type {number} */ index)=>
        new DataView(blob.buffer, blob.byteOffset).getUint32(index * 4, true);
    const TAG = { DXBC: 0x43425844, ISGN: 0x4e475349, OSGN: 0x4e47534f };

    const input = containerOf(bytes, ['ISGN']);
    assert.ok(input);
    assert.equal(input.length, 32 + 4 + 8 + inputs.length);
    assert.deepEqual([word(input, 0), word(input, 5), word(input, 6), word(input, 7)],
        [TAG.DXBC, 1, input.length, 1]);
    assert.equal(word(input, 9), TAG.ISGN);
    assert.deepEqual(parseDxbc(input)?.inputs, parsed.inputs, 'the same elements');

    const output = containerOf(bytes, ['OSGN']);
    assert.ok(output);
    assert.equal(word(output, 9), TAG.OSGN);

    const both = containerOf(bytes, ['ISGN', 'OSGN']);
    assert.ok(both);
    assert.equal(both.length, 32 + 8 + 16 + inputs.length + outputs.length);
    assert.equal(word(both, 10), TAG.ISGN);
    assert.equal(word(both, 10 + 2 + inputs.length / 4), TAG.OSGN);

    assert.equal(containerOf(bytes, ['PCSG']), null, 'a chunk the program does not have');
    assert.equal(containerOf(new Uint8Array(64), ['ISGN']), null, 'no container at all');
    assert.deepEqual([...(debugInfoOf(bytes) ?? [])], [...dwords([7, 8])]);
    assert.equal(debugInfoOf(passThroughVertexShader()), null);
});

test('the reflection object answers the runtime codes for a missing structure or index', ()=>{
    const bytes = withChunks(passThroughVertexShader(), [{
        name: 'RDEF', bytes: definitions({ target: 0xfffe0400, flags: 0, creator: CREATOR,
            bindings: [{ name: 'c', type: 0, bindPoint: 3 }] }),
    }]);
    const parsed = reflectShader(bytes);
    assert.ok(parsed);
    let released = false;
    const reflection = createShaderReflection(parsed, ()=>{
        released = true;
    });
    assert.ok(reflection.supports(IID.ID3D10ShaderReflection));
    assert.equal(reflection.GetDesc(null), E_FAIL, 'as Wine test_reflection_desc_vs has it');
    /** @type {{ desc?: Record<string, number> }} */
    const desc = {};
    assert.equal(reflection.GetDesc(desc), S_OK);
    assert.equal(desc.desc?.BoundResources, 1);
    /** @type {{ entry?: any }} */
    const entry = {};
    assert.equal(reflection.GetResourceBindingDesc(0, null), E_INVALIDARG);
    assert.equal(reflection.GetResourceBindingDesc(0xffffffff, entry), E_INVALIDARG);
    assert.equal(reflection.GetResourceBindingDesc(0, entry), S_OK);
    assert.equal(entry.entry.bindPoint, 3);
    assert.equal(reflection.GetInputParameterDesc(1, entry), E_INVALIDARG);
    assert.equal(reflection.GetOutputParameterDesc(0, entry), S_OK);
    assert.equal(reflection.release(), 0);
    assert.ok(released, 'the last release lets the copy go');
});

test('a blob is its memory and its length, and lets the memory go with its last reference', ()=>{
    let freed = 0;
    const blob = createBlob(0x1000, 12, ()=>{
        freed++;
    });
    assert.ok(blob.supports(IID.ID3D10Blob));
    assert.equal(blob.GetBufferPointer(), 0x1000);
    assert.equal(blob.GetBufferSize(), 12);
    blob.addRef();
    blob.release();
    assert.equal(freed, 0);
    blob.release();
    assert.equal(freed, 1);
});
