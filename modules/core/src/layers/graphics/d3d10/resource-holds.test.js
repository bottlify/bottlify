/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of a resource's bytes held in the run's cache (`render.js`
 * `backingOf`, `cache/scratch.js` `hold`): seeded random programs of
 * creates, maps, updates, copies and releases through a Direct3D 10 and a
 * Direct3D 11 device, made twice - every resource's bytes held in a roomy
 * cache, and in a cache whose blocks come back full of what an earlier
 * holder left there - and every call the GPU was handed and
 * every byte the program read back compared. A renderer that read a byte of
 * its resource it never wrote, or took a view's offset in the cache's
 * segment for its offset in the resource, answers differently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import {
    D3D10_BIND, D3D10_CPU_ACCESS, D3D10_DRIVER_TYPE, D3D10_MAP, D3D10_SDK_VERSION, D3D10_USAGE,
    D3D_FEATURE_LEVEL, DXGI_FORMAT, S_OK,
} from './constants.js';
import { D3D10CreateDevice, D3D11CreateDevice } from './device.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { createScratches, roomFor } from '../../cache/scratch.js';
import { deviceRooms, testCache, testScratch } from '../../cache/testing.fixture.js';

/** @param {number} seed */
const random = seed=>{
    let state = seed >>> 0;
    return (/** @type {number} */ below)=>{
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return Math.floor((state / 2 ** 32) * below);
    };
};

/** @param {(below: number) => number} next @param {number} length */
const randomBytes = (next, length)=>Uint8Array.from({ length }, ()=>next(256));

/**
 * Guest memory as the engine gives it, for a resource a map hands out in it:
 * a bump heap, and a write watch at page grain the program's stores mark.
 */
function guestMemory(){
    const memory = new Uint8Array(4 << 20);
    let next = 0x10000;
    /** @type {Set<number>} */
    const written = new Set();
    return {
        memory,
        /** @param {number} address @param {Uint8Array} bytes  the program's store */
        store(address, bytes){
            memory.set(bytes, address);
            for (let page = address >>> 12; page <= (address + bytes.length - 1) >>> 12; page++)
            {
                written.add(page);
            }
        },
        /** @type {import('./render.js').GuestStorage} */
        storage: {
            allocate: bytes=>{
                const at = next;
                next += (bytes + 0xfff) & ~0xfff;
                return next <= memory.length ? at : 0;
            },
            free: ()=>{},
            readMemory: (address, length)=>memory.slice(address, address + length),
            writeMemory: (address, bytes)=>memory.set(bytes, address),
            watchWrites: ()=>({
                take: (address, length)=>{
                    const pages = [...written].filter(page=>page >= address >>> 12
                        && page <= (address + length - 1) >>> 12);
                    pages.forEach(page=>written.delete(page));
                    return pages;
                },
            }),
        },
    };
}

/**
 * A device over the recording GPU, Direct3D 10's or 11's, its resources'
 * bytes held where `holds` says, and those a map hands out in `guest` where
 * there is one.
 *
 * @param {'d3d10' | 'd3d11'} api
 * @param {import('./device.js').DeviceOptions['holds']} holds
 * @param {import('./render.js').GuestStorage} [guest]
 */
function deviceOf(api, holds, guest){
    const gpu = createFakeDevice();
    const backend = createBackend({ scratches: testScratch,
        device: gpu.device, queue: gpu.queue,
        presentTo: ()=>{}, now: ()=>0 });
    const options = {
        backend,
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
        createTexture: gpu.device.createTexture,
        holds: holds ?? deviceRooms().holds,
        ...(guest ? { guest } : {}),
    };
    if (api === 'd3d10')
    {
        /** @type {{ device?: any }} */
        const out = {};
        assert.equal(D3D10CreateDevice(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0,
            D3D10_SDK_VERSION, out, options), S_OK);
        return { gpu, device: out.device, context: out.device };
    }
    /** @type {any} */
    const out = { wantDevice: true, wantContext: true };
    assert.equal(D3D11CreateDevice(null, 1, null, 0, [D3D_FEATURE_LEVEL.LEVEL_11_0], out, options),
        S_OK);
    return { gpu, device: out.device, context: out.context };
}

