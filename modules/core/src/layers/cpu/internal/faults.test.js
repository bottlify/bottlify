/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFault, exceptionName, hostFault, HOST_VECTOR } from './faults.js';

/**
 * A processor exception's record, as the engine builds one from a fault exit.
 *
 * @param {number} vector @param {number} eip @param {number | null} [errorCode]
 * @param {number} [calledFrom]
 * @returns {import('./faults.js').GuestFault}
 */
const exception = (vector, eip, errorCode = null, calledFrom = 0)=>({
    vector, name: exceptionName(vector), eip, cs: 0x08, eflags: 0x2, errorCode, calledFrom,
});

test('a fault the host raised reads as the sentence it was given', ()=>{
    const fault = hostFault({
        name: 'unimplemented import',
        detail: 'unimplemented import KERNEL32.dll!NoSuchExport, called from 0x00401234',
        eip: 0x401234,
        calledFrom: 0x401234,
    });

    assert.equal(fault.vector, HOST_VECTOR, 'outside the processor\'s table');
    assert.equal(fault.errorCode, null);
    assert.equal(describeFault(fault),
        'unimplemented import KERNEL32.dll!NoSuchExport, called from 0x00401234');
});

test('a stand-in for an exception the processor could not deliver keeps its vector', ()=>{
    const fault = hostFault({
        vector: 8, errorCode: 0, name: 'double fault', eip: 0xf001c,
        detail: 'double fault at 0x000f001c: a page fault at 0x00000ff8 while delivering a fault',
    });
    assert.equal(fault.vector, 8);
    assert.equal(fault.errorCode, 0);
    assert.match(describeFault(fault), /^double fault at 0x000f001c/);
});

test('a processor exception reads as its name and where', ()=>{
    assert.equal(describeFault(exception(6, 0x401000)), 'invalid opcode at 0x00401000');
    assert.equal(describeFault(exception(6, 0x10, null, 0x401005)),
        'invalid opcode at 0x00000010, called from 0x00401005',
        'a jump to nowhere names the call that made it');
    assert.equal(describeFault(exception(14, 0x401000, 2)),
        'page fault at 0x00401000: writing, not present');
    assert.equal(describeFault(exception(13, 0x401000, 0x10)),
        'general protection at 0x00401000, error code 0x10');
});
