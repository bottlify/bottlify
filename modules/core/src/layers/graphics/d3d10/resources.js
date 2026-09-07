/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Resources and the views onto them.
 *
 * The separation is the point of the API. A resource is created once from an
 * immutable description and never changes shape; what a draw actually binds is
 * a *view*, which names a format, a dimensionality and a slice of the resource.
 * Two consequences the older APIs have no equivalent of:
 *
 * - **A view does not own the resource it looks at.** Creating one takes a
 *   reference on the *device* and none at all on the resource, so a program can
 *   release the texture and keep the view; the storage stays alive because the
 *   view holds it internally, not because the count says so. A layer that
 *   AddRefs the resource here reports every resource's count one too high, and
 *   every leak check built on those counts then passes when it should not.
 * - **A view over a typeless resource is where the type is decided**, and a
 *   view that names no format cannot decide one. That is why a null view
 *   description -- which means "the obvious view of the whole thing" -- is a
 *   failure on a typeless resource, and always a failure on a buffer, which has
 *   no obvious view at all.
 *
 * `MipLevels` of zero at creation means the full chain, and the description
 * reads back with the resolved number rather than the zero that was asked for.
 */

import { attachCom } from './com.js';
import {
    ALL_REMAINING, D3D10_BIND, D3D10_DSV_DIMENSION, D3D10_RESOURCE_DIMENSION, D3D10_RTV_DIMENSION,
    D3D10_SRV_DIMENSION, E_INVALIDARG, FORMAT_INFO, FORMAT_KIND, IID, S_OK,
} from './constants.js';
import { fullMipChainLength, levelExtent, resolveViewFormat } from './validity.js';

/**
 * Which view dimension names suit which resource shape.
 *
 * @type {Readonly<Record<number, { single: string, array: string }>>}
 */
const VIEW_SHAPE = Object.freeze({
    [D3D10_RESOURCE_DIMENSION.TEXTURE1D]: Object.freeze({
        single: 'TEXTURE1D', array: 'TEXTURE1DARRAY',
    }),
    [D3D10_RESOURCE_DIMENSION.TEXTURE2D]: Object.freeze({
        single: 'TEXTURE2D', array: 'TEXTURE2DARRAY',
    }),
    [D3D10_RESOURCE_DIMENSION.TEXTURE3D]: Object.freeze({
        single: 'TEXTURE3D', array: 'TEXTURE3D',
    }),
});

/**
 * @typedef {Object} ResourceOptions
 * @property {number} dimension          A D3D10_RESOURCE_DIMENSION.
 * @property {any} desc                  Already validated and resolved.
 * @property {readonly string[]} interfaces
 * @property {() => void} retainDevice
 * @property {() => void} releaseDevice
 * @property {() => any} device
 * @property {boolean} [implicit]        A swap chain's back buffer is not the caller's.
 * @property {() => void} [onFirstRef]
 * @property {() => void} [onLastRef]
 */

/**
 * @param {ResourceOptions} options
 */
export function createResource(options){
    return attachCom({
        dimension: options.dimension,
        desc: options.desc,

        /** @param {{ desc?: any }} out */
        GetDesc(out){
            if (!out)
            {
                return E_INVALIDARG;
            }
            out.desc = options.desc;
            return S_OK;
        },

        /** @param {{ type?: number }} out */
        GetType(out){
            out.type = options.dimension;
            return S_OK;
        },

        /** @param {{ device?: any }} out */
        GetDevice(out){
            options.retainDevice();
            out.device = options.device();
            return S_OK;
        },
    }, {
        interfaces: options.interfaces,
        implicit: options.implicit,
        onFirstRef: ()=>{
            options.retainDevice();
            options.onFirstRef?.();
        },
        onLastRef: ()=>{
            options.onLastRef?.();
            options.releaseDevice();
        },
    });
}

/**
 * How many slices a view of this resource can reach at a given mip slice.
 *
 * A 3D texture is the awkward one: its "slices" are the depth of the *mip
 * level being viewed*, which halves with every level, where an array's slice
 * count is the same at every level.
 *
 * @param {any} resource
 * @param {number} mipSlice
 * @returns {number}
 */
function availableSlices(resource, mipSlice){
    if (resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D)
    {
        return levelExtent(resource.desc.Depth, mipSlice);
    }
    return resource.desc.ArraySize;
}

/**
 * @param {any} resource
 * @param {Record<string, number>} dimensions  The view kind's dimension enumeration.
 * @returns {string | null} the name of the dimension a default view would use
 */
