/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Access, RegionKind, createRegionMap } from './regions.js';
import { createAccessors } from './accessors.js';

/**
 * A stand-in for guest physical memory.
 *
 * @param {number} [size]
 */
function fakeMemory(size = 0x10000){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readPhysical: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writePhysical: (address, data)=>bytes.set(data, address),
    };
}

/**
 * The emulator's memory as the accessors see it, with the paths it offers kept
 * apart: `writePhysical` is the one that tells the emulator's compiler about a
 * page it may have translated, `writeData` and `fillData` the ones that go
 * straight into memory. The log of which path a call took is the only way to
 * see the difference from outside, since all three leave the same bytes.
 *
 * @param {number} [size]
 */
function machineMemory(size = 0x10000){
    const bytes = new Uint8Array(size);
    /** @type {string[]} */
    const took = [];
    return {
        bytes,
        took,
        /** @param {number} address @param {number} length */
        readPhysical: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writePhysical: (address, data)=>{
            took.push('writePhysical');
            bytes.set(data, address);
        },
        /** @param {number} address @param {Uint8Array} data */
        writeData: (address, data)=>{
            took.push('writeData');
            bytes.set(data, address);
        },
        /** @param {number} address @param {number} value @param {number} length */
        fillData: (address, value, length)=>{
            took.push('fillData');
            bytes.fill(value, address, address + length);
        },
    };
}

/** A region of several pages, for a fill that has to cross one. */
function mapWithPages(){
    const regions = createRegionMap();
    regions.register({
        name: 'heap', base: 0x4000, size: 0x4000,
        kind: RegionKind.THUNK_DATA, access: Access.READ_WRITE,
    });
    regions.register({
        name: 'generated', base: 0x8000, size: 0x1000,
        kind: RegionKind.THUNK_CODE, access: Access.READ_WRITE_EXECUTE,
    });
    return regions;
}

function mapWithCode(){
    const regions = createRegionMap();
    regions.register({
        name: 'code', base: 0x1000, size: 0x1000,
        kind: RegionKind.THUNK_CODE, access: Access.READ_EXECUTE,
    });
    regions.register({
        name: 'data', base: 0x2000, size: 0x1000,
        kind: RegionKind.THUNK_DATA, access: Access.READ_WRITE,
    });
    return regions;
}

test('a layout that overlaps is refused when it is registered', ()=>{
    const regions = mapWithCode();
    assert.throws(
        ()=>regions.register({
            name: 'stack', base: 0x1800, size: 0x1000,
            kind: RegionKind.STACK, access: Access.READ_WRITE,
        }),
        /overlaps "code"/,
        'a stack growing into existing code is a layout bug, caught at registration');

    // Butting up against the end of a region is not an overlap.
    regions.register({
        name: 'stack', base: 0x3000, size: 0x1000,
        kind: RegionKind.STACK, access: Access.READ_WRITE,
    });
    assert.deepEqual(regions.list().map(r=>r.name), ['code', 'data', 'stack']);
});

test('a region given back is gone from every answer, and its span can be registered again', ()=>{
    // A thread's stack outlives nothing but its thread: once it is given
    // back, a read there is a read of nothing, and the next stack goes there.
    const raw = fakeMemory();
    const regions = mapWithCode();
    const accessors = createAccessors({ raw, regions });
    regions.register({
        name: 'stack-1', base: 0x3000, size: 0x1000,
        kind: RegionKind.STACK, access: Access.READ_WRITE,
    });
    accessors.writeU32(0x3000, 5);
    assert.equal(accessors.readU32(0x3000), 5, 'remembered by the accessors and the map');

    regions.unregister('stack-1');
    assert.equal(regions.find(0x3000), undefined, 'not answered from a cache');
    assert.throws(()=>accessors.readU32(0x3000), /Unmapped/);
    assert.deepEqual(regions.list().map(r=>r.name), ['code', 'data']);
    assert.throws(()=>regions.unregister('stack-1'), /No region named/);

    regions.register({
        name: 'stack-2', base: 0x3000, size: 0x800,
        kind: RegionKind.STACK, access: Access.READ_WRITE,
    });
    assert.equal(regions.find(0x3000)?.name, 'stack-2');
});

