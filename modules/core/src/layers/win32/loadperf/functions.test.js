/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoadperfFunctions } from './functions.js';

test('a counter load and unload answer success, said once with the command line', ()=>{
    /** @type {string[]} */
    const divergences = [];
    const lines = new Map([[0x1000, 'lodctr aspnet_perf.ini'], [0x2000, 'unlodctr ASP.NET']]);
    const functions = createLoadperfFunctions({
        readWideString: address=>lines.get(address) ?? '',
        readCString: address=>lines.get(address) ?? '',
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
    });
    assert.equal(functions.LoadPerfCounterTextStringsW.handler([0x1000, 1]), 0);
    assert.equal(functions.UnloadPerfCounterTextStringsA.handler([0x2000, 1]), 0);
    assert.equal(functions.LoadPerfCounterTextStringsW.argBytes, 8);
    assert.deepEqual(divergences, ['LoadPerfCounterTextStringsW: performance counter text is '
        + 'taken and kept nowhere (lodctr aspnet_perf.ini)']);
});
