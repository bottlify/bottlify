/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of a blit's rooms (`blitRooms`): seeded random blits made three
 * ways - in rooms held in the run's cache, too small a cache for some of
 * them, so that those are plain memory; in rooms whose every grow hands back
 * memory full of what an earlier holder left there, as a block of the cache
 * may; and in rooms that are bytes of their own each call - and every
 * answer and every byte of guest memory compared. A blit that read a byte of
 * its room it did not write in the same call, or that held two views of one
 * room at once, answers differently in one of them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bytesPerCall } from '../../../../../../tools/fixtures/allocation.mjs';

import {
    DDBLTFAST_DESTCOLORKEY, DDBLTFAST_SRCCOLORKEY, DDBLTFX_MIRRORLEFTRIGHT, DDBLTFX_MIRRORUPDOWN,
    DDBLT_COLORFILL, DDBLT_DDFX, DDBLT_KEYDEST, DDBLT_KEYSRC,
} from './constants.js';
import { blitRooms, blt, bltFast } from './blit.js';
import { createScratches } from '../../cache/scratch.js';
import { testCache } from '../../cache/testing.fixture.js';

const MEMORY = 1 << 18;

/**
 * The arm the others are held to: a scratch that hands out bytes of their
 * own every call, as a converter made before it had rooms, so no view of it
 * is ever written over by a later one.
 *
 * @type {import('../../cache/scratch.js').Scratch}
 */
const FRESH = { bytes: length=>new Uint8Array(length), release: ()=>{} };

/** @param {number} seed */
const random = seed=>{
    let state = seed >>> 0;
    return (/** @type {number} */ below)=>{
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return Math.floor((state / 2 ** 32) * below);
    };
};

/** Channel masks of the RGB formats a copy converts between. */
const FORMATS = [
    { bytesPerPixel: 2, channels: { red: 0xf800, green: 0x7e0, blue: 0x1f, alpha: 0 } },
    { bytesPerPixel: 2, channels: { red: 0x7c00, green: 0x3e0, blue: 0x1f, alpha: 0x8000 } },
    { bytesPerPixel: 4, channels: { red: 0xff0000, green: 0xff00, blue: 0xff, alpha: 0 } },
    { bytesPerPixel: 4, channels: { red: 0xff0000, green: 0xff00, blue: 0xff, alpha: 0xff000000 } },
    { bytesPerPixel: 1 },
    { bytesPerPixel: 3, channels: { red: 0xff0000, green: 0xff00, blue: 0xff, alpha: 0 } },
];

/** @param {Uint8Array} bytes @param {boolean} windowed */
const memoryOver = (bytes, windowed)=>({
    readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>bytes.slice(at, at + length),
    writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
    ...(windowed ? { windowMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
        bytes.subarray(at, at + length) } : {}),
});

/**
 * One random blit, as a call that makes it on a memory with given rooms.
 *
 * @param {(below: number) => number} next
 */
function program(next){
    const format = ()=>FORMATS[next(FORMATS.length)];
    const shape = (/** @type {any} */ kind, /** @type {number} */ at)=>{
        const width = 1 + next(kind.compressed ? 16 : 120);
        const height = 1 + next(kind.compressed ? 16 : 90);
        const w = kind.compressed ? Math.ceil(width / 4) * 4 : width;
        const h = kind.compressed ? Math.ceil(height / 4) * 4 : height;
        return { ...kind, buffer: at, width: w, height: h,
            pitch: w * kind.bytesPerPixel + next(3) * 4 };
    };
    const rect = (/** @type {any} */ s)=>{
        if (next(4) === 0)
        {
            return null;
        }
        const left = next(s.width);
        const top = next(s.height);
        return { left, top, right: left + 1 + next(s.width - left),
            bottom: top + 1 + next(s.height - top) };
    };
    const compressedSource = next(8) === 0;
    const destKind = format();
    const srcKind = compressedSource ? { bytesPerPixel: 4, compressed: /** @type {const} */ ('dxt1') }
        : next(3) === 0 ? format() : destKind;
    const dest = shape(destKind, 0x100);
    const src = shape(srcKind, 0x20000);
    const key = ()=>{
        const low = next(1 << 16);
        return { low, high: low + next(64) };
    };
    const fast = next(3) === 0;
    if (fast)
    {
        const srcRect = rect(src);
        const flags = (next(2) ? DDBLTFAST_SRCCOLORKEY : 0)
            | (next(3) === 0 ? DDBLTFAST_DESTCOLORKEY : 0);
        const x = next(dest.width);
        const y = next(dest.height);
        const srcColorKey = key();
        const destColorKey = key();
        return (/** @type {any} */ memory, /** @type {any} */ rooms)=>bltFast({ memory, dest, src,
            srcRect, x, y, flags, srcColorKey, destColorKey, rooms });
    }
    const fill = next(6) === 0;
    const flags = fill ? DDBLT_COLORFILL
        : (next(2) ? DDBLT_KEYSRC : 0) | (next(3) === 0 ? DDBLT_KEYDEST : 0)
            | (next(3) === 0 ? DDBLT_DDFX : 0);
    const fx = { fillColor: next(2 ** 31), srcColorKey: key(), destColorKey: key(),
        ddfx: next(4) === 0 ? 0 : (next(2) ? DDBLTFX_MIRRORLEFTRIGHT : 0)
            | (next(2) ? DDBLTFX_MIRRORUPDOWN : 0) };
    const destRect = rect(dest);
    const srcRect = fill ? null : rect(src);
    const clipList = next(4) === 0 ? [rect(dest) ?? { left: 0, top: 0, right: 8, bottom: 8 }]
        : undefined;
    return (/** @type {any} */ memory, /** @type {any} */ rooms)=>blt({ memory, dest,
        src: fill ? null : src, destRect, srcRect, flags, fx, fxGiven: true, clipList, rooms });
}

