/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * D3DX 10: the helper library a Direct3D 10 program links as `d3dx10_NN.dll`.
 *
 * Its mathematics is D3DX 9's -- the same functions under the same names --
 * so those come from that table. What is its own is the image loaders, which
 * make a texture on the program's device through the device's own methods,
 * as D3DX itself does (`CreateTexture2D` with the levels as initial data),
 * and the shader compiler, which this build does not have: a compile is
 * refused with an error blob saying so, which is what a program that ships
 * its shaders compiled (and compiles only what its cache lacks) is told.
 */

import { createDeviceCalls } from '../d3dx9/device.js';
import { ImageError, readImage } from '../d3dx9/images.js';
import {
    FMT, decodeAlphaBlock, decodeTexels, encodeAlphaBlock, encodeTexels, halve, keptAsIs,
    resample,
} from '../d3dx9/pixels.js';
import {
    DIMENSION, averagesBytes, dxgiLayout, halveTexels, isDxgiDds, readDxgiDds, resampleTexels,
    texelBytesOf,
} from './dds10.js';
import { createComObject } from '../ole32/objects.js';

const S_OK = 0;
const E_FAIL = 0x80004005;
const E_INVALIDARG = 0x80070057;
const E_NOTIMPL = 0x80004001;
const E_OUTOFMEMORY = 0x8007000e;
/** D3DX10_ERR_INVALID_DATA. */
const D3DX10_ERR_INVALID_DATA = 0x88760b59;

/** IID_ID3D10Blob, which is IID_ID3DXBuffer's number too. */
const IID_ID3D10BLOB = '{8BA5FB08-5195-40E2-AC58-0D989C3A0102}';

/** D3D10_SDK_VERSION, which D3DX10CheckVersion holds a program's to. */
const D3D10_SDK_VERSION = 29;

/**
 * ID3D10Device's methods used here, by vtable slot (d3d10.h; the device's
 * table is `graphics/d3d10/slots.js`): the creates the loaders call, and the
 * setters D3DX10UnsetAllDeviceObjects calls.
 */
const DEVICE = Object.freeze({ CreateTexture1D: 72, CreateTexture2D: 73, CreateTexture3D: 74,
    CreateShaderResourceView: 75,
    VSSetConstantBuffers: 3, PSSetShaderResources: 4, PSSetShader: 5, PSSetSamplers: 6,
    VSSetShader: 7, PSSetConstantBuffers: 10, IASetInputLayout: 11, IASetVertexBuffers: 12,
    IASetIndexBuffer: 13, GSSetConstantBuffers: 16, GSSetShader: 17, VSSetShaderResources: 19,
    VSSetSamplers: 20, GSSetShaderResources: 22, GSSetSamplers: 23, OMSetRenderTargets: 24,
    OMSetBlendState: 25, OMSetDepthStencilState: 26, SOSetTargets: 27, RSSetState: 29,
});

/** Each shader stage's constant buffers, resources, samplers and shader. */
const STAGE_SLOTS = [
    [DEVICE.VSSetConstantBuffers, DEVICE.VSSetShaderResources, DEVICE.VSSetSamplers,
        DEVICE.VSSetShader],
    [DEVICE.PSSetConstantBuffers, DEVICE.PSSetShaderResources, DEVICE.PSSetSamplers,
        DEVICE.PSSetShader],
    [DEVICE.GSSetConstantBuffers, DEVICE.GSSetShaderResources, DEVICE.GSSetSamplers,
        DEVICE.GSSetShader],
];

/** D3D10's slot counts: the common shader's, the input assembler's, stream output's, the OM's. */
const CONSTANT_BUFFER_SLOTS = 14;
const RESOURCE_SLOTS = 128;
const SAMPLER_SLOTS = 16;
const VERTEX_BUFFER_SLOTS = 16;
const STREAM_OUTPUT_SLOTS = 4;
const RENDER_TARGET_SLOTS = 8;

export const D3DX10_DEFAULT = 0xffffffff;
export const D3DX10_FROM_FILE = 0xfffffffd;

const UNKNOWN_RELEASE = 2;

/** The DXGI formats a file's texels are made into, and what a row of blocks or texels takes. */
const DXGI = Object.freeze({ B8G8R8A8_UNORM: 87, R8G8B8A8_UNORM: 28, BC1_UNORM: 71,
    BC2_UNORM: 74, BC3_UNORM: 77, R16_UNORM: 56, R16G16_UNORM: 35, R16G16B16A16_UNORM: 11,
    R8G8_SNORM: 51, R8G8B8A8_SNORM: 31, R16G16_SNORM: 37 });

/** D3D10_BIND_SHADER_RESOURCE and D3D10_RESOURCE_MISC_TEXTURECUBE. */
const BIND_SHADER_RESOURCE = 0x8;
const MISC_TEXTURECUBE = 0x4;

/**
 * The DXGI format a file's level is held in: its blocks as they are, or
 * the BGRA texels the reader makes of every other format.
 *
 * @param {number} format  the level's D3DFORMAT
 */
