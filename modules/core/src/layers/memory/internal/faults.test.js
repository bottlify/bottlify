/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Access, RegionKind, createRegionMap } from './regions.js';
import { createAccessors } from './accessors.js';
import { GUEST_ACCESS, UNTERMINATED } from './faults.js';
import { threadCpuMs } from '../../../../../../tools/cpu-time.mjs';

function setup(){
    const bytes = new Uint8Array(0x4000);
    const raw = {
        /** @param {number} address @param {number} length */
        readPhysical: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writePhysical: (address, data)=>bytes.set(data, address),
    };
    const regions = createRegionMap();
    regions.register({ name: 'code', base: 0x1000, size: 0x1000,
        kind: RegionKind.THUNK_CODE, access: Access.READ_EXECUTE });
    regions.register({ name: 'data', base: 0x2000, size: 0x1000,
        kind: RegionKind.STACK, access: Access.READ_WRITE });
    return { bytes, regions, accessors: createAccessors({ raw, regions }) };
}

/** @param {() => unknown} call */
const caught = call=>{
    try
    {
        call();
    }
    catch (e){
        return /** @type {any} */ (e);
    }
    assert.fail('did not throw');
};

test('a refused access is a fault that names the address, length and mode', ()=>{
    const { regions, accessors } = setup();
    const unmapped = caught(()=>accessors.readU32(0));
    assert.deepEqual([unmapped.code, unmapped.address, unmapped.length, unmapped.mode],
        [GUEST_ACCESS, 0, 4, 'read']);
    const readOnly = caught(()=>regions.assert(0x1000, 1, 'write'));
    assert.deepEqual([readOnly.code, readOnly.address, readOnly.mode],
        [GUEST_ACCESS, 0x1000, 'write']);
    // Past the end, the first byte refused is the region's end, not the start.
    const past = caught(()=>regions.assert(0x2ffe, 4, 'read'));
    assert.deepEqual([past.code, past.address], [GUEST_ACCESS, 0x3000]);
});

test('a string longer than the limit is unterminated; one cut by its region is a fault', ()=>{
    const { bytes, accessors } = setup();
    bytes.fill(0x61, 0x2000, 0x3000);
    bytes[0x2100] = 0;
    assert.equal(accessors.readCString(0x2000, 0x101), 'a'.repeat(0x100));
    const long = caught(()=>accessors.readCString(0x2000, 0x100));
    assert.deepEqual([long.code, long.limit], [UNTERMINATED, 0x100]);
    const scanned = caught(()=>accessors.scanCString(0x2000, 0x10));
    assert.equal(scanned.code, UNTERMINATED);

    // No terminator before the region ends: the byte after it is what a
    // processor would refuse.
    const cut = caught(()=>accessors.readCString(0x2f00, 0x1000));
    assert.deepEqual([cut.code, cut.address], [GUEST_ACCESS, 0x3000]);
    const wideCut = caught(()=>accessors.readWideString(0x2f00, 0x1000));
    assert.deepEqual([wideCut.code, wideCut.address], [GUEST_ACCESS, 0x3000]);
    const wideLong = caught(()=>accessors.readWideString(0x2000, 0x10));
    assert.equal(wideLong.code, UNTERMINATED);
    assert.equal(caught(()=>accessors.readCString(0, 16)).code, GUEST_ACCESS);
});

test('a fill of a span that is not there is refused before a buffer is made of it', ()=>{
    const { accessors } = setup();
    // This thread's processor time, which other processes on the machine do
    // not stretch: filling 3.7 GB takes seconds of it.
    const started = threadCpuMs();
    const refused = caught(()=>accessors.fillBytes(0xdeadbeef, 0, 0xdeadbeef));
    assert.deepEqual([refused.code, refused.mode], [GUEST_ACCESS, 'write']);
    assert.ok(threadCpuMs() - started < 100, 'no 3.7 GB buffer on the way');
});
