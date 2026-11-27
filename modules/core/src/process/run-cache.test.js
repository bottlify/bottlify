/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLinkMemory, createReader, linkCarrier, openKeeperClient, openLink }
    from '@bottlify/cellar';
import { CACHE_CALLS, openRunCache } from './run-cache.js';
import { relayedJoin } from '../layers/cache/module.js';

/**
 * The remote keeper a process in a worker of its own calls (`across`), both
 * sides of its link on this thread: a call is answered in place.
 *
 * @param {import('./run-cache.js').RunCache} run @param {ReturnType<import('./run-cache.js').RunCache['across']>} [across]
 */
const acrossOf = (run, across = run.across())=>{
    const { a, b } = createLinkMemory({ capacity: 1 << 16, ...CACHE_CALLS });
    openLink(a, {}, { words: across.words });
    return openKeeperClient(linkCarrier(openLink(b)));
};

/** A reader over what `join` handed a thread, told what the keeper says after. */
const joinedReader = (/** @type {{ join: (post: (message: any) => void) => any }} */ run)=>{
    /** @type {any} */
    let reader = null;
    const joined = run.join(message=>reader?.adopt(message));
    reader = createReader({ shared: joined.shared, segments: joined.segments,
        keeper: { reserve: ()=>null, raise: ()=>false, raiseLater: ()=>{}, drop: ()=>{} } });
    return reader;
};

/** Enough names that the keeper's index makes its table larger. */
const NAMES = 3000;

test('a thread joined after the index grew finds every name, the ones put before and after',
    async()=>{
        const run = await openRunCache({ budget: 64 << 20 });
        try
        {
            for (let n = 0; n < NAMES; n++)
            {
                assert.ok(run.reader.put(`n/${n}`, new Uint8Array([n & 0xff])));
            }
            const late = joinedReader(run);
            run.reader.put('n/after', new Uint8Array([7]));
            for (const n of [0, NAMES >> 1, NAMES - 1])
            {
                assert.equal(late.with(`n/${n}`, (/** @type {Uint8Array} */ body)=>body[0]), n & 0xff,
                    `name ${n}`);
            }
            assert.equal(late.with('n/after', (/** @type {Uint8Array} */ body)=>body[0]), 7);

            // The same through a thread that passes the run's cache on (a process in a
            // worker of its own, to its executors): it was joined before the growth.
            const relay = relayedJoin(run.join(message=>relay.adopt(message)));
            for (let n = 0; n < NAMES; n++)
            {
                run.reader.put(`m/${n}`, new Uint8Array([n & 0xff]));
            }
            const relayed = joinedReader(relay);
            assert.equal(relayed.with(`m/${NAMES - 1}`, (/** @type {Uint8Array} */ body)=>body[0]),
                (NAMES - 1) & 0xff);
        }
        finally
        {
            run.close();
        }
    });

test('the figures weigh each space on its own: its bodies, those in memory, the blocks they take',
    async()=>{
        const run = await openRunCache({ budget: 64 << 20 });
        try
        {
            assert.ok(run.reader.put('reads/a', new Uint8Array(256)));
            assert.ok(run.reader.put('reads/b', new Uint8Array(4096)));
            // Through the handlers a process in a worker of its own calls.
            const place = acrossOf(run).keeper.reserve('translations/m', 5000,
                { onlyCopy: false, known: 1 });
            assert.ok(place !== null);
            const standing = {
                reads: { bodies: 2, bytes: 4352, hotBytes: 4352, placedBytes: 2 * 4096 },
                translations: { bodies: 1, bytes: 5000, hotBytes: 5000, placedBytes: 8192 },
            };
            const figures = run.figures();
            assert.deepEqual(figures.spaces, standing);
            assert.deepEqual(figures.peakSpaces, standing, 'the most placed is now');
            assert.equal(figures.peakRoundingBytes, 2 * 4096 + 8192 - 4352 - 5000);
            // Let go of: the spaces are empty now, the peak keeps them as they stood.
            run.reader.drop('reads/a');
            run.reader.drop('reads/b');
            const after = run.figures();
            assert.equal(after.spaces.reads.placedBytes, 0);
            assert.deepEqual(after.peakSpaces, standing);
        }
        finally
        {
            run.close();
        }
    });

