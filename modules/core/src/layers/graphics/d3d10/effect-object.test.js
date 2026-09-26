/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The effect framework's objects, against what Wine's d3d10 effect tests
 * expect of each: the effect's description and lookups, types, members and
 * elements, the As* casts, techniques and passes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3D10_DRIVER_TYPE, D3D10_SDK_VERSION, E_FAIL, E_INVALIDARG, S_OK,
} from './constants.js';
import { D3D10CreateDevice } from './device.js';
import { CONSTANT_TYPE, D3D10_SVC, D3D10_SVT, parseEffect } from './effect.js';
import { FX_KIND, effectBinary } from './effect-fixtures.js';
import {
    D3D10_EFFECT_VARIABLE, INVALID, PASS_STATE, VARIABLE_KIND, createEffect,
} from './effect-object.js';
import {
    passThroughVertexShader, resourceDefinitions, solidPixelShader, withChunks,
} from './shader-fixtures.js';
import { D3D10_DST, STATE_BLOCK_MASK_SIZE, stateBlockMask } from './stateblock.js';

const FLOAT = { name: 'float', numeric: /** @type {const} */ ({ layout: 'scalar', base: 'float' }) };
const STRING = { name: 'String', object: FX_KIND.STRING };

function createDevice(){
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(D3D10CreateDevice(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0,
        D3D10_SDK_VERSION, out), S_OK);
    return out.device;
}

/**
 * @param {import('./effect-fixtures.js').FixtureEffect} spec
 * @param {string[]} [reports]
 */
function made(spec, reports = []){
    const device = createDevice();
    const bytes = effectBinary(spec);
    const parsed = parseEffect(bytes);
    assert.ok('effect' in parsed);
    const effect = createEffect(parsed.effect, { device, report: line=>reports.push(line) });
    /** A name or string an object hands out, as its text. @param {any} name */
    const text = name=>{
        if (!name)
        {
            return null;
        }
        if ('text' in name)
        {
            return name.text;
        }
        const block = parsed.effect.unstructured;
        let end = name.at;
        while (block[end] !== 0)
        {
            end++;
        }
        return String.fromCharCode(...block.subarray(name.at, end));
    };
    return { device, effect, text };
}

/** @param {any} object @returns {Record<string, any>} */
const descOf = object=>{
    /** @type {{ desc?: Record<string, any> }} */
    const out = {};
    assert.equal(object.GetDesc(out), S_OK);
    return /** @type {Record<string, any>} */ (out.desc);
};

test('an effect describes itself and finds variables by index, name and semantic', ()=>{
    // Wine's test_effect_get_variable_by: names are exact, semantics are not
    // told apart by case, and every miss is the one invalid variable.
    const TEXTURE1D = { name: 'Texture1D', object: FX_KIND.TEXTURE1D };
    const { device, effect } = made({
        buffers: [
            { name: 'cb', size: 16, variables: [
                { name: 'f1', offset: 0, semantic: 'SV_POSITION', type: FLOAT },
                { name: 'f2', offset: 4, semantic: 'COLOR0', type: FLOAT }] },
            { name: 'cb2', size: 16, variables: [
                { name: 'f3', offset: 0, semantic: 'SV_POSITION', type: FLOAT },
                { name: 'f4', offset: 4, semantic: 'COLOR1', type: FLOAT }] },
        ],
        objects: [
            { name: 'tex1', semantic: 'COLOR2', type: TEXTURE1D },
            { name: 'tex2', semantic: 'COLOR1', type: TEXTURE1D },
        ],
    });
    assert.equal(effect.GetDesc(null), E_INVALIDARG);
    assert.deepEqual(descOf(effect), { IsChildEffect: false, ConstantBuffers: 2,
        SharedConstantBuffers: 0, GlobalVariables: 6, SharedGlobalVariables: 0, Techniques: 0 });
    assert.equal(effect.IsValid(), true);
    assert.equal(effect.IsPool(), false);

    const none = effect.GetVariableByIndex(0xffffffff);
    assert.equal(none, INVALID.variables.variable);
    assert.equal(none.IsValid(), false);
    for (const miss of [effect.GetVariableByName(null), effect.GetVariableByName('invalid'),
        effect.GetVariableBySemantic(null), effect.GetVariableBySemantic('invalid')])
    {
        assert.equal(miss, none);
    }
    const [f1, f2, f3, f4, tex1, tex2] = [0, 1, 2, 3, 4, 5].map(effect.GetVariableByIndex);
    assert.equal(effect.GetVariableByName('f1'), f1);
    assert.equal(effect.GetVariableBySemantic('sv_POSITION'), f1, 'the first with it');
    assert.equal(effect.GetVariableBySemantic('color0'), f2);
    assert.equal(effect.GetVariableByName('f3'), f3);
    assert.equal(effect.GetVariableBySemantic('COLOR1'), f4);
    assert.equal(effect.GetVariableByName('tex1'), tex1);
    assert.equal(effect.GetVariableBySemantic('COLOR2'), tex1);
    assert.equal(effect.GetVariableByName('tex2'), tex2);
    assert.equal(effect.GetVariableByIndex(1), f2, 'one object for one variable');

    const cb = effect.GetConstantBufferByName('cb');
    assert.equal(effect.GetConstantBufferByIndex(0), cb);
    assert.equal(effect.GetConstantBufferByIndex(2), INVALID.variables.constantBuffer);
    assert.equal(f1.GetParentConstantBuffer(), cb);
    assert.equal(tex1.GetParentConstantBuffer(), INVALID.variables.constantBuffer);
    assert.equal(cb.GetMemberByIndex(1), f2);
    assert.equal(cb.GetMemberByName('f1'), f1);
    assert.equal(cb.GetMemberBySemantic('COLOR0'), f2);
    assert.equal(cb.GetMemberByIndex(2), INVALID.variables.variable);

    /** @type {{ device?: any }} */
    const held = {};
    assert.equal(effect.GetDevice(held), S_OK);
    assert.equal(held.device, device);
    held.device.release();
    assert.equal(effect.release(), 0);
    assert.equal(device.release(), 0, 'the effect gave its reference to the device back');
});

