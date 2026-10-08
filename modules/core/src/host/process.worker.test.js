/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainOf } from './process.worker.js';

test('a report that cannot be read as data says why, rather than nothing', ()=>{
    assert.deepEqual(plainOf(()=>[{ name: 'cpu', metrics: { n: 1 } }]),
        [{ name: 'cpu', metrics: { n: 1 } }]);
    assert.equal(plainOf(()=>{
        throw new Error('no such table');
    }), null);
    assert.deepEqual(plainOf(()=>{
        throw new Error('blocks.decoded is not a function');
    }, message=>[{ name: 'diagnostics', status: 'error', metrics: { error: message } }]),
    [{ name: 'diagnostics', status: 'error',
        metrics: { error: 'blocks.decoded is not a function' } }]);
    assert.equal(plainOf(()=>({ big: 1n })), null, 'a BigInt does not cross as JSON');
});