test('with a run\'s folder, a body that is the only copy for the run goes to its disk for room '
    + 'and comes back; one that can be made again goes away, and nothing stays past the run',
async()=>{
    const { fakeOpfs } = await import('../layers/filesystem/internal/opfs.fixture.js');
    const { openRunFolder } = await import('../layers/filesystem/internal/run-folder.js');
    const { cacheSpace } = await import('../layers/cache/module.js');
    const opfs = fakeOpfs();
    const runFolder = await openRunFolder({ root: opfs.root });
    assert.ok(runFolder);
    // One segment: what is put past it makes room by the least recently used.
    const run = await openRunCache({ budget: 16 << 20, runFolder });
    // The keeper's first pack opens behind a promise, as every file on OPFS.
    await new Promise(resolve=>setTimeout(resolve, 0));
    const MIB = 1 << 20;
    // Bodies of a quarter of it, four to the segment.
    const texels = new Uint8Array(4 * MIB).map((_, i)=>i * 7);
    assert.ok(run.reader.put('texels/1', texels, { onlyCopy: true, disk: 'run' }));
    const reads = cacheSpace(run.reader, 'reads');
    for (const key of ['a', 'b', 'c'])
    {
        assert.ok(reads.put(key, new Uint8Array(4 * MIB)));
    }
    assert.ok(reads.put('d', new Uint8Array(4 * MIB)), 'room made');
    assert.ok(reads.put('e', new Uint8Array(4 * MIB)), 'and again');
    const figures = run.figures();
    assert.equal(figures.written, 1, 'the texels written, the reads not');
    assert.ok(figures.gone >= 1, 'a read that can be made again went away');
    assert.equal(run.reader.look('texels/1'), 'cold');
    assert.equal(run.reader.with('texels/1', (/** @type {Uint8Array} */ body)=>
        body.every((byte, i)=>byte === texels[i]), { wait: true }), true, 'back as it was');
    const [name] = opfs.names('bottlify-runs');
    assert.ok(opfs.names(`bottlify-runs/${name}/cache`).some(file=>file.startsWith('pack')));
    run.close();
    await new Promise(resolve=>setTimeout(resolve, 0));
    assert.deepEqual(opfs.names('bottlify-runs'), [], 'the run\'s folder goes with it');
});

test('a run\'s folder whose cache does not open is said, and its figures say why', async()=>{
    /** @type {string[]} */
    const lost = [];
    let released = 0;
    const runFolder = {
        folder: { getDirectoryHandle: async()=>{
            throw new DOMException('the origin refused it', 'SecurityError');
        } },
        use: ()=>()=>{
            released++;
        },
    };
    const run = await openRunCache({ budget: 16 << 20, runFolder,
        onLoss: detail=>lost.push(detail) });
    try
    {
        assert.equal(lost.length, 1);
        assert.match(lost[0], /the origin refused it/);
        assert.equal(run.figures().diskLost, 'the origin refused it');
        assert.equal(released, 1, 'the folder let go of at once: nothing of the cache is in it');
    }
    finally
    {
        run.close();
    }
    assert.equal(released, 1, 'and not again with the run');
});

test('a run with no folder has no disk and nothing to say of it', async()=>{
    const run = await openRunCache({ budget: 16 << 20, onLoss: ()=>assert.fail('said') });
    assert.equal(run.figures().diskLost, null);
    run.close();
});

test('the run\'s figures carry its budget and the most it held at once, after bodies went',
    async()=>{
        const MIB = 1 << 20;
        const run = await openRunCache({ budget: 48 * MIB });
        try
        {
            const before = run.figures();
            assert.equal(before.budget, 48 * MIB);
            assert.equal(before.peakPlacedBytes, 0, 'nothing placed yet');
            for (const name of ['a', 'b', 'c'])
            {
                assert.ok(run.reader.put(name, new Uint8Array(10 * MIB)));
            }
            const full = run.figures();
            assert.ok(full.placedBytes >= 30 * MIB, `placed ${full.placedBytes}`);
            assert.equal(full.peakSegmentBytes, full.segmentBytes, 'segments counted as made');
            for (const name of ['a', 'b', 'c'])
            {
                run.reader.drop(name);
            }
            const after = run.figures();
            assert.ok(after.placedBytes < full.placedBytes, `placed after ${after.placedBytes}`);
            assert.equal(after.peakPlacedBytes, full.placedBytes, 'the most placed stays');
            assert.ok(after.peakSegmentBytes >= full.segmentBytes);
        }
        finally
        {
            run.close();
        }
    });

