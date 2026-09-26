/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ASSIGNMENT, CONSTANT_TYPE, D3D10_SVC, D3D10_SVT, FX_VERSION, parseEffect,
} from './effect.js';
import { FX_KIND, effectBinary } from './effect-fixtures.js';
import { parseDxbc } from './dxbc.js';
import { container, passThroughVertexShader, solidPixelShader } from './shader-fixtures.js';

/** @param {Uint8Array} bytes */
const effectOf = bytes=>{
    const result = parseEffect(bytes);
    assert.ok('effect' in result, 'error' in result ? result.error : '');
    return result.effect;
};

/** @param {Uint8Array} block @param {number} at */
const stringIn = (block, at)=>{
    let end = at;
    while (block[end] !== 0)
    {
        end++;
    }
    return String.fromCharCode(...block.subarray(at, end));
};

/** @param {Uint8Array | null} bytes */
const dwordsOf = bytes=>(bytes
    ? [...new Uint32Array(bytes.slice().buffer)]
    : null);

const STRING = { name: 'String', object: FX_KIND.STRING };

test('a constant buffer\'s variables are read with their types, sizes and defaults', ()=>{
    // The buffer of Wine's d3d10 test_effect_variable_type_class: a float, an
    // int2, a column-major uint2x3 and a row-major bool2x3, the buffer
    // annotated with two strings; and a float4 with a default value.
    const effect = effectOf(effectBinary({ buffers: [{
        name: 'cb', size: 96,
        annotations: [{ name: 's', type: STRING, strings: ['STRING'] },
            { name: 's2', type: STRING, strings: ['STRING'] }],
        variables: [
            { name: 'f', offset: 0,
                type: { name: 'float', numeric: { layout: 'scalar', base: 'float' } } },
            { name: 'i', offset: 4, semantic: 'COLOR0',
                type: { name: 'int2', numeric: { layout: 'vector', base: 'int', columns: 2 } } },
            { name: 'u', offset: 16, type: { name: 'uint2x3',
                numeric: { layout: 'matrix', base: 'uint', rows: 2, columns: 3 } } },
            { name: 'b', offset: 64, type: { name: 'bool2x3',
                numeric: { layout: 'matrix', base: 'bool', rows: 2, columns: 3,
                    rowMajor: true } } },
        ],
    }, { name: 'defaults', size: 16, variables: [
        { name: 'fv', offset: 0, defaultValue: [0x3f000000, 0x3f19999a, 0x3f333333, 0x3f4ccccd],
            type: { name: 'float4', numeric: { layout: 'vector', base: 'float', columns: 4 } } },
    ] }] }));
    assert.equal(effect.version, FX_VERSION.FX_4_0);
    const [cb, defaults] = effect.buffers;
    assert.deepEqual([cb.name, cb.size, cb.bindPoint, cb.textureBuffer], ['cb', 96, -1, false]);
    assert.deepEqual(cb.annotations.map(entry=>[entry.name, entry.type.svt,
        stringIn(effect.unstructured, entry.strings[0])]),
    [['s', D3D10_SVT.STRING, 'STRING'], ['s2', D3D10_SVT.STRING, 'STRING']]);
    assert.deepEqual(cb.variables.map(({ name, bufferOffset, semantic, type })=>[name,
        bufferOffset, semantic, type.name, type.svc, type.svt, type.rows, type.columns,
        type.packedSize, type.unpackedSize, type.stride]), [
        ['f', 0, null, 'float', D3D10_SVC.SCALAR, D3D10_SVT.FLOAT, 1, 1, 4, 4, 16],
        ['i', 4, 'COLOR0', 'int2', D3D10_SVC.VECTOR, D3D10_SVT.INT, 1, 2, 8, 8, 16],
        ['u', 16, null, 'uint2x3', D3D10_SVC.MATRIX_COLUMNS, D3D10_SVT.UINT, 2, 3, 24, 40, 48],
        ['b', 64, null, 'bool2x3', D3D10_SVC.MATRIX_ROWS, D3D10_SVT.BOOL, 2, 3, 24, 28, 32],
    ], 'the sizes Wine\'s test expects of each');
    assert.equal(stringIn(effect.unstructured, cb.variables[1].nameAt), 'i');
    assert.equal(cb.variables[0].defaultValue, null);
    assert.deepEqual(dwordsOf(defaults.variables[0].defaultValue),
        [0x3f000000, 0x3f19999a, 0x3f333333, 0x3f4ccccd]);
});

