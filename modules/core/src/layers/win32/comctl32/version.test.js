/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CCM_GETVERSION, CCM_SETVERSION, answerVersion } from './version.js';

test('the 5.82 library keeps the version set, from 0, and refuses one past 5', ()=>{
    // misc.c's test_CCM_SETVERSION, version 5: setting 0 to 7 in turn.
    const record = { controlsVersion: 5 };
    const held = {};
    assert.equal(answerVersion(record, held, CCM_GETVERSION, 0), 0);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7]
        .map(asked=>answerVersion(record, held, CCM_SETVERSION, asked)),
    [0, 0, 1, 2, 3, 4, -1, -1]);
    assert.equal(answerVersion(record, held, CCM_GETVERSION, 0), 5, 'a refused one is not kept');
});

test('Common Controls 6 is version 6 whatever is set', ()=>{
    const record = { controlsVersion: 6 };
    const held = {};
    assert.equal(answerVersion(record, held, CCM_GETVERSION, 0), 6);
    assert.deepEqual([0, 5, 7].map(asked=>answerVersion(record, held, CCM_SETVERSION, asked)),
        [6, 6, 6]);
});
