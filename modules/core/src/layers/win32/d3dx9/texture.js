/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { DEVICE, TEXTURE, UNKNOWN_RELEASE, createDeviceCalls } from './device.js';
import { ImageError, readImage } from './images.js';
import { FMT, decodeTexels, encodeTexels, halve, isCompressed, isSupported, layoutOf, resample }
    from './pixels.js';

/**
 * D3DX's texture loaders: an image file in memory made into a texture on the
 * program's own device, through the device's own methods -- CreateTexture,
 * the levels locked and written, and for a texture the device keeps where it
 * cannot be locked (the default pool, not dynamic), a system-memory copy
 * handed over with UpdateTexture, as D3DX itself does.
 *
 * The sizes, level count and format follow the documented meaning of
 * D3DX_DEFAULT, D3DX_DEFAULT_NONPOW2 and D3DX_FROM_FILE; the levels the file
 * does not hold are made with a box filter; a colour key replaces the texels
 * of that colour with transparent black.
 */

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DXERR_INVALIDDATA = 0x88760b59;
const E_OUTOFMEMORY = 0x8007000e;

export const D3DX_DEFAULT = 0xffffffff;
export const D3DX_DEFAULT_NONPOW2 = 0xfffffffe;
export const D3DX_FROM_FILE = 0xfffffffd;

const D3DPOOL_DEFAULT = 0;
const D3DPOOL_SYSTEMMEM = 2;
const D3DUSAGE_DYNAMIC = 0x200;
const D3DRTYPE_TEXTURE = 3;

/**
 * @typedef {Object} TextureHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {() => any} [currentThread]
 */

/** @param {number} value */
const nextPowerOfTwo = value=>2 ** Math.ceil(Math.log2(Math.max(1, value)));

/** A size argument, as D3DX reads it. @param {number} asked @param {number} file */
function sizeOf(asked, file){
    if (asked === 0 || asked === D3DX_DEFAULT_NONPOW2 || asked === D3DX_FROM_FILE)
    {
        return file;
    }
    return asked === D3DX_DEFAULT ? nextPowerOfTwo(file) : asked;
}

/**
 * The format a file's texels go into when the program names none: the file's
 * own where this loader can write it, else the nearest that holds as much.
 *
 * @param {number} file
 */
function formatFromFile(file){
    if (isSupported(file) && file !== FMT.R8G8B8)
    {
        return file;
    }
    return file === FMT.R8G8B8 || file === FMT.P8 ? FMT.X8R8G8B8 : FMT.A8R8G8B8;
}

/**
 * @param {TextureHost} host
 */