test('a variable describes itself, and a structure its members and an array its elements', ()=>{
    // Wine's test_effect_variable_element: struct test1 { float f1; float
    // f2[3]; test t[2]; } in cb, test being three floats with semantics.
    const structure = { name: 'test', elements: 2, packedSize: 24, unpackedSize: 28, stride: 16,
        members: [
            { name: 'f3', semantic: 'SV_POSITION', offset: 0, type: FLOAT },
            { name: 'f4', semantic: 'COLOR0', offset: 4, type: FLOAT },
            { name: 'f5', semantic: 'COLOR1', offset: 8, type: FLOAT },
        ] };
    const test1 = { name: 'test1', packedSize: 40, unpackedSize: 92, stride: 96, members: [
        { name: 'f1', offset: 0, type: FLOAT },
        { name: 'f2', offset: 16, type: { ...FLOAT, elements: 3 } },
        { name: 't', offset: 64, type: structure },
    ] };
    const { effect, text } = made({ buffers: [{ name: 'cb', size: 96, variables: [
        { name: 't1', offset: 0, type: test1 }] }] });
    const cb = effect.GetConstantBufferByName('cb');
    assert.deepEqual(descOf(cb), { Name: { at: descOf(cb).Name.at }, Semantic: null, Flags: 0,
        Annotations: 0, BufferOffset: 0, ExplicitBindPoint: 0 });
    assert.equal(text(descOf(cb).Name), 'cb');
    assert.equal(cb.GetMemberByIndex(1).GetDesc({}), E_FAIL, 'the invalid variable');

    const t1 = cb.GetMemberByName('t1');
    assert.equal(t1.kind, VARIABLE_KIND.VARIABLE, 'a structure is a plain variable');
    const f2 = t1.GetMemberByName('f2');
    assert.equal(text(descOf(f2).Name), 'f2');
    assert.equal(descOf(f2).BufferOffset, 16);
    assert.equal(f2.GetParentConstantBuffer(), cb);
    const arrayType = descOf(f2.GetType());
    assert.deepEqual([arrayType.Elements, arrayType.PackedSize, arrayType.UnpackedSize,
        arrayType.Stride], [3, 0xc, 0x24, 0x10]);
    const elements = [0, 1, 2].map(index=>f2.GetElement(index));
    assert.deepEqual(elements.map(element=>[text(descOf(element).Name),
        descOf(element).BufferOffset]), [['f2', 16], ['f2', 32], ['f2', 48]]);
    assert.equal(elements[1].GetType(), elements[0].GetType(), 'one type for every element');
    const elementType = descOf(elements[0].GetType());
    assert.deepEqual([text(elementType.TypeName), elementType.Class, elementType.Type,
        elementType.Elements, elementType.PackedSize, elementType.UnpackedSize, elementType.Stride],
    ['float', D3D10_SVC.SCALAR, D3D10_SVT.FLOAT, 0, 4, 4, 16]);
    assert.equal(f2.GetElement(3), INVALID.variables.variable);
    assert.equal(elements[0].GetParentConstantBuffer(), cb);
    assert.equal(elements[0].As(VARIABLE_KIND.SCALAR), elements[0]);

    const t = t1.GetMemberByName('t');
    const tType = descOf(t.GetType());
    assert.deepEqual([text(tType.TypeName), tType.Class, tType.Type, tType.Elements,
        tType.Members, tType.Rows, tType.Columns, tType.PackedSize, tType.UnpackedSize,
        tType.Stride], ['test', D3D10_SVC.STRUCT, D3D10_SVT.VOID, 2, 3, 0, 0, 0x18, 0x1c, 0x10]);
    const second = t.GetElement(1);
    assert.equal(descOf(second).BufferOffset, 80);
    const f4 = second.GetMemberBySemantic('color0');
    assert.equal(text(descOf(f4).Name), 'f4');
    assert.equal(descOf(f4).BufferOffset, 84);
    assert.equal(second.GetMemberByName(null), INVALID.variables.variable);

    const type = t.GetType();
    assert.equal(type.GetDesc(null), E_INVALIDARG);
    assert.equal(text(type.GetMemberName(1)), 'f4');
    assert.equal(text(type.GetMemberSemantic(2)), 'COLOR1');
    assert.equal(type.GetMemberName(3), null);
    assert.equal(type.GetMemberSemantic(3), null);
    assert.equal(type.GetMemberTypeByName('f5'), type.GetMemberTypeByIndex(2));
    assert.equal(type.GetMemberTypeBySemantic('sv_position'), type.GetMemberTypeByIndex(0));
    const invalidType = type.GetMemberTypeByIndex(3);
    assert.equal(invalidType, INVALID.type);
    assert.equal(type.GetMemberTypeByName(null), invalidType);
    assert.equal(invalidType.GetDesc({}), E_FAIL);
    assert.equal(invalidType.GetDesc(null), E_FAIL);
});

