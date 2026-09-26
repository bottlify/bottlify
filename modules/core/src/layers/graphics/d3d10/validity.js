/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which resources a Direct3D 10 device agrees to create, and which swap chains
 * DXGI agrees to make.
 *
 * These are tables, not branches. Usage, bind flags and CPU access interact in
 * ways that are simply enumerated -- there is no rule underneath to factor out
 * -- and a table can be walked by a test, which a chain of conditions cannot.
 *
 * The shape worth naming, because it is the whole of the resource model:
 * **usage says who may write, and bind flags say who may read.** `DEFAULT` is
 * the GPU's to write and the CPU's to never touch; `IMMUTABLE` is nobody's,
 * which is why the contents have to arrive with the creation call; `DYNAMIC` is
 * the CPU's to write and so cannot be a render target or a stream-output
 * target; `STAGING` is neither side's to use in the pipeline at all, so it
 * takes no bind flag whatsoever and exists only to move bytes. `DYNAMIC` and
 * `STAGING` further *require* a CPU access flag -- a resource the CPU cannot
 * touch has no reason to be either -- which is the row of the table most often
 * got wrong, because it is a requirement rather than a permission.
 */

import {
    ALL_REMAINING, D3D10_BIND, D3D10_CPU_ACCESS, D3D10_LIMITS, D3D10_RESOURCE_MISC, D3D10_USAGE,
    DXGI_FORMAT, DXGI_SWAP_EFFECT, DXGI_USAGE, E_INVALIDARG, FORMAT_INFO, FORMAT_KIND, S_OK,
} from './constants.js';

/**
 * @typedef {Object} ResourceAccessRow
 * @property {number} usage
 * @property {number} bindFlags
 * @property {boolean} valid              Whether usage and bind flags may be combined at all.
 * @property {number} allowedCpuAccess    The CPU access bits this row permits, and no others.
 */

/**
 * Usage x bind flag, and the CPU access each combination allows. A zero bind
 * flag is a row of its own because it is the only one `STAGING` accepts and the
 * only one `IMMUTABLE` and `DYNAMIC` refuse.
 *
 * @type {readonly ResourceAccessRow[]}
 */
