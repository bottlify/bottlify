/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTextureSaver, writeBmp, writeDds } from './save-texture.js';
import { deviceRig } from './device.fixture.js';
import { readImage } from './images.js';
import { FMT } from './pixels.js';

const D3DERR_INVALIDCALL = 0x8876086c;
const E_NOTIMPL = 0x80004001;
const IFF_BMP = 0;
const IFF_PNG = 3;
const IFF_DDS = 4;
const IFF_DIB = 6;

/** A rig with a 4x2 A8R8G8B8 texture of two levels, each texel's bytes numbered. */
function setup(){
    const r = deviceRig();
    /** @type {Map<string, Uint8Array>} */
    const written = new Map();
    /** @type {Uint8Array[]} */
    const given = [];
    const saver = /** @type {any} */ (createTextureSaver({ ...r.host,
        writeFile: (path, bytes)=>{
            written.set(path, bytes.slice());
            return true;
        } }, { giveBuffer: (out, bytes)=>{
        given.push(bytes.slice());
        r.view.setUint32(out, 0xb0f, true);
        return 0;
    } }));
    const texture = r.texture(4, 2, 2, 0, FMT.A8R8G8B8, 1);
    r.objects.get(texture).surfaces.forEach((/** @type {number} */ at, /** @type {number} */ l)=>{
        const surface = r.objects.get(at);
        for (let i = 0; i < surface.pitch * surface.height; i++)
        {
            r.memory[surface.data + i] = (l * 100 + i) & 0xff;
        }
    });
    const name = r.heap.allocate(32);
    r.memory.set([...'shot.dds\0'].map(c=>c.charCodeAt(0)), name);
    return { r, saver, texture, written, given, name };
}

test('a DDS file keeps every level in the texture\'s own format', async()=>{
    const { r, saver, texture, written, name } = setup();
    assert.equal(await r.call(saver.D3DXSaveTextureToFileA, [name, IFF_DDS, texture, 0]), 0);
    const file = /** @type {Uint8Array} */ (written.get('shot.dds'));
    assert.equal(file.length, 128 + 4 * 2 * 4 + 2 * 1 * 4);
    const image = readImage(file);
    assert.deepEqual([image.width, image.height, image.format, image.mipLevels],
        [4, 2, FMT.A8R8G8B8, 2]);
    assert.deepEqual([...file.subarray(128, 132)], [0, 1, 2, 3]);
    assert.deepEqual([...file.subarray(128 + 32, 128 + 36)], [100, 101, 102, 103]);
    assert.ok(r.calls.filter(c=>c[0] === 'LockRect').every(c=>c[4] === 0x10), 'read-only locks');
});

test('a DDS file of a format with no masks names it by its four-character code', ()=>{
    const dxt = writeDds(FMT.DXT5, [{ width: 4, height: 4, bytes: new Uint8Array(16) }]);
    const view = new DataView(dxt.buffer);
    assert.equal(view.getUint32(80, true), 0x4, 'DDPF_FOURCC');
    assert.equal(view.getUint32(84, true), FMT.DXT5);
    assert.equal(view.getUint32(20, true), 16, 'the linear size of the top level');
    assert.equal(readImage(dxt).format, FMT.DXT5);
    const half = writeDds(113, [{ width: 1, height: 1, bytes: new Uint8Array(8) }]);
    assert.equal(new DataView(half.buffer).getUint32(84, true), 113);
});

test('BMP and DIB keep the first level, with alpha beside the colour when it has one',
    async()=>{
        const { r, saver, texture, given } = setup();
        assert.equal(await r.call(saver.D3DXSaveTextureToFileInMemory,
            [r.heap.allocate(4), IFF_BMP, texture, 0]), 0);
        const [bmp] = given;
        const image = readImage(bmp);
        assert.deepEqual([image.width, image.height], [4, 2]);
        const view = new DataView(bmp.buffer);
        assert.equal(view.getUint16(28, true), 32);
        // The top row is the last in the file; its first texel is bytes 0..3.
        assert.deepEqual([...bmp.subarray(54 + 16, 54 + 20)], [0, 1, 2, 3]);
        assert.equal(await r.call(saver.D3DXSaveTextureToFileInMemory,
            [r.heap.allocate(4), IFF_DIB, texture, 0]), 0);
        assert.equal(given[1].length, bmp.length - 14, 'a DIB has no file header');
        const opaque = writeBmp(new Uint8Array(3 * 4).fill(9), 3, 1, false);
        assert.equal(new DataView(opaque.buffer).getUint16(28, true), 24);
        assert.equal(opaque.length, 54 + 12, 'rows padded to four bytes');
    });

