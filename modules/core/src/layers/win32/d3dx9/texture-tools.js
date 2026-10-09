/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { DEVICE, createDeviceCalls } from './device.js';
import { D3DX_DEFAULT } from './texture.js';
import { FMT, isCompressed } from './pixels.js';

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
 */

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const E_OUTOFMEMORY = 0x8007000e;

const D3DPTEXTURECAPS_POW2 = 0x2;
const D3DPTEXTURECAPS_SQUAREONLY = 0x20;
const D3DPTEXTURECAPS_NONPOW2CONDITIONAL = 0x100;
const D3DUSAGE_AUTOGENMIPMAP = 0x400;
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
    };
}
