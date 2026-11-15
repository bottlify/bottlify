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
