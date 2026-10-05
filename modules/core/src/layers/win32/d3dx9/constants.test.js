/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConstantTables, registerValues } from './constants.js';

/**
 * A vertex shader's bytecode as a compiler writes it: the version token, then
 * the CTAB comment -- a matrix packed by column at c0, a colour at c4, an array
 * of two vectors at c5 with a default, a sampler at s0 -- then the end token.
 */
function shader(){
    /** @type {number[]} */
    const block = [];
    const strings = new Map();
    // D3DXSHADER_CONSTANTTABLE, then four CONSTANTINFO, four TYPEINFO, the
    // names and the default; offsets from the block's start.
    const infos = 28;
    const types = infos + 4 * 20;
    const names = types + 4 * 16;
    const text = ['WorldViewProj', 'Color', 'Lights', 'Diffuse', 'test compiler', 'vs_3_0'];
    let at = names;
    for (const name of text)
    {
        strings.set(name, at);
        at += name.length + 1;
    }
    at = (at + 3) & ~3;
    const defaults = at;
    const word = (/** @type {number} */ value)=>block.push(value >>> 0);
    word(28); word(strings.get('test compiler')); word(0xfffe0300); word(4); word(infos);
    word(0); word(strings.get('vs_3_0'));
    /** name, set, index, count, type record, default */
    const constants = [['WorldViewProj', 2, 0, 4, 0, 0], ['Color', 2, 4, 1, 1, 0],
        ['Lights', 2, 5, 2, 2, defaults], ['Diffuse', 3, 0, 1, 3, 0]];
    for (const [name, set, index, count, type, fallback] of constants)
    {
        word(strings.get(name));
        word(Number(set) | Number(index) << 16);
        word(Number(count));
        word(types + Number(type) * 16);
        word(Number(fallback));
    }
    /** class, type, rows, columns, elements, members */
    for (const [cls, type, rows, columns, elements] of [[3, 3, 4, 4, 1], [1, 3, 1, 4, 1],
        [1, 3, 1, 4, 2], [4, 12, 1, 1, 1]])
    {
        word(cls | type << 16);
        word(rows | columns << 16);
        word(elements);
        word(0);
    }
    const bytes = new Uint8Array(defaults + 32);
    const view = new DataView(bytes.buffer);
    block.forEach((value, i)=>view.setUint32(i * 4, value, true));
    for (const [name, offset] of strings)
    {
        bytes.set(new TextEncoder().encode(name), offset);
    }
    [1, 2, 3, 4, 5, 6, 7, 8].forEach((value, i)=>view.setFloat32(defaults + i * 4, value, true));
    const length = 1 + bytes.length / 4;
    const head = new Uint8Array(Uint32Array.of(0xfffe0300, 0xfffe | length << 16, 0x42415443)
        .buffer);
    const end = new Uint8Array(Uint32Array.of(0x0000ffff).buffer);
    return new Uint8Array([...head, ...bytes, ...end]);
}

function machine(){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    let free = 0x4000;
    /** @type {any[]} */
    const published = [];
    /** @type {{ slot: number, args: number[], data: number[] }[]} */
    const calls = [];
    // A device whose vtable's slot n holds n, so a call names its method.
    const DEVICE = 0x100;
    view.setUint32(DEVICE, 0x200, true);
    for (let slot = 0; slot < 120; slot++)
    {
        view.setUint32(0x200 + slot * 4, slot, true);
    }
    const tables = createConstantTables({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        heap: { allocate: bytes=>{
            const at = free;
            free += bytes + 15 & ~15;
            return at;
        }, free: ()=>{} },
        vtables: { publish: object=>{
            published.push(object);
            return 0x300;
        } },
        callGuest: ({ entry, args })=>{
            const [, , data, count] = args;
            const integer = entry === 96 || entry === 98 || entry === 111 || entry === 113;
            calls.push({ slot: entry, args, data: Array.from({ length: count * 4 }, (_, i)=>
                (integer ? view.getInt32(data + i * 4, true)
                    : view.getFloat32(data + i * 4, true))) });
            return Promise.resolve(0);
        },
    });
    const code = shader();
    memory.set(code, 0x1000);
    /** @param {string} text */
    const put = (text, at = 0x3000)=>{
        memory.set([...new TextEncoder().encode(text), 0], at);
        return at;
    };
    return { memory, view, tables, published, calls, DEVICE, put };
}

