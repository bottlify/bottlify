/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD3dxFunctions } from './functions.js';
import { parseShader } from '../../graphics/d3d9/shader.js';
import { translateShader } from '../../graphics/d3d9/wgsl.js';

const E_FAIL = 0x80004005;
const D3DERR_INVALIDCALL = 0x8876086c;

const OPEN = 0x1111;
const CLOSE = 0x2222;

/** A guest with a heap, a place for COM objects, and an include that serves some files. */
function guest(files = {}){
    const memory = new Uint8Array(0x100000);
    const view = new DataView(memory.buffer);
    let free = 0x20000;
    /** @type {any[]} */
    const published = [];
    const INCLUDE = 0x400;
    view.setUint32(INCLUDE, 0x410, true);
    view.setUint32(0x410, OPEN, true);
    view.setUint32(0x414, CLOSE, true);
    /** @type {string[]} */
    const opened = [];
    const fns = /** @type {any} */ (createD3dxFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        heap: { allocate: bytes=>{
            const at = free;
            free += bytes + 15 & ~15;
            return at;
        }, free: ()=>{} },
        vtables: { publish: object=>{
            published.push(object);
            return 0x300 + published.length * 16;
        } },
        callGuest: ({ entry, args })=>{
            if (entry === OPEN)
            {
                // Open(this, type, name, parentData, ppData, pBytes)
                const [, , name, , data, bytes] = args;
                let text = '';
                for (let at = name; memory[at] !== 0; at++)
                {
                    text += String.fromCharCode(memory[at]);
                }
                opened.push(text);
                const content = /** @type {Record<string, string>} */ (files)[text];
                if (content === undefined)
                {
                    return Promise.resolve(0x80004005);
                }
                const where = free;
                free += content.length + 16 & ~15;
                memory.set([...content].map(c=>c.charCodeAt(0)), where);
                view.setUint32(data, where, true);
                view.setUint32(bytes, content.length, true);
            }
            return Promise.resolve(0);
        },
    }));
    /** @param {string} text */
    const put = text=>{
        const at = free;
        memory.set([...text].map(c=>c.charCodeAt(0)), at);
        memory[at + text.length] = 0;
        free += text.length + 16 & ~15;
        return at;
    };
    /** @param {number} pointer The out parameter's contents, as the buffer object. */
    const buffer = pointer=>{
        const at = view.getUint32(pointer, true);
        return at === 0 ? null : published[(at - 0x300) / 16 - 1];
    };
    /** @param {number} pointer */
    const text = pointer=>{
        const object = buffer(pointer);
        return object === null ? null : String.fromCharCode(
            ...memory.subarray(object.state.data, object.state.data + object.state.size - 1));
    };
    /**
     * @param {string} source @param {string | null} entry @param {string} profile
     * @param {{ defines?: [string, string][], include?: boolean, flags?: number }} [options]
     */
    const compile = async(source, entry, profile, options = {})=>{
        const code = put(source);
        const out = 0x800;
        view.setUint32(out, 0xdead, true);
        view.setUint32(out + 4, 0xdead, true);
        view.setUint32(out + 8, 0xdead, true);
        let macros = 0;
        if (options.defines)
        {
            macros = free;
            free += 8 * (options.defines.length + 1);
            let at = macros;
            for (const [name, value] of options.defines)
            {
                view.setUint32(at, put(name), true);
                view.setUint32(at + 4, put(value), true);
                at += 8;
            }
        }
        const answer = await fns.D3DXCompileShader.handler([code, source.length, macros,
            options.include ? INCLUDE : 0, entry === null ? 0 : put(entry), put(profile),
            options.flags ?? 0, out, out + 4, out + 8]);
        return { answer: answer >>> 0, shader: out, errors: out + 4, table: out + 8 };
    };
    return { compile, buffer, text, put, memory, view, published, opened, fns };
}

/** The bytecode in a buffer object. @param {any} object @param {Uint8Array} memory */
function words(object, memory){
    const { data, size } = object.state;
    return new Uint32Array(memory.slice(data, data + size).buffer);
}

const PIXEL = `
sampler2D Diffuse : register(s0);
float4 Tint = float4(1, 0.5, 0.25, 1);
float4 main(float2 uv : TEXCOORD0) : COLOR0
{
    return tex2D(Diffuse, uv) * Tint;
}`;

test('a pixel shader compiles to bytecode the translator takes, with its constant table', async()=>{
    const g = guest();
    const result = await g.compile(PIXEL, 'main', 'ps_2_0');
    assert.equal(result.answer, 0);
    const shader = g.buffer(result.shader);
    const tokens = words(shader, g.memory);
    assert.equal(tokens[0], 0xffff0200);
    const parsed = parseShader(tokens);
    assert.equal(parsed.error, null);
    assert.equal(translateShader(parsed).error, null);
    assert.equal(g.view.getUint32(result.errors, true), 0, 'no warnings, no error buffer');
    assert.notEqual(g.view.getUint32(result.table, true), 0, 'a constant table');
});

