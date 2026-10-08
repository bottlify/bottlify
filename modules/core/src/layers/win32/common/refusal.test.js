/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefusals } from './refusal.js';

test('a refused call answers the failure, leaves the last error and says why once', ()=>{
    /** @type {number[]} */
    const errors = [];
    /** @type {string[]} */
    const said = [];
    const refuse = createRefusals({
        setLastError: code=>errors.push(code),
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    });
    const entry = refuse('OpenPrinterW', { argBytes: 12, lastError: 1801, why: 'no printer' });
    assert.equal(entry.argBytes, 12);
    assert.equal(entry.handler(), 0);
    assert.equal(entry.handler(), 0);
    assert.deepEqual(errors, [1801, 1801], 'the last error on every call');
    assert.deepEqual(said, ['OpenPrinterW: no printer'], 'the divergence once');

    const counted = refuse('Counted', { argBytes: 0, answer: ()=>-1 >>> 0, why: 'x' });
    assert.equal(counted.handler(), 0xffffffff, 'an answer worked out when called');
    assert.equal(refuse('Quiet', { argBytes: 4, answer: 5, why: 'y' }).handler(), 5);
    assert.deepEqual(errors, [1801, 1801], 'and no last error where none is given');
});