test('object variables are read with their kind, and a shader, string or state per element',
    ()=>{
        const vs = passThroughVertexShader();
        const gs = solidPixelShader([1, 0, 0, 1]);
        const effect = effectOf(effectBinary({ objects: [
            { name: 'name', type: STRING, elements: [{ string: 'hello' }] },
            { name: 't2', type: { name: 'Texture2D', object: FX_KIND.TEXTURE2D } },
            { name: 'cube', type: { name: 'TextureCube', object: FX_KIND.TEXTURECUBE,
                elements: 3 } },
            { name: 'v', type: { name: 'VertexShader', object: FX_KIND.VERTEXSHADER, elements: 2 },
                elements: [{ shader: vs }, { shader: null }] },
            { name: 'g_so', type: { name: 'GeometryShader', object: FX_KIND.GEOMETRYSHADER_SO },
                elements: [{ shader: gs, streamOutput: 'SV_POSITION.x; $Skip.x' }] },
            { name: 'sam', type: { name: 'SamplerState', object: FX_KIND.SAMPLER },
                elements: [{ assignments: [
                    { state: 0x2e, constant: [[CONSTANT_TYPE.INT, 2]] },
                    { state: 0x34, constant: [[1, 0x3f800000], [1, 0], [1, 0], [1, 0x3f800000]] },
                    { state: 0x37, variable: 't2' },
                ] }] },
            { name: 'blend', type: { name: 'BlendState', object: FX_KIND.BLEND, elements: 2 },
                elements: [{ assignments: [{ state: 0x25, index: 7,
                    constant: [[CONSTANT_TYPE.BOOL, 1]] }] }, { assignments: [] }] },
            { name: 'rtv', type: { name: 'RenderTargetView', object: FX_KIND.RENDERTARGETVIEW } },
        ] }));
        assert.deepEqual(effect.objects.map(({ name, type })=>[name, type.svc, type.svt,
            type.elements]), [
            ['name', D3D10_SVC.OBJECT, D3D10_SVT.STRING, 0],
            ['t2', D3D10_SVC.OBJECT, D3D10_SVT.TEXTURE2D, 0],
            ['cube', D3D10_SVC.OBJECT, D3D10_SVT.TEXTURECUBE, 3],
            ['v', D3D10_SVC.OBJECT, D3D10_SVT.VERTEXSHADER, 2],
            ['g_so', D3D10_SVC.OBJECT, D3D10_SVT.GEOMETRYSHADER, 0],
            ['sam', D3D10_SVC.OBJECT, D3D10_SVT.SAMPLER, 0],
            ['blend', D3D10_SVC.OBJECT, D3D10_SVT.BLEND, 2],
            ['rtv', D3D10_SVC.OBJECT, D3D10_SVT.RENDERTARGETVIEW, 0],
        ]);
        const [name, , cube, v, gso, sam, blend] = effect.objects;
        assert.equal(stringIn(effect.unstructured, /** @type {number} */ (name.elements[0].stringAt)),
            'hello');
        assert.equal(cube.elements.length, 3, 'one element per array element');
        assert.deepEqual([...(v.elements[0].shader?.bytecode ?? [])], [...vs]);
        assert.equal(v.elements[1].shader, null, 'a null shader');
        assert.equal(gso.type.streamOutput, true);
        assert.equal(gso.elements[0].shader?.streamOutput, 'SV_POSITION.x; $Skip.x');
        assert.deepEqual(sam.elements[0].assignments, [
            { state: 0x2e, index: 0, kind: ASSIGNMENT.CONSTANT,
                constants: [{ type: CONSTANT_TYPE.INT, bits: 2 }] },
            { state: 0x34, index: 0, kind: ASSIGNMENT.CONSTANT, constants: [
                { type: 1, bits: 0x3f800000 }, { type: 1, bits: 0 }, { type: 1, bits: 0 },
                { type: 1, bits: 0x3f800000 }] },
            { state: 0x37, index: 0, kind: ASSIGNMENT.VARIABLE, variable: 't2' },
        ]);
        assert.deepEqual(blend.elements.map(element=>element.assignments?.length), [1, 0]);
        assert.equal(blend.elements[0].assignments?.[0].index, 7);
    });

