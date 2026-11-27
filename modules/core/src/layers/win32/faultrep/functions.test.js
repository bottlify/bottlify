/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRRV_ERR_NO_DW, createFaultrepFunctions } from './functions.js';

test('ReportFault says the reporting client could not be launched', ()=>{
    const { ReportFault } = createFaultrepFunctions();
    assert.equal(ReportFault.argBytes, 8);
    assert.equal(ReportFault.handler(), FRRV_ERR_NO_DW);
    assert.equal(FRRV_ERR_NO_DW, 4);
});