export const RESOURCE_ACCESS = Object.freeze([
    { usage: D3D10_USAGE.DEFAULT, bindFlags: 0, valid: true, allowedCpuAccess: 0 },
    {
        usage: D3D10_USAGE.DEFAULT, bindFlags: D3D10_BIND.VERTEX_BUFFER,
        valid: true, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.DEFAULT, bindFlags: D3D10_BIND.INDEX_BUFFER,
        valid: true, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.DEFAULT, bindFlags: D3D10_BIND.CONSTANT_BUFFER,
        valid: true, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.DEFAULT, bindFlags: D3D10_BIND.SHADER_RESOURCE,
        valid: true, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.DEFAULT, bindFlags: D3D10_BIND.STREAM_OUTPUT,
        valid: true, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.DEFAULT, bindFlags: D3D10_BIND.RENDER_TARGET,
        valid: true, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.DEFAULT, bindFlags: D3D10_BIND.DEPTH_STENCIL,
        valid: true, allowedCpuAccess: 0,
    },

    { usage: D3D10_USAGE.IMMUTABLE, bindFlags: 0, valid: false, allowedCpuAccess: 0 },
    {
        usage: D3D10_USAGE.IMMUTABLE, bindFlags: D3D10_BIND.VERTEX_BUFFER,
        valid: true, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.IMMUTABLE, bindFlags: D3D10_BIND.INDEX_BUFFER,
        valid: true, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.IMMUTABLE, bindFlags: D3D10_BIND.CONSTANT_BUFFER,
        valid: true, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.IMMUTABLE, bindFlags: D3D10_BIND.SHADER_RESOURCE,
        valid: true, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.IMMUTABLE, bindFlags: D3D10_BIND.STREAM_OUTPUT,
        valid: false, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.IMMUTABLE, bindFlags: D3D10_BIND.RENDER_TARGET,
        valid: false, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.IMMUTABLE, bindFlags: D3D10_BIND.DEPTH_STENCIL,
        valid: false, allowedCpuAccess: 0,
    },

    {
        usage: D3D10_USAGE.DYNAMIC, bindFlags: 0,
        valid: false, allowedCpuAccess: D3D10_CPU_ACCESS.WRITE,
    },
    {
        usage: D3D10_USAGE.DYNAMIC, bindFlags: D3D10_BIND.VERTEX_BUFFER,
        valid: true, allowedCpuAccess: D3D10_CPU_ACCESS.WRITE,
    },
    {
        usage: D3D10_USAGE.DYNAMIC, bindFlags: D3D10_BIND.INDEX_BUFFER,
        valid: true, allowedCpuAccess: D3D10_CPU_ACCESS.WRITE,
    },
    {
        usage: D3D10_USAGE.DYNAMIC, bindFlags: D3D10_BIND.CONSTANT_BUFFER,
        valid: true, allowedCpuAccess: D3D10_CPU_ACCESS.WRITE,
    },
    {
        usage: D3D10_USAGE.DYNAMIC, bindFlags: D3D10_BIND.SHADER_RESOURCE,
        valid: true, allowedCpuAccess: D3D10_CPU_ACCESS.WRITE,
    },
    {
        usage: D3D10_USAGE.DYNAMIC, bindFlags: D3D10_BIND.STREAM_OUTPUT,
        valid: false, allowedCpuAccess: D3D10_CPU_ACCESS.WRITE,
    },
    {
        usage: D3D10_USAGE.DYNAMIC, bindFlags: D3D10_BIND.RENDER_TARGET,
        valid: false, allowedCpuAccess: D3D10_CPU_ACCESS.WRITE,
    },
    {
        usage: D3D10_USAGE.DYNAMIC, bindFlags: D3D10_BIND.DEPTH_STENCIL,
        valid: false, allowedCpuAccess: D3D10_CPU_ACCESS.WRITE,
    },

    {
        usage: D3D10_USAGE.STAGING, bindFlags: 0, valid: true,
        allowedCpuAccess: D3D10_CPU_ACCESS.WRITE | D3D10_CPU_ACCESS.READ,
    },
    {
        usage: D3D10_USAGE.STAGING, bindFlags: D3D10_BIND.VERTEX_BUFFER,
        valid: false, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.STAGING, bindFlags: D3D10_BIND.INDEX_BUFFER,
        valid: false, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.STAGING, bindFlags: D3D10_BIND.CONSTANT_BUFFER,
        valid: false, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.STAGING, bindFlags: D3D10_BIND.SHADER_RESOURCE,
        valid: false, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.STAGING, bindFlags: D3D10_BIND.STREAM_OUTPUT,
        valid: false, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.STAGING, bindFlags: D3D10_BIND.RENDER_TARGET,
        valid: false, allowedCpuAccess: 0,
    },
    {
        usage: D3D10_USAGE.STAGING, bindFlags: D3D10_BIND.DEPTH_STENCIL,
        valid: false, allowedCpuAccess: 0,
    },
]);

/**
 * @param {number} usage
 * @param {number} bindFlags
 * @returns {ResourceAccessRow | null}
 */
export function resourceAccessRow(usage, bindFlags){
    return RESOURCE_ACCESS.find(row=>row.usage === usage && row.bindFlags === bindFlags) ?? null;
}

/**
 * Whether a usage cannot exist without the CPU being able to reach the
 * resource. This is the half of the table that is a requirement rather than a
 * permission, and it is why a `DYNAMIC` resource with no CPU access flag fails.
 *
 * @param {number} usage
 * @returns {boolean}
 */
export function usageRequiresCpuAccess(usage){
    return usage === D3D10_USAGE.DYNAMIC || usage === D3D10_USAGE.STAGING;
}

/**
 * The table lists one bind flag per row, and a resource may carry several. A
 * combination is checked bit by bit rather than looked up whole: every flag has
 * to be legal for the usage on its own, and the CPU access the combination
 * allows is what all of them agree on. That is why sampling a depth buffer is
 * expressible -- `SHADER_RESOURCE | DEPTH_STENCIL` is two valid rows -- while
 * `STAGING` with any flag at all is not.
 *
 * @param {number} usage
 * @param {number} bindFlags
 * @param {number} cpuAccessFlags
 * @returns {number} S_OK or E_INVALIDARG
 */