function defaultDimensionName(resource, dimensions){
    const shape = VIEW_SHAPE[resource.dimension];
    if (!shape)
    {
        return null;
    }
    if (resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D)
    {
        return dimensions[shape.single] === undefined ? null : shape.single;
    }
    const name = resource.desc.ArraySize > 1 ? shape.array : shape.single;
    return dimensions[name] === undefined ? null : name;
}

/**
 * @param {number} dimension  A view dimension value.
 * @param {Record<string, number>} dimensions
 * @returns {string | null}
 */
function nameOfDimension(dimension, dimensions){
    const entry = Object.entries(dimensions).find(([, value])=>value === dimension);
    return entry ? entry[0] : null;
}

/**
 * Whether a view dimension can look at this resource at all. The comparison is
 * on the name rather than the number because the three view enumerations
 * number the same shapes differently -- a depth-stencil view's `TEXTURE2D` is
 * 3 where a render-target view's is 4 -- and a layer that compares numbers
 * across them accepts views it should refuse.
 *
 * @param {any} resource
 * @param {string} name
 * @returns {boolean}
 */
function dimensionSuitsResource(resource, name){
    const shape = VIEW_SHAPE[resource.dimension];
    if (!shape)
    {
        return false;
    }
    if (resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D)
    {
        return name === 'TEXTURE3D';
    }
    // Every name for a shape starts with that shape: TEXTURE2D, TEXTURE2DARRAY,
    // TEXTURE2DMS and TEXTURE2DMSARRAY all view a 2D texture, while TEXTURE1D
    // and TEXTURE3D never do.
    return name.startsWith(shape.single);
}

/**
 * @typedef {Object} ViewRequest
 * @property {any} resource
 * @property {any} desc                 Null asks for the default view.
 * @property {Record<string, number>} dimensions
 * @property {number} bindFlag          The bind flag the resource must carry.
 * @property {boolean} [mipRange]       A shader resource view names a range of levels.
 */

/**
 * The whole of view validation, in one place because all three view kinds run
 * exactly these checks and differ only in their dimension enumeration.
 *
 * @param {ViewRequest} request
 * @returns {any | null} the resolved description, or null if the view is refused
 */
export function resolveViewDesc(request){
    const { resource, desc, dimensions } = request;
    if ((resource.desc.BindFlags & request.bindFlag) === 0)
    {
        return null;
    }
    if (resource.dimension === D3D10_RESOURCE_DIMENSION.BUFFER)
    {
        // A buffer has no shape to infer a view from, so a null description is
        // not "the obvious one" but a request that cannot be answered.
        return desc ? resolveBufferViewDesc(resource, desc, dimensions) : null;
    }

    const name = desc
        ? nameOfDimension(desc.ViewDimension, dimensions)
        : defaultDimensionName(resource, dimensions);
    if (!name || name === 'UNKNOWN' || !dimensionSuitsResource(resource, name))
    {
        return null;
    }

    const format = resolveViewFormat(resource.desc.Format, desc ? desc.Format : 0);
    if (format === null)
    {
        return null;
    }

    const mipSlice = desc ? (desc.MipSlice ?? desc.MostDetailedMip ?? 0) : 0;
    if (mipSlice >= resource.desc.MipLevels)
    {
        return null;
    }

    const available = availableSlices(resource, mipSlice);
    const firstSlice = desc ? (desc.FirstArraySlice ?? desc.FirstWSlice ?? 0) : 0;
    const requested = desc ? (desc.ArraySize ?? desc.WSize ?? ALL_REMAINING) : ALL_REMAINING;
    const sliceCount = requested === ALL_REMAINING ? available - firstSlice : requested;
    if (firstSlice >= available || sliceCount < 1 || firstSlice + sliceCount > available)
    {
        return null;
    }

    const resolved = {
        Format: format,
        ViewDimension: dimensions[name],
        MipSlice: mipSlice,
        FirstArraySlice: firstSlice,
        ArraySize: sliceCount,
    };
    if (!request.mipRange)
    {
        return resolved;
    }
    const levels = desc && desc.MipLevels !== undefined && desc.MipLevels !== ALL_REMAINING
        ? desc.MipLevels
        : resource.desc.MipLevels - mipSlice;
    if (levels < 1 || mipSlice + levels > resource.desc.MipLevels)
    {
        return null;
    }
    return { ...resolved, MostDetailedMip: mipSlice, MipLevels: levels };
}

