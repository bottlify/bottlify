/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGlobals } from './globals.js';
import { fakeMemory } from './harness.test.js';

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