const dxgiOf = format=>{
    switch (format)
    {
        case FMT.DXT1:
            return DXGI.BC1_UNORM;
        case FMT.DXT2:
        case FMT.DXT3:
            return DXGI.BC2_UNORM;
        case FMT.DXT4:
        case FMT.DXT5:
            return DXGI.BC3_UNORM;
        // Held as the file has them, and laid out byte for byte as these are.
        case FMT.L16:
            return DXGI.R16_UNORM;
        case FMT.G16R16:
            return DXGI.R16G16_UNORM;
        case FMT.A16B16G16R16:
            return DXGI.R16G16B16A16_UNORM;
        case FMT.V8U8:
            return DXGI.R8G8_SNORM;
        case FMT.Q8W8V8U8:
            return DXGI.R8G8B8A8_SNORM;
        case FMT.V16U16:
            return DXGI.R16G16_SNORM;
        default:
            return DXGI.B8G8R8A8_UNORM;
    }
};

/**
 * A row's bytes and the rows of a level, in the DXGI format.
 *
 * @param {number} format @param {number} width @param {number} height
 */
const pitchOf = (format, width, height)=>/** @type {{ rowBytes: number, rows: number }} */ (
    dxgiLayout(format, width, height));

/**
 * @typedef {import('../d3dx9/images.js').Image
 *     | import('./dds10.js').DxgiImage} AnyImage
 */

/** @typedef {{ width: number, height: number, data: Uint8Array }} TexelLevel */

/** The next level of BGRA texels, box-filtered. @param {TexelLevel} level @returns {TexelLevel} */
const bgraSmaller = level=>{
    const half = halve(level.data, level.width, level.height);
    return { width: half.width, height: half.height, data: half.bgra };
};

/** The DXGI format a file holds, when it says one. @param {AnyImage} image */
const nativeOf = image=>('dxgi' in image ? image : null);

/** BC1, BC2 and BC3 (typeless, UNORM and sRGB) as the DXTn blocks they are laid out as. */
const BLOCK_CODEC = new Map([[70, FMT.DXT1], [71, FMT.DXT1], [72, FMT.DXT1], [73, FMT.DXT3],
    [74, FMT.DXT3], [75, FMT.DXT3], [76, FMT.DXT5], [77, FMT.DXT5], [78, FMT.DXT5]]);

/** BC4 and BC5 (typeless and UNORM): channels a block, each eight bytes of DXT5's alpha. */
const CHANNEL_BLOCKS = new Map([[79, 1], [80, 1], [82, 2], [83, 2]]);

/**
 * BC4 or BC5 blocks as texels of a byte a channel, or texels as blocks.
 *
 * @param {Uint8Array} data @param {number} width @param {number} height
 * @param {number} channels @param {boolean} encode  texels into blocks
 * @returns {Uint8Array}
 */
const channelBlocks = (data, width, height, channels, encode)=>{
    const across = Math.max(1, Math.ceil(width / 4));
    const down = Math.max(1, Math.ceil(height / 4));
    const out = new Uint8Array(encode ? across * down * channels * 8 : width * height * channels);
    for (let by = 0; by < down; by++)
    {
        for (let bx = 0; bx < across; bx++)
        {
            const at = (by * across + bx) * channels * 8;
            for (let c = 0; c < channels; c++)
            {
                /** Where texel k of the block is, the edges repeated past the level. */
                const texel = (/** @type {number} */ k, /** @type {boolean} */ clamp)=>{
                    const x = bx * 4 + (k & 3);
                    const y = by * 4 + (k >> 2);
                    return clamp ? (Math.min(height - 1, y) * width + Math.min(width - 1, x))
                        * channels + c : x < width && y < height ? (y * width + x) * channels + c
                        : -1;
                };
                if (encode)
                {
                    encodeAlphaBlock(Array.from({ length: 16 }, (_, k)=>data[texel(k, true)]), out,
                        at + c * 8);
                    continue;
                }
                decodeAlphaBlock(data, at + c * 8).forEach((value, k)=>{
                    const to = texel(k, false);
                    if (to >= 0)
                    {
                        out[to] = value;
                    }
                });
            }
        }
    }
    return out;
};

/**
 * @typedef {Object} NativeCodec  How a file's own DXGI levels are remade.
 * @property {(level: TexelLevel, width: number, height: number) => Uint8Array} stretch
 * @property {(level: TexelLevel) => TexelLevel} smaller  the next level down
 * @property {boolean} nearest  whether both take the nearest texel rather than a filter
 */

/**
 * The codec of a DXGI format: texels a whole number of bytes are stretched
 * and halved byte for byte, BC1 to BC5 (unsigned) blocks through their
 * texels and back; null for a format with neither (signed BC4 and BC5, BC6H,
 * BC7, pairs, bits).
 *
 * @param {number} dxgi
 * @returns {NativeCodec | null}
 */
