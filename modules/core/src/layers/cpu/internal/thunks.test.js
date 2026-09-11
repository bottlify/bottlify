/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildStub, createThunkTable, DEFAULT_THUNK_CAPACITY, FORWARD_SAVE, STUB_SIZE,
} from './thunks.js';

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
    // sixteen bytes: one to save the registers, ten for the trap and five for
    // the jump itself. Getting this wrong lands in the middle of an
    // instruction, which is not a failure anybody can read afterwards -- so it
    // is checked here rather than found in a guest.
    const address = 0x100200;
    const target = 0x37c49a8;
    const stub = buildStub({ trapId: 7, port: PORT, popBytes: 0, forwardTo: target, address });

    assert.equal(stub[11], 0xe9, 'jmp rel32 where the ret would have been');
    const relative = new DataView(stub.buffer).getInt32(12, true);
    assert.equal(address + 16 + relative, target);
});

test('a forwarding stub saves every register before the trap spends two of them', ()=>{
    // The function it forwards into may take its arguments in ECX and EDX, or
    // in EAX under a compiler's private convention, and the trap sequence
    // writes DX and EAX. Saved with one `pushad`, so the host can put them
    // back; a stub that only preserved the stack would hand a fastcall
    // routine the trap port as its second argument.
    const stub = buildStub({
        trapId: 7, port: PORT, popBytes: 0, forwardTo: 0x37c49a8, address: 0x100200,
    });
    assert.equal(stub[0], 0x60, 'pushad first');
    assert.equal(FORWARD_SAVE, 32, 'eight registers of four bytes');
    assert.deepEqual([...stub.subarray(1, 5)], [0x66, 0xba, PORT & 0xff, PORT >>> 8],
        'then the trap');

    const plain = buildStub({ trapId: 7, port: PORT, popBytes: 0 });
    assert.notEqual(plain[0], 0x60, 'an ordinary stub answers in EAX and saves nothing');
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

test('a full table refuses a slot rather than laying one outside its region', ()=>{
    // Four slots, one of which is the park loop. What follows the region in the
    // running machine is the guest's initial stack, so the slot after the last
    // one is not a slot at all -- it is executable bytes written over the
    // stack, and nothing downstream can tell that from a stub.
    const base = 0x100000;
    const capacity = 4 * STUB_SIZE;
    const table = createThunkTable({ base, port: PORT, capacity });

    const taken = [
        table.register('KERNEL32.dll!Sleep', 4),
        table.register('USER32.dll!PeekMessageA', 20),
        table.register('IDirect3DTexture8::LockRect', 16),
    ];
    assert.equal(taken.at(-1)?.address, base + capacity - STUB_SIZE, 'the last slot fits');

    assert.throws(
        ()=>table.register('IDirect3DTexture8::UnlockRect', 8),
        /full at 4 slots.*IDirect3DTexture8::UnlockRect/s,
        'the refusal names the capacity and what was being registered');

    assert.equal(table.count, 4, 'a refused registration takes nothing');
    assert.equal(table.image().length, capacity, 'and the image still fits the region');
});

test('the table defaults to the capacity the module reserves for it', ()=>{
    const table = createThunkTable({ base: 0x100000, port: PORT });
    assert.equal(DEFAULT_THUNK_CAPACITY % STUB_SIZE, 0);
    for (let taken = table.count; taken < DEFAULT_THUNK_CAPACITY / STUB_SIZE; taken++)
    {
        table.register(`slot-${taken}`, 0);
    }
    assert.throws(()=>table.register('one too many', 0), /stub table is full/);
});
