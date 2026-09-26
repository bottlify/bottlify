/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which surface descriptions DirectDraw accepts, what it turns them into, and
 * which surfaces can back a 3D device.
 *
 * The two tables here are pure functions over a parsed descriptor: no object,
 * no memory, no state beyond the cooperative level and the interface
 * generation the call arrived through. That is what makes them testable as a
 * table, which is the shape the underlying evidence has.
 *
 * Two orderings matter and neither is derivable from the flag names:
 *
 * - A flip chain is a three-part request. `DDSCAPS_FLIP`, `DDSCAPS_COMPLEX`
 *   and a `dwBackBufferCount` marked present by `DDSD_BACKBUFFERCOUNT` must
 *   arrive together; any one of the three without the others is
 *   `DDERR_INVALIDCAPS`, and the count being zero is too. Only once the whole
 *   request is well formed does the missing exclusive mode become visible as
 *   `DDERR_NOEXCLUSIVEMODE` -- so a program that forgot the count under a
 *   normal cooperative level never learns that exclusivity was also missing.
 * - For a 3D device target the capability check runs first and the palette
 *   check second. A palettised surface with no attached palette reports
 *   `DDERR_NOPALETTEATTACHED` only when its caps were acceptable to begin
 *   with; with the same format and unusable caps the answer is
 *   `DDERR_INVALIDCAPS`, and the palette is never looked at. The palette check
 *   in turn precedes the system-memory check.
 */

import {
    DDERR_INVALIDCAPS,
    DDERR_INVALIDPARAMS,
    DDERR_NOEXCLUSIVEMODE,
    DDERR_NOOVERLAYHW,
    DDERR_NOPALETTEATTACHED,
    DDPF_PALETTEINDEXED_ANY,
    DDSCAPS2_CUBEMAP,
    DDSCAPS2_TEXTUREMANAGE,
    DDSCAPS_3DDEVICE,
    DDSCAPS_BACKBUFFER,
    DDSCAPS_COMPLEX,
    DDSCAPS_FLIP,
    DDSCAPS_FRONTBUFFER,
    DDSCAPS_LOCALVIDMEM,
    DDSCAPS_MIPMAP,
    DDSCAPS_OVERLAY,
    DDSCAPS_PRIMARYSURFACE,
    DDSCAPS_SYSTEMMEMORY,
    DDSCAPS_TEXTURE,
    DDSCAPS_VIDEOMEMORY,
    DDSCAPS_VISIBLE,
    DDSCAPS_WRITEONLY,
    DDSCAPS_ZBUFFER,
    DD_OK,
} from './constants.js';

/** A surface that is not in video memory but is asked to be a device target. */
export const D3DERR_SURFACENOTINVIDMEM = 0x88760000 + 747;

/**
 * @typedef {Object} SurfaceCapsRequest
 * @property {number} caps               DDSCAPS.dwCaps as the guest wrote it.
 * @property {number} caps2              DDSCAPS2.dwCaps2; zero for the older layout.
 * @property {number} backBufferCount
 * @property {boolean} hasBackBufferCount  DDSD_BACKBUFFERCOUNT was among dwFlags.
 * @property {boolean} [hasMipMapCount]   DDSD_MIPMAPCOUNT was among dwFlags.
 * @property {boolean} exclusive         The cooperative level holds DDSCL_EXCLUSIVE.
 * @property {1 | 2 | 4 | 7} version     The IDirectDraw generation that was called.
 */

/**
 * @typedef {Object} SurfaceCapsResult
 * @property {number} hr
 * @property {number} caps        The caps the surface reports back, on success.
 * @property {boolean} flipChain  True when the request builds a flip chain.
 */

/**
 * True when any part of a flip-chain request is present. All three parts have
 * to arrive together, so the presence of any one is what makes the request a
 * flip-chain request and therefore subject to the whole rule.
 *
 * @param {SurfaceCapsRequest} request
 * @returns {boolean}
 */
function wantsFlipChain(request){
    return (request.caps & DDSCAPS_FLIP) !== 0 || request.hasBackBufferCount;
}

/**
 * Where the surface ends up, and the two bits that follow from what it is.
 * Anything that did not ask for system memory is placed in video memory, and a
 * primary surface is on screen by definition.
 *
 * @param {number} caps
 * @param {boolean} flipChain
 * @returns {number}
 */