/**
 * What the GPU was handed, every call, as text: an object named by the order
 * it was first seen in, bytes by their contents.
 *
 * @param {any[]} calls
 */
function transcriptOf(calls){
    /** @type {Map<object, number>} */
    const seen = new Map();
    return JSON.stringify(calls, (key, value)=>{
        if (typeof value === 'function')
        {
            return undefined;
        }
        if (ArrayBuffer.isView(value))
        {
            return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
        }
        if (value !== null && typeof value === 'object')
        {
            const id = seen.get(value);
            if (id !== undefined)
            {
                return `#${id}`;
            }
            seen.set(value, seen.size);
        }
        return value;
    });
}

/**
 * One seeded program, played on a device of `api` whose resources' bytes
 * `holds` holds: what each call answered, what each map read, and what the GPU
 * was handed.
 *
 * @param {number} seed @param {'d3d10' | 'd3d11'} api
 * @param {import('./device.js').DeviceOptions['holds']} holds
 */
async function play(seed, api, holds){
    const next = random(seed);
    // A third of the programs map into their own memory, as the engine's do.
    const guest = seed % 3 === 0 ? guestMemory() : null;
    const { gpu, device, context } = deviceOf(api, holds, guest?.storage);
    /** @type {any[]} */
    const said = [];
    /** @type {{ resource: any, buffer: boolean, desc: any, subresources: number }[]} */
    const live = [];
    /** @param {any} resource @param {number} subresource @param {number} type */
    const mapped = async(resource, subresource, type)=>{
        const pending = resource.pendingReadback();
        if (pending)
        {
            await pending;
        }
        /** @type {{ data?: Uint8Array | null, pData?: number, bytes?: number }} */
        const out = {};
        const hr = resource.Map(subresource, type, 0, out);
        if (guest && out.pData !== undefined)
        {
            const at = out.pData;
            const view = guest.memory.subarray(at, at + (out.bytes ?? 0));
            return { hr, data: view,
                write: (/** @type {number} */ offset, /** @type {Uint8Array} */ bytes)=>
                    guest.store(at + offset, bytes) };
        }
        const data = out.data ?? null;
        return { hr, data,
            write: (/** @type {number} */ offset, /** @type {Uint8Array} */ bytes)=>
                data?.set(bytes, offset) };
    };
    const kinds = [D3D10_USAGE.DEFAULT, D3D10_USAGE.DYNAMIC, D3D10_USAGE.STAGING];
    for (let step = 0; step < 60; step++)
    {
        const choice = next(10);
        if (choice < 3 || live.length < 2)
        {
            const usage = kinds[next(3)];
            const access = usage === D3D10_USAGE.DYNAMIC ? D3D10_CPU_ACCESS.WRITE
                : usage === D3D10_USAGE.STAGING
                    ? D3D10_CPU_ACCESS.READ | D3D10_CPU_ACCESS.WRITE : 0;
            /** @type {{ resource?: any }} */
            const out = {};
            if (next(2) === 0)
            {
                // Now and then one past what the cache holds beside its spare segment,
                // which finds no room.
                const desc = { ByteWidth: 16 * (1 + next(next(8) === 0 ? 12_000 : 300)),
                    Usage: usage,
                    BindFlags: usage === D3D10_USAGE.STAGING ? 0 : D3D10_BIND.VERTEX_BUFFER,
                    CPUAccessFlags: access, MiscFlags: 0 };
                const data = next(2) === 0
                    ? [{ pSysMem: randomBytes(next, desc.ByteWidth) }] : null;
                said.push(['CreateBuffer', device.CreateBuffer(desc, data, out)]);
                live.push({ resource: out.resource, buffer: true, desc, subresources: 1 });
            }
            else
            {
                const width = 1 + next(40);
                const height = 1 + next(40);
                const dynamic = usage === D3D10_USAGE.DYNAMIC;
                const levels = dynamic ? 1 : 1 + next(Math.min(3, 32 - Math.clz32(Math.max(width,
                    height))));
                const slices = dynamic ? 1 : 1 + next(2);
                const desc = { Width: width, Height: height, MipLevels: levels, ArraySize: slices,
                    Format: DXGI_FORMAT.R8G8B8A8_UNORM, SampleDesc: { Count: 1, Quality: 0 },
                    Usage: usage,
                    BindFlags: usage === D3D10_USAGE.STAGING ? 0 : D3D10_BIND.SHADER_RESOURCE,
                    CPUAccessFlags: access, MiscFlags: 0 };
                const data = next(2) === 0 ? Array.from({ length: levels * slices }, (_, index)=>{
                    const level = index % levels;
                    const w = Math.max(1, width >> level);
                    const h = Math.max(1, height >> level);
                    return { pSysMem: randomBytes(next, w * h * 4), SysMemPitch: w * 4,
                        SysMemSlicePitch: w * h * 4 };
                }) : null;
                said.push(['CreateTexture2D', device.CreateTexture2D(desc, data, out)]);
                live.push({ resource: out.resource, buffer: false, desc,
                    subresources: levels * slices });
            }
            continue;
        }
        const one = live[next(live.length)];
        const subresource = next(one.subresources);
        if (choice < 5 && one.desc.Usage !== D3D10_USAGE.DEFAULT)
        {
            const dynamic = one.desc.Usage === D3D10_USAGE.DYNAMIC;
            const got = await mapped(one.resource, subresource,
                dynamic ? D3D10_MAP.WRITE_DISCARD : D3D10_MAP.READ_WRITE);
            said.push(['Map', got.hr, dynamic || !got.data ? null : [...got.data]]);
            if (got.data && got.data.length > 0)
            {
                const at = next(got.data.length);
                got.write(at, randomBytes(next, Math.min(got.data.length - at, 1 + next(200))));
                one.resource.Unmap(subresource);
            }
        }
        else if (choice < 7 && one.desc.Usage === D3D10_USAGE.DEFAULT)
        {
            if (one.buffer)
            {
                const left = next(one.desc.ByteWidth);
                const right = left + 1 + next(one.desc.ByteWidth - left);
                const box = next(2) === 0 ? null
                    : { left, top: 0, front: 0, right, bottom: 1, back: 1 };
                const length = box ? right - left : one.desc.ByteWidth;
                context.UpdateSubresource(one.resource, 0, box, randomBytes(next, length), 0, 0);
            }
            else
            {
                const level = subresource % one.desc.MipLevels;
                const w = Math.max(1, one.desc.Width >> level);
                const h = Math.max(1, one.desc.Height >> level);
                const left = next(w);
                const top = next(h);
                const box = next(2) === 0 ? null : { left, top, front: 0,
                    right: left + 1 + next(w - left), bottom: top + 1 + next(h - top), back: 1 };
                const rows = box ? box.bottom - box.top : h;
                const pitch = (box ? box.right - box.left : w) * 4 + 4 * next(3);
                context.UpdateSubresource(one.resource, subresource, box,
                    randomBytes(next, pitch * rows), pitch, pitch * rows);
            }
            said.push(['UpdateSubresource']);
        }
        else if (choice < 9)
        {
            // A copy between two of one shape: the GPU's where both have a GPU copy,
            // the bytes kept here where one is staging.
            const same = live.filter(other=>other !== one && other.buffer === one.buffer
                && (one.buffer ? other.desc.ByteWidth === one.desc.ByteWidth
                    : other.desc.Width === one.desc.Width && other.desc.Height === one.desc.Height
                        && other.desc.MipLevels === one.desc.MipLevels
                        && other.desc.ArraySize === one.desc.ArraySize)
                && other.desc.Usage !== D3D10_USAGE.DYNAMIC);
            if (same.length > 0 && one.desc.Usage !== D3D10_USAGE.DYNAMIC)
            {
                context.CopyResource(same[next(same.length)].resource, one.resource);
                said.push(['CopyResource']);
            }
        }
        else
        {
            live.splice(live.indexOf(one), 1);
            said.push(['Release', one.resource.release()]);
        }
        if (next(4) === 0)
        {
            context.Flush();
            await device.idle();
        }
    }
    context.Flush();
    await device.idle();
    // What every staging resource holds at the end, as the program reads it.
    for (const one of live.filter(other=>other.desc.Usage === D3D10_USAGE.STAGING))
    {
        for (let subresource = 0; subresource < one.subresources; subresource++)
        {
            const got = await mapped(one.resource, subresource, D3D10_MAP.READ);
            said.push(['Map', got.hr, got.data ? [...got.data] : null]);
            one.resource.Unmap(subresource);
        }
    }
    return { said: JSON.stringify(said), calls: transcriptOf(gpu.calls) };
}