test('access is checked against the region that holds it', ()=>{
    const regions = mapWithCode();

    regions.assert(0x2000, 4, 'write');
    regions.assert(0x1000, 4, 'execute');

    assert.throws(()=>regions.assert(0x1000, 4, 'write'), /does not permit write/,
        'thunk code is executable and read-only; writing to it is corruption');
    assert.throws(()=>regions.assert(0x2000, 4, 'execute'), /does not permit execute/);
    assert.throws(()=>regions.assert(0x9000, 4, 'read'), /Unmapped read/);
});

test('protect tightens a region after it has been filled in', ()=>{
    const regions = createRegionMap();
    regions.register({
        name: 'thunks', base: 0x1000, size: 0x100,
        kind: RegionKind.THUNK_CODE, access: Access.READ_WRITE_EXECUTE,
    });

    regions.assert(0x1000, 4, 'write');
    regions.protect('thunks', Access.READ_EXECUTE);
    assert.throws(()=>regions.assert(0x1000, 4, 'write'), /does not permit write/,
        'stubs are written once at setup; a later write would rewrite what the guest calls');
    regions.assert(0x1000, 4, 'execute');

    assert.throws(()=>regions.protect('nope', Access.READ), /No region named/);
});

test('a span may not run past its region, even into an adjacent one', ()=>{
    const regions = createRegionMap();
    regions.register({
        name: 'first', base: 0x1000, size: 0x100,
        kind: RegionKind.THUNK_DATA, access: Access.READ_WRITE,
    });
    regions.register({
        name: 'second', base: 0x1100, size: 0x100,
        kind: RegionKind.THUNK_DATA, access: Access.READ_WRITE,
    });

    regions.assert(0x10fc, 4, 'read');
    assert.throws(()=>regions.assert(0x10fe, 4, 'read'), /runs past the end of region "first"/,
        'adjacency is a coincidence of layout, not permission to span both');
});

test('typed accessors round-trip little-endian values', ()=>{
    const raw = fakeMemory();
    const accessors = createAccessors({ raw, regions: mapWithCode() });

    accessors.writeU32(0x2000, 0xcafebabe);
    assert.equal(accessors.readU32(0x2000), 0xcafebabe);
    assert.deepEqual([...raw.bytes.slice(0x2000, 0x2004)], [0xbe, 0xba, 0xfe, 0xca],
        'little-endian on the wire, as the guest reads it');

    accessors.writeU16(0x2010, 0xb077);
    assert.equal(accessors.readU16(0x2010), 0xb077);
    accessors.writeU8(0x2020, 0xf4);
    assert.equal(accessors.readU8(0x2020), 0xf4);

    // 0x80000000 and up must survive as unsigned.
    accessors.writeU32(0x2030, 0xffffffff);
    assert.equal(accessors.readU32(0x2030), 0xffffffff);
});

test('a region map hits its cache alternating between two regions, not one', ()=>{
    const regions = createRegionMap();
    regions.register({
        name: 'stack', base: 0x1000, size: 0x100,
        kind: RegionKind.STACK, access: Access.READ_WRITE,
    });
    regions.register({
        name: 'teb', base: 0x2000, size: 0x100,
        kind: RegionKind.THUNK_DATA, access: Access.READ_WRITE,
    });

    regions.find(0x1010);
    regions.find(0x2010);
    // A one-entry cache would miss on both of these, since each lookup evicted
    // the other region; a two-entry one answers both from cache.
    regions.find(0x1020);
    regions.find(0x2020);

    assert.equal(regions.scans, 2, 'each region was walked for once, not four times');
});

