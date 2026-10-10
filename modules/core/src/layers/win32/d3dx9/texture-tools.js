/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { DEVICE, TEXTURE, createDeviceCalls } from './device.js';
import { D3DX_DEFAULT } from './texture.js';
import { FMT, encodeTexels, isCompressed, isSupported, layoutOf } from './pixels.js';
import { D3DXFloat32To16Array } from './inguest-vector.js';

/**
 * D3DX's textures made empty: D3DXCheckTextureRequirements's corrections of a
 * size, level count and format, and D3DXCreateTexture, which makes what they
 * come to with the device's own CreateTexture.
 *
 * The corrections are the documented ones, against the device's capabilities:
 * a width or height of 0 is 1 and D3DX_DEFAULT is the other one's or 256; the
 * sizes go up to powers of two where the device needs them (D3DPTEXTURECAPS_POW2,
 * unless NONPOW2CONDITIONAL lets a single level be any size), to a square
 * where it needs that, down to its largest, and up to whole blocks for a
 * compressed format; the level count is the full chain for 0 or D3DX_DEFAULT,
 * else at most that, and one for a texture whose levels the device makes
 * (D3DUSAGE_AUTOGENMIPMAP). A format of D3DFMT_UNKNOWN or D3DX_DEFAULT is
 * A8R8G8B8; any other is kept as asked -- the device's own CreateTexture
 * says whether it has it, where D3DX would look for the nearest one it has.
 *
 * D3DXFillTexture asks the program's own function for every texel of every
 * level, at the texel's centre, and writes what it answers in the level's
 * format: the formats the loaders write (pixels.js), through eight bits a
 * channel, and the floating-point ones, from the floats as they are.
 */

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const E_OUTOFMEMORY = 0x8007000e;

const D3DPTEXTURECAPS_POW2 = 0x2;
const D3DPTEXTURECAPS_SQUAREONLY = 0x20;
const D3DPTEXTURECAPS_NONPOW2CONDITIONAL = 0x100;
const D3DUSAGE_AUTOGENMIPMAP = 0x400;
const D3DSURFACE_DESC_BYTES = 32;

/** The floating-point formats a fill writes: bytes a channel, and how many channels. */
const FLOATS = new Map([[111, [2, 1]], [112, [2, 2]], [113, [2, 4]], [114, [4, 1]],
    [115, [4, 2]], [116, [4, 4]]]);

/** A float as the library's own conversion makes a half of it. @param {number} value */
const halfOf = value=>{
    const bits = new Uint32Array(Float32Array.of(value).buffer)[0];
    let half = 0;
    D3DXFloat32To16Array(/** @type {any} */ ({ u32: ()=>bits,
        setU16: (/** @type {number} */ _, /** @type {number} */ v)=>{
            half = v;
        } }), 0, 0, 1);
    return half;
};

/**
 * A level's texels in its format, from the RGBA each texel was given, rows
 * packed; null for a format this does not write.
 *
 * @param {number} format @param {Float32Array} rgba @param {number} width @param {number} height
 * @returns {Uint8Array | null}
 */
export function packFilled(format, rgba, width, height){
    const floats = FLOATS.get(format);
    if (floats)
    {
        const [bytes, channels] = floats;
        const out = new Uint8Array(width * height * bytes * channels);
        const view = new DataView(out.buffer);
        for (let i = 0; i < width * height; i++)
        {
            for (let c = 0; c < channels; c++)
            {
                const at = (i * channels + c) * bytes;
                if (bytes === 2)
                {
                    view.setUint16(at, halfOf(rgba[i * 4 + c]), true);
                }
                else
                {
                    view.setFloat32(at, rgba[i * 4 + c], true);
                }
            }
        }
        return out;
    }
    if (!isSupported(format))
    {
        return null;
    }
    const bgra = new Uint8Array(width * height * 4);
    /** @param {number} v */
    const unorm = v=>Math.round(Math.min(1, Math.max(0, v)) * 255);
    for (let i = 0; i < width * height; i++)
    {
        bgra.set([unorm(rgba[i * 4 + 2]), unorm(rgba[i * 4 + 1]), unorm(rgba[i * 4]),
            unorm(rgba[i * 4 + 3])], i * 4);
    }
    return encodeTexels(format, bgra, width, height);
}
/** D3DCAPS9's size, and where TextureCaps and MaxTextureWidth and Height are in it. */
const CAPS_BYTES = 304;
const CAPS_TEXTURE = 60;
const CAPS_MAX_WIDTH = 88;
const CAPS_MAX_HEIGHT = 92;

/**
 * @typedef {Object} TextureToolsHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {() => any} [currentThread]
 */

/**
 * @typedef {Object} Requirements
 * @property {number} width
 * @property {number} height
 * @property {number} levels
 * @property {number} usage
 * @property {number} format
 */

/** @param {number} value */
const nextPowerOfTwo = value=>2 ** Math.ceil(Math.log2(Math.max(1, value)));

/**
 * The corrections, given what the device can do.
 *
 * @param {{ width: number, height: number, levels: number, usage: number, format: number }}
 *     asked  D3DX_DEFAULT where a pointer was null.
 * @param {{ textureCaps: number, maxWidth: number, maxHeight: number }} caps
 * @returns {Requirements}
 */
