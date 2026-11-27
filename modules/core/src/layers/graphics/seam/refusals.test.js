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
        assert.equal(loud('GetRenderTarget', 0x88760866), 0x88760866,
            'nothing bound at an index is an answer, not a refusal');
        assert.deepEqual(said, ['Direct3D 9: StretchRect answered D3DERR_INVALIDCALL',
            'Direct3D 9: Reset answered D3DERR_DEVICELOST']);
    });

test('a refusal says the arguments of the call it was first answered to', ()=>{
    /** @type {string[]} */
    const said = [];
    const loud = loudRefusals('Direct3D 9', (api, detail)=>said.push(detail));
    loud('CreateVolumeTexture', 0x8876086c, [128, 128, 128, 1, 0, 0x31545844, 1, 0x2ff000]);
    loud('CreateVolumeTexture', 0x8876086c, [64, 64, 64, 1, 0, 21, 1, 0x2ff000]);
    assert.deepEqual(said, ['CreateVolumeTexture(0x80, 0x80, 0x80, 0x1, 0x0, 0x31545844, 0x1,'
        + ' 0x2ff000) answered D3DERR_INVALIDCALL']);
});
