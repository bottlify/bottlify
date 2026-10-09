/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRichedLibraries } from './libraries.js';

test('both rich edit libraries are there to load, and text services are refused', ()=>{
    const memory = new Uint8Array(16).fill(0xcc);
    const libraries = createRichedLibraries({ writeMemory: (at, bytes)=>memory.set(bytes, at) });
    assert.deepEqual(Object.keys(libraries), ['RICHED32.DLL', 'RICHED20.DLL']);
    const create = libraries['RICHED20.DLL'].CreateTextServices;
    assert.equal(create.argBytes, 12);
    assert.equal(create.handler([0, 0, 4]), 0x80004001);
    assert.deepEqual([...memory.subarray(4, 8)], [0, 0, 0, 0]);
    assert.equal(memory[8], 0xcc);
    assert.equal(create.handler([0, 0, 0]), 0x80070057);
});
