/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a D3D8 device agrees to, where its answer differs from D3D9's.
 *
 * The pool x usage x format table is not here, and that is the point: it is
 * the same table in both versions, down to the row, so it is imported. Three
 * things genuinely differ and are written out:
 *
 * - **The swap effects.** D3D8 has a fourth, COPY_VSYNC, which limits the back
 *   buffer count the same way COPY does. D3D9 dropped it and later reused the
 *   value for an Ex-only effect, so the two tables cannot be shared even though
 *   they agree on their first three rows.
 * - **The pair a render target is set as.** D3D8 binds the colour target and
 *   the depth stencil in one call, so the rules for both live in one place.
 * - **CopyRects**, which D3D9 does not have at all.
 */

import {
    D3DERR_INVALIDCALL, D3DPOOL, D3DSWAPEFFECT, D3DTEXF, D3DTSS, D3DUSAGE, D3D_OK, FORMAT_INFO,
    isCompressed, isVideo, videoPoolAllowed,
} from './constants.js';
import {
    FORMAT_KIND, RESOURCE_VALIDITY, SURFACE_TYPE, surfaceCreateResult,
} from '../d3d9/validity.js';
import { D3DTA, D3DTOP, argumentsRead } from '../webgpu/internal/fixedfunction.js';

/** ValidateDevice's refusals: MAKE_D3DHRESULT of the codes d3d8.h and d3d9.h give them. */
export const D3DERR_UNSUPPORTEDCOLOROPERATION = 0x88760819;
export const D3DERR_UNSUPPORTEDCOLORARG = 0x8876081a;
export const D3DERR_UNSUPPORTEDALPHAOPERATION = 0x8876081b;
export const D3DERR_UNSUPPORTEDALPHAARG = 0x8876081c;
export const D3DERR_UNSUPPORTEDTEXTUREFILTER = 0x88760822;

export {
    FORMAT_KIND, RESOURCE_VALIDITY, SURFACE_TYPE, reportedBackBufferCount, surfaceCreateResult,
    surfaceIsLockable,
} from '../d3d9/validity.js';

/** The usage bits the validity table has a column for; the rest do not select a row. */
const TABLE_USAGE = D3DUSAGE.RENDERTARGET | D3DUSAGE.DEPTHSTENCIL | D3DUSAGE.DYNAMIC;

/**
 * The row of the shared pool x format x usage table these arguments select.
 *
 * @param {number} format
 * @param {number} pool
 * @param {number} usage
 * @returns {import('../d3d9/validity.js').ResourceValidityRow | undefined}
 */
export function validityRow(format, pool, usage){
    const info = FORMAT_INFO[format];
    if (!info)
    {
        return undefined;
    }
    const kind = info.depth ? FORMAT_KIND.DEPTH : FORMAT_KIND.COLOUR;
    return RESOURCE_VALIDITY.find(row=>
        row.pool === pool && row.format === kind && row.usage === (usage & TABLE_USAGE));
}

/**
 * @typedef {Object} AdapterFormatSupport
 * @property {boolean} depthTexture2d
 * @property {boolean} depthCube
 * @property {boolean} depthPlain
 */

/**
 * @param {string} surfaceType   A SURFACE_TYPE.
 * @param {number} format
 * @param {number} pool
 * @param {number} usage
 * @param {AdapterFormatSupport} support
 * @returns {number} D3D_OK or D3DERR_INVALIDCALL
 */
export function createResult(surfaceType, format, pool, usage, support){
    // A write-only texture is a contradiction the API rejects before the table
    // is consulted at all -- there is no column for it.
    if ((usage & D3DUSAGE.WRITEONLY) !== 0)
    {
        return D3DERR_INVALIDCALL;
    }
    if (isVideo(format))
    {
        return usage === 0 && videoPoolAllowed(pool, surfaceType === SURFACE_TYPE.PLAIN)
            ? D3D_OK : D3DERR_INVALIDCALL;
    }
    if (isCompressed(format) || FORMAT_INFO[format]?.signed)
    {
        // Legal on every device of the era regardless of `compressedTextures`
        // -- that flag only chooses how the surface's bytes reach the GPU
        // (blocks or a decode), never whether the format exists. Nothing may
        // be drawn into a compressed surface, whatever the adapter supports --
        // the blocks are not writable by the pipeline -- nor into a signed
        // one, which is only ever sampled.
        if (surfaceType === SURFACE_TYPE.RENDER_TARGET
            || surfaceType === SURFACE_TYPE.DEPTH_STENCIL)
        {
            return D3DERR_INVALIDCALL;
        }
    }
    const row = validityRow(format, pool, usage);
    return row ? surfaceCreateResult(surfaceType, row, support) : D3DERR_INVALIDCALL;
}

