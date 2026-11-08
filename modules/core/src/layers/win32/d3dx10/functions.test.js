/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createD3dx10Functions } from './functions.js';
import { DIMENSION } from './dds10.js';
import { dds10 } from './dds10.fixture.js';
import { D3DX11_PROFILE } from '../d3dx11/functions.js';

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
    // A8R8G8B8 is made R8G8B8A8, as D3DX 10 makes every classic 32-bit colour.
    assert.deepEqual(calls[0].desc, [4, 2, 3, 1, 28, 1, 0, 0, 0x8, 0, 0]);
    assert.deepEqual(calls[0].data.map(([, pitch])=>pitch), [16, 8, 4]);
    // Each level's texels after the one before's: 4x2, then the halved 2x1 and 1x1.
    assert.deepEqual(calls[0].data.map(([at])=>at - calls[0].data[0][0]), [0, 32, 40]);
});

test('D3DX10GetImageInfoFromMemory says a DX10 DDS file\'s own DXGI format', async()=>{
    // 3DMark Vantage's lookup table: 256x1 R8_UNORM, no mip-count flag.
    const { host, view, memory } = machine();
    const fns = createD3dx10Functions(host, 34);
    const file = dds10({ width: 256, format: 61, bytes: 256 });
    memory.set(file, 0x8000);
    assert.equal(await fns.D3DX10GetImageInfoFromMemory.handler([0x8000, file.length, 0, 0x300,
        0]), 0);
    // Width, Height, Depth, ArraySize, MipLevels, MiscFlags, Format, ResourceDimension, IFF.
    assert.deepEqual(Array.from({ length: 9 }, (_, i)=>view.getUint32(0x300 + i * 4, true)),
        [256, 1, 1, 1, 1, 0, 61, 3, 4]);

    const cubes = dds10({ width: 1, height: 1, format: 10, misc: 0x4, bytes: 48 });
    memory.set(cubes, 0x8000);
    assert.equal(await fns.D3DX10GetImageInfoFromMemory.handler([0x8000, cubes.length, 0, 0x300,
        0]), 0);
    assert.deepEqual(Array.from({ length: 9 }, (_, i)=>view.getUint32(0x300 + i * 4, true)),
        [1, 1, 1, 6, 1, 0x4, 10, 3, 4], 'a cube: six slices, TEXTURECUBE');
});

test('D3DX10CreateTextureFromMemory makes a DX10 DDS texture in the file\'s format, its bytes'
    + ' as they are', async()=>{
    const { host, device, calls, view, memory } = machine();
    /** @type {string[]} */
    const said = [];
    const fns = createD3dx10Functions({ ...host, divergence: (/** @type {string} */ api,
        /** @type {string} */ detail)=>said.push(`${api}: ${detail}`) }, 34);
    // R16G16B16A16_FLOAT 4x2 with its three levels.
    const file = dds10({ width: 4, height: 2, format: 10, mips: 3, bytes: 88 });
    memory.set(file, 0x8000);
    assert.equal(await fns.D3DX10CreateTextureFromMemory.handler([device, 0x8000, file.length,
        0, 0, 0x200, 0]), 0);
    assert.equal(calls[0].slot, 73);
    assert.deepEqual(calls[0].desc, [4, 2, 3, 1, 10, 1, 0, 0, 0x8, 0, 0]);
    assert.deepEqual(calls[0].data.map(([, pitch])=>pitch), [32, 16, 8]);
    const first = calls[0].data[0][0];
    assert.deepEqual(calls[0].data.map(([at])=>[at - first, memory[at]]), [[0, 0], [64, 64],
        [80, 80]], 'each level the file\'s own bytes');
    assert.deepEqual(said, []);

    // R8_UNORM with one level: the rest averaged from it, byte for byte.
    const single = dds10({ width: 4, height: 4, format: 61, bytes: 16 });
    memory.set(single, 0x8000);
    calls.length = 0;
    assert.equal(await fns.D3DX10CreateTextureFromMemory.handler([device, 0x8000, single.length,
        0, 0, 0x200, 0]), 0);
    assert.deepEqual(calls[0].desc.slice(0, 5), [4, 4, 3, 1, 61]);
    const second = calls[0].data[1][0];
    // The file's bytes are 0..15 row by row: 0, 1, 4, 5 average to 3 (rounded).
    assert.deepEqual([...memory.subarray(second, second + 4)], [3, 5, 11, 13]);
    assert.deepEqual(said, [], 'averaging bytes is the box filter for R8');

    // BC7 is D3DX 11's: D3DX 10 does not read it; D3DX 11 keeps the one level the file has,
    // no codec making the others, and that is said.
    const blocks = dds10({ width: 8, height: 8, format: 98, bytes: 64 });
    memory.set(blocks, 0x8000);
    calls.length = 0;
    assert.equal(await fns.D3DX10CreateTextureFromMemory.handler([device, 0x8000, blocks.length,
        0, 0, 0x200, 0]) >>> 0, 0x80004005);
    // deepEqual above narrowed `said` to never[]; the array is the same.
    const heard = /** @type {string[]} */ (said);
    const eleven = createD3dx10Functions({ ...host, divergence: (/** @type {string} */ api,
        /** @type {string} */ detail)=>heard.push(`${api}: ${detail}`) }, 43, D3DX11_PROFILE);
    assert.equal(await eleven.D3DX11CreateTextureFromMemory.handler([device, 0x8000,
        blocks.length, 0, 0, 0x200, 0]), 0);
    assert.equal(calls[0].desc[2], 1, 'the one level the file has');
    assert.match(said.join('\n'), /3 levels of format 98 left out/);

    // A 1D file is a 1D texture: Width, MipLevels, ArraySize, Format, Usage, Bind, CPU, Misc.
    const line = dds10({ width: 8, format: 61, dimension: DIMENSION.TEXTURE1D, mips: 4,
        bytes: 15 });
    memory.set(line, 0x8000);
    calls.length = 0;
    assert.equal(await fns.D3DX10CreateTextureFromMemory.handler([device, 0x8000, line.length,
        0, 0, 0x200, 0]), 0);
    assert.equal(calls[0].slot, 72);
    assert.deepEqual(calls[0].desc.slice(0, 8), [8, 4, 1, 61, 0, 0x8, 0, 0]);
    assert.equal(view.getUint32(0x200, true), 0xabc0);
});

