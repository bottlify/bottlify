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
    createMacrotask, groupBlocks, idleWait, inParallel, pacedYield, pageIsHidden,
    withReadAhead, withWindow, refetchedIn, windowFor, NEAR_ROUND_TRIP_MS, READ_AHEAD_BYTES,
    resolveLibraryPath, startDirectoryOf, libraryCandidates, withLibraryExtension, timedWait,
    pathDirectories,
    pagePacing,
    PAGE_YIELD_MS,
    PENDING_YIELD_MS,
    retryingFetch,
    moduleKeyOf, relocatablePrefix, jumpBytes, clockCredit, feedFilmSound,
    heapSizeFor,
    spaceAbove,
    placeMainStack,
    stackReserveOf,
    resourceLookup,
    createMissingImports,
    shippedLibraryReader,
    areaOf,
    createGuestView,
    createKernelGl,
    resolveOpenglEntry,
    describeEvent,
    answeredByEngine,
    mapShippedLibraries,
    placeLibrary,
    missingImportCall,
    compatibilityOf,
    createApp,
    versionResourceOf,
    runProcessId,
    withCpuSetup,
    withoutFaultingTailCalls,
    tailCallsFault,
    mobileOrSafari,
    automaticCores,
    translatorsBeside,
    allocateCleared,
    RESOURCE_ALIGNMENT,
    liveDumpOf,
    readWholeFile,
    WHOLE_READ_BYTES,
} from './app.js';
import { createHeapAllocator } from './layers/win32/kernel32/heap.js';
import { HEAP_POOLS } from './memory-zones.js';
import { writeBundle } from './bundle-node.js';
import { openBundle } from './layers/filesystem/internal/bundle/format.js';
import { createBundleSource } from './layers/filesystem/internal/bundle/source.js';
import { createBlockCache } from './layers/filesystem/internal/bundle/cache.js';
import { createEvents } from './events.js';
import { filesystemModule } from './layers/filesystem/module.js';
import { createMemoryStore } from './layers/filesystem/internal/memory-store.js';
import { planDependencies } from './layers/loader/internal/dependencies.js';
import { parsePe } from './layers/loader/internal/pe.js';
import { createAccessors } from './layers/memory/internal/accessors.js';
import { Access, RegionKind, createRegionMap } from './layers/memory/internal/regions.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { findResource, RT_STRING } from './layers/loader/internal/resources.js';
import { buildImage, buildResources } from './layers/loader/internal/resources.test.js';

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

test('a mapped module\'s strings are read where it lies, as its own code left them', ()=>{
    /** @param {string} text */
    const bundle = text=>Uint8Array.from([text.length, 0,
        ...[...text].flatMap(unit=>[unit.charCodeAt(0), 0]), ...new Array(30).fill(0)]);
    const { bytes, image } = buildImage(buildResources([{ type: RT_STRING,
        names: [{ name: 1, langs: [{ lang: 0x409, data: [...bundle('on disk!')] }] }] }]));
    const found = /** @type {{ rva: number, size: number }} */ (
        findResource(bytes, image, RT_STRING, 1));
    const library = { base: 0x10000000, file: bytes, image };
    const unpacked = bundle('unpacked');
    const lookup = resourceLookup(()=>null, new Map([[library.base, library]]), new Map(),
        (address, length)=>(address === library.base + found.rva
            ? unpacked.subarray(0, length) : new Uint8Array(length)));
    assert.equal(lookup.loadString(library.base, 0), 'unpacked', 'memory, not the file');
    assert.equal(lookup.loadString(library.base, 1), null, 'an empty slot is absent');
    assert.equal(resourceLookup(()=>null, new Map([[library.base, library]]))
        .loadString(library.base, 0), 'on disk!', 'with no memory to read, the file');
});

/**
 * A library whose only section holds one resource: RCDATA 1, four bytes, at
 * RVA 0x1058 and file offset 0x258 -- two different numbers, so a lookup that
 * mixes them up lands somewhere else.
 */
function resourceLibrary(){
    const bytes = new Uint8Array(0x260);
    const view = new DataView(bytes.buffer);
    const put = (/** @type {number} */ at, /** @type {number} */ value)=>
        view.setUint32(at, value, true);
    view.setUint16(0, 0x5a4d, true); //              "MZ"
    put(0x3c, 0x80);
    put(0x80, 0x4550); //                             "PE\0\0"
    view.setUint16(0x84, 0x014c, true); //           i386
    view.setUint16(0x86, 1, true); //                one section
    view.setUint16(0x94, 224, true);
    view.setUint16(0x96, 0x2102, true); //           a DLL
    view.setUint16(0x98, 0x010b, true); //           PE32
    put(0x98 + 28, 0x10000000); //                    ImageBase
    put(0x98 + 32, 0x1000); //                        SectionAlignment
    put(0x98 + 56, 0x2000); //                        SizeOfImage
    put(0x98 + 60, 0x200); //                         SizeOfHeaders
    put(0x98 + 92, 16);
    put(0x98 + 96 + 2 * 8, 0x1000); //                the resource directory
    put(0x98 + 96 + 2 * 8 + 4, 0x60);
    bytes.set([...'.rsrc'].map(ch=>ch.charCodeAt(0)), 0x178);
    put(0x178 + 8, 0x60);
    put(0x178 + 12, 0x1000);
    put(0x178 + 16, 0x60);
    put(0x178 + 20, 0x200);
    // Type 10, then name 1, then language 0x409, then the data entry.
    view.setUint16(0x200 + 14, 1, true);
    put(0x200 + 16, 10);
    put(0x200 + 20, 24 | 0x80000000);
    view.setUint16(0x200 + 24 + 14, 1, true);
    put(0x200 + 40, 1);
    put(0x200 + 44, 48 | 0x80000000);
    view.setUint16(0x200 + 48 + 14, 1, true);
    put(0x200 + 64, 0x409);
    put(0x200 + 68, 72);
    put(0x200 + 72, 0x1058);
    put(0x200 + 76, 4);
    bytes.set([0xca, 0xfe, 0xf0, 0x0d], 0x258);
    return bytes;
}

/**
 * A program whose only resource is its manifest (RT_MANIFEST 1, the one
 * CreateProcess reads) and whose PE header names an operating system version.
 *
 * @param {Uint8Array | null} manifest  Absent, the resource is RCDATA instead.
 * @param {number} major @param {number} minor
 */
function manifestProgram(manifest, major, minor){
    const data = manifest ?? Uint8Array.of(0xca, 0xfe, 0xf0, 0x0d);
    const bytes = new Uint8Array(0x258 + data.length);
    const view = new DataView(bytes.buffer);
    const put = (/** @type {number} */ at, /** @type {number} */ value)=>
        view.setUint32(at, value, true);
    view.setUint16(0, 0x5a4d, true);
    put(0x3c, 0x80);
    put(0x80, 0x4550);
    view.setUint16(0x84, 0x014c, true);
    view.setUint16(0x86, 1, true);
    view.setUint16(0x94, 224, true);
    view.setUint16(0x96, 0x0102, true); //           an executable
    view.setUint16(0x98, 0x010b, true);
    put(0x98 + 28, 0x00400000);
    put(0x98 + 32, 0x1000);
    view.setUint16(0x98 + 40, major, true); //       MajorOperatingSystemVersion
    view.setUint16(0x98 + 42, minor, true);
    put(0x98 + 56, 0x2000);
    put(0x98 + 60, 0x200);
    put(0x98 + 92, 16);
    put(0x98 + 96 + 2 * 8, 0x1000);
    put(0x98 + 96 + 2 * 8 + 4, 0x58 + data.length);
    bytes.set([...'.rsrc'].map(ch=>ch.charCodeAt(0)), 0x178);
    put(0x178 + 8, 0x58 + data.length);
    put(0x178 + 12, 0x1000);
    put(0x178 + 16, 0x58 + data.length);
    put(0x178 + 20, 0x200);
    view.setUint16(0x200 + 14, 1, true);
    put(0x200 + 16, manifest ? 24 : 10);
    put(0x200 + 20, 24 | 0x80000000);
    view.setUint16(0x200 + 24 + 14, 1, true);
    put(0x200 + 40, 1);
    put(0x200 + 44, 48 | 0x80000000);
    view.setUint16(0x200 + 48 + 14, 1, true);
    put(0x200 + 64, 0x409);
    put(0x200 + 68, 72);
    put(0x200 + 72, 0x1058);
    put(0x200 + 76, data.length);
    bytes.set(data, 0x258);
    return bytes;
}

test('a program says what Windows it knows through its manifest and its PE header', ()=>{
    // Windows 10 answers a program's version calls from these two
    // (versions.js's reportedVersion), so they are read from the program's
    // own image, the way CreateProcess reads them.
    const WINDOWS_10 = '8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a';
    const WINDOWS_7 = '35138b9a-5d96-4fbd-8e2d-a2440225f93a';
    const text = '<?xml version="1.0" encoding="UTF-8"?><assembly><compatibility><application>'
        + `<supportedOS Id="{${WINDOWS_7}}"/><supportedOS Id="{${WINDOWS_10}}"/>`
        + '</application></compatibility></assembly>';
    assert.deepEqual(compatibilityOf(manifestProgram(new TextEncoder().encode(text), 6, 0)),
        { supportedOS: [WINDOWS_7, WINDOWS_10], imageVersion: { major: 6, minor: 0 } });

    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe]);
    [...text].forEach((character, index)=>{
        utf16[2 + index * 2] = character.charCodeAt(0);
    });
    assert.deepEqual(compatibilityOf(manifestProgram(utf16, 5, 1)).supportedOS,
        [WINDOWS_7, WINDOWS_10], 'a manifest written in UTF-16 says the same');

    assert.deepEqual(compatibilityOf(manifestProgram(null, 4, 0)),
        { supportedOS: [], imageVersion: { major: 4, minor: 0 } }, 'no manifest at all');
});

