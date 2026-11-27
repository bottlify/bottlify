/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the texels an upload keeps until its frame is replayed
 * (`d3d8/render.js` `uploadTexels`, `internal/texel-store.js`): seeded
 * programs of textures made in several formats, written whole and in part
 * while a frame that already samples them is being recorded, and drawn, run
 * with the run's cache under the store and without one. The device must be
 * given the same calls with the same bytes, and the cache must hold nothing
 * once the frames are let go of.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3D_OK, surfaceBytes } from './constants.js';
import { D3DCLEAR, D3DFMT_INDEX, D3DPT } from '../d3d8/constants.js';
import { createDirect3D9 } from './device.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF } from '../webgpu/internal/vertexformat.js';
import { openRunCache } from '../../../process/run-cache.js';
import { channelSpace } from '../../cache/module.js';

const RAM_BASE = 0x40000000;
const ok = (/** @type {number} */ value)=>assert.equal(value, D3D_OK);
const turn = ()=>new Promise(resolve=>setTimeout(resolve, 0));

/** @param {number} seed @returns {() => number} 0 up to 2^32 */
function random(seed){
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

/** The formats a texture is made in, each widened or decoded on its way up. */
const FORMATS = [D3DFMT.A8R8G8B8, D3DFMT.X8R8G8B8, D3DFMT.R5G6B5, D3DFMT.A4R4G4B4, D3DFMT.L8,
    D3DFMT.DXT1, D3DFMT.DXT5];
const BLOCKS = new Set(/** @type {number[]} */ ([D3DFMT.DXT1, D3DFMT.DXT5]));
/** @type {Record<number, number>} */
const TEXEL_BYTES = { [D3DFMT.A8R8G8B8]: 4, [D3DFMT.X8R8G8B8]: 4, [D3DFMT.R5G6B5]: 2,
    [D3DFMT.A4R4G4B4]: 2, [D3DFMT.L8]: 1 };

/** A call as text: the double's objects left out, bytes by their exact values. @param {any} call */
const callText = call=>JSON.stringify({ op: call.op, size: call.size, layout: call.layout,
    origin: call.destination?.origin, mipLevel: call.destination?.mipLevel,
    bufferOffset: call.bufferOffset, bytes: call.bytes ? [...call.bytes].join(',') : undefined });

/**
 * One run of a seeded program: the calls the device was given, the store's
 * figures, and what the cache held under the root's names at the end.
 *
 * @param {number} seed @param {boolean} cached
 */
async function run(seed, cached){
    const next = random(seed);
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const runCache = cached ? await openRunCache({ budget: 64 << 20 }) : null;
    /** @type {ReturnType<typeof channelSpace> | null} */
    let texels = null;
    if (runCache)
    {
        const joined = runCache.join(message=>texels?.adopt(message));
        texels = channelSpace(joined, runCache.serve('texels'));
    }
    const ram = new Uint8Array(8 << 20);
    let free = RAM_BASE + (1 << 20);
    /** @type {string[]} */
    const losses = [];
    const d3d = createDirect3D9({
        backend,
        texelCache: texels,
        divergence: (api, detail, severity)=>{
            if (severity === 'loss')
            {
                losses.push(detail);
            }
        },
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        windowMemory: (address, length)=>ram.subarray(address - RAM_BASE,
            address - RAM_BASE + length),
        createSampler: descriptor=>({ kind: 'sampler', id: `sampler-${JSON.stringify(descriptor)}`,
            descriptor }),
        allocate: bytes=>{
            const address = free;
            free += bytes + 0x100;
            return address;
        },
    });
    /** @type {{ device?: any }} */
    const out = {};
    ok(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: 32,
        backBufferHeight: 32, backBufferFormat: D3DFMT.X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D24S8,
    }, out));
    const device = out.device;
    const stride = 24;
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any }} */
    const indices = {};
    const fvf = FVF.XYZ | (1 << FVF.TEXCOUNT_SHIFT);
    ok(device.CreateVertexBuffer(4 * stride, 0, fvf, D3DPOOL.MANAGED, vertices));
    ok(device.CreateIndexBuffer(6 * 2, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.MANAGED, indices));
    /** @type {{ pBits?: number, Pitch?: number }} */
    const locked = {};
    ok(vertices.buffer.Lock(0, 0, locked, 0));
    const view = new DataView(ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE,
        4 * stride);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([x, y], corner)=>{
        [x, y, 0.5, (corner & 1), (corner >> 1), 0].forEach((value, index)=>
            view.setFloat32(corner * stride + index * 4, value, true));
    });
    ok(vertices.buffer.Unlock());
    ok(indices.buffer.Lock(0, 0, locked, 0));
    new Uint16Array(ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE, 6)
        .set([0, 1, 2, 2, 1, 3]);
    ok(indices.buffer.Unlock());
    ok(device.SetStreamSource(0, vertices.buffer, 0, stride));
    ok(device.SetIndices(indices.buffer));
    ok(device.SetFVF(fvf));

    /** @type {{ texture: any, format: number, size: number, levels: number }[]} */
    const textures = [];
    const count = 3 + next() % 3;
    for (let made = 0; made < count; made++)
    {
        const format = FORMATS[next() % FORMATS.length];
        const size = 32 << (next() % 3);
        const levels = next() % 2 === 0 ? 1 : 0;
        /** @type {{ texture?: any }} */
        const held = {};
        ok(device.CreateTexture(size, size, levels, 0, format, D3DPOOL.MANAGED, held));
        textures.push({ texture: held.texture, format, size,
            levels: held.texture.levels });
    }
    /**
     * A level written: whole, or a rectangle of rows where its format has
     * texels rather than blocks.
     *
     * @param {{ texture: any, format: number, size: number, levels: number }} one
     */
    const write = one=>{
        const level = next() % one.levels;
        const side = Math.max(1, one.size >> level);
        const bytesPer = TEXEL_BYTES[one.format];
        const part = !BLOCKS.has(one.format) && side >= 8 && next() % 2 === 0;
        const rect = part ? { left: next() % (side / 2), top: next() % (side / 2),
            right: side - next() % (side / 4), bottom: side - next() % (side / 4) } : null;
        ok(one.texture.LockRect(level, locked, rect, 0));
        const at = /** @type {number} */ (locked.pBits) - RAM_BASE;
        if (rect)
        {
            for (let row = 0; row < rect.bottom - rect.top; row++)
            {
                const from = at + row * /** @type {number} */ (locked.Pitch);
                for (let byte = 0; byte < (rect.right - rect.left) * bytesPer; byte++)
                {
                    ram[from + byte] = next() & 0xff;
                }
            }
        }
        else
        {
            const length = surfaceBytes(one.format, side, side);
            for (let byte = 0; byte < length; byte++)
            {
                ram[at + byte] = next() & 0xff;
            }
        }
        ok(one.texture.UnlockRect(level));
    };
    for (const one of textures)
    {
        for (let level = 0; level < one.levels; level++)
        {
            const side = Math.max(1, one.size >> level);
            ok(one.texture.LockRect(level, locked, null, 0));
            const at = /** @type {number} */ (locked.pBits) - RAM_BASE;
            ram.fill(level * 16 + 3, at, at + surfaceBytes(one.format, side, side));
            ok(one.texture.UnlockRect(level));
        }
    }
    for (let frame = 0; frame < 4; frame++)
    {
        ok(device.BeginScene());
        ok(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, 0xff000000, 1, 0));
        const draws = 4 + next() % 6;
        for (let draw = 0; draw < draws; draw++)
        {
            const one = textures[next() % textures.length];
            // Written while this frame already samples it: the upload waits
            // in the frame's order, its texels in the store.
            if (next() % 3 !== 0)
            {
                write(one);
            }
            ok(device.SetTexture(0, one.texture));
            ok(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 0, 4, 0, 2));
            // Some time for room asked for to be granted, as a frame's calls
            // take it: bodies move into the cache before their replay.
            if (next() % 2 === 0)
            {
                await turn();
            }
        }
        ok(device.EndScene());
        ok(device.Present());
        await device.idle();
    }
    // Every room asked for answered, and let go of where its body went first.
    for (let turns = 0; turns < 200 && (device.diagnostics().keptTexels.asking > 0
        || (runCache?.under(/** @type {any} */ (texels).prefix).bodies ?? 0) > 0); turns++)
    {
        await turn();
    }
    const figures = device.diagnostics();
    const left = runCache?.under(/** @type {any} */ (texels).prefix).bodies ?? 0;
    const released = await texels?.close();
    runCache?.close();
    return {
        calls: gpu.calls.map(callText),
        kept: figures.keptTexels,
        failures: figures.failures,
        losses,
        left,
        released,
    };
}

