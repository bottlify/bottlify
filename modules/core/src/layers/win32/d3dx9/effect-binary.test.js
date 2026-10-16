/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FX_2_0, readCompiledEffect } from './effect-binary.js';
import { PC, PT } from './effect-model.js';

/**
 * A compiled effect laid out as fxc lays one out: a body of words, every name,
 * type and value reached by its offset from the body's start.
 */
function writer(){
    /** @type {number[]} */
    const words = [];
    const here = ()=>words.length * 4;
    /** @param {...number} values */
    const put = (...values)=>{
        const at = here();
        words.push(...values.map(v=>v >>> 0));
        return at;
    };
    /** @param {string} text */
    const name = text=>{
        const bytes = [...text, '\0'].map(c=>c.charCodeAt(0));
        while (bytes.length % 4)
        {
            bytes.push(0);
        }
        const at = put(text.length + 1);
        for (let i = 0; i < bytes.length; i += 4)
        {
            put(bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16 | bytes[i + 3] << 24);
        }
        return at;
    };
    /** @param {number} byteLength @param {number[]} data  an object's bytes, as words */
    const blob = (byteLength, data)=>{
        put(byteLength);
        put(...data);
    };
    return { words, here, put, name, blob };
}

const floatBits = (/** @type {number} */ v)=>new Uint32Array(Float32Array.of(v).buffer)[0];

/** An expression: mov oc0.x, imm0, the literal 3. */
const FXLC = [0x46580201, 0x000afffe, 0x54494c43, 4,
    ...new Uint32Array(Float64Array.of(3, 0, 0, 0).buffer),
    0x000afffe, 0x434c5846, 1, 0x10000001, 1, 0, 1, 0, 0, 4, 0];

/** vs_1_1 with a CTAB comment and a PRES comment, then the end token. */
const VS = [0xfffe0101, 0x0002fffe, 0x42415443, 0x1c, 0x0001fffe, 0x53455250, 0x0000ffff];

function effect(){
    const w = writer();
    w.put(0); // the body's own first word, before the offset the header gives
    const none = w.name('');
    const tint = w.name('tint');
    const diffuse = w.name('DIFFUSE');
    const ui = w.name('UIName');
    const texName = w.name('tex');
    const samplerName = w.name('s');
    const techName = w.name('T');
    const passName = w.name('P0');

    // Types: a float4, a string, a texture, a sampler, an int (for states and FXLC).
    const float4 = w.put(PT.FLOAT, PC.VECTOR, tint, diffuse, 0, 4, 1);
    const stringType = w.put(PT.STRING, PC.OBJECT, ui, none, 0);
    const textureType = w.put(PT.TEXTURE, PC.OBJECT, texName, none, 0);
    const samplerType = w.put(PT.SAMPLER2D, PC.OBJECT, samplerName, none, 0);
    const intType = w.put(PT.INT, PC.SCALAR, none, none, 0, 1, 1);
    const shaderType = w.put(PT.VERTEXSHADER, PC.OBJECT, none, none, 0);

    // Values: tint's floats, the annotation's string id 1, the texture's id 2, the
    // sampler's two states, ZEnable's 1, the shader's id 3, CullMode's id-less int.
    const tintValue = w.put(floatBits(1), floatBits(0.5), 0, floatBits(1));
    const uiValue = w.put(1);
    const texValue = w.put(2);
    const minValue = w.put(2);
    const samplerValue = w.put(2, 0xa4, 0, textureType, texValue, 0xaa, 0, intType, minValue);
    const one = w.put(1);
    const shaderValue = w.put(3);
    const fxlcValue = w.put(0);

    const start = w.here();
    w.put(3, 1, 0, 5); // parameters, techniques, shaders, objects
    w.put(float4, tintValue, 0, 1, stringType, uiValue);
    w.put(textureType, texValue, 0, 0);
    w.put(samplerType, samplerValue, 0, 0);
    w.put(techName, 0, 1);
    w.put(passName, 0, 3);
    w.put(0x92, 0, shaderType, shaderValue); // VertexShader
    w.put(0x00, 0, intType, one); // ZEnable
    w.put(0x08, 0, intType, fxlcValue); // CullMode, an expression
    w.put(1, 3); // strings, resources
    w.put(1);
    w.blob(5, [0x746e6954, 0]); // "Tint\0"
    w.put(0xffffffff, 2, 0xffffffff, 0, 1); // the sampler's Texture reads a parameter
    w.blob(4, [0x00786574]); // "tex\0"
    w.put(0, 0, 0xffffffff, 0, 0); // the pass's shader
    w.blob(VS.length * 4, VS);
    w.put(0, 0, 0xffffffff, 2, 0); // CullMode's expression
    w.blob(FXLC.length * 4, FXLC);

    const body = new Uint32Array([FX_2_0, start, ...w.words]);
    return new Uint8Array(body.buffer);
}

test('a compiled effect is read into the model the source path builds', ()=>{
    const { model, messages } = readCompiledEffect(effect());
    assert.ok(model, messages);
    const [tint, tex, sampler] = model.parameters;
    assert.equal(tint.name, 'tint');
    assert.equal(tint.semantic, 'DIFFUSE');
    assert.deepEqual([tint.cls, tint.type, tint.rows, tint.columns, tint.bytes],
        [PC.VECTOR, PT.FLOAT, 1, 4, 16]);
    assert.deepEqual(tint.init, [{ word: floatBits(1) }, { word: floatBits(0.5) }, { word: 0 },
        { word: floatBits(1) }]);
    assert.equal(tint.annotations[0].name, 'UIName');
    assert.deepEqual(tint.annotations[0].init, [{ string: 'Tint' }]);
    assert.equal(tint.annotations[0].flags, 4, 'D3DX_PARAMETER_ANNOTATION');
    assert.deepEqual(tex.init, [{ word: 0 }]);

    const [texture, minFilter] = sampler.samplers[0] ?? [];
    assert.deepEqual([texture.kind, texture.source], ['texture', { kind: 'param', path: 'tex' }]);
    assert.deepEqual([minFilter.kind, minFilter.op, minFilter.source],
        ['sampler', 6, { kind: 'const', words: [2] }]);

    const pass = model.techniques[0].passes[0];
    assert.equal(model.techniques[0].name, 'T');
    assert.equal(pass.name, 'P0');
    assert.deepEqual(pass.states.map(s=>s.name), ['VertexShader', 'ZEnable', 'CullMode']);
    const cull = pass.states[2].source;
    assert.equal(cull.kind, 'expression');
    assert.deepEqual(cull.kind === 'expression'
        ? [cull.type, cull.count, cull.program.run(()=>null)] : [], [PT.INT, 1, [3]]);
    assert.deepEqual(pass.states[0].source, { kind: 'shader', shader: 0 });
    assert.deepEqual(pass.states[1].source, { kind: 'const', words: [1] });
    assert.equal(model.shaders[0].profile, 'vs_1_1');
    assert.deepEqual([...model.shaders[0].tokens ?? []], VS);
    assert.deepEqual([...model.shaders[0].constantTable ?? []], [0x1c, 0, 0, 0]);
    assert.match(messages, /preshader is not run/);
});

test('what is not a compiled effect, or runs past its end, is refused with a reason', ()=>{
    assert.equal(readCompiledEffect(new Uint8Array(8)).model, null);
    const cut = effect().subarray(0, 200);
    const { model, messages } = readCompiledEffect(cut);
    assert.equal(model, null);
    assert.match(messages, /^error: /);
});