test('D3DX10CreateTextureFromMemory resizes a file to the size asked, then makes its chain',
    async()=>{
        const { host, device, calls, view, memory } = machine();
        /** @type {string[]} */
        const said = [];
        const fns = createD3dx10Functions({ ...host, divergence: (/** @type {string} */ api,
            /** @type {string} */ detail)=>said.push(`${api}: ${detail}`) }, 34);
        const file = dds(4, 2);
        memory.set(file, 0x8000);
        // D3DX10_IMAGE_LOAD_INFO: Width 8, Height 4, the rest D3DX10_DEFAULT.
        for (let i = 0; i < 12; i++)
        {
            view.setUint32(0x400 + i * 4, 0xffffffff, true);
        }
        view.setUint32(0x430, 0, true);
        view.setUint32(0x400, 8, true);
        view.setUint32(0x404, 4, true);
        assert.equal(await fns.D3DX10CreateTextureFromMemory.handler([device, 0x8000,
            file.length, 0x400, 0, 0x200, 0]), 0);
        assert.deepEqual(calls[0].desc.slice(0, 5), [8, 4, 4, 1, 28]);
        assert.deepEqual(calls[0].data.map(([, pitch])=>pitch), [32, 16, 8, 4]);
        const top = calls[0].data[0][0];
        assert.deepEqual([...memory.subarray(top, top + 4)], [0x7f, 0x7f, 0x7f, 0x7f],
            'the file\'s texels, stretched');

        // Vantage's lookup table: 256x1 R8_UNORM asked as 128x4, stretched texel by texel.
        view.setUint32(0x400, 128, true);
        const table = dds10({ width: 256, format: 61, bytes: 256 });
        memory.set(table, 0x8000);
        calls.length = 0;
        assert.equal(await fns.D3DX10CreateTextureFromMemory.handler([device, 0x8000,
            table.length, 0x400, 0, 0x200, 0]), 0);
        assert.deepEqual(calls[0].desc.slice(0, 5), [128, 4, 8, 1, 61]);
        const row = calls[0].data[0][0];
        assert.deepEqual([...memory.subarray(row, row + 3)], [1, 3, 5], 'every other texel');
        assert.deepEqual([...memory.subarray(row + 128, row + 131)], [1, 3, 5],
            'each row the same');

        // BC3_UNORM_SRGB 32x32 asked as 16x16: through its texels, back into blocks.
        view.setUint32(0x400, 16, true);
        view.setUint32(0x404, 16, true);
        const srgb = dds10({ width: 32, height: 32, format: 78, bytes: 1024 });
        srgb.fill(0, 148);
        memory.set(srgb, 0x8000);
        calls.length = 0;
        assert.equal(await fns.D3DX10CreateTextureFromMemory.handler([device, 0x8000,
            srgb.length, 0x400, 0, 0x200, 0]), 0);
        assert.deepEqual(calls[0].desc.slice(0, 5), [16, 16, 5, 1, 78]);
        assert.deepEqual(calls[0].data.map(([, pitch])=>pitch), [64, 32, 16, 16, 16]);

        // Vantage's ground height map: R8_UNORM asked as R32_FLOAT, each byte over 255.
        view.setUint32(0x400, 0xffffffff, true);
        view.setUint32(0x404, 0xffffffff, true);
        view.setUint32(0x424, 41, true);
        const height = dds10({ width: 2, height: 2, format: 61, bytes: 4 });
        height.set([0, 51, 102, 255], 148);
        memory.set(height, 0x8000);
        calls.length = 0;
        assert.equal(await fns.D3DX10CreateTextureFromMemory.handler([device, 0x8000,
            height.length, 0x400, 0, 0x200, 0]), 0);
        assert.deepEqual(calls[0].desc.slice(0, 5), [2, 2, 2, 1, 41]);
        assert.deepEqual(calls[0].data.map(([, pitch])=>pitch), [8, 4]);
        const texels = calls[0].data[0][0];
        assert.deepEqual([0, 4, 8, 12].map(at=>view.getFloat32(texels + at, true)),
            [0, Math.fround(0.2), Math.fround(0.4), 1]);
        view.setUint32(0x424, 0xffffffff, true);

        // A size the file holds as a level is filtered down from the first all the same,
        // as D3DX does: BC5 16x16 with its whole chain asked as 8x8.
        view.setUint32(0x400, 8, true);
        view.setUint32(0x404, 8, true);
        const chain = dds10({ width: 16, height: 16, format: 83, mips: 5, bytes: 368 });
        memory.set(chain, 0x8000);
        calls.length = 0;
        assert.equal(await fns.D3DX10CreateTextureFromMemory.handler([device, 0x8000,
            chain.length, 0x400, 0, 0x200, 0]), 0);
        assert.deepEqual(calls[0].desc.slice(0, 5), [8, 8, 4, 1, 83]);

        // BC5 8x8 of one level asked as 4x4: through its two channels and back. Red's
        // blocks have ends 200 and 40, green's 100 and 40, every index 0: all texels
        // (200, 100).
        view.setUint32(0x400, 4, true);
        view.setUint32(0x404, 4, true);
        const bc5 = dds10({ width: 8, height: 8, format: 83, bytes: 64 });
        for (let block = 0; block < 8; block++)
        {
            bc5.set([block & 1 ? 100 : 200, 40, 0, 0, 0, 0, 0, 0], 148 + block * 8);
        }
        memory.set(bc5, 0x8000);
        calls.length = 0;
        assert.equal(await fns.D3DX10CreateTextureFromMemory.handler([device, 0x8000,
            bc5.length, 0x400, 0, 0x200, 0]), 0);
        assert.deepEqual(calls[0].desc.slice(0, 5), [4, 4, 3, 1, 83]);
        const made = calls[0].data[0][0];
        assert.deepEqual([memory[made], memory[made + 1], memory[made + 8], memory[made + 9]],
            [200, 200, 100, 100], 'one value a block: both ends hold it, each channel its own');

        // BC7 has no codec here: a size its file holds as a level takes that level
        // (decision A234); any other is refused, and said.
        const eleven = createD3dx10Functions({ ...host, divergence: (/** @type {string} */ api,
            /** @type {string} */ detail)=>said.push(`${api}: ${detail}`) }, 43, D3DX11_PROFILE);
        view.setUint32(0x400, 4, true);
        view.setUint32(0x404, 4, true);
        const levels = dds10({ width: 8, height: 8, format: 98, mips: 2, bytes: 80 });
        memory.set(levels, 0x8000);
        calls.length = 0;
        assert.equal(await eleven.D3DX11CreateTextureFromMemory.handler([device, 0x8000,
            levels.length, 0x400, 0, 0x200, 0]), 0);
        assert.deepEqual(calls[0].desc.slice(0, 5), [4, 4, 1, 1, 98]);
        assert.equal(memory[calls[0].data[0][0]], 64, 'the file\'s second level as it is');
        view.setUint32(0x400, 8, true);
        const blocks = dds10({ width: 4, height: 4, format: 98, bytes: 16 });
        memory.set(blocks, 0x8000);
        assert.equal(await eleven.D3DX11CreateTextureFromMemory.handler([device, 0x8000,
            blocks.length, 0x400, 0, 0x200, 0]) >>> 0, 0x80004005);
        assert.match(said.join('\n'), /format 98 made format 98 or another size: this loader has/);
    });

