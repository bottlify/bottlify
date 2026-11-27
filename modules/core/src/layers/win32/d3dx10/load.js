/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The texture D3DX 10 and 11 make of an image and a D3DX10_IMAGE_LOAD_INFO:
 * its description and every subresource's bytes, worked out before the
 * device is asked.
 *
 * As Wine's d3dx10 and d3dx11 tests say Windows does it: the size, depth,
 * format and level count asked (DEFAULT, FROM_FILE and 0 meaning the file's,
 * or every level the size has), a block-compressed format's size rounded up
 * to whole blocks; a depth above 1 refused for a file that is not a volume;
 * FirstMipLevel naming the file's level each texture's first is loaded from
 * (one past the file's last meaning 0), the texture's own size being the
 * file's; the filter checked and used only when the texture differs from the
 * file in size, level count or format (a file whose texels were converted
 * always does), LINEAR by default; the levels the file lacks made from the
 * last loaded one by the mip filter, which is checked only then.
 */

import { DIMENSION, averagesBytes, dxgiLayout, halveTexels } from './dds10.js';
import {
    FILTER, convertGamma, decodeLevel, encodeLevel, hasCodec, isBlockFormat, isSrgb, resize,
    validFilter,
} from './texels.js';

export const D3DX10_DEFAULT = 0xffffffff;
export const D3DX10_FROM_FILE = 0xfffffffd;

const E_FAIL = 0x80004005 | 0;
const D3DERR_INVALIDCALL = 0x8876086c | 0;
/** D3D10_BIND_SHADER_RESOURCE and D3D10_RESOURCE_MISC_TEXTURECUBE. */
const BIND_SHADER_RESOURCE = 0x8;
const MISC_TEXTURECUBE = 0x4;

/**
 * What a load is asked for, D3DX10_IMAGE_LOAD_INFO's fields; each
 * D3DX10_DEFAULT when the program passes none.
 *
 * @typedef {{ width: number, height: number, depth: number, firstMip: number, mips: number,
 *     usage: number, bind: number, cpu: number, misc: number, format: number, filter: number,
 *     mipFilter: number }} LoadInfo
 */

/** Every field DEFAULT. @type {LoadInfo} */
export const DEFAULT_LOAD = Object.freeze({ width: D3DX10_DEFAULT, height: D3DX10_DEFAULT,
    depth: D3DX10_DEFAULT, firstMip: D3DX10_DEFAULT, mips: D3DX10_DEFAULT,
    usage: D3DX10_DEFAULT, bind: D3DX10_DEFAULT, cpu: D3DX10_DEFAULT, misc: D3DX10_DEFAULT,
    format: D3DX10_DEFAULT, filter: D3DX10_DEFAULT, mipFilter: D3DX10_DEFAULT });

/**
 * @typedef {Object} Plan
 * @property {number} dimension  D3D10_RESOURCE_DIMENSION: 2, 3 or 4
 * @property {number} width
 * @property {number} height
 * @property {number} depth
 * @property {number} mips
 * @property {number} arraySize
 * @property {number} format
 * @property {number} usage
 * @property {number} bind
 * @property {number} cpu
 * @property {number} misc
 * @property {{ data: Uint8Array, pitch: number, slice: number }[]} subresources
 *     each array slice's levels, largest first
 */

/** @param {number} asked */
const unasked = asked=>asked === 0 || asked === D3DX10_DEFAULT || asked === D3DX10_FROM_FILE;

/**
 * A slice's level of a file as one run of bytes (a volume's slices one after
 * another).
 *
 * @param {import('./dds10.js').DxgiImage} image @param {number} layer @param {number} level
 */
const fileLevel = (image, layer, level)=>{
    if (image.dimension === DIMENSION.TEXTURE3D)
    {
        const slices = /** @type {import('./dds10.js').DxgiLevel[][]} */ (image.volume)[level];
        const bytes = new Uint8Array(slices.reduce((sum, slice)=>sum + slice.data.length, 0));
        let at = 0;
        for (const slice of slices)
        {
            bytes.set(slice.data, at);
            at += slice.data.length;
        }
        return { width: slices[0].width, height: slices[0].height, depth: slices.length,
            data: bytes };
    }
    const own = (image.faces ?? [image.levels])[layer][level];
    return { width: own.width, height: own.height, depth: 1, data: own.data };
};

/**
 * The texture to make of an image, or the HRESULT the program is answered.
 *
 * @param {import('./dds10.js').DxgiImage} image
 * @param {LoadInfo} info
 * @param {(detail: string) => void} say  a departure, said
 * @returns {Plan | { hr: number }}
 */
export function planTexture(image, info, say){
    const { dimension } = image;
    if (dimension !== DIMENSION.TEXTURE1D && dimension !== DIMENSION.TEXTURE2D
        && dimension !== DIMENSION.TEXTURE3D)
    {
        return { hr: E_FAIL };
    }
    const volume = dimension === DIMENSION.TEXTURE3D;
    const layers = volume ? 1 : image.arraySize;
    let first = info.firstMip === D3DX10_DEFAULT || info.firstMip >= image.mipLevels ? 0
        : info.firstMip;
    const format = info.format === D3DX10_DEFAULT || info.format === D3DX10_FROM_FILE
        ? image.dxgi : info.format;
    if (!dxgiLayout(format, 1, 1))
    {
        say(`format ${format} asked, which this loader does not lay out`);
        return { hr: E_FAIL };
    }
    const block = isBlockFormat(format) ? 4 : 1;
    /** @param {number} n */
    const blocks = n=>Math.ceil(n / block) * block;
    const width = blocks(unasked(info.width) ? image.width : info.width);
    const height = dimension === DIMENSION.TEXTURE1D ? 1
        : blocks(unasked(info.height) ? image.height : info.height);
    const depth = unasked(info.depth) ? image.depth ?? 1 : info.depth;
    if (depth > 1 && !volume)
    {
        return { hr: E_FAIL };
    }
    const most = Math.floor(Math.log2(Math.max(width, height, depth))) + 1;
    let mips = Math.min(most, info.mips === D3DX10_FROM_FILE ? image.mipLevels
        : unasked(info.mips) ? most : info.mips);
    const differs = width !== image.width || height !== image.height
        || depth !== (image.depth ?? 1) || mips !== image.mipLevels || format !== image.dxgi
        || Boolean(image.converted);
    const filter = !differs ? FILTER.NONE : unasked(info.filter) ? FILTER.LINEAR : info.filter;
    if (!validFilter(filter))
    {
        return { hr: D3DERR_INVALIDCALL };
    }
    // A format with no codec here is not filtered: a size the file holds as one of
    // its levels is taken from that level (decision A234).
    if ((width !== Math.max(1, image.width >> first)
        || height !== Math.max(1, image.height >> first)) && format === image.dxgi
        && !hasCodec(format))
    {
        const held = image.levels.findIndex((level, index)=>index >= first
            && level.width === width && level.height === height);
        first = held < 0 ? first : held;
    }
    const loaded = Math.min(image.mipLevels - first, mips);
    if (loaded < mips)
    {
        const mipFilter = unasked(info.mipFilter) ? FILTER.LINEAR : info.mipFilter;
        if (!validFilter(mipFilter))
        {
            return { hr: D3DERR_INVALIDCALL };
        }
        if (!hasCodec(format))
        {
            say(`${mips - loaded} levels of format ${format} left out: this loader makes no`
                + ' levels of it');
            mips = loaded;
        }
    }
    /** @param {number} n @param {number} level */
    const at = (n, level)=>Math.max(1, n >> level);
    /** @type {Plan['subresources']} */
    const subresources = [];
    for (let layer = 0; layer < layers; layer++)
    {
        /** @type {{ width: number, height: number, depth: number, data: Uint8Array }[]} */
        const chain = [];
        for (let level = 0; level < mips; level++)
        {
            const w = at(width, level);
            const h = at(height, level);
            const d = at(depth, level);
            if (level < loaded)
            {
                const source = fileLevel(image, layer, first + level);
                const data = load(source, image.dxgi, w, h, d, format, filter);
                if (!data)
                {
                    say(`a level of format ${image.dxgi} made format ${format} or another size:`
                        + ' this loader has no codec for it');
                    return { hr: E_FAIL };
                }
                chain.push({ width: w, height: h, depth: d, data });
                continue;
            }
            const above = chain[level - 1];
            const mipFilter = unasked(info.mipFilter) ? FILTER.LINEAR : info.mipFilter;
            chain.push({ width: w, height: h, depth: d,
                data: smaller(above, format, w, h, d, mipFilter) });
        }
        for (const level of chain)
        {
            const { rowBytes, rows } = /** @type {{ rowBytes: number, rows: number }} */ (
                dxgiLayout(format, level.width, level.height));
            subresources.push({ data: level.data, pitch: rowBytes, slice: rowBytes * rows });
        }
    }
    return {
        dimension, width, height, depth, mips, arraySize: layers, format,
        usage: info.usage === D3DX10_DEFAULT ? 0 : info.usage,
        bind: info.bind === D3DX10_DEFAULT ? BIND_SHADER_RESOURCE : info.bind,
        cpu: info.cpu === D3DX10_DEFAULT ? 0 : info.cpu,
        misc: (info.misc === D3DX10_DEFAULT ? 0 : info.misc) | (image.cube ? MISC_TEXTURECUBE : 0),
        subresources,
    };
}

/**
 * A file's level made a level of the texture: its bytes as they are where
 * nothing differs, else read, made the size by the filter and written in the
 * format, through linear colour where the filter or a format says sRGB on
 * one side only. Null where a format has no codec here.
 *
 * @param {{ width: number, height: number, depth: number, data: Uint8Array }} source
 * @param {number} from @param {number} toWidth @param {number} toHeight @param {number} toDepth
 * @param {number} format @param {number} filter
 * @returns {Uint8Array | null}
 */
function load(source, from, toWidth, toHeight, toDepth, format, filter){
    const srgbIn = (filter & FILTER.SRGB_IN) !== 0 || isSrgb(from);
    const srgbOut = (filter & FILTER.SRGB_OUT) !== 0 || isSrgb(format);
    const gamma = srgbIn !== srgbOut;
    const sameSize = source.width === toWidth && source.height === toHeight
        && source.depth === toDepth;
    if (sameSize && from === format && !gamma)
    {
        return source.data;
    }
    // A level of blocks whose size is not whole blocks, made the whole blocks the
    // texture has: D3DX reads its texels and fills the rest of each block by
    // wrapping them, then makes the blocks again. With no codec, its blocks are
    // the texture's as they are.
    const padded = from === format && isBlockFormat(format) && source.depth === toDepth
        && Math.ceil(source.width / 4) === Math.ceil(toWidth / 4)
        && Math.ceil(source.height / 4) === Math.ceil(toHeight / 4);
    if (padded && !hasCodec(format))
    {
        return source.data;
    }
    if (padded && !gamma)
    {
        const texels = decodeLevel(from, source.data, source.width, source.height, source.depth);
        const filled = new Float32Array(toWidth * toHeight * toDepth * 4);
        for (let z = 0; z < toDepth; z++)
        {
            for (let y = 0; y < toHeight; y++)
            {
                for (let x = 0; x < toWidth; x++)
                {
                    const from4 = ((z * source.height + y % source.height) * source.width
                        + x % source.width) * 4;
                    filled.set(texels.subarray(from4, from4 + 4),
                        ((z * toHeight + y) * toWidth + x) * 4);
                }
            }
        }
        return encodeLevel(format, filled, toWidth, toHeight, toDepth);
    }
    if (!hasCodec(from) || !hasCodec(format))
    {
        return null;
    }
    let rgba = decodeLevel(from, source.data, source.width, source.height, source.depth);
    if (gamma && srgbIn)
    {
        convertGamma(rgba, true);
    }
    if (!sameSize)
    {
        rgba = resize(rgba, source.width, source.height, source.depth, toWidth, toHeight, toDepth,
            filter);
    }
    if (gamma && srgbOut)
    {
        convertGamma(rgba, false);
    }
    return encodeLevel(format, rgba, toWidth, toHeight, toDepth);
}

/**
 * The next level down made of one, by the mip filter: bytes averaged two by
 * two where a format's bytes are its channels and the size halves (BOX, and
 * LINEAR, which samples between the same texels there), else through its
 * texels.
 *
 * @param {{ width: number, height: number, depth: number, data: Uint8Array }} above
 * @param {number} format @param {number} width @param {number} height @param {number} depth
 * @param {number} filter
 * @returns {Uint8Array}
 */
function smaller(above, format, width, height, depth, filter){
    const kind = filter & 7;
    const halves = depth === 1 && above.depth === 1
        && width === Math.max(1, above.width >> 1) && height === Math.max(1, above.height >> 1)
        && (above.width === 1 || above.width % 2 === 0)
        && (above.height === 1 || above.height % 2 === 0);
    if (halves && averagesBytes(format) && (kind === FILTER.BOX || kind === FILTER.LINEAR)
        && !(filter & (FILTER.SRGB_IN | FILTER.SRGB_OUT)))
    {
        const { rowBytes } = /** @type {{ rowBytes: number, rows: number }} */ (
            dxgiLayout(format, 1, 1));
        return halveTexels(above.data, above.width, above.height, rowBytes, true).data;
    }
    return /** @type {Uint8Array} */ (load(above, format, width, height, depth, format,
        filter));
}