/**
 * A cache whose blocks come back full of what the holder before left: every
 * room it holds filled with a pattern before it is handed over.
 *
 * @param {{ budget: number, segmentBytes: number }} made
 */
async function usedCache(made){
    const cache = await testCache(made);
    const space = cache.space('scratch');
    /** @type {import('../../cache/scratch.js').Hold} */
    const hold = (key, length)=>{
        const got = space.hold(key, length);
        got?.bytes.fill(0xcd);
        return got;
    };
    return { cache, hold };
}

const SEEDS = Array.from({ length: 24 }, (_, n)=>0x5eed0 + n * 7919);

test('a resource\'s bytes held in a used cache answer every program as in a roomy one does, '
    + 'Direct3D 10 and 11 alike', { timeout: 300_000 }, async()=>{
    let held = 0;
    for (const seed of SEEDS)
    {
        const api = seed % 2 === 0 ? 'd3d10' : 'd3d11';
        const alone = await play(seed, api, undefined);
        const { hold } = await usedCache({ budget: 64 << 20, segmentBytes: 16 << 20 });
        const scratches = createScratches(hold);
        const inCache = await play(seed, api, (name, length)=>{
            held++;
            return scratches.hold(name, length);
        });
        assert.equal(inCache.said, alone.said, `seed ${seed} (${api}): what the program read`);
        assert.equal(inCache.calls, alone.calls, `seed ${seed} (${api}): what the GPU was handed`);
        assert.equal(scratches.figures().refused, 0, `seed ${seed}: every resource held`);
    }
    assert.ok(held > 50, `resources held in the cache (${held})`);
});

