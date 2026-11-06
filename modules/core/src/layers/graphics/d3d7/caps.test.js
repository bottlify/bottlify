/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_DESCRIPTIONS } from './caps.js';
import {
    D3DDEVCAPS_DRAWPRIMITIVES2EX, D3DDEVCAPS_HWRASTERIZATION, D3DDEVCAPS_HWTRANSFORMANDLIGHT,
    D3DPRASTERCAPS_FOGRANGE,
    D3DPRASTERCAPS_FOGTABLE, D3DPRASTERCAPS_FOGVERTEX, D3DPRASTERCAPS_WFOG, D3DPRASTERCAPS_ZBIAS,
    D3DPRASTERCAPS_ZFOG, D3DPRASTERCAPS_ZTEST, D3DPTFILTERCAPS_MIPFLINEAR,
    D3DPTFILTERCAPS_MIPFPOINT,
    D3DTOP,
    DEVICE_IDS, textureOpCaps,
} from './constants.js';

test('the three devices differ only in where the work is said to happen', ()=>{
    const [rgb, hal, tnl] = DEVICE_DESCRIPTIONS;
    assert.deepEqual([rgb.id, hal.id, tnl.id], [DEVICE_IDS.RGB, DEVICE_IDS.HAL, DEVICE_IDS.TNLHAL]);
    // Strip the two placement bits and the identity, and nothing is left to tell apart:
    // the software device has no DrawPrimitives2 extensions (ddraw7 test_enum_devices).
    const same = (/** @type {any} */ caps)=>({
        ...caps,
        devCaps: caps.devCaps & ~(D3DDEVCAPS_HWRASTERIZATION | D3DDEVCAPS_HWTRANSFORMANDLIGHT
            | D3DDEVCAPS_DRAWPRIMITIVES2EX),
        deviceGuid: '',
    });
    assert.deepEqual(same(rgb.caps), same(hal.caps));
    assert.deepEqual(same(hal.caps), same(tnl.caps));
    assert.equal(rgb.caps.devCaps & D3DDEVCAPS_HWRASTERIZATION, 0);
    assert.equal(rgb.caps.devCaps & D3DDEVCAPS_DRAWPRIMITIVES2EX, 0);
    assert.equal(hal.caps.devCaps & D3DDEVCAPS_HWTRANSFORMANDLIGHT, 0);
    assert.equal(tnl.caps.devCaps & D3DDEVCAPS_HWTRANSFORMANDLIGHT, D3DDEVCAPS_HWTRANSFORMANDLIGHT);
});

test('a capability claimed is one the renderer draws', ()=>{
    // The shared renderer draws the stencil test (device.test.js draws one),
    // every fog and the depth bias; no bump mapping, and no user clip planes in
    // a draw, so neither is claimed.
    const caps = DEVICE_DESCRIPTIONS[2].caps;
    assert.equal(caps.stencilCaps, 0xff);
    assert.equal(caps.vertexProcessingCaps, 0);
    assert.equal(caps.maxUserClipPlanes, 0);
    assert.equal(caps.triCaps.rasterCaps, D3DPRASTERCAPS_ZTEST | D3DPRASTERCAPS_FOGRANGE
        | D3DPRASTERCAPS_FOGVERTEX | D3DPRASTERCAPS_FOGTABLE | D3DPRASTERCAPS_WFOG
        | D3DPRASTERCAPS_ZFOG | D3DPRASTERCAPS_ZBIAS, 'the depth test, every fog, the depth bias');
    assert.equal(caps.lineCaps.rasterCaps, caps.triCaps.rasterCaps);
    const mipFilters = D3DPTFILTERCAPS_MIPFPOINT | D3DPTFILTERCAPS_MIPFLINEAR;
    assert.equal(caps.triCaps.textureFilterCaps & mipFilters, mipFilters,
        'a DirectDraw mip chain is sampled level by level');
    // Bump environment mapping is operation 22; nothing here draws it.
    assert.equal(caps.textureOpCaps & textureOpCaps([22]), 0);
    assert.notEqual(caps.textureOpCaps & textureOpCaps([D3DTOP.MODULATE]), 0);
    assert.equal(textureOpCaps([D3DTOP.DISABLE, D3DTOP.SELECTARG1]), 0b11,
        'bit n-1 for operation n');
});