/**
 * @param {any} resource
 * @param {any} desc
 * @param {Record<string, number>} dimensions
 * @returns {any | null}
 */
function resolveBufferViewDesc(resource, desc, dimensions){
    if (desc.ViewDimension !== dimensions.BUFFER)
    {
        return null;
    }
    // A buffer is bytes and carries no format of its own, so there is nothing
    // for the view's format to be a cast *of*: it only has to name a real,
    // concrete format. This is the one view whose format stands alone.
    const info = FORMAT_INFO[desc.Format];
    if (!info || info.kind === FORMAT_KIND.TYPELESS || desc.ElementWidth < 1)
    {
        return null;
    }
    const offset = desc.ElementOffset ?? 0;
    if ((offset + desc.ElementWidth) * info.bytesPerPixel > resource.desc.ByteWidth)
    {
        return null;
    }
    return {
        Format: desc.Format,
        ViewDimension: dimensions.BUFFER,
        ElementOffset: offset,
        ElementWidth: desc.ElementWidth,
    };
}

/**
 * @typedef {Object} ViewOptions
 * @property {any} resource
 * @property {any} desc              The already-resolved description.
 * @property {string} iid
 * @property {() => void} retainDevice
 * @property {() => void} releaseDevice
 * @property {() => any} device
 */

/**
 * @param {ViewOptions} options
 */
export function createView(options){
    return attachCom({
        /** @param {{ desc?: any }} out */
        GetDesc(out){
            if (!out)
            {
                return E_INVALIDARG;
            }
            out.desc = options.desc;
            return S_OK;
        },

        /**
         * The one place a view does touch the resource's count: handing the
         * resource back to a caller is a new reference for that caller, which
         * is a different thing from the view holding one of its own.
         *
         * @param {{ resource?: any }} out
         */
        GetResource(out){
            options.resource.addRef();
            out.resource = options.resource;
            return S_OK;
        },

        /** @param {{ device?: any }} out */
        GetDevice(out){
            options.retainDevice();
            out.device = options.device();
            return S_OK;
        },
    }, {
        interfaces: [options.iid],
        onFirstRef: options.retainDevice,
        onLastRef: options.releaseDevice,
    });
}

/** The three view kinds, each with its own dimension enumeration and bind flag. */
export const VIEW_KINDS = Object.freeze({
    RENDER_TARGET: Object.freeze({
        dimensions: D3D10_RTV_DIMENSION,
        bindFlag: D3D10_BIND.RENDER_TARGET,
        mipRange: false,
        iid: IID.ID3D10RenderTargetView,
    }),
    DEPTH_STENCIL: Object.freeze({
        dimensions: D3D10_DSV_DIMENSION,
        bindFlag: D3D10_BIND.DEPTH_STENCIL,
        mipRange: false,
        iid: IID.ID3D10DepthStencilView,
    }),
    SHADER_RESOURCE: Object.freeze({
        dimensions: D3D10_SRV_DIMENSION,
        bindFlag: D3D10_BIND.SHADER_RESOURCE,
        mipRange: true,
        iid: IID.ID3D10ShaderResourceView,
    }),
});

/**
 * The interface list a texture answers to. A 1D or 2D texture is an
 * `IDXGISurface` only when it is a single subresource -- one mip level and one
 * array slice -- because a surface is one two-dimensional image and a mip chain
 * is not. A program uses exactly that to find out whether it can hand the
 * texture to something that speaks DXGI rather than Direct3D.
 *
 * @param {any} desc
 * @param {string} textureIid
 * @param {number} dimension
 * @returns {string[]}
 */
export function textureInterfaces(desc, textureIid, dimension){
    const base = [IID.IDXGIObject, IID.IDXGIDeviceSubObject, IID.IDXGIResource, textureIid];
    const single = dimension !== D3D10_RESOURCE_DIMENSION.TEXTURE3D
        && desc.MipLevels === 1 && (desc.ArraySize ?? 1) === 1;
    return single ? [...base, IID.IDXGISurface] : base;
}

/**
 * @param {any} desc
 * @param {number} dimension
 * @returns {number} the mip level count the resource actually has
 */
export function resolveMipLevels(desc, dimension){
    if (desc.MipLevels !== 0)
    {
        return desc.MipLevels;
    }
    const height = dimension === D3D10_RESOURCE_DIMENSION.TEXTURE1D ? 1 : (desc.Height ?? 1);
    const depth = dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D ? (desc.Depth ?? 1) : 1;
    return fullMipChainLength(desc.Width, height, depth);
}