test('the gate fails a hold that hands over what the block held before, or one room for two '
    + 'resources', { timeout: 300_000 }, async()=>{
    /** @type {Record<string, import('./device.js').DeviceOptions['holds']>} */
    const mutants = {};
    {
        const { hold } = await usedCache({ budget: 4 << 20, segmentBytes: 1 << 20 });
        mutants['not zeroed'] = (name, length)=>{
            const got = hold(name, roomFor(length));
            return got ? { bytes: got.bytes.subarray(0, length), release: got.release }
                : (()=>{
                    throw new Error('no room');
                })();
        };
    }
    {
        const shared = new Uint8Array(new SharedArrayBuffer(1 << 20));
        mutants['one room'] = (name, length)=>({ bytes: shared.subarray(0, length).fill(0),
            release: ()=>{} });
    }
    for (const [why, holds] of Object.entries(mutants))
    {
        let caught = false;
        for (const seed of SEEDS)
        {
            const api = seed % 2 === 0 ? 'd3d10' : 'd3d11';
            const alone = await play(seed, api, undefined);
            const mutant = await play(seed, api, holds);
            if (mutant.said !== alone.said || mutant.calls !== alone.calls)
            {
                caught = true;
                break;
            }
        }
        assert.ok(caught, `a hold ${why} is found`);
    }
});