export function textureRequirements(asked, caps){
    let width = asked.width === 0 ? 1 : asked.width;
    let height = asked.height === 0 ? 1 : asked.height;
    if (width === D3DX_DEFAULT)
    {
        width = height === D3DX_DEFAULT ? 256 : height;
    }
    if (height === D3DX_DEFAULT)
    {
        height = width;
    }
    const usage = asked.usage === D3DX_DEFAULT ? 0 : asked.usage;
    const format = asked.format === FMT.UNKNOWN || asked.format === D3DX_DEFAULT
        ? FMT.A8R8G8B8 : asked.format;
    const single = asked.levels === 1 || (usage & D3DUSAGE_AUTOGENMIPMAP) !== 0;
    if ((caps.textureCaps & D3DPTEXTURECAPS_POW2)
        && (!(caps.textureCaps & D3DPTEXTURECAPS_NONPOW2CONDITIONAL) || !single))
    {
        width = nextPowerOfTwo(width);
        height = nextPowerOfTwo(height);
    }
    if (caps.textureCaps & D3DPTEXTURECAPS_SQUAREONLY)
    {
        const side = Math.max(width, height);
        width = side;
        height = side;
    }
    width = Math.min(width, caps.maxWidth || width);
    height = Math.min(height, caps.maxHeight || height);
    if (isCompressed(format))
    {
        width = (width + 3) & ~3;
        height = (height + 3) & ~3;
    }
    const chain = Math.floor(Math.log2(Math.max(width, height))) + 1;
    const levels = usage & D3DUSAGE_AUTOGENMIPMAP ? 1
        : asked.levels === 0 || asked.levels === D3DX_DEFAULT ? chain
            : Math.min(asked.levels, chain);
    return { width, height, levels, usage, format };
}

/**
 * @param {TextureToolsHost} host
 */