test('a constant buffer is an object of its own type, and annotations are flagged variables',
    ()=>{
        // Wine's test_effect_variable_type_class, and its check_as: each As*
        // answers the variable itself only for its own kind.
        const { effect, text } = made({ buffers: [{
            name: 'cb', size: 96,
            annotations: [{ name: 's', type: STRING, strings: ['STRING'] },
                { name: 's2', type: STRING, strings: ['STRING'] }],
            variables: [
                { name: 'f', offset: 0, type: FLOAT },
                { name: 'i', offset: 4,
                    type: { name: 'int2',
                        numeric: { layout: 'vector', base: 'int', columns: 2 } } },
                { name: 'u', offset: 16, type: { name: 'uint2x3',
                    numeric: { layout: 'matrix', base: 'uint', rows: 2, columns: 3 } } },
                { name: 'b', offset: 64, type: { name: 'bool2x3',
                    numeric: { layout: 'matrix', base: 'bool', rows: 2, columns: 3,
                        rowMajor: true } } },
            ],
        }], objects: [
            { name: 'blend', type: { name: 'BlendState', object: FX_KIND.BLEND } },
            { name: 't2', type: { name: 'Texture2D', object: FX_KIND.TEXTURE2D } },
            { name: 'ps', type: { name: 'PixelShader', object: FX_KIND.PIXELSHADER } },
            { name: 'sam', type: { name: 'SamplerState', object: FX_KIND.SAMPLER } },
        ] });
        const cb = effect.GetConstantBufferByIndex(0);
        assert.equal(descOf(cb).Annotations, 2);
        const cbType = descOf(cb.GetType());
        assert.deepEqual([text(cbType.TypeName), cbType.Class, cbType.Type, cbType.Elements,
            cbType.Members, cbType.Rows, cbType.Columns, cbType.PackedSize, cbType.UnpackedSize,
            cbType.Stride], ['cbuffer', D3D10_SVC.OBJECT, D3D10_SVT.CBUFFER, 0, 4, 0, 0, 0x3c,
            0x60, 0x60]);
        const annotation = cb.GetAnnotationByIndex(0);
        assert.deepEqual(descOf(annotation).Flags, D3D10_EFFECT_VARIABLE.ANNOTATION);
        assert.equal(text(descOf(annotation).Name), 's');
        assert.equal(annotation.GetParentConstantBuffer(), INVALID.variables.constantBuffer);
        assert.equal(descOf(annotation.GetType()).Type, D3D10_SVT.STRING);
        assert.equal(cb.GetAnnotationByName('s2'), cb.GetAnnotationByIndex(1));
        assert.equal(cb.GetAnnotationByIndex(2), INVALID.variables.variable);

        /** @type {[string, string][]} */
        const kinds = [['cb', VARIABLE_KIND.CONSTANT_BUFFER], ['f', VARIABLE_KIND.SCALAR],
            ['i', VARIABLE_KIND.VECTOR], ['u', VARIABLE_KIND.MATRIX], ['b', VARIABLE_KIND.MATRIX],
            ['blend', VARIABLE_KIND.BLEND], ['t2', VARIABLE_KIND.SHADER_RESOURCE],
            ['ps', VARIABLE_KIND.SHADER], ['sam', VARIABLE_KIND.SAMPLER]];
        for (const [name, kind] of kinds)
        {
            const variable = name === 'cb' ? cb : effect.GetVariableByName(name);
            for (const other of Object.values(VARIABLE_KIND))
            {
                const cast = variable.As(other);
                assert.equal(cast.IsValid(), other === kind, `${name} as ${other}`);
                assert.equal(cast === variable, other === kind);
            }
        }
        const u = descOf(effect.GetVariableByName('u').GetType());
        assert.deepEqual([u.Class, u.Rows, u.Columns], [D3D10_SVC.MATRIX_COLUMNS, 2, 3]);
        assert.equal(descOf(effect.GetVariableByName('b').GetType()).Class,
            D3D10_SVC.MATRIX_ROWS);
        const blendType = descOf(effect.GetVariableByName('blend').GetType());
        assert.deepEqual([blendType.Class, blendType.Type, blendType.PackedSize,
            blendType.UnpackedSize, blendType.Stride],
        [D3D10_SVC.OBJECT, D3D10_SVT.BLEND, 0, 0, 0]);
    });