test('techniques and passes are read with what each pass assigns', ()=>{
    // After Wine's fx_local_shader: a pass assigning NULL, a variable, an
    // element of one and shaders compiled in place; and the two kinds that
    // need an expression evaluated, kept as they are.
    const ps = solidPixelShader([0, 1, 0, 1]);
    const effect = effectOf(effectBinary({
        objects: [{ name: 'v', type: { name: 'VertexShader', object: FX_KIND.VERTEXSHADER,
            elements: 2 }, elements: [{ shader: passThroughVertexShader() }, { shader: null }] }],
        techniques: [{ name: 'Render',
            annotations: [{ name: 'a', type: STRING, strings: ['tech_a'] }],
            passes: [
                { name: 'P0' },
                { name: 'P1', annotations: [{ name: 'n', value: [3],
                    type: { name: 'int', numeric: { layout: 'scalar', base: 'int' } } }],
                assignments: [
                    { state: 7, constant: [[CONSTANT_TYPE.INT, 0]] },
                    { state: 6, variable: 'v', element: 1 },
                    { state: 8, shader: ps, streamOutput: 'SV_POSITION.y' },
                    { state: 2, kind: ASSIGNMENT.INDEX_EXPRESSION },
                    { state: 0xa, kind: ASSIGNMENT.VALUE_EXPRESSION },
                ] },
            ] }],
    }));
    const [technique] = effect.techniques;
    assert.equal(technique.name, 'Render');
    assert.equal(stringIn(effect.unstructured, technique.annotations[0].strings[0]), 'tech_a');
    assert.deepEqual(technique.passes.map(pass=>[pass.name, pass.assignments.length]),
        [['P0', 0], ['P1', 5]]);
    const [p0, p1] = technique.passes;
    assert.deepEqual(p0.annotations, []);
    assert.deepEqual(dwordsOf(p1.annotations[0].value), [3], 'a number kept packed');
    const [none, element, inline, index, value] = p1.assignments;
    assert.deepEqual(none.constants, [{ type: CONSTANT_TYPE.INT, bits: 0 }]);
    assert.deepEqual([element.kind, element.variable, element.element],
        [ASSIGNMENT.CONSTANT_INDEX, 'v', 1]);
    assert.equal(inline.kind, ASSIGNMENT.ANONYMOUS_SHADER);
    assert.deepEqual([...(inline.shader?.bytecode ?? [])], [...ps]);
    assert.equal(inline.shader?.streamOutput, 'SV_POSITION.y');
    assert.deepEqual([index.kind, value.kind],
        [ASSIGNMENT.INDEX_EXPRESSION, ASSIGNMENT.VALUE_EXPRESSION]);
});

test('an effect this runtime cannot read says why rather than answering half of one', ()=>{
    /** @param {Uint8Array} bytes */
    const errorOf = bytes=>{
        const result = parseEffect(bytes);
        assert.ok('error' in result);
        return result.error;
    };
    assert.match(errorOf(new Uint8Array(64)), /FX10/);
    assert.match(errorOf(passThroughVertexShader()), /FX10/, 'a shader is not an effect');
    assert.match(errorOf(effectBinary({ version: 0xfeff2001 })), /fx_4_0/,
        'fx_5_0 is Direct3D 11\'s');
    assert.ok('effect' in parseEffect(effectBinary({ version: FX_VERSION.FX_4_1 })));

    const whole = effectBinary({ techniques: [{ name: 't', passes: [{ name: 'p' }] }] });
    const chunk = /** @type {Uint8Array} */ (parseDxbc(whole)?.chunks.get('FX10'));
    const cut = container([{ name: 'FX10', bytes: chunk.slice(0, chunk.length - 8) }]);
    assert.match(errorOf(cut), /cut short/);

    const pooled = chunk.slice();
    new DataView(pooled.buffer).setUint32(16, 1, true);
    assert.match(errorOf(container([{ name: 'FX10', bytes: pooled }])), /pool/,
        'a child of a pool');
});