export function resourceAccessResult(usage, bindFlags, cpuAccessFlags){
    let allowed = D3D10_CPU_ACCESS.READ | D3D10_CPU_ACCESS.WRITE;
    if (bindFlags === 0)
    {
        const row = resourceAccessRow(usage, 0);
        if (!row || !row.valid)
        {
            return E_INVALIDARG;
        }
        allowed = row.allowedCpuAccess;
    }
    for (const bit of Object.values(D3D10_BIND))
    {
        if ((bindFlags & bit) === 0)
        {
            continue;
        }
        const row = resourceAccessRow(usage, bit);
        if (!row || !row.valid)
        {
            return E_INVALIDARG;
        }
        allowed &= row.allowedCpuAccess;
    }
    // A flag outside the enumeration has no row to be judged by, so it is a
    // request this API cannot answer rather than one it ignores.
    const known = Object.values(D3D10_BIND).reduce((all, bit)=>all | bit, 0);
    if ((bindFlags & ~known) !== 0)
    {
        return E_INVALIDARG;
    }
    if (usageRequiresCpuAccess(usage) && cpuAccessFlags === 0)
    {
        return E_INVALIDARG;
    }
    return (cpuAccessFlags & ~allowed) === 0 ? S_OK : E_INVALIDARG;
}

/** The bind flags that only a buffer may carry. */
export const BUFFER_ONLY_BIND_FLAGS =
    D3D10_BIND.VERTEX_BUFFER | D3D10_BIND.INDEX_BUFFER | D3D10_BIND.CONSTANT_BUFFER;

/**
 * The typeless families that contain a depth format, and therefore the only
 * ones a depth stencil may be created over. Derived from the format table so
 * that adding a format cannot leave a second list stale.
 *
 * @type {ReadonlySet<number>}
 */
export const DEPTH_CAPABLE_FAMILIES = new Set(Object.entries(FORMAT_INFO)
    .filter(([, info])=>info.kind === FORMAT_KIND.DEPTH)
    .map(([, info])=>info.family));

/**
 * The typeless families with a member a render target may be made of, derived
 * the same way.
 *
 * @type {ReadonlySet<number>}
 */
export const RENDERABLE_FAMILIES = new Set(Object.entries(FORMAT_INFO)
    .filter(([, info])=>info.kind === FORMAT_KIND.COLOUR && info.renderable)
    .map(([, info])=>info.family));

/**
 * Whether a texture of this format may carry this single bind flag.
 *
 * A depth format may only ever be a depth stencil, and a colour format may
 * never be one. A typeless format sits between them: it may be anything its
 * family can express, which is what lets a program write depth through one view
 * of a resource and sample it through another. A render target is further
 * limited to the formats a pixel shader can write.
 *
 * @param {number} format
 * @param {number} bindFlag  Exactly one bit.
 * @returns {boolean}
 */
export function formatAllowsBind(format, bindFlag){
    const info = FORMAT_INFO[format];
    if (!info)
    {
        return false;
    }
    if (bindFlag === D3D10_BIND.DEPTH_STENCIL)
    {
        return info.kind === FORMAT_KIND.DEPTH
            || (info.kind === FORMAT_KIND.TYPELESS && DEPTH_CAPABLE_FAMILIES.has(info.family));
    }
    if (bindFlag === D3D10_BIND.RENDER_TARGET)
    {
        // A shared exponent, a compressed block or the sampled half of a depth
        // format is read by a shader and never written by one.
        return info.kind === FORMAT_KIND.TYPELESS
            ? RENDERABLE_FAMILIES.has(info.family)
            : info.renderable;
    }
    if (bindFlag === D3D10_BIND.SHADER_RESOURCE)
    {
        return info.kind !== FORMAT_KIND.DEPTH;
    }
    return false;
}

/**
 * @param {number} width
 * @param {number} height
 * @param {number} depth
 * @returns {number} the number of mip levels a full chain has
 */
