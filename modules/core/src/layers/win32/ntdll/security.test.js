/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecurityFunctions } from './security.js';

const TEB = 0x1000;

function setup(){
    const memory = new Uint8Array(0x2000);
    const view = new DataView(memory.buffer);
    /** @type {any[]} */
    const calls = [];
    const advapi32 = {
        GetLengthSid: { argBytes: 4, handler: ()=>12 },
        CopySid: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: args=>{
                calls.push(args);
                // ERROR_INSUFFICIENT_BUFFER, as advapi32 sets it.
                view.setUint32(TEB + 0x34, 122, true);
                return 0;
            },
        },
        AllocateAndInitializeSid: { argBytes: 44, handler: ()=>1 },
    };
    const table = createSecurityFunctions({
        advapi32,
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        teb: ()=>TEB,
    });
    return { table, advapi32, view, calls };
}

test('an Rtl form is advapi32\'s entry, or its error turned back into a status', ()=>{
    const { table, advapi32, view, calls } = setup();
    assert.equal(table.RtlLengthSid, advapi32.GetLengthSid);
    view.setUint32(TEB + 0x34, 0xbeef, true);
    assert.equal(table.RtlCopySid.handler([4, 0x100, 0x200]), 0xc0000023, 'BUFFER_TOO_SMALL');
    assert.deepEqual(calls, [[4, 0x100, 0x200]]);
    assert.equal(view.getUint32(TEB + 0x34, true), 0xbeef, 'the last error left as it was');
    assert.equal(table.RtlAllocateAndInitializeSid.handler([0x10, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0x20]),
        0xc0000078, 'nine subauthorities: STATUS_INVALID_SID');
    assert.equal(table.RtlAllocateAndInitializeSid.handler([0x10, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0x20]),
        0);
});

test('the owner and group come back with a BOOLEAN defaulted, absolute or self-relative', ()=>{
    const { table, view } = setup();
    const SD = 0x300;
    const OUT = 0x400;
    const FLAG = 0x408;
    // Absolute: revision 1, SE_GROUP_DEFAULTED, owner and group pointers.
    view.setUint32(SD, 1 | 0x0002 << 16, true);
    view.setUint32(SD + 4, 0x500, true);
    view.setUint32(SD + 8, 0x600, true);
    view.setUint32(FLAG, 0xaaaaaaaa, true);
    assert.equal(table.RtlGetGroupSecurityDescriptor.handler([SD, OUT, FLAG]), 0);
    assert.equal(view.getUint32(OUT, true), 0x600);
    assert.equal(view.getUint32(FLAG, true), 0xaaaaaa01, 'one byte written, set');
    assert.equal(table.RtlGetOwnerSecurityDescriptor.handler([SD, OUT, FLAG]), 0);
    assert.equal(view.getUint32(OUT, true), 0x500);
    assert.equal(view.getUint8(FLAG), 0, 'the owner is not defaulted');
    // Self-relative: the fields are offsets from the descriptor.
    view.setUint32(SD, 1 | 0x8000 << 16, true);
    view.setUint32(SD + 8, 0x40, true);
    assert.equal(table.RtlGetGroupSecurityDescriptor.handler([SD, OUT, FLAG]), 0);
    assert.equal(view.getUint32(OUT, true), SD + 0x40);
    view.setUint8(SD, 2);
    assert.equal(table.RtlGetGroupSecurityDescriptor.handler([SD, OUT, FLAG]), 0xc0000058,
        'STATUS_UNKNOWN_REVISION');
});

test('RtlFirstFreeAce finds where the next ACE goes, NULL when the ACL is full', ()=>{
    const { table, view } = setup();
    const ACL = 0x800;
    const OUT = 0x900;
    // Revision 2, 32 bytes, one ACE of 16.
    view.setUint32(ACL, 2 | 32 << 16, true);
    view.setUint32(ACL + 4, 1, true);
    view.setUint16(ACL + 8 + 2, 16, true);
    assert.equal(table.RtlFirstFreeAce.handler([ACL, OUT]), 1);
    assert.equal(view.getUint32(OUT, true), ACL + 24);
    view.setUint16(ACL + 2, 24, true);
    assert.equal(table.RtlFirstFreeAce.handler([ACL, OUT]), 1);
    assert.equal(view.getUint32(OUT, true), 0, 'full: no room past the last ACE');
    view.setUint32(ACL + 4, 3, true);
    assert.equal(table.RtlFirstFreeAce.handler([ACL, OUT]), 0, 'ACEs past the end');
    view.setUint8(ACL, 1);
    assert.equal(table.RtlFirstFreeAce.handler([ACL, OUT]), 0, 'no ACL has revision 1');
});
