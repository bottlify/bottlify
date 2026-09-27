/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OBJREF_BYTES, decodeObjref, encodeObjref } from './objref.js';
import { parseGuid } from './guid.js';

const IID = /** @type {Uint8Array} */ (parseGuid('{8C5E2F10-4B1D-4E7A-9A61-3D2F0C9B7E01}'));

test('an OBJREF is DCOM\'s standard packet, naming the exporter and the object', ()=>{
    const bytes = encodeObjref(IID, { endpoint: 3, object: 0x11 });
    const view = new DataView(bytes.buffer);
    assert.equal(bytes.length, OBJREF_BYTES);
    assert.deepEqual([...bytes.subarray(0, 4)], [0x4d, 0x45, 0x4f, 0x57], "'MEOW'");
    assert.equal(view.getUint32(4, true), 1, 'OBJREF_STANDARD');
    assert.deepEqual([...bytes.subarray(8, 24)], [...IID]);
    assert.equal(view.getUint32(28, true), 1, 'one public reference');
    assert.equal(view.getBigUint64(32, true), 3n, 'the OXID is the exporting process');
    assert.equal(view.getBigUint64(40, true), 0x11n, 'the OID its object');
    assert.deepEqual([view.getUint16(64, true), view.getUint16(66, true)], [2, 1],
        'a binding array of two empty lists');

    assert.deepEqual(decodeObjref(bytes), { iid: IID, reference: { endpoint: 3, object: 0x11 } });
});

test('bytes that are not a standard OBJREF are not read as one', ()=>{
    const bytes = encodeObjref(IID, { endpoint: 1, object: 1 });
    assert.equal(decodeObjref(bytes.subarray(0, 40)), null, 'too short');
    const custom = bytes.slice();
    custom[4] = 4;
    assert.equal(decodeObjref(custom), null, 'OBJREF_CUSTOM');
    const signed = bytes.slice();
    signed[0] = 0;
    assert.equal(decodeObjref(signed), null);
});
