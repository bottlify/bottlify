/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGuid } from './guid.js';
import {
    FMTID_DOC_SUMMARY_INFORMATION, FMTID_SUMMARY_INFORMATION, FMTID_USER_DEFINED_PROPERTIES,
    createPropertySetFunctions, formatOfName, nameOfFormat,
} from './propset.js';

const IID_IPROPERTYSETSTORAGE = '{0000013A-0000-0000-C000-000000000046}';

test('a property set is stored under its documented name or its FMTID in 26 characters', ()=>{
    // stg_prop.c testFmtId: the two summary sets by name, the user-defined
    // one beside the document summary, and any other FMTID five bits a
    // character, a capital where a byte begins.
    assert.equal(nameOfFormat(FMTID_SUMMARY_INFORMATION), '\x05SummaryInformation');
    assert.equal(nameOfFormat(FMTID_DOC_SUMMARY_INFORMATION), '\x05DocumentSummaryInformation');
    assert.equal(nameOfFormat(FMTID_USER_DEFINED_PROPERTIES), '\x05DocumentSummaryInformation');
    assert.equal(nameOfFormat(IID_IPROPERTYSETSTORAGE), '\x050jaaaaaaAaaaaadaAaaaaaaaGc');
    assert.equal(formatOfName('\x050jaaaaaaAaaaaadaAaaaaaaaGc'), IID_IPROPERTYSETSTORAGE);
    assert.equal(formatOfName('\x050JAAAAAAAAAAAADAAAAAAAAAGC'), IID_IPROPERTYSETSTORAGE,
        'letters of either case');
    assert.equal(formatOfName('\x05DOCUMENTSUMMARYINFORMATION'), FMTID_DOC_SUMMARY_INFORMATION);
    assert.equal(formatOfName('\x05short'), null);
    assert.equal(formatOfName('\x050jaaaaaaAaaaaadaAaaaaaaa!c'), null);
    for (const fmtid of ['{12345678-DEAD-BEEF-0001-020304050607}',
        '{FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF}'])
    {
        assert.equal(formatOfName(nameOfFormat(fmtid)), fmtid);
    }
});

test('FmtIdToPropStgName and PropStgNameToFmtId check their arguments as Windows does', ()=>{
    const bytes = new Uint8Array(0x1000);
    const fns = createPropertySetFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
    });
    const FMTID = 0x100;
    const NAME = 0x200;
    const OUT = 0x300;
    bytes.set(/** @type {Uint8Array} */ (parseGuid(FMTID_SUMMARY_INFORMATION)), FMTID);
    assert.equal(fns.FmtIdToPropStgName.handler([0, NAME]) >>> 0, 0x80070057);
    assert.equal(fns.FmtIdToPropStgName.handler([FMTID, 0]) >>> 0, 0x80070057);
    assert.equal(fns.FmtIdToPropStgName.handler([FMTID, NAME]), 0);
    const units = [...new Uint16Array(bytes.buffer.slice(NAME, NAME + 40))];
    assert.equal(String.fromCharCode(...units.slice(0, units.indexOf(0))),
        '\x05SummaryInformation');

    assert.equal(fns.PropStgNameToFmtId.handler([0, 0]) >>> 0, 0x80070057);
    assert.equal(fns.PropStgNameToFmtId.handler([0, OUT]) >>> 0, 0x800300fc,
        'STG_E_INVALIDNAME');
    assert.equal(fns.PropStgNameToFmtId.handler([NAME, 0]) >>> 0, 0x80070057);
    assert.equal(fns.PropStgNameToFmtId.handler([NAME, OUT]), 0);
    assert.deepEqual(bytes.slice(OUT, OUT + 16), bytes.slice(FMTID, FMTID + 16));
});