test('a Windows that is not one of the four is refused before anything is built', async()=>{
    // A launcher passes what a manifest said, which no type checks.
    const options = /** @type {any} */ ({ executable: new Uint8Array(0), windows: 'win98' });
    await assert.rejects(createApp(options),
        /unknown Windows version "win98": the choices are win2000, winxp, win7, win10/);
});

test('a graphics choice nobody knows is refused before anything is built', async()=>{
    const options = /** @type {any} */ ({ executable: new Uint8Array(0), graphicsApi: 'glide' });
    await assert.rejects(createApp(options),
        /unknown graphics choice "glide": the choices are directx7, directx8, directx9, directx10, opengl/);
});

test('a library loaded as data answers for its resources by the handle it was given', ()=>{
    // LoadLibraryEx hands out a data file's base with a low bit set -- one for
    // a view of the file as it lies on disk, two for one laid out as an image
    // -- and FindResource, LoadResource and the rest take that handle. In the
    // file's own layout a resource is at its file offset from the base, not at
    // its RVA.
    const file = resourceLibrary();
    const image = parsePe(file);
    const flat = { base: 0x10000000, file, image, flat: true };
    const laidOut = { base: 0x10100000, file, image, flat: false };
    const lookup = resourceLookup(()=>null, new Map(),
        new Map([[0x10000001, flat], [0x10100002, laidOut]]));

    assert.equal(lookup.moduleBase(0x10000001), 0x10000000);
    assert.equal(lookup.findResource(0x10000001, 10, 1)?.rva, 0x258);
    assert.equal(lookup.moduleBase(0x10100002), 0x10100000);
    assert.equal(lookup.findResource(0x10100002, 10, 1)?.rva, 0x1058);
    assert.equal(lookup.moduleBase(0x10000000), 0, 'the base alone names no module');
    assert.equal(lookup.findResource(0x10000003, 10, 1), null, 'nor does another low bit');
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
    // A setup that changes to a folder of its disc loads a helper there by
    // bare name: the current directory, after the system ones.
    assert.deepEqual(libraryCandidates('dsetup.dll', IMAGE, 'D:\\DirectX').at(-1),
        'D:\\DirectX\\dsetup.dll');
    assert.equal(libraryCandidates('dsetup.dll', IMAGE, 'C:\\App\\').length, 3,
        'the program\'s own directory is not searched twice');
    // A name the engine's table already answers: the program's own copy still
    // wins, the system's is the engine's.
    assert.deepEqual(libraryCandidates('d3dx9_24.dll', IMAGE, undefined, { ours: true }),
        ['C:\\App\\d3dx9_24.dll']);
});

test('a library loaded with an altered search finds its imports beside it, then on PATH', ()=>{
    // LOAD_WITH_ALTERED_SEARCH_PATH: the loaded library's directory replaces
    // the program's for its own imports; the directories PATH names come last.
    assert.deepEqual(libraryCandidates('tier0.dll', IMAGE, 'C:\\App', {
        from: 'C:\\App\\bin\\', path: ['C:\\WINDOWS\\system32', 'C:\\App\\bin', 'D:\\Tools'],
    }), [
        'C:\\App\\bin\\tier0.dll', 'C:\\WINDOWS\\system32\\tier0.dll', 'C:\\WINDOWS\\tier0.dll',
        'C:\\App\\tier0.dll', 'D:\\Tools\\tier0.dll',
    ], 'each place once, case aside');
    assert.deepEqual(pathDirectories(' C:\\WINDOWS;;"C:\\Program Files\\X";bin;D:/y '),
        ['C:\\WINDOWS', 'C:\\Program Files\\X', 'D:/y'],
        'quotes off, empty and relative entries out');
    assert.deepEqual(pathDirectories(undefined), []);
});

test('a library name without an extension is looked for as a .dll', ()=>{
    // LoadLibrary appends the default extension when the name has none and
    // drops a trailing dot, which says the file has none.
    assert.equal(withLibraryExtension('rglsw'), 'rglsw.dll');
    assert.equal(withLibraryExtension('C:\\Game\\render'), 'C:\\Game\\render.dll');
    assert.equal(withLibraryExtension('plugins.d\\snd'), 'plugins.d\\snd.dll',
        'a dot in a directory is not the file\'s extension');
    assert.equal(withLibraryExtension('glide2x.dll'), 'glide2x.dll');
    assert.equal(withLibraryExtension('driver.drv'), 'driver.drv');
    assert.equal(withLibraryExtension('noext.'), 'noext');
});

test('a redistributable runtime is answered by the engine whoever brought a copy', ()=>{
    // A sound library loads its MPEG provider out of its own directory by full
    // path; the engine stands in for that runtime, so
    // the program's copy is not what loads -- run as emulated x86 it was a
    // third of the machine. A KnownDLL is answered the same way; any other
    // library the engine has a table for still loses to the program's file.
    const ours = answeredByEngine(['kernel32.dll'], ['Mp3dec.asi', 'ijl15.dll']);
    assert.equal(ours('C:\\App\\redist\\miles\\Mp3dec.asi'), true);
    assert.equal(ours('MP3DEC.ASI'), true);
    assert.equal(ours('ijl15'), true);
    assert.equal(ours('KERNEL32.dll'), true);
    assert.equal(ours('d3dx9_26.dll'), false, 'a runtime the program may bring its own of');
    assert.equal(ours('mss32.dll'), false, 'the sound library itself runs as shipped');
});

test('a library missing beside the program is read from system32', async()=>{
    // The runtime a title links against lives in `system32`, where its
    // installer's `DXSETUP` put it. A search that stopped beside the
    // executable would report every one of them missing.
    const d3dx = new Uint8Array([1, 2, 3, 4]);
    const filesystem = await filesystemModule.create({
        drives: { C: { source: createMemoryStore({ 'WINDOWS\\system32\\d3dx9_26.dll': d3dx }) } },
    });
    const read = shippedLibraryReader(filesystem, null, IMAGE);

    assert.deepEqual([.../** @type {Uint8Array} */ (await read('d3dx9_26.dll'))],
        [1, 2, 3, 4]);
    assert.equal(await read('nothing.dll'), null);
});

test('a file beside the program still wins over system32', async()=>{
    const beside = new Uint8Array([9]);
    const system = new Uint8Array([7]);
    const filesystem = await filesystemModule.create({
        drives: { C: { source: createMemoryStore({
            'WINDOWS\\system32\\d3dx9_26.dll': system, 'App\\d3dx9_26.dll': beside,
        }) } },
    });
    const read = shippedLibraryReader(filesystem, null, IMAGE);
    assert.deepEqual([.../** @type {Uint8Array} */ (await read('d3dx9_26.dll'))], [9]);
});

test('an import the engine answers is its own over a file in system32, not over one beside',
    async()=>{
        // A bottle carries everything its installation wrote, the runtime its
        // DirectX setup put in system32 too; the engine covers that copy, as
        // LoadLibrary at run time already did. A copy the program keeps beside
        // itself is still the program's.
        const d3dx = new Uint8Array(buildExe({
            imports: { 'KERNEL32.dll': ['Anything'] },
            code: ()=>[0xc3],
        }));
        const entry = new Uint8Array(buildExe({
            imports: { 'd3dx9_26.dll': ['D3DXCreateEffect'], 'KERNEL32.dll': ['Anything'] },
            code: ()=>[0xc3],
        }));
        const ours = (/** @type {string} */ name)=>name.toLowerCase() === 'd3dx9_26.dll';
        const plan = async(/** @type {Record<string, Uint8Array>} */ files)=>planDependencies({
            entry,
            isSystem: ours,
            isKnownDll: (/** @type {string} */ name)=>name.toLowerCase() === 'kernel32.dll',
            readLibrary: shippedLibraryReader(await filesystemModule.create({
                drives: { C: { source: createMemoryStore(files) } } }), null, IMAGE, ours),
        });

        const covered = await plan({ 'WINDOWS\\system32\\d3dx9_26.dll': d3dx });
        assert.deepEqual(covered.order, [], 'the table answers; the file is not mapped');
        assert.deepEqual(covered.missing, []);

        const beside = await plan({ 'App\\d3dx9_26.dll': d3dx });
        assert.deepEqual(beside.order.map(/** @type {any} */ one=>one.name), ['d3dx9_26.dll'],
            'the program\'s own copy is mapped');
    });

/**
 * A fixture image given a relocation directory -- one empty block -- so that
 * it can be mapped anywhere, as nearly every library a program ships can.
 *
 * @param {Uint8Array} file
 */