test('accessors refuse what the region map refuses', ()=>{
    const raw = fakeMemory();
    const accessors = createAccessors({ raw, regions: mapWithCode() });

    assert.throws(()=>accessors.writeU32(0x1000, 1), /does not permit write/);
    assert.throws(()=>accessors.readU32(0x9000), /Unmapped read/);
    assert.throws(()=>accessors.readU32(0x2ffe), /runs past the end/);

    // Nothing was written by the rejected calls.
    assert.deepEqual([...raw.bytes.slice(0x1000, 0x1004)], [0, 0, 0, 0]);
});

test('a dword read alternating between the stack and the TEB hits the cache both times', ()=>{
    // A host call reads its own stack and the TEB beside it in the same
    // crossing, over and over; a cache that only remembers one region misses
    // on every single dword this pattern reads.
    const bytes = new Uint8Array(0x3000);
    const view = new DataView(bytes.buffer);
    const raw = {
        readPhysical: (/** @type {number} */ address, /** @type {number} */ length)=>
            bytes.slice(address, address + length),
        writePhysical: (/** @type {number} */ address, /** @type {Uint8Array} */ data)=>
            bytes.set(data, address),
        readU32: (/** @type {number} */ address)=>view.getUint32(address, true),
    };
    const regions = createRegionMap();
    regions.register({
        name: 'stack', base: 0x1000, size: 0x100,
        kind: RegionKind.STACK, access: Access.READ_WRITE,
    });
    regions.register({
        name: 'teb', base: 0x2000, size: 0x100,
        kind: RegionKind.THUNK_DATA, access: Access.READ_WRITE,
    });
    const accessors = createAccessors({ raw, regions });

    accessors.readU32(0x1010);
    accessors.readU32(0x2010);
    accessors.readU32(0x1020);
    accessors.readU32(0x2020);

    assert.equal(regions.scans, 2, 'the stack and the TEB were each validated once');
});

test('a call\'s stack, TEB and data are each validated once, until a permission moves', ()=>{
    // A host call reads its arguments off the stack, its last error out of
    // the TEB and its string out of the image: three regions in turn, which a
    // two-entry cache missed on every read.
    const bytes = new Uint8Array(0x4000);
    const view = new DataView(bytes.buffer);
    const raw = {
        readPhysical: (/** @type {number} */ address, /** @type {number} */ length)=>
            bytes.subarray(address, address + length),
        writePhysical: (/** @type {number} */ address, /** @type {Uint8Array} */ data)=>
            bytes.set(data, address),
        readU32: (/** @type {number} */ address)=>view.getUint32(address, true),
    };
    const regions = createRegionMap();
    /** @type {[string, number][]} */
    const layout = [['stack', 0x1000], ['teb', 0x2000], ['data', 0x3000]];
    for (const [name, base] of layout)
    {
        regions.register({ name, base, size: 0x100, kind: RegionKind.THUNK_DATA,
            access: Access.READ_WRITE });
    }
    let asked = 0;
    const assertSpan = regions.assert;
    regions.assert = (...args)=>{
        asked++;
        return assertSpan.apply(regions, args);
    };
    const accessors = createAccessors({ raw, regions });
    for (let turn = 0; turn < 4; turn++)
    {
        accessors.readU32(0x1010);
        accessors.readU32(0x2010);
        accessors.readU32(0x3010);
    }
    assert.equal(asked, 3, 'each of the three validated once');
    const version = regions.version;
    regions.protect('data', Access.READ);
    assert.equal(regions.version, version + 1);
    accessors.readU32(0x3010);
    assert.equal(asked, 4, 'a changed table is asked again');
});