test('other image formats, cube textures and missing pointers are refused', async()=>{
    const { r, saver, texture, name, written } = setup();
    assert.equal(await r.call(saver.D3DXSaveTextureToFileA, [name, IFF_PNG, texture, 0]),
        E_NOTIMPL);
    assert.match(r.diverged.at(-1)?.[1] ?? '', /image file format 3/);
    assert.equal(written.size, 0);
    assert.equal(r.call(saver.D3DXSaveTextureToFileA, [0, IFF_DDS, texture, 0]),
        D3DERR_INVALIDCALL);
    assert.equal(r.call(saver.D3DXSaveTextureToFileA, [name, IFF_DDS, 0, 0]),
        D3DERR_INVALIDCALL);
    assert.equal(r.call(saver.D3DXSaveTextureToFileInMemory, [0, IFF_DDS, texture, 0]),
        D3DERR_INVALIDCALL);
    const without = /** @type {any} */ (createTextureSaver(r.host, { giveBuffer: ()=>0 }));
    assert.equal(r.call(without.D3DXSaveTextureToFileA, [name, IFF_DDS, texture, 0]),
        E_NOTIMPL, 'nowhere to write a file');
});

test('a surface is saved as one level: its rectangle, or all of it, read through its lock',
    async()=>{
        const { r, saver, texture, written, given, name } = setup();
        const [top] = r.objects.get(texture).surfaces;
        assert.equal(saver.D3DXSaveSurfaceToFileA.argBytes, 20);
        assert.equal(await r.call(saver.D3DXSaveSurfaceToFileA, [name, IFF_DDS, top, 0, 0]), 0);
        const whole = readImage(/** @type {Uint8Array} */ (written.get('shot.dds')));
        assert.deepEqual([whole.width, whole.height, whole.mipLevels], [4, 2, 1]);

        const rect = r.heap.allocate(16);
        [1, 0, 3, 2].forEach((v, i)=>r.view.setUint32(rect + i * 4, v, true));
        const out = r.heap.allocate(4);
        assert.equal(await r.call(saver.D3DXSaveSurfaceToFileInMemory, [out, IFF_DDS, top, 0,
            rect]), 0);
        const part = readImage(given[0]);
        assert.deepEqual([part.width, part.height], [2, 2]);
        // The surface fixture locks at the surface's start whatever the rectangle; the
        // rows are read at its pitch, the rectangle's width of them.
        assert.deepEqual([...given[0].subarray(128, 136)], [0, 1, 2, 3, 4, 5, 6, 7]);
        assert.deepEqual([...given[0].subarray(136, 140)], [16, 17, 18, 19], 'the next row');
        assert.deepEqual(r.calls.filter(c=>c[0] === 'LockRect').at(-1)?.slice(2), [rect, 0x10],
            'the rectangle locked, only to read');

        [3, 0, 5, 2].forEach((v, i)=>r.view.setUint32(rect + i * 4, v, true));
        assert.equal(await r.call(saver.D3DXSaveSurfaceToFileInMemory, [out, IFF_BMP, top, 0,
            rect]), D3DERR_INVALIDCALL, 'a rectangle past the edge');
        assert.equal(r.view.getUint32(out, true), 0);
        const wide = r.heap.allocate(32);
        [...'w.bmp\0'].forEach((c, i)=>r.view.setUint16(wide + i * 2, c.charCodeAt(0), true));
        assert.equal(await r.call(saver.D3DXSaveSurfaceToFileW, [wide, IFF_BMP, top, 0, 0]), 0);
        assert.equal(readImage(/** @type {Uint8Array} */ (written.get('w.bmp'))).width, 4);
    });