export function fullMipChainLength(width, height, depth){
    let levels = 1;
    let extent = Math.max(width, height, depth);
    while (extent > 1)
    {
        extent >>>= 1;
        levels++;
    }
    return levels;
}

/**
 * @param {number} size
 * @param {number} level
 * @returns {number} the extent of a mip level, never smaller than one texel
 */
export function levelExtent(size, level){
    return Math.max(1, size >>> level);
}

/**
 * @typedef {Object} BufferDesc
 * @property {number} ByteWidth
 * @property {number} Usage
 * @property {number} BindFlags
 * @property {number} CPUAccessFlags
 * @property {number} MiscFlags
 */

/**
 * @param {BufferDesc} desc
 * @param {boolean} hasInitialData
 * @returns {number} S_OK or E_INVALIDARG
 */
export function bufferCreateResult(desc, hasInitialData){
    if (desc.ByteWidth === 0)
    {
        return E_INVALIDARG;
    }
    // A constant buffer is fetched a register at a time, and a register is four
    // floats: a size that is not a whole number of them has no meaning.
    if ((desc.BindFlags & D3D10_BIND.CONSTANT_BUFFER) !== 0
        && desc.ByteWidth % D3D10_LIMITS.CONSTANT_BUFFER_SIZE_GRANULARITY !== 0)
    {
        return E_INVALIDARG;
    }
    if (!hasInitialData && desc.Usage === D3D10_USAGE.IMMUTABLE)
    {
        return E_INVALIDARG;
    }
    return resourceAccessResult(desc.Usage, desc.BindFlags, desc.CPUAccessFlags);
}

/**
 * @typedef {Object} TextureDesc
 * @property {number} Width
 * @property {number} [Height]
 * @property {number} [Depth]
 * @property {number} MipLevels     Zero asks for the full chain.
 * @property {number} [ArraySize]
 * @property {number} Format
 * @property {{ Count: number, Quality: number }} [SampleDesc]
 * @property {number} Usage
 * @property {number} BindFlags
 * @property {number} CPUAccessFlags
 * @property {number} MiscFlags
 */

/**
 * @typedef {Object} DeviceCaps
 * @property {(format: number, sampleCount: number) => number} multisampleQualityLevels
 *           Zero means the format cannot be multisampled at that count at all.
 */

/**
 * @param {number} dimension  A D3D10_RESOURCE_DIMENSION for a texture.
 * @returns {number} the largest extent that dimension allows
 */
function maxExtentFor(dimension){
    if (dimension === 2)
    {
        return D3D10_LIMITS.MAX_TEXTURE1D_DIMENSION;
    }
    return dimension === 4
        ? D3D10_LIMITS.MAX_TEXTURE3D_DIMENSION
        : D3D10_LIMITS.MAX_TEXTURE2D_DIMENSION;
}

/**
 * @param {TextureDesc} desc
 * @param {number} dimension  A D3D10_RESOURCE_DIMENSION.
 * @param {DeviceCaps} caps
 * @param {boolean} hasInitialData
 * @returns {number} S_OK or E_INVALIDARG
 */
