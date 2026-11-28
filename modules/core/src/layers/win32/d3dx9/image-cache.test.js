/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the images D3DX's texture loaders keep decoded in the run's
 * cache (`image-cache.js`): seeded programs that make textures, cube textures
 * and volume textures of a few files - TGAs, DDS files in A8R8G8B8 with their
 * mip chains, DXT1, a cube map, a volume - again and again, asked other sizes,
 * levels, formats, colour keys and pools, run with the run's cache under the
 * loaders and without one. Everything the program observes must be the same:
 * every answer, every call the device was given, the image info written, and
 * the bytes of every level of every texture made.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DX_DEFAULT, D3DX_FROM_FILE, createTextureLoader } from './texture.js';
import { FMT, layoutOf } from './pixels.js';
import { deviceRig } from './device.fixture.js';
import { writeDds } from './save-texture.js';
import { openRunCache } from '../../../process/run-cache.js';
import { cacheSpace } from '../../cache/module.js';
import { testCache } from '../../cache/testing.fixture.js';

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

/** @param {() => number} next @param {number} n */
const noise = (next, n)=>new Uint8Array(n).map(()=>next() & 0xff);

/**
 * A TGA of 24 bits, top row first.
 *
 * @param {number} width @param {number} height @param {Uint8Array} texels  b, g, r each
 */
function tga(width, height, texels){
    const file = new Uint8Array(18 + texels.length);
    file[2] = 2;
    file[12] = width;
    file[14] = height;
    file[16] = 24;
    file[17] = 0x20;
    file.set(texels, 18);
    return file;
}

/**
 * A DDS file whose one level of A8R8G8B8 is the faces of a cube map, or the
 * slices of a volume.
 *
 * @param {number} edge @param {Uint8Array[]} parts @param {'cube' | 'volume'} kind
 */
function stacked(edge, parts, kind){
    const head = writeDds(FMT.A8R8G8B8, [{ width: edge, height: edge, bytes: parts[0] }]);
    const file = new Uint8Array(head.length + parts.slice(1).reduce((sum, p)=>sum + p.length, 0));
    file.set(head);
    let at = head.length;
    for (const part of parts.slice(1))
    {
        file.set(part, at);
        at += part.length;
    }
    const view = new DataView(file.buffer);
    if (kind === 'cube')
    {
        view.setUint32(112, 0x200 | 0xfc00, true);
    }
    else
    {
        view.setUint32(8, view.getUint32(8, true) | 0x800000, true);
        view.setUint32(24, parts.length, true);
        view.setUint32(112, 0x200000, true);
    }
    return file;
}

/**
 * The files a program makes its textures of, the same for every seed: each
 * with the loader it goes through.
 *
 * @returns {{ file: Uint8Array, kind: 'texture' | 'cube' | 'volume' }[]}
 */
function files(){
    const next = random(99);
    /** @param {number} side */
    const chain = side=>{
        /** @type {{ width: number, height: number, bytes: Uint8Array }[]} */
        const levels = [];
        for (let edge = side; edge >= 1; edge >>= 1)
        {
            levels.push({ width: edge, height: edge, bytes: noise(next, edge * edge * 4) });
        }
        return levels;
    };
    return [
        { file: tga(32, 32, noise(next, 32 * 32 * 3)), kind: 'texture' },
        { file: tga(48, 16, noise(next, 48 * 16 * 3)), kind: 'texture' },
        { file: writeDds(FMT.A8R8G8B8, chain(32)), kind: 'texture' },
        { file: writeDds(FMT.DXT1, [{ width: 32, height: 32, bytes: noise(next, 512) }]),
            kind: 'texture' },
        { file: stacked(16, Array.from({ length: 6 }, ()=>noise(next, 16 * 16 * 4)), 'cube'),
            kind: 'cube' },
        { file: stacked(16, Array.from({ length: 4 }, ()=>noise(next, 16 * 16 * 4)), 'volume'),
            kind: 'volume' },
    ];
}

