/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { TEXTURE, createDeviceCalls } from './device.js';
import { IFF } from './images.js';
import { FMT, decodeTexels, isCompressed, isSupported, layoutOf } from './pixels.js';

/**
 * D3DXSaveTextureToFile and D3DXSaveTextureToFileInMemory: a texture of the
 * program's read through its levels' locks and written as an image file.
 *
 * DDS keeps every level as the texture holds it, in its own format: the
 * formats with a documented mask layout described by their masks, the
 * block-compressed ones and every other by their D3DFORMAT as the four-
 * character code, as Direct3D 9's DDS files carry formats that have no masks.
 * BMP and DIB keep the first level, as 24-bit colour, or 32-bit with the
 * alpha beside it for a format that has alpha, in the formats the loaders
 * decode (pixels.js). The other image formats, a cube or volume texture, and
 * a BMP of a format that does not decode are told as divergences and answer
 * E_NOTIMPL.
 */

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const E_NOTIMPL = 0x80004001;
const E_OUTOFMEMORY = 0x8007000e;
const E_FAIL = 0x80004005;
const D3DLOCK_READONLY = 0x10;
const D3DRTYPE_TEXTURE = 3;
const SURFACE_DESC_BYTES = 32;
const IFF_DIB = 6;

/** DDS_HEADER's flags and caps, and DDS_PIXELFORMAT's. */
const DDSD = { CAPS: 0x1, HEIGHT: 0x2, WIDTH: 0x4, PITCH: 0x8, PIXELFORMAT: 0x1000,
    MIPMAPCOUNT: 0x20000, LINEARSIZE: 0x80000 };
const DDSCAPS = { COMPLEX: 0x8, TEXTURE: 0x1000, MIPMAP: 0x400000 };
const DDPF = { ALPHAPIXELS: 0x1, ALPHA: 0x2, FOURCC: 0x4, RGB: 0x40, LUMINANCE: 0x20000 };

/**
 * The formats a DDS file describes by masks: flags, bits a texel, then the
 * red, green, blue and alpha masks.
 *
 * @type {Map<number, number[]>}
 */
const MASKS = new Map([
    [FMT.A8R8G8B8, [DDPF.RGB | DDPF.ALPHAPIXELS, 32, 0xff0000, 0xff00, 0xff, 0xff000000]],
    [FMT.X8R8G8B8, [DDPF.RGB, 32, 0xff0000, 0xff00, 0xff, 0]],
    [FMT.R8G8B8, [DDPF.RGB, 24, 0xff0000, 0xff00, 0xff, 0]],
    [FMT.R5G6B5, [DDPF.RGB, 16, 0xf800, 0x7e0, 0x1f, 0]],
    [FMT.X1R5G5B5, [DDPF.RGB, 16, 0x7c00, 0x3e0, 0x1f, 0]],
    [FMT.A1R5G5B5, [DDPF.RGB | DDPF.ALPHAPIXELS, 16, 0x7c00, 0x3e0, 0x1f, 0x8000]],
    [FMT.A4R4G4B4, [DDPF.RGB | DDPF.ALPHAPIXELS, 16, 0xf00, 0xf0, 0xf, 0xf000]],
    [FMT.X4R4G4B4, [DDPF.RGB, 16, 0xf00, 0xf0, 0xf, 0]],
    [FMT.A8B8G8R8, [DDPF.RGB | DDPF.ALPHAPIXELS, 32, 0xff, 0xff00, 0xff0000, 0xff000000]],
    [FMT.X8B8G8R8, [DDPF.RGB, 32, 0xff, 0xff00, 0xff0000, 0]],
    [FMT.A8, [DDPF.ALPHA, 8, 0, 0, 0, 0xff]],
    [FMT.L8, [DDPF.LUMINANCE, 8, 0xff, 0, 0, 0]],
    [FMT.A8L8, [DDPF.LUMINANCE | DDPF.ALPHAPIXELS, 16, 0xff, 0, 0, 0xff00]],
]);

