/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkFunctions } from './functions.js';

test('with no network, a drive is not a connection, and the call pops its twelve bytes', ()=>{
    /** @type {number[]} */
    const errors = [];
    const fns = createNetworkFunctions({ setLastError: code=>errors.push(code) });

    assert.equal(fns.WNetGetConnectionA.handler(), 2250, 'ERROR_NOT_CONNECTED');
    assert.deepEqual(errors, [2250]);
    assert.equal(fns.WNetGetConnectionA.argBytes, 12);
    assert.equal(fns.WNetGetUserA.handler(), 1222, 'ERROR_NO_NETWORK');
    assert.equal(fns.WNetGetUserA.argBytes, 12);
});