export function createTextureLoader(host){
    const { u32, putU32s, method: call } = createDeviceCalls(host);

    /**
     * Writes D3DXIMAGE_INFO.
     *
     * @param {number} at @param {import('./images.js').Image} image
     */
    const writeInfo = (at, image)=>{
        putU32s(at, [image.width, image.height, 1, image.mipLevels, image.format,
            D3DRTYPE_TEXTURE, image.fileFormat]);
    };

    /**
     * The file read, or the answer a loader gives for one it cannot read.
     *
     * @param {string} api @param {number} data @param {number} size
     * @returns {import('./images.js').Image | number}
     */
    const read = (api, data, size)=>{
        try
        {
            return readImage(host.readMemory(data >>> 0, size >>> 0).slice());
        }
        catch (e){
            if (!(e instanceof ImageError))
            {
                throw e;
            }
            host.divergence?.(api, `answered D3DXERR_INVALIDDATA: ${e.message}`);
            return D3DXERR_INVALIDDATA;
        }
    };

    /**
     * HRESULT D3DXGetImageInfoFromFileInMemory(LPCVOID pSrcData, UINT SrcDataSize,
     *     D3DXIMAGE_INFO *pSrcInfo)
     *
     * @param {number[]} args
     */
    const imageInfo = ([data, size, info])=>{
        if ((data >>> 0) === 0 || (size >>> 0) === 0)
        {
            return D3DERR_INVALIDCALL;
        }
        const image = read('D3DXGetImageInfoFromFileInMemory', data, size);
        if (typeof image === 'number')
        {
            return image;
        }
        if ((info >>> 0) !== 0)
        {
            writeInfo(info, image);
        }
        return D3D_OK;
    };

    /**
     * HRESULT D3DXCreateTextureFromFileInMemoryEx(LPDIRECT3DDEVICE9 pDevice, LPCVOID pSrcData,
     *     UINT SrcDataSize, UINT Width, UINT Height, UINT MipLevels, DWORD Usage,
     *     D3DFORMAT Format, D3DPOOL Pool, DWORD Filter, DWORD MipFilter, D3DCOLOR ColorKey,
     *     D3DXIMAGE_INFO *pSrcInfo, PALETTEENTRY *pPalette, LPDIRECT3DTEXTURE9 *ppTexture)
     *
     * @param {number[]} args
     * @returns {number | Promise<number>}
     */
    const fromMemory = args=>{
        const [device, data, size, width, height, mips, usage, format, pool, , , colorKey,
            info, , out] = args.map(a=>a >>> 0);
        if (out !== 0)
        {
            putU32s(out, [0]);
        }
        if (device === 0 || data === 0 || size === 0 || out === 0 || !host.callGuest
            || !host.heap)
        {
            return D3DERR_INVALIDCALL;
        }
        const image = read('D3DXCreateTextureFromFileInMemoryEx', data, size);
        if (typeof image === 'number')
        {
            return image;
        }
        if (info !== 0)
        {
            writeInfo(info, image);
        }
        const w = sizeOf(width, image.width);
        const h = sizeOf(height, image.height);
        let target = format === FMT.UNKNOWN || format === D3DX_FROM_FILE
            ? formatFromFile(image.format) : format;
        if (!isSupported(target))
        {
            host.divergence?.('D3DXCreateTextureFromFileInMemoryEx', `format ${target} is not `
                + 'one this loader writes: A8R8G8B8 instead');
            target = FMT.A8R8G8B8;
        }
        const full = Math.floor(Math.log2(Math.max(w, h))) + 1;
        const count = mips === 0 || mips === D3DX_DEFAULT ? full
            : mips === D3DX_FROM_FILE ? Math.min(full, image.mipLevels) : Math.min(full, mips);
        const levels = levelsOf(image, w, h, count, target, colorKey);
        const thread = host.currentThread?.();
        return upload(device, { w, h, count, usage, pool, target, levels, out, thread });
    };

    /**
     * The bytes of each level in the texture's format.
     *
     * @param {import('./images.js').Image} image @param {number} w @param {number} h
     * @param {number} count @param {number} target @param {number} colorKey
     * @returns {Uint8Array[]}
     */
    const levelsOf = (image, w, h, count, target, colorKey)=>{
        /** @type {Uint8Array[]} */
        const out = [];
        /** @type {Uint8Array | null} */
        let previous = null;
        for (let level = 0; level < count; level++)
        {
            const lw = Math.max(1, w >> level);
            const lh = Math.max(1, h >> level);
            const held = image.levels[level];
            const fits = held && held.width === lw && held.height === lh;
            if (fits && held.format === target && colorKey === 0)
            {
                // A compressed level already in the format asked for goes as it is.
                out.push(held.data);
                previous = null;
                continue;
            }
            /** @type {Uint8Array} */
            let bgra;
            if (fits)
            {
                bgra = isCompressed(held.format) ? decodeTexels(held.format, held.data, lw, lh)
                    : held.data.slice();
            }
            else if (previous && level > 0)
            {
                bgra = halve(previous, Math.max(1, w >> (level - 1)),
                    Math.max(1, h >> (level - 1))).bgra;
            }
            else
            {
                const top = image.levels[0];
                const texels = isCompressed(top.format)
                    ? decodeTexels(top.format, top.data, top.width, top.height) : top.data;
                bgra = resample(texels, top.width, top.height, lw, lh);
            }
            if (colorKey !== 0)
            {
                applyColorKey(bgra, colorKey);
            }
            previous = bgra;
            out.push(encodeTexels(target, bgra, lw, lh));
        }
        return out;
    };

    /**
     * The texture made on the device and its levels written.
     *
     * @param {number} device
     * @param {{ w: number, h: number, count: number, usage: number, pool: number,
     *     target: number, levels: Uint8Array[], out: number, thread: any }} plan
     * @returns {Promise<number>}
     */
    const upload = async(device, plan)=>{
        // The bridge places a call into the guest below the host call in flight,
        // and this one is in flight only once its handler has returned its promise.
        await null;
        const heap = /** @type {NonNullable<TextureHost['heap']>} */ (host.heap);
        const scratch = heap.allocate(16);
        if (scratch === 0)
        {
            return E_OUTOFMEMORY;
        }
        /** @param {number} object @param {number} slot @param {number[]} rest */
        const method = (object, slot, rest)=>call(plan.thread, object, slot, rest);
        let failed = D3D_OK;
        /** @param {number} usage @param {number} pool @returns {Promise<number | null>} */
        const create = async(usage, pool)=>{
            putU32s(scratch, [0]);
            const answer = await method(device, DEVICE.CreateTexture, [plan.w, plan.h, plan.count,
                usage, plan.target, pool, scratch, 0]);
            if (answer !== D3D_OK)
            {
                failed = answer;
                return null;
            }
            return u32(scratch);
        };
        try
        {
            const lockable = plan.pool !== D3DPOOL_DEFAULT || (plan.usage & D3DUSAGE_DYNAMIC) !== 0;
            const filled = await create(lockable ? plan.usage : 0,
                lockable ? plan.pool : D3DPOOL_SYSTEMMEM);
            if (filled === null)
            {
                return failed;
            }
            for (let level = 0; level < plan.count; level++)
            {
                const answer = await method(filled, TEXTURE.LockRect, [level, scratch + 4, 0, 0]);
                if (answer !== D3D_OK)
                {
                    await method(filled, UNKNOWN_RELEASE, []);
                    return answer;
                }
                const pitch = u32(scratch + 4);
                const bits = u32(scratch + 8);
                const { rowBytes, rows } = layoutOf(plan.target, Math.max(1, plan.w >> level),
                    Math.max(1, plan.h >> level));
                const bytes = plan.levels[level];
                for (let row = 0; row < rows; row++)
                {
                    host.writeMemory(bits + row * pitch,
                        bytes.subarray(row * rowBytes, (row + 1) * rowBytes));
                }
                await method(filled, TEXTURE.UnlockRect, [level]);
            }
            if (lockable)
            {
                putU32s(plan.out, [filled]);
                return D3D_OK;
            }
            const placed = await create(plan.usage, plan.pool);
            if (placed === null)
            {
                await method(filled, UNKNOWN_RELEASE, []);
                return failed;
            }
            const answer = await method(device, DEVICE.UpdateTexture, [filled, placed]);
            await method(filled, UNKNOWN_RELEASE, []);
            if (answer !== D3D_OK)
            {
                await method(placed, UNKNOWN_RELEASE, []);
                return answer;
            }
            putU32s(plan.out, [placed]);
            return D3D_OK;
        }
        finally
        {
            heap.free(scratch);
        }
    };

    return { fromMemory, imageInfo };
}

/**
 * Texels of the key's colour, alpha included, made transparent black.
 *
 * @param {Uint8Array} bgra @param {number} key  ARGB.
 */
function applyColorKey(bgra, key){
    for (let i = 0; i < bgra.length; i += 4)
    {
        const argb = (bgra[i + 3] << 24 | bgra[i + 2] << 16 | bgra[i + 1] << 8 | bgra[i]) >>> 0;
        if (argb === key >>> 0)
        {
            bgra.fill(0, i, i + 4);
        }
    }
}