test('an upload that waits for its frame gives the device the same bytes from the run\'s cache '
    + 'as from plain memory, and leaves nothing there', { timeout: 120_000 }, async()=>{
    let moved = 0;
    let puts = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8])
    {
        const plain = await run(seed, false);
        const cached = await run(seed, true);
        assert.deepEqual(plain.failures, [], `seed ${seed}`);
        assert.deepEqual(cached.failures, [], `seed ${seed}`);
        assert.ok(plain.calls.some(call=>call.includes('"writeTexture"')
            || call.includes('"copyBufferToTexture"')), `seed ${seed}: textures uploaded`);
        assert.equal(cached.calls.length, plain.calls.length, `seed ${seed}`);
        for (let at = 0; at < plain.calls.length; at++)
        {
            assert.equal(cached.calls[at], plain.calls[at], `seed ${seed}: call ${at}`);
        }
        assert.equal(plain.kept.put, cached.kept.put, `seed ${seed}: the same uploads kept`);
        assert.equal(cached.kept.lost, 0, `seed ${seed}`);
        assert.deepEqual([...plain.losses, ...cached.losses], [], `seed ${seed}`);
        assert.equal(cached.kept.bodies, 0, `seed ${seed}: every frame let its texels go`);
        assert.equal(plain.kept.bodies, 0, `seed ${seed}`);
        assert.equal(cached.left, 0, `seed ${seed}: nothing left under the root's names`);
        assert.deepEqual(cached.released, { bodies: 0, bytes: 0, waiting: 0 }, `seed ${seed}`);
        assert.equal(plain.kept.cache, false);
        moved += cached.kept.moved;
        puts += cached.kept.put;
    }
    assert.ok(puts > 0, 'uploads waited for their frames');
    assert.ok(moved > 0, 'some of their texels waited in the run\'s cache');
});
