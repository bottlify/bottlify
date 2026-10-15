/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMED_PASSES, createGpuTimer } from './gputime.js';

/**
 * A device whose resolved timestamps are what `stamps` says, in nanoseconds.
 *
 * @param {bigint[]} stamps @param {boolean} [stamping]
 */
function device(stamps, stamping = true){
    /** @type {any[]} */
    const calls = [];
    return {
        calls,
        features: new Set(stamping ? ['timestamp-query'] : []),
        createQuerySet: (/** @type {any} */ descriptor)=>({ descriptor, destroy(){} }),
        createBuffer: (/** @type {any} */ descriptor)=>({
            descriptor,
            mapAsync: ()=>Promise.resolve(),
            getMappedRange: ()=>BigInt64Array.from(stamps).buffer,
            unmap(){},
            destroy(){},
        }),
        encoder: {
            resolveQuerySet: (/** @type {any[]} */ ...args)=>calls.push(['resolve', ...args]),
            copyBufferToBuffer: (/** @type {any[]} */ ...args)=>calls.push(['copy', ...args]),
        },
    };
}

test('each pass of a frame is timed by the GPU and summed by the surface it drew into', async()=>{
    const gpu = device([1000000n, 3000000n, 3000000n, 3500000n]);
    const timer = createGpuTimer({ device: gpu });
    const frame = /** @type {any} */ (timer.frame());
    const first = frame.pass('scene 800x600');
    const second = frame.pass('shadow 128x128');
    assert.equal(first.beginningOfPassWriteIndex, 0);
    assert.equal(second.endOfPassWriteIndex, 3);
    assert.equal(first.querySet, second.querySet, 'one set a frame');
    frame.resolve(gpu.encoder);
    assert.deepEqual(gpu.calls.map(call=>call[0]), ['resolve', 'copy']);
    frame.settle();
    await new Promise(resolve=>setTimeout(resolve, 0));
    const stats = /** @type {any} */ (timer.stats());
    assert.equal(stats.frames, 1);
    assert.equal(stats.gpuMs, 2.5);
    assert.deepEqual(stats.byLabel, [{ label: 'scene 800x600', passes: 1, ms: 2 },
        { label: 'shadow 128x128', passes: 1, ms: 0.5 }]);
});

test('a device that cannot stamp says so, and times nothing', ()=>{
    const timer = createGpuTimer({ device: device([], false) });
    assert.equal(timer.frame(), null);
    assert.deepEqual(timer.stats(), { available: false });
    assert.equal(createGpuTimer({ device: device([]), enabled: false }).available, false);
});

test('a frame past the slots times its first passes and leaves the rest untimed', ()=>{
    const timer = createGpuTimer({ device: device([]) });
    const frame = /** @type {any} */ (timer.frame());
    for (let pass = 0; pass < TIMED_PASSES; pass++)
    {
        assert.ok(frame.pass(`p${pass}`));
    }
    assert.equal(frame.pass('one too many'), undefined);
});

test('a pass is timed from the end of the one before, and one with no time is counted apart',
    async()=>{
        // The first pass's beginning was left unwritten, as some drivers leave
        // it; the third ends before the second did.
        const gpu = device([0n, 5000000n, 1n, 8000000n, 2n, 6000000n]);
        const timer = createGpuTimer({ device: gpu });
        const frame = /** @type {any} */ (timer.frame());
        frame.pass('unwritten');
        frame.pass('fine');
        frame.pass('backwards');
        frame.resolve(gpu.encoder);
        frame.settle();
        await new Promise(resolve=>setTimeout(resolve, 0));
        const stats = /** @type {any} */ (timer.stats());
        assert.equal(stats.unpaired, 2);
        assert.equal(stats.gpuMs, 3, 'from the end of the first to the end of the second');
        assert.deepEqual(stats.byLabel.map((/** @type {any} */ entry)=>entry.label), ['fine']);
        assert.deepEqual(stats.lastUnpaired, ['backwards', '8000000', '6000000']);
    });
