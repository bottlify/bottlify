/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What createApp wires that the module graph deliberately does not express.
 * Only the parts that can be exercised without an emulator are here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupBlocks, inParallel, placePatches, resolveLibraryPath, retryingFetch }
    from './app.js';
import { createEvents } from './events.js';

/** Fast enough that a test does not pay for the backoff it is checking. */
const QUICK = { attempts: 4, baseDelayMs: 1, maxDelayMs: 4 };

/** Records what the fetch reported, in order. */
function recording(){
    const events = createEvents();
    /** @type {any[]} */
    const seen = [];
    events.on('bundle-retry', (/** @type {any} */ e)=>{
        seen.push(['retry', e.attempt, e.reason]);
    });
    events.on('bundle-unavailable', (/** @type {any} */ e)=>{
        seen.push(['unavailable', e.attempts, e.reason]);
    });
    return { events, seen };
}

test('a fetch that fails and then works is not a failed fetch', async()=>{
    const { events, seen } = recording();
    let calls = 0;
    const fetch = retryingFetch({
        events,
        retry: QUICK,
        fetch: async()=>{
            calls++;
            if (calls < 3)
            {
                throw new Error('connection reset');
            }
            return new Uint8Array(8).fill(0x41);
        },
    });

    const bytes = await fetch(1024, 8);
    assert.equal(bytes.length, 8);
    assert.equal(calls, 3);
    assert.deepEqual(seen, [
        ['retry', 1, 'connection reset'],
        ['retry', 2, 'connection reset'],
    ], 'each attempt that failed was reported, and the one that worked was not');
});

test('a range that comes back short is a glitch, not an answer', async()=>{
    // The case worth having a test for: a proxy that closes early answers with
    // fewer bytes and no error, so nothing but the length says anything is
    // wrong -- and those bytes would otherwise land in a guest's file.
    const { events } = recording();
    let calls = 0;
    const fetch = retryingFetch({
        events,
        retry: QUICK,
        fetch: async(/** @type {number} */ offset, /** @type {number} */ length)=>{
            calls++;
            return new Uint8Array(calls < 2 ? length - 1 : length);
        },
    });

    assert.equal((await fetch(0, 16)).length, 16);
    assert.equal(calls, 2, 'the truncated answer was refused and asked for again');
});

test('bytes that arrive damaged are asked for again, not handed on', async()=>{
    // The checksum is checked inside the retry rather than by the caller,
    // because damage is exactly what a retry is for. Checked outside, a bad
    // block could only become an error -- and a bad block that got through
    // would go into the guest's files and stay in the cache after a reload.
    const { events, seen } = recording();
    let calls = 0;
    const fetch = retryingFetch({
        events,
        retry: QUICK,
        fetch: async()=>{
            calls++;
            return new Uint8Array(4).fill(calls < 3 ? 0xff : 0x01);
        },
    });

    const bytes = await fetch(0, 4, sample=>sample[0] === 0x01 ? null : 'checksum');
    assert.deepEqual(bytes, new Uint8Array(4).fill(0x01));
    assert.equal(calls, 3);
    assert.deepEqual(seen.map(e=>e[2]), ['checksum', 'checksum']);
});

test('giving up says how many times it tried and why it stopped', async()=>{
    const { events, seen } = recording();
    const fetch = retryingFetch({
        events,
        retry: QUICK,
        fetch: async()=>{
            throw new Error('offline');
        },
    });

    await assert.rejects(()=>fetch(4096, 32), /did not arrive in 4 attempts: offline/);
    assert.deepEqual(seen.at(-1), ['unavailable', 4, 'offline'],
        'the last thing reported is the one a caller would act on');
    assert.equal(seen.filter(e=>e[0] === 'retry').length, 3,
        'three waits between four attempts, not four');
});

/**
 * Blocks laid out back to back from `at`, as the container lays them out.
 *
 * @param {number} at @param {number} count @param {number} [packed]
 */
function run(at, count, packed = 1000){
    return Array.from({ length: count }, (unused, step)=>({
        index: step, offset: at + step * packed, packed,
    }));
}

