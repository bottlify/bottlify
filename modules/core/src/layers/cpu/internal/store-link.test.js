/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the store across a link: a store asked directly and the same
 * store asked from a process across a link, every value crossing through the
 * link's codec, given the same seeded programs of puts and lookups, answer
 * every lookup alike -- the bytes of a record, or that there is none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeValue, encodeValue } from '../../../system/codec.js';
import { createDirectoryTranslationStore, createMemoryDirectory } from './translation-store.js';
import { remoteStore, storeHandlers } from './store-link.js';

/** @param {any} value */
const across = value=>decodeValue(encodeValue(value));

/** A small generator, so a failing seed runs again the same. @param {number} seed */
function random(seed){
    let state = seed >>> 0 || 1;
    return (/** @type {number} */ below)=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) % below;
    };
}

/** A store opened on a directory of its own. */
async function opened(){
    const store = await createDirectoryTranslationStore(createMemoryDirectory(), 'gate');
    await store.prepare();
    return store;
}

/**
 * The store as a process across a link has it: what it asks crosses the
 * codec both ways, and what it puts is answered later, as a call is.
 *
 * @param {any} store
 */
function overLink(store){
    const { store: handlers } = storeHandlers(store);
    /** @type {Promise<any>[]} */
    const calls = [];
    const remote = remoteStore({
        ask: (method, args)=>{
            const answer = /** @type {any} */ (handlers)[method](...across(args));
            assert.ok(!(answer instanceof Promise), `${method} answered at once`);
            return across(answer);
        },
        call: (method, args)=>{
            const pending = Promise.resolve(/** @type {any} */ (handlers)[method](...across(args)))
                .then(across);
            calls.push(pending);
            return pending;
        },
    });
    return { remote, settled: ()=>Promise.all(calls) };
}

/** @param {Uint8Array | null | undefined} bytes */
const shown = bytes=>(bytes === null || bytes === undefined ? String(bytes)
    : Array.from(bytes).join(','));

for (const seed of [1, 2, 3, 4, 5, 6])
{
    test(`a store across a link answers as the store itself (seed ${seed})`, async()=>{
        const next = random(seed);
        const direct = await opened();
        const { remote, settled } = overLink(await opened());
        const keys = Array.from({ length: 12 }, (_, i)=>`region-${seed}-${i}`);
        for (let step = 0; step < 200; step++)
        {
            const key = keys[next(keys.length)];
            const op = next(4);
            if (op === 0)
            {
                const bytes = Uint8Array.from({ length: 1 + next(64) }, ()=>next(256));
                await direct.put(key, bytes);
                await remote.put(key, bytes);
                await settled();
            }
            else if (op === 1)
            {
                assert.equal(shown(remote.getNow?.(key)), shown(direct.getNow(key)),
                    `step ${step}: getNow ${key}`);
            }
            else if (op === 2)
            {
                const asked = Array.from({ length: next(5) }, ()=>keys[next(keys.length)]);
                assert.deepEqual(remote.getManyNow(asked)?.map(shown),
                    asked.map(one=>shown(direct.getNow(one))), `step ${step}: getManyNow`);
            }
            else
            {
                assert.equal(shown(await remote.get(key)), shown(await direct.get(key)),
                    `step ${step}: get ${key}`);
            }
        }
    });
}

test('a lookup the link cannot answer is no answer, and the translator asks again later',
    ()=>{
        const remote = remoteStore({
            ask: ()=>{
                throw new Error('the link is closed');
            },
            call: async()=>null,
        });
        assert.equal(remote.getNow?.('anything'), undefined);
        assert.equal(remote.getManyNow(['a', 'b']), undefined);
    });