/**
 * A process in a worker of its own, as `process.worker.js` makes its cache:
 * a reader and owner names across its link. It holds a scratch, a hold, an
 * in-thread root's texels and a graphics root's channel (here, in its own
 * thread, as a worker of the process's would), says what it holds, and on
 * the word lets go of all of it as a process that goes does.
 */
const PROCESS = `
    const { workerData, parentPort } = require('node:worker_threads');
    const next = ()=>new Promise(resolve=>parentPort.once('message', resolve));
    Promise.all([import(workerData.link), import(workerData.runCache), import(workerData.cache)])
        .then(async([{ openLink }, { remoteCache }, { createCacheModule, channelSpace }])=>{
            const link = openLink(workerData.end, {});
            link.serve();
            const owners = remoteCache(workerData.joined, link,
                message=>parentPort.postMessage(message));
            const module = createCacheModule();
            const api = await module.create({ reader: owners.reader, own: owners.own,
                serve: owners.serve });
            const room = api.scratch('blit').bytes(100_000).fill(5);
            const resource = api.hold('resource', 50_000);
            resource.bytes.fill(6);
            const texels = api.owner('texels');
            const put = texels.put('a', new Uint8Array(8192).fill(7));
            const served = api.serve('texels');
            const root = channelSpace(workerData.joined, served);
            const granted = await root.ask('b', 4096);
            root.put('b', new Uint8Array(4096).fill(8));
            parentPort.postMessage({ type: 'held', room, resource: resource.bytes, put, granted,
                texels: texels.prefix, root: served.prefix });
            await next();
            const released = { texels: await texels.close(), root: await root.close() };
            await module.dispose();
            parentPort.postMessage({ type: 'gone', released });
        });`;