function movable(file){
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const optional = view.getUint32(0x3c, true) + 4 + 20;
    const BLOCK_RVA = 0x1020;
    const BLOCK_OFFSET = 0x220;
    view.setUint32(optional + 96 + 5 * 8, BLOCK_RVA, true);
    view.setUint32(optional + 96 + 5 * 8 + 4, 8, true);
    view.setUint32(BLOCK_OFFSET, 0x1000, true);
    view.setUint32(BLOCK_OFFSET + 4, 8, true);
    return file;
}

/**
 * The program's libraries, mapped by `mapShippedLibraries` over a loader that
 * only records where each one went.
 *
 * @param {Record<string, Uint8Array>} files  Beside the program, by name.
 * @param {Uint8Array} executable
 * @param {{ base: number, limit: number, floor?: number,
 *           held?: { base: number, size: number }[], bits?: 32 | 64 }} space
 *        `bits`: the process's machine.
 */
async function mapBeside(files, executable, space){
    const filesystem = await filesystemModule.create({
        drives: { C: { source: createMemoryStore(Object.fromEntries(
            Object.entries(files).map(([name, bytes])=>[`App\\${name}`, bytes]))) } },
    });
    /** @type {{ name: string, base: number, size: number }[]} */
    const placed = [];
    /** @type {any[]} */
    const emitted = [];
    const loader = {
        /** @param {Uint8Array} file @param {{ base: number, name: string }} where */
        map: (file, { base, name })=>{
            placed.push({ name, base, size: parsePe(file, { wide: true }).sizeOfImage });
            return { record: { entryPoint: 0 } };
        },
    };
    const kernel32 = (/** @type {string} */ name)=>name.toLowerCase() === 'kernel32.dll';
    const { held = [], floor = 0x00500000, bits, ...bounds } = space;
    const mapped = await mapShippedLibraries({
        executable, imagePath: IMAGE, filesystem, loader, blocks: null, bits,
        events: { emit: (/** @type {string} */ name, /** @type {any} */ payload)=>
            emitted.push([name, payload]) },
        isSystem: kernel32, isKnownDll: kernel32,
        byName: new Map(), byBase: new Map(),
        floor,
        /** @param {number} base @param {number} size */
        holder: (base, size)=>[...held, ...placed].find(one=>
            base < one.base + one.size && one.base < base + size) ?? null,
        ...bounds,
    });
    return { mapped, placed, emitted };
}

test('a library of the other machine is refused with its reason, as Windows refuses to map it',
    async()=>{
        /** @param {32 | 64} bits */
        const build = bits=>new Uint8Array(buildExe({ bits, dll: true, imageBase: 0x02000000,
            imports: { 'KERNEL32.dll': ['Anything'] }, code: ()=>[0xc3] }));
        /** @param {32 | 64} bits */
        const program = bits=>new Uint8Array(buildExe({ bits,
            imports: { 'other.dll': ['Anything'] }, code: ()=>[0xc3] }));
        for (const [bits, other, said] of /** @type {const} */ ([
            [32, 64, /an x86-64 image does not load into a 32-bit process/],
            [64, 32, /an i386 image does not load into a 64-bit process/]]))
        {
            const space = { base: 0x02000000, limit: 0x08000000, bits };
            const refused = await mapBeside({ 'other.dll': build(other) }, program(bits), space);
            assert.deepEqual(refused.placed, [], `a ${other}-bit library in a ${bits}-bit process`);
            assert.ok(refused.emitted.some(([name, payload])=>name === 'libraries-missing'
                && payload.names.includes('other.dll') && said.test(payload.reason)));
            const taken = await mapBeside({ 'other.dll': build(bits) }, program(bits), space);
            assert.deepEqual(taken.placed.map(one=>one.name), ['other.dll']);
        }
    });

test('a library that would reach past the modules\' space is refused, not mapped over the stacks',
    async()=>{
        // Above the modules' space the pool of thread stacks begins, and a
        // library mapped there is found only when a thread's stack is laid over
        // it -- as an overlap far from anything that explains it.
        const library = ()=>movable(new Uint8Array(buildExe({
            imports: { 'KERNEL32.dll': ['Anything'] }, code: ()=>[0xc3],
        })));
        const executable = new Uint8Array(buildExe({
            imports: { 'first.dll': ['Anything'], 'second.dll': ['Anything'] },
            code: ()=>[0xc3],
        }));
        const { placed, emitted } = await mapBeside(
            { 'first.dll': library(), 'second.dll': library() }, executable,
            { base: 0x02000000, limit: 0x02010000 });

        assert.deepEqual(placed.map(one=>[one.name, one.base]), [['first.dll', 0x02000000]]);
        assert.ok(emitted.some(([name, payload])=>name === 'libraries-missing'
            && payload.names.includes('second.dll') && payload.reason === 'no room'));
    });

test('a library without relocations goes to its own base, and movable ones fill in around it',
    async()=>{
        // Its absolute addresses assume that base, and it runs nowhere else.
        const fixed = new Uint8Array(buildExe({
            imports: { 'KERNEL32.dll': ['Anything'] }, code: ()=>[0xc3],
        }));
        new DataView(fixed.buffer).setUint32(
            new DataView(fixed.buffer).getUint32(0x3c, true) + 4 + 20 + 28, 0x02020000, true);
        const executable = new Uint8Array(buildExe({
            imports: { 'first.dll': ['Anything'], 'fixed.dll': ['Anything'],
                'second.dll': ['Anything'], 'third.dll': ['Anything'] },
            code: ()=>[0xc3],
        }));
        const library = ()=>movable(new Uint8Array(buildExe({
            imports: { 'KERNEL32.dll': ['Anything'] }, code: ()=>[0xc3],
        })));
        const { placed } = await mapBeside(
            { 'first.dll': library(), 'fixed.dll': fixed, 'second.dll': library(),
                'third.dll': library() },
            executable, { base: 0x02000000, limit: 0x08000000 });

        assert.deepEqual(placed.map(one=>[one.name, one.base]), [
            ['first.dll', 0x02000000], ['fixed.dll', 0x02020000],
            ['second.dll', 0x02010000], ['third.dll', 0x02030000],
        ]);
    });

test('a library without relocations whose base is taken is refused, not moved', async()=>{
    // "If the base address is not available, the loader reports an error"
    // (the PE format's IMAGE_FILE_RELOCS_STRIPPED): a library moved without
    // relocations runs with every absolute address pointing at its old base.
    const fixed = new Uint8Array(buildExe({
        imports: { 'KERNEL32.dll': ['Anything'] }, code: ()=>[0xc3],
    }));
    const executable = new Uint8Array(buildExe({
        imports: { 'fixed.dll': ['Anything'] }, code: ()=>[0xc3],
    }));
    const { placed, emitted } = await mapBeside({ 'fixed.dll': fixed }, executable,
        { base: 0x02000000, limit: 0x08000000 });

    assert.deepEqual(placed, [], 'its base, 0x400000, is the program\'s');
    assert.ok(emitted.some(([name, payload])=>name === 'libraries-missing'
        && payload.names.includes('fixed.dll') && /no relocations/.test(payload.reason)));
});

test('a library that cannot move takes its base outside the modules\' space when it is given up',
    ()=>{
        // Libraries linked at 0x20000000 and 0x30000000 with their relocations
        // stripped: free memory in a new process on Windows, the heap's arena
        // here, which gives the span up while nothing has been given it.
        /** @type {[number, number][]} */
        const asked = [];
        const space = { next: 0x02000000, floor: 0x00500000, limit: 0x08000000,
            holder: ()=>null,
            /** @param {number | null} base @param {number} size */
            claim: (base, size)=>{
                asked.push([base ?? 0, size]);
                return base === 0x20000000 ? base : base === null ? 0x31000000 : 0;
            } };
        const fixed = (/** @type {number} */ imageBase)=>({ relocatable: false, imageBase,
            sizeOfImage: 0x10000 });
        assert.deepEqual(placeLibrary(fixed(0x20000000), space), { base: 0x20000000 });
        assert.ok('refused' in placeLibrary(fixed(0x30000000), space), 'not given up');
        assert.deepEqual(placeLibrary(fixed(0x03000000), space), { base: 0x03000000 });
        assert.deepEqual(asked, [[0x20000000, 0x10000], [0x30000000, 0x10000]],
            'and a base free in the modules\' space is taken without asking');

        // One that can move and finds the space full goes wherever there is room.
        const full = { ...space, holder: ()=>({ base: 0x02000000, size: 0x06000000 }) };
        assert.deepEqual(placeLibrary({ relocatable: true, imageBase: 0x10000000,
            sizeOfImage: 0x10000 }, full), { base: 0x31000000 });
        assert.ok('refused' in placeLibrary({ relocatable: true, imageBase: 0x10000000,
            sizeOfImage: 0x10000 }, { ...full, claim: ()=>0 }), 'and nowhere is no room');
    });

