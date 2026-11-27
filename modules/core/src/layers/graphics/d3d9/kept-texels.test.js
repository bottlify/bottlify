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
 * over the two real ways a root holds the run's cache under its store: the
 * names a root drawn on the run's own thread holds (`ownedSpace`), the
 * reference, and those a root in the graphics worker holds (`channelSpace`),
 * each body read as handed over until its room is granted and from the cache
 * after. The device must be given the same calls with the same bytes, and the
 * cache must hold nothing once the frames are let go of. On the run's thread
 * the frames' uniform arenas are held in the cache too (`createUniformArena`),
 * their blocks among the bytes compared.
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
import { createScratches } from '../../cache/scratch.js';
import { channelSpace, ownedSpace } from '../../cache/module.js';
import { deviceRooms, testScratch } from '../../cache/testing.fixture.js';

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
 * @param {number} seed @param {'worker' | 'thread'} where  the texels' store: the run's
 *     cache from the graphics worker or from the run's thread
 * @param {{ mutate?: boolean }} [options]  `mutate`: the cache's read of a body is wrong
 *     in its first byte, which the gate must see
 */
async function run(seed, where, { mutate = false } = {}){
    const next = random(seed);
    const gpu = createFakeDevice();
    const backend = createBackend({ scratches: testScratch,
        device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const runCache = await openRunCache({ budget: 64 << 20 });
    /** @type {ReturnType<typeof channelSpace> | ReturnType<typeof ownedSpace>} */
    let texels;
    if (where === 'worker')
    {
        /** @type {ReturnType<typeof channelSpace> | null} */
        let worker = null;
        worker = channelSpace(runCache.join(message=>worker?.adopt(message)),
            /** @type {NonNullable<ReturnType<typeof runCache.serve>>} */ (
                runCache.serve('texels')));
        texels = worker;
    }
    else
    {
        texels = ownedSpace(runCache.reader,
            /** @type {NonNullable<ReturnType<typeof runCache.own>>} */ (runCache.own('texels')));
    }
    if (mutate)
    {
        const space = texels.space;
        const read = space.with;
        space.with = (key, reader, options)=>read(key, body=>{
            const wrong = body.slice();
            wrong[0] ^= 0xff;
            return reader(wrong);
        }, options);
    }
    const rooms = where === 'thread'
        ? createScratches(ownedSpace(runCache.reader, runCache.own('rooms')).space.hold)
        : null;
    const ram = new Uint8Array(8 << 20);
    let free = RAM_BASE + (1 << 20);
    /** @type {string[]} */
    const losses = [];
    const d3d = createDirect3D9({
        ...deviceRooms(),
        backend,
        texelCache: texels,
        // On the run's thread, the frames' uniform arenas held in its cache as well: a
        // hold across a channel waits on the keeper, which is this thread.
        ...rooms ? { holds: (name, length)=>rooms.hold(name, length) } : {},
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
        || runCache.under(texels.prefix).bodies > 0); turns++)
    {
        await turn();
    }
    const figures = device.diagnostics();
    const left = runCache.under(texels.prefix).bodies;
    const released = await texels.close();
    runCache.close();
    return {
        calls: gpu.calls.map(callText),
        kept: figures.keptTexels,
        uniformsHeld: rooms?.figures().held ?? 0,
        failures: figures.failures,
        losses,
        left,
        released,
    };
}

test('an upload that waits for its frame gives the device the same bytes from the graphics '
    + 'worker\'s names in the run\'s cache as from the run\'s thread\'s, and leaves nothing there',
{ timeout: 120_000 }, async()=>{
    /** @type {Record<string, number>} */
    const moved = { worker: 0, thread: 0 };
    let puts = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8])
    {
        const thread = await run(seed, 'thread');
        const worker = await run(seed, 'worker');
        const at = `seed ${seed}`;
        assert.ok(thread.calls.some(call=>call.includes('"writeTexture"')
            || call.includes('"copyBufferToTexture"')), `${at}: textures uploaded`);
        assert.equal(worker.calls.length, thread.calls.length, at);
        for (let call = 0; call < thread.calls.length; call++)
        {
            assert.equal(worker.calls[call], thread.calls[call], `${at}: call ${call}`);
        }
        assert.equal(worker.kept.put, thread.kept.put, `${at}: the same uploads kept`);
        for (const [where, one] of Object.entries({ thread, worker }))
        {
            assert.deepEqual(one.failures, [], `${where}, ${at}`);
            assert.equal(one.kept.lost, 0, `${where}, ${at}`);
            assert.deepEqual(one.losses, [], `${where}, ${at}`);
            assert.equal(one.kept.bodies, 0, `${where}, ${at}: every frame let its texels go`);
            assert.equal(one.left, 0, `${where}, ${at}: nothing left under the root's names`);
            assert.deepEqual(one.released, { bodies: 0, bytes: 0, waiting: 0 }, `${where}, ${at}`);
            moved[where] += one.kept.moved;
        }
        assert.ok(thread.uniformsHeld > 0, `${at}: the frames' uniform arenas held in the cache`);
        puts += thread.kept.put;
    }
    assert.ok(puts > 0, 'uploads waited for their frames');
    assert.ok(moved.thread > 0 && moved.worker > 0,
        'some of their texels waited in the run\'s cache, on either side');
});

test('the gate sees a wrong read of the run\'s cache', { timeout: 120_000 }, async()=>{
    let differed = 0;
    for (const seed of [1, 2, 3, 4])
    {
        const thread = await run(seed, 'thread');
        const wrong = await run(seed, 'worker', { mutate: true });
        differed += wrong.calls.some((call, at)=>call !== thread.calls[at]) ? 1 : 0;
    }
    assert.ok(differed > 0, 'a body read wrong reaches the device');
});
