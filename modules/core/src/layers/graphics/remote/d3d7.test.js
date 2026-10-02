/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirect3D7 } from '../d3d7/device.js';
import { D3DRENDERSTATE, D3D_OK, DEVICE_IDS } from '../d3d7/constants.js';
import { D3DCLEAR, D3DPT, D3DTA, D3DTOP, D3DTSS } from '../d3d8/constants.js';
import { createDirectDraw } from '../ddraw/objects.js';
import {
    DDCKEY_SRCBLT, DDPF_ALPHAPIXELS, DDPF_RGB, DDSCAPS_3DDEVICE, DDSCAPS_COMPLEX, DDSCAPS_MIPMAP,
    DDSCAPS_OFFSCREENPLAIN, DDSCAPS_TEXTURE, DDSCAPS_ZBUFFER, DDSCL_NORMAL, DDSD_CAPS,
    DDSD_HEIGHT, DDSD_MIPMAPCOUNT, DDSD_PIXELFORMAT, DDSD_WIDTH, DDSD_ZBUFFERBITDEPTH,
} from '../ddraw/constants.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF } from '../webgpu/internal/vertexformat.js';
import { playedAtOnce } from './direct3d.js';
import { playedDirect3D7, recordedDirect3D7 } from './d3d7.js';

const FVF_TL = FVF.XYZRHW | FVF.DIFFUSE;
const FVF_TL_TEX = FVF_TL | (1 << FVF.TEXCOUNT_SHIFT);
const ARGB32 = Object.freeze({
    size: 0x20, flags: DDPF_RGB | DDPF_ALPHAPIXELS, fourCC: 0, bitCount: 32,
    redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff, alphaMask: 0xff000000,
});

/**
 * A value as the GPU was asked it, comparable across two runs.
 *
 * @param {any} value @param {number} [depth]
 * @returns {any}
 */
function plain(value, depth = 0){
    if (value === null || typeof value !== 'object')
    {
        return value;
    }
    if (ArrayBuffer.isView(value))
    {
        return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)].join(',');
    }
    if (typeof value.id === 'string' && typeof value.kind === 'string' && depth > 0)
    {
        return value.id;
    }
    if (depth > 6)
    {
        return '...';
    }
    if (Array.isArray(value))
    {
        return value.map(item=>plain(item, depth + 1));
    }
    /** @type {Record<string, any>} */
    const out = {};
    for (const key of Object.keys(value).sort())
    {
        if (typeof value[key] !== 'function')
        {
            out[key] = plain(value[key], depth + 1);
        }
    }
    return out;
}

/** Pre-transformed corners: x, y, z, rhw, colour, and a coordinate pair if asked. */
function corners(/** @type {number[][]} */ points, /** @type {boolean} */ textured){
    const stride = textured ? 28 : 20;
    const view = new DataView(new ArrayBuffer(stride * points.length));
    points.forEach(([x, y, u, v], index)=>{
        const at = index * stride;
        view.setFloat32(at, x, true);
        view.setFloat32(at + 4, y, true);
        view.setFloat32(at + 8, 0.5, true);
        view.setFloat32(at + 12, 1, true);
        view.setUint32(at + 16, 0xff102030 + index, true);
        if (textured)
        {
            view.setFloat32(at + 20, u, true);
            view.setFloat32(at + 24, v, true);
        }
    });
    return new Uint8Array(view.buffer);
}

/**
 * Three frames through a Direct3D 7 device on a target with a depth buffer
 * attached, and every call they asked of the GPU: a mip-mapped texture and a
 * colour-keyed one, each written again between frames; vertices by pointer,
 * in a vertex buffer rewritten every frame, and indexed through a pointer; a
 * DirectDraw depth fill; the target read back and written by the program;
 * the target's pixels traded with another surface's, as a flip trades them.
 *
 * @param {(ddraw: any, services: any) => any} make
 */