const nativeCodec = dxgi=>{
    const bytes = texelBytesOf(dxgi);
    if (bytes)
    {
        return {
            stretch: (level, width, height)=>resampleTexels(level.data, level.width,
                level.height, width, height, bytes),
            smaller: level=>halveTexels(level.data, level.width, level.height, bytes,
                averagesBytes(dxgi)),
            nearest: !averagesBytes(dxgi),
        };
    }
    const channels = CHANNEL_BLOCKS.get(dxgi);
    if (channels)
    {
        /** @param {TexelLevel} level */
        const values = level=>channelBlocks(level.data, level.width, level.height, channels,
            false);
        return {
            stretch: (level, width, height)=>channelBlocks(resampleTexels(values(level),
                level.width, level.height, width, height, channels), width, height, channels,
            true),
            smaller: level=>{
                const half = halveTexels(values(level), level.width, level.height, channels, true);
                return { width: half.width, height: half.height,
                    data: channelBlocks(half.data, half.width, half.height, channels, true) };
            },
            nearest: false,
        };
    }
    const blocks = BLOCK_CODEC.get(dxgi);
    if (blocks === undefined)
    {
        return null;
    }
    /** @param {TexelLevel} level */
    const texels = level=>decodeTexels(blocks, level.data, level.width, level.height);
    return {
        stretch: (level, width, height)=>encodeTexels(blocks, resample(texels(level),
            level.width, level.height, width, height), width, height),
        smaller: level=>{
            const half = halve(texels(level), level.width, level.height);
            return { width: half.width, height: half.height,
                data: encodeTexels(blocks, half.bgra, half.width, half.height) };
        },
        nearest: false,
    };
};

/**
 * A file in its own DXGI format made the size asked: each slice's top level
 * stretched by its codec; the levels below are made from it.
 *
 * @param {import('./dds10.js').DxgiImage} image
 * @param {number} toWidth @param {number} toHeight @param {NativeCodec} codec
 * @returns {import('./dds10.js').DxgiImage}
 */
const nativeResizedTo = (image, toWidth, toHeight, codec)=>{
    /** @type {import('./dds10.js').DxgiLevel[][]} */
    const faces = (image.faces ?? [image.levels]).map(([top])=>[{ width: toWidth,
        height: toHeight, format: 0, dxgi: image.dxgi, data: codec.stretch(top, toWidth,
            toHeight) }]);
    return { ...image, width: toWidth, height: toHeight, mipLevels: 1, levels: faces[0],
        ...(image.faces ? { faces } : {}) };
};

/**
 * A file's image from its level `skip` down: a size asked that the file holds
 * as one of its levels is taken from there (decision A234).
 *
 * @template {AnyImage} T
 * @param {T} image @param {number} skip
 * @returns {T}
 */
const fromLevel = (image, skip)=>({ ...image, width: image.levels[skip].width,
    height: image.levels[skip].height, mipLevels: image.mipLevels - skip,
    levels: image.levels.slice(skip),
    ...(image.faces ? { faces: image.faces.map(levels=>levels.slice(skip)) } : {}) });

/**
 * The level of a file sized as asked, below its first, or -1.
 *
 * @param {AnyImage} image @param {number} width @param {number} height
 */
const levelSized = (image, width, height)=>image.levels.findIndex((level, index)=>index > 0
    && level.width === width && level.height === height);

/**
 * An image made the size asked, as D3DX 10 resizes a file before it makes the
 * levels: each face's top level stretched to it, then its whole chain halved
 * from there, put back in the file's own format where the file's level was
 * held as it is (blocks, deep or signed texels).
 *
 * @param {import('../d3dx9/images.js').Image} image
 * @param {number} toWidth @param {number} toHeight
 * @returns {import('../d3dx9/images.js').Image}
 */
const resizedTo = (image, toWidth, toHeight)=>{
    const faces = (image.faces ?? [image.levels]).map(levels=>{
        const top = levels[0];
        const own = keptAsIs(top.format);
        let bgra = resample(own ? decodeTexels(top.format, top.data, top.width, top.height)
            : top.data, top.width, top.height, toWidth, toHeight);
        let width = toWidth;
        let height = toHeight;
        /** @type {import('../d3dx9/images.js').Level[]} */
        const chain = [];
        for (;;)
        {
            chain.push({ width, height, format: top.format,
                data: own ? encodeTexels(top.format, bgra, width, height) : bgra });
            if (width === 1 && height === 1)
            {
                return chain;
            }
            ({ bgra, width, height } = halve(bgra, width, height));
        }
    });
    return { ...image, width: toWidth, height: toHeight, mipLevels: faces[0].length,
        levels: faces[0], ...(image.faces ? { faces } : {}) };
};

/**
 * @typedef {Object} D3dx10Host
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number) => number} [readU32]
 * @property {(address: number, value: number) => void} [writeU32]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ publish: (object: any, interfaceId: string) => number }} [vtables]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {() => any} [currentThread]
 * @property {(path: string) => Promise<Uint8Array | null> | Uint8Array | null} [readFile]
 * @property {() => Promise<number>} [compiler]
 *     Where this process's D3DCompile is (d3dcompiler_43's), or 0 for none.
 */