test('a technique finds its passes, and a pass says which shaders and values it sets', ()=>{
    // Wine's test_effect_local_shader and test_effect_state_groups: no
    // assignment names the invalid shader variable, NULL and a shader
    // compiled in place an "$Anonymous" one, a variable itself at the
    // element named; the pass's own values are what it assigns.
    const vs = passThroughVertexShader();
    const reports = /** @type {string[]} */ ([]);
    const { effect, text } = made({
        objects: [
            { name: 'v', type: { name: 'VertexShader', object: FX_KIND.VERTEXSHADER, elements: 2 },
                elements: [{ shader: vs }, { shader: null }] },
            { name: 'p', type: { name: 'PixelShader', object: FX_KIND.PIXELSHADER },
                elements: [{ shader: solidPixelShader([1, 1, 0, 1]) }] },
        ],
        techniques: [{ name: 'Render', passes: [
            { name: 'P0', annotations: [{ name: 'a', type: STRING, strings: ['text'] }] },
            { name: 'P1', assignments: [
                { state: PASS_STATE.PIXEL_SHADER, constant: [[CONSTANT_TYPE.INT, 0]] },
                { state: PASS_STATE.VERTEX_SHADER, shader: vs },
                { state: PASS_STATE.GEOMETRY_SHADER, kind: 5 }] },
            { name: 'P2', assignments: [
                { state: PASS_STATE.PIXEL_SHADER, variable: 'p' },
                { state: PASS_STATE.VERTEX_SHADER, variable: 'v', element: 1 },
                { state: PASS_STATE.BLEND_FACTOR, constant: [[1, 0x3f000000], [1, 0x3f19999a],
                    [1, 0x3f333333], [1, 0x3f4ccccd]] },
                { state: PASS_STATE.SAMPLE_MASK, constant: [[CONSTANT_TYPE.UINT, 0xffff]] },
                { state: PASS_STATE.STENCIL_REF, constant: [[CONSTANT_TYPE.FLOAT, 0x3f800000]] }] },
        ] }],
    }, reports);
    const none = effect.GetTechniqueByIndex(0xffffffff);
    assert.equal(none, INVALID.technique);
    assert.equal(effect.GetTechniqueByName(null), none);
    assert.equal(effect.GetTechniqueByName('invalid'), none);
    const technique = effect.GetTechniqueByName('Render');
    assert.equal(effect.GetTechniqueByIndex(0), technique);
    assert.deepEqual([text(descOf(technique).Name), descOf(technique).Passes], ['Render', 3]);
    const nonePass = none.GetPassByIndex(0);
    assert.equal(nonePass, INVALID.pass);
    assert.equal(technique.GetPassByIndex(3), nonePass);
    assert.equal(nonePass.GetShaderDesc(PASS_STATE.VERTEX_SHADER, {}), E_FAIL);
    assert.equal(nonePass.GetShaderDesc(PASS_STATE.VERTEX_SHADER, null), E_FAIL);

    const [p0, p1, p2] = [0, 1, 2].map(index=>technique.GetPassByIndex(index));
    assert.equal(technique.GetPassByName('P1'), p1);
    assert.equal(p0.GetShaderDesc(PASS_STATE.VERTEX_SHADER, null), E_INVALIDARG);
    /** @param {any} pass @param {number} state */
    const shaderOf = (pass, state)=>{
        /** @type {{ desc?: any }} */
        const out = {};
        assert.equal(pass.GetShaderDesc(state, out), S_OK);
        return out.desc;
    };
    assert.deepEqual(shaderOf(p0, PASS_STATE.PIXEL_SHADER),
        { variable: INVALID.variables.shader, index: 0 }, 'nothing assigned');
    const p0Desc = descOf(p0);
    assert.deepEqual([text(p0Desc.Name), p0Desc.Annotations, p0Desc.IAInputSignature,
        p0Desc.StencilRef, p0Desc.SampleMask, p0Desc.BlendFactor],
    ['P0', 1, null, 0, 0, [0, 0, 0, 0]], 'the effect\'s defaults');
    assert.equal(p0.GetAnnotationByName('a'), p0.GetAnnotationByIndex(0));
    assert.equal(text(descOf(p0.GetAnnotationByIndex(0)).Name), 'a');

    const anonymous = shaderOf(p1, PASS_STATE.PIXEL_SHADER).variable;
    assert.equal(anonymous.IsValid(), true, 'NULL is a shader variable of its own');
    assert.deepEqual([text(descOf(anonymous).Name), descOf(anonymous).Flags],
        ['$Anonymous', 0]);
    const anonymousType = descOf(anonymous.GetType());
    assert.deepEqual([text(anonymousType.TypeName), anonymousType.Class, anonymousType.Type],
        ['pixelshader', D3D10_SVC.OBJECT, D3D10_SVT.PIXELSHADER]);
    const inline = shaderOf(p1, PASS_STATE.VERTEX_SHADER).variable;
    assert.notEqual(inline, anonymous);
    assert.equal(text(descOf(inline.GetType()).TypeName), 'vertexshader');
    assert.equal(descOf(p1).IAInputSignatureSize, vs.length, 'the vertex shader\'s bytecode');
    assert.deepEqual(shaderOf(p1, PASS_STATE.GEOMETRY_SHADER).variable, INVALID.variables.shader);
    assert.ok(reports.some(line=>line.includes('index expression')), reports.join('\n'));

    assert.deepEqual(shaderOf(p2, PASS_STATE.PIXEL_SHADER),
        { variable: effect.GetVariableByName('p'), index: 0 });
    assert.deepEqual(shaderOf(p2, PASS_STATE.VERTEX_SHADER),
        { variable: effect.GetVariableByName('v'), index: 1 });
    const p2Desc = descOf(p2);
    assert.equal(p2Desc.IAInputSignature, null, 'the element named holds no shader');
    assert.deepEqual([p2Desc.StencilRef, p2Desc.SampleMask], [1, 0xffff]);
    assert.deepEqual(p2Desc.BlendFactor, [0.5, 0.6, 0.7, 0.8].map(Math.fround));
});