test('a movable library takes the first free base at or after the next one', ()=>{
    const held = [{ base: 0x02000000, size: 0x3000 }, { base: 0x02010000, size: 0x10000 }];
    /** @param {number} base @param {number} size */
    const holder = (base, size)=>held.find(one=>
        base < one.base + one.size && one.base < base + size) ?? null;
    const space = { next: 0x02000000, floor: 0x00500000, limit: 0x08000000, holder };

    assert.deepEqual(placeLibrary(
        { relocatable: true, imageBase: 0x10000000, sizeOfImage: 0x5000 }, space),
    { base: 0x02020000 });
    assert.deepEqual(placeLibrary(
        { relocatable: true, imageBase: 0x10000000, sizeOfImage: 0x06000000 }, space),
    { refused: 'no room' });
    assert.deepEqual(placeLibrary(
        { relocatable: false, imageBase: 0x03000000, sizeOfImage: 0x5000 }, space),
    { base: 0x03000000 });
    assert.ok('refused' in placeLibrary(
        { relocatable: false, imageBase: 0x10000000, sizeOfImage: 0x5000 }, space),
    'above the modules\' space is the stacks\' and the heap\'s');
    assert.ok('refused' in placeLibrary(
        { relocatable: false, imageBase: 0x00400000, sizeOfImage: 0x5000 }, space),
    'below the floor is the program\'s and the engine\'s');
});

test('a library that imports from the program is not given a second copy of the program',
    async()=>{
        const executable = movable(new Uint8Array(buildExe({
            imports: { 'game.dll': ['Anything'] }, code: ()=>[0xc3],
        })));
        const game = movable(new Uint8Array(buildExe({
            imports: { 'GAME.EXE': ['Anything'] }, code: ()=>[0xc3],
        })));
        const { placed, emitted } = await mapBeside(
            { 'game.dll': game, 'Game.exe': executable }, executable,
            { base: 0x02000000, limit: 0x08000000 });

        assert.deepEqual(placed.map(one=>one.name), ['game.dll']);
        assert.ok(!emitted.some(([, payload])=>payload?.missing?.length > 0));
    });

/**
 * Runs `body` as a browser would see the globals: no `setImmediate`, which
 * Node has and no browser does, so the yield takes the path a page and a
 * worker take.
 *
 * @param {() => Promise<void>} body
 */
async function withoutImmediate(body){
    const immediate = globalThis.setImmediate;
    globalThis.setImmediate = /** @type {any} */ (undefined);
    try
    {
        await body();
    }
    finally
    {
        globalThis.setImmediate = immediate;
    }
}

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
        for (const host of [(/** @type {() => Promise<void>} */ body)=>body(), withoutImmediate])
        {
            await host(async()=>{
                const breathe = createMacrotask();
                await breathe();
                await breathe();
                breathe.close();
            });
        }
        assert.deepEqual(timers, [], 'no timer was involved, with an immediate or without');
    }
    finally
    {
        globalThis.setTimeout = realTimeout;
    }
});

test('a host timer comes due between two yields, not a thousand turns later', async()=>{
    // Node hands a port's messages over at least a thousand at a time, running
    // the microtasks after each, so a loop yielding through a port runs a
    // thousand turns before a timer, a file read, a worker's message or the
    // engine's own compiled code gets a turn. Where the host has setImmediate
    // the yield is one, and every one goes round the event loop.
    const breathe = createMacrotask();
    // Once before the timer is set: the first yield of a process pays for
    // whatever the host loads to make it, tens of milliseconds, which would
    // let the timer come due before the loop starts.
    await breathe();
    const timer = { fired: false };
    setTimeout(()=>{
        timer.fired = true;
    }, 5);
    let turns = 0;
    while (!timer.fired && turns < 5000)
    {
        const turn = performance.now();
        while (performance.now() - turn < 0.1)
        {
            // A turn of guest work.
        }
        await breathe();
        turns++;
    }
    breathe.close();
    assert.ok(timer.fired, 'the timer fired while the loop ran');
    assert.ok(turns < 200, `a 5 ms timer waited ${turns} turns of 0.1 ms`);
});

test('a yield still works where there is neither an immediate nor a channel', async()=>{
    // The fallback is not decoration: this file runs in a worker, in a page and
    // under a test runner, and a yield that threw in one of them would stop the
    // machine rather than slow it.
    const channel = globalThis.MessageChannel;
    globalThis.MessageChannel = /** @type {any} */ (undefined);
    try
    {
        await withoutImmediate(async()=>{
            const breathe = createMacrotask();
            await breathe();
            breathe.close();
        });
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
        await withoutImmediate(async()=>{
            const breathe = createMacrotask();
            await breathe();
            await breathe();
            await breathe();
            assert.equal(opened, 1);
            breathe.close();
        });
    }
    finally
    {
        globalThis.MessageChannel = real;
    }
});

test('closing a yield answers whoever was still waiting on it', async()=>{
    // A close that only drops the ports leaves the run loop awaiting a message
    // that can no longer arrive, which is a hang rather than a shutdown.
    for (const host of [(/** @type {() => Promise<void>} */ body)=>body(), withoutImmediate])
    {
        await host(async()=>{
            const breathe = createMacrotask();
            const pending = breathe();
            breathe.close();
            await pending;
        });
    }
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
    assert.equal(waitOn({ idlers: 1, spun: 1 }).phase, 'idle-message');
    assert.equal(waitOn({ suspended: 1 }).phase, 'idle-host');
    assert.equal(waitOn({ fetching: 1, idlers: 3, suspended: 2 }).phase, 'idle-fetch',
        'a range request outranks the message queue: it is the one with a cost');
    assert.equal(waitOn({ suspended: 1, spun: 64 }).phase, 'idle-host-wait',
        'and the name says which of the two waits it took');
});

test('a call on the host while the other executors run waits for its answer or for them', ()=>{
    // The turn the others ran retired nothing here and resets the count, so a
    // machine whose one thread here waits on the host came straight back for
    // as long as they ran -- or, before, the turn itself waited for them and
    // held the answer back, the event loop being where it comes.
    assert.equal(waitOn({ suspended: 1, others: true }).timer, true);
    assert.equal(waitOn({ suspended: 1, others: true }).phase, 'idle-host-wait');
    assert.equal(idleWait(busy({ others: true })), null,
        'with nothing on the host the next turn is the others\' work');
    assert.equal(idleWait(busy({ idlers: 1, others: true })), null,
        'nor a caller on the guest\'s own queue: its look is the next turn');
});