test('a resource\'s held bytes go back to the cache once nothing can reach it, and with the '
    + 'holder', { timeout: 60_000 }, async()=>{
    setFlagsFromString('--expose-gc');
    const collect = /** @type {() => void} */ (runInNewContext('gc'));
    const cache = await testCache();
    const scratches = createScratches(cache.space('scratch').hold);
    const holds = (/** @type {string} */ name, /** @type {number} */ length)=>
        scratches.hold(name, length);
    await (async()=>{
        const { device, context } = deviceOf('d3d11', holds);
        for (let n = 0; n < 8; n++)
        {
            /** @type {{ resource?: any }} */
            const out = {};
            assert.equal(device.CreateBuffer({ ByteWidth: 4096, Usage: D3D10_USAGE.STAGING,
                BindFlags: 0, CPUAccessFlags: D3D10_CPU_ACCESS.READ, MiscFlags: 0 }, null, out),
            S_OK);
            out.resource.release();
        }
        context.Flush();
        await device.idle();
        assert.equal(scratches.figures().held, 8, 'each resource\'s bytes held');
    })();
    for (let tries = 0; tries < 50 && scratches.figures().held > 0; tries++)
    {
        collect();
        await new Promise(resolve=>setImmediate(resolve));
    }
    assert.equal(scratches.figures().held, 0, 'let go of once nothing reaches them');
    cache.idle(1);
    assert.equal(cache.keeper.under('scratch/').bodies, 0);
    // And the holder going takes what is still held.
    const { device } = deviceOf('d3d10', holds);
    /** @type {{ resource?: any }} */
    const out = {};
    device.CreateBuffer({ ByteWidth: 4096, Usage: D3D10_USAGE.DEFAULT,
        BindFlags: D3D10_BIND.VERTEX_BUFFER, CPUAccessFlags: 0, MiscFlags: 0 }, null, out);
    assert.equal(cache.keeper.under('scratch/').bodies, 1);
    scratches.releaseAll();
    cache.idle(1);
    assert.equal(cache.keeper.under('scratch/').bodies, 0);
    assert.ok(out.resource, 'still the program\'s when its holder went');
});

test('a resource past a segment of the run\'s cache is held there at its length, mapped, written'
    + ' and read back', { timeout: 60_000 }, async()=>{
    const cache = await testCache({ budget: 64 << 20, segmentBytes: 16 << 20 });
    const scratches = createScratches(cache.space('scratch').hold ?? null);
    /** @type {Uint8Array[]} */
    const given = [];
    const { device, context } = deviceOf('d3d11', (name, length)=>{
        const got = scratches.hold(name, length);
        given.push(got.bytes);
        return got;
    });
    const bytes = 20 * (1 << 20) + 16;
    /** @type {{ resource?: any }} */
    const out = {};
    assert.equal(device.CreateBuffer({ ByteWidth: bytes, Usage: D3D10_USAGE.STAGING, BindFlags: 0,
        CPUAccessFlags: D3D10_CPU_ACCESS.READ | D3D10_CPU_ACCESS.WRITE, MiscFlags: 0 }, null, out),
    S_OK);
    assert.equal(given.length, 1);
    assert.ok(given[0].buffer instanceof SharedArrayBuffer, 'in the cache');
    assert.equal(scratches.figures().refused, 0);
    assert.equal(cache.keeper.under('scratch/').placedBytes, bytes - 16 + 4096,
        'its pages, not a power of two');
    const written = randomBytes(random(7), 4096);
    /** @type {{ data?: Uint8Array | null }} */
    const map = {};
    assert.equal(out.resource.Map(0, D3D10_MAP.READ_WRITE, 0, map), S_OK);
    map.data?.set(written, bytes - written.length);
    map.data?.set(written, 0);
    out.resource.Unmap(0);
    context.Flush();
    await device.idle();
    /** @type {{ data?: Uint8Array | null }} */
    const read = {};
    assert.equal(out.resource.Map(0, D3D10_MAP.READ, 0, read), S_OK);
    const back = /** @type {Uint8Array} */ (read.data);
    assert.deepEqual([...back.subarray(bytes - written.length)], [...written]);
    assert.deepEqual([...back.subarray(0, written.length)], [...written]);
    out.resource.Unmap(0);
    out.resource.release();
    scratches.releaseAll();
    assert.equal(cache.keeper.under('scratch/').bodies, 0);
    cache.idle(1);
    assert.equal(cache.keeper.figures().segmentBytes, 0, 'its segment went with it');
});
