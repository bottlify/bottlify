/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loudRefusals } from './refusals.js';

test('a device method that fails is reported once by method and code, its answer passed on',
    async()=>{
        /** @type {string[]} */
        const said = [];
        const loud = loudRefusals('Direct3D 9', (api, detail)=>said.push(`${api}: ${detail}`));
        assert.equal(loud('StretchRect', 0x8876086c), 0x8876086c);
        assert.equal(loud('StretchRect', 0x8876086c), 0x8876086c);
        assert.equal(loud('Present', 0), 0);
        assert.equal(loud('GetData', 1), 1, 'S_FALSE is no failure');
        assert.equal(await loud('Reset', Promise.resolve(0x88760868)), 0x88760868);
        assert.deepEqual(said, ['Direct3D 9: StretchRect answered D3DERR_INVALIDCALL',
            'Direct3D 9: Reset answered D3DERR_DEVICELOST']);
    });