/**
 * The highest back-buffer count each swap effect allows. A swap effect outside
 * this map is rejected outright, which covers zero and anything past the four
 * D3D8 defines.
 *
 * @type {Readonly<Record<number, number>>}
 */
export const SWAP_EFFECT_MAX_BACK_BUFFERS = Object.freeze({
    [D3DSWAPEFFECT.DISCARD]: 3,
    [D3DSWAPEFFECT.FLIP]: 3,
    [D3DSWAPEFFECT.COPY]: 1,
    [D3DSWAPEFFECT.COPY_VSYNC]: 1,
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
 * @property {number} [flags]  D3DPRESENTFLAG_*, which decide what the swap
 *           chain itself will allow -- locking the back buffer, above all.
 */

/**
 * The rule is the same in windowed and fullscreen mode, which is worth stating
 * because the parameters carry the distinction and it would be natural to
 * assume it matters here. It does not.
 *
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
 * CreateImageSurface takes no pool: the surface is always system memory with
 * no usage, so the only question left is the format, and the only format that
 * can fail is a depth one on an adapter that does not offer depth formats as
 * plain surfaces.
 *
 * @param {number} format
 * @param {AdapterFormatSupport} support
 * @returns {number}
 */
export function imageSurfaceCreateResult(format, support){
    return createResult(SURFACE_TYPE.PLAIN, format, D3DPOOL.SYSTEMMEM, 0, support);
}

/**
 * Whether a pair of surfaces may be bound as the device's targets.
 *
 * Usage decides and nothing else does: a surface reached through a texture is
 * a legal colour target exactly when the texture was created with
 * D3DUSAGE_RENDERTARGET, so asking what kind of object it came from would give
 * the wrong answer.
 *
 * A null colour target is not an unbind: it means "leave the one that is
 * already there", which is how the entry point reaches a program that only
 * wants to change the depth stencil. A null depth stencil *is* an unbind, and
 * that asymmetry is why each side is tested separately.
 *
 * @param {{ Usage: number } | null} renderTarget
 * @param {{ Usage: number } | null} depthStencil
 * @returns {number}
 */
export function targetPairResult(renderTarget, depthStencil){
    if (renderTarget && (renderTarget.Usage & D3DUSAGE.RENDERTARGET) === 0)
    {
        return D3DERR_INVALIDCALL;
    }
    if (depthStencil && (depthStencil.Usage & D3DUSAGE.DEPTHSTENCIL) === 0)
    {
        return D3DERR_INVALIDCALL;
    }
    return D3D_OK;
}

/**
 * @typedef {Object} CopyableSurface
 * @property {string} type
 * @property {number} format
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} CopyRect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * Whether CopyRects would accept these arguments.
 *
 * Two rules are measured. A depth stencil is refused on either side, whatever
 * the rectangles are and whether or not it is the bound one -- there is no
 * combination of the two that works. And the call cannot stretch, so the
 * destination extent is the source extent and the destination point decides
 * where it lands.
 *
 * The rest is this layer's reading of what "copy" has to mean and is marked as
 * such where it is asserted: matching formats, a rectangle inside its surface,
 * and a rectangle whose edges are the right way round.
 *
 * @param {CopyableSurface} source
 * @param {CopyableSurface} destination
 * @param {readonly CopyRect[] | null} rects
 * @param {readonly { x: number, y: number }[] | null} points
 * @returns {number}
 */
export function copyRectsResult(source, destination, rects, points){
    if (source.type === SURFACE_TYPE.DEPTH_STENCIL
        || destination.type === SURFACE_TYPE.DEPTH_STENCIL)
    {
        return D3DERR_INVALIDCALL;
    }
    if (source.format !== destination.format)
    {
        return D3DERR_INVALIDCALL;
    }
    if (!rects || rects.length === 0)
    {
        // The whole surface travels, so the two must be the same size.
        return source.width === destination.width && source.height === destination.height
            ? D3D_OK
            : D3DERR_INVALIDCALL;
    }
    if (!points || points.length !== rects.length)
    {
        return D3DERR_INVALIDCALL;
    }
    for (let index = 0; index < rects.length; index++)
    {
        const rect = rects[index];
        const point = points[index];
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        if (width <= 0 || height <= 0)
        {
            return D3DERR_INVALIDCALL;
        }
        if (rect.left < 0 || rect.top < 0
            || rect.right > source.width || rect.bottom > source.height)
        {
            return D3DERR_INVALIDCALL;
        }
        if (point.x < 0 || point.y < 0
            || point.x + width > destination.width || point.y + height > destination.height)
        {
            return D3DERR_INVALIDCALL;
        }
    }
    return D3D_OK;
}

/** The operations the fixed-function combiner draws. @type {Set<number>} */
const COMBINED_OPS = new Set(Object.values(D3DTOP));

/**
 * The same, as D3DTEXOPCAPS: operation n is bit n - 1. A cap derived from the
 * combiner cannot claim an operation the combiner lacks.
 */
export const TEXTURE_OP_CAPS = [...COMBINED_OPS]
    .reduce((caps, op)=>(caps | (1 << (op - 1))) >>> 0, 0);

/**
 * The argument sources the combiner reads: diffuse, current, texture, factor,
 * specular.
 *
 * @type {Set<number>}
 */
const COMBINED_SOURCES = new Set([
    D3DTA.DIFFUSE, D3DTA.CURRENT, D3DTA.TEXTURE, D3DTA.TFACTOR, D3DTA.SPECULAR,
]);

/** What a stage may minify and magnify by. @type {Set<number>} */
const SAMPLED_FILTERS = new Set([D3DTEXF.POINT, D3DTEXF.LINEAR]);
/** What may pick its mip level. @type {Set<number>} */
const MIP_FILTERS = new Set([D3DTEXF.NONE, D3DTEXF.POINT, D3DTEXF.LINEAR]);

/**
 * ValidateDevice's answer for the texture stages as they stand: D3D_OK when
 * the combiner draws the cascade -- in the one pass it draws everything in --
 * or the documented refusal naming the first thing it cannot. Only stages up
 * to the first disabled one are drawn, and only the arguments an operation
 * reads are looked at.
 *
 * @param {(stage: number) => Map<number, number>} stageStates
 * @param {number} stageCount
 * @param {{ filters?: boolean }} [options]  whether the stages hold filters in
 *        the D3DTEXF numbering, which Direct3D 7's do not
 * @returns {number} HRESULT
 */
export function validateStages(stageStates, stageCount, options = {}){
    /** @param {number} arg */
    const readable = arg=>COMBINED_SOURCES.has(arg & D3DTA.SELECTMASK);
    for (let stage = 0; stage < stageCount; stage++)
    {
        const states = stageStates(stage);
        const colorOp = states.get(D3DTSS.COLOROP) ?? 0;
        if (colorOp === D3DTOP.DISABLE)
        {
            break;
        }
        if (!COMBINED_OPS.has(colorOp))
        {
            return D3DERR_UNSUPPORTEDCOLOROPERATION;
        }
        if (!argumentsRead(colorOp, states.get(D3DTSS.COLORARG1) ?? 0,
            states.get(D3DTSS.COLORARG2) ?? 0, states.get(D3DTSS.COLORARG0) ?? D3DTA.CURRENT)
            .every(readable))
        {
            return D3DERR_UNSUPPORTEDCOLORARG;
        }
        const alphaOp = states.get(D3DTSS.ALPHAOP) ?? 0;
        // The bump operations move the next stage's coordinate; an alpha has
        // no coordinate to move, and no driver takes them there.
        if (!COMBINED_OPS.has(alphaOp) || alphaOp === D3DTOP.BUMPENVMAP
            || alphaOp === D3DTOP.BUMPENVMAPLUMINANCE)
        {
            return D3DERR_UNSUPPORTEDALPHAOPERATION;
        }
        if (!argumentsRead(alphaOp, states.get(D3DTSS.ALPHAARG1) ?? 0,
            states.get(D3DTSS.ALPHAARG2) ?? 0, states.get(D3DTSS.ALPHAARG0) ?? D3DTA.CURRENT)
            .every(readable))
        {
            return D3DERR_UNSUPPORTEDALPHAARG;
        }
    }
    if (options.filters !== false)
    {
        for (let stage = 0; stage < stageCount; stage++)
        {
            const states = stageStates(stage);
            if (!SAMPLED_FILTERS.has(states.get(D3DTSS.MAGFILTER) ?? D3DTEXF.POINT)
                || !SAMPLED_FILTERS.has(states.get(D3DTSS.MINFILTER) ?? D3DTEXF.POINT)
                || !MIP_FILTERS.has(states.get(D3DTSS.MIPFILTER) ?? D3DTEXF.NONE))
            {
                return D3DERR_UNSUPPORTEDTEXTUREFILTER;
            }
        }
    }
    return D3D_OK;
}