test('a pass value a variable gives is the variable\'s value now', ()=>{
    // Wine's test_effect_dynamic_numeric_field: a pass reads a numeric
    // variable, or a dword into one, each time; an element named by a
    // constant index is that many dwords in.
    const uint = { name: 'uint', numeric: /** @type {const} */ ({ layout: 'scalar', base: 'uint' }) };
    const float4 = { name: 'float4', numeric: /** @type {const} */ ({ layout: 'vector',
        base: 'float', columns: 4 }) };
    const { effect } = made({
        buffers: [{ name: '$Globals', size: 144, variables: [
            { name: 'i1', offset: 0, type: uint },
            { name: 'i1_a', offset: 16, type: { ...uint, elements: 2 }, defaultValue: [5, 6] },
            { name: 'fv1', offset: 48, type: float4,
                defaultValue: [0x3f000000, 0x3f19999a, 0x3f333333, 0x3f4ccccd] },
            { name: 'fv1_a', offset: 64, type: { ...float4, elements: 2 }, defaultValue: [
                0x3f800000, 0x3f8ccccd, 0x3f99999a, 0x3fa66666,
                0x3dcccccd, 0x3e4ccccd, 0x3e99999a, 0x3ecccccd] },
        ] }],
        techniques: [{ name: 'tech', passes: [
            { name: 'P0', assignments: [{ state: PASS_STATE.STENCIL_REF, variable: 'i1' },
                { state: PASS_STATE.BLEND_FACTOR, variable: 'fv1' }] },
            { name: 'P1', assignments: [
                { state: PASS_STATE.STENCIL_REF, variable: 'i1_a', element: 4 },
                { state: PASS_STATE.BLEND_FACTOR, variable: 'fv1_a', element: 4 }] },
        ] }],
    });
    const [p0, p1] = [0, 1].map(index=>effect.GetTechniqueByIndex(0).GetPassByIndex(index));
    assert.deepEqual(descOf(p0).BlendFactor, [0.5, 0.6, 0.7, 0.8].map(Math.fround),
        'the default value, spread into the buffer');
    assert.equal(descOf(p0).StencilRef, 0);
    const [buffer] = effect.buffers();
    new DataView(buffer.bytes.buffer).setUint32(0, 3, true);
    assert.equal(descOf(p0).StencilRef, 3, 'read when asked');
    assert.equal(descOf(p1).StencilRef, 6, 'the second element, four dwords in');
    assert.deepEqual(descOf(p1).BlendFactor, [0.1, 0.2, 0.3, 0.4].map(Math.fround));
});

test('what an effect made is named for giving back, and goes with its last release', ()=>{
    let released = 0;
    const device = createDevice();
    const parsed = parseEffect(effectBinary({ buffers: [{ name: 'cb', size: 16,
        variables: [{ name: 'f', offset: 0, type: FLOAT }] }] }));
    assert.ok('effect' in parsed);
    const effect = createEffect(parsed.effect, { device, onLastRef: ()=>{
        released++;
    } });
    const f = effect.GetVariableByName('f');
    const type = f.GetType();
    const children = effect.children();
    for (const object of [f, type, effect.GetConstantBufferByIndex(0)])
    {
        assert.ok(children.includes(object));
    }
    assert.ok(!children.includes(INVALID.variables.variable));
    assert.equal(effect.release(), 0);
    assert.equal(released, 1);
    assert.equal(device.release(), 0);
});

// --- applying a pass ---