/**
 * What a load is asked for, D3DX10_IMAGE_LOAD_INFO's fields; every one
 * D3DX10_DEFAULT when the program passes none.
 *
 * @typedef {{ width: number, height: number, depth: number, firstMip: number, mips: number,
 *     usage: number, bind: number, cpu: number, misc: number, format: number }} LoadInfo
 */

/**
 * The library's own functions, with D3DX 9's mathematics laid under them by
 * the caller.
 *
 * @param {D3dx10Host} host
 * @param {number} version  the SDK version this copy of the library answers to
 */
export function createD3dx10Functions(host, version){
    const { u32, putU32s, method, string } = createDeviceCalls(host);
    const blob = {
        id: IID_ID3D10BLOB,
        methods: [
            /** LPVOID GetBufferPointer() */
            { name: 'GetBufferPointer', argBytes: 4,
                invoke: (/** @type {any} */ object)=>object.state.data },
            /** SIZE_T GetBufferSize() */
            { name: 'GetBufferSize', argBytes: 4,
                invoke: (/** @type {any} */ object)=>object.state.size },
        ],
    };

    /**
     * An ID3D10Blob holding these bytes, its pointer written to `out`.
     *
     * @param {number} out @param {Uint8Array} bytes
     */
    const giveBlob = (out, bytes)=>{
        if (!host.heap || !host.vtables)
        {
            return E_OUTOFMEMORY;
        }
        const heap = host.heap;
        const data = heap.allocate(Math.max(bytes.length, 1));
        if (data === 0)
        {
            return E_OUTOFMEMORY;
        }
        host.writeMemory(data, bytes);
        const object = createComObject(IID_ID3D10BLOB, { interfaces: [blob],
            state: { data, size: bytes.length }, destroy: ()=>heap.free(data) });
        const pointer = host.vtables.publish(object, IID_ID3D10BLOB) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return E_OUTOFMEMORY;
        }
        putU32s(out, [pointer]);
        return S_OK;
    };

    /** @param {number} at @param {number} hr */
    const answer = (at, hr)=>{
        if ((at >>> 0) !== 0)
        {
            putU32s(at, [hr >>> 0]);
        }
        return hr;
    };

    /** @param {number} at @returns {LoadInfo} */
    const loadInfoAt = at=>{
        if ((at >>> 0) === 0)
        {
            return { width: D3DX10_DEFAULT, height: D3DX10_DEFAULT, depth: D3DX10_DEFAULT,
                firstMip: D3DX10_DEFAULT, mips: D3DX10_DEFAULT, usage: D3DX10_DEFAULT,
                bind: D3DX10_DEFAULT, cpu: D3DX10_DEFAULT, misc: D3DX10_DEFAULT,
                format: D3DX10_DEFAULT };
        }
        const [width, height, depth, firstMip, mips, usage, bind, cpu, misc, format] =
            Array.from({ length: 10 }, (_, i)=>u32(at + i * 4));
        return { width, height, depth, firstMip, mips, usage, bind, cpu, misc, format };
    };

    /** @param {number} asked @param {number} fallback */
    const given = (asked, fallback)=>(asked === D3DX10_DEFAULT || asked === D3DX10_FROM_FILE
        ? fallback : asked);

    /**
     * The file's image, or the HRESULT a program gets for one this cannot read.
     *
     * @param {string} api @param {Uint8Array | null} bytes
     * @returns {AnyImage | number}
     */
    const imageOf = (api, bytes)=>{
        if (!bytes)
        {
            return D3DX10_ERR_INVALID_DATA;
        }
        try
        {
            return isDxgiDds(bytes) ? readDxgiDds(bytes) : readImage(bytes);
        }
        catch (e){
            if (e instanceof ImageError)
            {
                host.divergence?.(api, `answered D3DX10_ERR_INVALID_DATA: ${e.message}`);
                return D3DX10_ERR_INVALID_DATA;
            }
            throw e;
        }
    };

    /**
     * Each level the texture is made with, in its format: the file's own, and
     * below the file's last one, its texels halved (blocks are not made again:
     * a compressed file gives the levels it has).
     *
     * @param {import('../d3dx9/images.js').Level[]} held @param {number} count
     * @param {(level: TexelLevel) => TexelLevel} [smaller]  the next level made of one
     * @returns {TexelLevel[]}
     */
    const levelsOf = (held, count, smaller = bgraSmaller)=>{
        /** @type {{ width: number, height: number, data: Uint8Array }[]} */
        const out = [];
        for (let level = 0; level < count; level++)
        {
            const own = held[level];
            out.push(own ? { width: own.width, height: own.height, data: own.data }
                : smaller(out[out.length - 1]));
        }
        return out;
    };

    /** DXGI formats whose levels or size were made by nearest texel, each said once. */
    const nearestSaid = new Set();

    /**
     * The texture made on the device from an image: a 2D texture (six array
     * slices for a cube map) or a volume, its levels written as initial data.
     *
     * @param {string} api @param {number} device
     * @param {AnyImage} file @param {LoadInfo} info
     * @param {number} out  where the resource's pointer goes
     * @param {any} thread
     * @returns {Promise<number>}
     */
    const make = async(api, device, file, info, out, thread)=>{
        const heap = /** @type {NonNullable<D3dx10Host['heap']>} */ (host.heap);
        const native = nativeOf(file);
        const volume = native ? native.dimension === DIMENSION.TEXTURE3D
            : Boolean(file.depth && file.depth > 1);
        const toWidth = given(info.width, file.width);
        const toHeight = given(info.height, file.height);
        const sized = volume ? -1 : levelSized(file, toWidth, toHeight);
        const resize = sized < 0 && (toWidth !== file.width || toHeight !== file.height);
        const codec = native ? nativeCodec(native.dxgi) : null;
        if (resize && (volume || (native && !codec)))
        {
            host.divergence?.(api, `answered E_FAIL: ${toWidth}x${toHeight} asked of a`
                + ` ${file.width}x${file.height} ${volume ? 'volume' : `file of DXGI format`
                + ` ${native?.dxgi}`}; this loader resizes neither`);
            return E_FAIL;
        }
        const image = sized > 0 ? fromLevel(file, sized) : !resize ? file
            : native && codec ? nativeResizedTo(native, toWidth, toHeight, codec)
                : resizedTo(file, toWidth, toHeight);
        const faces = volume
            ? (image.volume ?? []).map(slices=>slices)
            : (image.faces ?? [image.levels]);
        const sample = volume ? image.volume?.[0]?.[0] : faces[0]?.[0];
        if (!sample)
        {
            host.divergence?.(api, 'answered D3DX10_ERR_INVALID_DATA: a '
                + `${volume ? 'volume' : 'file'} of format ${image.format}, not read`);
            return D3DX10_ERR_INVALID_DATA;
        }
        const format = native ? native.dxgi : dxgiOf(sample.format);
        const asked = given(info.format, format);
        if (asked !== format && !(asked === DXGI.R8G8B8A8_UNORM && format === DXGI.B8G8R8A8_UNORM))
        {
            host.divergence?.(api, `answered E_FAIL: format ${asked} asked of a file held as`
                + ` ${format}; this loader converts none but BGRA to RGBA`);
            return E_FAIL;
        }
        const first = Math.min(given(info.firstMip, 0), Math.max(0, image.mipLevels - 1));
        const width = Math.max(1, image.width >> first);
        const height = Math.max(1, image.height >> first);
        const depth = volume ? Math.max(1, /** @type {number} */ (image.depth) >> first) : 1;
        const full = Math.floor(Math.log2(Math.max(width, height, depth))) + 1;
        // A file's blocks are not made again: a compressed file gives the levels
        // it holds. D3DX 10 makes the full chain for D3DX10_DEFAULT; texels are
        // halved for the levels a file lacks.
        const fromFile = Math.max(1, image.mipLevels - first);
        const asks = info.mips === D3DX10_DEFAULT || info.mips === 0 ? full
            : info.mips === D3DX10_FROM_FILE ? fromFile : Math.min(full, info.mips);
        // Texels held as a classic file has them are not halved; a file's own
        // DXGI levels are, by its format's codec, where there is one.
        const count = (native && !codec) || (!native && keptAsIs(sample.format)) || volume
            ? Math.min(asks, fromFile) : asks;
        if (native && count < asks)
        {
            host.divergence?.(api, `${asks - count} levels below the file's last of DXGI format`
                + ` ${format} are left out: this loader has no codec for it`);
        }
        if (codec?.nearest && (resize || count > fromFile) && !nearestSaid.has(format))
        {
            nearestSaid.add(format);
            host.divergence?.(api, `levels or a size made of a file of DXGI format ${format} take`
                + ' the nearest texel, not D3DX\'s filter');
        }
        /** @type {{ width: number, height: number, data: Uint8Array }[][]} */
        const chains = volume
            ? []
            : faces.map(levels=>levelsOf(levels.slice(first), count, codec?.smaller));
        /** @type {Uint8Array[]} */
        const subresources = [];
        /** @type {{ pitch: number, slice: number }[]} */
        const pitches = [];
        if (volume)
        {
            const levels = /** @type {import('../d3dx9/images.js').Level[][]} */ (image.volume)
                .slice(first, first + count);
            for (const slices of levels)
            {
                const { rowBytes, rows } = pitchOf(format, slices[0].width, slices[0].height);
                const bytes = new Uint8Array(rowBytes * rows * slices.length);
                slices.forEach((slice, z)=>bytes.set(slice.data.subarray(0, rowBytes * rows),
                    z * rowBytes * rows));
                subresources.push(bytes);
                pitches.push({ pitch: rowBytes, slice: rowBytes * rows });
            }
        }
        else
        {
            for (const chain of chains)
            {
                for (const level of chain)
                {
                    const { rowBytes, rows } = pitchOf(format, level.width, level.height);
                    let data = level.data;
                    if (asked !== format)
                    {
                        data = data.slice();
                        for (let i = 0; i < data.length; i += 4)
                        {
                            const blue = data[i];
                            data[i] = data[i + 2];
                            data[i + 2] = blue;
                        }
                    }
                    subresources.push(data);
                    pitches.push({ pitch: rowBytes, slice: rowBytes * rows });
                }
            }
        }
        const total = subresources.reduce((sum, bytes)=>sum + bytes.length, 0);
        const descBytes = 0x2c;
        const dataBytes = subresources.length * 12;
        const block = heap.allocate(descBytes + dataBytes + total);
        if (block === 0)
        {
            return E_OUTOFMEMORY;
        }
        try
        {
            const usage = given(info.usage, 0);
            const bind = given(info.bind, BIND_SHADER_RESOURCE);
            const cpu = given(info.cpu, 0);
            const cube = native ? native.cube : Boolean(image.faces);
            const misc = given(info.misc, 0) | (cube ? MISC_TEXTURECUBE : 0);
            const linear = native?.dimension === DIMENSION.TEXTURE1D;
            putU32s(block, volume
                ? [width, height, depth, count, asked, usage, bind, cpu, misc]
                : linear ? [width, count, faces.length, asked, usage, bind, cpu, misc]
                    : [width, height, count, faces.length, asked, 1, 0, usage, bind, cpu, misc]);
            let at = block + descBytes + dataBytes;
            /** @type {number[]} */
            const records = [];
            subresources.forEach((bytes, i)=>{
                host.writeMemory(at, bytes);
                records.push(at, pitches[i].pitch, pitches[i].slice);
                at += bytes.length;
            });
            putU32s(block + descBytes, records);
            return await method(thread, device,
                volume ? DEVICE.CreateTexture3D
                    : linear ? DEVICE.CreateTexture1D : DEVICE.CreateTexture2D,
                [block, block + descBytes, out]);
        }
        finally
        {
            heap.free(block);
        }
    };

    /**
     * A loader: the image from where the call says, the texture made of it,
     * and with `view`, a shader-resource view of the whole texture made in its
     * place, the texture's own reference given back.
     *
     * @param {string} api @param {boolean} view
     * @param {(args: number[]) => { device: number, found: () => Uint8Array | null
     *     | Promise<Uint8Array | null>, info: number, out: number, hr: number }} parse
     */
    const loader = (api, view, parse)=>(/** @type {number[]} */ args)=>{
        const { device, found, info, out, hr } = parse(args.map(a=>a >>> 0));
        if (out !== 0)
        {
            putU32s(out, [0]);
        }
        if (device === 0 || out === 0 || !host.callGuest || !host.heap)
        {
            return answer(hr, E_INVALIDARG);
        }
        const thread = host.currentThread?.();
        return (async()=>{
            const image = imageOf(api, await found());
            if (typeof image === 'number')
            {
                return answer(hr, image);
            }
            const heap = /** @type {NonNullable<D3dx10Host['heap']>} */ (host.heap);
            const held = view ? heap.allocate(4) : out;
            if (held === 0)
            {
                return answer(hr, E_OUTOFMEMORY);
            }
            try
            {
                let result = await make(api, device, image, loadInfoAt(info), held, thread);
                if (view && result === S_OK)
                {
                    const texture = u32(held);
                    result = await method(thread, device, DEVICE.CreateShaderResourceView,
                        [texture, 0, out]);
                    await method(thread, texture, UNKNOWN_RELEASE, []);
                }
                return answer(hr, result);
            }
            finally
            {
                if (view)
                {
                    heap.free(held);
                }
            }
        })();
    };

    /** @param {number} data @param {number} size */
    const fromMemory = (data, size)=>()=>(data === 0 || size === 0 ? null
        : host.readMemory(data, size).slice());
    /** @param {string} api @param {number} at @param {boolean} wide */
    const fromFile = (api, at, wide)=>async()=>{
        const path = string(at, wide, 260);
        const bytes = host.readFile ? await host.readFile(path) : null;
        if (!bytes)
        {
            host.divergence?.(api, `answered D3DX10_ERR_INVALID_DATA: no file ${path}`);
        }
        return bytes;
    };

    /**
     * D3DX10_IMAGE_INFO, as a file says it: Width, Height, Depth, ArraySize,
     * MipLevels, MiscFlags, Format, ResourceDimension, ImageFileFormat.
     *
     * @param {number} at @param {AnyImage} image
     */
    const writeInfo = (at, image)=>{
        const native = nativeOf(image);
        if (native)
        {
            putU32s(at, [native.width, native.height, native.depth ?? 1, native.arraySize,
                native.mipLevels, native.cube ? MISC_TEXTURECUBE : 0, native.dxgi,
                native.dimension, native.fileFormat]);
            return;
        }
        const volume = Boolean(image.depth && image.depth > 1);
        const sample = volume ? image.volume?.[0]?.[0] : image.levels[0];
        putU32s(at, [image.width, image.height, volume ? image.depth ?? 1 : 1,
            image.faces ? 6 : 1, image.mipLevels, image.faces ? MISC_TEXTURECUBE : 0,
            sample ? dxgiOf(sample.format) : dxgiOf(image.format),
            volume ? DIMENSION.TEXTURE3D : DIMENSION.TEXTURE2D, image.fileFormat]);
    };

    /**
     * Refused, saying why: what this build has no counterpart of.
     *
     * @param {string} api @param {number} argBytes @param {string} why
     * @param {number} [hrAt]  which argument is the HRESULT out-pointer
     */
    const refused = (api, argBytes, why, hrAt = -1)=>({
        argBytes,
        /** @param {number[]} args */
        handler: args=>{
            host.divergence?.(api, why);
            return hrAt >= 0 ? answer(args[hrAt], E_NOTIMPL) : E_NOTIMPL;
        },
    });

    /**
     * HRESULT D3DX10CompileFromMemory(LPCSTR pSrcData, SIZE_T SrcDataLen, LPCSTR pFileName,
     *     const D3D10_SHADER_MACRO*, LPD3D10INCLUDE, LPCSTR pFunctionName, LPCSTR pProfile,
     *     UINT Flags1, UINT Flags2, ID3DX10ThreadPump*, ID3D10Blob **ppShader,
     *     ID3D10Blob **ppErrorMsgs, HRESULT *pHResult)
     *
     * D3DCompile's work, as the library hands it to d3dcompiler_43: the source,
     * its name, defines, include handler, entry point, profile and flags, the
     * code and the messages. Asked of the D3DCompile this process finds, so the
     * compiler is whichever the process has. With none to ask, the program is
     * told the compile failed, with the reason in its error blob. A thread pump
     * is not used: the compile is done by the time the call returns, its answer
     * in pHResult as well.
     */
    const compile = async(/** @type {number[]} */ args)=>{
        const thread = host.currentThread?.();
        const [data, size, file, defines, include, entryAt, profileAt, flags1, flags2, ,
            shaderOut, errorsOut, hrAt] = args.map(a=>a >>> 0);
        const compiler = host.callGuest ? await host.compiler?.() ?? 0 : 0;
        if (compiler !== 0 && host.callGuest)
        {
            const hr = await host.callGuest({ entry: compiler,
                args: [data, size, file, defines, include, entryAt, profileAt, flags1, flags2,
                    shaderOut, errorsOut], ...(thread === undefined ? {} : { thread }) });
            return answer(hrAt, hr | 0);
        }
        const entry = entryAt === 0 ? '' : string(entryAt, false, 256);
        const profile = profileAt === 0 ? '' : string(profileAt, false, 32);
        const reason = 'error X0000: this build has no HLSL compiler for'
            + ` ${profile || 'this profile'} (${entry || 'no entry point'})`;
        host.divergence?.('D3DX10CompileFromMemory', `refused ${profile} ${entry}: no shader`
            + ' model 4 compiler');
        if (shaderOut !== 0)
        {
            putU32s(shaderOut, [0]);
        }
        if (errorsOut !== 0)
        {
            putU32s(errorsOut, [0]);
            giveBlob(errorsOut, Uint8Array.from([...reason, '\0'], c=>c.charCodeAt(0) & 0xff));
        }
        return answer(hrAt, E_FAIL);
    };

    return {
        /** BOOL D3DX10CheckVersion(UINT D3DSdkVersion, UINT D3DX10SdkVersion) */
        D3DX10CheckVersion: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([d3d, d3dx])=>((d3d >>> 0) === D3D10_SDK_VERSION && (d3dx >>> 0) === version
                ? 1 : 0),
        },
        /**
         * HRESULT D3DX10CreateTextureFromMemory(ID3D10Device*, LPCVOID pSrcData,
         *     SIZE_T SrcDataSize, D3DX10_IMAGE_LOAD_INFO*, ID3DX10ThreadPump*,
         *     ID3D10Resource **ppTexture, HRESULT *pHResult)
         */
        D3DX10CreateTextureFromMemory: {
            argBytes: 28,
            handler: loader('D3DX10CreateTextureFromMemory', false,
                ([device, data, size, info, , out, hr])=>({ device, found: fromMemory(data, size),
                    info, out, hr })),
        },
        /** The same, the image from a file: (device, file, info, pump, ppTexture, pHResult) */
        D3DX10CreateTextureFromFileA: {
            argBytes: 24,
            handler: loader('D3DX10CreateTextureFromFileA', false,
                ([device, file, info, , out, hr])=>({ device,
                    found: fromFile('D3DX10CreateTextureFromFileA', file, false), info, out, hr })),
        },
        D3DX10CreateTextureFromFileW: {
            argBytes: 24,
            handler: loader('D3DX10CreateTextureFromFileW', false,
                ([device, file, info, , out, hr])=>({ device,
                    found: fromFile('D3DX10CreateTextureFromFileW', file, true), info, out, hr })),
        },
        /** The loaders above, a shader-resource view of the texture handed out instead. */
        D3DX10CreateShaderResourceViewFromMemory: {
            argBytes: 28,
            handler: loader('D3DX10CreateShaderResourceViewFromMemory', true,
                ([device, data, size, info, , out, hr])=>({ device, found: fromMemory(data, size),
                    info, out, hr })),
        },
        D3DX10CreateShaderResourceViewFromFileA: {
            argBytes: 24,
            handler: loader('D3DX10CreateShaderResourceViewFromFileA', true,
                ([device, file, info, , out, hr])=>({ device,
                    found: fromFile('D3DX10CreateShaderResourceViewFromFileA', file, false), info,
                    out, hr })),
        },
        D3DX10CreateShaderResourceViewFromFileW: {
            argBytes: 24,
            handler: loader('D3DX10CreateShaderResourceViewFromFileW', true,
                ([device, file, info, , out, hr])=>({ device,
                    found: fromFile('D3DX10CreateShaderResourceViewFromFileW', file, true), info,
                    out, hr })),
        },
        /**
         * HRESULT D3DX10GetImageInfoFromMemory(LPCVOID pSrcData, SIZE_T SrcDataSize,
         *     ID3DX10ThreadPump*, D3DX10_IMAGE_INFO*, HRESULT *pHResult)
         */
        D3DX10GetImageInfoFromMemory: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([data, size, , infoAt, hr])=>{
                const image = imageOf('D3DX10GetImageInfoFromMemory',
                    fromMemory(data >>> 0, size >>> 0)());
                if (typeof image === 'number')
                {
                    return answer(hr, image);
                }
                if ((infoAt >>> 0) === 0)
                {
                    return answer(hr, E_INVALIDARG);
                }
                writeInfo(infoAt >>> 0, image);
                return answer(hr, S_OK);
            },
        },
        D3DX10CompileFromMemory: { argBytes: 52, handler: compile },
        /**
         * HRESULT D3DX10UnsetAllDeviceObjects(ID3D10Device *pDevice)
         *
         * Every object bound to the device unbound, through the device's own
         * methods (ID3D10Device's slots): each stage's constant buffers,
         * resources, samplers and shader, the input assembler's buffers and
         * layout, the stream-output targets, the render targets and the
         * output and rasterizer states.
         */
        D3DX10UnsetAllDeviceObjects: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([device])=>{
                if ((device >>> 0) === 0 || !host.callGuest || !host.heap)
                {
                    return E_INVALIDARG;
                }
                const thread = host.currentThread?.();
                const nulls = host.heap.allocate(RESOURCE_SLOTS * 4);
                if (nulls === 0)
                {
                    return E_OUTOFMEMORY;
                }
                host.writeMemory(nulls, new Uint8Array(RESOURCE_SLOTS * 4));
                /** @param {number} slot @param {number[]} rest */
                const call = (slot, ...rest)=>method(thread, device, slot, rest);
                try
                {
                    for (const [buffers, views, samplers, shader] of STAGE_SLOTS)
                    {
                        await call(buffers, 0, CONSTANT_BUFFER_SLOTS, nulls);
                        await call(views, 0, RESOURCE_SLOTS, nulls);
                        await call(samplers, 0, SAMPLER_SLOTS, nulls);
                        await call(shader, 0);
                    }
                    await call(DEVICE.IASetVertexBuffers, 0, VERTEX_BUFFER_SLOTS, nulls, nulls,
                        nulls);
                    await call(DEVICE.IASetIndexBuffer, 0, 0, 0);
                    await call(DEVICE.IASetInputLayout, 0);
                    await call(DEVICE.SOSetTargets, STREAM_OUTPUT_SLOTS, nulls, nulls);
                    await call(DEVICE.OMSetRenderTargets, RENDER_TARGET_SLOTS, nulls, 0);
                    // A blend factor of zeros, the mask every sample.
                    await call(DEVICE.OMSetBlendState, 0, nulls, 0xffffffff);
                    await call(DEVICE.OMSetDepthStencilState, 0, 0);
                    await call(DEVICE.RSSetState, 0);
                    return S_OK;
                }
                finally
                {
                    host.heap.free(nulls);
                }
            },
        },
        /**
         * HRESULT D3DX10FilterTexture(ID3D10Resource *pTexture, UINT SrcLevel, UINT MipFilter)
         *
         * The levels below SrcLevel remade from it. The texture's levels are as
         * the loader made them - a loaded file comes with its chain - so they
         * are left as they are, and said.
         */
        D3DX10FilterTexture: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([texture])=>{
                if ((texture >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                host.divergence?.('D3DX10FilterTexture',
                    'the texture\'s levels are kept as loaded, not filtered again');
                return S_OK;
            },
        },
        /**
         * HRESULT D3DX10SaveTextureToFileA(ID3D10Resource*, D3DX10_IMAGE_FILE_FORMAT, LPCSTR):
         * refused; the texture's bytes are the GPU's and no read-back is made for it.
         */
        D3DX10SaveTextureToFileA: refused('D3DX10SaveTextureToFileA', 12,
            'refused: saving a Direct3D 10 texture to a file is not implemented'),
        D3DX10SaveTextureToFileW: refused('D3DX10SaveTextureToFileW', 12,
            'refused: saving a Direct3D 10 texture to a file is not implemented'),
    };
}
