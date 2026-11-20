/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { features, memory64, wideLanes } from './features.js';
import { allowMemory64, ifRoom } from '../testing/memory64.js';

test('the probe answers booleans and says what this machine has', ()=>{
    const found = features();
    for (const [name, value] of Object.entries(found))
    {
        assert.equal(typeof value, 'boolean', name);
    }
    // Printed, not asserted: the record of a run says what the machine had,
    // and the translator's tests skip what it lacks by name.
    console.log(`wasm features: ${JSON.stringify(found)}`);
    assert.equal(typeof found.defaultNaNNegative, 'boolean');
});

test('a wide window\'s lane accesses: this engine read and written past 4 GiB as they are, '
    + 'and a memory that does not reach past 4 GiB answered no', ifRoom(()=>{
    allowMemory64();
    const ram = memory64(2 ** 33, true);
    assert.equal(wideLanes(ram), true, 'reads and writes them past 4 GiB');
    assert.deepEqual([...new Uint8Array(ram.buffer, 0, 2 ** 20)].some(byte=>byte !== 0), false,
        'the RAM below its last page left alone');
    assert.equal(wideLanes(memory64(2 ** 32)), false, 'nothing past 4 GiB to ask');
}));