test("a caller parked on the guest's own queue is no wait while the guest still runs", ()=>{
    // An installer's window thread sits in GetMessage while another thread
    // copies; the window thread looks at its queue every turn without the
    // host, so a trip round the event loop for it every turn -- over a hundred
    // microseconds each on a page -- was paid behind every slice of copying.
    assert.equal(idleWait(busy({ idlers: 1 })), null);
    assert.deepEqual(waitOn({ idlers: 1, spun: 1 }), { phase: 'idle-message', timer: false },
        'once nothing ran, the queue is all there is and the loop comes straight back');
    assert.equal(waitOn({ idlers: 1, spun: 64 }).timer, true, 'and then backs off');
    assert.equal(waitOn({ idlers: 1, suspended: 1 }).phase, 'idle-message',
        'a call on the host beside it is still waited for');
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
    await yieldNow({ ...nothing, spun: 1 });
    assert.equal(trips, 1, 'a turn that retired nothing yields at once');
    // An answer outstanding while threads still run waits out PENDING_YIELD_MS
    // since the last trip ended: the trips a turn behind a running loader
    // were the largest host phase of a run.
    for (const pending of [{ suspended: 1 }, { fetching: 1 }])
    {
        assert.equal(yieldNow({ ...nothing, ...pending }), null, 'not straight after a trip');
        now += PENDING_YIELD_MS;
        await yieldNow({ ...nothing, ...pending });
    }
    assert.equal(trips, 3, 'and once the bound is up it does');
    await yieldNow({ ...nothing, suspended: 1, spun: 1 });
    assert.equal(trips, 4, 'with nothing else running the answer is looked for at once');
    assert.equal(yieldNow({ ...nothing, idlers: 1 }), null,
        "a caller on the guest's own queue is not the host's to answer");
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

test("a page's pacing yields on its own clock and looks again on its timer or on a wake", async t=>{
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
    await pacing.yield({ ...nothing, spun: 1 });
    assert.deepEqual(pacing.counts?.(), { kept: 1, interval: 1, spun: 1 },
        'each turn is counted by why it went to the event loop, or kept');

    let woke = false;
    await pacing.wait({ timer: true, sleep: true, deadlineMs: 1000,
        wakes: [Promise.resolve().then(()=>{
            woke = true;
        })] });
    assert.equal(woke, true, 'a wake ends the wait before the timer');
    // The look is the page's timer of `lookMs`, whatever the deadline: read off
    // the timer it sets, not off how soon a busy machine got round to it.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let looked = false;
    const look = pacing.wait({ timer: true, sleep: true, deadlineMs: null, wakes: [] })
        .then(()=>{
            looked = true;
        });
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(looked, false, 'the look waits for its timer');
    t.mock.timers.tick(1);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(looked, true, 'the look is short, whatever the deadline');
    await look;
});

test("a page's pacing sleeps to a deadline rather than spinning macrotasks to it", async t=>{
    // Every thread in a timed wait of a millisecond: a lap of macrotasks to the
    // deadline is a posted message each, tens of thousands a second.
    let laps = 0;
    let hidden = false;
    const pacing = pagePacing({
        macrotask: async()=>{
            laps++;
        },
        hidden: ()=>hidden,
        lookMs: 20,
        napWord: new Int32Array(new SharedArrayBuffer(4)),
    });
    // An async wait does not hold node's loop open; the page's does.
    const held = setInterval(()=>{}, 1000);
    t.after(()=>clearInterval(held));
    // How long each nap is asked to last, read off the wait itself: a loaded
    // machine wakes it late, never early.
    const naps = t.mock.method(Atomics, /** @type {any} */ ('waitAsync'));
    const before = performance.now();
    await pacing.wait({ timer: false, sleep: true, deadlineMs: 5, wakes: [] });
    assert.equal(laps, 0, 'no macrotask on the way to the deadline');
    assert.ok(performance.now() - before >= 4, 'the deadline is waited out');
    await pacing.wait({ timer: false, sleep: true, deadlineMs: 10_000, wakes: [] });
    assert.deepEqual(naps.mock.calls.map((/** @type {any} */ call)=>call.arguments[3]), [5, 20],
        'to the deadline, and a look at most, whatever the deadline');
    naps.mock.restore();
    assert.equal(pacing.counts?.().napped, 2);
    await pacing.wait({ timer: false, sleep: false, deadlineMs: 5, wakes: [] });
    await pacing.wait({ timer: false, sleep: true, deadlineMs: null, wakes: [] });
    hidden = true;
    await pacing.wait({ timer: false, sleep: true, deadlineMs: 5, wakes: [] });
    assert.equal(laps, 3, 'a thread still at work, no deadline, or a hidden page: a macrotask');
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

test('a film\'s sound counts whole on its timeline, even the part its track refused', ()=>{
    // Counted as taken only, the refused part was heard the moment it was
    // offered and the picture raced ahead of a sound that was mostly dropped.
    const track = { write: (/** @type {Uint8Array} */ bytes)=>Math.floor(bytes.length / 4 / 2) };
    const block = new Int16Array(22050 * 2);
    const fed = feedFilmSound(track, [block], 2, 22050, 44100);
    assert.deepEqual(fed, { offered: 44100, refused: 44100 - 11025 },
        'a second of film at 22050 is a second of device frames, taken or not');
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

test('a thread gets at least a megabyte of stack, whatever its image was linked for', ()=>{
    // Call of Duty 2's demo is linked for 64 KiB and its first thread reaches
    // 70 KiB down inside a window procedure; on Windows it runs.
    assert.equal(stackReserveOf(0x10000), 0x100000);
    assert.equal(stackReserveOf(0), 0x100000);
    assert.equal(stackReserveOf(0x800000), 0x800000, 'more is given as asked');
});

test('the first thread gets its whole reserve, in the pool when it does not fit low', ()=>{
    // Clamped to the span under the default stack pointer, a program linked
    // for eight megabytes got less than two and walked off the bottom of its
    // stack, through the stub table, on its first deep call.
    assert.deepEqual(placeMainStack(0x100000, 0x08000000, 0x04000000),
        { initialStack: undefined, poolBase: 0x08000000, poolSize: 0x04000000 },
        'a megabyte fits under the default stack pointer');
    assert.deepEqual(placeMainStack(0x800000, 0x08000000, 0x04000000),
        { initialStack: 0x08800000, poolBase: 0x08800000, poolSize: 0x03800000 },
        'eight megabytes go at the bottom of the pool, whole, and the pool starts above them');
    assert.deepEqual(placeMainStack(0x800001, 0x08000000, 0x04000000).initialStack, 0x08810000,
        'on a 64 KiB granule');
    assert.deepEqual(placeMainStack(0x40000000, 0x08000000, 0x04000000),
        { initialStack: 0x09000000, poolBase: 0x09000000, poolSize: 0x03000000 },
        'an enormous reserve is capped at a quarter of the pool');
});

test('the heap reaches the end of RAM unless a size was asked for', ()=>{
    // A fixed heap short of the end of RAM was what a program loading a level
    // ran into: it reported the machine's memory as exhausted while most of
    // it sat unused above the heap.
    assert.equal(heapSizeFor(1024 * 1024 * 1024), 1024 * 1024 * 1024 - 0x0c000000);
    assert.equal(heapSizeFor(1024 * 1024 * 1024, 0x14000000), 0x14000000, 'an asked-for size wins');
    assert.throws(()=>heapSizeFor(64 * 1024 * 1024), /less than the heap's base/);
    assert.equal(heapSizeFor(0x80000000), 0x7ffe0000 - 0x0c000000,
        'two gigabytes end below the shared page, as the memory of a process does');
});

/**
 * The smallest machine `createMissingImports` needs: a register that keeps the
 * handler it was given, the real event registry, and a journal that remembers
 * every write. `fault` throws so a test that reaches it says so.
 *
 * @param {Partial<{ own: boolean, returns: boolean }>} [what]
 */
function missingImportsHarness(what = {}){
    const events = createEvents();
    /** @type {any[]} */
    const announced = [];
    events.on('unimplemented', e=>announced.push(e));
    /** @type {any[][]} */
    const written = [];
    /** @type {(...args: any[]) => void} */
    const write = (...args)=>{
        written.push(args);
    };
    const journal = { write };
    /** @type {Map<string, (args: number[], frame: any) => number>} */
    const handlers = new Map();
    let base = 0x1000;
    const missing = createMissingImports({
        register: (/** @type {string} */ name, /** @type {any} */ spec)=>{
            handlers.set(name, spec.handler);
            base += 0x10;
            return base;
        },
        events,
        journal,
        classify: ()=>({ own: what.own ?? false, returns: what.returns ?? true, argBytes: 0 }),
        fault: ()=>{
            throw new Error('the fault branch was taken');
        },
    });
    return { events, announced, written, handlers, missing };
}

test('a missing import called a thousand times is announced once and counted a thousand', ()=>{
    // The observation this exists for: a wide-character classifier called per
    // character raised the event on every call, tens of thousands of a second,
    // each a structured clone and a wake-up through the port to the page, until
    // the page's queue filled and the program froze. The page needs to be told
    // once that the import is missing; every call after that is a number.
    const { announced, written, handlers, missing } = missingImportsHarness();
    missing.bind('KERNEL32.dll', 'iswspace', null);
    const handler = handlers.get('KERNEL32.dll!iswspace');
    assert.ok(handler, 'the import was bound to a stub');

    for (let call = 0; call < 1000; call++)
    {
        assert.equal(handler([], { callerStack: 0, hostReturn: 0 }), 0,
            'the returning stub answers zero');
    }

    assert.deepEqual(announced, [
        { import: 'KERNEL32.dll!iswspace', origin: 'system', count: 1 },
    ], 'one event, naming the import once');
    assert.equal(missing.calls.get('KERNEL32.dll!iswspace'), 1000,
        'and the count diagnostics reports');
    assert.equal(written.length, 1000,
        'the journal is a ring that never waits, so it keeps a record a call');
    assert.deepEqual(written[0], ['warn', 'unimplemented', '{0}',
        'import=KERNEL32.dll!iswspace origin=system count=1']);
    assert.deepEqual(written.at(-1), ['warn', 'unimplemented', '{0}',
        'import=KERNEL32.dll!iswspace origin=system count=1000']);
});

test('two missing imports are two announcements, each counted on its own', ()=>{
    const { announced, handlers, missing } = missingImportsHarness();
    missing.bind('KERNEL32.dll', 'iswspace', null);
    missing.bind('USER32.dll', 'NoSuchThing', null);

    /** @param {string} label */
    const call = label=>{
        const handler = handlers.get(label);
        assert.ok(handler, label);
        handler([], {});
    };
    call('KERNEL32.dll!iswspace');
    call('KERNEL32.dll!iswspace');
    call('USER32.dll!NoSuchThing');

    assert.deepEqual(announced, [
        { import: 'KERNEL32.dll!iswspace', origin: 'system', count: 1 },
        { import: 'USER32.dll!NoSuchThing', origin: 'system', count: 1 },
    ]);
    assert.equal(missing.calls.get('KERNEL32.dll!iswspace'), 2);
    assert.equal(missing.calls.get('USER32.dll!NoSuchThing'), 1);
});

test('a missing C++ import returns as its name says, and not at all when the name cannot say',
    ()=>{
        const crt = { own: false, cdeclLibrary: true };
        const system = { own: false, cdeclLibrary: false };

        assert.deepEqual(missingImportCall('??4__non_rtti_object@@QAEAAV0@ABV0@@Z', crt),
            { returns: true, argBytes: 4 }, 'a thiscall member of a cdecl library pops its own');
        assert.deepEqual(missingImportCall('?what@exception@@UBEPBDXZ', crt),
            { returns: true, argBytes: 0 });
        assert.deepEqual(missingImportCall('?f@@YGXHN_J@Z', system),
            { returns: true, argBytes: 20 }, 'the name sizes what an undecorated one cannot');
        assert.equal(missingImportCall('??0exception@@QAE@ABQBD@Z', crt).returns, false,
            'a constructor may take an argument its name does not show');
        assert.deepEqual(missingImportCall('??0exception@@QAE@ABQBD@Z',
            { own: true, cdeclLibrary: false }), { returns: true, argBytes: 0 },
        'a library the program brought answers as before');

        assert.deepEqual(missingImportCall('_stat', crt), { returns: true, argBytes: 0 });
        assert.deepEqual(missingImportCall('_Thing@8', system), { returns: true, argBytes: 8 });
        assert.equal(missingImportCall('Thing', system).returns, false);
    });

test('a missing import is bound once, however often it is asked for', ()=>{
    const { handlers, missing } = missingImportsHarness();
    const first = missing.bind('KERNEL32.dll', 'iswspace', null);
    const again = missing.bind('KERNEL32.dll', 'iswspace', null);

    assert.equal(first, again);
    assert.equal(handlers.size, 1);
});

test("a name a library the program brought does not export is the program's own", ()=>{
    const { announced, handlers, missing } = missingImportsHarness({ own: true });
    missing.bind('Game.dll', 'MissingExport', null);
    const handler = handlers.get('Game.dll!MissingExport');
    assert.ok(handler, 'the import was bound to a stub');
    handler([], {});

    assert.deepEqual(announced, [
        { import: 'Game.dll!MissingExport', origin: 'program', count: 1 },
    ]);
});

test('a call area is memoised by name, computed once for every call site', ()=>{
    /** @type {Map<string, string>} */
    const cache = new Map();
    assert.equal(areaOf({ name: 'D3D8.dll!Present' }, cache), 'call.gpu');
    assert.equal(areaOf({ name: 'WSOCK32.dll!send' }, cache), 'call.net');
    // A codec's conversions are sound: a line cut short is found beside the
    // buffer it was written into.
    assert.equal(areaOf({ name: 'MSACM32.dll!acmStreamConvert' }, cache), 'call.audio');
    // A COM method arrives named by its interface, with no library to split off.
    assert.equal(areaOf({ name: 'DrawPrimitive' }, cache), 'call.com');
    assert.equal(cache.size, 4);

    // A second call under an already-seen name answers from the cache: the
    // cached value is what comes back even if it could no longer be recomputed
    // correctly, which is the only way to tell a hit from a fresh split.
    cache.set('D3D8.dll!Present', 'call.stale');
    assert.equal(areaOf({ name: 'D3D8.dll!Present' }, cache), 'call.stale');
    assert.equal(cache.size, 4, 'no new entry was made for a name already cached');
});

/** The real region-checked accessors over a plain byte array, so the view's aliasing is real. */
function guestMemoryHarness(){
    const bytes = new Uint8Array(0x2000);
    const raw = {
        /** @param {number} address @param {number} length */
        readPhysical: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writePhysical: (address, data)=>bytes.set(data, address),
    };
    const regions = createRegionMap();
    regions.register({ name: 'heap', base: 0x1000, size: 0x1000,
        kind: RegionKind.THUNK_DATA, access: Access.READ_WRITE });
    const accessors = createAccessors({ raw, regions });
    return { bytes, accessors, guest: createGuestView(accessors) };
}

test('f32s/i32s/u8s are live, bounds-checked-once views: a view sees a scalar write and vice versa',
    ()=>{
        const { accessors, guest } = guestMemoryHarness();
        accessors.writeU32(0x1000, 0x3f800000); // 1.0f
        accessors.writeU32(0x1004, 0x40000000); // 2.0f

        const floats = guest.f32s(0x1000, 2);
        assert.equal(floats[0], 1);
        assert.equal(floats[1], 2);

        // A write through the view lands in guest memory ...
        floats[0] = 3;
        assert.equal(accessors.readU32(0x1000), 0x40400000, 'bit pattern of 3.0f');
        // ... and a scalar write after the view was built is visible through it,
        // the way only a real alias -- not a copy -- can be.
        accessors.writeU32(0x1004, 0x40800000); // 4.0f
        assert.equal(floats[1], 4);

        const ints = guest.i32s(0x1008, 1);
        ints[0] = -1;
        assert.equal(accessors.readU32(0x1008), 0xffffffff);

        const octets = guest.u8s(0x1010, 2);
        octets[0] = 9;
        assert.equal(accessors.readU8(0x1010), 9);
        accessors.writeU8(0x1011, 7);
        assert.equal(octets[1], 7);
    });

test('an out-of-region f32s/i32s/u8s view is refused, the way any guest memory access is', ()=>{
    const { guest } = guestMemoryHarness();
    assert.throws(()=>guest.f32s(0x5000, 4), /Unmapped/);
    assert.throws(()=>guest.i32s(0x1ffc, 4), /runs past the end/);
    assert.throws(()=>guest.u8s(0x5000, 4), /Unmapped/);
});

test('an unaligned f32s/i32s view is refused, so the call falls through to the guest', ()=>{
    const { guest } = guestMemoryHarness();
    assert.throws(()=>guest.f32s(0x1001, 1), /not 4-byte aligned/);
    assert.throws(()=>guest.i32s(0x1002, 1), /not 4-byte aligned/);
});

/**
 * A fake OpenGL layer: `entry(name)` answers a handler for one name and null for the rest.
 *
 * @param {Record<string, (args: number[]) => number>} handlers
 */
function fakeOpengl(handlers){
    return { entry: (/** @type {string} */ name)=>handlers[name] ?? null };
}

test('createKernelGl resolves a name to a closure, and null for one the library has not', ()=>{
    const gl = createKernelGl(fakeOpengl({ glEnable: ()=>0 }), ()=>{}, ()=>false, { calls: 0 });
    assert.equal(typeof gl.entry('glEnable'), 'function');
    assert.equal(gl.entry('glNoSuchThing'), null);
});

test('a call through createKernelGl counts, and journals only when traced() is true', ()=>{
    const counters = { calls: 0 };
    /** @type {{ name: string, args: number[], result: string }[]} */
    const journalled = [];
    let traced = false;
    const gl = createKernelGl(
        fakeOpengl({ glEnable: args=>(args[0], 0) }),
        call=>journalled.push(call),
        ()=>traced,
        counters);

    const entry = gl.entry('glEnable');
    assert.ok(entry);
    entry([0xb90]);
    assert.equal(counters.calls, 1);
    assert.equal(journalled.length, 0, 'not traced: nothing written');

    traced = true;
    entry([0xb90]);
    assert.equal(counters.calls, 2);
    assert.deepEqual(journalled, [{ name: 'OPENGL32.dll!glEnable', args: [0xb90], result: '0x0' }]);
});

test('a seam that throws makes every entry answer null rather than throwing', ()=>{
    const gl = createKernelGl({
        entry(){
            throw new Error('no OpenGL seam in this build');
        },
    }, ()=>{}, ()=>true, { calls: 0 });
    assert.equal(gl.entry('glEnable'), null);
});

test('resolveOpenglEntry remembers a seam that throws once, and reuses one that resolves', ()=>{
    let calls = 0;
    const throwing = resolveOpenglEntry({ opengl(){ calls++; throw new Error('no seam'); } });
    assert.equal(throwing.entry('glEnable'), null);
    assert.equal(throwing.entry('glEnable'), null);
    assert.equal(calls, 1, 'the failure is remembered, not retried');

    const layer = fakeOpengl({ glEnable: ()=>0 });
    const resolving = resolveOpenglEntry({ opengl: ()=>layer });
    assert.equal(resolving.entry('glEnable'), layer.entry('glEnable'));
});

test('an event line names a picture by its size, never by its pixels', ()=>{
    const line = describeEvent({
        width: 32, height: 32, hotSpot: { x: 1, y: 2 }, bgra: new Uint8Array(32 * 32 * 4),
        shown: true, names: ['a', 'b'],
    });
    assert.equal(line,
        'width=32 height=32 hotSpot={"x":1,"y":2} bgra=<4096 bytes> shown=true names=[a b]');
});

test('a file\'s version block is read without reading the file', ()=>{
    // An installer asks after every file it puts down, a gigabyte archive
    // among them: the headers, the resource directory and the block are read,
    // and nothing else of it.
    const RSRC_RVA = 0x1000;
    const RSRC_FILE = 0x200;
    const SECTION_TABLE = 0x178;
    const block = Uint8Array.from({ length: 92 }, (_, at)=>at + 1);
    // type 16 -> id 1 -> language 0x409 -> the data entry -> the block, each
    // node a header of sixteen bytes and one entry of eight.
    const rsrc = new Uint8Array(88 + block.length);
    const tree = new DataView(rsrc.buffer);
    [[16, 24], [1, 48], [0x409, 72]].forEach(([key, next], level)=>{
        tree.setUint16(level * 24 + 14, 1, true);
        tree.setUint32(level * 24 + 16, key, true);
        tree.setUint32(level * 24 + 20, level < 2 ? (next | 0x80000000) >>> 0 : next, true);
    });
    tree.setUint32(72, RSRC_RVA + 88, true);
    tree.setUint32(76, block.length, true);
    rsrc.set(block, 88);
    const OVERLAY = 1 << 24;
    const bytes = new Uint8Array(RSRC_FILE + rsrc.length + OVERLAY);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0x5a4d, true);
    view.setUint32(0x3c, 0x80, true);
    view.setUint32(0x80, 0x00004550, true);
    view.setUint16(0x84, 0x014c, true);
    view.setUint16(0x86, 1, true);
    view.setUint16(0x94, 224, true);
    view.setUint16(0x98, 0x010b, true);
    view.setUint32(0x98 + 60, RSRC_FILE, true);
    view.setUint32(0x98 + 92, 16, true);
    view.setUint32(0x98 + 96 + 2 * 8, RSRC_RVA, true);
    view.setUint32(0x98 + 96 + 2 * 8 + 4, 88, true);
    bytes.set(new TextEncoder().encode('.rsrc'), SECTION_TABLE);
    view.setUint32(SECTION_TABLE + 8, rsrc.length, true);
    view.setUint32(SECTION_TABLE + 12, RSRC_RVA, true);
    view.setUint32(SECTION_TABLE + 16, rsrc.length, true);
    view.setUint32(SECTION_TABLE + 20, RSRC_FILE, true);
    bytes.set(rsrc, RSRC_FILE);

    let read = 0;
    let position = 0;
    const filesystem = {
        open: (/** @type {string} */ path)=>{
            if (path !== 'C:\\Game\\content.gcf')
            {
                throw new Error('not found');
            }
            return {};
        },
        size: ()=>bytes.length,
        seek: (/** @type {any} */ handle, /** @type {number} */ offset)=>{
            position = offset;
        },
        read: (/** @type {any} */ handle, /** @type {number} */ length)=>{
            read += length;
            const out = bytes.slice(position, position + length);
            position += out.length;
            return out;
        },
        close: ()=>{},
    };
    assert.deepEqual(versionResourceOf(filesystem, 'C:\\Game\\content.gcf'), block);
    assert.ok(read < 0x2000, `${read} bytes read of ${bytes.length}`);
    assert.equal(versionResourceOf(filesystem, 'C:\\Game\\gone.gcf'), null);
    view.setUint32(0x98 + 96 + 2 * 8 + 4, 0, true);
    assert.equal(versionResourceOf(filesystem, 'C:\\Game\\content.gcf'), null,
        'an image with no resources has no version');
});

test('the version block of a bundle file whose bytes are still coming is waited for, as a read '
    + 'waits for its own', async()=>{
    // Headers, a section table, a resource tree and the block, each in a
    // block of its own that has not arrived: every read misses once.
    const PAGE = 0x1000;
    const RSRC_RVA = 0x3000;
    const RSRC_FILE = 0x3000;
    const block = Uint8Array.from({ length: 64 }, (_, i)=>i + 1);
    const rsrc = new Uint8Array(PAGE + block.length);
    const tree = new DataView(rsrc.buffer);
    // Type 16, name 1, language 0, each a directory of one entry, then the leaf.
    [16, 1, 0].forEach((key, level)=>{
        const next = (level + 1) * 24;
        tree.setUint16(level * 24 + 14, 1, true);
        tree.setUint32(level * 24 + 16, key, true);
        tree.setUint32(level * 24 + 20, level < 2 ? (next | 0x80000000) >>> 0 : next, true);
    });
    tree.setUint32(72, RSRC_RVA + PAGE, true);
    tree.setUint32(76, block.length, true);
    rsrc.set(block, PAGE);
    const bytes = new Uint8Array(RSRC_FILE + rsrc.length);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0x5a4d, true);
    view.setUint32(0x3c, 0x80, true);
    view.setUint32(0x80, 0x00004550, true);
    view.setUint16(0x84, 0x014c, true);
    view.setUint16(0x86, 1, true);
    view.setUint16(0x94, 224, true);
    view.setUint16(0x98, 0x010b, true);
    view.setUint32(0x98 + 60, PAGE, true);
    view.setUint32(0x98 + 92, 16, true);
    view.setUint32(0x98 + 96 + 2 * 8, RSRC_RVA, true);
    view.setUint32(0x98 + 96 + 2 * 8 + 4, 88, true);
    const SECTION_TABLE = 0x80 + 24 + 224;
    bytes.set(new TextEncoder().encode('.rsrc'), SECTION_TABLE);
    view.setUint32(SECTION_TABLE + 8, rsrc.length, true);
    view.setUint32(SECTION_TABLE + 12, RSRC_RVA, true);
    view.setUint32(SECTION_TABLE + 16, rsrc.length, true);
    view.setUint32(SECTION_TABLE + 20, RSRC_FILE, true);
    bytes.set(rsrc, RSRC_FILE);

    /** The pages that have arrived; a read of any other throws the volume's miss. */
    const resident = new Set();
    let position = 0;
    const filesystem = {
        open: ()=>({}),
        size: ()=>bytes.length,
        seek: (/** @type {any} */ handle, /** @type {number} */ offset)=>{
            position = offset;
        },
        read: (/** @type {any} */ handle, /** @type {number} */ length)=>{
            const pages = [];
            for (let page = Math.floor(position / PAGE); page * PAGE < position + length; page++)
            {
                if (!resident.has(page))
                {
                    pages.push(page);
                }
            }
            if (pages.length > 0)
            {
                throw Object.assign(new Error('not resident'), { code: 'BLOCK_MISS',
                    blocks: pages });
            }
            const out = bytes.slice(position, position + length);
            position += out.length;
            return out;
        },
        close: ()=>{},
    };
    /** @type {number[][]} */
    const fetched = [];
    const blocks = {
        fetch: async(/** @type {number[]} */ pages)=>{
            fetched.push(pages);
            pages.forEach(page=>resident.add(page));
        },
    };

    assert.equal(versionResourceOf(filesystem, 'C:\\Game\\steam.exe'), null,
        'with nothing to fetch the bytes through, a file still coming has none');
    const answer = versionResourceOf(filesystem, 'C:\\Game\\steam.exe', blocks);
    assert.equal(typeof (/** @type {any} */ (answer))?.then, 'function', 'it waits');
    assert.deepEqual(await answer, block);
    assert.ok(fetched.length >= 2 && fetched.length <= 4, `${fetched.length} fetches`);
    assert.deepEqual(versionResourceOf(filesystem, 'C:\\Game\\steam.exe', blocks), block,
        'and once they are here it answers at once');
});

test('each run has a first process id of its own, below the others and on the table step', ()=>{
    // A program that writes its id to a file to refuse a second copy of itself
    // found its own id there the next run, when every run had the same one.
    const ids = new Set(Array.from({ length: 64 }, ()=>runProcessId()));
    assert.ok(ids.size > 1, 'not the same id every run');
    for (const id of ids)
    {
        assert.ok(id >= 0x400 && id < 0x2000 && id % 8 === 0, `0x${id.toString(16)}`);
    }
});

test('the cpu setup\'s cores are a whole number from 1 to 32, and `executors`, their older name,'
    + ' is refused', ()=>{
    assert.equal(withCpuSetup({ cpu: { cores: 4 } }).cpu?.cores, 4);
    for (const cores of [0, 33, 2.5, -1, NaN])
    {
        assert.throws(()=>withCpuSetup({ cpu: { cores } }), /from 1 to 32/);
    }
    assert.throws(()=>withCpuSetup(/** @type {any} */ ({ executors: 3 })), /cpu\.cores/);
    assert.throws(()=>withCpuSetup(/** @type {any} */ ({ cpu: { cores: 3 }, executors: 3 })),
        /cpu\.cores/);
});

test('cores the caller names open before the program starts, automatic ones as threads want them',
    ()=>{
        const browser = { node: false, processors: 4, shareable: true };
        assert.equal(withCpuSetup({ cpu: { cores: 4 } }).cpu?.eager, true);
        assert.equal(withCpuSetup({ cpu: { cores: 4, eager: false } }).cpu?.eager, false,
            'unless the caller says otherwise');
        assert.equal(withCpuSetup({}, browser).cpu?.eager, false, 'automatic: lazy');
        assert.equal(withCpuSetup({ cpu: { eager: true } }, browser).cpu?.eager, true);
        assert.equal(withCpuSetup({}, { node: true, processors: 4, shareable: true, named: '4' })
            .cpu?.eager, false, 'BOTTLIFY_CORES is the suite\'s choice, not the caller\'s');
    });

test('a run that names no cores gets one fewer than a browser host\'s processors where it shares'
    + ' memory, at most eight, and one where it cannot; in node the cores BOTTLIFY_CORES names',
()=>{
    const browser = { node: false, processors: 4, shareable: true };
    assert.equal(withCpuSetup({}, browser).cpu?.cores, 3, 'four processors: three cores');
    assert.equal(withCpuSetup({}, { ...browser, processors: 16 }).cpu?.cores, 8, 'at most eight');
    assert.equal(withCpuSetup({}, { ...browser, processors: 2 }).cpu?.cores, 1);
    assert.equal(withCpuSetup({}, { ...browser, processors: 1 }).cpu?.cores, undefined, 'one');
    assert.equal(withCpuSetup({}, { ...browser, processors: undefined }).cpu?.cores, undefined,
        'a host that does not say: one');
    assert.equal(withCpuSetup({}, { ...browser, shareable: false }).cpu?.cores, undefined,
        'a page that is not cross-origin isolated: one');
    assert.equal(withCpuSetup({ mode: 'compatible' }, browser).cpu?.cores, undefined);
    assert.equal(withCpuSetup({ cork: { config: { sharedMemory: false } } }, browser).cpu?.cores,
        undefined);
    assert.equal(withCpuSetup({ cpu: { cores: 1 } }, browser).cpu?.cores, 1, 'named, as named');
    const node = { node: true, processors: 4, shareable: true };
    assert.equal(withCpuSetup({}, node).cpu?.cores, undefined, 'node: one, the same everywhere');
    assert.equal(withCpuSetup({}, { ...node, named: '4' }).cpu?.cores, 4, 'BOTTLIFY_CORES');
    assert.equal(withCpuSetup({}, { ...node, named: '' }).cpu?.cores, undefined);
});

test('the pool lends a process the host\'s cores its own leave, less two, and never none', ()=>{
    assert.equal(translatorsBeside(1, 4), 1, 'four cores, one for the program: one translator');
    assert.equal(translatorsBeside(4, 4), 1, 'the program takes them all: still one');
    assert.equal(translatorsBeside(1, 8), 5);
    assert.equal(translatorsBeside(4, 16), 10);
});

test('a miss brings in more the farther the bundle is, and no more than eight windows', ()=>{
    // A near bundle keeps the window the transport was tuned on; a bucket a
    // third of a second away has each round trip carry what the line delivers
    // in it, and the cap keeps one request under the request ceiling.
    assert.equal(windowFor(0), READ_AHEAD_BYTES, 'before any request');
    assert.equal(windowFor(NEAR_ROUND_TRIP_MS - 1), READ_AHEAD_BYTES, 'a near bundle');
    assert.equal(windowFor(2 * NEAR_ROUND_TRIP_MS), 2 * READ_AHEAD_BYTES);
    assert.equal(windowFor(350), 7 * READ_AHEAD_BYTES, 'a bucket at 350 ms');
    assert.equal(windowFor(60000), 8 * READ_AHEAD_BYTES, 'capped');
});

test('a graphics resource is handed cleared memory, and fresh memory is not written again', ()=>{
    /** @type {[number, number, number][]} */
    const filled = [];
    const fill = (/** @type {number} */ address, /** @type {number} */ value,
        /** @type {number} */ length)=>filled.push([address, value, length]);
    const recycled = { allocate: ()=>0x5000, block: ()=>({ fresh: false }) };
    assert.equal(allocateCleared(recycled, fill, 64), 0x5000);
    assert.deepEqual(filled, [[0x5000, 0, 64]]);
    const fresh = { allocate: ()=>0x9000, block: ()=>({ fresh: true }) };
    assert.equal(allocateCleared(fresh, fill, 64), 0x9000);
    assert.equal(filled.length, 1);
    const full = { allocate: ()=>0, block: ()=>null };
    assert.equal(allocateCleared(full, fill, 64), 0);
    assert.equal(filled.length, 1);
    // Bytes nobody reads before they are written -- a render target another
    // device draws -- are left as the heap had them.
    assert.equal(allocateCleared(recycled, fill, 64, false), 0x5000);
    assert.equal(filled.length, 1);
});

test('a graphics resource starts on a 16-byte boundary where the heap\'s next block does not', ()=>{
    const heap = createHeapAllocator({ base: 0x10000, size: 0x10000 });
    const fill = ()=>{};
    let offBoundary = 0;
    for (const bytes of [4, 36, 1, 44, 8, 52, 4608])
    {
        // An eight-byte block between them moves the heap's own next one.
        heap.allocate(8);
        const address = allocateCleared(heap, fill, bytes);
        assert.equal(address % RESOURCE_ALIGNMENT, 0,
            `${bytes} bytes at 0x${address.toString(16)}`);
        assert.equal(heap.block(address)?.size, bytes, 'the block is the one handed out');
        offBoundary += heap.allocate(bytes) % RESOURCE_ALIGNMENT === 0 ? 0 : 1;
    }
    assert.ok(offBoundary > 0, 'the heap alone hands out blocks off the boundary');
});

test('freeze pauses a running program while it shows a frame, and ends only its own pause', ()=>{
    /** @type {any[]} */
    const posted = [];
    const worker = { postMessage: (/** @type {any} */ data)=>posted.push(data),
        addEventListener: ()=>{} };
    let paused = false;
    /** @type {string[]} */
    const told = [];
    const control = {
        pause: ()=>{ paused = true; told.push('pause'); },
        resume: ()=>{ paused = false; told.push('resume'); },
        paused: ()=>paused,
    };
    const debug = liveDumpOf(worker, control);
    // A program left running would present new frames, each the one shown again.
    debug.freeze(true);
    assert.equal(paused, true);
    debug.freeze(true);
    debug.freeze(false);
    assert.equal(paused, false);
    assert.deepEqual(told, ['pause', 'resume']);
    assert.deepEqual(posted.map(each=>each.freeze), [true, true, false]);
    // Someone else's pause is theirs to end.
    control.pause();
    debug.freeze(true);
    debug.freeze(false);
    assert.equal(paused, true);
    assert.deepEqual(told, ['pause', 'resume', 'pause']);
});

test('an iPhone translates without wasm tail calls; phones and Safari run on one core', ()=>{
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 '
        + '(KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
    const chromeIos = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 '
        + '(KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1';
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
        + '(KHTML, like Gecko) Version/26.0 Safari/605.1.15';
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    const android = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/141.0.0.0 Mobile Safari/537.36';
    const iphone26 = iphone.replace('Version/26.0', 'Version/26.4');
    const iphone27 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 '
        + '(KHTML, like Gecko) Version/27.0.1 Mobile/15E148 Safari/604.1';
    for (const userAgent of [iphone27, chromeIos])
    {
        assert.equal(tailCallsFault({ userAgent }), true, userAgent);
    }
    // iOS 26 had no such defect; the Mac's agent is an iPad's too: tail calls kept.
    for (const userAgent of [iphone26, mac, chrome, android, 'Node.js/22', ''])
    {
        assert.equal(tailCallsFault({ userAgent }), false, userAgent);
    }
    for (const userAgent of [iphone, chromeIos, mac, android])
    {
        assert.equal(mobileOrSafari({ userAgent }), true, userAgent);
    }
    for (const userAgent of [chrome, 'Node.js/22', ''])
    {
        assert.equal(mobileOrSafari({ userAgent }), false, userAgent);
    }
    const off = withoutFaultingTailCalls({ cork: { config: { worker: false } } }, true);
    assert.deepEqual(off.cork.config,
        { crossTailCalls: false, dispatch: true, callDepth: 64, worker: false });
    assert.equal(withoutFaultingTailCalls({ cork: { config: { crossTailCalls: true } } }, true)
        .cork.config.crossTailCalls, true, 'the caller\'s own setting wins');
    const options = {};
    assert.equal(withoutFaultingTailCalls(options, false), options);

    const browser = { node: false, processors: 8, shareable: true };
    assert.equal(automaticCores({}, browser), 7);
    assert.equal(automaticCores({}, { ...browser, oneCore: true }), undefined, 'one core');
    assert.equal(withCpuSetup({ cpu: { cores: 3 } }, { ...browser, oneCore: true }).cpu?.cores, 3,
        'cores asked for by name are given');
});

test('a whole file larger than the heap\'s pool of fetched blocks is read whole, a piece at a time',
    async()=>{
        const BLOCK = 1024;
        const image = new Uint8Array(40 * BLOCK).map((_, at)=>(at * 7 + (at >> 10)) & 0xff);
        image.set([0x4d, 0x5a]);
        const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const directory = await mkdtemp(join(tmpdir(), 'bottlify-whole-'));
        let container;
        try
        {
            await writeFile(join(directory, 'game.exe'), image);
            await writeBundle({ root: directory, output: join(directory, 'b.btl'),
                blockSize: BLOCK, pack: (/** @type {Buffer} */ block)=>({ codec: 0,
                    bytes: block }) });
            container = new Uint8Array(await readFile(join(directory, 'b.btl')));
        }
        finally
        {
            await rm(directory, { recursive: true, force: true });
        }
        const { inflateRawSync } = await import('node:zlib');
        const bundle = await openBundle(async(at, length)=>container.subarray(at, at + length),
            (codec, bytes)=>(codec === 1 ? new Uint8Array(inflateRawSync(bytes)) : bytes));
        /** A run with no store: eight blocks in the heap, as the pool is to a large image. */
        const cache = await createBlockCache({ store: null, name: 'b', blockSize: BLOCK,
            blockCount: bundle.blockCount, maxHeapBytes: 8 * BLOCK });
        const source = createBundleSource({ bundle, readBlock: index=>cache.read(index),
            decode: (_, bytes)=>bytes, cacheBlocks: 0, hotBlocks: 0 });
        // The volume's handle reads, which move only by what they answer.
        const filesystem = {
            open: (/** @type {string} */ path)=>({ path, position: 0 }),
            size: (/** @type {any} */ handle)=>source.stat(handle.path)?.size ?? 0,
            read(/** @type {any} */ handle, /** @type {number} */ length){
                const bytes = source.read(handle.path, handle.position, length);
                handle.position += bytes.length;
                return bytes;
            },
            close(){},
        };
        // The run's fetch: the blocks in, then the batch's end, where the
        // heap's cache lets go of all but its pool.
        let fetches = 0;
        const blocks = {
            fetch: async(/** @type {any[]} */ needed)=>{
                if (++fetches > 200)
                {
                    throw new Error('fetched for ever');
                }
                for (const { offset, packed, index } of needed)
                {
                    await cache.put(index, container.slice(offset, offset + packed));
                }
                await cache.persist();
            },
        };
        const read = await readWholeFile(filesystem, blocks, 'game.exe', 4 * BLOCK);
        assert.deepEqual(read, image, 'the file arrives whole, MZ first');
        assert.ok(fetches <= 10, `a fetch a piece (${fetches})`);
        await assert.rejects(readWholeFile(filesystem, blocks, 'game.exe', Infinity),
            /fetched for ever/, 'the whole file in one read never fits the pool');
        assert.ok(WHOLE_READ_BYTES * 2 <= HEAP_POOLS.blockCache,
            'a piece and the read-ahead beside it fit the pool');
    });