function placedCaps(caps, flipChain){
    let resolved = caps;
    if (!(resolved & DDSCAPS_SYSTEMMEMORY))
    {
        resolved |= DDSCAPS_VIDEOMEMORY | DDSCAPS_LOCALVIDMEM;
    }
    if (resolved & DDSCAPS_PRIMARYSURFACE)
    {
        resolved |= DDSCAPS_VISIBLE;
    }
    if (flipChain)
    {
        resolved |= DDSCAPS_FRONTBUFFER;
    }
    return resolved >>> 0;
}

/**
 * The capability half of CreateSurface: what the combination means and what it
 * would produce. Dimensions are checked separately, because whether they are
 * required at all depends on the answer here -- a primary surface takes its
 * size from the display mode and ignores whatever the caller wrote.
 *
 * @param {SurfaceCapsRequest} request
 * @returns {SurfaceCapsResult}
 */
export function validateSurfaceCaps(request){
    const caps = request.caps >>> 0;
    const fail = /** @param {number} hr @returns {SurfaceCapsResult} */
        hr=>({ hr, caps: 0, flipChain: false });

    // Memory placement is a choice of one. Asking for both is the one caps
    // error that does not depend on anything else in the request.
    if ((caps & DDSCAPS_SYSTEMMEMORY) && (caps & DDSCAPS_VIDEOMEMORY))
    {
        return fail(DDERR_INVALIDCAPS);
    }

    // DDSCAPS_WRITEONLY is spelled as a permission but behaves as a promise the
    // surface has to be able to keep: only a managed texture, whose contents
    // the runtime owns a copy of, is allowed to make it.
    if ((caps & DDSCAPS_WRITEONLY) && !(request.caps2 & DDSCAPS2_TEXTUREMANAGE))
    {
        return fail(DDERR_INVALIDCAPS);
    }

    const flipChain = wantsFlipChain(request);
    if (flipChain)
    {
        const parts = (caps & DDSCAPS_FLIP) && (caps & DDSCAPS_COMPLEX)
            && request.hasBackBufferCount;
        if (!parts || request.backBufferCount < 1)
        {
            return fail(DDERR_INVALIDCAPS);
        }
        // The chain names its own front and back buffers. Saying so as well is
        // a contradiction rather than a redundancy.
        if (caps & (DDSCAPS_FRONTBUFFER | DDSCAPS_BACKBUFFER))
        {
            return fail(DDERR_INVALIDCAPS);
        }
    }
    else if ((caps & DDSCAPS_COMPLEX)
        && !(caps & DDSCAPS_MIPMAP) && !(request.caps2 & DDSCAPS2_CUBEMAP))
    {
        // Complex means "this surface comes with attached ones". Without a flip
        // chain, a mip chain or a cube map there is nothing for it to attach.
        return fail(DDERR_INVALIDCAPS);
    }

    // Levels are a texture's. How many is the caller's to say only when they
    // come attached: a mip-mapped texture that is not complex is one level.
    if ((caps & DDSCAPS_MIPMAP)
        && (!(caps & DDSCAPS_TEXTURE) || (request.hasMipMapCount && !(caps & DDSCAPS_COMPLEX))))
    {
        return fail(DDERR_INVALIDCAPS);
    }

    if (caps & DDSCAPS_PRIMARYSURFACE)
    {
        if (caps & (DDSCAPS_TEXTURE | DDSCAPS_BACKBUFFER))
        {
            return fail(DDERR_INVALIDCAPS);
        }
        if (flipChain && !request.exclusive)
        {
            return fail(DDERR_NOEXCLUSIVEMODE);
        }
    }
    else if ((caps & DDSCAPS_BACKBUFFER) && request.version !== 1)
    {
        // Asking for a lone back buffer was accepted by the original interface
        // and refused by every later one, which is a version difference rather
        // than a capability the hardware gained or lost.
        return fail(DDERR_INVALIDCAPS);
    }

    // No overlay hardware is claimed -- DDCAPS_OVERLAY is not among the caps
    // -- so a surface that would be an overlay is refused the way a card
    // without one refuses it, not made and then never shown.
    if (caps & DDSCAPS_OVERLAY)
    {
        return fail(DDERR_NOOVERLAYHW);
    }

    return { hr: DD_OK, caps: placedCaps(caps, flipChain), flipChain };
}

