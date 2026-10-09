/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DERR_INVALIDCALL, D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3DTEXF, D3DTSS, D3DUSAGE, D3D_OK,
} from './constants.js';
import { createDefaultStageStates } from './stagestates.js';
import { D3DSWAPEFFECT as D3DSWAPEFFECT9 } from '../d3d9/constants.js';
import { RESOURCE_VALIDITY as RESOURCE_VALIDITY_9 } from '../d3d9/validity.js';
import {
    RESOURCE_VALIDITY, SURFACE_TYPE, SWAP_EFFECT_MAX_BACK_BUFFERS, createResult,
    reportedBackBufferCount, targetPairResult, validatePresentParameters, validateStages,
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

// --- the block-compressed formats ---

test('a compressed texture is created whatever compressedTextures says -- the flag chooses'
    + ' only how its bytes travel to the GPU, never whether the format exists', ()=>{
    const support = { depthTexture2d: false, depthCube: false, depthPlain: false };

    for (const format of [D3DFMT.DXT1, D3DFMT.DXT2, D3DFMT.DXT3, D3DFMT.DXT4, D3DFMT.DXT5])
    {
        assert.equal(
            createResult(SURFACE_TYPE.TEXTURE_2D, format, D3DPOOL.MANAGED, 0, support),
            D3D_OK,
            'legal on every Direct3D 8 device of the era, whatever the adapter offers');
    }
});

test('nothing may be rendered into a compressed surface, however capable the adapter', ()=>{
    const support = { depthTexture2d: true, depthCube: true, depthPlain: true };
    assert.equal(
        createResult(SURFACE_TYPE.RENDER_TARGET, D3DFMT.DXT1, D3DPOOL.DEFAULT,
            D3DUSAGE.RENDERTARGET, support),
        D3DERR_INVALIDCALL);
    assert.equal(
        createResult(SURFACE_TYPE.DEPTH_STENCIL, D3DFMT.DXT5, D3DPOOL.DEFAULT,
            D3DUSAGE.DEPTHSTENCIL, support),
        D3DERR_INVALIDCALL);
});

// --- ValidateDevice: the cascade the combiner draws in one pass ---

test('the texture stages validate when the combiner draws them, and name what it cannot', ()=>{
    const UNSUPPORTEDCOLOROPERATION = 0x88760819;
    const UNSUPPORTEDCOLORARG = 0x8876081a;
    const UNSUPPORTEDALPHAOPERATION = 0x8876081b;
    const UNSUPPORTEDALPHAARG = 0x8876081c;
    const UNSUPPORTEDTEXTUREFILTER = 0x88760822;
    /** @type {Map<number, number>[]} */
    let stages = [];
    const reset = ()=>{
        stages = Array.from({ length: 8 }, (_, stage)=>createDefaultStageStates(stage));
    };
    /** @param {number} stage @param {number} type @param {number} value */
    const set = (stage, type, value)=>{
        stages[stage].set(type, value);
    };
    const validate = (filters = true)=>validateStages(stage=>stages[stage], 8, { filters });

    reset();
    assert.equal(validate(), D3D_OK, 'the default cascade');
    set(0, D3DTSS.COLOROP, 22);
    assert.equal(validate(), UNSUPPORTEDCOLOROPERATION, 'D3DTOP_BUMPENVMAP');
    reset();
    set(0, D3DTSS.COLORARG1, 5);
    assert.equal(validate(), UNSUPPORTEDCOLORARG, 'D3DTA_TEMP');
    set(0, D3DTSS.COLOROP, 3);
    assert.equal(validate(), D3D_OK, 'an argument the operation does not read is not looked at');
    reset();
    set(0, D3DTSS.ALPHAOP, 23);
    assert.equal(validate(), UNSUPPORTEDALPHAOPERATION, 'D3DTOP_BUMPENVMAPLUMINANCE');
    reset();
    set(0, D3DTSS.ALPHAOP, 4);
    set(0, D3DTSS.ALPHAARG2, 6);
    assert.equal(validate(), UNSUPPORTEDALPHAARG, 'D3DTA_CONSTANT, read by MODULATE');
    reset();
    set(1, D3DTSS.COLOROP, 1);
    set(2, D3DTSS.COLOROP, 22);
    assert.equal(validate(), D3D_OK, 'nothing past the first disabled stage is drawn');

    // Wine's d3d9 test_filter: a filter of none is refused, texture or not.
    reset();
    set(0, D3DTSS.MAGFILTER, D3DTEXF.NONE);
    assert.equal(validate(), UNSUPPORTEDTEXTUREFILTER, 'a magnification filter of none');
    assert.equal(validate(false), D3D_OK, 'unless the filters are not these numbers');
    reset();
    set(3, D3DTSS.MINFILTER, D3DTEXF.ANISOTROPIC);
    assert.equal(validate(), UNSUPPORTEDTEXTUREFILTER, 'anisotropy, which is not claimed');
    reset();
    set(0, D3DTSS.MIPFILTER, D3DTEXF.NONE);
    set(0, D3DTSS.MINFILTER, D3DTEXF.LINEAR);
    assert.equal(validate(), D3D_OK);
});