/** The formats a create asks for. */
const FORMATS = [FMT.UNKNOWN, D3DX_FROM_FILE, FMT.A8R8G8B8, FMT.X8R8G8B8, FMT.R5G6B5,
    FMT.A4R4G4B4, FMT.L8, FMT.DXT1, FMT.DXT5];
/** The level counts: a full chain, the file's, one, two. */
const MIPS = [D3DX_DEFAULT, D3DX_FROM_FILE, 1, 2];
/** Sizes: the file's rounded up, the file's, a size of its own. */
const SIZES = [D3DX_DEFAULT, 0, 16, 64];

/**
 * A level's bytes as the device holds them.
 *
 * @param {Uint8Array} memory @param {any} surface  a surface, or a volume's level
 */
const levelBytes = (memory, surface)=>{
    const length = surface.slicePitch ? surface.slicePitch * surface.depth
        : surface.pitch * layoutOf(surface.format, surface.width, surface.height).rows;
    return [...memory.subarray(surface.data, surface.data + length)].join(',');
};

/**
 * One run of a seeded program: everything it observed, and how many creates
 * the cache answered.
 *
 * @param {number} seed @param {boolean} cached
 * @param {{ mutate?: boolean }} [options]  `mutate`: the cache's read of a body is wrong
 *     in its last byte, a level's, which the gate must see
 */
