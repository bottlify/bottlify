/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawCheck } from './draw-check.js';

test('a draw is stale where guest memory holds bytes the played side was not sent', ()=>{
    const memory = new Uint8Array(0x4000);
    const read = (/** @type {number} */ address, /** @type {number} */ length)=>
        memory.slice(address, address + length);
    const check = createDrawCheck(read);
    memory.fill(7, 0x0ff0, 0x1010);
    check.sent(0x0ff0, read(0x0ff0, 0x20));
    check.drew(0x0ff0, 0x20, { buffer: 32 });
    assert.equal(check.figures().stale, 0, 'what was sent, across a page');
    memory[0x1004] = 9;
    check.drew(0x1000, 0x10, { buffer: 32 });
    const figures = check.figures();
    assert.equal(figures.stale, 1);
    assert.equal(figures.staleBytes, 1);
    assert.deepEqual(figures.samples[0], { buffer: 32, address: 0x1000, length: 0x10, stale: 1,
        first: 4, page: '1' });
    check.drew(0x2000, 8, {});
    assert.equal(check.figures().unknownBytes, 8, 'never sent: not compared');
});
