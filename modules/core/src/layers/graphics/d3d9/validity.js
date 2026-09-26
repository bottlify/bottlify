/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which resources a device agrees to create, and which presentation parameters
 * it accepts.
 *
 * Both are tables, not branches. The rules have no structure worth expressing
 * as code -- pool, usage and surface type interact in ways that are simply
 * enumerated -- and a table can be walked by a test, which a chain of
 * conditions cannot.
 *
 * Where a row depends on what the adapter reports, the condition is named in
 * the row's evaluator rather than resolved here: a table that has already
 * chosen one machine's answer is no longer a specification.
 */

import {
    D3DERR_INVALIDCALL, D3DPOOL, D3DSWAPEFFECT, D3DUSAGE, D3D_OK, FORMAT_INFO,
} from './constants.js';

/** What the pool/usage table distinguishes about a format, and nothing more. */
export const FORMAT_KIND = Object.freeze({ COLOUR: 'colour', DEPTH: 'depth' });

/** The five shapes a surface can be asked for. */
export const SURFACE_TYPE = Object.freeze({
    TEXTURE_2D: 'texture2d',
    CUBE: 'cube',
    RENDER_TARGET: 'rendertarget',
    DEPTH_STENCIL: 'depthstencil',
    PLAIN: 'plain',
});

/**
 * @typedef {Object} ResourceValidityRow
 * @property {number} pool
 * @property {string} format   A FORMAT_KIND.
 * @property {number} usage
 * @property {boolean} valid   Whether a texture of this row can be created at all.
 */

/**
 * Pool x format x usage, as it applies to a texture or cube texture. The other
 * three surface types ignore the pool and usage columns entirely, which is
 * itself part of the contract and is why `surfaceCreateResult` takes the type.
 *
 * @type {readonly ResourceValidityRow[]}
 */
export const RESOURCE_VALIDITY = Object.freeze([
    { pool: D3DPOOL.DEFAULT, format: FORMAT_KIND.COLOUR, usage: 0, valid: true },
    { pool: D3DPOOL.DEFAULT, format: FORMAT_KIND.DEPTH, usage: 0, valid: true },
    {
        pool: D3DPOOL.DEFAULT, format: FORMAT_KIND.COLOUR,
        usage: D3DUSAGE.RENDERTARGET, valid: true,
    },
    {
        pool: D3DPOOL.DEFAULT, format: FORMAT_KIND.DEPTH,
        usage: D3DUSAGE.RENDERTARGET, valid: false,
    },
    {
        pool: D3DPOOL.DEFAULT, format: FORMAT_KIND.COLOUR,
        usage: D3DUSAGE.DEPTHSTENCIL, valid: false,
    },
    {
        pool: D3DPOOL.DEFAULT, format: FORMAT_KIND.DEPTH,
        usage: D3DUSAGE.DEPTHSTENCIL, valid: true,
    },
    { pool: D3DPOOL.DEFAULT, format: FORMAT_KIND.COLOUR, usage: D3DUSAGE.DYNAMIC, valid: true },
    { pool: D3DPOOL.DEFAULT, format: FORMAT_KIND.DEPTH, usage: D3DUSAGE.DYNAMIC, valid: true },
    {
        pool: D3DPOOL.DEFAULT, format: FORMAT_KIND.COLOUR,
        usage: D3DUSAGE.DYNAMIC | D3DUSAGE.RENDERTARGET, valid: false,
    },
    {
        pool: D3DPOOL.DEFAULT, format: FORMAT_KIND.DEPTH,
        usage: D3DUSAGE.DYNAMIC | D3DUSAGE.RENDERTARGET, valid: false,
    },
    {
        pool: D3DPOOL.DEFAULT, format: FORMAT_KIND.COLOUR,
        usage: D3DUSAGE.DYNAMIC | D3DUSAGE.DEPTHSTENCIL, valid: false,
    },
    {
        pool: D3DPOOL.DEFAULT, format: FORMAT_KIND.DEPTH,
        usage: D3DUSAGE.DYNAMIC | D3DUSAGE.DEPTHSTENCIL, valid: false,
    },

    { pool: D3DPOOL.MANAGED, format: FORMAT_KIND.COLOUR, usage: 0, valid: true },
    { pool: D3DPOOL.MANAGED, format: FORMAT_KIND.DEPTH, usage: 0, valid: false },
    {
        pool: D3DPOOL.MANAGED, format: FORMAT_KIND.COLOUR,
        usage: D3DUSAGE.RENDERTARGET, valid: false,
    },
    {
        pool: D3DPOOL.MANAGED, format: FORMAT_KIND.DEPTH,
        usage: D3DUSAGE.RENDERTARGET, valid: false,
    },
    {
        pool: D3DPOOL.MANAGED, format: FORMAT_KIND.COLOUR,
        usage: D3DUSAGE.DEPTHSTENCIL, valid: false,
    },
    {
        pool: D3DPOOL.MANAGED, format: FORMAT_KIND.DEPTH,
        usage: D3DUSAGE.DEPTHSTENCIL, valid: false,
    },

    { pool: D3DPOOL.SYSTEMMEM, format: FORMAT_KIND.COLOUR, usage: 0, valid: true },
    { pool: D3DPOOL.SYSTEMMEM, format: FORMAT_KIND.DEPTH, usage: 0, valid: false },
    {
        pool: D3DPOOL.SYSTEMMEM, format: FORMAT_KIND.COLOUR,
        usage: D3DUSAGE.RENDERTARGET, valid: false,
    },
    {
        pool: D3DPOOL.SYSTEMMEM, format: FORMAT_KIND.DEPTH,
        usage: D3DUSAGE.RENDERTARGET, valid: false,
    },
    {
        pool: D3DPOOL.SYSTEMMEM, format: FORMAT_KIND.COLOUR,
        usage: D3DUSAGE.DEPTHSTENCIL, valid: false,
    },
    {
        pool: D3DPOOL.SYSTEMMEM, format: FORMAT_KIND.DEPTH,
        usage: D3DUSAGE.DEPTHSTENCIL, valid: false,
    },

    { pool: D3DPOOL.SCRATCH, format: FORMAT_KIND.COLOUR, usage: 0, valid: true },
    { pool: D3DPOOL.SCRATCH, format: FORMAT_KIND.DEPTH, usage: 0, valid: false },
    {
        pool: D3DPOOL.SCRATCH, format: FORMAT_KIND.COLOUR,
        usage: D3DUSAGE.RENDERTARGET, valid: false,
    },
    {
        pool: D3DPOOL.SCRATCH, format: FORMAT_KIND.DEPTH,
        usage: D3DUSAGE.RENDERTARGET, valid: false,
    },
    {
        pool: D3DPOOL.SCRATCH, format: FORMAT_KIND.COLOUR,
        usage: D3DUSAGE.DEPTHSTENCIL, valid: false,
    },
    {
        pool: D3DPOOL.SCRATCH, format: FORMAT_KIND.DEPTH,
        usage: D3DUSAGE.DEPTHSTENCIL, valid: false,
    },
]);

