/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { features } from './features.js';

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
