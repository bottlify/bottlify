/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Behaviour observed on real programs, pinned as tests: what a buffer lock's
 * flags cost in traffic, which way a matrix multiplies, what a chain of
 * render targets does to alpha, and where a viewport puts a vertex. Each of
 * these was a picture that came out wrong once, and each is cheap to hold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DERR_INVALIDCALL, D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3D_OK } from './constants.js';
import { D3DLOCK, D3DPT } from '../d3d8/constants.js';
import { createDirect3D9 } from './device.js';
import { multiplyMatrices, transformPosition } from '../d3d8/render.js';
import { blendChannel } from '../webgpu/internal/reference.js';
import { viewportState } from '../webgpu/internal/viewport.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF } from '../webgpu/internal/vertexformat.js';

const RAM_BASE = 0x40000000;
const RAM_SIZE = 4 << 20;
/** x, y, z, rhw and a colour. */
const STRIDE = 20;

/** A device over the recording GPU with a locked, drawn vertex buffer. */
function harness(){
    const gpu = createFakeDevice();
    const backend = createBackend({
        device: gpu.device, queue: gpu.queue, presentTo: ()=>{}, now: ()=>0,
    });
    const ram = new Uint8Array(RAM_SIZE);
    let next = RAM_BASE;
    const d3d = createDirect3D9({
        backend,
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        allocate: bytes=>{
            const address = next;
            next += bytes + 0x100;
            return address;
        },
    });
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: 8,
        backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8, enableAutoDepthStencil: false,
    }, out), D3D_OK);
    const device = out.device;
    /** @type {{ buffer?: any }} */
    const vb = {};
    assert.equal(device.CreateVertexBuffer(STRIDE * 60, 0, 0, D3DPOOL.DEFAULT, vb), D3D_OK);
    device.SetStreamSource(0, vb.buffer, 0, STRIDE);
    device.SetFVF(FVF.XYZRHW | FVF.DIFFUSE);
    return {
        gpu, device, buffer: vb.buffer,
        /**
         * Locks a range, writes a byte pattern there and unlocks.
         *
         * @param {number} offset @param {number} size @param {number} flags @param {number} fill
         */
        write(offset, size, flags, fill){
            /** @type {{ pBits?: number }} */
            const lock = {};
            assert.equal(vb.buffer.Lock(offset, size, lock, flags), D3D_OK);
            const length = size === 0 ? STRIDE * 60 - offset : size;
            ram.fill(fill, (lock.pBits ?? 0) - RAM_BASE, (lock.pBits ?? 0) - RAM_BASE + length);
            assert.equal(vb.buffer.Unlock(), D3D_OK);
        },
        /** @param {number} first */
        async draw(first){
            device.BeginScene();
            assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, first, 1), D3D_OK);
            device.EndScene();
            assert.equal(device.Present(), D3D_OK);
            await device.idle();
        },
        /** The uploads to vertex buffers so far, as (size, first byte). */
        uploads: ()=>gpu.of('writeBuffer')
            .filter(call=>String(call.buffer.descriptor.label ?? '').startsWith('vertices'))
            .map(call=>({ size: call.size, byte: call.bytes[0] })),
        /** The GPU buffer each draw so far read its vertices from. */
        drawnFrom: ()=>gpu.of('setVertexBuffer').map(call=>call.buffer),
        release(){
            device.SetStreamSource(0, null, 0, 0);
            vb.buffer.release();
            assert.equal(device.release(), 0);
        },
    };
}

test('a lock sends only its range, NOOVERWRITE renames nothing and DISCARD renames', async()=>{
    const h = harness();
    // The whole buffer, once: a plain lock of everything.
    h.write(0, 0, 0, 0x11);
    await h.draw(0);
    assert.deepEqual(h.uploads(), [{ size: STRIDE * 60, byte: 0x11 }]);

    // A few vertices under NOOVERWRITE: the promise not to touch what a
    // pending draw reads, so the bytes go into the live buffer and only the
    // locked range travels.
    h.write(STRIDE * 3, STRIDE * 3, D3DLOCK.NOOVERWRITE, 0x22);
    await h.draw(3);
    assert.deepEqual(h.uploads().slice(1), [{ size: STRIDE * 3, byte: 0x22 }]);
    let drawn = h.drawnFrom();
    assert.equal(drawn[1], drawn[0], 'the same buffer: nothing was renamed');

    // DISCARD declares the rest undefined: another buffer, and only the
    // bytes written since carried into it.
    h.write(0, STRIDE * 3, D3DLOCK.DISCARD, 0x33);
    await h.draw(0);
    assert.deepEqual(h.uploads().slice(2), [{ size: STRIDE * 3, byte: 0x33 }]);
    drawn = h.drawnFrom();
    assert.notEqual(drawn[2], drawn[1], 'renamed');

    // A plain lock of a range once the frame that read the buffer has been
    // submitted: nothing pending reads it, so the write goes into the live
    // backing and only the locked range travels. (A rename is owed only while
    // a recorded draw still reads it; the render tests pin that case.)
    h.write(STRIDE * 6, STRIDE * 3, 0, 0x44);
    await h.draw(6);
    const last = h.uploads().slice(3);
    assert.equal(last.length, 1);
    assert.equal(last[0].size, STRIDE * 3);
    drawn = h.drawnFrom();
    assert.equal(drawn[3], drawn[2], 'the same backing, because nothing was in flight');
    h.release();
});

