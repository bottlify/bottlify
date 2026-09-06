/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DERR_INVALIDCALL, D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3DUSAGE, D3D_OK,
} from './constants.js';
import { D3DSWAPEFFECT as D3DSWAPEFFECT9 } from '../d3d9/constants.js';
import { RESOURCE_VALIDITY as RESOURCE_VALIDITY_9 } from '../d3d9/validity.js';
import {
    RESOURCE_VALIDITY, SURFACE_TYPE, SWAP_EFFECT_MAX_BACK_BUFFERS, createResult,
    reportedBackBufferCount, targetPairResult, validatePresentParameters,
} from './validity.js';

// --- the swap effects, which are the table that could not be shared ---

test('the two versions agree on three swap effects and part on the fourth', ()=>{
    assert.equal(D3DSWAPEFFECT.DISCARD, D3DSWAPEFFECT9.DISCARD);
    assert.equal(D3DSWAPEFFECT.FLIP, D3DSWAPEFFECT9.FLIP);
    assert.equal(D3DSWAPEFFECT.COPY, D3DSWAPEFFECT9.COPY);
    // The same value, and a different effect: D3D9 reused it for an Ex-only
    // one, which is exactly why sharing the table would have been wrong.
    assert.equal(D3DSWAPEFFECT.COPY_VSYNC, D3DSWAPEFFECT9.OVERLAY);
});

test('a copying swap effect allows one back buffer and a flipping one three', ()=>{
    const cases = [
        { swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 3, hr: D3D_OK },
        { swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 4, hr: D3DERR_INVALIDCALL },
        { swapEffect: D3DSWAPEFFECT.FLIP, backBufferCount: 3, hr: D3D_OK },
        { swapEffect: D3DSWAPEFFECT.FLIP, backBufferCount: 4, hr: D3DERR_INVALIDCALL },
        { swapEffect: D3DSWAPEFFECT.COPY, backBufferCount: 0, hr: D3D_OK },
        { swapEffect: D3DSWAPEFFECT.COPY, backBufferCount: 1, hr: D3D_OK },
        { swapEffect: D3DSWAPEFFECT.COPY, backBufferCount: 2, hr: D3DERR_INVALIDCALL },
        { swapEffect: D3DSWAPEFFECT.COPY_VSYNC, backBufferCount: 0, hr: D3D_OK },
        { swapEffect: D3DSWAPEFFECT.COPY_VSYNC, backBufferCount: 1, hr: D3D_OK },
        { swapEffect: D3DSWAPEFFECT.COPY_VSYNC, backBufferCount: 2, hr: D3DERR_INVALIDCALL },
        { swapEffect: 0, backBufferCount: 1, hr: D3DERR_INVALIDCALL },
        { swapEffect: D3DSWAPEFFECT.COPY_VSYNC + 1, backBufferCount: 1, hr: D3DERR_INVALIDCALL },
    ];

    for (const { swapEffect, backBufferCount, hr } of cases)
    {
        for (const windowed of [true, false])
        {
            assert.equal(
                validatePresentParameters({ swapEffect, backBufferCount, windowed }), hr,
                `swap effect ${swapEffect}, ${backBufferCount} back buffers, windowed ${windowed}`);
        }
    }
});

test('a swap effect the version does not have is not a swap effect', ()=>{
    assert.equal(SWAP_EFFECT_MAX_BACK_BUFFERS[D3DSWAPEFFECT9.FLIPEX], undefined);
    assert.equal(validatePresentParameters({ swapEffect: D3DSWAPEFFECT9.FLIPEX }),
        D3DERR_INVALIDCALL);
});

test('a back buffer count of zero is reported back as one', ()=>{
    assert.equal(reportedBackBufferCount({ swapEffect: D3DSWAPEFFECT.DISCARD }), 1);
    assert.equal(
        reportedBackBufferCount({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 0 }), 1);
    assert.equal(
        reportedBackBufferCount({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 3 }), 3);
});

// --- the table that is shared, and is asserted to be shared ---

