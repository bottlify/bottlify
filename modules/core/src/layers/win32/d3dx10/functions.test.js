/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createD3dx10Functions } from './functions.js';

/**
 * Guest memory, a bump heap, and a device whose vtable's slot N holds N, so
 * that a call's entry says which method was called.
 */
function machine(){
    const memory = new Uint8Array(1 << 20);
    const view = new DataView(memory.buffer);
    let next = 0x10000;
    const vtable = 0x100;
    const device = 0x80;
    for (let slot = 0; slot < 100; slot++)
    {
        view.setUint32(vtable + slot * 4, slot, true);
    }
    view.setUint32(device, vtable, true);
    /** @type {{ slot: number, args: number[], desc: number[], data: number[][] }[]} */
    const calls = [];
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
        heap: {
            allocate: (/** @type {number} */ bytes)=>{
                const at = next;
                next += (bytes + 15) & ~15;
                return at;
            },
            free: ()=>{},
        },
        divergence: ()=>{},
        callGuest: async(/** @type {{ entry: number, args: number[] }} */ { entry, args })=>{
            const [, desc, data, out] = args;
            const words = Array.from({ length: 11 }, (_, i)=>view.getUint32(desc + i * 4, true));
            const levels = words[2] * words[3];
            calls.push({ slot: entry, args, desc: words,
                data: Array.from({ length: levels }, (_, i)=>[0, 1, 2].map(k=>
                    view.getUint32(data + i * 12 + k * 4, true))) });
            view.setUint32(out, 0xabc0, true);
            return 0;
        },
    };
    return { memory, view, host, device, calls };
}

/** A DDS file of A8R8G8B8 texels, one level. @param {number} width @param {number} height */
function dds(width, height){
    const bytes = new Uint8Array(128 + width * height * 4);
    const view = new DataView(bytes.buffer);
    bytes.set([0x44, 0x44, 0x53, 0x20]);
    view.setUint32(4, 124, true);
    view.setUint32(8, 0x1007, true);
    view.setUint32(12, height, true);
    view.setUint32(16, width, true);
    view.setUint32(76, 32, true);
    view.setUint32(80, 0x41, true);
    view.setUint32(88, 32, true);
    view.setUint32(92, 0xff0000, true);
    view.setUint32(96, 0xff00, true);
    view.setUint32(100, 0xff, true);
    view.setUint32(104, 0xff000000, true);
    bytes.fill(0x7f, 128);
    return bytes;
}

test('D3DX10CreateTextureFromMemory makes a 2D texture with the full chain through'
    + ' CreateTexture2D', async()=>{
    const { host, device, calls, view, memory } = machine();
    const fns = createD3dx10Functions(host, 34);
    const file = dds(4, 2);
    memory.set(file, 0x8000);
    const hr = await fns.D3DX10CreateTextureFromMemory.handler([device, 0x8000, file.length, 0,
        0, 0x200, 0x204]);
    assert.equal(hr, 0);
    assert.equal(view.getUint32(0x204, true), 0);
    assert.equal(view.getUint32(0x200, true), 0xabc0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].slot, 73);
    // Width, Height, MipLevels, ArraySize, Format, SampleDesc, Usage, BindFlags, CPU, Misc.
    assert.deepEqual(calls[0].desc, [4, 2, 3, 1, 87, 1, 0, 0, 0x8, 0, 0]);
    assert.deepEqual(calls[0].data.map(([, pitch])=>pitch), [16, 8, 4]);
    // Each level's texels after the one before's: 4x2, then the halved 2x1 and 1x1.
    assert.deepEqual(calls[0].data.map(([at])=>at - calls[0].data[0][0]), [0, 32, 40]);
});

test('D3DX10CompileFromMemory with no compiler refuses, with an error blob and the HRESULT',
    async()=>{
        const { host, view, memory } = machine();
        /** @type {any[]} */
        const published = [];
        const fns = createD3dx10Functions({ ...host, vtables: { publish: object=>{
            published.push(object);
            return 0x5000;
        } } }, 34);
        memory.set([...'ps_4_0\0'].map(c=>c.charCodeAt(0)), 0x300);
        view.setUint32(0x400, 0xdead, true);
        const hr = await fns.D3DX10CompileFromMemory.handler([0x1000, 10, 0, 0, 0, 0, 0x300, 0,
            0, 0, 0x400, 0x404, 0x408]);
        assert.equal(hr >>> 0, 0x80004005);
        assert.equal(view.getUint32(0x400, true), 0);
        assert.equal(view.getUint32(0x404, true), 0x5000);
        assert.equal(view.getUint32(0x408, true), 0x80004005);
        assert.equal(published.length, 1);
    });

test('D3DX10CompileFromMemory hands its compile to the process\'s D3DCompile', async()=>{
    // d3dx10_43 calls d3dcompiler_43's D3DCompile with its own arguments but
    // the thread pump; the answer is the call's and pHResult's both.
    const { host, view } = machine();
    /** @type {{ entry: number, args: number[] }[]} */
    const called = [];
    const fns = createD3dx10Functions({ ...host, compiler: async()=>0x7000,
        callGuest: async(/** @type {any} */ { entry, args })=>{
            called.push({ entry, args });
            return 0;
        } }, 43);
    const args = [0x1000, 10, 0x1100, 0x1200, 0x1300, 0x1400, 0x1500, 0x8, 0x9, 0xbeef,
        0x400, 0x404, 0x408];
    assert.equal(await fns.D3DX10CompileFromMemory.handler(args), 0);
    assert.deepEqual(called, [{ entry: 0x7000,
        args: [0x1000, 10, 0x1100, 0x1200, 0x1300, 0x1400, 0x1500, 0x8, 0x9, 0x400, 0x404] }]);
    assert.equal(view.getUint32(0x408, true), 0);
});

test('D3DX10UnsetAllDeviceObjects unbinds through the device\'s own setters', async()=>{
    const { host, device } = machine();
    /** @type {number[]} */
    const slots = [];
    const fns = createD3dx10Functions({ ...host,
        callGuest: async(/** @type {any} */ { entry, args })=>{
            assert.equal(args[0], device, 'each a method of the device');
            slots.push(entry);
            return 0;
        } }, 43);
    assert.equal(await fns.D3DX10UnsetAllDeviceObjects.handler([device]), 0);
    // VS, PS and GS: constant buffers, resources, samplers, shader; then the
    // input assembler, stream output, the output merger and the rasterizer.
    assert.deepEqual(slots, [3, 19, 20, 7, 10, 4, 6, 5, 16, 22, 23, 17, 12, 13, 11, 27, 24, 25,
        26, 29]);
    assert.equal(await fns.D3DX10UnsetAllDeviceObjects.handler([0]) >>> 0, 0x80070057);
});

test('D3DX10CheckVersion holds the program to its own SDK versions', ()=>{
    const fns = createD3dx10Functions(machine().host, 34);
    assert.equal(fns.D3DX10CheckVersion.handler([29, 34]), 1);
    assert.equal(fns.D3DX10CheckVersion.handler([29, 33]), 0);
});
