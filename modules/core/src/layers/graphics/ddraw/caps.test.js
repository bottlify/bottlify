/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DDERR_INVALIDCAPS,
    DDERR_INVALIDPARAMS,
    DDERR_NOEXCLUSIVEMODE,
    DDERR_NOPALETTEATTACHED,
    DDPF_PALETTEINDEXED8,
    DDPF_RGB,
    DDSCAPS2_CUBEMAP,
    DDSCAPS2_TEXTUREMANAGE,
    DDSCAPS_3DDEVICE,
    DDSCAPS_ALLOCONLOAD,
    DDSCAPS_BACKBUFFER,
    DDSCAPS_COMPLEX,
    DDSCAPS_FLIP,
    DDSCAPS_FRONTBUFFER,
    DDSCAPS_LOCALVIDMEM,
    DDSCAPS_MIPMAP,
    DDSCAPS_OFFSCREENPLAIN,
    DDSCAPS_PRIMARYSURFACE,
    DDSCAPS_SYSTEMMEMORY,
    DDSCAPS_TEXTURE,
    DDSCAPS_VIDEOMEMORY,
    DDSCAPS_VISIBLE,
    DDSCAPS_WRITEONLY,
    DDSCAPS_ZBUFFER,
    DD_OK,
} from './constants.js';
import {
    D3DERR_SURFACENOTINVIDMEM,
    acceptsMalformedLockRect,
    backBufferCaps,
    validateDeviceTarget,
    validateSurfaceCaps,
    validateSurfaceSize,
} from './caps.js';

/** Where a surface with no memory preference of its own ends up. */
const IN_VIDEO = DDSCAPS_VIDEOMEMORY | DDSCAPS_LOCALVIDMEM;

/**
 * @param {{ caps?: number, caps2?: number, backBufferCount?: number,
 *   hasBackBufferCount?: boolean, exclusive?: boolean, version?: 1 | 2 | 4 | 7 }} [options]
 */
function ask(options = {}){
    return validateSurfaceCaps({
        caps: options.caps ?? 0,
        caps2: options.caps2 ?? 0,
        backBufferCount: options.backBufferCount ?? 0,
        hasBackBufferCount: options.hasBackBufferCount ?? false,
        exclusive: options.exclusive ?? false,
        version: options.version ?? 7,
    });
}

/** The three parts of a flip-chain request, present together. */
function flipRequest(extra = 0){
    return {
        caps: DDSCAPS_COMPLEX | DDSCAPS_FLIP | extra,
        backBufferCount: 1,
        hasBackBufferCount: true,
    };
}

test('a surface with no memory preference is placed in video memory', ()=>{
    for (const caps of [0, DDSCAPS_OFFSCREENPLAIN, DDSCAPS_TEXTURE, DDSCAPS_ZBUFFER,
        DDSCAPS_3DDEVICE, DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN])
    {
        const result = ask({ caps });
        assert.equal(result.hr, DD_OK);
        assert.equal(result.caps, (caps | IN_VIDEO) >>> 0);
    }
});

test('asking for system memory is honoured, and asking for both is refused', ()=>{
    const managed = ask({ caps: DDSCAPS_TEXTURE | DDSCAPS_ALLOCONLOAD | DDSCAPS_SYSTEMMEMORY });
    assert.equal(managed.hr, DD_OK);
    assert.equal(managed.caps, DDSCAPS_TEXTURE | DDSCAPS_ALLOCONLOAD | DDSCAPS_SYSTEMMEMORY,
        'a surface that named its memory is left where it asked to be');

    assert.equal(ask({ caps: DDSCAPS_SYSTEMMEMORY | DDSCAPS_VIDEOMEMORY }).hr, DDERR_INVALIDCAPS);
});

test('a primary surface is visible, and refuses to be a texture or a back buffer', ()=>{
    const primary = ask({ caps: DDSCAPS_PRIMARYSURFACE });
    assert.equal(primary.hr, DD_OK);
    assert.equal(primary.caps, DDSCAPS_PRIMARYSURFACE | DDSCAPS_VISIBLE | IN_VIDEO);

    const inSystemMemory = ask({ caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_SYSTEMMEMORY });
    assert.equal(inSystemMemory.caps,
        DDSCAPS_PRIMARYSURFACE | DDSCAPS_SYSTEMMEMORY | DDSCAPS_VISIBLE);

    assert.equal(ask({ caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_TEXTURE }).hr, DDERR_INVALIDCAPS);
    assert.equal(ask({ caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_BACKBUFFER }).hr, DDERR_INVALIDCAPS);

    // Being the front of nothing is allowed; being the front of a chain that
    // was not asked for is not.
    const front = ask({ caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_FRONTBUFFER });
    assert.equal(front.hr, DD_OK);
    assert.equal(front.caps,
        DDSCAPS_PRIMARYSURFACE | DDSCAPS_FRONTBUFFER | DDSCAPS_VISIBLE | IN_VIDEO);
});

