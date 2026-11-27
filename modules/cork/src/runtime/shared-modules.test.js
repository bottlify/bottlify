/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The compiled modules kept for the runtimes sharing a store: those no runtime
 * took for an age go, their bytes given back to what paid for them, so code a
 * runtime let go is not held alive here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedModules } from './shared-modules.js';

/** The smallest module wasm compiles. */
const module = ()=>new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));

test('a kept module no runtime took for the age goes, one taken lately stays', ()=>{
    let paid = 0;
    const charge = { take: (/** @type {number} */ n)=>{ paid += n; return true; },
        give: (/** @type {number} */ n)=>{ paid -= n; } };
    const shared = createSharedModules(1 << 20, charge);
    shared.set('a', module(), 100, 0);
    shared.set('b', module(), 200, 10);
    shared.set('c', module(), 300, 20);
    // b taken at 50: used later than c.
    assert.ok(shared.get('b', 50));
    shared.sweep(80, 60);
    assert.equal(shared.get('a', 80), undefined, 'set at 0, untaken for 80');
    assert.ok(shared.get('c', 80) === undefined, 'set at 20, untaken for 60');
    assert.ok(shared.get('b', 80), 'taken at 50');
    assert.equal(shared.stats().bytes, 200);
    assert.equal(paid, 200, 'what went is given back');
});
