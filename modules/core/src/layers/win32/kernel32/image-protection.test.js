/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageLayout, sectionProtection } from './image-protection.js';
import { imageHeaders } from './image-protection.fixture.js';

test('a section\'s characteristics give its pages\' protection, writable ones copy-on-write', ()=>{
    const R = 0x40000000;
    const W = 0x80000000;
    const X = 0x20000000;
    const SHARED = 0x10000000;
    assert.deepEqual([0, R, W, R | W, X, R | X, W | X, R | W | X, R | W | SHARED,
        R | W | X | SHARED].map(flags=>sectionProtection(flags >>> 0)),
    [0x01, 0x02, 0x08, 0x08, 0x10, 0x20, 0x80, 0x80, 0x04, 0x40]);
});

test('an image\'s pages are its headers read-only, its sections by theirs, a gap closed', ()=>{
    const headers = imageHeaders(0x5000, [[0x1000, 0x1000, 0x60000020],
        [0x3000, 0x1800, 0xc0000040]]);
    const layout = imageLayout((address, length)=>headers.slice(address, address + length), 0);
    assert.deepEqual(layout, { size: 0x5000, runs: [
        { from: 0, to: 0x1000, protect: 0x02 },
        { from: 0x1000, to: 0x2000, protect: 0x20 },
        { from: 0x2000, to: 0x3000, protect: 0x01 },
        { from: 0x3000, to: 0x5000, protect: 0x08 },
    ] });
    assert.equal(imageLayout(()=>new Uint8Array(64), 0), null, 'no headers, no image');
});