test('a flip chain is a three-part request and any part alone is refused', ()=>{
    const parts = flipRequest(DDSCAPS_PRIMARYSURFACE);

    assert.equal(ask({ ...parts, hasBackBufferCount: false }).hr, DDERR_INVALIDCAPS,
        'the count has to be marked present, not merely non-zero');
    assert.equal(ask({ ...parts, caps: parts.caps & ~DDSCAPS_FLIP }).hr, DDERR_INVALIDCAPS);
    assert.equal(ask({ ...parts, caps: parts.caps & ~DDSCAPS_COMPLEX }).hr, DDERR_INVALIDCAPS);
    assert.equal(ask({ ...parts, backBufferCount: 0 }).hr, DDERR_INVALIDCAPS);

    assert.equal(ask({ ...parts, caps: parts.caps | DDSCAPS_FRONTBUFFER }).hr, DDERR_INVALIDCAPS,
        'the chain names its own front buffer');
    assert.equal(ask({ ...parts, caps: parts.caps | DDSCAPS_BACKBUFFER }).hr, DDERR_INVALIDCAPS);
});

test('the screen is checked only once the flip request is well formed', ()=>{
    const parts = flipRequest(DDSCAPS_PRIMARYSURFACE);

    assert.equal(ask({ ...parts, backBufferCount: 0, exclusive: false }).hr, DDERR_INVALIDCAPS,
        'a malformed request never reveals that the screen was also missing');
    assert.equal(ask({ ...parts, exclusive: false }).hr, DDERR_NOEXCLUSIVEMODE);

    const owned = ask({ ...parts, exclusive: true });
    assert.equal(owned.hr, DD_OK);
    assert.ok(owned.flipChain);
    assert.equal(owned.caps, DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP
        | DDSCAPS_FRONTBUFFER | DDSCAPS_VISIBLE | IN_VIDEO);
});

test('a chain that is not the primary needs no exclusive screen', ()=>{
    for (const kind of [DDSCAPS_OFFSCREENPLAIN, DDSCAPS_TEXTURE])
    {
        const result = ask({ ...flipRequest(kind), exclusive: false });
        assert.equal(result.hr, DD_OK);
        assert.ok(result.flipChain);
    }
});

test('complex means attached surfaces, and needs something to attach', ()=>{
    assert.equal(ask({ caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX }).hr, DDERR_INVALIDCAPS);
    assert.equal(ask({ caps: DDSCAPS_TEXTURE | DDSCAPS_COMPLEX }).hr, DDERR_INVALIDCAPS);

    assert.equal(ask({ caps: DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP }).hr, DD_OK);
    assert.equal(ask({
        caps: DDSCAPS_TEXTURE | DDSCAPS_COMPLEX, caps2: DDSCAPS2_CUBEMAP,
    }).hr, DD_OK);
});

test('a lone back buffer is a version difference, not a capability', ()=>{
    const request = { caps: DDSCAPS_BACKBUFFER };
    assert.equal(ask({ ...request, version: 1 }).hr, DD_OK,
        'the original interface hands one out');
    for (const version of /** @type {(2 | 4 | 7)[]} */ ([2, 4, 7]))
    {
        assert.equal(ask({ ...request, version }).hr, DDERR_INVALIDCAPS,
            `IDirectDraw${version} refuses one`);
    }
});

test('write-only is a promise only a managed texture can keep', ()=>{
    assert.equal(ask({ caps: DDSCAPS_OFFSCREENPLAIN | DDSCAPS_WRITEONLY }).hr, DDERR_INVALIDCAPS);
    assert.equal(ask({ caps: DDSCAPS_TEXTURE | DDSCAPS_WRITEONLY }).hr, DDERR_INVALIDCAPS);
    assert.equal(ask({
        caps: DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY | DDSCAPS_WRITEONLY,
    }).hr, DDERR_INVALIDCAPS, 'system memory alone does not license it');
    assert.equal(ask({
        caps: DDSCAPS_TEXTURE | DDSCAPS_WRITEONLY, caps2: DDSCAPS2_TEXTUREMANAGE,
    }).hr, DD_OK);
});

