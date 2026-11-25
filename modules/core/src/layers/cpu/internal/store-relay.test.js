/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE_SPACE, answerStoreAsks, storeClient } from './store-relay.js';
import { testCache } from '../../cache/testing.fixture.js';

/** A store holding `records`, counting its lookups. @param {Record<string, Uint8Array>} records */
function countedStore(records){
    const looked = /** @type {string[]} */ ([]);
    return {
        looked,
        /** @type {import('../engine.js').TranslationStore} */
        store: {
            get: async key=>{
                looked.push(key);
                return records[key]?.slice() ?? null;
            },
            put: async()=>{},
        },
    };
}

/**
 * A process and `count` executors on one thread: each executor's messages go
 * to the process's answerer for it, and back; what crossed back is kept.
 *
 * @param {import('../engine.js').TranslationStore} store @param {number} count
 * @param {Awaited<ReturnType<typeof testCache>> | null} made
 */
function wired(store, count, made){
    return Array.from({ length: count }, ()=>{
        /** @type {any[]} */
        const crossed = [];
        /** @type {ReturnType<typeof storeClient>} */
        let client;
        /** @type {(message: any) => void} */
        let tell = ()=>{};
        // The keeper's index and segments, as the run's `join` hands them a thread.
        const keeper = /** @type {any} */ (made?.keeper);
        const joined = made === null ? null
            : { shared: keeper.shared, segments: keeper.segmentBuffers() };
        const answerer = answerStoreAsks({ store,
            cache: made === null ? null : { space: made.space(STORE_SPACE), joined: true },
            post: message=>{
                crossed.push(message);
                tell(message);
            } });
        client = storeClient(message=>answerer.answer(message));
        tell = message=>client.take(message);
        client.join(joined);
        return { client, answerer, crossed };
    });
}

const MODULE = new Uint8Array(1 << 16).map((_, i)=>i * 7);

test('a batch module two executors ask for is put once in the run\'s cache and read there, '
    + 'sent to neither', async()=>{
    const made = await testCache();
    const { store, looked } = countedStore({ 'm/1': MODULE, 'r/1': new Uint8Array([1, 2, 3]) });
    const [first, second] = wired(store, 2, made);
    const one = await first.client.store.get('m/1', { fixed: true });
    const two = await second.client.store.get('m/1', { fixed: true });
    assert.deepEqual(one, MODULE);
    assert.deepEqual(two, MODULE);
    assert.deepEqual(looked, ['m/1'], 'the store read once, for the first executor');
    const sent = first.crossed.filter(message=>message.bytes);
    assert.equal(sent.length, 0, 'no bytes crossed to an executor');
    assert.deepEqual(first.crossed.map(message=>message.cached), [true]);
    assert.deepEqual(second.crossed, [], 'the second executor did not ask the process');
    assert.equal(second.client.counts.cacheHits, 1);
    assert.equal(first.answerer.counts.cachedBytes, MODULE.length);
    const shared = made.space(STORE_SPACE).with('m/1',
        body=>body.buffer instanceof SharedArrayBuffer);
    assert.equal(shared, true, 'kept in the run\'s shared memory');
    // A record that may change under its key still crosses as it was read.
    assert.deepEqual(await second.client.store.get('r/1'), new Uint8Array([1, 2, 3]));
    assert.equal(made.space(STORE_SPACE).look('r/1'), null, 'and is not kept');
});

test('without the run\'s cache, a module crosses to each executor as before', async()=>{
    const { store, looked } = countedStore({ 'm/1': MODULE });
    const [first, second] = wired(store, 2, null);
    assert.deepEqual(await first.client.store.get('m/1', { fixed: true }), MODULE);
    assert.deepEqual(await second.client.store.get('m/1', { fixed: true }), MODULE);
    assert.deepEqual(looked, ['m/1', 'm/1']);
    assert.equal(first.crossed[0].bytes.length, MODULE.length);
});

test('a module the cache has no room for crosses, and a record the store has not is a miss',
    async()=>{
        const made = await testCache({ budget: 1 << 12, segmentBytes: 1 << 12 });
        const { store } = countedStore({ 'm/1': MODULE });
        const [first] = wired(store, 1, made);
        assert.deepEqual(await first.client.store.get('m/1', { fixed: true }), MODULE);
        assert.equal(first.crossed[0].cached, undefined);
        assert.equal(first.client.counts.copied, 1);
        assert.equal(await first.client.store.get('m/2', { fixed: true }), null);
    });

test('a put and an addition hand their buffer across, the whole of one; a part of one is copied',
    ()=>{
        /** @type {[any, any[] | undefined][]} */
        const sent = [];
        const { store } = storeClient((message, transfer)=>sent.push([message, transfer]));
        const record = new Uint8Array([1, 2, 3]);
        const blocks = new Uint8Array([4, 5]);
        const part = new Uint8Array(8).subarray(2, 4);
        store.put('r/1', record);
        store.append?.('blocks', blocks);
        store.append?.('blocks', part);
        assert.deepEqual(sent.map(([, transfer])=>transfer),
            [[record.buffer], [blocks.buffer], []]);
    });