test('the constant table the compile hands out is the one in the bytecode', async()=>{
    const g = guest();
    const result = await g.compile(PIXEL, 'main', 'ps_2_0');
    const table = g.buffer(result.table);
    assert.ok(table, 'an object');
    const names = table.state.constants.map((/** @type {any} */ c)=>[c.name, c.set, c.index]);
    assert.deepEqual(names, [['Diffuse', 3, 0], ['Tint', 2, 0]]);
});

test('a source with an error answers E_FAIL with fxc\'s message and no shader', async()=>{
    const g = guest();
    const result = await g.compile('float4 main() : COLOR0\n{\n    return foo;\n}\n', 'main',
        'ps_2_0');
    assert.equal(result.answer, E_FAIL);
    assert.equal(g.view.getUint32(result.shader, true), 0);
    assert.equal(g.view.getUint32(result.table, true), 0);
    assert.equal(g.text(result.errors),
        'memory(3,12): error X3004: undeclared identifier \'foo\'\n');
});

test('a syntax error and a missing entry point are reported too', async()=>{
    const g = guest();
    let result = await g.compile('float4 main() : COLOR0 { return 1 }', 'main', 'ps_2_0');
    assert.equal(result.answer, E_FAIL);
    assert.match(/** @type {string} */ (g.text(result.errors)), /error X3000: syntax error/);
    result = await g.compile(PIXEL, 'missing', 'ps_2_0');
    assert.equal(result.answer, E_FAIL);
    assert.match(/** @type {string} */ (g.text(result.errors)), /error X3501: 'missing'/);
});

test('a null function name means main; a profile that is none is refused', async()=>{
    const g = guest();
    assert.equal((await g.compile(PIXEL, null, 'ps_2_0')).answer, 0);
    const result = await g.compile(PIXEL, 'main', 'ps_9_9');
    assert.equal(result.answer, E_FAIL);
    assert.match(/** @type {string} */ (g.text(result.errors)), /X3506: 'ps_9_9'/);
});

test('the program\'s macros are defined and its includes are read', async()=>{
    const g = guest({ 'lib.fxh': 'float4 Scale(float4 x){ return x * K; }' });
    const result = await g.compile('#include "lib.fxh"\nfloat4 main(float4 c : COLOR0) : COLOR0'
        + '{ return Scale(c); }', 'main', 'ps_2_0', { defines: [['K', '2.0']], include: true });
    assert.equal(result.answer, 0, String(g.text(result.errors)));
    assert.deepEqual(g.opened, ['lib.fxh']);
    const missing = await g.compile('#include "gone.fxh"\n', 'main', 'ps_2_0', { include: true });
    assert.equal(missing.answer, E_FAIL);
    assert.match(/** @type {string} */ (g.text(missing.errors)), /cannot open include file/);
});

test('an error in an included file names that file and its own line', async()=>{
    const g = guest({ 'bad.fxh': '\n\nfloat4 Bad(){ return nothing; }\n' });
    const result = await g.compile('#include "bad.fxh"\nfloat4 main() : COLOR0 { return Bad(); }',
        'main', 'ps_2_0', { include: true });
    assert.equal(result.answer, E_FAIL);
    assert.match(/** @type {string} */ (g.text(result.errors)),
        /^bad\.fxh\(3,\d+\): error X3004: undeclared identifier 'nothing'/);
});

test('invalid arguments are refused before anything is written', async()=>{
    const g = guest();
    const bad = await g.fns.D3DXCompileShader.handler([0, 0, 0, 0, 0, 0, 0, 0x800, 0, 0]);
    assert.equal(bad >>> 0, D3DERR_INVALIDCALL);
});

test('warnings come back in the error buffer of a compile that succeeded', async()=>{
    const g = guest();
    const result = await g.compile('float4 main(float4 c : COLOR0) : COLOR0'
        + '{ float3 t = c; return float4(t, 1); }', 'main', 'ps_2_0');
    assert.equal(result.answer, 0);
    assert.match(/** @type {string} */ (g.text(result.errors)), /warning X3206/);
});