test('a read is a snapshot, not a window onto guest memory', ()=>{
    const raw = fakeMemory();
    const accessors = createAccessors({ raw, regions: mapWithCode() });
    accessors.writeBytes(0x2000, new Uint8Array([1, 2, 3, 4]));

    const before = accessors.readBytes(0x2000, 4);
    accessors.writeBytes(0x2000, new Uint8Array([9, 9, 9, 9]));

    // The emulator hands back a subarray of its own memory. A caller holding
    // one has a value that changes under it -- read two ranges, write one, and
    // the other has silently moved, which is how a swap turns into a copy.
    assert.deepEqual([...before], [1, 2, 3, 4]);
});

test('C strings are read up to the NUL, and a missing one is an error', ()=>{
    const raw = fakeMemory();
    const accessors = createAccessors({ raw, regions: mapWithCode() });

    accessors.writeBytes(0x2100, new Uint8Array([0x4b, 0x33, 0x32, 0x00, 0x99]));
    assert.equal(accessors.readCString(0x2100, 0x10), 'K32');

    accessors.writeBytes(0x2200, new Uint8Array(8).fill(0x41));
    assert.throws(()=>accessors.readCString(0x2200, 8), /No NUL within 8 bytes/);
});

test('a string read copies the string, not the region it sits in', ()=>{
    // A limit is how far the caller will look, not how long the string is, and
    // the two differ by orders of magnitude: a name read with a megabyte of
    // headroom must not copy a megabyte. Counting what the scan asks memory for
    // is the only way to see it from outside, since the answer is the same.
    const size = 0x100000;
    const bytes = new Uint8Array(size);
    let asked = 0;
    const raw = {
        /** @param {number} address @param {number} length */
        readPhysical: (address, length)=>{
            asked += length;
            return bytes.subarray(address, address + length);
        },
        /** @param {number} address @param {Uint8Array} data */
        writePhysical: (address, data)=>bytes.set(data, address),
    };
    const regions = createRegionMap();
    regions.register({
        name: 'heap', base: 0x1000, size,
        kind: RegionKind.THUNK_DATA, access: Access.READ_WRITE,
    });
    const accessors = createAccessors({ raw, regions });

    bytes.set([0x4b, 0x33, 0x32, 0x00], 0x1000); // "K32"
    asked = 0;
    assert.equal(accessors.readCString(0x1000, size), 'K32');
    assert.ok(asked < 0x1000,
        `a four-byte string is found without copying the region: ${asked} bytes read`);

    // A string longer than one chunk is still read whole, a wide one the same
    // way, and a terminator missing within the limit is still the error it was.
    bytes.set(new Uint8Array(600).fill(0x41), 0x2000);
    assert.equal(accessors.readCString(0x2000, size).length, 600);
    bytes.set([0x41, 0x00, 0x42, 0x00, 0x00, 0x00], 0x4000); // "AB" as UTF-16LE
    assert.equal(accessors.readWideString(0x4000, size), 'AB');
    assert.throws(()=>accessors.readCString(0x2000, 8), /No NUL within 8 bytes/);
});

