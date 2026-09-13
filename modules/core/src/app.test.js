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
import {
    createMacrotask, groupBlocks, idleWait, inParallel, pacedYield, pageIsHidden, placePatches,
    withReadAhead, withWindow, refetchedIn,
    resolveLibraryPath, startDirectoryOf, libraryCandidates, timedWait, pagePacing,
    PAGE_YIELD_MS,
    retryingFetch,
    moduleKeyOf, relocatablePrefix, jumpBytes, clockCredit, emulatorArtifacts, heapSizeFor,
    spaceAbove,
    resourceLookup,
} from './app.js';
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

test('a miss reaches ahead through the blocks that follow it', ()=>{
    // A program reading an archive forward misses one block at a time, and each
    // miss was one round trip. Reaching past the last wanted block turns the
    // run into a few requests; what is already here is stepped over, not asked
    // for again.
    const layout = run(0, 40, 256 << 10);
    const bundle = { block: (/** @type {number} */ index)=>layout[index], blockCount: 40 };
    const resident = (/** @type {number} */ index)=>index === 6;

    const reached = withReadAhead(layout.slice(3, 5), bundle, resident, [9, 3], 1 << 20);

    assert.deepEqual(reached.map(block=>block.index), [3, 4, 5, 7, 8],
        'four blocks of reach past the last wanted one, minus the resident one');
    assert.ok(reached.slice(2).every(block=>block.ahead === true));
    assert.equal(reached[2].offset, 5 * (256 << 10), 'with the container offsets');
});

test('a lone miss becomes its aligned window, minus what is already here', ()=>{
    // A miss costs a round trip whatever its size, so the request is the
    // two-mebibyte window of the container the miss falls in: blocks 8..15 at
    // a quarter mebibyte each, wherever in the window the miss was.
    const layout = run(0, 40, 256 << 10);
    const bundle = { block: (/** @type {number} */ index)=>layout[index], blockCount: 40 };
    const resident = (/** @type {number} */ index)=>index === 9 || index === 14;

    const widened = withWindow([layout[11]], bundle, resident);

    assert.deepEqual(widened.map(block=>block.index), [8, 10, 11, 12, 13, 15]);
    assert.ok(widened.filter(block=>block.index !== 11).every(block=>block.ahead === true));
    assert.equal(groupBlocks(widened).length, 3,
        'a resident block wider than a bridged gap splits the request, and is not fetched again');
    assert.equal(groupBlocks(withWindow([layout[11]], bundle, ()=>false)).length, 1,
        'with nothing resident, the window is one request');
});

