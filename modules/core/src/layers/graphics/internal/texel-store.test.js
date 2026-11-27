/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEPT_FROM, createTexelStore } from './texel-store.js';
import { openRunCache } from '../../../process/run-cache.js';
import { channelSpace } from '../../cache/module.js';

const turn = ()=>new Promise(resolve=>setTimeout(resolve, 0));

/** A run's cache and one owner's names in it, as a graphics root has them. */
async function owner(){
    const run = await openRunCache({ budget: 16 << 20 });
    /** @type {ReturnType<typeof channelSpace> | null} */
    let names = null;
    const joined = run.join(message=>names?.adopt(message));
    names = channelSpace(joined, run.serve('texels'));
    const space = names;
    return {
        run, names: space,
        under: ()=>run.under(space.prefix),
        close: async()=>{
            const released = await space.close();
            run.close();
            return released;
        },
    };
}

/** @param {() => boolean} done */
async function until(done){
    for (let turns = 0; turns < 1000 && !done(); turns++)
    {
        await turn();
    }
}

/** @param {number} length @param {number} seed */
const bytesOf = (length, seed)=>new Uint8Array(length).map((_, at)=>(at * 31 + seed) & 0xff);

test('a body put moves into the run\'s cache, is read there in place and taken back as it was',
    async()=>{
        const cache = await owner();
        try
        {
            const store = createTexelStore({ cache: cache.names });
            const made = bytesOf(KEPT_FROM * 2, 5);
            const expected = made.slice();
            store.put('level', made);
            // Readable at once, before the room is granted: from the bytes handed over.
            assert.equal(store.with('level', bytes=>bytes), made);
            await until(()=>store.figures().moved === 1);
            assert.deepEqual(cache.under(), { bodies: 1, bytes: made.length,
                hotBytes: made.length, placedBytes: made.length });
            assert.deepEqual({ plain: store.figures().plainBytes,
                cached: store.figures().cachedBytes }, { plain: 0, cached: made.length });
            // In place: the view handed to `read` is the cache's shared memory.
            const seen = store.with('level', bytes=>({ shared: bytes.buffer instanceof
                SharedArrayBuffer, same: bytes.every((byte, at)=>byte === expected[at]) }));
            assert.deepEqual(seen, { shared: true, same: true });
            const back = /** @type {Uint8Array} */ (store.take('level'));
            assert.ok(!(back.buffer instanceof SharedArrayBuffer), 'the caller\'s own bytes');
            assert.deepEqual(back, expected);
            assert.equal(store.has('level'), false);
            assert.equal(store.figures().takenBytes, made.length, 'one copy out of the cache');
            await until(()=>cache.under().bodies === 0);
            assert.equal(cache.under().bodies, 0, 'and its body gone from there');
        }
        finally
        {
            await cache.close();
        }
    });

test('a body dropped before its room came leaves nothing in the cache and no room held',
    // Room granted and never written holds the owner's end open: without a
    // timeout the test would wait for it rather than fail.
    { timeout: 10_000 }, async()=>{
        const cache = await owner();
        const store = createTexelStore({ cache: cache.names });
        store.put('a', bytesOf(KEPT_FROM, 1));
        store.drop('a');
        store.put('b', bytesOf(KEPT_FROM, 2));
        // Taken back before the room came: the bytes themselves, no copy.
        const handed = bytesOf(KEPT_FROM, 3);
        store.put('c', handed);
        assert.equal(store.take('c'), handed);
        // Put again under one key while the first room is asked for.
        store.put('b', bytesOf(KEPT_FROM, 4));
        await until(()=>store.figures().forgone === 3 && store.figures().moved === 1);
        assert.deepEqual({ forgone: store.figures().forgone, moved: store.figures().moved },
            { forgone: 3, moved: 1 });
        assert.equal(store.with('b', bytes=>bytes[0]), bytesOf(KEPT_FROM, 4)[0]);
        assert.equal(cache.under().bodies, 1, 'the one body kept, nothing of those that went');
        store.drop('b');
        const released = await cache.close();
        assert.deepEqual(released, { bodies: 0, bytes: 0, waiting: 0 },
            'the owner goes holding nothing: no granted room left unwritten');
        assert.deepEqual(cache.run.figures().ownerTails, { owners: 0, bodies: 0, bytes: 0 });
    });

