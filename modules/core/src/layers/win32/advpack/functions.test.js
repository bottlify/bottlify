/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdvpackFunctions } from './functions.js';

test('IsNTAdmin says whether the account is in BUILTIN\\Administrators', ()=>{
    assert.equal(createAdvpackFunctions({ isAdministrator: ()=>true }).IsNTAdmin.handler(), 1);
    assert.equal(createAdvpackFunctions({ isAdministrator: ()=>false }).IsNTAdmin.handler(), 0);
    assert.equal(createAdvpackFunctions({ isAdministrator: ()=>true }).IsNTAdmin.argBytes, 8,
        'two reserved arguments, popped by the callee');
});
