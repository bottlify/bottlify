/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How long an executor's waits look first follows the cores the slices out
 * leave free (`lookFor`). The wakes of the turns themselves are Cellar's
 * link's, gated there (`link.itest.js`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BELL_BYTES, BUSY_BESIDE, Bell, SPARE_SPIN_MS, SPIN_MS, lookFor }
    from './executor-channel.js';

test('a wait looks long while the slices out leave a core free, briefly when they do not', ()=>{
    const bell = new Int32Array(new SharedArrayBuffer(BELL_BYTES));
    const look = lookFor(bell, 4);
    // Nothing out: the process's executor and the graphics worker on two of four.
    assert.equal(look(), SPARE_SPIN_MS);
    Atomics.store(bell, Bell.RUNNING, 4 - BUSY_BESIDE - 1);
    assert.equal(look(), SPARE_SPIN_MS, 'one core still free');
    Atomics.store(bell, Bell.RUNNING, 4 - BUSY_BESIDE);
    assert.equal(look(), SPIN_MS, 'every core taken');
    Atomics.store(bell, Bell.RUNNING, 0);
    // An unknown host looks briefly.
    assert.equal(lookFor(bell, undefined)(), SPIN_MS);
    assert.equal(lookFor(null, 16)(), SPIN_MS);
    // A machine of two cores has none to spare beside the two threads.
    assert.equal(lookFor(bell, 2)(), SPIN_MS);
});