test('a scan answers from the chunks it walked, not the string behind them', ()=>{
    // The C functions whose answer is a position -- a span, a search -- ask
    // where the first byte they care about is. Counting what the scan asks
    // memory for is the only way to see from outside that the megabyte behind
    // the answer was never copied.
    const size = 0x100000;
    const bytes = new Uint8Array(size);
    let asked = 0;
    const raw = {
        /** @param {number} address @param {number} length */
        readPhysical: (address, length)=>{
            asked += length;
            return bytes.subarray(address, address + length);
        },
        /** @param {number} address @param {Uint8Array} data */
        writePhysical: (address, data)=>bytes.set(data, address),
    };
    const regions = createRegionMap();
    regions.register({
        name: 'heap', base: 0x1000, size: size - 0x1000,
        kind: RegionKind.THUNK_DATA, access: Access.READ_WRITE,
    });
    const accessors = createAccessors({ raw, regions });

    // A megabyte of 'a' whose first interesting byte is the fourth.
    bytes.fill(0x61, 0x1000);
    bytes.set([0x20, 0x20, 0x20, 0x78], 0x1000); // "   x"
    const wanted = new Uint8Array(256);
    wanted[0x78] = 1;

    asked = 0;
    const found = accessors.scanCString(0x1000, size, wanted);
    assert.deepEqual(found, { index: 3, byte: 0x78 });
    assert.ok(asked < 0x1000,
        `the answer at byte 3 is found without reading the megabyte: ${asked} bytes`);

    // Without a table only the terminator stops the walk, and the index it
    // stops at is the string's length; a terminator missing within the limit
    // is the error a read of the same string would have been.
    bytes[0x1000 + 600] = 0;
    assert.equal(accessors.scanCString(0x1000, size).index, 600);
    bytes[0x1000 + 600] = 0x61;
    assert.throws(()=>accessors.scanCString(0x1000, 8), /No NUL within 8 bytes/);

    // A string whose terminator is the region's last byte is found: the walk
    // is clamped to the region, so the chunk holding the end never reads past
    // it, exactly as the string read's walk is.
    const end = 0x1000 + (size - 0x1000) - 1;
    bytes[end] = 0;
    assert.equal(accessors.scanCString(end - 3, size).index, 3);
});

test('a dword read remembers its region and forgets it when the map changes', ()=>{
    // Nearly every dword a host call reads falls in the region the last one
    // did, so the region is remembered -- but a region added or re-protected
    // after that read has to be seen, and the remembered span never lets a
    // read run past its end.
    const raw = fakeMemory();
    const view = new DataView(raw.bytes.buffer);
    /** @type {any} */ (raw).readU32 =
        (/** @type {number} */ address)=>view.getUint32(address, true);
    const regions = mapWithCode();
    const accessors = createAccessors({ raw, regions });
    view.setUint32(0x2000, 1, true);
    view.setUint32(0x2ffc, 2, true);
    assert.equal(accessors.readU32(0x2000), 1);
    assert.equal(accessors.readU32(0x2ffc), 2, 'the last dword of the remembered region');
    assert.throws(()=>accessors.readU32(0x2ffe), /runs past/, 'straddling its end is refused');
    assert.throws(()=>accessors.readU32(0x3000), /Unmapped/);

    regions.register({
        name: 'more', base: 0x3000, size: 0x1000,
        kind: RegionKind.THUNK_DATA, access: Access.READ_WRITE,
    });
    view.setUint32(0x3000, 7, true);
    assert.equal(accessors.readU32(0x3000), 7, 'a region added after the last read is found');
    assert.equal(accessors.readU32(0x2000), 1, 'and the earlier one still is');
    regions.protect('data', Access.NONE);
    assert.throws(()=>accessors.readU32(0x2000), /does not permit/,
        'a region re-protected after being remembered is asked again');
});

test('a read of bytes remembers its region the way a dword read does', ()=>{
    const raw = fakeMemory();
    const regions = mapWithCode();
    const accessors = createAccessors({ raw, regions });
    raw.bytes.set([1, 2, 3, 4], 0x2000);
    assert.deepEqual([...accessors.readBytes(0x2000, 4)], [1, 2, 3, 4]);
    assert.deepEqual([...accessors.readBytes(0x2ffc, 4)], [0, 0, 0, 0], 'to the end of the region');
    assert.throws(()=>accessors.readBytes(0x2ffe, 4), /runs past/, 'not past it');
    assert.throws(()=>accessors.readBytes(0x3000, 4), /Unmapped/);
    regions.register({
        name: 'more', base: 0x3000, size: 0x1000,
        kind: RegionKind.THUNK_DATA, access: Access.READ_WRITE,
    });
    raw.bytes.set([5, 6], 0x3000);
    assert.deepEqual([...accessors.readBytes(0x3000, 2)], [5, 6], 'a region added later is found');
    regions.protect('data', Access.NONE);
    assert.throws(()=>accessors.readBytes(0x2000, 4), /does not permit/,
        'a region re-protected after being remembered is asked again');
});