export function textureCreateResult(desc, dimension, caps, hasInitialData){
    const arraySize = desc.ArraySize ?? 1;
    const height = desc.Height ?? 1;
    const depth = desc.Depth ?? 1;
    const sample = desc.SampleDesc ?? { Count: 1, Quality: 0 };
    const limit = maxExtentFor(dimension);

    if (desc.Width < 1 || height < 1 || depth < 1
        || desc.Width > limit || height > limit || depth > limit)
    {
        return E_INVALIDARG;
    }
    // A 3D texture has a depth instead of an array, so the field a 1D or 2D
    // texture counts slices in must never be zero -- and for a 3D texture it is
    // not a field the caller sets at all.
    if (dimension !== 4 && arraySize < 1)
    {
        return E_INVALIDARG;
    }
    if ((desc.BindFlags & BUFFER_ONLY_BIND_FLAGS) !== 0)
    {
        return E_INVALIDARG;
    }
    // Both at once would ask one surface to be written by the output merger's
    // colour and depth halves in the same draw.
    const renderAndDepth = D3D10_BIND.RENDER_TARGET | D3D10_BIND.DEPTH_STENCIL;
    if ((desc.BindFlags & renderAndDepth) === renderAndDepth)
    {
        return E_INVALIDARG;
    }
    for (const bindFlag of [
        D3D10_BIND.SHADER_RESOURCE, D3D10_BIND.RENDER_TARGET, D3D10_BIND.DEPTH_STENCIL,
    ])
    {
        if ((desc.BindFlags & bindFlag) !== 0 && !formatAllowsBind(desc.Format, bindFlag))
        {
            return E_INVALIDARG;
        }
    }
    if (!FORMAT_INFO[desc.Format])
    {
        return E_INVALIDARG;
    }

    // Generating a level means drawing into it from the one above, so the
    // texture has to be both a target and something a shader can read.
    const mipGeneration = D3D10_BIND.RENDER_TARGET | D3D10_BIND.SHADER_RESOURCE;
    if ((desc.MiscFlags & D3D10_RESOURCE_MISC.GENERATE_MIPS) !== 0
        && (desc.BindFlags & mipGeneration) !== mipGeneration)
    {
        return E_INVALIDARG;
    }
    const shared = D3D10_RESOURCE_MISC.SHARED | D3D10_RESOURCE_MISC.SHARED_KEYEDMUTEX;
    if ((desc.MiscFlags & shared) === shared)
    {
        return E_INVALIDARG;
    }
    if ((desc.MiscFlags & D3D10_RESOURCE_MISC.TEXTURECUBE) !== 0)
    {
        // A cube is six faces and, in this version of the API, exactly one cube:
        // arrays of cubes arrived with the next feature level.
        if (dimension !== 3 || arraySize !== 6)
        {
            return E_INVALIDARG;
        }
    }

    if (sample.Count < 1 || sample.Count > D3D10_LIMITS.MAX_MULTISAMPLE_SAMPLE_COUNT)
    {
        return E_INVALIDARG;
    }
    if (sample.Count > 1 || sample.Quality > 0)
    {
        const levels = caps.multisampleQualityLevels(desc.Format, sample.Count);
        if (levels === 0 || sample.Quality >= levels)
        {
            return E_INVALIDARG;
        }
    }

    if (desc.MipLevels > fullMipChainLength(desc.Width, height, depth))
    {
        return E_INVALIDARG;
    }
    if (!hasInitialData && desc.Usage === D3D10_USAGE.IMMUTABLE)
    {
        return E_INVALIDARG;
    }
    return resourceAccessResult(desc.Usage, desc.BindFlags, desc.CPUAccessFlags);
}

/**
 * Whether a view may name this format over a resource stored in that one.
 *
 * A view over a typed resource must name the same type or nothing at all; a
 * view over a typeless resource must name something, and that something has to
 * belong to the resource's family. `DXGI_FORMAT_UNKNOWN` over a typeless
 * resource is the case that catches people out: there is nothing to inherit.
 *
 * @param {number} resourceFormat
 * @param {number} viewFormat
 * @returns {number | null} the format the view ends up with, or null if refused
 */
export function resolveViewFormat(resourceFormat, viewFormat){
    const resource = FORMAT_INFO[resourceFormat];
    if (!resource)
    {
        return null;
    }
    if (viewFormat === DXGI_FORMAT.UNKNOWN)
    {
        return resource.kind === FORMAT_KIND.TYPELESS ? null : resourceFormat;
    }
    const view = FORMAT_INFO[viewFormat];
    if (!view || view.kind === FORMAT_KIND.TYPELESS || view.family !== resource.family)
    {
        return null;
    }
    return viewFormat;
}

/**
 * @param {number} requested
 * @param {number} available
 * @returns {number} how many slices a view covers, resolving "all remaining"
 */
export function resolveSliceCount(requested, available){
    return requested === ALL_REMAINING ? available : requested;
}

// --- swap chains ---

/**
 * @typedef {Object} SwapEffectRule
 * @property {number} minBuffers
 * @property {number} maxBuffers
 * @property {boolean} sequentialAccess  Whether buffers past zero can be read at all.
 * @property {boolean} allowsMultisample
 */

