/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGlobals } from './globals.js';
import { fakeMemory } from './harness.test.js';
import { guestWindow } from './guest-window.fixture.js';

test('a variable set before anyone asked where it is starts out holding that value', ()=>{
    const memory = fakeMemory();
    const globals = createGlobals(memory);

    globals.set('errno', 2);
    const address = globals.address('errno');
    assert.notEqual(address, 0);
    assert.equal(memory.i32(address), 2);
    assert.equal(globals.address('errno'), address, 'the same cell every time');
});

test('once it has an address the cell is the variable, whichever side writes it', ()=>{
    const memory = fakeMemory();
    const globals = createGlobals(memory);
    const address = globals.address('fmode', 0);

    globals.set('fmode', 0x8000);
    assert.equal(memory.i32(address), 0x8000, 'a set lands in guest memory');
    memory.setU32(address, 0x4000);
    assert.equal(globals.get('fmode'), 0x4000, 'and a program\'s own write is read back');
    assert.equal(globals.get('commode'), 0, 'a variable nobody touched is zero');
    assert.equal(memory.i32(globals.address('argc', 3)), 3, 'or what it starts as');
});

test('at 64 bits past 4 GiB: a cell of the runtime\'s own holds a pointer whole', ()=>{
    const base = 0x140000000;
    const bytes = new Uint8Array(0x100);
    const view = new DataView(bytes.buffer);
    const globals = createGlobals({ guest: guestWindow(bytes, { base, pointerSize: 8 }),
        allocate: ()=>base + 0x10 });
    bytes.fill(0xcc);
    const cell = globals.address('argv');
    globals.set('argv', base + 0x80);
    assert.equal(view.getUint32(cell - base, true)
        + view.getUint32(cell - base + 4, true) * 2 ** 32, base + 0x80,
    '__p___argv\'s char **, every bit of it');
    globals.set('argv', -1);
    assert.deepEqual([view.getUint32(0x10, true), view.getUint32(0x14, true)],
        [0xffffffff, 0xffffffff], 'an int sign-extended');
    assert.equal(globals.get('argv'), -1);
});