/**
 * The dimension half. A primary surface is exempt: its size is the mode's, and
 * whatever the caller left in the width and height fields is ignored rather
 * than rejected.
 *
 * @param {{ caps: number, width: number, height: number,
 *   hasWidth: boolean, hasHeight: boolean }} request
 * @returns {number} DD_OK or DDERR_INVALIDPARAMS
 */
export function validateSurfaceSize(request){
    if (request.caps & DDSCAPS_PRIMARYSURFACE)
    {
        return DD_OK;
    }
    if (!request.hasWidth || !request.hasHeight)
    {
        return DDERR_INVALIDPARAMS;
    }
    return request.width > 0 && request.height > 0 ? DD_OK : DDERR_INVALIDPARAMS;
}

/**
 * How many levels a mip chain has, or null when the count asked for cannot be
 * built. A full chain halves until both sides are one from IDirectDraw7 on,
 * and until the shorter side is one before it (Wine's test_mipmap for each
 * version: 128x32 is eight levels through IDirectDraw7 and six before).
 *
 * @param {{ caps: number, width: number, height: number,
 *   mipMapCount: number | null, version: 1 | 2 | 4 | 7 }} request
 *           `mipMapCount` is null when DDSD_MIPMAPCOUNT was not given.
 * @returns {number | null} zero for a surface that is no mip chain
 */
export function mipLevelCount(request){
    if (!(request.caps & DDSCAPS_MIPMAP))
    {
        return 0;
    }
    if (!(request.caps & DDSCAPS_COMPLEX))
    {
        return 1;
    }
    const side = request.version === 7
        ? Math.max(request.width, request.height)
        : Math.min(request.width, request.height);
    const full = Math.floor(Math.log2(side)) + 1;
    if (request.mipMapCount === null)
    {
        return full;
    }
    return request.mipMapCount >= 1 && request.mipMapCount <= full ? request.mipMapCount : null;
}

/**
 * The caps a back buffer of a flip chain carries. The chain's front buffer
 * owns the properties that describe a chain -- being visible, being the
 * primary, being the front -- so a back buffer is the front's caps without
 * them, and only the buffer immediately behind the front is marked as the
 * back one.
 *
 * @param {number} frontCaps
 * @param {boolean} immediate  True for the first buffer behind the front.
 * @returns {number}
 */
export function backBufferCaps(frontCaps, immediate){
    const stripped = frontCaps
        & ~(DDSCAPS_VISIBLE | DDSCAPS_PRIMARYSURFACE | DDSCAPS_FRONTBUFFER);
    return (immediate ? stripped | DDSCAPS_BACKBUFFER : stripped) >>> 0;
}

/**
 * Whether this surface tolerates a lock rectangle that is inverted or reaches
 * outside it.
 *
 * Most surfaces refuse one with DDERR_INVALIDPARAMS, but a texture the runtime
 * keeps its own copy of -- in system memory, or explicitly managed -- accepts
 * it and answers DD_OK. The lenient answer is the one to reproduce: it is
 * observable, so a program may have been written against it, and refusing
 * where the original accepted turns a working call into a failure.
 *
 * @param {number} caps
 * @param {number} caps2
 * @returns {boolean}
 */
export function acceptsMalformedLockRect(caps, caps2){
    return (caps & DDSCAPS_TEXTURE) !== 0
        && ((caps & DDSCAPS_SYSTEMMEMORY) !== 0 || (caps2 & DDSCAPS2_TEXTUREMANAGE) !== 0);
}

/**
 * Whether a surface can back a 3D device, and why not when it cannot.
 *
 * This is not part of CreateSurface: the surface already exists and is being
 * asked to serve as a render target. It lives here because it is the same kind
 * of table over the same caps, and because the ordering it encodes -- caps,
 * then palette, then memory placement -- is the thing worth pinning down
 * before anything is built on top of it.
 *
 * @param {{ caps: number, pixelFormatFlags: number, hasPalette: boolean }} surface
 * @returns {number}
 */
export function validateDeviceTarget(surface){
    if (!(surface.caps & DDSCAPS_3DDEVICE) || (surface.caps & DDSCAPS_ZBUFFER))
    {
        return DDERR_INVALIDCAPS;
    }
    if ((surface.pixelFormatFlags & DDPF_PALETTEINDEXED_ANY) && !surface.hasPalette)
    {
        return DDERR_NOPALETTEATTACHED;
    }
    if (surface.caps & DDSCAPS_SYSTEMMEMORY)
    {
        return D3DERR_SURFACENOTINVIDMEM;
    }
    return DD_OK;
}