test('a fill covers exactly its range, unaligned and across a page boundary', ()=>{
    const raw = machineMemory();
    const accessors = createAccessors({ raw, regions: mapWithPages() });

    // From partway through one page to partway through the third, so neither
    // end is where a page-at-a-time implementation would have put it.
    const from = 0x4ffd;
    const length = 0x1006;
    accessors.fillBytes(from, 0xa5, length);

    assert.equal(raw.bytes[from - 1], 0, 'the byte before the range is not part of it');
    assert.equal(raw.bytes[from + length], 0, 'nor the byte after');
    assert.ok(raw.bytes.subarray(from, from + length).every(byte=>byte === 0xa5),
        'and everything between is filled');

    accessors.fillBytes(from, 0, 0);
    accessors.fillBytes(from, 0, -1);
    assert.equal(raw.bytes[from], 0xa5, 'an empty range writes nothing');
});

test('a fill is charged once, for the bytes the equivalent write would be', ()=>{
    const raw = machineMemory();
    /** @type {number[]} */
    const charges = [];
    const accessors = createAccessors({
        raw, regions: mapWithPages(), charge: length=>charges.push(length),
    });

    accessors.fillBytes(0x4001, 0xff, 0x1234);
    accessors.writeBytes(0x4001, new Uint8Array(0x1234).fill(0xff));

    assert.deepEqual(charges, [0x1234, 0x1234],
        'one charge for the range, the same size the write costs -- not one per byte or page');
});

test('a fill over executable memory goes the way a write there does', ()=>{
    const raw = machineMemory();
    const regions = mapWithPages();
    const accessors = createAccessors({ raw, regions });

    // Whatever the emulator has translated for a page it may execute has to be
    // discarded, and the write path is what discards it. A fill that went
    // straight into memory there would leave the old translation running.
    accessors.writeBytes(0x8000, new Uint8Array(16).fill(0x90));
    accessors.fillBytes(0x8010, 0x90, 16);
    assert.deepEqual(raw.took, ['writePhysical', 'writePhysical']);

    raw.took.length = 0;
    accessors.writeBytes(0x4000, new Uint8Array(16));
    accessors.fillBytes(0x4010, 0, 16);
    assert.deepEqual(raw.took, ['writeData', 'fillData'],
        'data has nothing to tell the compiler, so it is filled in place');
});

test('a fill still fills where the memory offers no fill of its own', ()=>{
    // A build whose memory is a plain buffer: the primitive is on the memory
    // layer's interface either way, and falls back to the write path.
    const raw = fakeMemory();
    const accessors = createAccessors({ raw, regions: mapWithPages() });

    accessors.fillBytes(0x4008, 0x7e, 8);
    assert.deepEqual([...raw.bytes.subarray(0x4006, 0x4012)],
        [0, 0, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0, 0]);
});

test('readU32sInto validates the whole span once and reads without an intermediate view', ()=>{
    const bytes = new Uint8Array(0x3000);
    const view = new DataView(bytes.buffer);
    const raw = {
        readPhysical: (/** @type {number} */ address, /** @type {number} */ length)=>
            bytes.slice(address, address + length),
        writePhysical: (/** @type {number} */ address, /** @type {Uint8Array} */ data)=>
            bytes.set(data, address),
        readU32: (/** @type {number} */ address)=>view.getUint32(address, true),
    };
    const regions = mapWithCode();
    const accessors = createAccessors({ raw, regions });
    view.setUint32(0x2000, 10, true);
    view.setUint32(0x2004, 20, true);
    view.setUint32(0x2008, 30, true);

    /** @type {number[]} */
    const into = new Array(3);
    accessors.readU32sInto(0x2000, 3, into);

    assert.deepEqual(into, [10, 20, 30]);
    assert.equal(regions.scans, 1, 'one span check for the whole read, not one per word');
});