test('a run of blocks is one request, not one request each', ()=>{
    // The number that decides how long a large read takes, and the reason the
    // block size is not that number: blocks sit back to back in file order.
    const groups = groupBlocks(run(0, 400));

    assert.equal(groups.length, 1);
    assert.equal(groups[0].start, 0);
    assert.equal(groups[0].end, 400 * 1000);
    assert.equal(groups[0].blocks.length, 400);
});

test('a request does not grow past what a failed one would cost', ()=>{
    // Eight blocks at the default size are two requests. The cap has to fall
    // between blocks and never through one: half a block in a request could not
    // be checked against its checksum, since the checksum covers the whole.
    const groups = groupBlocks(run(0, 8, 1 << 22));

    assert.equal(groups.length, 2);
    assert.equal(groups[0].end - groups[0].start, 16 << 20);
    assert.equal(groups[0].blocks.length, 4, 'four whole blocks, not three and a half');
    assert.equal(groups[1].blocks.length, 4);
});

test('a small gap is downloaded again rather than paid for in a round trip', ()=>{
    const near = [
        { index: 0, offset: 0, packed: 1000 },
        { index: 2, offset: 1000 + (64 << 10), packed: 1000 },
    ];
    assert.equal(groupBlocks(near).length, 1, 'a 64 KiB gap is bridged');

    const far = [
        { index: 0, offset: 0, packed: 1000 },
        { index: 9, offset: 1000 + (512 << 10), packed: 1000 },
    ];
    assert.equal(groupBlocks(far).length, 2, 'half a mebibyte is not');
});

test('requests overlap, but only so many at a time', async()=>{
    let running = 0;
    let peak = 0;
    /** @type {number[]} */
    const done = [];

    await inParallel([1, 2, 3, 4, 5, 6, 7, 8], 3, async item=>{
        running++;
        peak = Math.max(peak, running);
        await new Promise(resolve=>setTimeout(resolve, 5));
        running--;
        done.push(item);
    });

    assert.equal(peak, 3, 'three at once, not eight and not one');
    assert.deepEqual(done.sort((a, b)=>a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});

const IMAGE = 'C:\\App\\Game.exe';

test('a bare library name is looked for beside the executable', ()=>{
    assert.equal(resolveLibraryPath('Storm.dll', IMAGE), 'C:\\App\\Storm.dll');
});

test('a name that already says where it is, is taken as given', ()=>{
    // Prefixing a qualified name again asks for C:\\App\\C:\\App\\..., which is not
    // there -- and the library is reported missing while sitting exactly where
    // it was asked for.
    assert.equal(resolveLibraryPath('C:\\App\\Storm.dll', IMAGE), 'C:\\App\\Storm.dll');
    assert.equal(resolveLibraryPath('D:\\Other\\Plug.dll', IMAGE), 'D:\\Other\\Plug.dll');
    assert.equal(resolveLibraryPath('C:/App/Storm.dll', IMAGE), 'C:/App/Storm.dll',
        'a program is free to use forward slashes, and Windows accepts them');
    assert.equal(resolveLibraryPath('\\App\\Storm.dll', IMAGE), '\\App\\Storm.dll',
        'root-relative is qualified too');
});

test('a relative name with a directory in it still searches beside the executable', ()=>{
    assert.equal(resolveLibraryPath('plugins\\Sound.dll', IMAGE),
        'C:\\App\\plugins\\Sound.dll');
});

test('a parent\'s deferred writes land only inside the child it wrote them for', ()=>{
    // A write that falls outside the image was addressing a mapping this
    // process does not have. Putting the bytes down anyway corrupts whatever
    // really is at that address, and the failure then looks like the child
    // being wrong rather than the patch being misplaced.
    /** @param {number} address @param {number} length */
    const at = (address, length)=>({ address, bytes: new Uint8Array(length) });

    const { applied, refused } = placePatches(
        [at(0x401000, 4), at(0x400000, 1), at(0x3fffff, 1), at(0x401ffe, 4), at(0x500000, 1)],
        0x400000, 0x2000);

    assert.deepEqual(applied.map(patch=>patch.address), [0x401000, 0x400000]);
    assert.deepEqual(refused.map(patch=>patch.address), [0x3fffff, 0x401ffe, 0x500000],
        'below the base, straddling the end, and past it');
});

test('nothing to patch is not a patch of nothing', ()=>{
    assert.deepEqual(placePatches([], 0x400000, 0x2000), { applied: [], refused: [] });
});
