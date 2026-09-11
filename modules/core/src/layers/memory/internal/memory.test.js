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