test('a process in a worker of its own is served names of its own: its scratches, holds and '
    + 'roots are the run\'s, counted under each owner, read in place, and gone with it, no tail',
{ timeout: 60_000 }, async()=>{
    const { Worker } = await import('node:worker_threads');
    /** @type {import('../layers/cache/module.js').OwnerTail[]} */
    const tails = [];
    const run = await openRunCache({ onTail: tail=>tails.push(tail) });
    const across = run.across();
    const { a, b } = createLinkMemory(CACHE_CALLS);
    const system = openLink(a, {}, { words: across.words });
    const serving = system.serve();
    const joined = run.join(()=>{});
    const worker = new Worker(PROCESS, { eval: true, workerData: {
        link: import.meta.resolve('@bottlify/cellar'),
        runCache: new URL('./run-cache.js', import.meta.url).href,
        cache: new URL('../layers/cache/module.js', import.meta.url).href,
        end: b, joined: { shared: joined.shared, segments: joined.segments } } });
    /** @type {any[]} */
    const said = [];
    /** @type {(() => void) | null} */
    let heard = null;
    worker.on('message', message=>{
        if (message.type === 'cache-serve')
        {
            across.served(message.prefix, message.channel);
            return;
        }
        said.push(message);
        heard?.();
    });
    const nextSaid = async()=>{
        while (said.length === 0)
        {
            await new Promise((resolve, reject)=>{
                heard = ()=>resolve(undefined);
                worker.once('error', reject);
            });
        }
        return said.shift();
    };
    try
    {
        const held = await nextSaid();
        assert.equal(held.type, 'held');
        assert.equal(held.put, true);
        assert.equal(held.granted, true);
        assert.ok(held.room.buffer instanceof SharedArrayBuffer, 'the scratch is the cache\'s');
        assert.ok(held.resource.buffer instanceof SharedArrayBuffer, 'so is the hold');
        assert.ok(held.room.every((/** @type {number} */ byte)=>byte === 5), 'read in place here');
        assert.ok(held.resource.every((/** @type {number} */ byte)=>byte === 6));
        const out = run.figures().ownersOut;
        assert.deepEqual(Object.keys(out), ['scratch/1/', held.texels],
            'its scratches and its in-thread root, numbered by the run');
        assert.deepEqual(out['scratch/1/'], { bodies: 2, bytes: 128 * 1024 + 13 * 4096,
            hotBytes: 128 * 1024 + 13 * 4096, placedBytes: 128 * 1024 + 64 * 1024 },
        'the scratch and the hold (its pages), each in a block of the budget');
        assert.equal(out[held.texels].bodies, 1);
        assert.equal(run.reader.with(`${held.texels}a`, body=>body[8191], { wait: true }), 7,
            'its root\'s texels read in place on the keeper\'s thread');
        assert.notEqual(held.root, held.texels);
        assert.equal(run.under(held.root).bodies, 1, 'the root its channel serves holds there');
        assert.equal(run.figures().served, 1);

        worker.postMessage('go');
        const gone = await nextSaid();
        assert.deepEqual(gone.released, { texels: { bodies: 1, bytes: 8192, waiting: 0 },
            root: { bodies: 1, bytes: 4096, waiting: 0 } });
        for (let turns = 0; turns < 100 && run.figures().served > 0; turns++)
        {
            await new Promise(resolve=>setTimeout(resolve, 0));
        }
        across.end();
        assert.deepEqual(run.figures().ownersOut, {}, 'nothing of it out');
        assert.equal(run.figures().served, 0);
        for (const kind of ['scratch/', 'texels/'])
        {
            assert.equal(run.under(kind).bodies, 0, `nothing left under ${kind}`);
        }
        assert.deepEqual(tails, []);
    }
    finally
    {
        await worker.terminate();
        system.close();
        await serving;
        joined.leave();
        run.close();
    }
});

test('a process in a worker that goes without letting go of its names leaves a tail, counted, '
    + 'and nothing under them; a channel that comes after it went is closed unserved', async()=>{
    const { createChannel, openClient } = await import('@bottlify/cellar');
    /** @type {import('../layers/cache/module.js').OwnerTail[]} */
    const tails = [];
    const run = await openRunCache({ onTail: tail=>tails.push(tail) });
    try
    {
        const across = run.across();
        const asking = acrossOf(run, across);
        const prefix = /** @type {string} */ (asking.own('scratch'));
        const late = /** @type {string} */ (asking.own('texels'));
        assert.ok(run.reader.hold(`${prefix}x`, 4096));
        assert.equal(asking.release('scratch/99/', 0), null, 'not its own');
        across.end();
        assert.deepEqual(tails.map(tail=>[tail.prefix, tail.bodies, tail.why]),
            [[prefix, 1, 'unreleased']]);
        assert.equal(run.under(prefix).bodies, 0, 'taken back as it went');
        assert.deepEqual(run.figures().ownersOut, {});
        assert.equal(run.figures().ownerTails.owners, 1);
        const channel = createChannel();
        across.served(late, channel);
        assert.equal(openClient(channel).closed(), true, 'nothing waits on it');
        assert.equal(run.figures().served, 0);
    }
    finally
    {
        run.close();
    }
});

test('the run\'s own scratches (its presenter\'s) are held under names of its own, let go of '
    + 'with the run', async()=>{
    /** @type {import('../layers/cache/module.js').OwnerTail[]} */
    const tails = [];
    const run = await openRunCache({ onTail: tail=>tails.push(tail) });
    const room = run.scratch('present/converted').bytes(10_000);
    assert.ok(room.buffer instanceof SharedArrayBuffer);
    const [prefix] = Object.keys(run.figures().ownersOut);
    assert.match(prefix, /^scratch\/\d+\/$/);
    assert.equal(run.under(prefix).hotBytes, 16 * 1024);
    run.close();
    assert.deepEqual(tails, [], 'no tail: the run took it with it');
});