test('without a cache, and below the unit of room, a body keeps the same contract in plain memory',
    async()=>{
        const cache = await owner();
        try
        {
            for (const store of [createTexelStore(),
                createTexelStore({ cache: cache.names })])
            {
                const big = bytesOf(KEPT_FROM, 7);
                const small = bytesOf(KEPT_FROM - 1, 8);
                store.put('big', store.cached ? bytesOf(KEPT_FROM - 1, 7) : big);
                store.put('small', small);
                await turn();
                assert.equal(store.with('small', bytes=>bytes), small, 'read where it lies');
                assert.equal(store.lengthOf('small'), small.length);
                assert.equal(store.take('small'), small, 'taken back without a copy');
                assert.equal(store.with('small', ()=>1), undefined, 'gone once taken');
                assert.equal(store.take('small'), null);
                store.drop('big');
                assert.equal(store.has('big'), false);
                assert.equal(store.figures().moved, 0);
                assert.equal(store.figures().plainBytes, 0);
            }
            assert.equal(cache.under().bodies, 0);
        }
        finally
        {
            await cache.close();
        }
    });

test('a body the cache cannot give back is a loss, said and counted, and reads as zeros',
    async()=>{
        /** @type {[string, string][]} */
        const said = [];
        /** @type {Map<string, Uint8Array>} */
        const held = new Map();
        // A cache that loses what it held: every read a miss once it is in.
        const losing = {
            space: { look: ()=>null, with: ()=>undefined, put: ()=>false, drop: ()=>{},
                hold: ()=>null },
            ask: async()=>true,
            /** @param {string} name @param {Uint8Array} bytes */
            put: (name, bytes)=>{
                held.set(name, bytes);
                return true;
            },
            forgo: ()=>{},
        };
        const store = createTexelStore({ cache: losing,
            divergence: (detail, severity)=>said.push([severity, detail]) });
        store.put('a', bytesOf(KEPT_FROM, 1));
        store.put('b', bytesOf(KEPT_FROM, 2));
        await until(()=>store.figures().moved === 2);
        assert.deepEqual(store.with('a', bytes=>[bytes.length, bytes.some(byte=>byte !== 0)]),
            [KEPT_FROM, false]);
        const back = /** @type {Uint8Array} */ (store.take('b'));
        assert.deepEqual([back.length, back.some(byte=>byte !== 0)], [KEPT_FROM, false]);
        assert.equal(store.figures().lost, 2);
        assert.equal(store.figures().cachedBytes, 0);
        assert.equal(store.has('a'), false, 'a lost body is not held');
        assert.equal(said.length, 2);
        assert.ok(said.every(([severity])=>severity === 'loss'));
    });

test('a body refused room is a loss, said and counted, and reads as zeros: no copy kept',
    async()=>{
        const refusing = {
            space: { look: ()=>null, with: ()=>undefined, put: ()=>false, drop: ()=>{},
                hold: ()=>null },
            ask: async()=>false,
            put: ()=>false,
            forgo: ()=>{},
        };
        /** @type {string[]} */
        const said = [];
        const store = createTexelStore({ cache: refusing,
            divergence: (_detail, severity)=>said.push(severity) });
        store.put('a', bytesOf(KEPT_FROM, 9));
        await until(()=>store.figures().refused === 1);
        assert.deepEqual(store.with('a', read=>[read.length, read.some(byte=>byte !== 0)]),
            [KEPT_FROM, false]);
        assert.deepEqual(store.figures().lost, 1);
        assert.equal(store.figures().plainBytes, 0, 'nothing kept in this heap');
        assert.deepEqual(said, ['loss']);
    });
