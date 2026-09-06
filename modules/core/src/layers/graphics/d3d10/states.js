/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The four immutable state objects: blend, depth stencil, rasterizer, sampler.
 *
 * This is where Direct3D 10 differs most from everything before it. There are
 * no individually settable render states any more; a program describes a whole
 * stage once, gets an object back, and binds that object as a unit. Three
 * consequences, all of them observable and all of them easy to get wrong:
 *
 * - **A description is normalised, not stored.** Fields the description does
 *   not actually use are replaced by the API's own defaults before the object
 *   exists, so `GetDesc` hands back something that differs from what was
 *   passed. Blend factors with blending disabled read back as one-and-zero-add;
 *   a depth-stencil description with the depth test off reads back with the
 *   *default* write mask and function rather than the ones supplied; a sampler
 *   that is not anisotropic reports a maximum anisotropy of zero, one that is
 *   not a comparison sampler reports a comparison function of never, and one
 *   whose addressing never reaches the border reports a border colour of black.
 *   A layer that stores what it was handed reports all four of those wrongly.
 * - **Two identical descriptions are one object.** Creation returns the same
 *   pointer with an added reference, which is what makes the objects safe to
 *   treat as values. Because the description is normalised first, two
 *   descriptions that differ only in fields normalisation erases are identical
 *   for this purpose -- which is the only sensible reading, and is what the
 *   cache key being the normalised form encodes.
 * - **Creating one takes a reference on the device**, and `GetDevice` takes
 *   another. Binding one takes none at all; that rule lives in `device.js`
 *   because it is the whole pipeline's, not just these objects'.
 */

import {
    D3D10_BLEND, D3D10_BLEND_OP, D3D10_COLOR_WRITE_ENABLE, D3D10_COMPARISON, D3D10_CULL_MODE,
    D3D10_DEFAULTS, D3D10_DEPTH_WRITE_MASK, D3D10_FILL_MODE, D3D10_FILTER,
    D3D10_FILTER_ANISOTROPIC_BIT, D3D10_FILTER_COMPARISON_BIT, D3D10_LIMITS, D3D10_STENCIL_OP,
    D3D10_TEXTURE_ADDRESS, E_INVALIDARG, S_OK,
} from './constants.js';

export const STATE_KIND = Object.freeze({
    BLEND: 'blend',
    DEPTH_STENCIL: 'depthstencil',
    RASTERIZER: 'rasterizer',
    SAMPLER: 'sampler',
});

/** @param {Record<string, number>} table @param {number} value */
function isMember(table, value){
    return Object.values(table).includes(value);
}

/** @param {number} value @param {number} bits */
function bitsOf(value, bits){
    return (value & bits) === bits;
}

/**
 * @param {any} desc
 * @returns {any | null} the description as the object will report it
 */
export function normaliseBlendDesc(desc){
    if (!desc)
    {
        return null;
    }
    const count = D3D10_LIMITS.SIMULTANEOUS_RENDER_TARGETS;
    const blendEnable = [];
    const writeMask = [];
    for (let index = 0; index < count; index++)
    {
        blendEnable.push(!!(desc.BlendEnable ?? [])[index]);
        const mask = (desc.RenderTargetWriteMask ?? [])[index] ?? 0;
        if ((mask & ~D3D10_COLOR_WRITE_ENABLE.ALL) !== 0)
        {
            return null;
        }
        writeMask.push(mask);
    }

    // With blending off on every target the factors are not consulted at all,
    // so they are replaced by the API's own defaults rather than validated --
    // which is why a description of nothing but zeros is accepted here and
    // reads back as one, zero and add.
    const blending = blendEnable.some(enabled=>enabled);
    /** @type {number[]} */
    const factors = blending
        ? [desc.SrcBlend, desc.DestBlend, desc.SrcBlendAlpha, desc.DestBlendAlpha]
        : [D3D10_BLEND.ONE, D3D10_BLEND.ZERO, D3D10_BLEND.ONE, D3D10_BLEND.ZERO];
    /** @type {number[]} */
    const operations = blending
        ? [desc.BlendOp, desc.BlendOpAlpha]
        : [D3D10_BLEND_OP.ADD, D3D10_BLEND_OP.ADD];

    if (factors.some(factor=>!isMember(D3D10_BLEND, factor))
        || operations.some(operation=>!isMember(D3D10_BLEND_OP, operation)))
    {
        return null;
    }

    return Object.freeze({
        AlphaToCoverageEnable: !!desc.AlphaToCoverageEnable,
        BlendEnable: Object.freeze(blendEnable),
        SrcBlend: factors[0],
        DestBlend: factors[1],
        BlendOp: operations[0],
        SrcBlendAlpha: factors[2],
        DestBlendAlpha: factors[3],
        BlendOpAlpha: operations[1],
        RenderTargetWriteMask: Object.freeze(writeMask),
    });
}

