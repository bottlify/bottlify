/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMfKit } from './kit.js';
import { guestOver } from '../common/guest.fixture.js';

const E_NOINTERFACE = 0x80004002 | 0;
const IID_THING = '{12345678-1234-1234-1234-123456789ABC}';

test('in a 64-bit process an object\'s pointer is written out whole, NULL over all of it', ()=>{
    const bytes = new Uint8Array(0x1000);
    const guest = guestOver(bytes, 8);
    const POINTER = 0x1_0000_2000;
    /** @type {any} */
    let made = null;
    const kit = createMfKit(/** @type {any} */ ({ guest,
        heap: { allocate: ()=>0, free: ()=>{} },
        vtables: { publish: ()=>POINTER, unpublish: ()=>true },
        objectAt: (/** @type {number} */ pointer)=>(pointer === POINTER ? made : null) }));
    made = kit.make({ primary: { id: IID_THING, methods: [] }, state: {} });
    const OUT = 0x100;
    assert.equal(kit.give(OUT, made), 0);
    assert.equal(guest.ptr(OUT), POINTER);
    guest.setBytes(0x200, Uint8Array.from([0x78, 0x56, 0x34, 0x12, 0x34, 0x12, 0x34, 0x12,
        0x12, 0x34, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbd]));
    guest.setIptr(OUT, -1);
    assert.equal(kit.query(POINTER, 0x200, OUT, null), E_NOINTERFACE);
    assert.equal(guest.ptr(OUT), 0, 'NULL, both dwords');
});