test('the pool, format and usage table is D3D9 own, row for row', ()=>{
    assert.equal(RESOURCE_VALIDITY, RESOURCE_VALIDITY_9,
        'a second copy of this table is free to drift from the first');
    assert.equal(RESOURCE_VALIDITY.length, 30);
});

test('every row of the shared table answers the same way through both entry points', ()=>{
    const support = { depthTexture2d: true, depthCube: true, depthPlain: true };
    for (const row of RESOURCE_VALIDITY)
    {
        const format = row.format === 'depth' ? D3DFMT.D24S8 : D3DFMT.X8R8G8B8;
        const expected = row.valid ? D3D_OK : D3DERR_INVALIDCALL;
        assert.equal(createResult(SURFACE_TYPE.TEXTURE_2D, format, row.pool, row.usage, support),
            expected, `2D pool ${row.pool} usage ${row.usage} ${row.format}`);
        assert.equal(createResult(SURFACE_TYPE.CUBE, format, row.pool, row.usage, support),
            expected, `cube pool ${row.pool} usage ${row.usage} ${row.format}`);
    }
});

test('a depth format is a texture only where the adapter says so', ()=>{
    const none = { depthTexture2d: false, depthCube: false, depthPlain: false };
    const all = { depthTexture2d: true, depthCube: true, depthPlain: true };
    const args = /** @type {const} */ ([D3DFMT.D16, D3DPOOL.DEFAULT, 0]);

    assert.equal(createResult(SURFACE_TYPE.TEXTURE_2D, ...args, none), D3DERR_INVALIDCALL);
    assert.equal(createResult(SURFACE_TYPE.CUBE, ...args, none), D3DERR_INVALIDCALL);
    assert.equal(createResult(SURFACE_TYPE.TEXTURE_2D, ...args, all), D3D_OK);
    assert.equal(createResult(SURFACE_TYPE.CUBE, ...args, all), D3D_OK);

    // The condition travels per surface type: an adapter may offer one and not
    // the others, and carrying an expectation without its condition would
    // freeze whichever branch happened to be measured.
    const only2d = { depthTexture2d: true, depthCube: false, depthPlain: false };
    assert.equal(createResult(SURFACE_TYPE.TEXTURE_2D, ...args, only2d), D3D_OK);
    assert.equal(createResult(SURFACE_TYPE.CUBE, ...args, only2d), D3DERR_INVALIDCALL);
    assert.equal(createResult(SURFACE_TYPE.PLAIN, D3DFMT.D16, D3DPOOL.SYSTEMMEM, 0, only2d),
        D3DERR_INVALIDCALL);
});

test('an unknown format selects no row at all', ()=>{
    const support = { depthTexture2d: true, depthCube: true, depthPlain: true };
    assert.equal(createResult(SURFACE_TYPE.TEXTURE_2D, 0xbeef, D3DPOOL.DEFAULT, 0, support),
        D3DERR_INVALIDCALL);
});

// --- the pair of targets, which is one call in this version ---

test('a null target on either side is not a usage error', ()=>{
    const colour = { Usage: D3DUSAGE.RENDERTARGET };
    const depth = { Usage: D3DUSAGE.DEPTHSTENCIL };

    assert.equal(targetPairResult(null, null), D3D_OK);
    assert.equal(targetPairResult(colour, null), D3D_OK);
    assert.equal(targetPairResult(null, depth), D3D_OK);
    assert.equal(targetPairResult(colour, depth), D3D_OK);
});

test('each half of the pair needs its own usage', ()=>{
    // A texture level reaches this with the texture's own usage, which is what
    // makes usage the only thing worth asking about.
    const plain = { Usage: 0 };
    const colour = { Usage: D3DUSAGE.RENDERTARGET };
    const depth = { Usage: D3DUSAGE.DEPTHSTENCIL };

    assert.equal(targetPairResult(plain, null), D3DERR_INVALIDCALL);
    assert.equal(targetPairResult(depth, null), D3DERR_INVALIDCALL);
    assert.equal(targetPairResult(null, plain), D3DERR_INVALIDCALL);
    assert.equal(targetPairResult(null, colour), D3DERR_INVALIDCALL);
});