async function run(seed, cached, { mutate = false } = {}){
    const next = random(seed);
    const r = deviceRig();
    const runCache = cached ? await openRunCache({ budget: 16 << 20 }) : null;
    const counts = { found: 0, kept: 0 };
    // A cache with no room: every create decodes.
    /** @type {import('../../cache/module.js').CacheSpace} */
    let images = (await testCache({ budget: 0 })).space('d3dx-images');
    if (runCache)
    {
        const space = cacheSpace(runCache.reader, 'd3dx-images');
        images = {
            ...space,
            with: (key, read, options)=>space.with(key, body=>{
                counts.found++;
                if (!mutate)
                {
                    return read(body);
                }
                const wrong = body.slice();
                wrong[wrong.length - 1] ^= 0xff;
                return read(wrong);
            }, options),
            put: (key, bytes)=>{
                counts.kept++;
                return space.put(key, bytes);
            },
        };
    }
    const loader = createTextureLoader({ ...r.host, images });
    const pool = files();
    const placed = pool.map(({ file })=>{
        const at = r.heap.allocate(file.length);
        r.memory.set(file, at);
        return at;
    });
    const out = r.heap.allocate(8);
    const info = r.heap.allocate(28);
    /** @type {string[]} */
    const observed = [];
    // A few ways the program asks for its files, each made more than once:
    // the pool and usage, which a decode does not depend on, at every create.
    const asks = Array.from({ length: 6 + next() % 4 }, ()=>({ which: next() % pool.length,
        size: SIZES[next() % SIZES.length], mips: MIPS[next() % MIPS.length],
        format: FORMATS[next() % FORMATS.length],
        key: next() % 3 === 0 ? (0xff000000 | next() & 0xffffff) >>> 0 : 0 }));
    const creates = 16 + next() % 8;
    for (let create = 0; create < creates; create++)
    {
        const { which, size, mips, format, key } = asks[next() % asks.length];
        const { file, kind } = pool[which];
        const usage = next() % 4 === 0 ? 0x200 : 0;
        const where = next() % 3;
        r.memory.fill(0xcd, info, info + 28);
        const args = kind === 'volume'
            ? [r.device, placed[which], file.length, size, size, 0, mips, usage, format, where,
                D3DX_DEFAULT, D3DX_DEFAULT, key, info, 0, out]
            : kind === 'cube'
                ? [r.device, placed[which], file.length, size, mips, usage, format, where,
                    D3DX_DEFAULT, D3DX_DEFAULT, key, info, 0, out]
                : [r.device, placed[which], file.length, size, size, mips, usage, format, where,
                    D3DX_DEFAULT, D3DX_DEFAULT, key, info, 0, out];
        const name = { texture: 'D3DXCreateTextureFromFileInMemoryEx',
            cube: 'D3DXCreateCubeTextureFromFileInMemoryEx',
            volume: 'D3DXCreateVolumeTextureFromFileInMemoryEx' }[kind];
        const answer = await r.call(/** @type {any} */ (loader.exports[name]), args);
        const made = r.objects.get(r.view.getUint32(out, true));
        const levels = !made ? [] : made.kind === 'cube' ? made.faces.flat()
            : made.kind === 'volume' ? made.levels : made.surfaces;
        observed.push(JSON.stringify({ name, answer, format: made?.format, pool: made?.pool,
            info: [...r.memory.subarray(info, info + 28)],
            levels: levels.map((/** @type {any} */ level)=>levelBytes(r.memory, level)) }));
    }
    runCache?.close();
    return { observed, calls: r.calls.map(call=>JSON.stringify(call)),
        diverged: [...new Set(r.diverged.map(said=>said.join(': ')))].sort(), counts };
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

test('a texture made again of the same file reads its levels decoded in the run\'s cache, and the '
    + 'program observes what a decode of its own would give it', { timeout: 120_000 }, async()=>{
    let found = 0;
    let kept = 0;
    for (const seed of SEEDS)
    {
        const plain = await run(seed, false);
        const cached = await run(seed, true);
        assert.equal(cached.observed.length, plain.observed.length);
        for (let at = 0; at < plain.observed.length; at++)
        {
            assert.equal(cached.observed[at], plain.observed[at], `seed ${seed}: create ${at}`);
        }
        assert.deepEqual(cached.calls, plain.calls, `seed ${seed}: the device's calls`);
        // A decode the cache answered says once what the first one said.
        assert.deepEqual(cached.diverged, plain.diverged, `seed ${seed}`);
        found += cached.counts.found;
        kept += cached.counts.kept;
    }
    assert.ok(kept > 0, 'decodes kept');
    assert.ok(found > kept, 'creates answered from the run\'s cache');
});

test('the gate sees a wrong read of the run\'s cache', { timeout: 120_000 }, async()=>{
    let differed = 0;
    for (const seed of SEEDS)
    {
        const plain = await run(seed, false);
        const wrong = await run(seed, true, { mutate: true });
        differed += wrong.observed.some((seen, at)=>seen !== plain.observed[at]) ? 1 : 0;
    }
    assert.ok(differed > 0, 'a level read wrong reaches the texture');
});

test('a DDS in the format asked is not kept: its levels are the file\'s own bytes', async()=>{
    const r = deviceRig();
    const runCache = await openRunCache({ budget: 16 << 20 });
    const space = cacheSpace(runCache.reader, 'd3dx-images');
    let puts = 0;
    const loader = createTextureLoader({ ...r.host, images: { ...space, put: (key, bytes)=>{
        puts++;
        return space.put(key, bytes);
    } } });
    const file = files()[2].file;
    const at = r.heap.allocate(file.length);
    r.memory.set(file, at);
    const out = r.heap.allocate(8);
    const args = [r.device, at, file.length, 0, 0, D3DX_FROM_FILE, 0, FMT.A8R8G8B8, 1,
        D3DX_DEFAULT, D3DX_DEFAULT, 0, 0, 0, out];
    // A8R8G8B8 is the working form: the file's levels are views of its bytes.
    const call = ()=>r.call(/** @type {any} */ (loader.exports.D3DXCreateTextureFromFileInMemoryEx),
        args);
    assert.equal(await call(), 0);
    assert.equal(puts, 0, 'nothing decoded, nothing kept');
    args[7] = FMT.X8R8G8B8;
    assert.equal(await call(), 0);
    assert.equal(puts, 1, 'converted, the levels are kept');
    runCache.close();
});