/**
 * @typedef {Object} AdapterFormatSupport
 * @property {boolean} depthTexture2d  Depth formats usable as a 2D texture.
 * @property {boolean} depthCube
 * @property {boolean} depthPlain      Depth formats usable as an offscreen plain surface.
 */

/**
 * @param {string} surfaceType   A SURFACE_TYPE.
 * @param {ResourceValidityRow} row
 * @param {AdapterFormatSupport} support
 * @returns {number} D3D_OK or D3DERR_INVALIDCALL
 */
export function surfaceCreateResult(surfaceType, row, support){
    const depth = row.format === FORMAT_KIND.DEPTH;
    switch (surfaceType)
    {
        case SURFACE_TYPE.TEXTURE_2D:
            return row.valid && (!depth || support.depthTexture2d) ? D3D_OK : D3DERR_INVALIDCALL;
        case SURFACE_TYPE.CUBE:
            return row.valid && (!depth || support.depthCube) ? D3D_OK : D3DERR_INVALIDCALL;
        // The render target and depth stencil entry points name the usage
        // themselves, so only the format has a say; the row's pool and usage
        // never reach them.
        case SURFACE_TYPE.RENDER_TARGET:
            return depth ? D3DERR_INVALIDCALL : D3D_OK;
        case SURFACE_TYPE.DEPTH_STENCIL:
            return depth ? D3D_OK : D3DERR_INVALIDCALL;
        case SURFACE_TYPE.PLAIN:
            return row.pool !== D3DPOOL.MANAGED && (!depth || support.depthPlain)
                ? D3D_OK
                : D3DERR_INVALIDCALL;
        default:
            return D3DERR_INVALIDCALL;
    }
}

/**
 * How many levels a volume of this extent has when all are asked for: down
 * to a single texel on its longest axis.
 *
 * @param {number} width @param {number} height @param {number} depth
 */
