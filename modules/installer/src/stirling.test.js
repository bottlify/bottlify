/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { explode, isStirlingArchive, readStirling } from './stirling.js';

// The format's published example: coded-literal flag 0, a 1 KB dictionary,
// "AI" as two stored literals and then one long match back two bytes.
const AIAI = Uint8Array.from([0x00, 0x04, 0x82, 0x24, 0x25, 0x8f, 0x80, 0x7f]);

test('explode unpacks stored literals and a match over its own output', ()=>{
    assert.equal(Buffer.from(explode(AIAI)).toString('latin1'), 'AIAIAIAIAIAIA');
    assert.equal(explode(AIAI, 13).length, 13);
});

test('explode refuses a size other than the one it was told', ()=>{
    assert.throws(()=>explode(AIAI, 12), /13 bytes, not 12/);
});

test('explode refuses a stream with no end code and a header out of range', ()=>{
    assert.throws(()=>explode(AIAI.subarray(0, 5)), /ends before its end code/);
    assert.throws(()=>explode(Uint8Array.from([2, 4, 0])), /not an implode stream/);
    assert.throws(()=>explode(Uint8Array.from([0, 7, 0])), /not an implode stream/);
});

/**
 * A container as the setup launcher's engine archive lays it out.
 * @param {{ name: string, stored: string, packed: Uint8Array, size: number }[]} members
 */
function container(members){
    const names = members.map(m=>4 + m.name.length + m.stored.length);
    const table = 0x52 + members.reduce((sum, _, n)=>sum + 20 + names[n], 0);
    const total = table + members.reduce((sum, m)=>sum + m.packed.length, 0);
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    bytes.set([0x2a, 0xab, 0x79, 0xd8, 0, 1, 0, 0]);
    bytes.set(Buffer.from('Copyright (c) 1990-1995 Stirling Technologies, Inc. '
        + 'All Rights Reserve'), 8);
    view.setUint32(0x4e, members.length, true);
    let at = 0x52;
    let data = table;
    for (const member of members)
    {
        view.setUint32(at, data, true);
        view.setUint32(at + 4, member.packed.length, true);
        view.setUint32(at + 8, member.size, true);
        at += 20;
        for (const text of [member.name, member.stored])
        {
            view.setUint16(at, text.length, true);
            bytes.set(Buffer.from(text, 'latin1'), at + 2);
            at += 2 + text.length;
        }
        bytes.set(member.packed, data);
        data += member.packed.length;
    }
    return bytes;
}

test('readStirling gives each member under both its names, unpacked', ()=>{
    const bytes = container([
        { name: 'INSTALL.EXE', stored: '_INS5176._MP', packed: AIAI, size: 13 },
        { name: 'ZDATA.DLL', stored: 'ZDataI51.dll', packed: AIAI, size: 13 },
    ]);
    assert.ok(isStirlingArchive(bytes));
    const members = readStirling(bytes);
    assert.deepEqual(members.map(m=>[m.name, m.stored]),
        [['INSTALL.EXE', '_INS5176._MP'], ['ZDATA.DLL', 'ZDataI51.dll']]);
    assert.equal(Buffer.from(members[1].bytes).toString('latin1'), 'AIAIAIAIAIAIA');
});

test('readStirling refuses other bytes and a member past the end', ()=>{
    assert.equal(isStirlingArchive(Uint8Array.from([0x4d, 0x5a, 0, 0])), false);
    assert.throws(()=>readStirling(Uint8Array.from([0x4d, 0x5a, 0, 0])), /not a Stirling/);
    const bytes = container([{ name: 'A', stored: 'B', packed: AIAI, size: 13 }]);
    assert.throws(()=>readStirling(bytes.subarray(0, bytes.length - 1)), /past the end/);
});