export function createTextureTools(host){
    const { u32, putU32s, method } = createDeviceCalls(host);

    /**
     * What a device's capabilities say about textures.
     *
     * @param {number} device @param {any} thread
     * @returns {Promise<{ textureCaps: number, maxWidth: number, maxHeight: number } | number>}
     */
    const capsOf = async(device, thread)=>{
        const heap = /** @type {NonNullable<TextureToolsHost['heap']>} */ (host.heap);
        const at = heap.allocate(CAPS_BYTES);
        if (at === 0)
        {
            return E_OUTOFMEMORY;
        }
        try
        {
            host.writeMemory(at, new Uint8Array(CAPS_BYTES));
            const answer = await method(thread, device, DEVICE.GetDeviceCaps, [at]);
            if (answer !== D3D_OK)
            {
                return answer;
            }
            return { textureCaps: u32(at + CAPS_TEXTURE), maxWidth: u32(at + CAPS_MAX_WIDTH),
                maxHeight: u32(at + CAPS_MAX_HEIGHT) };
        }
        finally
        {
            heap.free(at);
        }
    };

    /**
     * The corrections for what a device can do, once the handler has returned.
     *
     * @param {number} device @param {Parameters<typeof textureRequirements>[0]} asked
     * @param {any} thread
     * @returns {Promise<Requirements | number>}
     */
    const requirements = async(device, asked, thread)=>{
        await null;
        const caps = await capsOf(device, thread);
        return typeof caps === 'number' ? caps : textureRequirements(asked, caps);
    };

    /** @param {number} at  A UINT in-out pointer: D3DX_DEFAULT when null. */
    const given = at=>((at >>> 0) === 0 ? D3DX_DEFAULT : u32(at));

    /**
     * D3DXFillTexture's work, once its handler has returned.
     *
     * @param {number} texture @param {number} fill @param {number} data @param {any} thread
     * @returns {Promise<number>}
     */
    const fillTexture = async(texture, fill, data, thread)=>{
        await null;
        const heap = /** @type {NonNullable<TextureToolsHost['heap']>} */ (host.heap);
        const callGuest = /** @type {NonNullable<TextureToolsHost['callGuest']>} */ (
            host.callGuest);
        // The level's description, its lock, then the out vector, the texel's
        // centre and the texel's size the function is handed.
        const scratch = heap.allocate(D3DSURFACE_DESC_BYTES + 8 + 32);
        if (scratch === 0)
        {
            return E_OUTOFMEMORY;
        }
        const locked = scratch + D3DSURFACE_DESC_BYTES;
        const out = locked + 8;
        const coord = out + 16;
        const size = coord + 8;
        try
        {
            const levels = await method(thread, texture, TEXTURE.GetLevelCount, []);
            for (let level = 0; level < levels; level++)
            {
                const described = await method(thread, texture, TEXTURE.GetLevelDesc,
                    [level, scratch]);
                if (described !== D3D_OK)
                {
                    return described;
                }
                const format = u32(scratch);
                const width = u32(scratch + 24);
                const height = u32(scratch + 28);
                if (!FLOATS.has(format) && !isSupported(format))
                {
                    host.divergence?.('D3DXFillTexture', `format ${format} is not one a fill `
                        + 'writes: answered D3DERR_INVALIDCALL');
                    return D3DERR_INVALIDCALL;
                }
                const rgba = new Float32Array(width * height * 4);
                host.writeMemory(size, new Uint8Array(Float32Array.of(1 / width, 1 / height)
                    .buffer));
                for (let y = 0; y < height; y++)
                {
                    for (let x = 0; x < width; x++)
                    {
                        host.writeMemory(out, new Uint8Array(16));
                        host.writeMemory(coord, new Uint8Array(Float32Array.of(
                            (x + 0.5) / width, (y + 0.5) / height).buffer));
                        await callGuest({ entry: fill >>> 0, args: [out, coord, size,
                            data >>> 0], ...(thread === undefined ? {} : { thread }) });
                        rgba.set(new Float32Array(host.readMemory(out, 16).slice().buffer),
                            (y * width + x) * 4);
                    }
                }
                const packed = /** @type {Uint8Array} */ (packFilled(format, rgba, width,
                    height));
                const answer = await method(thread, texture, TEXTURE.LockRect,
                    [level, locked, 0, 0]);
                if (answer !== D3D_OK)
                {
                    return answer;
                }
                const pitch = u32(locked);
                const bits = u32(locked + 4);
                const rows = FLOATS.has(format) ? height : layoutOf(format, width, height).rows;
                const rowBytes = packed.length / rows;
                for (let row = 0; row < rows; row++)
                {
                    host.writeMemory(bits + row * pitch, packed.subarray(row * rowBytes,
                        (row + 1) * rowBytes));
                }
                await method(thread, texture, TEXTURE.UnlockRect, [level]);
            }
            return D3D_OK;
        }
        finally
        {
            heap.free(scratch);
        }
    };

    return {
        /**
         * HRESULT D3DXCheckTextureRequirements(LPDIRECT3DDEVICE9 pDevice, UINT *pWidth,
         *     UINT *pHeight, UINT *pNumMipLevels, DWORD Usage, D3DFORMAT *pFormat,
         *     D3DPOOL Pool)
         */
        D3DXCheckTextureRequirements: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([device, widthAt, heightAt, levelsAt, usage, formatAt])=>{
                if ((device >>> 0) === 0 || !host.callGuest || !host.heap)
                {
                    return D3DERR_INVALIDCALL;
                }
                const asked = { width: given(widthAt), height: given(heightAt),
                    levels: given(levelsAt), usage: usage >>> 0, format: given(formatAt) };
                return requirements(device >>> 0, asked, host.currentThread?.()).then(found=>{
                    if (typeof found === 'number')
                    {
                        return found;
                    }
                    for (const [at, value] of /** @type {[number, number][]} */ ([
                        [widthAt, found.width], [heightAt, found.height],
                        [levelsAt, found.levels], [formatAt, found.format]]))
                    {
                        if ((at >>> 0) !== 0)
                        {
                            putU32s(at, [value]);
                        }
                    }
                    return D3D_OK;
                });
            },
        },

        /**
         * HRESULT D3DXCreateTexture(LPDIRECT3DDEVICE9 pDevice, UINT Width, UINT Height,
         *     UINT MipLevels, DWORD Usage, D3DFORMAT Format, D3DPOOL Pool,
         *     LPDIRECT3DTEXTURE9 *ppTexture)
         *
         * The requirements' answer made with the device's CreateTexture, whose
         * answer this is.
         */
        D3DXCreateTexture: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([device, width, height, levels, usage, format, pool, out])=>{
                if ((out >>> 0) !== 0)
                {
                    putU32s(out, [0]);
                }
                if ((device >>> 0) === 0 || (out >>> 0) === 0 || !host.callGuest || !host.heap)
                {
                    return D3DERR_INVALIDCALL;
                }
                const thread = host.currentThread?.();
                return requirements(device >>> 0, { width: width >>> 0, height: height >>> 0,
                    levels: levels >>> 0, usage: usage >>> 0, format: format >>> 0 }, thread)
                    .then(found=>(typeof found === 'number' ? found
                        : method(thread, device, DEVICE.CreateTexture, [found.width,
                            found.height, found.levels, found.usage, found.format, pool >>> 0,
                            out >>> 0, 0])));
            },
        },

        /**
         * HRESULT D3DXFillTexture(LPDIRECT3DTEXTURE9 pTexture, LPD3DXFILL2D pFunction,
         *     LPVOID pData)
         *
         * The function is VOID WINAPI (D3DXVECTOR4 *pOut, const D3DXVECTOR2 *pTexCoord,
         * const D3DXVECTOR2 *pTexelSize, LPVOID pData), called once a texel, the
         * levels in order and each level row by row.
         */
        D3DXFillTexture: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([texture, fill, data])=>{
                if ((texture >>> 0) === 0 || (fill >>> 0) === 0 || !host.callGuest
                    || !host.heap)
                {
                    return D3DERR_INVALIDCALL;
                }
                return fillTexture(texture >>> 0, fill >>> 0, data, host.currentThread?.());
            },
        },
    };
}
