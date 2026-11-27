/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createChannel, openClient, openKeeper, openServer } from '@bottlify/cellar';
import { createCacheModule, serveKeeper } from './module.js';
import { openRunCache } from '../../process/run-cache.js';

test('a worker\'s bodies reach the keeper as the only copy for this run, to its disk and never '
    + 'named for the next', { timeout: 60_000 }, async()=>{
    // The graphics worker's texels: a body nothing can make again while the
    // run lasts, and nothing the next run can use.
    const keeper = await openKeeper({ budget: 1 << 20, segmentBytes: 1 << 20 });
    /** @type {any[]} */
    const asked = [];
    const channel = createChannel();
    const served = serveKeeper(openServer(channel), {
        reserve: (name, length, options)=>{
            asked.push(options);
            return keeper.reserve(name, length, options);
        },
        raise: (name, options)=>keeper.raise(name, options),
        drop: name=>keeper.drop(name),
        release: prefix=>keeper.release(prefix),
    }, { owner: 'texels/1/' });
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.url).then(async({ channelSpace })=>{
            const space = channelSpace(workerData.joined, { channel: workerData.channel, prefix: 'texels/1/' });
            const granted = await space.ask('1', 64);
            space.put('1', new Uint8Array(64).fill(7));
            space.space.put('2', new Uint8Array(32).fill(8));
            parentPort.postMessage({ granted });
        });`, { eval: true, workerData: { url: new URL('./module.js', import.meta.url).href,
        channel, joined: { shared: keeper.shared, segments: keeper.segmentBuffers() } } });
    try
    {
        const said = await new Promise((resolve, reject)=>{
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        assert.equal(/** @type {any} */ (said).granted, true);
        assert.ok(asked.length >= 2, 'room asked ahead, and for the body put outright');
        for (const options of asked)
        {
            assert.equal(options.onlyCopy, true);
            assert.equal(options.disk, 'run');
        }
    }
    finally
    {
        await worker.terminate();
        served.close();
        keeper.close();
    }
});

/**
 * The keeper served over `channels` channels, owners numbered from 1, and
 * what owners left behind as they went.
 *
 * @param {number} channels @param {{ inflate?: number }} [options]  `inflate`: bodies a
 *     release finds past those there, as a keeper holding what an owner forgot would
 */
async function servedKeeper(channels, { inflate = 0 } = {}){
    const keeper = await openKeeper({ budget: 1 << 20, segmentBytes: 1 << 20 });
    /** @type {import('./module.js').OwnerTail[]} */
    const tails = [];
    const memories = Array.from({ length: channels }, (_, n)=>({ channel: createChannel(),
        prefix: `texels/${n + 1}/` }));
    const served = memories.map(({ channel, prefix })=>serveKeeper(openServer(channel), {
        reserve: (name, length, options)=>keeper.reserve(name, length, options),
        raise: (name, options)=>keeper.raise(name, options),
        drop: name=>keeper.drop(name),
        release: owned=>{
            const left = keeper.release(owned);
            return { ...left, bodies: left.bodies + inflate };
        },
    }, { owner: prefix, onTail: tail=>tails.push(tail) }));
    return { keeper, memories, served, tails,
        joined: { shared: keeper.shared, segments: keeper.segmentBuffers() } };
}

/**
 * Runs `script` in a worker with `channelSpace` and what it is handed, and
 * answers the message it posts.
 *
 * @param {string} script  the body of an async function of
 *     ({ channelSpace, joined, channels, post })
 * @param {any} data
 */
async function inWorker(script, data){
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.url).then(async({ channelSpace })=>{
            const { joined, channels } = workerData;
            const post = message=>parentPort.postMessage(message);
            try { await (async()=>{ ${script} })(); }
            catch (error) { post({ error: String(error && error.stack || error) }); }
        });`, { eval: true,
        workerData: { url: new URL('./module.js', import.meta.url).href, ...data } });
    try
    {
        const said = await new Promise((resolve, reject)=>{
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        assert.equal(/** @type {any} */ (said).error, undefined);
        return /** @type {any} */ (said);
    }
    finally
    {
        await worker.terminate();
    }
}

test('two owners of one kind - two roots\' texels - the run serves names of their own, and their '
    + 'bodies under one key stay apart', { timeout: 60_000 }, async()=>{
    const run = await openRunCache();
    try
    {
        const served = [run.serve('texels'), run.serve('texels')];
        assert.notEqual(served[0].prefix, served[1].prefix);
        const joined = run.join(()=>{});
        const said = await inWorker(`
            const a = channelSpace(joined, channels[0]);
            const b = channelSpace(joined, channels[1]);
            a.put('1', new Uint8Array(64).fill(1));
            b.put('1', new Uint8Array(64).fill(2));
            const read = space=>space.space.with('1', body=>body[0], { wait: true });
            post({ a: read(a), b: read(b) });`,
        { joined: { shared: joined.shared, segments: joined.segments }, channels: served });
        assert.deepEqual([said.a, said.b], [1, 2], 'each owner reads what it put');
        assert.deepEqual(run.under(served[0].prefix),
            { bodies: 1, bytes: 64, hotBytes: 64, placedBytes: 4096 });
        assert.deepEqual(run.under(served[1].prefix),
            { bodies: 1, bytes: 64, hotBytes: 64, placedBytes: 4096 });
    }
    finally
    {
        run.close();
    }
});

test('an owner that goes lets go of every name it held, after the calls it sent before, and '
    + 'leaves no tail', { timeout: 60_000 }, async()=>{
    const { keeper, memories, served, tails, joined } = await servedKeeper(1);
    try
    {
        const said = await inWorker(`
            const space = channelSpace(joined, channels[0]);
            for (let n = 0; n < 6; n++)
            {
                space.put(String(n), new Uint8Array(100).fill(n));
            }
            // Let go of before it goes, the drops sent without waiting.
            space.space.drop('0');
            space.space.drop('1');
            const granted = await space.ask('7', 100);
            const held = space.held();
            const released = await space.close();
            post({ prefix: space.prefix, held, granted, released });`,
        { joined, channels: memories });
        assert.equal(said.held, 4);
        assert.deepEqual(said.released, { bodies: 5, bytes: 500, waiting: 1 },
            'the four it held and the room granted it, which waits for a writer that is gone');
        await served[0].ended;
        assert.deepEqual(keeper.under(said.prefix),
            { bodies: 1, bytes: 100, hotBytes: 100, placedBytes: 4096 },
            'only the reservation left, which the keeper takes back after its age');
        assert.deepEqual(tails, []);
    }
    finally
    {
        served.forEach(one=>one.close());
        keeper.close();
    }
});

test('an owner that leaves bodies past what it held, or goes without letting go, leaves a tail '
    + 'that is counted, and nothing under its names', { timeout: 60_000 }, async()=>{
    {
        const { keeper, memories, served, tails, joined } = await servedKeeper(1, { inflate: 2 });
        try
        {
            const said = await inWorker(`
                const space = channelSpace(joined, channels[0]);
                space.put('a', new Uint8Array(10));
                await space.close();
                post({ prefix: space.prefix });`, { joined, channels: memories });
            assert.deepEqual(tails,
                [{ prefix: said.prefix, bodies: 2, bytes: 10, held: 1, why: 'unknown' }]);
        }
        finally
        {
            served.forEach(one=>one.close());
            keeper.close();
        }
    }
    {
        const { keeper, memories, served, tails, joined } = await servedKeeper(1);
        try
        {
            const said = await inWorker(`
                const space = channelSpace(joined, channels[0]);
                space.put('a', new Uint8Array(10));
                space.put('b', new Uint8Array(20));
                post({ prefix: space.prefix });`, { joined, channels: memories });
            // Its channel closed from its end with its names out: its worker gone.
            openClient(memories[0].channel).close();
            await served[0].ended;
            assert.deepEqual(tails,
                [{ prefix: said.prefix, bodies: 2, bytes: 30, held: 0, why: 'unreleased' }]);
            assert.deepEqual(keeper.under(said.prefix),
                { bodies: 0, bytes: 0, hotBytes: 0, placedBytes: 0 });
        }
        finally
        {
            keeper.close();
        }
    }
    {
        // The run going closes every channel: what owners held then is no tail.
        const { keeper, memories, served, tails, joined } = await servedKeeper(1);
        await inWorker(`
            const space = channelSpace(joined, channels[0]);
            space.put('a', new Uint8Array(10));
            post({});`, { joined, channels: memories });
        served[0].close();
        await served[0].ended;
        assert.deepEqual(tails, []);
        keeper.close();
    }
});

test('an owner on the keeper\'s own thread - an in-thread root\'s texels - is numbered by the run, '
    + 'reads and writes through the thread\'s reader, and lets go of every name it held',
{ timeout: 60_000 }, async()=>{
    /** @type {import('./module.js').OwnerTail[]} */
    const tails = [];
    const run = await openRunCache({ onTail: tail=>tails.push(tail) });
    try
    {
        const api = await createCacheModule().create({ reader: run.reader, join: run.join,
            serve: run.serve, own: run.own });
        const worker = run.serve('texels');
        const owned = /** @type {NonNullable<ReturnType<typeof api.owner>>} */ (api.owner('texels'));
        assert.ok(owned, 'a run that serves names gives one');
        assert.notEqual(owned.prefix, worker.prefix, 'apart from a worker\'s root of the run');
        assert.equal(await owned.ask('1', 8192), true, 'granted at once');
        assert.equal(owned.put('1', new Uint8Array(8192).fill(3)), true);
        assert.equal(owned.put('2', new Uint8Array(8192).fill(4)), true);
        owned.space.drop('2');
        assert.equal(owned.space.with('1', body=>body[8191], { wait: true }), 3, 'read in place');
        assert.equal(owned.held(), 1);
        assert.equal(run.under(owned.prefix).bodies, 1);
        assert.deepEqual(await owned.close(), { bodies: 1, bytes: 8192, waiting: 0 });
        assert.equal(await owned.ask('3', 8192), false, 'nothing granted once it went');
        assert.equal(owned.put('3', new Uint8Array(8192)), false);
        assert.equal(run.under(owned.prefix).bodies, 0, 'nothing left under its names');
        assert.deepEqual(tails, []);
        const alone = await createCacheModule().create({ reader: run.reader });
        assert.equal(alone.owner('texels'), null, 'none where the run serves no names');
    }
    finally
    {
        run.close();
    }
});

test('memory an owner in a worker holds is the run\'s cache, written there and read in place on '
    + 'the keeper\'s thread, counted under the owner and in the budget, and taken back when it '
    + 'goes', { timeout: 60_000 }, async()=>{
    /** @type {import('./module.js').OwnerTail[]} */
    const tails = [];
    const run = await openRunCache({ onTail: tail=>tails.push(tail) });
    const served = run.serve('resources');
    const joined = run.join(()=>{});
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.url).then(async({ channelSpace })=>{
            const owner = channelSpace(workerData.joined, workerData.served);
            const next = ()=>new Promise(resolve=>parentPort.once('message', resolve));
            const a = owner.space.hold('a', 100_000);
            const b = owner.space.hold('b', 5000);
            a.bytes.fill(7);
            b.bytes.fill(8);
            parentPort.postMessage({ a: a.bytes, b: b.bytes, holding: owner.holding() });
            await next();
            // What the keeper's thread wrote, read here in place.
            const seen = [a.bytes[0], a.bytes[99_999]];
            b.release();
            b.release();
            parentPort.postMessage({ seen, holding: owner.holding() });
            await next();
            const released = await owner.close();
            parentPort.postMessage({ released, after: owner.space.hold('c', 10) });
        });`, { eval: true, workerData: { url: new URL('./module.js', import.meta.url).href,
        served, joined: { shared: joined.shared, segments: joined.segments } } });
    const next = ()=>/** @type {Promise<any>} */ (new Promise((resolve, reject)=>{
        worker.once('message', resolve);
        worker.once('error', reject);
    }));
    try
    {
        const first = await next();
        assert.ok(first.a.buffer instanceof SharedArrayBuffer, 'the cache\'s own memory');
        assert.equal(first.a.length, 100_000);
        assert.ok(first.a.every((/** @type {number} */ byte)=>byte === 7), 'read in place here');
        assert.ok(first.b.every((/** @type {number} */ byte)=>byte === 8));
        assert.deepEqual(first.holding, { holds: 2, bytes: 105_000 });
        assert.deepEqual(run.under(served.prefix),
            { bodies: 2, bytes: 105_000, hotBytes: 105_000, placedBytes: 131_072 + 8192 },
            'counted under the owner, in blocks of the budget');
        assert.ok(run.figures().placedBytes >= 131_072 + 8192, 'in the cache\'s budget');
        first.a[0] = 1;
        first.a[99_999] = 2;
        worker.postMessage('read');
        const second = await next();
        assert.deepEqual(second.seen, [1, 2], 'the worker reads what this thread wrote');
        assert.deepEqual(second.holding, { holds: 1, bytes: 100_000 });
        assert.deepEqual(run.under(served.prefix),
            { bodies: 1, bytes: 100_000, hotBytes: 100_000, placedBytes: 131_072 },
            'one let go of, its room the keeper\'s');
        worker.postMessage('go');
        const third = await next();
        assert.deepEqual(third.released, { bodies: 1, bytes: 100_000, waiting: 0 },
            'what it still held taken back as it went, nothing left waiting');
        assert.equal(third.after, null, 'nothing held once it went');
        assert.deepEqual(run.under(served.prefix),
            { bodies: 0, bytes: 0, hotBytes: 0, placedBytes: 0 }, 'no tail under its names');
        assert.deepEqual(tails, []);
    }
    finally
    {
        await worker.terminate();
        joined.leave();
        run.close();
    }
});

test('memory an owner on the keeper\'s own thread holds goes through its reader, under the same '
    + 'contract', { timeout: 60_000 }, async()=>{
    /** @type {import('./module.js').OwnerTail[]} */
    const tails = [];
    const run = await openRunCache({ onTail: tail=>tails.push(tail) });
    try
    {
        const api = await createCacheModule().create({ reader: run.reader, join: run.join,
            serve: run.serve, own: run.own });
        const owned = /** @type {NonNullable<ReturnType<typeof api.owner>>} */ (
            api.owner('resources'));
        const held = owned.space.hold?.('a', 10_000) ?? null;
        assert.ok(held && held.bytes.buffer instanceof SharedArrayBuffer);
        held.bytes.fill(3);
        assert.deepEqual(owned.holding(), { holds: 1, bytes: 10_000 });
        assert.equal(run.under(owned.prefix).hotBytes, 10_000);
        owned.space.hold?.('b', 20_000);
        held.release();
        assert.deepEqual(owned.holding(), { holds: 1, bytes: 20_000 });
        assert.deepEqual(await owned.close(), { bodies: 1, bytes: 20_000, waiting: 0 });
        assert.equal(owned.space.hold?.('c', 10), null, 'nothing held once it went');
        assert.equal(run.under(owned.prefix).bodies, 0);
        assert.deepEqual(tails, []);
    }
    finally
    {
        run.close();
    }
});

test('a worker owner\'s scratches and holds are held under its names, one past a segment too, '
    + 'and nothing is left when it goes', { timeout: 60_000 }, async()=>{
    /** @type {import('./module.js').OwnerTail[]} */
    const tails = [];
    const run = await openRunCache({ onTail: tail=>tails.push(tail) });
    const served = run.serve('resources');
    const joined = run.join(()=>{});
    try
    {
        const said = await inWorker(`
            const { createScratches } = await import(workerData.scratch);
            const owner = channelSpace(joined, workerData.served);
            const rooms = createScratches(owner.space.hold);
            const blit = rooms.scratch('blit');
            blit.bytes(1000).fill(1);
            const grown = blit.bytes(300_000);
            const resource = rooms.hold('resource', 50_000);
            // Past a segment of the cache: a segment of its own, which the
            // worker heard of before it asked.
            const large = rooms.hold('large', 20 << 20);
            const during = { figures: rooms.figures(), holding: owner.holding(),
                shared: [grown.buffer instanceof SharedArrayBuffer,
                    resource.bytes.buffer instanceof SharedArrayBuffer,
                    large.bytes.buffer instanceof SharedArrayBuffer],
                zero: resource.bytes.every(byte=>byte === 0) };
            rooms.releaseAll();
            post({ during, after: owner.holding(), released: await owner.close() });`,
        { joined: { shared: joined.shared, segments: joined.segments }, served,
            scratch: new URL('./scratch.js', import.meta.url).href });
        assert.deepEqual(said.during.shared, [true, true, true]);
        assert.equal(said.during.zero, true);
        const heldBytes = 512 * 1024 + 13 * 4096 + (20 << 20);
        assert.deepEqual(said.during.figures, { scratches: 1, holds: 2, held: 3, heldBytes,
            plain: 0, plainBytes: 0, grows: 2, plainGrows: 0 });
        assert.deepEqual(said.during.holding, { holds: 3, bytes: heldBytes },
            'the owner counts what its scratches hold');
        assert.deepEqual(said.after, { holds: 0, bytes: 0 });
        assert.deepEqual(said.released, { bodies: 0, bytes: 0, waiting: 0 });
        assert.deepEqual(run.under(served.prefix),
            { bodies: 0, bytes: 0, hotBytes: 0, placedBytes: 0 });
        assert.deepEqual(tails, []);
    }
    finally
    {
        joined.leave();
        run.close();
    }
});