test('readU32sInto writes into the array at the given offset, for a call\'s ecx already there',
    ()=>{
        const raw = fakeMemory();
        const accessors = createAccessors({ raw, regions: mapWithCode() });
        accessors.writeU32(0x2000, 10);
        accessors.writeU32(0x2004, 20);

        /** @type {number[]} */
        const into = [0x401000, 0, 0];
        accessors.readU32sInto(0x2000, 2, into, 1);

        assert.deepEqual(into, [0x401000, 10, 20]);
    });

test('readU32sInto falls back to per-word reads across a region boundary, answering the same '
    + 'words the whole-span path would', ()=>{
    const raw = fakeMemory();
    const regions = createRegionMap();
    regions.register({
        name: 'first', base: 0x1000, size: 8,
        kind: RegionKind.THUNK_DATA, access: Access.READ_WRITE,
    });
    regions.register({
        name: 'second', base: 0x1008, size: 8,
        kind: RegionKind.THUNK_DATA, access: Access.READ_WRITE,
    });
    const accessors = createAccessors({ raw, regions });
    accessors.writeU32(0x1004, 11); // the last word of "first"
    accessors.writeU32(0x1008, 22); // the first word of "second"

    /** @type {number[]} */
    const into = new Array(2);
    accessors.readU32sInto(0x1004, 2, into); // spans the boundary between the two regions

    assert.deepEqual(into, [11, 22],
        'the same words a per-word read gets, even though the span crosses a region');
});

test('readU32sInto refuses an unmapped word with the same error readU32 gives', ()=>{
    const raw = fakeMemory();
    const accessors = createAccessors({ raw, regions: mapWithCode() });

    assert.throws(()=>accessors.readU32sInto(0x9000, 1, [0]), /Unmapped read/);
    assert.throws(()=>accessors.readU32(0x9000), /Unmapped read/);
});

test('readF32sInto decodes floats through raw.readF32 with one span check', ()=>{
    const bytes = new Uint8Array(0x3000);
    const view = new DataView(bytes.buffer);
    const raw = {
        readPhysical: (/** @type {number} */ address, /** @type {number} */ length)=>
            bytes.slice(address, address + length),
        writePhysical: (/** @type {number} */ address, /** @type {Uint8Array} */ data)=>
            bytes.set(data, address),
        readF32: (/** @type {number} */ address)=>view.getFloat32(address, true),
    };
    const regions = mapWithCode();
    const accessors = createAccessors({ raw, regions });
    view.setFloat32(0x2000, 1.5, true);
    view.setFloat32(0x2004, -2.25, true);

    /** @type {number[]} */
    const into = new Array(2);
    accessors.readF32sInto(0x2000, 2, into);

    assert.deepEqual(into, [1.5, -2.25]);
    assert.equal(regions.scans, 1, 'one span check for the whole read, not one per word');
});

test('readF32sInto falls back without raw.readF32, decoding the same bits readU32 would', ()=>{
    const raw = fakeMemory();
    const accessors = createAccessors({ raw, regions: mapWithCode() });
    accessors.writeU32(0x2000, 0x3fc00000); // the bits of 1.5 as an IEEE float

    /** @type {number[]} */
    const into = [0];
    accessors.readF32sInto(0x2000, 1, into);

    assert.equal(into[0], 1.5);
});

test('a fill is refused where the region map refuses a write', ()=>{
    const raw = machineMemory();
    const accessors = createAccessors({ raw, regions: mapWithPages() });

    assert.throws(()=>accessors.fillBytes(0x3000, 1, 4), /Unmapped write/);
    assert.throws(()=>accessors.fillBytes(0x7ff8, 1, 16), /runs past the end/);
    assert.deepEqual(raw.took, [], 'and nothing was written by either');
});
