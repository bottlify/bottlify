/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    COMPONENT_TYPE, SHADER_KIND, SYSTEM_VALUE, parseDxbc, parseShaderOfKind,
} from './dxbc.js';
import { OPCODE, decodeSm4 } from './sm4.js';
import {
    assemble, container, dclInput, dclOutputSiv, mov, o, passThroughVertexShader, ret,
    solidPixelShader, v,
} from './shader-fixtures.js';

/**
 * A pass-through vertex shader as a real compiler laid it out, dword by dword:
 * the header, three chunks at their offsets, a one-element input signature, a
 * one-element output signature and a four-instruction program. This is the
 * one blob here that did not come out of the assembler beside it, which is
 * what keeps the assembler and the parser from agreeing by construction.
 */
const COMPILED_PASS_THROUGH = Uint32Array.from([
    0x43425844, 0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x00000001, 0x000000d8, 0x00000003,
    0x0000002c, 0x00000060, 0x00000094,
    0x4e475349, 0x0000002c, 0x00000001, 0x00000008, 0x00000020, 0x00000000, 0x00000000, 0x00000003,
    0x00000000, 0x00000f0f, 0x49534f50, 0x4e4f4954, 0xababab00,
    0x4e47534f, 0x0000002c, 0x00000001, 0x00000008, 0x00000020, 0x00000000, 0x00000001, 0x00000003,
    0x00000000, 0x0000000f, 0x505f5653, 0x5449534f, 0x004e4f49,
    0x52444853, 0x0000003c, 0x00010040, 0x0000000f, 0x0300005f, 0x001010f2, 0x00000000, 0x04000067,
    0x001020f2, 0x00000000, 0x00000001, 0x05000036, 0x001020f2, 0x00000000, 0x00101e46, 0x00000000,
    0x0100003e,
]);

/** @param {Uint32Array} words */
function bytesOf(words){
    const bytes = new Uint8Array(words.length * 4);
    const view = new DataView(bytes.buffer);
    words.forEach((word, index)=>view.setUint32(index * 4, word, true));
    return bytes;
}

test('a compiled container yields its signatures and its program', ()=>{
    const parsed = parseDxbc(bytesOf(COMPILED_PASS_THROUGH));
    assert.ok(parsed);
    assert.deepEqual([...parsed.chunks.keys()], ['ISGN', 'OSGN', 'SHDR']);
    assert.deepEqual(parsed.inputs, [{
        name: 'POSITION', index: 0, systemValue: SYSTEM_VALUE.UNDEFINED,
        componentType: COMPONENT_TYPE.FLOAT, register: 0, mask: 0xf, readWriteMask: 0xf,
    }]);
    assert.deepEqual(parsed.outputs, [{
        name: 'SV_POSITION', index: 0, systemValue: SYSTEM_VALUE.POSITION,
        componentType: COMPONENT_TYPE.FLOAT, register: 0, mask: 0xf, readWriteMask: 0,
    }]);
    assert.ok(parsed.shader);
    assert.equal(parsed.shader.kind, SHADER_KIND.VERTEX);
    assert.equal(parsed.shader.major, 4);
    assert.equal(parsed.shader.minor, 0);
    assert.equal(parsed.shader.tokens.length, 13, 'fifteen dwords less the two of the header');
});

test('the assembler produces the same tokens a compiler did for the same program', ()=>{
    const compiled = parseDxbc(bytesOf(COMPILED_PASS_THROUGH));
    const assembled = parseDxbc(passThroughVertexShader());
    assert.ok(compiled && compiled.shader && assembled && assembled.shader);
    assert.deepEqual([...assembled.shader.tokens], [...compiled.shader.tokens]);
    assert.deepEqual(assembled.inputs, compiled.inputs);
    assert.deepEqual(assembled.outputs, compiled.outputs);
    assert.deepEqual(decodeSm4(assembled.shader.tokens).map(instruction=>instruction.opcode),
        [OPCODE.DCL_INPUT, OPCODE.DCL_OUTPUT_SIV, OPCODE.MOV, OPCODE.RET]);
});

test('bytes that are not a container are refused rather than read', ()=>{
    assert.equal(parseDxbc(new Uint8Array(0)), null);
    assert.equal(parseDxbc(new Uint8Array(64)), null, 'no magic');
    // A Shader Model 3 program starts with its version token, not "DXBC".
    assert.equal(parseDxbc(bytesOf(Uint32Array.from([0xfffe0300, 0x0000ffff]))), null);
    const truncated = bytesOf(COMPILED_PASS_THROUGH).subarray(0, 100);
    assert.equal(parseDxbc(truncated), null, 'a chunk past the end');
    const overclaimed = bytesOf(COMPILED_PASS_THROUGH);
    new DataView(overclaimed.buffer).setUint32(24, 0x10000, true);
    assert.equal(parseDxbc(overclaimed), null, 'a total size past the end');
});

test('a create accepts only a program of its own kind', ()=>{
    const vertex = passThroughVertexShader();
    const pixel = solidPixelShader([1, 1, 1, 1]);
    assert.ok(parseShaderOfKind(vertex, SHADER_KIND.VERTEX));
    assert.ok(parseShaderOfKind(pixel, SHADER_KIND.PIXEL));
    assert.equal(parseShaderOfKind(pixel, SHADER_KIND.VERTEX), null);
    assert.equal(parseShaderOfKind(vertex, SHADER_KIND.PIXEL), null);
    assert.equal(parseShaderOfKind(vertex, SHADER_KIND.GEOMETRY), null);
    const signatureOnly = container([{ name: 'ISGN', bytes: new Uint8Array(8) }]);
    assert.ok(parseDxbc(signatureOnly), 'a container with no program still parses');
    assert.equal(parseShaderOfKind(signatureOnly, SHADER_KIND.VERTEX), null,
        'but is no shader');
});

test('a container with a program of another major version is no shader here', ()=>{
    const bytes = assemble({
        kind: SHADER_KIND.VERTEX,
        instructions: [dclInput(v(0)), dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
            mov(o(0), v(0)), ret()],
    });
    const parsed = parseDxbc(bytes);
    assert.ok(parsed && parsed.shader);
    const chunk = /** @type {Uint8Array} */ (parsed.chunks.get('SHDR'));
    // Version 5.0 in the header dword: major in bits 4..7.
    new DataView(chunk.buffer, chunk.byteOffset).setUint32(0, (1 << 16) | (5 << 4), true);
    assert.equal(parseShaderOfKind(bytes, SHADER_KIND.VERTEX), null);
});
