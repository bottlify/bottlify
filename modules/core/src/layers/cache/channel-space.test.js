/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createChannel, openKeeper, openServer } from '../../../vendor/cellar/cellar.js';
import { serveKeeper } from './module.js';

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
    });
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.url).then(async({ channelSpace })=>{
            const space = channelSpace(workerData.joined, workerData.channel, 'texels');
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