/** The state blocks of Wine's fx_test_state_groups, described. */
const STATE_GROUPS = (()=>{
    const I = CONSTANT_TYPE.INT;
    const U = CONSTANT_TYPE.UINT;
    const B = CONSTANT_TYPE.BOOL;
    const F = CONSTANT_TYPE.FLOAT;
    /** @param {number} state @param {number} type @param {number} bits @param {number} [index] */
    const is = (state, type, bits, index = 0)=>({ state, index, constant: [[type, bits]] });
    /** @param {string} name @param {number} object @param {any[][]} blocks */
    const states = (name, object, blocks)=>({ name,
        type: { name, object, elements: blocks.length > 1 ? blocks.length : 0 },
        elements: blocks.map(assignments=>({ assignments })) });
    return [
        states('rast_state', FX_KIND.RASTERIZER, [[is(0x0c, I, 2), is(0x0d, I, 2), is(0x0e, B, 1),
            is(0x0f, I, -4 >>> 0), is(0x10, F, 0x3f000000), is(0x11, F, 0x3e800000),
            is(0x12, B, 0), is(0x13, B, 1), is(0x14, B, 1), is(0x15, B, 1)], [is(0x0d, I, 3)]]),
        states('ds_state', FX_KIND.DEPTHSTENCIL, [[is(0x16, B, 1), is(0x17, I, 0), is(0x18, I, 3),
            is(0x19, B, 1), is(0x1a, U, 4), is(0x1b, U, 5), is(0x1c, I, 6), is(0x1d, I, 7),
            is(0x1e, I, 8), is(0x1f, I, 4), is(0x20, I, 3), is(0x21, I, 4), is(0x22, I, 5),
            is(0x23, I, 7)], [is(0x16, B, 0)]]),
        states('blend_state', FX_KIND.BLEND, [[is(0x24, B, 0), is(0x25, B, 1), is(0x25, B, 0, 7),
            is(0x26, I, 2), is(0x27, I, 3), is(0x28, I, 4), is(0x29, I, 5), is(0x2a, I, 6),
            is(0x2b, I, 5), is(0x2c, U, 8), is(0x2c, U, 7, 7)], [is(0x26, I, 3)]]),
        states('sampler0', FX_KIND.SAMPLER, [[is(0x2d, I, 0x15), is(0x2e, I, 1), is(0x2f, I, 2),
            is(0x30, I, 3), is(0x31, I, -1 >>> 0), is(0x32, U, 4), is(0x33, I, 8),
            { state: 0x34, constant: [[F, 0x3f800000], [F, 0x40000000], [F, 0x40400000],
                [F, 0x40800000]] }, is(0x35, U, 6), is(0x36, U, 5), is(0x37, I, 0)],
        [is(0x2e, I, 2)]]),
        states('defaults_rast', FX_KIND.RASTERIZER, [[]]),
        states('defaults_ds', FX_KIND.DEPTHSTENCIL, [[]]),
        states('defaults_blend', FX_KIND.BLEND, [[]]),
        states('defaults_sampler', FX_KIND.SAMPLER, [[]]),
    ];
})();

test('a state block starts from the effect\'s own defaults and takes what it assigns', ()=>{
    // Wine's test_effect_state_groups and test_effect_state_group_defaults:
    // each block's backing store, and the state object made from it.
    const { effect, device } = made({ objects: STATE_GROUPS });
    /** @param {string} name @param {number} [element] */
    const slotOf = (name, element = 0)=>effect.GetVariableByName(name).shape.slots[element];
    assert.deepEqual(slotOf('rast_state').desc, {
        FillMode: 2, CullMode: 2, FrontCounterClockwise: true, DepthBias: -4,
        DepthBiasClamp: 0.5, SlopeScaledDepthBias: 0.25, DepthClipEnable: false,
        ScissorEnable: true, MultisampleEnable: true, AntialiasedLineEnable: true,
    });
    assert.equal(slotOf('rast_state', 1).desc.CullMode, 3);
    assert.deepEqual(slotOf('ds_state').desc, {
        DepthEnable: true, DepthWriteMask: 0, DepthFunc: 3, StencilEnable: true,
        StencilReadMask: 4, StencilWriteMask: 5,
        FrontFace: { StencilFailOp: 6, StencilDepthFailOp: 7, StencilPassOp: 8, StencilFunc: 4 },
        BackFace: { StencilFailOp: 3, StencilDepthFailOp: 4, StencilPassOp: 5, StencilFunc: 7 },
    });
    const blend = slotOf('blend_state').desc;
    assert.deepEqual([blend.AlphaToCoverageEnable, blend.BlendEnable[0], blend.BlendEnable[7],
        blend.SrcBlend, blend.DestBlend, blend.BlendOp, blend.SrcBlendAlpha, blend.DestBlendAlpha,
        blend.BlendOpAlpha, blend.RenderTargetWriteMask[0], blend.RenderTargetWriteMask[7]],
    [false, true, false, 2, 3, 4, 5, 6, 5, 8, 7]);
    assert.deepEqual(slotOf('sampler0').desc, {
        Filter: 0x15, AddressU: 1, AddressV: 2, AddressW: 3, MipLODBias: -1, MaxAnisotropy: 4,
        ComparisonFunc: 8, BorderColor: [1, 2, 3, 4], MinLOD: 6, MaxLOD: 5,
    });
    assert.equal(slotOf('sampler0', 1).desc.AddressU, 2);

    assert.deepEqual(slotOf('defaults_rast').desc, { FillMode: 3, CullMode: 3,
        FrontCounterClockwise: false, DepthBias: 0, DepthBiasClamp: 0, SlopeScaledDepthBias: 0,
        DepthClipEnable: true, ScissorEnable: false, MultisampleEnable: false,
        AntialiasedLineEnable: false });
    const dsDefaults = slotOf('defaults_ds').desc;
    assert.deepEqual([dsDefaults.DepthEnable, dsDefaults.DepthWriteMask, dsDefaults.DepthFunc,
        dsDefaults.StencilEnable, dsDefaults.StencilReadMask, dsDefaults.FrontFace.StencilFunc],
    [true, 1, 2, false, 0xff, 8]);
    const blendDefaults = slotOf('defaults_blend').desc;
    assert.deepEqual([blendDefaults.SrcBlend, blendDefaults.DestBlend, blendDefaults.BlendOp,
        blendDefaults.RenderTargetWriteMask[7]], [5, 6, 1, 0xf],
    'source alpha over its inverse, not the device\'s one and zero');
    assert.deepEqual(slotOf('defaults_sampler').desc, { Filter: 0, AddressU: 1, AddressV: 1,
        AddressW: 1, MipLODBias: 0, MaxAnisotropy: 16, ComparisonFunc: 1,
        BorderColor: [0, 0, 0, 0], MinLOD: 0, MaxLOD: 3.4028234663852886e38 });

    /** @type {{ desc?: any }} */
    const described = {};
    slotOf('rast_state').made.GetDesc(described);
    assert.equal(described.desc.CullMode, 2, 'a state object made from the backing store');
    assert.equal(effect.release(), 0);
    assert.equal(device.release(), 0, 'every state object went with the effect');
});

