/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { D3D9_CHECK_DEVICE_FORMAT, DEVICE, TEXTURE, UNKNOWN_RELEASE, VOLUME_TEXTURE,
    createDeviceCalls } from './device.js';
import { D3DX_DEFAULT } from './texture.js';
import { FMT, decodeTexels, encodeTexels, halve, isCompressed, isSupported, layoutOf, resample }
    from './pixels.js';
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
 * A8R8G8B8; any other is kept where the device's CheckDeviceFormat takes it
 * for that usage and resource, else the nearest one it does take
 * (`formatCandidates`): R8G8B8 on a card without 24-bit textures is
 * X8R8G8B8. A usage only a buffer has is refused, as is a format with no
 * near one the device takes (D3DERR_NOTAVAILABLE). The cube and volume
 * checks are the same, against the cube and volume caps.
 *
 * D3DXFillTexture asks the program's own function for every texel of every
 * level, at the texel's centre, and writes what it answers in the level's
 * format: the formats the loaders write (pixels.js), through eight bits a
 * channel, and the floating-point ones, from the floats as they are.
 *
 * D3DXFilterTexture makes each level below the one it is given from the level
 * above it -- each face's, for a cube texture -- through the levels' locks, in
 * the formats pixels.js reads and writes: a box filter (pixels.js's `halve`)
 * for D3DX_DEFAULT and the box, linear and triangle filters, which at a ratio
 * of two take the same two by two texels, and a texel picked for NONE and
 * POINT.
 */

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const E_OUTOFMEMORY = 0x8007000e;

const D3DPTEXTURECAPS_POW2 = 0x2;
const D3DPTEXTURECAPS_SQUAREONLY = 0x20;
const D3DPTEXTURECAPS_NONPOW2CONDITIONAL = 0x100;
const D3DPTEXTURECAPS_CUBEMAP_POW2 = 0x20000;
const D3DPTEXTURECAPS_VOLUMEMAP_POW2 = 0x40000;
/** D3DVOLUME_DESC's size, and its Width, Height and Depth. */
const D3DVOLUME_DESC_BYTES = 28;
const D3DUSAGE_AUTOGENMIPMAP = 0x400;
const D3DSURFACE_DESC_BYTES = 32;
const E_NOTIMPL = 0x80004001;
const D3DLOCK_READONLY = 0x10;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_VOLUMETEXTURE = 4;
const D3DRTYPE_CUBETEXTURE = 5;
/** D3DX_FILTER_NONE to D3DX_FILTER_BOX: the low byte of a filter; the rest are flags. */
const D3DX_FILTER_NONE = 1;
const D3DX_FILTER_POINT = 2;
const D3DX_FILTER_BOX = 5;
const D3DERR_NOTAVAILABLE = 0x8876086a;
/** D3DUSAGE_WRITEONLY, DONOTCLIP, POINTS, RTPATCHES and NPATCHES: a buffer's, never a texture's. */
const BUFFER_USAGES = 0x8 | 0x20 | 0x40 | 0x80 | 0x100;
/** D3DDEVICE_CREATION_PARAMETERS and D3DDISPLAYMODE, and where the mode's Format is. */
const CREATION_PARAMETERS_BYTES = 16;
const DISPLAY_MODE_BYTES = 16;
const DISPLAY_MODE_FORMAT = 12;

/**
 * What a format holds, as the nearest-format choice weighs it: bits of alpha,
 * red, green and blue (luminance counted as red, and U, V, W, Q as red,
 * green, blue, alpha), bytes a texel, and its kind. A signed format stands in
 * only for a signed one; the rest stand in for each other. In the order a tie
 * is settled in: the common layout first, the premultiplied blocks last.
 *
 * @type {Map<number, { bits: number[], bytes: number, kind: string }>}
 */
const FORMAT_BITS = new Map(/** @type {[number, number[], number, string][]} */ ([
    [21, [8, 8, 8, 8], 4, 'rgb'], [22, [0, 8, 8, 8], 4, 'rgb'], [20, [0, 8, 8, 8], 3, 'rgb'],
    [23, [0, 5, 6, 5], 2, 'rgb'], [24, [0, 5, 5, 5], 2, 'rgb'], [25, [1, 5, 5, 5], 2, 'rgb'],
    [26, [4, 4, 4, 4], 2, 'rgb'], [30, [0, 4, 4, 4], 2, 'rgb'], [27, [0, 3, 3, 2], 1, 'rgb'],
    [29, [8, 3, 3, 2], 2, 'rgb'], [28, [8, 0, 0, 0], 1, 'rgb'], [32, [8, 8, 8, 8], 4, 'rgb'],
    [33, [0, 8, 8, 8], 4, 'rgb'], [35, [2, 10, 10, 10], 4, 'rgb'],
    [31, [2, 10, 10, 10], 4, 'rgb'], [34, [0, 16, 16, 0], 4, 'rgb'],
    [36, [16, 16, 16, 16], 8, 'rgb'],
    [50, [0, 8, 0, 0], 1, 'luminance'], [81, [0, 16, 0, 0], 2, 'luminance'],
    [51, [8, 8, 0, 0], 2, 'luminance'], [52, [4, 4, 0, 0], 1, 'luminance'],
    [41, [8, 8, 8, 8], 1, 'palette'], [40, [8, 8, 8, 8], 2, 'palette'],
    [FMT.DXT1, [1, 5, 6, 5], 0, 'blocks'], [FMT.DXT3, [4, 5, 6, 5], 0, 'blocks'],
    [FMT.DXT5, [8, 5, 6, 5], 0, 'blocks'], [FMT.DXT2, [4, 5, 6, 5], 0, 'blocks'],
    [FMT.DXT4, [8, 5, 6, 5], 0, 'blocks'],
    [111, [0, 16, 0, 0], 2, 'float'], [112, [0, 16, 16, 0], 4, 'float'],
    [113, [16, 16, 16, 16], 8, 'float'], [114, [0, 32, 0, 0], 4, 'float'],
    [115, [0, 32, 32, 0], 8, 'float'], [116, [32, 32, 32, 32], 16, 'float'],
    [60, [0, 8, 8, 0], 2, 'signed'], [64, [0, 16, 16, 0], 4, 'signed'],
    [63, [8, 8, 8, 8], 4, 'signed'],
]).map(([format, bits, bytes, kind])=>[format, { bits, bytes, kind }]));

/**
 * The formats to try for one asked, nearest first: the format itself, then
 * every other of `FORMAT_BITS` that can stand in for it, ranked by the bits
 * of a channel it would lose, then whether it is of the same kind, then the
 * channels it adds, then the bits it adds. A three-byte format stands in
 * only for another. A format not in the table is tried alone.
 *
 * @param {number} format
 * @returns {number[]}
 */
export function formatCandidates(format){
    const asked = FORMAT_BITS.get(format);
    if (!asked)
    {
        return [format];
    }
    const ranked = [...FORMAT_BITS].filter(([other, { bytes, kind }])=>other !== format
        && (kind === 'signed') === (asked.kind === 'signed')
        && (bytes !== 3 || asked.bytes === 3))
        .map(([other, { bits, kind }])=>{
            let lost = 0;
            let added = 0;
            let channels = 0;
            bits.forEach((count, at)=>{
                const more = count - asked.bits[at];
                lost += Math.max(0, -more);
                added += Math.max(0, more);
                channels += count > 0 && asked.bits[at] === 0 ? 1 : 0;
            });
            return { other, key: [lost, kind === asked.kind ? 0 : 1, channels, added] };
        });
    // Stable: a tie keeps the table's order.
    ranked.sort((a, b)=>{
        const at = a.key.findIndex((v, i)=>v !== b.key[i]);
        return at < 0 ? 0 : a.key[at] - b.key[at];
    });
    return [format, ...ranked.map(({ other })=>other)];
}

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
const CAPS_MAX_VOLUME_EXTENT = 96;
/** And where its shader versions are. */
const CAPS_VERTEX_SHADER_VERSION = 196;
const CAPS_PIXEL_SHADER_VERSION = 204;

/**
 * The profile a shader version names, as D3DXGet*ShaderProfile answer: the
 * highest one the device runs, or null for none.
 * ponytail: 2.x is "_2_0" whatever its extended caps; the 2_a and 2_b
 * profiles a 2.x card's extra caps would earn are not told apart.
 *
 * @param {'vs' | 'ps'} kind @param {number} version  D3DVS_VERSION / D3DPS_VERSION
 * @returns {string | null}
 */
export function shaderProfile(kind, version){
    const major = version >>> 8 & 0xff;
    const minor = version & 0xff;
    const known = kind === 'vs'
        ? ['1_1', '2_0', '3_0']
        : ['1_1', '1_2', '1_3', '1_4', '2_0', '3_0'];
    const name = major === 2 ? '2_0' : `${major}_${minor}`;
    return known.includes(name) ? `${kind}_${name}` : null;
}

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
     * @returns {Promise<{ textureCaps: number, maxWidth: number, maxHeight: number,
     *     maxVolume: number, vertexShader: number, pixelShader: number } | number>}
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
                maxHeight: u32(at + CAPS_MAX_HEIGHT), maxVolume: u32(at + CAPS_MAX_VOLUME_EXTENT),
                vertexShader: u32(at + CAPS_VERTEX_SHADER_VERSION),
                pixelShader: u32(at + CAPS_PIXEL_SHADER_VERSION) };
        }
        finally
        {
            heap.free(at);
        }
    };

    /**
     * The format asked, or the nearest one the device's CheckDeviceFormat
     * takes for this usage and resource (`formatCandidates`), asked on the
     * adapter, device type and display format the device was made with.
     *
     * @param {number} device @param {number} format  D3DFMT_UNKNOWN and D3DX_DEFAULT
     *     are A8R8G8B8 @param {number} usage @param {number} type  D3DRESOURCETYPE
     * @param {any} thread
     * @returns {Promise<{ format: number } | number>} the format, or the failure
     */
    const supportedFormat = async(device, format, usage, type, thread)=>{
        const heap = /** @type {NonNullable<TextureToolsHost['heap']>} */ (host.heap);
        const at = heap.allocate(4 + CREATION_PARAMETERS_BYTES + DISPLAY_MODE_BYTES);
        if (at === 0)
        {
            return E_OUTOFMEMORY;
        }
        const parameters = at + 4;
        const mode = parameters + CREATION_PARAMETERS_BYTES;
        try
        {
            putU32s(at, [0]);
            const found = await method(thread, device, DEVICE.GetDirect3D, [at]);
            if (found !== D3D_OK)
            {
                return found;
            }
            const d3d = u32(at);
            try
            {
                for (const answer of [
                    await method(thread, device, DEVICE.GetCreationParameters, [parameters]),
                    await method(thread, device, DEVICE.GetDisplayMode, [0, mode])])
                {
                    if (answer !== D3D_OK)
                    {
                        return answer;
                    }
                }
                const wanted = format === FMT.UNKNOWN || format === D3DX_DEFAULT
                    ? FMT.A8R8G8B8 : format;
                for (const candidate of formatCandidates(wanted))
                {
                    const answer = await method(thread, d3d, D3D9_CHECK_DEVICE_FORMAT,
                        [u32(parameters), u32(parameters + 4), u32(mode + DISPLAY_MODE_FORMAT),
                            usage, type, candidate]);
                    // D3DOK_NOAUTOGEN is a success too.
                    if ((answer & 0x80000000) === 0)
                    {
                        return { format: candidate };
                    }
                }
                return D3DERR_NOTAVAILABLE;
            }
            finally
            {
                await method(thread, d3d, UNKNOWN_RELEASE, []);
            }
        }
        finally
        {
            heap.free(at);
        }
    };

    /**
     * The device's caps and the format it takes, once the handler has
     * returned; or the failure.
     *
     * @param {number} device @param {number} usage @param {number} format
     * @param {number} type @param {any} thread
     */
    const capsAndFormat = async(device, usage, format, type, thread)=>{
        await null;
        if (usage !== D3DX_DEFAULT && (usage & BUFFER_USAGES) !== 0)
        {
            return D3DERR_INVALIDCALL;
        }
        const caps = await capsOf(device, thread);
        if (typeof caps === 'number')
        {
            return caps;
        }
        const taken = await supportedFormat(device, format,
            usage === D3DX_DEFAULT ? 0 : usage, type, thread);
        return typeof taken === 'number' ? taken : { caps, format: taken.format };
    };

    /**
     * The corrections for what a device can do, once the handler has returned.
     *
     * @param {number} device @param {Parameters<typeof textureRequirements>[0]} asked
     * @param {any} thread
     * @returns {Promise<Requirements | number>}
     */
    const requirements = async(device, asked, thread)=>{
        const found = await capsAndFormat(device, asked.usage, asked.format, D3DRTYPE_TEXTURE,
            thread);
        return typeof found === 'number' ? found
            : textureRequirements({ ...asked, format: found.format }, found.caps);
    };

    /**
     * A cube's corrections: a square of the size asked, a power of two
     * where the device's cube maps need one.
     *
     * @param {number} device @param {number} size @param {number} levels @param {number} usage
     * @param {number} format @param {any} thread
     * @returns {Promise<Requirements | number>}
     */
    const cubeRequirements = async(device, size, levels, usage, format, thread)=>{
        const found = await capsAndFormat(device, usage, format, D3DRTYPE_CUBETEXTURE, thread);
        if (typeof found === 'number')
        {
            return found;
        }
        const { caps } = found;
        const pow2 = (caps.textureCaps & D3DPTEXTURECAPS_CUBEMAP_POW2) !== 0;
        const square = { width: size, height: size, levels, usage, format: found.format };
        return textureRequirements(square, { textureCaps: pow2 ? D3DPTEXTURECAPS_POW2 : 0,
            maxWidth: caps.maxWidth, maxHeight: caps.maxHeight });
    };

    /**
     * A volume's: its width and height as a texture's under the volume caps,
     * its depth 1 for 0 or D3DX_DEFAULT, each a power of two where the device
     * needs one, none past the largest extent, and the full chain the longest
     * side gives.
     *
     * @param {number} device @param {{ width: number, height: number, depth: number,
     *     levels: number, usage: number, format: number }} asked @param {any} thread
     * @returns {Promise<(Requirements & { depth: number }) | number>}
     */
    const volumeRequirements = async(device, asked, thread)=>{
        const found = await capsAndFormat(device, asked.usage, asked.format,
            D3DRTYPE_VOLUMETEXTURE, thread);
        if (typeof found === 'number')
        {
            return found;
        }
        const { caps } = found;
        const pow2 = (caps.textureCaps & D3DPTEXTURECAPS_VOLUMEMAP_POW2) !== 0;
        const flat = textureRequirements({ ...asked, format: found.format, levels: 1 },
            { textureCaps: pow2 ? D3DPTEXTURECAPS_POW2 : 0, maxWidth: caps.maxVolume,
                maxHeight: caps.maxVolume });
        let depth = asked.depth === 0 || asked.depth === D3DX_DEFAULT ? 1 : asked.depth;
        depth = Math.min(pow2 ? nextPowerOfTwo(depth) : depth, caps.maxVolume || depth);
        const chain = Math.floor(Math.log2(Math.max(flat.width, flat.height, depth))) + 1;
        const levels = asked.levels === 0 || asked.levels === D3DX_DEFAULT ? chain
            : Math.min(asked.levels, chain);
        return { ...flat, depth, levels };
    };

    /**
     * D3DXFillVolumeTexture's work, once its handler has returned: as
     * `fillTexture`, a slice at a time.
     *
     * @param {number} texture @param {number} fill @param {number} data @param {any} thread
     * @returns {Promise<number>}
     */
    const fillVolume = async(texture, fill, data, thread)=>{
        await null;
        const heap = /** @type {NonNullable<TextureToolsHost['heap']>} */ (host.heap);
        const callGuest = /** @type {NonNullable<TextureToolsHost['callGuest']>} */ (
            host.callGuest);
        // The level's description, its locked box, then the out vector, the
        // texel's centre and the texel's size the function is handed.
        const scratch = heap.allocate(D3DVOLUME_DESC_BYTES + 12 + 16 + 24);
        if (scratch === 0)
        {
            return E_OUTOFMEMORY;
        }
        const locked = scratch + D3DVOLUME_DESC_BYTES;
        const out = locked + 12;
        const coord = out + 16;
        const size = coord + 12;
        try
        {
            const levels = await method(thread, texture, VOLUME_TEXTURE.GetLevelCount, []);
            for (let level = 0; level < levels; level++)
            {
                const described = await method(thread, texture, VOLUME_TEXTURE.GetLevelDesc,
                    [level, scratch]);
                if (described !== D3D_OK)
                {
                    return described;
                }
                const format = u32(scratch);
                const width = u32(scratch + 16);
                const height = u32(scratch + 20);
                const depth = u32(scratch + 24);
                if (!FLOATS.has(format) && !isSupported(format))
                {
                    host.divergence?.('D3DXFillVolumeTexture', `format ${format} is not one a `
                        + 'fill writes: answered D3DERR_INVALIDCALL');
                    return D3DERR_INVALIDCALL;
                }
                host.writeMemory(size, new Uint8Array(Float32Array.of(1 / width, 1 / height,
                    1 / depth).buffer));
                const answer = await method(thread, texture, VOLUME_TEXTURE.LockBox,
                    [level, locked, 0, 0]);
                if (answer !== D3D_OK)
                {
                    return answer;
                }
                const rowPitch = u32(locked);
                const slicePitch = u32(locked + 4);
                const bits = u32(locked + 8);
                for (let z = 0; z < depth; z++)
                {
                    const rgba = new Float32Array(width * height * 4);
                    for (let y = 0; y < height; y++)
                    {
                        for (let x = 0; x < width; x++)
                        {
                            host.writeMemory(out, new Uint8Array(16));
                            host.writeMemory(coord, new Uint8Array(Float32Array.of(
                                (x + 0.5) / width, (y + 0.5) / height, (z + 0.5) / depth).buffer));
                            await callGuest({ entry: fill >>> 0, args: [out, coord, size,
                                data >>> 0], ...(thread === undefined ? {} : { thread }) });
                            rgba.set(new Float32Array(host.readMemory(out, 16).slice().buffer),
                                (y * width + x) * 4);
                        }
                    }
                    const packed = /** @type {Uint8Array} */ (packFilled(format, rgba, width,
                        height));
                    const rows = FLOATS.has(format) ? height : layoutOf(format, width, height).rows;
                    const rowBytes = packed.length / rows;
                    for (let row = 0; row < rows; row++)
                    {
                        host.writeMemory(bits + z * slicePitch + row * rowPitch,
                            packed.subarray(row * rowBytes, (row + 1) * rowBytes));
                    }
                }
                await method(thread, texture, VOLUME_TEXTURE.UnlockBox, [level]);
            }
            return D3D_OK;
        }
        finally
        {
            heap.free(scratch);
        }
    };

    /** @param {number} at  A UINT in-out pointer: D3DX_DEFAULT when null. */
    const given = at=>((at >>> 0) === 0 ? D3DX_DEFAULT : u32(at));

    /**
     * A check's answer: the corrections written through the pointers that
     * are not null, or the failure.
     *
     * @param {Record<string, number> | number} found
     * @param {[number, string][]} pointers  each pointer and the field it takes
     */
    const answered = (found, pointers)=>{
        if (typeof found === 'number')
        {
            return found;
        }
        for (const [at, field] of pointers)
        {
            if ((at >>> 0) !== 0)
            {
                putU32s(at, [found[field]]);
            }
        }
        return D3D_OK;
    };

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

    /**
     * D3DXFilterTexture's work, once its handler has returned.
     *
     * @param {number} texture @param {number} source @param {number} filter @param {any} thread
     * @returns {Promise<number>}
     */
    const filterTexture = async(texture, source, filter, thread)=>{
        await null;
        const api = 'D3DXFilterTexture';
        const type = await method(thread, texture, TEXTURE.GetType, []);
        if (type === D3DRTYPE_VOLUMETEXTURE)
        {
            host.divergence?.(api, 'a volume texture is not filtered: answered E_NOTIMPL');
            return E_NOTIMPL;
        }
        if (type !== D3DRTYPE_TEXTURE && type !== D3DRTYPE_CUBETEXTURE)
        {
            return D3DERR_INVALIDCALL;
        }
        const levels = await method(thread, texture, TEXTURE.GetLevelCount, []);
        const top = source === D3DX_DEFAULT ? 0 : source;
        if (top >= levels)
        {
            return D3DERR_INVALIDCALL;
        }
        const heap = /** @type {NonNullable<TextureToolsHost['heap']>} */ (host.heap);
        const scratch = heap.allocate(D3DSURFACE_DESC_BYTES + 8);
        if (scratch === 0)
        {
            return E_OUTOFMEMORY;
        }
        const locked = scratch + D3DSURFACE_DESC_BYTES;
        const picked = filter !== D3DX_DEFAULT && (filter & 0xff) <= D3DX_FILTER_POINT;
        try
        {
            /** @type {{ format: number, width: number, height: number }[]} */
            const described = [];
            for (let level = top; level < levels; level++)
            {
                const answer = await method(thread, texture, TEXTURE.GetLevelDesc,
                    [level, scratch]);
                if (answer !== D3D_OK)
                {
                    return answer;
                }
                described[level] = { format: u32(scratch), width: u32(scratch + 24),
                    height: u32(scratch + 28) };
            }
            const { format } = described[top];
            if (!isSupported(format))
            {
                host.divergence?.(api, `format ${format} is not one a filter reads: answered `
                    + 'E_NOTIMPL');
                return E_NOTIMPL;
            }
            for (let face = 0; face < (type === D3DRTYPE_CUBETEXTURE ? 6 : 1); face++)
            {
                // A cube texture's LockRect and UnlockRect name the face first.
                const which = type === D3DRTYPE_CUBETEXTURE ? [face] : [];
                /** The level read is locked only to read. @param {number} level */
                const lock = level=>method(thread, texture, TEXTURE.LockRect,
                    [...which, level, locked, 0, level === top ? D3DLOCK_READONLY : 0]);
                /** @type {Uint8Array | null} */
                let bgra = null;
                for (let level = top; level < levels; level++)
                {
                    const { width, height } = described[level];
                    const { rowBytes, rows } = layoutOf(format, width, height);
                    const answer = await lock(level);
                    if (answer !== D3D_OK)
                    {
                        return answer;
                    }
                    const pitch = u32(locked);
                    const bits = u32(locked + 4);
                    if (bgra === null)
                    {
                        const packed = new Uint8Array(rowBytes * rows);
                        for (let row = 0; row < rows; row++)
                        {
                            packed.set(host.readMemory(bits + row * pitch, rowBytes),
                                row * rowBytes);
                        }
                        bgra = decodeTexels(format, packed, width, height);
                    }
                    else
                    {
                        const above = described[level - 1];
                        bgra = picked ? resample(bgra, above.width, above.height, width, height)
                            : halve(bgra, above.width, above.height).bgra;
                        const bytes = encodeTexels(format, bgra, width, height);
                        for (let row = 0; row < rows; row++)
                        {
                            host.writeMemory(bits + row * pitch,
                                bytes.subarray(row * rowBytes, (row + 1) * rowBytes));
                        }
                    }
                    await method(thread, texture, TEXTURE.UnlockRect, [...which, level]);
                }
            }
            return D3D_OK;
        }
        finally
        {
            heap.free(scratch);
        }
    };

    /**
     * Each profile name, written once into guest memory: what the profile
     * functions hand back is a constant string the program keeps.
     *
     * @type {Map<string, number>}
     */
    const profileNames = new Map();
    /** @param {string} name */
    const profileName = name=>{
        let at = profileNames.get(name) ?? 0;
        if (at === 0)
        {
            at = host.heap?.allocate(name.length + 1) ?? 0;
            if (at !== 0)
            {
                host.writeMemory(at, Uint8Array.from([...name, '\0'], c=>c.charCodeAt(0)));
                profileNames.set(name, at);
            }
        }
        return at;
    };

    /**
     * LPCSTR D3DXGetVertexShaderProfile / D3DXGetPixelShaderProfile(LPDIRECT3DDEVICE9)
     *
     * The highest profile of that kind the device's caps say it runs, or NULL
     * for a NULL device or none.
     *
     * @param {'vs' | 'ps'} kind
     */
    const profileOf = kind=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([device])=>{
            if ((device >>> 0) === 0 || !host.callGuest || !host.heap)
            {
                return 0;
            }
            const thread = host.currentThread?.();
            return (async()=>{
                // Into the guest only once the handler has returned.
                await null;
                const caps = await capsOf(device >>> 0, thread);
                if (typeof caps === 'number')
                {
                    return 0;
                }
                const name = shaderProfile(kind,
                    kind === 'vs' ? caps.vertexShader : caps.pixelShader);
                return name === null ? 0 : profileName(name);
            })();
        },
    });

    return {
        D3DXGetVertexShaderProfile: profileOf('vs'),
        D3DXGetPixelShaderProfile: profileOf('ps'),

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
                return requirements(device >>> 0, asked, host.currentThread?.()).then(found=>
                    answered(found, [[widthAt, 'width'], [heightAt, 'height'],
                        [levelsAt, 'levels'], [formatAt, 'format']]));
            },
        },

        /**
         * HRESULT D3DXCheckCubeTextureRequirements(LPDIRECT3DDEVICE9 pDevice, UINT *pSize,
         *     UINT *pNumMipLevels, DWORD Usage, D3DFORMAT *pFormat, D3DPOOL Pool)
         */
        D3DXCheckCubeTextureRequirements: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([device, sizeAt, levelsAt, usage, formatAt])=>{
                if ((device >>> 0) === 0 || !host.callGuest || !host.heap)
                {
                    return D3DERR_INVALIDCALL;
                }
                return cubeRequirements(device >>> 0, given(sizeAt), given(levelsAt),
                    usage >>> 0, given(formatAt), host.currentThread?.()).then(found=>
                    answered(found, [[sizeAt, 'width'], [levelsAt, 'levels'],
                        [formatAt, 'format']]));
            },
        },

        /**
         * HRESULT D3DXCheckVolumeTextureRequirements(LPDIRECT3DDEVICE9 pDevice, UINT *pWidth,
         *     UINT *pHeight, UINT *pDepth, UINT *pNumMipLevels, DWORD Usage,
         *     D3DFORMAT *pFormat, D3DPOOL Pool)
         */
        D3DXCheckVolumeTextureRequirements: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([device, widthAt, heightAt, depthAt, levelsAt, usage, formatAt])=>{
                if ((device >>> 0) === 0 || !host.callGuest || !host.heap)
                {
                    return D3DERR_INVALIDCALL;
                }
                return volumeRequirements(device >>> 0, { width: given(widthAt),
                    height: given(heightAt), depth: given(depthAt), levels: given(levelsAt),
                    usage: usage >>> 0, format: given(formatAt) }, host.currentThread?.())
                    .then(found=>answered(found, [[widthAt, 'width'], [heightAt, 'height'],
                        [depthAt, 'depth'], [levelsAt, 'levels'], [formatAt, 'format']]));
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
         * HRESULT D3DXCreateCubeTexture(LPDIRECT3DDEVICE9 pDevice, UINT Size,
         *     UINT MipLevels, DWORD Usage, D3DFORMAT Format, D3DPOOL Pool,
         *     LPDIRECT3DCUBETEXTURE9 *ppCubeTexture)
         *
         * The cube's requirements made with the device's CreateCubeTexture.
         */
        D3DXCreateCubeTexture: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([device, size, levels, usage, format, pool, out])=>{
                if ((out >>> 0) !== 0)
                {
                    putU32s(out, [0]);
                }
                if ((device >>> 0) === 0 || (out >>> 0) === 0 || !host.callGuest || !host.heap)
                {
                    return D3DERR_INVALIDCALL;
                }
                const thread = host.currentThread?.();
                return cubeRequirements(device >>> 0, size >>> 0, levels >>> 0, usage >>> 0,
                    format >>> 0, thread).then(found=>(typeof found === 'number' ? found
                    : method(thread, device, DEVICE.CreateCubeTexture, [found.width,
                        found.levels, found.usage, found.format, pool >>> 0, out >>> 0, 0])));
            },
        },

        /**
         * HRESULT D3DXCreateVolumeTexture(LPDIRECT3DDEVICE9 pDevice, UINT Width,
         *     UINT Height, UINT Depth, UINT MipLevels, DWORD Usage, D3DFORMAT Format,
         *     D3DPOOL Pool, LPDIRECT3DVOLUMETEXTURE9 *ppVolumeTexture)
         *
         * The volume's requirements made with the device's CreateVolumeTexture.
         */
        D3DXCreateVolumeTexture: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([device, width, height, depth, levels, usage, format, pool, out])=>{
                if ((out >>> 0) !== 0)
                {
                    putU32s(out, [0]);
                }
                if ((device >>> 0) === 0 || (out >>> 0) === 0 || !host.callGuest || !host.heap)
                {
                    return D3DERR_INVALIDCALL;
                }
                const thread = host.currentThread?.();
                return volumeRequirements(device >>> 0, { width: width >>> 0,
                    height: height >>> 0, depth: depth >>> 0, levels: levels >>> 0,
                    usage: usage >>> 0, format: format >>> 0 }, thread)
                    .then(found=>(typeof found === 'number' ? found
                        : method(thread, device, DEVICE.CreateVolumeTexture, [found.width,
                            found.height, found.depth, found.levels, found.usage, found.format,
                            pool >>> 0, out >>> 0, 0])));
            },
        },

        /**
         * HRESULT D3DXFillVolumeTexture(LPDIRECT3DVOLUMETEXTURE9 pTexture,
         *     LPD3DXFILL3D pFunction, LPVOID pData)
         *
         * The function is VOID WINAPI (D3DXVECTOR4 *pOut, const D3DXVECTOR3 *pTexCoord,
         * const D3DXVECTOR3 *pTexelSize, LPVOID pData), called once a texel,
         * the levels in order, each slice by slice and row by row.
         */
        D3DXFillVolumeTexture: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([texture, fill, data])=>{
                if ((texture >>> 0) === 0 || (fill >>> 0) === 0 || !host.callGuest
                    || !host.heap)
                {
                    return D3DERR_INVALIDCALL;
                }
                return fillVolume(texture >>> 0, fill >>> 0, data, host.currentThread?.());
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

        /**
         * HRESULT D3DXFilterTexture(LPDIRECT3DBASETEXTURE9 pBaseTexture,
         *     const PALETTEENTRY *pPalette, UINT SrcLevel, DWORD MipFilter)
         *
         * SrcLevel D3DX_DEFAULT is the first level; a level the texture does
         * not have, or a filter that is none of D3DX_DEFAULT and NONE to BOX,
         * is refused.
         */
        D3DXFilterTexture: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([texture, , source, filter])=>{
                const kind = filter & 0xff;
                if ((texture >>> 0) === 0 || !host.callGuest || !host.heap
                    || ((filter >>> 0) !== D3DX_DEFAULT
                        && (kind < D3DX_FILTER_NONE || kind > D3DX_FILTER_BOX)))
                {
                    return D3DERR_INVALIDCALL;
                }
                return filterTexture(texture >>> 0, source >>> 0, filter >>> 0,
                    host.currentThread?.());
            },
        },
    };
}