test('a shader\'s constants come out of its CTAB comment, by name and by register', ()=>{
    const m = machine();
    assert.equal(m.tables.D3DXGetShaderConstantTable.argBytes, 8);
    assert.equal(m.tables.D3DXGetShaderConstantTable.handler([0x1000, 0x50]), 0);
    assert.equal(m.view.getUint32(0x50, true), 0x300, 'the interface pointer');
    const [table] = m.published;
    const methods = table.interfaceFor('{AB3C758F-093E-4356-B762-4DB18F1B3A01}').methods;
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>methods.find((/** @type {any} */ one)=>one.name === name)
        .invoke(table, args);

    assert.equal(call('GetDesc', 0x60), 0);
    assert.deepEqual([4, 8].map(at=>m.view.getUint32(0x60 + at, true)), [0xfffe0300, 4]);
    const creator = m.view.getUint32(0x60, true);
    assert.equal(new TextDecoder().decode(m.memory.subarray(creator, creator + 13)),
        'test compiler');

    const color = call('GetConstantByName', 0, m.put('Color'));
    assert.notEqual(color, 0);
    assert.equal(call('GetConstant', 0, 1), color, 'the second constant is that one');
    assert.equal(call('GetConstantDesc', color, 0x80, 0x70), 0);
    const desc = Array.from({ length: 12 }, (_, i)=>m.view.getUint32(0x80 + i * 4, true));
    assert.deepEqual(desc.slice(1, 11), [2, 4, 1, 1, 3, 1, 4, 1, 0, 16],
        'FLOAT4 c4, one register, a vector of four floats, sixteen bytes');
    assert.equal(new TextDecoder().decode(m.memory.subarray(desc[0], desc[0] + 5)), 'Color');
    assert.equal(m.view.getUint32(0x70, true), 1);

    assert.equal(call('GetSamplerIndex', call('GetConstantByName', 0, m.put('Diffuse'))), 0);
    assert.equal(call('GetSamplerIndex', color), 0xffffffff, 'not a sampler');
    assert.equal(call('GetConstantByName', 0, m.put('Missing')), 0);
    const second = call('GetConstantElement', call('GetConstantByName', 0, m.put('Lights')), 1);
    call('GetConstantDesc', second, 0x80, 0);
    assert.deepEqual([2, 3, 8].map(i=>m.view.getUint32(0x80 + i * 4, true)), [6, 1, 1],
        'the second light is c6');
    assert.equal(call('GetConstantDesc', m.put('Lights[1]'), 0x80, 0), 0, 'a name is a handle too');
    assert.equal(m.view.getUint32(0x88, true), 6);
});

test('the setters lay the values over the registers the table names, through the device', async()=>{
    const m = machine();
    m.tables.D3DXGetShaderConstantTable.handler([0x1000, 0x50]);
    const [table] = m.published;
    const methods = table.interfaceFor('{AB3C758F-093E-4356-B762-4DB18F1B3A01}').methods;
    /** @param {string} name @param {number[]} args */
    const call = (name, ...args)=>methods.find((/** @type {any} */ one)=>one.name === name)
        .invoke(table, args);
    const matrix = Array.from({ length: 16 }, (_, i)=>i + 1);
    new Float32Array(m.memory.buffer, 0x2000, 16).set(matrix);

    // Packed by column: each register is a column of the matrix.
    assert.equal(await call('SetMatrix', m.DEVICE, m.put('WorldViewProj'), 0x2000), 0);
    assert.deepEqual(m.calls[0].slot, 94, 'SetVertexShaderConstantF');
    assert.deepEqual(m.calls[0].args.slice(0, 2), [m.DEVICE, 0]);
    assert.deepEqual(m.calls[0].args[3], 4);
    assert.deepEqual(m.calls[0].data, [1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15, 4, 8, 12, 16]);
    await call('SetMatrixTranspose', m.DEVICE, m.put('WorldViewProj'), 0x2000);
    assert.deepEqual(m.calls[1].data, matrix, 'and transposed first, the rows');

    await call('SetVector', m.DEVICE, m.put('Color'), 0x2000);
    assert.deepEqual([m.calls[2].args[1], m.calls[2].data], [4, [1, 2, 3, 4]]);
    await call('SetVectorArray', m.DEVICE, m.put('Lights'), 0x2000, 2);
    assert.deepEqual([m.calls[3].args[1], m.calls[3].args[3], m.calls[3].data],
        [5, 2, [1, 2, 3, 4, 5, 6, 7, 8]]);
    await call('SetFloat', m.DEVICE, m.put('Color'),
        new Uint32Array(Float32Array.of(0.5).buffer)[0]);
    assert.deepEqual(m.calls[4].data, [0.5, 0, 0, 0], 'a float fills the first lane');
    await call('SetDefaults', m.DEVICE);
    assert.deepEqual([m.calls[5].args[1], m.calls[5].data], [5, [1, 2, 3, 4, 5, 6, 7, 8]]);
    assert.equal(call('SetFloat', m.DEVICE, m.put('Missing'), 0) >>> 0, 0x8876086c);
});

test('values take the shape of the constant: scalars, vectors, matrices by row and by column', ()=>{
    const base = { name: '', nameAt: 0, set: 2, index: 0, type: 3, members: [], defaultAt: 0 };
    assert.deepEqual(registerValues({ ...base, cls: 0, rows: 1, columns: 1, elements: 3,
        count: 3 }, [7, 8, 9]).registers, [7, 0, 0, 0, 8, 0, 0, 0, 9, 0, 0, 0]);
    assert.deepEqual(registerValues({ ...base, cls: 2, rows: 2, columns: 3, elements: 1,
        count: 2 }, [1, 2, 3, 4, 5, 6]).registers, [1, 2, 3, 0, 4, 5, 6, 0]);
    assert.deepEqual(registerValues({ ...base, cls: 3, rows: 2, columns: 3, elements: 1,
        count: 3 }, [1, 2, 3, 4, 5, 6]).registers, [1, 4, 0, 0, 2, 5, 0, 0, 3, 6, 0, 0]);
    assert.equal(registerValues({ ...base, cls: 1, rows: 1, columns: 4, elements: 2,
        count: 2 }, [1, 2, 3, 4]).count, 1, 'only the registers the values fill');
});
