/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReader } from '../../vendor/cellar/cellar.js';
import { openRunCache, relayedJoin } from './run-cache.js';

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
            const place = run.handlers.cache.reserve('translations/m', 5000, {});
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
    const texels = new Uint8Array(6 * MIB).map((_, i)=>i * 7);
    assert.ok(run.reader.put('texels/1', texels, { onlyCopy: true, disk: 'run' }));
    const reads = cacheSpace(run.reader, 'reads');
    assert.ok(reads.put('a', new Uint8Array(6 * MIB)));
    assert.ok(reads.put('b', new Uint8Array(6 * MIB)), 'room made');
    assert.ok(reads.put('c', new Uint8Array(6 * MIB)), 'and again');
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