/** Bytes a texel of the formats outside pixels.js that a DDS file may carry. */
const OTHER_BYTES = new Map([[34, 4], [36, 8], [111, 2], [112, 4], [113, 8], [114, 4],
    [115, 8], [116, 16]]);

/** The formats whose BMP keeps their alpha. */
/** @type {Set<number>} */
const HAS_ALPHA = new Set([FMT.A8R8G8B8, FMT.A1R5G5B5, FMT.A4R4G4B4, FMT.A8, FMT.A8L8,
    FMT.A8B8G8R8, FMT.DXT2, FMT.DXT3, FMT.DXT4, FMT.DXT5]);

/**
 * A level's rows, packed: its row bytes and row count.
 *
 * @param {number} format @param {number} width @param {number} height
 * @returns {{ rowBytes: number, rows: number } | null}  Null for a format of unknown size.
 */
function rowsOf(format, width, height){
    if (isSupported(format))
    {
        return layoutOf(format, width, height);
    }
    const bytes = OTHER_BYTES.get(format);
    return bytes === undefined ? null : { rowBytes: width * bytes, rows: height };
}

/**
 * A DDS file of these levels.
 *
 * @param {number} format @param {{ width: number, height: number, bytes: Uint8Array }[]} levels
 * @returns {Uint8Array}
 */
export function writeDds(format, levels){
    const total = levels.reduce((sum, level)=>sum + level.bytes.length, 0);
    const out = new Uint8Array(128 + total);
    const view = new DataView(out.buffer);
    const [top] = levels;
    const compressed = isCompressed(format);
    const many = levels.length > 1;
    view.setUint32(0, 0x20534444, true);
    view.setUint32(4, 124, true);
    view.setUint32(8, DDSD.CAPS | DDSD.HEIGHT | DDSD.WIDTH | DDSD.PIXELFORMAT
        | (compressed ? DDSD.LINEARSIZE : DDSD.PITCH) | (many ? DDSD.MIPMAPCOUNT : 0), true);
    view.setUint32(12, top.height, true);
    view.setUint32(16, top.width, true);
    const layout = /** @type {{ rowBytes: number, rows: number }} */ (rowsOf(format, top.width,
        top.height));
    view.setUint32(20, compressed ? top.bytes.length : layout.rowBytes, true);
    view.setUint32(28, levels.length, true);
    // DDS_PIXELFORMAT, at 76.
    view.setUint32(76, 32, true);
    const masks = MASKS.get(format);
    if (masks)
    {
        const [flags, bits, ...rgba] = masks;
        view.setUint32(80, flags, true);
        view.setUint32(88, bits, true);
        rgba.forEach((mask, i)=>view.setUint32(92 + i * 4, mask >>> 0, true));
    }
    else
    {
        view.setUint32(80, DDPF.FOURCC, true);
        view.setUint32(84, format >>> 0, true);
    }
    view.setUint32(108, DDSCAPS.TEXTURE | (many ? DDSCAPS.COMPLEX | DDSCAPS.MIPMAP : 0), true);
    let at = 128;
    for (const level of levels)
    {
        out.set(level.bytes, at);
        at += level.bytes.length;
    }
    return out;
}

/**
 * A BMP file -- or, for a DIB, the same without its file header -- of a
 * level in the working form (B, G, R, A bytes), bottom row first.
 *
 * @param {Uint8Array} bgra @param {number} width @param {number} height
 * @param {boolean} alpha  32 bits a pixel, alpha kept; else 24.
 * @param {boolean} [dib]
 * @returns {Uint8Array}
 */