/**
 * Rooms whose every grow is memory an earlier holder wrote all over, a page
 * into a larger buffer, as a block of the cache lies in its segment.
 */
const dirtyRooms = ()=>blitRooms(createScratches((_key, length)=>({
    bytes: new Uint8Array(length + 4096).fill(0xcd).subarray(4096), release: ()=>{} })).scratch);

test('gate: a blit answers and writes the same in rooms of the run\'s cache, in rooms '
    + 'left dirty and in fresh ones', async()=>{
    // A small cache, whose blocks a larger room outgrows and is held anew in.
    const cache = await testCache({ budget: 1 << 20, segmentBytes: 1 << 18 });
    const heldScratches = createScratches(cache.space('scratch').hold);
    const arms = [
        { rooms: blitRooms(heldScratches.scratch), bytes: new Uint8Array(MEMORY) },
        { rooms: dirtyRooms(), bytes: new Uint8Array(MEMORY) },
        { rooms: blitRooms(()=>FRESH), bytes: new Uint8Array(MEMORY) },
    ];
    const next = random(0x5eed);
    let made = 0;
    for (let index = 0; index < 600; index++)
    {
        const fill = random(index + 1);
        const start = new Uint8Array(MEMORY).map(()=>fill(256));
        const call = program(next);
        const windowed = next(2) === 0;
        const answers = arms.map(arm=>{
            arm.bytes.set(start);
            return call(memoryOver(arm.bytes, windowed), arm.rooms);
        });
        made += answers[2] === 0 ? 1 : 0;
        assert.equal(answers[0], answers[2], `blit ${index}: held rooms answer as fresh ones`);
        assert.equal(answers[1], answers[2], `blit ${index}: dirty rooms answer as fresh ones`);
        assert.ok(arms[0].bytes.every((byte, at)=>byte === arms[2].bytes[at]),
            `blit ${index}: held rooms write as fresh ones`);
        assert.ok(arms[1].bytes.every((byte, at)=>byte === arms[2].bytes[at]),
            `blit ${index}: dirty rooms write as fresh ones`);
    }
    assert.ok(made > 200, `most of the blits are made (${made})`);
    const figures = heldScratches.figures();
    assert.ok(figures.held > 0 && figures.refused === 0, 'the rooms are held in the cache');
});

test('a full-screen blit reused frame after frame grows its rooms once and makes '
    + 'none a frame', async()=>{
    const cache = await testCache();
    const scratches = createScratches(cache.space('scratch').hold);
    const rooms = blitRooms(scratches.scratch);
    // A 640 by 480 back buffer at four bytes copied onto the primary.
    const width = 640;
    const height = 480;
    const bytes = new Uint8Array(2 * width * height * 4 + 0x1000);
    const memory = memoryOver(bytes, true);
    const back = { buffer: 0, pitch: width * 4, width, height, bytesPerPixel: 4 };
    const primary = { ...back, buffer: width * height * 4 + 0x1000 };
    const frame = ()=>blt({ memory, dest: primary, src: back, flags: 0, rooms });
    assert.equal(frame(), 0);
    const grows = scratches.figures().grows;
    // The heap's sampler sees a call's own few objects (its rectangles, its
    // job) and an array's header, never the bytes behind it: a room made a
    // frame would add a header to what it counts, the counter of grows the
    // room itself. Every room a blit works in is taken through its scratch.
    const frames = 200;
    assert.ok(await bytesPerCall(frame, { calls: frames }) < 4096, 'a call\'s own objects');
    assert.equal(scratches.figures().grows, grows, 'the counter of grows stays put');
    assert.equal(rooms.snapshot.bytes(width * height * 4), rooms.snapshot.bytes(width * height * 4),
        'the same view frame after frame');
    assert.equal(scratches.figures().heldBytes, 2 * 1024 * 1024 + 4096,
        'the snapshot (1.2 MB in a 2 MiB block) and a row, in the run\'s budget');
    assert.equal(cache.keeper.under('scratch/').hotBytes, scratches.figures().heldBytes);
});
