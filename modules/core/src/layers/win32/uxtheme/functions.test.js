/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThemeFunctions } from './functions.js';

test('with the classic style nothing is themed and no theme data opens', ()=>{
    /** @type {number[]} */
    const errors = [];
    const fns = createThemeFunctions({ setLastError: code=>errors.push(code) });
    assert.equal(fns.IsThemeActive.handler(), 0);
    assert.equal(fns.IsAppThemed.handler(), 0);
    assert.equal(fns.OpenThemeData.handler(), 0);
    assert.deepEqual(errors, [0x80070490], 'E_PROP_ID_UNSUPPORTED');
    assert.equal(fns.CloseThemeData.handler(), 0x80070006, 'E_HANDLE');
    assert.deepEqual(Object.values(fns).map(entry=>entry.argBytes), [0, 0, 8, 4]);
});