export function writeBmp(bgra, width, height, alpha, dib = false){
    const bytes = alpha ? 4 : 3;
    const stride = (width * bytes + 3) & ~3;
    const header = dib ? 0 : 14;
    const out = new Uint8Array(header + 40 + stride * height);
    const view = new DataView(out.buffer);
    if (!dib)
    {
        out.set([0x42, 0x4d]);
        view.setUint32(2, out.length, true);
        view.setUint32(10, header + 40, true);
    }
    view.setUint32(header, 40, true);
    view.setInt32(header + 4, width, true);
    view.setInt32(header + 8, height, true);
    view.setUint16(header + 12, 1, true);
    view.setUint16(header + 14, bytes * 8, true);
    view.setUint32(header + 20, stride * height, true);
    // 72 dots an inch.
    view.setUint32(header + 24, 2835, true);
    view.setUint32(header + 28, 2835, true);
    for (let y = 0; y < height; y++)
    {
        const row = header + 40 + (height - 1 - y) * stride;
        for (let x = 0; x < width; x++)
        {
            out.set(bgra.subarray((y * width + x) * 4, (y * width + x) * 4 + bytes),
                row + x * bytes);
        }
    }
    return out;
}

/**
 * @typedef {Object} SaveHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {() => any} [currentThread]
 * @property {(path: string, bytes: Uint8Array) => Promise<boolean> | boolean} [writeFile]
 *           A file written whole, created or replaced; false when it could not be.
 */

/**
 * @param {SaveHost} host
 * @param {{ giveBuffer: (out: number, bytes: Uint8Array) => number }} buffers
 */