/**
 * What each swap effect allows.
 *
 * The two flip effects are the ones that surprise people twice over: they need
 * at least two buffers where the older effects accept one, and they refuse
 * multisampling outright, because a flip presents the buffer itself rather than
 * copying it and there is nothing left to resolve it into.
 *
 * @type {Readonly<Record<number, SwapEffectRule>>}
 */
export const SWAP_EFFECT_RULES = Object.freeze({
    [DXGI_SWAP_EFFECT.DISCARD]: Object.freeze({
        minBuffers: 1, maxBuffers: D3D10_LIMITS.MAX_SWAP_CHAIN_BUFFERS,
        sequentialAccess: false, allowsMultisample: true,
    }),
    [DXGI_SWAP_EFFECT.SEQUENTIAL]: Object.freeze({
        minBuffers: 1, maxBuffers: D3D10_LIMITS.MAX_SWAP_CHAIN_BUFFERS,
        sequentialAccess: true, allowsMultisample: true,
    }),
    [DXGI_SWAP_EFFECT.FLIP_SEQUENTIAL]: Object.freeze({
        minBuffers: 2, maxBuffers: D3D10_LIMITS.MAX_SWAP_CHAIN_BUFFERS,
        sequentialAccess: true, allowsMultisample: false,
    }),
    [DXGI_SWAP_EFFECT.FLIP_DISCARD]: Object.freeze({
        minBuffers: 2, maxBuffers: D3D10_LIMITS.MAX_SWAP_CHAIN_BUFFERS,
        sequentialAccess: false, allowsMultisample: false,
    }),
});

/**
 * @param {import('./structs.js').SwapChainFields} desc
 * @returns {number} S_OK or DXGI_ERROR_INVALID_CALL is the caller's to decide;
 *          this reports S_OK or E_INVALIDARG and the caller translates
 */
export function swapChainDescResult(desc){
    const rule = SWAP_EFFECT_RULES[desc.swapEffect];
    if (!rule)
    {
        return E_INVALIDARG;
    }
    if (desc.bufferCount < rule.minBuffers || desc.bufferCount > rule.maxBuffers)
    {
        return E_INVALIDARG;
    }
    if (desc.sampleDesc.count > 1 && !rule.allowsMultisample)
    {
        return E_INVALIDARG;
    }
    if (desc.outputWindow === 0)
    {
        return E_INVALIDARG;
    }
    return S_OK;
}

/**
 * @param {number} swapEffect
 * @param {number} bufferCount
 * @returns {number} the largest index `GetBuffer` answers for
 */
export function highestAccessibleBuffer(swapEffect, bufferCount){
    const rule = SWAP_EFFECT_RULES[swapEffect];
    return rule && rule.sequentialAccess ? bufferCount - 1 : 0;
}

/**
 * What a back buffer reports its usage as, which is not what was asked for.
 *
 * Buffer zero gains the two bits that say it is the one being drawn into and
 * that its contents do not survive a present. Every buffer past it is readable
 * and nothing more, whatever the swap chain was created with.
 *
 * @param {number} requestedUsage
 * @param {number} index
 * @returns {number}
 */
export function backBufferUsage(requestedUsage, index){
    if (index === 0)
    {
        return requestedUsage | DXGI_USAGE.BACK_BUFFER | DXGI_USAGE.DISCARD_ON_PRESENT;
    }
    return requestedUsage | DXGI_USAGE.BACK_BUFFER | DXGI_USAGE.READ_ONLY;
}

/**
 * The bind flags of the texture behind a back buffer. A swap chain's usage
 * word and a resource's bind flags are two spellings of one idea, and this is
 * the whole of the translation between them.
 *
 * @param {number} usage
 * @returns {number}
 */
export function bindFlagsForUsage(usage){
    let bindFlags = 0;
    if ((usage & DXGI_USAGE.RENDER_TARGET_OUTPUT) !== 0)
    {
        bindFlags |= D3D10_BIND.RENDER_TARGET;
    }
    if ((usage & DXGI_USAGE.SHADER_INPUT) !== 0)
    {
        bindFlags |= D3D10_BIND.SHADER_RESOURCE;
    }
    return bindFlags;
}