/** The face description a disabled stencil test reports, whatever was asked. */
const DEFAULT_STENCIL_FACE = Object.freeze({
    StencilFailOp: D3D10_STENCIL_OP.KEEP,
    StencilDepthFailOp: D3D10_STENCIL_OP.KEEP,
    StencilPassOp: D3D10_STENCIL_OP.KEEP,
    StencilFunc: D3D10_COMPARISON.ALWAYS,
});

/**
 * @param {any} face
 * @returns {any | null}
 */
function normaliseStencilFace(face){
    if (!face)
    {
        return null;
    }
    for (const name of ['StencilFailOp', 'StencilDepthFailOp', 'StencilPassOp'])
    {
        if (!isMember(D3D10_STENCIL_OP, face[name]))
        {
            return null;
        }
    }
    if (!isMember(D3D10_COMPARISON, face.StencilFunc))
    {
        return null;
    }
    return Object.freeze({
        StencilFailOp: face.StencilFailOp,
        StencilDepthFailOp: face.StencilDepthFailOp,
        StencilPassOp: face.StencilPassOp,
        StencilFunc: face.StencilFunc,
    });
}

/**
 * @param {any} desc
 * @returns {any | null}
 */
export function normaliseDepthStencilDesc(desc){
    if (!desc)
    {
        return null;
    }
    const depthEnable = !!desc.DepthEnable;
    const stencilEnable = !!desc.StencilEnable;

    const depth = depthEnable
        ? { DepthWriteMask: desc.DepthWriteMask, DepthFunc: desc.DepthFunc }
        : { DepthWriteMask: D3D10_DEPTH_WRITE_MASK.ALL, DepthFunc: D3D10_COMPARISON.LESS };
    if (!isMember(D3D10_DEPTH_WRITE_MASK, depth.DepthWriteMask)
        || !isMember(D3D10_COMPARISON, depth.DepthFunc))
    {
        return null;
    }

    if (!stencilEnable)
    {
        return Object.freeze({
            DepthEnable: depthEnable,
            ...depth,
            StencilEnable: false,
            StencilReadMask: D3D10_DEFAULTS.STENCIL_READ_MASK,
            StencilWriteMask: D3D10_DEFAULTS.STENCIL_WRITE_MASK,
            FrontFace: DEFAULT_STENCIL_FACE,
            BackFace: DEFAULT_STENCIL_FACE,
        });
    }

    const front = normaliseStencilFace(desc.FrontFace);
    const back = normaliseStencilFace(desc.BackFace);
    if (!front || !back)
    {
        return null;
    }
    // The masks are single bytes in the structure the guest wrote; anything
    // wider means the caller filled a DWORD it thought was one.
    if ((desc.StencilReadMask & ~0xff) !== 0 || (desc.StencilWriteMask & ~0xff) !== 0)
    {
        return null;
    }
    return Object.freeze({
        DepthEnable: depthEnable,
        ...depth,
        StencilEnable: true,
        StencilReadMask: desc.StencilReadMask,
        StencilWriteMask: desc.StencilWriteMask,
        FrontFace: front,
        BackFace: back,
    });
}

/**
 * @param {any} desc
 * @returns {any | null}
 */
export function normaliseRasterizerDesc(desc){
    if (!desc)
    {
        return null;
    }
    if (!isMember(D3D10_FILL_MODE, desc.FillMode) || !isMember(D3D10_CULL_MODE, desc.CullMode))
    {
        return null;
    }
    return Object.freeze({
        FillMode: desc.FillMode,
        CullMode: desc.CullMode,
        FrontCounterClockwise: !!desc.FrontCounterClockwise,
        DepthBias: desc.DepthBias | 0,
        DepthBiasClamp: desc.DepthBiasClamp ?? 0,
        SlopeScaledDepthBias: desc.SlopeScaledDepthBias ?? 0,
        DepthClipEnable: !!desc.DepthClipEnable,
        ScissorEnable: !!desc.ScissorEnable,
        MultisampleEnable: !!desc.MultisampleEnable,
        AntialiasedLineEnable: !!desc.AntialiasedLineEnable,
    });
}