test('every surface but the primary has to say how big it is', ()=>{
    const sized = { caps: DDSCAPS_OFFSCREENPLAIN, width: 64, height: 64 };
    assert.equal(validateSurfaceSize({ ...sized, hasWidth: true, hasHeight: true }), DD_OK);
    assert.equal(validateSurfaceSize({ ...sized, hasWidth: false, hasHeight: true }),
        DDERR_INVALIDPARAMS);
    assert.equal(validateSurfaceSize({ ...sized, hasWidth: true, hasHeight: false }),
        DDERR_INVALIDPARAMS);
    assert.equal(validateSurfaceSize({ ...sized, width: 0, hasWidth: true, hasHeight: true }),
        DDERR_INVALIDPARAMS);
    assert.equal(validateSurfaceSize({ ...sized, height: 0, hasWidth: true, hasHeight: true }),
        DDERR_INVALIDPARAMS);

    assert.equal(validateSurfaceSize({
        caps: DDSCAPS_PRIMARYSURFACE, width: 0, height: 0, hasWidth: false, hasHeight: false,
    }), DD_OK, 'a primary takes the mode\'s size and ignores the fields');
});

test('a back buffer is the front\'s caps without what makes a front a front', ()=>{
    const front = DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP
        | DDSCAPS_FRONTBUFFER | DDSCAPS_VISIBLE | IN_VIDEO;

    const immediate = backBufferCaps(front, true);
    assert.equal(immediate, DDSCAPS_COMPLEX | DDSCAPS_FLIP | DDSCAPS_BACKBUFFER | IN_VIDEO);
    assert.equal(backBufferCaps(front, false),
        DDSCAPS_COMPLEX | DDSCAPS_FLIP | IN_VIDEO,
        'only the buffer immediately behind the front is the back buffer');
});

test('a device target is judged on its caps first and its palette second', ()=>{
    const rgb = DDPF_RGB;
    const p8 = DDPF_PALETTEINDEXED8 | DDPF_RGB;

    assert.equal(validateDeviceTarget({
        caps: DDSCAPS_3DDEVICE, pixelFormatFlags: rgb, hasPalette: false,
    }), DD_OK);
    assert.equal(validateDeviceTarget({
        caps: 0, pixelFormatFlags: rgb, hasPalette: false,
    }), DDERR_INVALIDCAPS);
    assert.equal(validateDeviceTarget({
        caps: DDSCAPS_3DDEVICE | DDSCAPS_ZBUFFER, pixelFormatFlags: rgb, hasPalette: false,
    }), DDERR_INVALIDCAPS);
    assert.equal(validateDeviceTarget({
        caps: DDSCAPS_3DDEVICE | DDSCAPS_SYSTEMMEMORY, pixelFormatFlags: rgb, hasPalette: false,
    }), D3DERR_SURFACENOTINVIDMEM);

    // The palette is only ever looked at once the caps were acceptable: the
    // same format with unusable caps never gets that far.
    assert.equal(validateDeviceTarget({
        caps: DDSCAPS_OFFSCREENPLAIN, pixelFormatFlags: p8, hasPalette: false,
    }), DDERR_INVALIDCAPS);
    assert.equal(validateDeviceTarget({
        caps: DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE, pixelFormatFlags: p8, hasPalette: false,
    }), DDERR_NOPALETTEATTACHED);
    assert.equal(validateDeviceTarget({
        caps: DDSCAPS_OFFSCREENPLAIN | DDSCAPS_3DDEVICE, pixelFormatFlags: p8, hasPalette: true,
    }), DD_OK);

    // And the palette is looked at before the memory it sits in.
    assert.equal(validateDeviceTarget({
        caps: DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY | DDSCAPS_3DDEVICE,
        pixelFormatFlags: p8,
        hasPalette: false,
    }), DDERR_NOPALETTEATTACHED);
});

test('only a texture the runtime keeps a copy of tolerates a malformed rectangle', ()=>{
    assert.equal(acceptsMalformedLockRect(DDSCAPS_OFFSCREENPLAIN, 0), false);
    assert.equal(acceptsMalformedLockRect(DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY, 0), false);
    assert.equal(acceptsMalformedLockRect(DDSCAPS_TEXTURE | DDSCAPS_VIDEOMEMORY, 0), false);

    assert.equal(acceptsMalformedLockRect(DDSCAPS_TEXTURE | DDSCAPS_SYSTEMMEMORY, 0), true);
    assert.equal(acceptsMalformedLockRect(DDSCAPS_TEXTURE, DDSCAPS2_TEXTUREMANAGE), true);
});
