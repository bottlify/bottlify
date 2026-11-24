/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cache's concurrency gate: threads read, write and drop names of one
 * pool at once while the keeper, short of room and with a clock that makes
 * everything idle at once, cools bodies to the disk, brings them back, drops
 * them and lets segments go. No thread may read a body that is not its name's
 * or that changes while it is inside (`concurrency.worker.fixture.js`); the
 * keeper's figures show the moves happened, so the gate cannot pass on a cache
 * that moved nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { channelMemory, serve } from './channel.fixture.js';
import { openKeeper } from './keeper.js';
import { memoryDisk } from './disk.fixture.js';

const KIB = 1024;
const THREADS = 4;

test('threads on one pool never read a body the keeper gave away', { timeout: 120_000 }, async()=>{
    /** @type {Worker[]} */
    const workers = [];
    const keeper = await openKeeper({
        budget: 512 * KIB, segmentBytes: 64 * KIB, disk: memoryDisk(),
        coldAfterMs: 5, goneAfterMs: 200, releaseAfterMs: 10,
        announce: message=>{
            for (const worker of workers)
            {
                worker.postMessage(message);
            }
        },
    });
    await new Promise(resolve=>setTimeout(resolve, 0));
    const sweeping = setInterval(()=>keeper.sweep(), 1);
    const links = [];
    const done = [];
    for (let t = 0; t < THREADS; t++)
    {
        const memory = channelMemory();
        links.push(serve(memory, {
            reserve: (name, length, options)=>keeper.reserve(name, length, options ?? {}),
            raise: name=>keeper.raise(name),
            drop: name=>keeper.drop(name),
        }));
        const worker = new Worker(new URL('./concurrency.worker.fixture.js', import.meta.url), {
            workerData: { channel: memory, shared: keeper.shared, segments: keeper.segmentBuffers(),
                seed: 0x9e3779b9 + t * 7919, operations: 6000, pool: 120 },
        });
        workers.push(worker);
        done.push(new Promise((resolve, reject)=>{
            worker.on('message', message=>{
                if (message.done)
                {
                    resolve(message);
                }
            });
            worker.on('error', reject);
        }));
    }
    /** @type {any[]} */
    let results;
    try
    {
        results = await Promise.all(done);
    }
    finally {
        clearInterval(sweeping);
        for (const link of links)
        {
            link.stop();
        }
        await Promise.all(workers.map(worker=>worker.terminate()));
    }

    const figures = keeper.figures();
    const failures = results.flatMap(result=>result.failures);
    assert.deepEqual(failures, [], `${results.reduce((sum, r)=>sum + r.failed, 0)} bad reads`);
    const hits = results.reduce((sum, result)=>sum + result.counts.hits, 0);
    const written = results.reduce((sum, result)=>sum + result.counts.written, 0);
    // The moves the gate is for happened, many times over.
    assert.ok(hits > 1000, `hits ${hits}`);
    assert.ok(written > 1000, `written ${written}`);
    assert.ok(figures.cooled > 100, `cooled ${figures.cooled}`);
    assert.ok(figures.raised > 10, `raised ${figures.raised}`);
    assert.ok(figures.segmentsLetGo > 0, `segments let go ${figures.segmentsLetGo}`);
    assert.ok(figures.segmentBytes <= 512 * KIB);
});