test('a pass applies the states it assigns, with its values, and leaves the rest', ()=>{
    // Wine's test_effect_state_groups, passes 0 and 2.
    const F = CONSTANT_TYPE.FLOAT;
    const { effect, device } = made({ objects: STATE_GROUPS, techniques: [{ name: 'tech0',
        passes: [
            { name: 'pass0', assignments: [
                { state: PASS_STATE.BLEND_FACTOR, constant: [[F, 0x3f000000], [F, 0x3f19999a],
                    [F, 0x3f333333], [F, 0x3f4ccccd]] },
                { state: PASS_STATE.SAMPLE_MASK, constant: [[CONSTANT_TYPE.UINT, 0xffff]] },
                { state: PASS_STATE.BLEND, variable: 'blend_state' },
                { state: PASS_STATE.STENCIL_REF, constant: [[F, 0x3f800000]] },
                { state: PASS_STATE.DEPTH_STENCIL, variable: 'ds_state' },
                { state: PASS_STATE.RASTERIZER, variable: 'rast_state', element: 1 },
            ] },
            { name: 'pass2', assignments: [
                { state: PASS_STATE.DEPTH_STENCIL, constant: [[CONSTANT_TYPE.INT, 0]] },
                { state: PASS_STATE.BLEND, constant: [[CONSTANT_TYPE.INT, 0]] },
            ] },
        ] }] });
    const technique = effect.GetTechniqueByName('tech0');
    assert.equal(technique.GetPassByName('pass0').Apply(0), S_OK);
    /** @type {any} */
    const blend = {};
    device.OMGetBlendState(blend);
    assert.equal(blend.state, effect.GetVariableByName('blend_state').shape.slots[0].made);
    assert.deepEqual(blend.blendFactor, [0.5, 0.6, 0.7, 0.8].map(Math.fround));
    assert.equal(blend.sampleMask, 0xffff);
    /** @type {any} */
    const depth = {};
    device.OMGetDepthStencilState(depth);
    assert.equal(depth.state, effect.GetVariableByName('ds_state').shape.slots[0].made);
    assert.equal(depth.stencilRef, 1, 'given as 1.0f, applied as an integer');
    /** @type {any} */
    const raster = {};
    device.RSGetState(raster);
    assert.equal(raster.state, effect.GetVariableByName('rast_state').shape.slots[1].made);
    for (const held of [blend.state, depth.state, raster.state])
    {
        held.release();
    }

    assert.equal(technique.GetPassByName('pass2').Apply(0), S_OK);
    /** @type {any} */
    const none = {};
    device.OMGetBlendState(none);
    device.OMGetDepthStencilState(none);
    assert.equal(none.state, null, 'NULL is none');
    device.RSGetState(raster);
    assert.equal(raster.state, effect.GetVariableByName('rast_state').shape.slots[1].made,
        'what the pass does not assign stays');
    raster.state.release();

    const mask = new Uint8Array(STATE_BLOCK_MASK_SIZE);
    assert.equal(technique.GetPassByName('pass0').ComputeStateBlockMask(mask), S_OK);
    assert.ok(stateBlockMask.GetSetting(mask, D3D10_DST.RS_RASTERIZER_STATE, 0));
    assert.ok(stateBlockMask.GetSetting(mask, D3D10_DST.OM_DEPTH_STENCIL_STATE, 0));
    assert.ok(stateBlockMask.GetSetting(mask, D3D10_DST.OM_BLEND_STATE, 0));
    assert.ok(!stateBlockMask.GetSetting(mask, D3D10_DST.VS, 0));
    assert.equal(technique.ComputeStateBlockMask(null), E_INVALIDARG);
    effect.release();
    device.OMSetBlendState(null, null, 0);
    device.OMSetDepthStencilState(null, 0);
    device.RSSetState(null);
    assert.equal(device.release(), 0);
});

