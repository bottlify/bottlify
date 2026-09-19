/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAcmFunctions } from './functions.js';

test('with no codec drivers, a stream cannot be opened and every export pops its stack', ()=>{
    const fns = createAcmFunctions();
    assert.equal(fns.acmGetVersion.handler(), 0x04000000);
    assert.equal(fns.acmGetVersion.argBytes, 0);
    assert.equal(fns.acmStreamOpen.handler(), 0x203, 'ACMERR_NOTPOSSIBLE');
    assert.equal(fns.acmStreamOpen.argBytes, 32, 'eight dwords');
    assert.equal(fns.acmDriverEnum.handler(), 8, 'MMSYSERR_NOTSUPPORTED');
    assert.equal(fns.acmFormatEnumA.argBytes, 20);
    assert.equal(fns.acmFormatEnumW.argBytes, 20);
    // The whole exported surface is declared: a library that imports any of
    // them still loads.
    assert.equal(Object.keys(fns).length, 42);
    for (const [name, entry] of Object.entries(fns))
    {
        assert.ok(Number.isInteger(entry.argBytes), `${name} declares its stack width`);
    }
});