/**
 * @param {any} desc
 * @returns {any | null}
 */
export function normaliseSamplerDesc(desc){
    if (!desc || !isMember(D3D10_FILTER, desc.Filter))
    {
        return null;
    }
    const addresses = [desc.AddressU, desc.AddressV, desc.AddressW];
    if (addresses.some(mode=>!isMember(D3D10_TEXTURE_ADDRESS, mode)))
    {
        return null;
    }

    const anisotropic = bitsOf(desc.Filter, D3D10_FILTER_ANISOTROPIC_BIT);
    const comparison = bitsOf(desc.Filter, D3D10_FILTER_COMPARISON_BIT);
    const bordered = addresses.includes(D3D10_TEXTURE_ADDRESS.BORDER);
    if (comparison && !isMember(D3D10_COMPARISON, desc.ComparisonFunc))
    {
        return null;
    }
    const borderColor = bordered
        ? [0, 1, 2, 3].map(index=>(desc.BorderColor ?? [])[index] ?? 0)
        : [0, 0, 0, 0];

    return Object.freeze({
        Filter: desc.Filter,
        AddressU: desc.AddressU,
        AddressV: desc.AddressV,
        AddressW: desc.AddressW,
        MipLODBias: desc.MipLODBias ?? 0,
        MaxAnisotropy: anisotropic ? (desc.MaxAnisotropy ?? 0) : 0,
        ComparisonFunc: comparison ? desc.ComparisonFunc : D3D10_COMPARISON.NEVER,
        BorderColor: Object.freeze(borderColor),
        MinLOD: desc.MinLOD ?? 0,
        MaxLOD: desc.MaxLOD ?? 0,
    });
}

/** @type {Readonly<Record<string, (desc: any) => any | null>>} */
const NORMALISERS = Object.freeze({
    [STATE_KIND.BLEND]: normaliseBlendDesc,
    [STATE_KIND.DEPTH_STENCIL]: normaliseDepthStencilDesc,
    [STATE_KIND.RASTERIZER]: normaliseRasterizerDesc,
    [STATE_KIND.SAMPLER]: normaliseSamplerDesc,
});

/**
 * @param {string} kind
 * @param {any} normalised
 * @returns {string}
 */
function cacheKey(kind, normalised){
    return `${kind}:${JSON.stringify(normalised)}`;
}

/**
 * @typedef {Object} StateStoreOptions
 * @property {() => void} retainDevice   Called when a state object first exists.
 * @property {() => void} releaseDevice  Called when its last reference goes.
 * @property {() => any} device          The object `GetDevice` answers with.
 */

/**
 * The device's store of state objects: one per distinct normalised
 * description, for as long as anybody holds a reference to it.
 *
 * @param {StateStoreOptions} options
 */
export function createStateStore(options){
    /** @type {Map<string, any>} */
    const live = new Map();

    /**
     * @param {string} kind
     * @param {any} desc
     * @param {{ state?: any }} out
     * @returns {number} S_OK or E_INVALIDARG
     */
    const create = (kind, desc, out)=>{
        const normalised = NORMALISERS[kind](desc);
        if (!normalised)
        {
            return E_INVALIDARG;
        }
        const key = cacheKey(kind, normalised);
        const existing = live.get(key);
        if (existing)
        {
            existing.addRef();
            out.state = existing;
            return S_OK;
        }

        let count = 1;
        options.retainDevice();
        const state = {
            kind,
            get refCount(){
                return count;
            },
            addRef(){
                count++;
                return count;
            },
            release(){
                if (count === 0)
                {
                    return 0;
                }
                count--;
                if (count === 0)
                {
                    live.delete(key);
                    options.releaseDevice();
                }
                return count;
            },

            /** @param {{ desc?: any }} target */
            GetDesc(target){
                target.desc = normalised;
                return S_OK;
            },

            /** @param {{ device?: any }} target */
            GetDevice(target){
                options.retainDevice();
                target.device = options.device();
                return S_OK;
            },
        };
        live.set(key, state);
        out.state = state;
        return S_OK;
    };

    return {
        create,
        /** @returns {number} how many distinct state objects are alive */
        size(){
            return live.size;
        },
    };
}
