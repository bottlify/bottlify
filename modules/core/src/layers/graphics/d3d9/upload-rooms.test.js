/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the rooms a Direct3D 8 or 9 upload is made in on its way to
 * the queue (`d3d8/render.js` `rooms`: a level's rows taken out tight, it
 * widened, it decoded from blocks): seeded programs of textures in every
 * format the renderer widens or decodes, written whole and in part between
 * frames and while a frame samples them, drawn, run three ways - its rooms
 * held in the run's cache, rooms whose every grow is dirty memory a page into
 * a larger buffer, and rooms that are bytes of their own each call. The
 * device must be given the same calls with the same bytes; a converter that
 * read a byte of its room it did not write, or a view kept past the next
 * upload (one that waits in its frame's order), gives it others.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3D_OK, FORMAT_INFO, surfaceBytes } from './constants.js';
import { D3DCLEAR, D3DFMT_INDEX, D3DPT } from '../d3d8/constants.js';
import { createDirect3D9 } from './device.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF } from '../webgpu/internal/vertexformat.js';
import { createScratches } from '../../cache/scratch.js';
import { deviceRooms, testCache } from '../../cache/testing.fixture.js';

const RAM_BASE = 0x40000000;

/**
 * The arm the others are held to: a scratch that hands out bytes of their
 * own every call, as a converter made before it had rooms, so no view of it
 * is ever written over by a later one.
 *
 * @type {import('../../cache/scratch.js').Scratch}
 */
const FRESH = { bytes: length=>new Uint8Array(length), release: ()=>{} };
const ok = (/** @type {number} */ value)=>assert.equal(value, D3D_OK);

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

/** Every format a level is widened or decoded from on its way up. */
const FORMATS = [D3DFMT.A8R8G8B8, D3DFMT.X8R8G8B8, D3DFMT.R5G6B5, D3DFMT.X1R5G5B5,
    D3DFMT.A1R5G5B5, D3DFMT.A4R4G4B4, D3DFMT.X4R4G4B4, D3DFMT.A2R10G10B10, D3DFMT.A8,
    D3DFMT.L8, D3DFMT.A8L8, D3DFMT.A4L4, D3DFMT.V8U8, D3DFMT.L6V5U5, D3DFMT.Q8W8V8U8,
    D3DFMT.L16, D3DFMT.DXT1, D3DFMT.DXT3, D3DFMT.DXT5];

/** A call as text: the double's objects left out, bytes by their exact values. @param {any} call */
const callText = call=>JSON.stringify({ op: call.op, size: call.size, layout: call.layout,
    origin: call.destination?.origin, mipLevel: call.destination?.mipLevel,
    bufferOffset: call.bufferOffset, bytes: call.bytes ? [...call.bytes].join(',') : undefined });

/**
 * A device on the fake GPU, its renderer's rooms taken from `scratches`, with
 * a quad to draw a texture on.
 *
 * @param {(name: string) => import('../../cache/scratch.js').Scratch} scratches
 */
function deviceWith(scratches){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const ram = new Uint8Array(8 << 20);
    let free = RAM_BASE + (1 << 20);
    const d3d = createDirect3D9({
        ...deviceRooms(),
        backend,
        scratches,
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
    return { gpu, ram, device };
}

/**
 * One run of a seeded program: the calls the device was given.
 *
 * @param {number} seed @param {'held' | 'dirty' | 'fresh'} rooms
 */
async function run(seed, rooms){
    const next = random(seed);
    // A small cache, whose blocks a larger level's room outgrows and is held anew in.
    const cache = rooms === 'held' ? await testCache({ budget: 1 << 20, segmentBytes: 1 << 18 })
        : null;
    const scratches = rooms === 'held'
        ? createScratches(/** @type {any} */ (cache).space('scratch').hold)
        : rooms === 'dirty' ? createScratches((_key, length)=>({
            bytes: new Uint8Array(length + 4096).fill(0xcd).subarray(4096), release: ()=>{} }))
            : null;
    const { gpu, ram, device } = deviceWith(scratches?.scratch ?? (()=>FRESH));
    /** @type {{ pBits?: number, Pitch?: number }} */
    const locked = {};
    /** @type {{ texture: any, format: number, size: number, levels: number }[]} */
    const textures = [];
    const count = 4 + next() % 4;
    while (textures.length < count)
    {
        const format = FORMATS[next() % FORMATS.length];
        // Odd sides too, whose rows a pitch pads and an upload takes out tight.
        const size = BLOCKS(format) ? 32 << (next() % 3) : 20 + next() % 100;
        const levels = next() % 2 === 0 ? 1 : 0;
        /** @type {{ texture?: any }} */
        const held = {};
        if (device.CreateTexture(size, size, levels, 0, format, D3DPOOL.MANAGED, held) === D3D_OK)
        {
            textures.push({ texture: held.texture, format, size, levels: held.texture.levels });
        }
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
        const bytesPer = FORMAT_INFO[one.format].bytesPerPixel;
        const part = !BLOCKS(one.format) && side >= 8 && next() % 2 === 0;
        const rect = part ? { left: next() % (side / 2), top: next() % (side / 2),
            right: side - next() % (side / 4), bottom: side - next() % (side / 4) } : null;
        ok(one.texture.LockRect(level, locked, rect, 0));
        const at = /** @type {number} */ (locked.pBits) - RAM_BASE;
        const pitch = /** @type {number} */ (locked.Pitch);
        if (rect)
        {
            for (let row = 0; row < rect.bottom - rect.top; row++)
            {
                for (let byte = 0; byte < (rect.right - rect.left) * bytesPer; byte++)
                {
                    ram[at + row * pitch + byte] = next() & 0xff;
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
            write(one);
        }
    }
    for (let frame = 0; frame < 5; frame++)
    {
        // Written between frames: each upload goes to the queue at once.
        for (const one of textures)
        {
            if (next() % 2 === 0)
            {
                write(one);
            }
        }
        ok(device.BeginScene());
        ok(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, 0xff000000, 1, 0));
        const draws = 8 + next() % 8;
        for (let draw = 0; draw < draws; draw++)
        {
            const one = textures[next() % textures.length];
            // Now and then written while this frame samples it: that upload
            // waits in the frame's order, in bytes of its own.
            if (next() % 2 === 0)
            {
                write(one);
            }
            ok(device.SetTexture(0, one.texture));
            ok(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 0, 4, 0, 2));
        }
        ok(device.EndScene());
        ok(device.Present());
        await device.idle();
    }
    const failures = device.diagnostics().failures;
    cache?.keeper.close?.();
    return { calls: gpu.calls.map(callText), failures, figures: scratches?.figures() ?? null };
}

/** @param {number} format */
function BLOCKS(format){
    return format === D3DFMT.DXT1 || format === D3DFMT.DXT3 || format === D3DFMT.DXT5;
}

test('gate: an upload made in rooms of the run\'s cache, in dirty rooms and in fresh ones gives '
    + 'the device the same calls and bytes', { timeout: 120_000 }, async()=>{
    let held = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    {
        const none = await run(seed, 'fresh');
        assert.deepEqual(none.failures, [], `seed ${seed}`);
        assert.ok(none.calls.some(call=>call.includes('"writeTexture"')), `seed ${seed}: uploads`);
        for (const rooms of /** @type {const} */ (['held', 'dirty']))
        {
            const made = await run(seed, rooms);
            const at = `${rooms}, seed ${seed}`;
            assert.deepEqual(made.failures, [], at);
            assert.equal(made.calls.length, none.calls.length, at);
            for (let call = 0; call < none.calls.length; call++)
            {
                assert.equal(made.calls[call], none.calls[call], `${at}: call ${call}`);
            }
            if (rooms === 'held')
            {
                held += made.figures?.held ?? 0;
                assert.equal(made.figures?.refused, 0, at);
            }
        }
    }
    assert.ok(held > 0, 'rooms held in the run\'s cache');
});

test('a texture written every frame grows its rooms once, held in the run\'s cache', async()=>{
    const cache = await testCache();
    const scratches = createScratches(cache.space('scratch').hold);
    const { ram, device } = deviceWith(scratches.scratch);
    /** @type {{ texture?: any }} */
    const held = {};
    // A 16-bit level and a DXT1 one: one widened, one decoded, each frame.
    ok(device.CreateTexture(256, 256, 1, 0, D3DFMT.R5G6B5, D3DPOOL.MANAGED, held));
    const widened = held.texture;
    ok(device.CreateTexture(256, 256, 1, 0, D3DFMT.DXT1, D3DPOOL.MANAGED, held));
    const decoded = held.texture;
    /** @type {{ pBits?: number, Pitch?: number }} */
    const locked = {};
    /** @type {number[]} */
    const grows = [];
    for (let frame = 0; frame < 8; frame++)
    {
        for (const [texture, format] of [[widened, D3DFMT.R5G6B5], [decoded, D3DFMT.DXT1]])
        {
            ok(texture.LockRect(0, locked, null, 0));
            const at = /** @type {number} */ (locked.pBits) - RAM_BASE;
            ram.fill(frame * 7 + 1, at, at + surfaceBytes(format, 256, 256));
            ok(texture.UnlockRect(0));
        }
        ok(device.BeginScene());
        for (const texture of [widened, decoded])
        {
            ok(device.SetTexture(0, texture));
            ok(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 0, 4, 0, 2));
        }
        ok(device.EndScene());
        ok(device.Present());
        await device.idle();
        grows.push(scratches.figures().grows);
    }
    assert.ok(grows[0] >= 2, 'the widened and the decoded level each grew a room');
    assert.deepEqual(grows, grows.map(()=>grows[0]), 'and none grew again after the first frame');
    const figures = scratches.figures();
    assert.equal(figures.refused, 0);
    assert.equal(figures.heldBytes, 2 * 256 * 256 * 4, 'a level of four bytes a texel each');
    assert.equal(cache.keeper.under('scratch/').hotBytes, figures.heldBytes,
        'in the run\'s budget');
});