test('a file held in its own deep format is made in the DXGI format laid out as it',
    async()=>{
        const { host, device, calls, memory } = machine();
        const fns = createD3dx10Functions(host, 34);
        // G16R16: 32 bits, masks 0xffff and 0xffff0000.
        const file = dds(2, 2);
        const view = new DataView(file.buffer);
        view.setUint32(80, 0x40, true);
        [0xffff, 0xffff0000, 0, 0].forEach((mask, i)=>view.setUint32(92 + i * 4, mask, true));
        memory.set(file, 0x8000);
        assert.equal(await fns.D3DX10CreateTextureFromMemory.handler([device, 0x8000,
            file.length, 0, 0, 0x200, 0]), 0);
        assert.equal(calls[0].desc[4], 35, 'DXGI_FORMAT_R16G16_UNORM');
        assert.equal(calls[0].desc[2], 2, 'its chain made through its own texels');
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
        26, 29, 21]);
    assert.equal(await fns.D3DX10UnsetAllDeviceObjects.handler([0]) >>> 0, 0x80070057);
});

test('D3DX10CheckVersion holds the program to its own SDK versions', ()=>{
    const fns = createD3dx10Functions(machine().host, 34);
    assert.equal(fns.D3DX10CheckVersion.handler([29, 34]), 1);
    assert.equal(fns.D3DX10CheckVersion.handler([29, 33]), 0);
});