test('a window at the end is clipped, and two misses in one window are one request', ()=>{
    const layout = run(0, 11, 256 << 10);
    const bundle = { block: (/** @type {number} */ index)=>layout[index], blockCount: 11 };

    const clipped = withWindow([layout[9]], bundle, ()=>false);
    assert.deepEqual(clipped.map(block=>block.index), [8, 9, 10]);

    const pair = withWindow([layout[1], layout[6]], bundle, ()=>false);
    assert.deepEqual(pair.map(block=>block.index), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(groupBlocks(pair).length, 1);
});

test('the window does not begin before an unaligned first block', ()=>{
    // Blocks start after the container's header, so the first window is short
    // by that much and no block before index zero is asked for.
    const layout = run(4096, 4, 256 << 10);
    const bundle = { block: (/** @type {number} */ index)=>layout[index], blockCount: 4 };

    assert.deepEqual(withWindow([layout[2]], bundle, ()=>false).map(block=>block.index),
        [0, 1, 2, 3]);
    assert.deepEqual(withWindow([], bundle, ()=>false), []);
});

test('a request is charged for every resident block inside its span', ()=>{
    // Whether named or bridged over as a gap, a resident block inside a range
    // request is downloaded twice, and that is the number that has to be zero.
    const layout = run(0, 10, 1000);
    const bundle = { block: (/** @type {number} */ index)=>layout[index] };
    const group = { start: 2000, end: 7000, blocks: [layout[2], layout[4], layout[6]] };
    const resident = (/** @type {number} */ index)=>index === 3 || index === 6 || index === 8;

    assert.deepEqual(refetchedIn(group, bundle, resident), { blocks: 2, bytes: 2000 },
        'the bridged block and the named one, not the one outside the span');
    assert.deepEqual(refetchedIn({ blocks: [] }, bundle, resident), { blocks: 0, bytes: 0 });
});

test('read-ahead stops at the end of the bundle and adds nothing to nothing', ()=>{
    const layout = run(0, 4, 256 << 10);
    const bundle = { block: (/** @type {number} */ index)=>layout[index], blockCount: 4 };

    assert.deepEqual(withReadAhead([layout[2]], bundle, ()=>false, [2]).map(block=>block.index),
        [2, 3]);
    assert.deepEqual(withReadAhead([], bundle, ()=>false, [0]), []);
    assert.deepEqual(withReadAhead([layout[3]], bundle, ()=>false, [3]), [layout[3]],
        'the last block has nothing after it');
    assert.deepEqual(withReadAhead([layout[2]], bundle, ()=>false, [0, 7]), [layout[2]],
        'a miss that does not continue the last fetch is left alone');
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

test('a program starts in its own directory, and at the root the backslash stays', ()=>{
    // `C:` alone names the drive's current directory, not its root.
    assert.equal(startDirectoryOf(IMAGE), 'C:\\App');
    assert.equal(startDirectoryOf('C:\\Install\\Disc\\Setup.exe'), 'C:\\Install\\Disc');
    assert.equal(startDirectoryOf('C:\\app.exe'), 'C:\\');
    assert.equal(startDirectoryOf('C:/App/Game.exe'), 'C:/App');
});

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

test('a resource is addressed relative to the module its instance names', ()=>{
    // LockResource adds a resource's RVA to its module's base. Without the
    // base a program was handed the RVA as a pointer, which is inside the
    // first 64 KiB and mapped by nothing.
    const main = { base: 0x00400000, file: null };
    const library = { base: 0x10000000, file: null };
    const lookup = resourceLookup(()=>main, new Map([[library.base, library]]));

    assert.equal(lookup.moduleBase(0), 0x00400000, 'zero is the running program');
    assert.equal(lookup.moduleBase(0x10000000), 0x10000000);
    assert.equal(lookup.moduleBase(0x12345678), 0, 'an instance that names nothing');
    assert.equal(lookup.findResource(0x12345678, 5, 107), null);
    assert.equal(lookup.loadString(0, 1), null, 'a module without its file has no resources');
});

test('a bare name is looked for beside the executable, then where the system keeps its own', ()=>{
    // An installer puts a library it brought into the system directory and
    // loads it by bare name; a search that stops beside the executable
    // reports it missing the moment it was put in place.
    assert.deepEqual(libraryCandidates('cabinet.dll', IMAGE), [
        'C:\\App\\cabinet.dll', 'C:\\WINDOWS\\system32\\cabinet.dll',
        'C:\\WINDOWS\\cabinet.dll',
    ]);
    assert.deepEqual(libraryCandidates('C:\\Other\\x.dll', IMAGE), ['C:\\Other\\x.dll'],
        'a qualified name has one place');
    assert.deepEqual(libraryCandidates('plugins\\Sound.dll', IMAGE),
        ['C:\\App\\plugins\\Sound.dll'], 'and so does one with a directory in it');
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

test('the loop yields through a channel rather than a clamped timer', async()=>{
    // A browser clamps a zero timeout to four milliseconds, and to more once
    // they nest. Measured at eight milliseconds a yield and fifteen seconds in
    // one run -- larger than the emulation the yield was interrupting -- so a
    // yield that reaches for a timer where a channel exists is the single most
    // expensive thing the loop did.
    /** @type {unknown[][]} */
    const timers = [];
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = /** @type {any} */ ((/** @type {unknown[]} */ ...args)=>{
        timers.push(args);
        return realTimeout(...(/** @type {[any, any]} */ (args)));
    });
    try
    {
        const breathe = createMacrotask();
        await breathe();
        await breathe();
        assert.deepEqual(timers, [], 'no timer was involved');
        breathe.close();
    }
    finally
    {
        globalThis.setTimeout = realTimeout;
    }
});

test('a yield still works where there is no channel to use', async()=>{
    // The fallback is not decoration: this file runs in a worker, in a page and
    // under a test runner, and a yield that threw in one of them would stop the
    // machine rather than slow it.
    const channel = globalThis.MessageChannel;
    globalThis.MessageChannel = /** @type {any} */ (undefined);
    try
    {
        const breathe = createMacrotask();
        await breathe();
        breathe.close();
    }
    finally
    {
        globalThis.MessageChannel = channel;
    }
});

test('one channel serves every yield, not one channel per yield', async()=>{
    // A channel is a pair of ports the host has to keep. Making one per turn is
    // the cost this was meant to remove, so the factory opens exactly one.
    const real = globalThis.MessageChannel;
    let opened = 0;
    globalThis.MessageChannel = /** @type {any} */ (class extends real {
        constructor(){
            super();
            opened++;
        }
    });
    try
    {
        const breathe = createMacrotask();
        await breathe();
        await breathe();
        await breathe();
        assert.equal(opened, 1);
        breathe.close();
    }
    finally
    {
        globalThis.MessageChannel = real;
    }
});

test('closing a yield answers whoever was still waiting on it', async()=>{
    // A close that only drops the ports leaves the run loop awaiting a message
    // that can no longer arrive, which is a hang rather than a shutdown.
    const breathe = createMacrotask();
    const pending = breathe();
    breathe.close();
    await pending;
});

/** A machine with nothing outstanding at all. @param {any} [changed] */
const busy = (changed = {})=>(
    { fetching: 0, idlers: 0, suspended: 0, spun: 0, ...changed });

/** The wait such a machine takes, insisting that it takes one. @param {any} changed */
function waitOn(changed){
    const wait = idleWait(busy(changed));
    assert.ok(wait, 'something was outstanding, so the loop had to wait for it');
    return wait;
}

test('a machine with nothing outstanding does not wait at all', ()=>{
    assert.equal(idleWait(busy()), null);
    assert.equal(idleWait(busy({ spun: 1000 })), null,
        'having retired nothing is not on its own a reason to wait');
});

test('a machine still retiring instructions never waits on a timer', ()=>{
    // The measured cost of getting this wrong: a program in its own message
    // loop takes this branch on most turns while running perfectly well, and a
    // zero timeout is clamped to four milliseconds and more once they nest. It
    // was seventy-seven seconds of an eighty-nine second run -- larger than
    // every host call and all the emulation together.
    for (const spun of [0, 1, 2, 3])
    {
        assert.equal(waitOn({ suspended: 1, spun }).timer, false,
            `a turn that retired something ${spun} turns ago comes straight back`);
    }
});

test('a machine that has stopped retiring anything backs off to a timer', ()=>{
    // The other half, and it is not optional: spinning on the event loop while
    // only the host can make progress burns a processor to arrive no sooner,
    // and starves the very I/O being waited on. Measured: two million spins in
    // fifteen seconds retired a fifth of the instructions the timer did.
    assert.equal(waitOn({ suspended: 1, spun: 64 }).timer, true);
});

test('the wait is named for what is being waited on', ()=>{
    // One condition inside the loop, three costs. A range request is the
    // network, an empty message queue is the program having nothing to do, and
    // anything else is a host call that has not answered -- and a table that
    // calls all three the same thing cannot say which a run went into.
    assert.equal(waitOn({ fetching: 1, suspended: 1 }).phase, 'idle-fetch');
    assert.equal(waitOn({ idlers: 1 }).phase, 'idle-message');
    assert.equal(waitOn({ suspended: 1 }).phase, 'idle-host');
    assert.equal(waitOn({ fetching: 1, idlers: 3, suspended: 2 }).phase, 'idle-fetch',
        'a range request outranks the message queue: it is the one with a cost');
    assert.equal(waitOn({ suspended: 1, spun: 64 }).phase, 'idle-host-wait',
        'and the name says which of the two waits it took');
});

test('a run that nobody is looking at does not wait on a clamped timer', async()=>{
    // A browser clamps a hidden page's timers to about a second, which does not
    // slow a machine down politely -- it stops it. Measured switching tabs
    // during a cinematic: the loop fell from about two hundred and fifty turns
    // a second to one, and the film from twenty-four frames a second to four.
    // So while nothing is on screen the loop yields through a macrotask, which
    // nothing clamps, and goes back to a real timer the moment anyone looks.
    /** @type {string[]} */
    const took = [];
    const how = {
        macrotask: async()=>{
            took.push('macrotask');
        },
        timer: async()=>{
            took.push('timer');
        },
    };

    await timedWait({ hidden: ()=>false, ...how });
    await timedWait({ hidden: ()=>true, ...how });
    await timedWait({ hidden: ()=>false, ...how });

    assert.deepEqual(took, ['timer', 'macrotask', 'timer']);
});

test('the loop yields at once for something pending, otherwise on a clock it resets', async()=>{
    // A trip round the event loop is paid for whatever the browser runs in the
    // gap, and one per turn was the largest host phase of a run. So the loop
    // yields when the host may have something to deliver and otherwise only
    // once the interval is up -- counted from when the last trip ended, so a
    // trip the browser stretched does not earn another at once.
    let now = 0;
    let trips = 0;
    const yieldNow = pacedYield({
        macrotask: async()=>{
            trips++;
            now += 3;
        },
        now: ()=>now,
        intervalMs: 4,
    });
    const nothing = { suspended: 0, fetching: 0, idlers: 0, spun: 0 };
    assert.equal(yieldNow(nothing), null, 'nothing pending and the interval not up');
    now = 3;
    assert.equal(yieldNow(nothing), null);
    for (const pending of [{ suspended: 1 }, { fetching: 1 }, { idlers: 1 }, { spun: 1 }])
    {
        await yieldNow({ ...nothing, ...pending });
    }
    assert.equal(trips, 4, 'each kind of pending work yields at once');
    assert.equal(yieldNow(nothing), null, 'and a trip resets the clock');
    now += 4;
    await yieldNow(nothing);
    assert.equal(trips, 5, 'the interval is up');
    assert.equal(yieldNow(nothing), null, 'once');
    now += 3;
    assert.equal(yieldNow(nothing), null,
        'six since the trip began and three since it ended: the clock runs from the end');
    now += 1;
    assert.ok(yieldNow(nothing));

    let posted = false;
    const signalled = pacedYield({
        macrotask: async()=>{}, now: ()=>0, intervalMs: 4, signalled: ()=>posted,
    });
    assert.equal(signalled(nothing), null);
    posted = true;
    assert.ok(signalled(nothing), 'a message known to be waiting yields at once');
});

test("a page's pacing yields on its own clock and looks again on its timer or on a wake", async()=>{
    // The default the loop runs with when a host does not choose: it cannot
    // block, so a turn boundary is a macrotask when the page's interval is
    // up, and an idle machine looks again on a short timer -- unless a wake
    // comes first, or nothing has stopped yet, in which case it only
    // breathes.
    /** @type {string[]} */
    const took = [];
    let now = 0;
    const pacing = pagePacing({
        macrotask: async()=>{
            took.push('macrotask');
        },
        hidden: ()=>false,
        lookMs: 1,
        now: ()=>now,
    });
    const nothing = { suspended: 0, fetching: 0, idlers: 0, spun: 0 };
    assert.equal(pacing.yield(nothing), null, 'a turn straight after a yield goes on');
    now = PAGE_YIELD_MS;
    assert.ok(pacing.yield(nothing) instanceof Promise, "the page's bound is a few milliseconds");
    await pacing.wait({ timer: false, sleep: true, deadlineMs: 0, wakes: [] });
    assert.deepEqual(took, ['macrotask', 'macrotask']);

    let woke = false;
    await pacing.wait({ timer: true, sleep: true, deadlineMs: 1000,
        wakes: [Promise.resolve().then(()=>{
            woke = true;
        })] });
    assert.equal(woke, true, 'a wake ends the wait before the timer');
    const before = performance.now();
    await pacing.wait({ timer: true, sleep: true, deadlineMs: null, wakes: [] });
    assert.ok(performance.now() - before < 100, 'the look is short, whatever the deadline');
});

test('a run outside a page is never treated as hidden', ()=>{
    // There is no document in a worker or in Node, and answering "hidden" there
    // would put every run that is not in a tab on the spinning path.
    assert.equal(pageIsHidden(), false);
});

test('a module is known by its file name, however it was asked for', ()=>{
    // A loader that found the file itself asks with the full path; an import
    // descriptor asks with the bare name; a program asks either way and may
    // leave the extension off. All of them must find the one module.
    assert.equal(moduleKeyOf('Storm.dll'), 'storm');
    assert.equal(moduleKeyOf('C:\\App\\Storm.dll'), 'storm');
    assert.equal(moduleKeyOf('C:/App/STORM'), 'storm');
    assert.equal(moduleKeyOf('C:\\App\\redist\\miles\\Mp3dec.asi'), 'mp3dec.asi',
        'an extension that is not .dll is part of the name');
});

test("a routine's opening bytes move only when no relative branch is among them", ()=>{
    // A hook copies them to a trampoline; a branch encoded relative to where
    // it stood would then go somewhere else, silently.
    assert.equal(relocatablePrefix(Uint8Array.of(0x81, 0xec, 0xd0, 0x01, 0x00, 0x00), [6]), true,
        'sub esp, imm32');
    assert.equal(relocatablePrefix(Uint8Array.of(0x56, 0x57, 0x8b, 0xf9, 0x8b, 0xf2), [1, 1, 2, 2]),
        true, 'push, push, mov, mov');
    assert.equal(relocatablePrefix(Uint8Array.of(0xa1, 0x30, 0x50, 0x78, 0x04), [5]), true,
        'an absolute address whose bytes look like a short jump is an operand, not an opcode');
    assert.equal(relocatablePrefix(Uint8Array.of(0x55, 0x8b, 0xec, 0xe8, 0, 0, 0, 0), [1, 2, 5]),
        false, 'a call');
    assert.equal(relocatablePrefix(Uint8Array.of(0x85, 0xc0, 0x74, 0x05, 0x90), [2, 2, 1]), false,
        'a short jump');
    assert.equal(relocatablePrefix(Uint8Array.of(0x85, 0xc0, 0x0f, 0x84, 0, 0, 0, 0), [2, 6]),
        false, 'a near conditional jump');
    assert.equal(relocatablePrefix(Uint8Array.of(0x90, 0x90), [1, 1]), false,
        'too few for the jump in');
    assert.equal(relocatablePrefix(Uint8Array.of(0x90, 0x90, 0x90, 0x90, 0x90), [1, 1]), false,
        'the lengths must account for every byte');
});

test('a near jump is encoded relative to the instruction after it', ()=>{
    assert.deepEqual([...jumpBytes(0x1000, 0x1005)], [0xe9, 0, 0, 0, 0]);
    assert.deepEqual([...jumpBytes(0x1000, 0x2000)], [0xe9, 0xfb, 0x0f, 0, 0]);
    assert.deepEqual([...jumpBytes(0x2000, 0x1000)], [0xe9, 0xfb, 0xef, 0xff, 0xff],
        'backwards wraps');
});

test('the guest clock is credited with all the wall time between credits, capped', ()=>{
    // Credited only for the slices the guest ran, the clock fell behind the
    // wall by the loop's own share -- a tenth at a menu -- and a sound
    // buffer's cursor, paced by that clock, fell behind the device by the same
    // share, which the device filled with silence.
    let wall = 1000;
    /** @type {number[]} */
    const advanced = [];
    const credit = clockCredit(()=>wall, { advance: ms=>advanced.push(ms) }, 250);

    wall += 3;
    assert.equal(credit(), 3, 'a slice');
    wall += 4;
    assert.equal(credit(), 4, 'and the yield after it, not just the slice');
    assert.equal(credit(), 0, 'nothing twice');

    wall += 2000;
    assert.equal(credit(), 250, 'a stall is capped');
    wall += 2000;
    assert.equal(credit(Infinity), 2000, 'a wait that was asked for is credited in full');
    assert.deepEqual(advanced, [3, 4, 0, 250, 2000]);
});

test('the emulator is found beside the module unless the caller names it', ()=>{
    // A caller starting a bundle from code should not have to know where the
    // package keeps its emulator; naming a part overrides that part only.
    const here = 'https://example.test/lib/dist/core.js';
    const own = emulatorArtifacts(undefined, here);
    assert.match(own.moduleUrl, /libv86\.mjs$/);
    assert.match(String(own.wasmUrl), /v86\.wasm$/);
    assert.equal(own.wasmBytes, null);
    assert.equal(new URL(own.moduleUrl).origin, 'https://example.test', 'relative to the module');

    const theirs = emulatorArtifacts({ moduleUrl: 'https://cdn.test/v86.mjs' }, here);
    assert.equal(theirs.moduleUrl, 'https://cdn.test/v86.mjs');
    assert.match(String(theirs.wasmUrl), /v86\.wasm$/, 'the rest is still the package\'s own');

    const bytes = new ArrayBuffer(4);
    const given = emulatorArtifacts({ wasmBytes: bytes }, here);
    assert.equal(given.wasmBytes, bytes);
    assert.equal(given.wasmUrl, null, 'bytes in hand are not fetched again');
});

test('the space above the program moves up past an image too large for the fixed layout', ()=>{
    // A self-extracting installer maps its whole payload as a section: a
    // 346 MiB image at 0x400000 ends far above where the modules, the stack
    // pool and the heap used to be placed, and registering any of them there
    // was refused as an overlap before the first instruction ran.
    assert.deepEqual(spaceAbove(0x400000 + 0x100000),
        { moduleBase: 0x02000000, stackPoolBase: 0x08000000, heapBase: 0x0c000000 },
        'a small image leaves the layout where it was');
    assert.deepEqual(spaceAbove(0x400000 + 0x159e6000),
        { moduleBase: 0x15e00000, stackPoolBase: 0x1be00000, heapBase: 0x1fe00000 },
        'a large image pushes the whole layout above its end, on a megabyte');
});

test('the heap reaches the end of RAM unless a size was asked for', ()=>{
    // A fixed heap short of the end of RAM was what a program loading a level
    // ran into: it reported the machine's memory as exhausted while most of
    // it sat unused above the heap.
    assert.equal(heapSizeFor(1024 * 1024 * 1024), 1024 * 1024 * 1024 - 0x0c000000);
    assert.equal(heapSizeFor(1024 * 1024 * 1024, 0x14000000), 0x14000000, 'an asked-for size wins');
    assert.throws(()=>heapSizeFor(64 * 1024 * 1024), /less than the heap's base/);
});