test('a lock of zero bytes is the whole buffer, and one past the end is refused untouched', ()=>{
    const h = harness();
    /** @type {{ pBits?: number }} */
    const lock = {};
    assert.equal(h.buffer.Lock(STRIDE * 60, 4, lock, 0), D3DERR_INVALIDCALL);
    assert.equal(lock.pBits, undefined, 'the caller\'s pointer is left alone');
    assert.equal(h.buffer.Lock(0, STRIDE * 60 + 1, lock, 0), D3DERR_INVALIDCALL, 'too long');
    assert.equal(h.buffer.Lock(STRIDE, 0, lock, D3DLOCK.NOOVERWRITE), D3D_OK,
        'zero means to the end, and NOOVERWRITE is accepted');
    assert.equal(h.buffer.Unlock(), D3D_OK);
    h.release();
});

test('a matrix multiplies row-vector style: translate then project', ()=>{
    // D3D's convention: a point is a row vector, and world * view * projection
    // applies world first. A translation followed by a perspective divide
    // must put a point at the translated place, not the other way round.
    const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1];
    const project = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0];
    const both = multiplyMatrices(translate, project);
    const [x, y, z, w] = transformPosition(both, [1, 1, 1]);
    assert.deepEqual([x, y, z, w], [4, 5, 6, 6], 'translated, then w takes the depth');
    assert.deepEqual([x / w, y / w], [4 / 6, 5 / 6]);
    // The other order would scale the translation by the depth.
    const wrong = multiplyMatrices(project, translate);
    assert.notDeepEqual(transformPosition(wrong, [1, 1, 1]), [4, 5, 6, 6]);
});

test('a faint layer drawn through a chain of transparent targets squares itself to nothing', ()=>{
    // Source-alpha over a target cleared to transparent, with no separate
    // alpha blend: the target's alpha becomes a*a, and the next hop samples
    // that as its source. Two hops of a faint layer leave nothing; an opaque
    // layer survives; a replace (blend off) keeps the layer whatever its
    // alpha.
    const faint = Math.round(0.05 * 255);
    assert.equal(faint, 13);
    const first = blendChannel(faint, 0, faint);
    assert.equal(first, 1, 'one hop: a fiftieth of a fiftieth');
    const second = blendChannel(first, 0, first);
    assert.equal(second, 0, 'two hops: gone');
    assert.equal(blendChannel(255, 0, 255), 255, 'opaque content survives');
    assert.equal(blendChannel(faint, 0, 255), faint, 'a replace keeps the layer alpha');
});

test('the viewport places a vertex: the whole target is the identity, a corner is not', ()=>{
    // A viewport equal to the target maps pixel x to clip x - 1 and pixel y
    // to 1 - clip y; one in the target's corner has to subtract its origin
    // as well as divide by its extent.
    const whole = viewportState({ x: 0, y: 0, width: 1024, height: 768 });
    /** @param {import('../webgpu/contract.js').ViewportState} vp @param {number[]} p */
    const clip = (vp, [x, y])=>[
        (x + vp.offset[0]) * vp.scale[0] - 1,
        (y + vp.offset[1]) * vp.scale[1] + 1,
    ];
    assert.deepEqual(clip(whole, [0, 0]), [-1, 1]);
    assert.deepEqual(clip(whole, [1024, 768]), [1, -1]);
    assert.deepEqual(clip(whole, [512, 384]), [0, 0]);

    const corner = viewportState({ x: 768, y: 576, width: 256, height: 192 });
    assert.deepEqual(clip(corner, [768, 576]), [-1, 1], 'the viewport\'s origin is its top left');
    assert.deepEqual(clip(corner, [896, 672]), [0, 0], 'its centre is the clip origin');
    // Dividing by the extent without subtracting the origin would put the
    // same vertex four extents away.
    assert.deepEqual([768 * corner.scale[0] - 1, 576 * corner.scale[1] + 1], [5, -5]);
});