test('every profile of the family compiles the same vertex shader', async()=>{
    const g = guest();
    const source = 'float4x4 M; float4 main(float4 p : POSITION) : POSITION { return mul(p, M); }';
    for (const profile of ['vs_1_1', 'vs_2_0', 'vs_2_a', 'vs_3_0'])
    {
        const result = await g.compile(source, 'main', profile);
        assert.equal(result.answer, 0, profile);
        const tokens = words(g.buffer(result.shader), g.memory);
        assert.equal(translateShader(parseShader(tokens)).error, null, profile);
    }
});

/** A guest for the assembler's exports: the same heap and buffers, its own tests below. */
const ASSEMBLY = `
ps_2_0
dcl t0.xy
dcl_2d s0
texld r0, t0, s0
mul r0, r0, c0
mov oC0, r0
`;

test('D3DXAssembleShader assembles to bytecode the translator takes', async()=>{
    const g = guest();
    const source = g.put(ASSEMBLY);
    const out = 0x800;
    const answer = await g.fns.D3DXAssembleShader.handler([source, ASSEMBLY.length, 0, 0, 0,
        out, out + 4]);
    assert.equal(answer, 0);
    const tokens = words(g.buffer(out), g.memory);
    assert.equal(tokens[0], 0xffff0200);
    assert.equal(tokens[tokens.length - 1], 0xffff);
    const parsed = parseShader(tokens);
    assert.equal(parsed.error, null);
    assert.equal(translateShader(parsed).error, null);
    assert.equal(g.view.getUint32(out + 4, true), 0, 'no error buffer');
});

test('D3DXAssembleShader expands the program\'s macros and names the bad line', async()=>{
    const g = guest();
    const text = '#define SRC c0\nps_2_0\nmov r0, REG\nbogus r0\nmov oC0, SRC\n';
    const source = g.put(text);
    const out = 0x800;
    const name = g.put('REG');
    const value = g.put('c3');
    const macros = 0x900;
    g.view.setUint32(macros, name, true);
    g.view.setUint32(macros + 4, value, true);
    g.view.setUint32(macros + 8, 0, true);
    const answer = await g.fns.D3DXAssembleShader.handler([source, text.length, macros, 0, 0,
        out, out + 4]);
    assert.equal(answer, E_FAIL);
    assert.equal(g.view.getUint32(out, true), 0, 'no shader');
    assert.match(/** @type {string} */ (g.text(out + 4)), /^memory\(4\): error: [^\n]*\n$/,
        'one error, on the bad line; the macros expanded');
});

test('D3DXDisassembleShader lists what D3DXAssembleShader wrote, and refuses what is no shader',
    async()=>{
        const g = guest();
        const out = 0x800;
        await g.fns.D3DXAssembleShader.handler([g.put(ASSEMBLY), ASSEMBLY.length, 0, 0, 0, out,
            out + 4]);
        const object = g.buffer(out);
        const listing = 0xa00;
        assert.equal(g.fns.D3DXDisassembleShader.handler([object.state.data, 0, 0, listing]), 0);
        const text = /** @type {string} */ (g.text(listing));
        assert.match(text, /^\s+ps_2_0\n/);
        assert.match(text, /texld r0, t0, s0/);
        // What it lists assembles to the same tokens.
        const again = 0xb00;
        assert.equal(await g.fns.D3DXAssembleShader.handler([g.put(text), text.length - 1, 0, 0,
            0, again, again + 4]), 0);
        assert.deepEqual([...words(g.buffer(again), g.memory)],
            [...words(object, g.memory)]);
        g.memory.fill(0, 0x1f00, 0x2000);
        assert.equal(g.fns.D3DXDisassembleShader.handler([0x1f00, 0, 0, listing]) >>> 0,
            D3DERR_INVALIDCALL);
    });

test('a compile asked again answers as before, until a file it included changes', async()=>{
    /** @type {Record<string, string>} */
    const files = { 'k.h': '#define K 0.25' };
    const g = guest(files);
    const source = '#include "k.h"\nfloat4 main() : COLOR { return K; }';
    const bytes = async()=>{
        const { answer, shader } = await g.compile(source, 'main', 'ps_2_0', { include: true });
        assert.equal(answer, 0);
        return words(g.buffer(shader), g.memory);
    };
    const first = await bytes();
    assert.deepEqual(await bytes(), first);
    assert.deepEqual(g.opened, ['k.h', 'k.h'], 'the include is asked for again and compared');
    files['k.h'] = '#define K 0.5';
    assert.notDeepEqual(await bytes(), first, 'a changed include is compiled anew');
    // A refusal answers the same each time, its message with it.
    for (let i = 0; i < 2; i++)
    {
        const refused = await g.compile('float4 main() : COLOR { return x; }', 'main', 'ps_2_0');
        assert.equal(refused.answer, E_FAIL);
        assert.match(String(g.text(refused.errors)), /X3004: undeclared identifier 'x'/);
    }
});
