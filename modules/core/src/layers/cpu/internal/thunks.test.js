/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStub, createThunkTable, STUB_SIZE } from './thunks.js';

const PORT = 0xb077;

test('a stub raises its trap and returns the way its convention says', ()=>{
    const stdcall = buildStub({ trapId: 3, port: PORT, popBytes: 8 });
    assert.equal(stdcall.length, STUB_SIZE);
    assert.deepEqual([...stdcall.subarray(0, 11)],
        [0x66, 0xba, 0x77, 0xb0, 0xb8, 3, 0, 0, 0, 0xef, 0xc2]);
    assert.deepEqual([...stdcall.subarray(11, 13)], [8, 0], 'ret 8');

    const cdecl = buildStub({ trapId: 3, port: PORT, popBytes: 0 });
    assert.equal(cdecl[10], 0xc3, 'the caller cleans up, so a plain ret');
});

test('a forwarding stub jumps into the real function instead of returning', ()=>{
    // The jump is relative to the byte after it, and the whole preamble is
    // fifteen bytes: ten for the trap and five for the jump itself. Getting
    // this wrong lands in the middle of an instruction, which is not a failure
    // anybody can read afterwards -- so it is checked here rather than found
    // in a guest.
    const address = 0x100200;
    const target = 0x37c49a8;
    const stub = buildStub({ trapId: 7, port: PORT, popBytes: 0, forwardTo: target, address });

    assert.equal(stub[10], 0xe9, 'jmp rel32 where the ret would have been');
    const relative = new DataView(stub.buffer).getInt32(11, true);
    assert.equal(address + 15 + relative, target);
});

test('a forwarding stub keeps its target once the table is written', ()=>{
    const table = createThunkTable({ base: 0x100000, port: PORT });
    const plain = table.register('KERNEL32.dll!Sleep', 4);
    const watch = table.register('Storm.dll!#279', 0, { forwardTo: 0x1cf30 });

    const image = table.image();
    assert.deepEqual([...image.subarray(watch.id * STUB_SIZE, watch.id * STUB_SIZE + STUB_SIZE)],
        [...table.stub(watch.id)],
        'the slot in the table and the slot written later must be the same bytes');
    assert.equal(image[plain.id * STUB_SIZE + 10], 0xc2, 'an ordinary stub still returns');
    assert.deepEqual([...image.subarray(0, 3)], [0xf4, 0xeb, 0xfd], 'slot 0 is the park loop');
});
