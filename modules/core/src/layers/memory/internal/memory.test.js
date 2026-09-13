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

test('accessors refuse what the region map refuses', ()=>{
    const raw = fakeMemory();
    const accessors = createAccessors({ raw, regions: mapWithCode() });

    assert.throws(()=>accessors.writeU32(0x1000, 1), /does not permit write/);
    assert.throws(()=>accessors.readU32(0x9000), /Unmapped read/);
    assert.throws(()=>accessors.readU32(0x2ffe), /runs past the end/);

    // Nothing was written by the rejected calls.
    assert.deepEqual([...raw.bytes.slice(0x1000, 0x1004)], [0, 0, 0, 0]);
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

test('a fill is refused where the region map refuses a write', ()=>{
    const raw = machineMemory();
    const accessors = createAccessors({ raw, regions: mapWithPages() });

    assert.throws(()=>accessors.fillBytes(0x3000, 1, 4), /Unmapped write/);
    assert.throws(()=>accessors.fillBytes(0x7ff8, 1, 16), /runs past the end/);
    assert.deepEqual(raw.took, [], 'and nothing was written by either');
});
