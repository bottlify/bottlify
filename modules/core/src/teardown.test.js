/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teardown } from './teardown.js';

test('every step of a teardown runs, in order, whatever the one before it did', async()=>{
    /** @type {string[]} */
    const done = [];
    /** @type {unknown[]} */
    const said = [];
    await teardown([
        ()=>void done.push('worker terminated'),
        ()=>{
            throw new Error('the objects would not go');
        },
        async()=>{
            await new Promise(resolve=>setImmediate(resolve));
            done.push('link closed');
        },
        ()=>Promise.reject(new Error('COM would not go')),
        ()=>void done.push('sound given back'),
    ], e=>{
        said.push(/** @type {Error} */ (e).message);
        throw new Error('a teller that throws stops nothing either');
    });
    assert.deepEqual(done, ['worker terminated', 'link closed', 'sound given back']);
    assert.deepEqual(said, ['the objects would not go', 'COM would not go'],
        'and each failure is said');
});