test('a pass sets its shaders and binds what each reads by the effect\'s names', ()=>{
    // Wine's test_effect_local_shader: no assignment leaves the stage as it
    // is, NULL clears it; a shader's constant buffer, texture and sampler
    // come from the effect's variables of their names, the buffer uploaded
    // when it changed.
    const float4 = { name: 'float4', numeric: /** @type {const} */ ({ layout: 'vector',
        base: 'float', columns: 4 }) };
    const ps = withChunks(solidPixelShader([1, 0, 0, 1]), [{ name: 'RDEF',
        bytes: resourceDefinitions({ target: 0xffff0400, flags: 0, bindings: [
            { name: 's', type: 3, bindPoint: 1 },
            { name: 'tex', type: 2, returnType: 5, dimension: 4, bindPoint: 2, bindCount: 2 },
            { name: 'cb', type: 0, bindPoint: 3 },
        ] }) }]);
    const { effect, device } = made({
        buffers: [{ name: 'cb', size: 16, variables: [{ name: 'colour', offset: 0,
            type: float4, defaultValue: [0x3f800000, 0, 0, 0x3f800000] }] }],
        objects: [
            { name: 'tex', type: { name: 'Texture2D', object: FX_KIND.TEXTURE2D, elements: 2 } },
            { name: 's', type: { name: 'SamplerState', object: FX_KIND.SAMPLER } },
            { name: 'p', type: { name: 'PixelShader', object: FX_KIND.PIXELSHADER },
                elements: [{ shader: ps }] },
        ],
        techniques: [{ name: 'Render', passes: [
            { name: 'none' },
            { name: 'null', assignments: [{ state: PASS_STATE.PIXEL_SHADER,
                constant: [[CONSTANT_TYPE.INT, 0]] }] },
            { name: 'named', assignments: [{ state: PASS_STATE.PIXEL_SHADER, variable: 'p' }] },
        ] }],
    });
    /** @type {any[]} */
    const uploads = [];
    const update = device.UpdateSubresource;
    device.UpdateSubresource = (/** @type {any[]} */ ...args)=>{
        uploads.push(args);
        return update(...args);
    };
    const technique = effect.GetTechniqueByIndex(0);
    const shader = effect.GetVariableByName('p').shape.slots[0].made;
    assert.ok(shader, 'the effect made its shader on the device');

    device.PSSetShader(shader);
    technique.GetPassByName('none').Apply(0);
    /** @type {any} */
    const bound = {};
    device.PSGetShader(bound);
    assert.equal(bound.shader, shader, 'nothing assigned, nothing changed');
    bound.shader.release();
    technique.GetPassByName('null').Apply(0);
    device.PSGetShader(bound);
    assert.equal(bound.shader, null);

    /** @type {{ resource?: any }} */
    const texture = {};
    assert.equal(device.CreateTexture2D({ Width: 4, Height: 4, MipLevels: 1, ArraySize: 1,
        Format: 28, SampleDesc: { Count: 1, Quality: 0 }, Usage: 0, BindFlags: 8,
        CPUAccessFlags: 0, MiscFlags: 0 }, null, texture), S_OK);
    /** @type {{ view?: any }} */
    const view = {};
    assert.equal(device.CreateShaderResourceView(texture.resource, null, view), S_OK);
    effect.GetVariableByName('tex').shape.slots[1].resource = view.view;

    const named = technique.GetPassByName('named');
    named.Apply(0);
    device.PSGetShader(bound);
    assert.equal(bound.shader, shader);
    bound.shader.release();
    const [buffer] = effect.buffers();
    /** @type {any} */
    const slots = {};
    device.PSGetConstantBuffers(3, 1, slots);
    assert.equal(slots.buffers[0], buffer.gpu, 'the effect\'s buffer at the shader\'s slot');
    slots.buffers[0].release();
    assert.equal(uploads.length, 1, 'uploaded once');
    assert.equal(uploads[0][3], buffer.bytes);
    device.PSGetShaderResources(2, 2, slots);
    assert.deepEqual(slots.views, [null, view.view], 'every element, at its slots');
    view.view.release();
    device.PSGetSamplers(1, 1, slots);
    assert.equal(slots.samplers[0], effect.GetVariableByName('s').shape.slots[0].made);
    slots.samplers[0].release();

    named.Apply(0);
    assert.equal(uploads.length, 1, 'unchanged, not uploaded again');
    buffer.dirty = true;
    named.Apply(0);
    assert.equal(uploads.length, 2);

    const mask = new Uint8Array(STATE_BLOCK_MASK_SIZE);
    named.ComputeStateBlockMask(mask);
    assert.ok(stateBlockMask.GetSetting(mask, D3D10_DST.PS, 0));
    assert.ok(stateBlockMask.GetSetting(mask, D3D10_DST.PS_CONSTANT_BUFFERS, 3));
    assert.ok(stateBlockMask.GetSetting(mask, D3D10_DST.PS_SHADER_RESOURCES, 3));
    assert.ok(stateBlockMask.GetSetting(mask, D3D10_DST.PS_SAMPLERS, 1));
    assert.ok(!stateBlockMask.GetSetting(mask, D3D10_DST.VS_SHADER_RESOURCES, 2));
});