async function framesThrough(make){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const ram = new Uint8Array(1 << 20);
    let next = 0x10000;
    const root = createDirectDraw({ version: 7, screenWidth: 16, screenHeight: 16,
        allocate: bytes=>{
            const at = next;
            next += bytes + 0xfff & ~0xfff;
            return at;
        } });
    root.setCooperativeLevel(0x00010044, DDSCL_NORMAL);
    /** @type {Map<number, () => unknown>} */
    const claims = new Map();
    const d3d = make(root, {
        backend,
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            ram.slice(address, address + length),
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            ram.set(bytes, address),
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler',
            id: `sampler-${JSON.stringify(descriptor)}`, descriptor }),
        presenter: {
            claim: (/** @type {number} */ buffer, /** @type {() => unknown} */ show)=>
                claims.set(buffer, show),
            release: (/** @type {number} */ buffer)=>claims.delete(buffer),
        },
    });
    /** @param {any} request */
    const made = request=>{
        const result = root.createSurface(request);
        assert.equal(result.hr, D3D_OK);
        return /** @type {any} */ (result.surface);
    };
    const target = made({ flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT,
        caps: DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN, width: 8, height: 8 });
    const spare = made({ flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT,
        caps: DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN, width: 8, height: 8 });
    const depth = made({ flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_ZBUFFERBITDEPTH,
        caps: DDSCAPS_ZBUFFER, width: 8, height: 8, zBufferBitDepth: 16 });
    assert.equal(target.addAttachedSurface(depth), D3D_OK);
    const mipped = made({
        flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT | DDSD_MIPMAPCOUNT,
        caps: DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP,
        width: 4, height: 4, mipMapCount: 3, pixelFormat: ARGB32,
    });
    const levels = [mipped, mipped.mipNext, mipped.mipNext.mipNext];
    levels.forEach((level, index)=>{
        ram.fill(index + 1, level.buffer, level.buffer + level.pitch * level.height);
    });
    const keyed = made({ flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT,
        caps: DDSCAPS_TEXTURE | DDSCAPS_OFFSCREENPLAIN, width: 2, height: 2,
        pixelFormat: ARGB32 });
    ram.fill(0x7f, keyed.buffer, keyed.buffer + 16);
    assert.equal(keyed.setColorKey(DDCKEY_SRCBLT, { low: 0x7f7f7f7f, high: 0x7f7f7f7f }), D3D_OK);

    const created = d3d.createDevice(DEVICE_IDS.TNLHAL, target);
    assert.equal(created.hr, D3D_OK);
    const device = created.device;
    const vb = d3d.createVertexBuffer({ caps: 0, fvf: FVF_TL, numVertices: 4 });
    assert.equal(vb.hr, D3D_OK);
    const indices = 0x80000;
    const ok = (/** @type {number} */ hr)=>assert.equal(hr, D3D_OK);
    ok(device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.MODULATE));
    ok(device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.TEXTURE));

    /** @type {string[]} */
    const frames = [];
    for (let frame = 0; frame < 3; frame++)
    {
        ok(device.BeginScene());
        ok(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, 0xff000000 + frame, 1, 0));
        ok(device.SetTexture(0, mipped));
        ok(device.DrawPrimitive(D3DPT.TRIANGLESTRIP, FVF_TL_TEX,
            corners([[0, 0, 0, 0], [8, 0, 1, 0], [0, 8, 0, 1], [8, 8, 1, 1]], true), 4));
        ok(device.SetTexture(0, keyed));
        ok(device.SetRenderState(D3DRENDERSTATE.COLORKEYENABLE, frame & 1));
        /** @type {{ data?: number }} */
        const lock = {};
        ok(vb.buffer.Lock(0, lock));
        ram.set(corners([[frame, 0], [8, frame], [0, 8], [8, 8]], false),
            /** @type {number} */ (lock.data));
        ok(vb.buffer.Unlock());
        ok(device.DrawPrimitiveVB(D3DPT.TRIANGLESTRIP, vb.buffer, 0, 4));
        ram.set(new Uint8Array(Uint16Array.from([0, 1, 2, 2, 1, frame % 4]).buffer), indices);
        ok(device.DrawIndexedPrimitiveVB(D3DPT.TRIANGLELIST, vb.buffer, 0, 4, indices, 6));
        if (frame === 1)
        {
            depth.depthFilled(null, 0x8000);
        }
        ok(device.EndScene());
        await /** @type {() => unknown} */ (claims.get(target.buffer))();
        if (frame === 2)
        {
            // What was drawn before the swap is still shown from its address.
            await /** @type {() => unknown} */ (claims.get(spare.buffer))();
        }
        await device.idle();
        frames.push(JSON.stringify(plain(gpu.calls)));
        gpu.reset();

        if (frame === 1)
        {
            // The target is read back before the program reads it, and what
            // it writes goes up before the next draw.
            await target.pixelsCurrent();
            assert.equal(target.lock(null, 0).hr, D3D_OK);
            ram.set([1, 2, 3, 4], target.buffer);
            assert.equal(target.unlock(null), D3D_OK);
        }
        ram.fill(0x40 + frame, levels[1].buffer, levels[1].buffer + 16);
        assert.equal(levels[1].lock(null).hr, D3D_OK);
        assert.equal(levels[1].unlock(null), D3D_OK);
        assert.equal(keyed.setColorKey(DDCKEY_SRCBLT, { low: frame, high: frame }), D3D_OK);
        if (frame === 1)
        {
            // As a flip does: the two surfaces trade the addresses of their pixels.
            const front = spare.buffer;
            spare.setBuffer(target.buffer);
            target.setBuffer(front);
        }
    }
    ok(device.SetTexture(0, null));
    assert.equal(vb.buffer.release(), 0);
    assert.equal(device.release(), 0);
    return { frames, ram: ram.slice(target.buffer, target.buffer + 8), claims };
}

/**
 * A recorded Direct3D 7 object whose every call is played at once on its twin.
 *
 * @param {any} ddraw @param {any} services
 */
const loopback = (ddraw, services)=>recordedDirect3D7(ddraw, services,
    playedAtOnce(/** @type {any} */ (playedDirect3D7(services))));

test('Direct3D 7 frames played from a record ask of the GPU what the device itself asked',
    async()=>{
        const direct = await framesThrough(createDirect3D7);
        const played = await framesThrough(loopback);
        assert.equal(played.frames.length, direct.frames.length);
        assert.ok(direct.frames.every(frame=>frame.includes('drawIndexed')), 'every frame drew');
        played.frames.forEach((frame, index)=>assert.ok(frame === direct.frames[index],
            `frame ${index} asked the same`));
        assert.deepEqual([...played.ram], [...direct.ram],
            'the target read back reached the program\'s bytes alike');
        assert.equal(played.claims.size, 0, 'and the addresses drawn into went with the device');
    });
