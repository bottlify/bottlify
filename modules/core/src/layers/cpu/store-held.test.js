/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeHeld } from './module.js';

test('the store\'s index is weighed from its counts, its kept modules as they are; a store with'
    + ' no counts is not measured', ()=>{
    assert.deepEqual(storeHeld({ records: 1000, regionsWithModule: 200,
        heldModules: { bytes: 3 << 20 } }),
    { storeIndex: 1000 * 141 + 200 * 109, storeModules: 3 << 20 });
    assert.deepEqual(storeHeld({ records: 10 }), { storeIndex: 10 * 141 },
        'no modules kept beside it: none said');
    assert.deepEqual(storeHeld({}), { storeIndex: 'not measured' });
    assert.deepEqual(storeHeld(null), { storeIndex: 'not measured' });
});