export function createTextureSaver(host, buffers){
    const { u32, method } = createDeviceCalls(host);

    /**
     * The file a texture makes in an image format, or the HRESULT that says why not.
     *
     * @param {string} api @param {number} texture @param {number} fileFormat
     * @param {number} palette @param {any} thread
     * @returns {Promise<Uint8Array | number>}
     */
    const encode = async(api, texture, fileFormat, palette, thread)=>{
        await null;
        if (fileFormat !== IFF.DDS && fileFormat !== IFF.BMP && fileFormat !== IFF_DIB)
        {
            host.divergence?.(api, `image file format ${fileFormat} is not written: answered `
                + 'E_NOTIMPL');
            return E_NOTIMPL;
        }
        const type = await method(thread, texture, TEXTURE.GetType, []);
        if (type !== D3DRTYPE_TEXTURE)
        {
            host.divergence?.(api, `a resource of type ${type} (a cube or volume texture) is not `
                + 'written: answered E_NOTIMPL');
            return E_NOTIMPL;
        }
        const heap = /** @type {NonNullable<SaveHost['heap']>} */ (host.heap);
        const scratch = heap.allocate(SURFACE_DESC_BYTES + 8);
        if (scratch === 0)
        {
            return E_OUTOFMEMORY;
        }
        try
        {
            const count = fileFormat === IFF.DDS
                ? await method(thread, texture, TEXTURE.GetLevelCount, []) : 1;
            /** @type {{ width: number, height: number, bytes: Uint8Array }[]} */
            const levels = [];
            /** @type {number} */
            let format = FMT.UNKNOWN;
            for (let level = 0; level < count; level++)
            {
                const described = await method(thread, texture, TEXTURE.GetLevelDesc,
                    [level, scratch]);
                if (described !== D3D_OK)
                {
                    return described;
                }
                format = u32(scratch);
                const width = u32(scratch + 24);
                const height = u32(scratch + 28);
                const layout = rowsOf(format, width, height);
                if (!layout || (fileFormat !== IFF.DDS && !isSupported(format)
                    && format !== FMT.P8))
                {
                    host.divergence?.(api, `a texture of format ${format} is not written as `
                        + `image file format ${fileFormat}: answered E_NOTIMPL`);
                    return E_NOTIMPL;
                }
                const locked = scratch + SURFACE_DESC_BYTES;
                const answer = await method(thread, texture, TEXTURE.LockRect,
                    [level, locked, 0, D3DLOCK_READONLY]);
                if (answer !== D3D_OK)
                {
                    return answer;
                }
                const pitch = u32(locked);
                const bits = u32(locked + 4);
                const bytes = new Uint8Array(layout.rowBytes * layout.rows);
                for (let row = 0; row < layout.rows; row++)
                {
                    bytes.set(host.readMemory(bits + row * pitch, layout.rowBytes),
                        row * layout.rowBytes);
                }
                await method(thread, texture, TEXTURE.UnlockRect, [level]);
                levels.push({ width, height, bytes });
            }
            if (fileFormat === IFF.DDS)
            {
                return writeDds(format, levels);
            }
            const [{ width, height, bytes }] = levels;
            const colours = (palette >>> 0) === 0 ? undefined
                : host.readMemory(palette >>> 0, 1024).slice();
            if (format === FMT.P8 && !colours)
            {
                return D3DERR_INVALIDCALL;
            }
            return writeBmp(decodeTexels(format, bytes, width, height, colours), width, height,
                HAS_ALPHA.has(format), fileFormat === IFF_DIB);
        }
        finally
        {
            heap.free(scratch);
        }
    };

    /** @param {number} at @param {boolean} wide */
    const pathAt = (at, wide)=>{
        if (!wide)
        {
            const bytes = host.readMemory(at >>> 0, 260);
            const end = bytes.indexOf(0);
            return String.fromCharCode(...bytes.subarray(0, end < 0 ? bytes.length : end));
        }
        const units = new Uint16Array(host.readMemory(at >>> 0, 520).slice().buffer);
        const end = units.indexOf(0);
        return String.fromCharCode(...units.subarray(0, end < 0 ? units.length : end));
    };

    /**
     * @param {string} api @param {boolean} wide
     * @returns {{ argBytes: number, handler: (args: number[]) => number | Promise<number> }}
     */
    const toFile = (api, wide)=>({
        argBytes: 16,
        handler: ([file, fileFormat, texture, palette])=>{
            if ((file >>> 0) === 0 || (texture >>> 0) === 0 || !host.callGuest || !host.heap)
            {
                return D3DERR_INVALIDCALL;
            }
            const path = pathAt(file, wide);
            const { writeFile } = host;
            if (!writeFile)
            {
                host.divergence?.(api, `no file can be written here: ${path} answered E_NOTIMPL`);
                return E_NOTIMPL;
            }
            return encode(api, texture >>> 0, fileFormat >>> 0, palette, host.currentThread?.())
                .then(async made=>{
                    if (typeof made === 'number')
                    {
                        return made;
                    }
                    return await writeFile(path, made) ? D3D_OK : E_FAIL;
                });
        },
    });

    return {
        /**
         * HRESULT D3DXSaveTextureToFileA(LPCSTR pDestFile,
         *     D3DXIMAGE_FILEFORMAT DestFormat, LPDIRECT3DBASETEXTURE9 pSrcTexture,
         *     CONST PALETTEENTRY *pSrcPalette)
         */
        D3DXSaveTextureToFileA: toFile('D3DXSaveTextureToFileA', false),
        /** The same, the name wide. */
        D3DXSaveTextureToFileW: toFile('D3DXSaveTextureToFileW', true),

        /**
         * HRESULT D3DXSaveTextureToFileInMemory(LPD3DXBUFFER *ppDestBuf,
         *     D3DXIMAGE_FILEFORMAT DestFormat, LPDIRECT3DBASETEXTURE9 pSrcTexture,
         *     CONST PALETTEENTRY *pSrcPalette)
         */
        D3DXSaveTextureToFileInMemory: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([out, fileFormat, texture, palette])=>{
                if ((out >>> 0) !== 0)
                {
                    host.writeMemory(out >>> 0, new Uint8Array(4));
                }
                if ((out >>> 0) === 0 || (texture >>> 0) === 0 || !host.callGuest || !host.heap)
                {
                    return D3DERR_INVALIDCALL;
                }
                return encode('D3DXSaveTextureToFileInMemory', texture >>> 0, fileFormat >>> 0,
                    palette, host.currentThread?.()).then(made=>(typeof made === 'number' ? made
                    : buffers.giveBuffer(out >>> 0, made)));
            },
        },
    };
}
