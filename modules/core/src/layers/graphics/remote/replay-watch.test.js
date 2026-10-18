/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The recorder's gate for buffers it compares through a write watch
 * (`watchWrites`) beside the same recorder comparing every byte: seeded runs
 * of stores, locks and draws over dynamic buffers that share pages, played
 * through both. What each played draw reads is what the program left in its
 * memory, on both paths, and the watched one compares no more than the other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playedDirect3D, recordedDirect3D } from './direct3d.js';
import { createSender } from './channel.js';
import { D3D_OK } from '../d3d9/constants.js';

/** A seeded generator. @param {number} seed */
function random(seed){
    let s = seed >>> 0;
    return (/** @type {number} */ n)=>{
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return (s >>> 8) % n;
    };
}

/**
 * A root with buffers and a draw that reads a range of one: the recorded side
 * tells the recording what it draws from (`drawsFrom`) where the buffers are
 * dynamic, the played side reads its memory, which has only what the
 * recording sent.
 *
 * @param {Uint8Array[][]} seen  the played draws' bytes, pushed to the last list
 * @param {boolean} [dynamic]
 */
const toy = (seen, dynamic = true)=>(/** @type {any} */ services)=>{
    const played = services.backend !== undefined;
    return {
        /** @param {number} length @param {{ buffer?: any }} out */
        CreateBuffer(length, out){
            const base = services.allocate(length);
            out.buffer = {
                base,
                length,
                /** @param {{ pBits?: number }} locked */
                Lock(locked){
                    locked.pBits = base;
                    return D3D_OK;
                },
                Unlock: ()=>D3D_OK,
            };
            return D3D_OK;
        },
        /** @param {any} buffer @param {number} from @param {number} to */
        Draw(buffer, from, to){
            if (played)
            {
                seen[seen.length - 1].push(services.readMemory(buffer.base + from, to - from)
                    .slice());
            }
            else if (dynamic)
            {
                services.drawsFrom?.(buffer, from, to);
            }
            return D3D_OK;
        },
    };
};

/**
 * The engine's write watch as the recorder is promised it: each watch takes
 * the pages written since its own last look at them.
 */
function watches(){
    /** @type {Set<{ first: number, last: number, dirty: Set<number> }>} */
    const all = new Set();
    return {
        /** A store of the program's. @param {number} address @param {number} length */
        stored(address, length){
            for (const watch of all)
            {
                for (let page = address >>> 12; page <= (address + length - 1) >>> 12; page++)
                {
                    if (page >= watch.first && page <= watch.last)
                    {
                        watch.dirty.add(page);
                    }
                }
            }
        },
        /** @param {number} address @param {number} length */
        watchWrites(address, length){
            const watch = { first: address >>> 12, last: (address + length - 1) >>> 12,
                dirty: new Set() };
            all.add(watch);
            return {
                /** @param {number} from @param {number} bytes */
                take(from, bytes){
                    const pages = [];
                    for (let page = Math.max(watch.first, from >>> 12);
                        page <= Math.min(watch.last, (from + bytes - 1) >>> 12); page++)
                    {
                        if (watch.dirty.delete(page))
                        {
                            pages.push(page);
                        }
                    }
                    return pages;
                },
            };
        },
    };
}

/**
 * One seeded run through a recorder, watched or not: what its played draws
 * read and what the program's memory held for each, the bytes compared and
 * the bytes unlocks sent. A program writes buffers that are not dynamic only
 * under a lock, a few stores at a time.
 *
 * @param {number} seed @param {boolean} watched @param {boolean} [dynamic]
 */
