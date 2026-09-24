/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFault, hostFault, readFault, HOST_VECTOR } from './faults.js';
import { DEAD_BOOT_CODE, FAULT_SAVED, GUEST_JUMP, ROM_BASE } from './boot-rom.js';

/** Where the stub stands: below the two registers it saved, under the frame at 0x1000. */
const STUB_ESP = 0x1000 - FAULT_SAVED;

/** A frame as the stub finds it: the words the processor pushed, then the caller's. */
const frame = (/** @type {number[]} */ words)=>
    (/** @type {number} */ address)=>words[(address - 0x1000) / 4] ?? 0;

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

test('a breakpoint inside the retired boot code is an excursion into the ROM', ()=>{
    // The trap frame names the byte after the int3, so the last byte of the
    // init code is reported one past its end -- and must still count.
    const init = DEAD_BOOT_CODE[0];
    for (const entered of [ROM_BASE + init.offset, ROM_BASE + init.offset + init.length - 1])
    {
        const fault = readFault(3, STUB_ESP, frame([entered + 1, 0x08, 0x2, 0x00401000]));
        assert.equal(describeFault(fault),
            `guest jumped into the boot ROM at 0x${(entered + 1).toString(16).padStart(8, '0')},`
            + ' called from 0x00401000');
    }
});

test('a fault on the live jump into guest code is not called an excursion', ()=>{
    // The prologue before it is retired; the jump itself is what `run()`
    // performs, and a fault there is that instruction's own.
    const fault = readFault(6, STUB_ESP, frame([GUEST_JUMP, 0x08, 0x2, 0]));
    assert.equal(describeFault(fault),
        `invalid opcode at 0x${GUEST_JUMP.toString(16).padStart(8, '0')}`);
});

test('a processor exception elsewhere reads as before', ()=>{
    assert.equal(describeFault(readFault(6, STUB_ESP, frame([0x401000, 0x08, 0x2, 0]))),
        'invalid opcode at 0x00401000');
    assert.equal(describeFault(readFault(6, STUB_ESP, frame([0x10, 0x08, 0x2, 0x401005]))),
        'invalid opcode at 0x00000010, called from 0x00401005',
        'a jump to nowhere names the call that made it');
    assert.equal(describeFault(readFault(14, STUB_ESP, frame([0x2, 0x401000, 0x08, 0x2]))),
        'page fault at 0x00401000: writing, not present');
});