export function volumeLevelCount(width, height, depth){
    let levels = 1;
    for (let extent = Math.max(width, height, depth); extent > 1; extent >>>= 1)
    {
        levels++;
    }
    return levels;
}

/**
 * Whether a volume texture of these arguments is made, in either version
 * (Wine's d3d8 and d3d9 test_volume_locking and test_lockbox_invalid, d3d9
 * test_mipmap_gen): never a render target, a depth buffer, write-only or
 * mipmapped by the device, and dynamic only in the default or system-memory
 * pool. A depth format and a format in blocks are refused too: nothing here
 * uploads either as a volume.
 *
 * @param {{ width: number, height: number, depth: number, levels: number, usage: number,
 *           format: number, pool: number, maxExtent: number }} request
 *        `levels` zero for the whole chain.
 * @returns {number} D3D_OK or D3DERR_INVALIDCALL
 */
export function volumeCreateResult(request){
    const info = FORMAT_INFO[request.format];
    if (!info || info.depth || info.blockBytes !== undefined)
    {
        return D3DERR_INVALIDCALL;
    }
    if ((request.usage & (D3DUSAGE.RENDERTARGET | D3DUSAGE.DEPTHSTENCIL
        | D3DUSAGE.WRITEONLY | D3DUSAGE.AUTOGENMIPMAP)) !== 0)
    {
        return D3DERR_INVALIDCALL;
    }
    if ((request.usage & D3DUSAGE.DYNAMIC) !== 0
        && request.pool !== D3DPOOL.DEFAULT && request.pool !== D3DPOOL.SYSTEMMEM)
    {
        return D3DERR_INVALIDCALL;
    }
    const extents = [request.width, request.height, request.depth];
    if (!extents.every(extent=>extent > 0 && extent <= request.maxExtent)
        || request.levels > volumeLevelCount(request.width, request.height, request.depth))
    {
        return D3DERR_INVALIDCALL;
    }
    return D3D_OK;
}

/**
 * Whether a created surface answers a lock. A depth stencil never does, however
 * it was asked for; a render target does exactly when it was created lockable.
 *
 * @param {{ type: string, pool: number, usage: number, lockable?: boolean }} surface
 * @returns {boolean}
 */
export function surfaceIsLockable(surface){
    if (surface.type === SURFACE_TYPE.PLAIN)
    {
        return true;
    }
    if (surface.type === SURFACE_TYPE.DEPTH_STENCIL)
    {
        return false;
    }
    if (surface.type === SURFACE_TYPE.RENDER_TARGET)
    {
        return surface.lockable === true;
    }
    return surface.pool !== D3DPOOL.DEFAULT || (surface.usage & D3DUSAGE.DYNAMIC) !== 0;
}

/**
 * The highest back-buffer count each swap effect allows. A swap effect outside
 * this map is rejected outright, which covers zero, the two the Ex API added,
 * and anything past them.
 *
 * @type {Readonly<Record<number, number>>}
 */
export const SWAP_EFFECT_MAX_BACK_BUFFERS = Object.freeze({
    [D3DSWAPEFFECT.DISCARD]: 3,
    [D3DSWAPEFFECT.FLIP]: 3,
    [D3DSWAPEFFECT.COPY]: 1,
});

/**
 * @typedef {Object} PresentParameters
 * @property {number} swapEffect
 * @property {number} [backBufferCount]  Zero means one, which is what a device reports back.
 * @property {boolean} [windowed]
 * @property {boolean} [enableAutoDepthStencil]
 * @property {number} [autoDepthStencilFormat]
 * @property {number} [backBufferWidth]
 * @property {number} [backBufferHeight]
 * @property {number} [backBufferFormat]
 * @property {boolean} [lockableBackBuffer]  D3DPRESENTFLAG_LOCKABLE_BACKBUFFER was asked for.
 */

/**
 * @param {PresentParameters} parameters
 * @returns {number} D3D_OK or D3DERR_INVALIDCALL
 */
export function validatePresentParameters(parameters){
    const limit = SWAP_EFFECT_MAX_BACK_BUFFERS[parameters.swapEffect];
    if (limit === undefined)
    {
        return D3DERR_INVALIDCALL;
    }
    return (parameters.backBufferCount ?? 0) > limit ? D3DERR_INVALIDCALL : D3D_OK;
}

/**
 * @param {PresentParameters} parameters
 * @returns {number} the count the swap chain reports, which is never zero
 */
export function reportedBackBufferCount(parameters){
    return parameters.backBufferCount ? parameters.backBufferCount : 1;
}