function run(seed, watched, dynamic = true){
    const next = random(seed);
    const ram = new Uint8Array(1 << 20);
    let free = 0x1000;
    const engine = watches();
    const services = {
        allocate: (/** @type {number} */ bytes)=>{
            // One after another, so that small buffers share pages.
            const at = free;
            free += bytes;
            return at;
        },
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            ram.slice(at, at + length),
        ...(watched ? { watchWrites: engine.watchWrites } : {}),
    };
    /** @type {Uint8Array[][]} */
    const seen = [];
    const played = playedDirect3D(toy(seen, dynamic),
        { ...services, backend: {}, readMemory: true });
    const sender = createSender({
        post: message=>{
            played.read(message.buffer, call=>{
                played.play(call);
            });
        },
        later: flush=>flush(),
    });
    const root = recordedDirect3D(toy(seen, dynamic), services, sender);
    const buffers = [0x1800, 0x1800, 0x900, 0x5000].map(length=>{
        /** @type {{ buffer?: any }} */
        const out = {};
        assert.equal(root.CreateBuffer(length, out), D3D_OK);
        return out.buffer;
    });
    /** A store of the program's into a buffer. @param {any} buffer */
    const store = buffer=>{
        const length = 1 + next(Math.min(600, buffer.length));
        const at = buffer.base + next(buffer.length - length + 1);
        for (let byte = 0; byte < length; byte++)
        {
            ram[at + byte] = next(256);
        }
        engine.stored(at, length);
    };
    /** @type {{ read: Uint8Array, held: Uint8Array }[]} */
    const draws = [];
    for (let step = 0; step < 600; step++)
    {
        const buffer = buffers[next(buffers.length)];
        const what = next(10);
        if (what < 5 && dynamic)
        {
            store(buffer);
        }
        else if (what < 7)
        {
            /** @type {{ pBits?: number }} */
            const locked = {};
            assert.equal(buffer.Lock(locked), D3D_OK);
            for (let stores = dynamic ? 1 : 1 + next(3); stores > 0; stores--)
            {
                store(buffer);
            }
            assert.equal(buffer.Unlock(), D3D_OK);
        }
        else
        {
            const from = next(buffer.length);
            const to = from + 1 + next(buffer.length - from);
            seen.push([]);
            assert.equal(root.Draw(buffer, from, to), D3D_OK);
            const read = seen[seen.length - 1];
            assert.equal(read.length, 1, 'played once');
            draws.push({ read: read[0], held: ram.slice(buffer.base + from, buffer.base + to) });
        }
    }
    const shipped = sender.shippedBytes();
    return { draws, compared: shipped.compared, unlocked: shipped.buffers };
}

test('a draw from buffers compared through the write watch reads what the program wrote, as one '
    + 'compared in full does', ()=>{
    for (let seed = 1; seed <= 12; seed++)
    {
        const full = run(seed, false);
        const watched = run(seed, true);
        assert.equal(watched.draws.length, full.draws.length);
        watched.draws.forEach((draw, index)=>{
            assert.deepEqual(draw.read, draw.held, `seed ${seed}, draw ${index}: watched`);
            assert.deepEqual(full.draws[index].read, full.draws[index].held,
                `seed ${seed}, draw ${index}: compared in full`);
        });
        assert.ok(watched.compared <= full.compared,
            `seed ${seed}: ${watched.compared} bytes compared watched, ${full.compared} in full`);
    }
});

test('an unlock of a buffer sent whole before sends what was written since, watched, and a draw '
    + 'reads what the program wrote, as one sending every unlock whole does', ()=>{
    let sent = 0;
    let whole = 0;
    for (let seed = 1; seed <= 12; seed++)
    {
        const full = run(seed, false, false);
        const watched = run(seed, true, false);
        assert.equal(watched.draws.length, full.draws.length);
        watched.draws.forEach((draw, index)=>{
            assert.deepEqual(draw.read, draw.held, `seed ${seed}, draw ${index}: watched`);
            assert.deepEqual(full.draws[index].read, full.draws[index].held,
                `seed ${seed}, draw ${index}: sent whole`);
        });
        assert.ok(watched.unlocked <= full.unlocked,
            `seed ${seed}: ${watched.unlocked} bytes unlocked watched, ${full.unlocked} whole`);
        sent += watched.unlocked;
        whole += full.unlocked;
    }
    // A store touches a page or two of buffers of two to six pages, three at
    // most an unlock: watched, a little over half of what whole unlocks send.
    assert.ok(sent < whole * 0.75, `${sent} bytes sent watched, ${whole} whole`);
});
