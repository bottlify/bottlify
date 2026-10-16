/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { DEVICE, SURFACE, TEXTURE, UNKNOWN_RELEASE, createDeviceCalls } from './device.js';
import { ImageError, bitmapFile, readImage } from './images.js';
import { FMT, decodeTexels, encodeTexels, halve, isCompressed, isSupported, layoutOf, resample }
    from './pixels.js';

/**
 * D3DX's texture loaders: an image file made into a texture, a cube texture
 * or a volume texture on the program's own device, through the device's own
 * methods -- CreateTexture, CreateCubeTexture or CreateVolumeTexture, the
 * levels locked and written, and for
 * a texture the device keeps where it cannot be locked (the default pool, not
 * dynamic), a system-memory copy handed over with UpdateTexture, as D3DX
 * itself does.
 *
 * Every loader is one mechanism with three ways to the file's bytes: the
 * program's memory (FromFileInMemory), a file it names (FromFile, read
 * through the host), and a resource of one of its modules (FromResource:
 * RT_RCDATA, else RT_BITMAP, the two types the documentation names).
 *
 * The sizes, level count and format follow the documented meaning of
 * D3DX_DEFAULT, D3DX_DEFAULT_NONPOW2 and D3DX_FROM_FILE; the levels the file
 * does not hold are made with a box filter; a colour key replaces the texels
 * of that colour with transparent black. A cube texture is made only from a
 * cube map (a DDS file with all six faces), and a texture only from a file
 * that is not one. A volume texture is made of a volume DDS's own levels, its
 * size the file's, converted only to the format asked.
 */

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DXERR_INVALIDDATA = 0x88760b59;
const E_OUTOFMEMORY = 0x8007000e;
const D3DLOCK_READONLY = 0x10;
/** D3DSURFACE_DESC: Format, Type, Usage, Pool, MultiSampleType, MultiSampleQuality, Width, Height. */
const SURFACE_DESC_BYTES = 32;

export const D3DX_DEFAULT = 0xffffffff;
export const D3DX_DEFAULT_NONPOW2 = 0xfffffffe;
export const D3DX_FROM_FILE = 0xfffffffd;

const D3DPOOL_DEFAULT = 0;
const D3DPOOL_MANAGED = 1;
const D3DPOOL_SYSTEMMEM = 2;
const D3DUSAGE_DYNAMIC = 0x200;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_CUBETEXTURE = 5;
const D3DRTYPE_VOLUMETEXTURE = 4;
const RT_BITMAP = 2;
const RT_RCDATA = 10;

/**
 * @typedef {Object} TextureHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {() => any} [currentThread]
 * @property {(path: string) => Promise<Uint8Array | null> | Uint8Array | null} [readFile]
 *     A file's bytes, for the FromFile loaders; null when there is no such file.
 * @property {(module: number, name: string | number, type: number) =>
 *     Promise<Uint8Array | null> | Uint8Array | null} [resource]
 *     A module's resource, for the FromResource loaders.
 */

/** @typedef {(object: number, slot: number, rest: number[]) => Promise<number>} GuestMethod */

/**
 * What a loader is asked to make, as the Ex forms' arguments say it.
 *
 * @typedef {Object} TextureAsk
 * @property {number} width
 * @property {number} height
 * @property {number} mips
 * @property {number} usage
 * @property {number} format
 * @property {number} pool
 * @property {number} colorKey
 * @property {number} info  Where D3DXIMAGE_INFO goes, or 0.
 * @property {number} out
 */

/**
 * The Ex forms' arguments after the image's source, from Width (a cube's
 * Size given twice) to the out-pointer.
 *
 * @param {number[]} rest
 * @returns {TextureAsk}
 */
const askOf = ([width, height, mips, usage, format, pool, , , colorKey, info, , out])=>
    ({ width, height, mips, usage, format, pool, colorKey, info, out });

/**
 * What the forms without Ex mean, as the documentation gives it: sizes and a
 * full chain of levels from the file, its format, the managed pool, no
 * colour key.
 *
 * @param {number} out
 */
const plainAsk = out=>askOf([D3DX_DEFAULT, D3DX_DEFAULT, D3DX_DEFAULT, 0, FMT.UNKNOWN,
    D3DPOOL_MANAGED, D3DX_DEFAULT, D3DX_DEFAULT, 0, 0, 0, out]);

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
    // A palette entry carries an alpha (peFlags), so P8's nearest is A8R8G8B8, as the
    // format table Wine's d3dx9 conformance tests hold to gives P8 eight bits of it.
    return file === FMT.R8G8B8 ? FMT.X8R8G8B8 : FMT.A8R8G8B8;
}

/**
 * @param {TextureHost} host
 */
export function createTextureLoader(host){
    const { u32, putU32s, method: call, string } = createDeviceCalls(host);

    /**
     * Writes D3DXIMAGE_INFO.
     *
     * @param {number} at @param {import('./images.js').Image} image
     */
    const writeInfo = (at, image)=>{
        putU32s(at, [image.width, image.height, image.depth ?? 1, image.mipLevels, image.format,
            image.depth ? D3DRTYPE_VOLUMETEXTURE : image.faces ? D3DRTYPE_CUBETEXTURE
                : D3DRTYPE_TEXTURE, image.fileFormat]);
    };

    /**
     * A string argument, a path or a resource's name, narrow or wide.
     *
     * @param {number} at @param {boolean} wide
     */
    const stringAt = (at, wide)=>string(at, wide, 1024);

    /**
     * The ways to an image file's bytes, each null when there are none.
     */
    const sources = {
        /** @param {number} data @param {number} size */
        memory: (data, size)=>((data >>> 0) === 0 || (size >>> 0) === 0 ? null
            : host.readMemory(data >>> 0, size >>> 0).slice()),
        /**
         * @param {string} api @param {number} at @param {boolean} wide
         * @returns {Promise<Uint8Array | null>}
         */
        file: async(api, at, wide)=>{
            const path = stringAt(at, wide);
            if (!host.readFile)
            {
                host.divergence?.(api, `no file reader is given to this layer: ${path}`);
                return null;
            }
            const bytes = await host.readFile(path);
            if (!bytes)
            {
                // Windows answers the same for a file that is not there; said all the
                // same, since a file a bottle lacks is the usual reason.
                host.divergence?.(api, `answered D3DXERR_INVALIDDATA: no file ${path}`);
            }
            return bytes;
        },
        /**
         * @param {string} api @param {number} module @param {number} name @param {boolean} wide
         * @returns {Promise<Uint8Array | null>}
         */
        resource: async(api, module, name, wide)=>{
            const key = (name >>> 0) < 0x10000 ? name >>> 0 : stringAt(name, wide);
            if (!host.resource)
            {
                host.divergence?.(api, `no resource reader is given to this layer: ${key}`);
                return null;
            }
            const data = await host.resource(module >>> 0, key, RT_RCDATA);
            if (data)
            {
                return data;
            }
            const dib = await host.resource(module >>> 0, key, RT_BITMAP);
            if (!dib)
            {
                return null;
            }
            try
            {
                return bitmapFile(dib);
            }
            catch (e){
                if (!(e instanceof ImageError))
                {
                    throw e;
                }
                host.divergence?.(api, `answered D3DXERR_INVALIDDATA: ${e.message}`);
                return null;
            }
        },
    };

    /**
     * The file read, or the answer a loader gives for one it cannot read.
     *
     * @param {string} api @param {Uint8Array} bytes
     * @returns {import('./images.js').Image | number}
     */
    const read = (api, bytes)=>{
        try
        {
            return readImage(bytes);
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
     * The image a call names, read once its bytes are there.
     *
     * @param {string} api @param {Uint8Array | null | Promise<Uint8Array | null>} found
     * @returns {Promise<import('./images.js').Image | number>}
     */
    const imageOf = async(api, found)=>{
        const bytes = await found;
        return bytes ? read(api, bytes) : D3DXERR_INVALIDDATA;
    };

    /**
     * The image a loader makes a texture or a surface of: a volume, which
     * only D3DXGetImageInfo describes, is refused.
     *
     * @param {string} api @param {Uint8Array | null | Promise<Uint8Array | null>} found
     * @returns {Promise<import('./images.js').Image | number>}
     */
    const flatImageOf = async(api, found)=>{
        const image = await imageOf(api, found);
        if (typeof image !== 'number' && image.depth)
        {
            host.divergence?.(api, 'answered D3DXERR_INVALIDDATA: a volume: not a 2D texture');
            return D3DXERR_INVALIDDATA;
        }
        return image;
    };

    /**
     * D3DXGetImageInfoFromFile's family: the description of an image wherever
     * it is.
     *
     * @param {string} api @param {Uint8Array | null | Promise<Uint8Array | null>} found
     * @param {number} info
     * @returns {Promise<number>}
     */
    const describe = async(api, found, info)=>described(await imageOf(api, found), info);

    /**
     * @param {import('./images.js').Image | number} image @param {number} info
     * @returns {number}
     */
    const described = (image, info)=>{
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
     * HRESULT D3DXGetImageInfoFromFileInMemory(LPCVOID pSrcData, UINT SrcDataSize,
     *     D3DXIMAGE_INFO *pSrcInfo)
     *
     * @param {number[]} args
     */
    const imageInfo = ([data, size, info])=>{
        const bytes = sources.memory(data, size);
        return bytes ? described(read('D3DXGetImageInfoFromFileInMemory', bytes), info)
            : D3DERR_INVALIDCALL;
    };

    /**
     * Every loader's work, once its handler has returned: the image read, a
     * texture (or cube texture) of what was asked made of it, and its levels
     * written.
     *
     * @param {string} api @param {number} device
     * @param {Uint8Array | null | Promise<Uint8Array | null>} found
     * @param {TextureAsk} ask @param {boolean} cube @param {any} thread
     * @returns {Promise<number>}
     */
    const build = async(api, device, found, ask, cube, thread)=>{
        const image = await flatImageOf(api, found);
        if (typeof image === 'number')
        {
            return image;
        }
        if (cube !== Boolean(image.faces))
        {
            host.divergence?.(api, `answered D3DXERR_INVALIDDATA: ${cube
                ? 'the file is not a cube map' : 'a cube map: not a 2D texture'}`);
            return D3DXERR_INVALIDDATA;
        }
        if (ask.info !== 0)
        {
            writeInfo(ask.info, image);
        }
        const w = sizeOf(ask.width, image.width);
        const h = cube ? w : sizeOf(ask.height, image.height);
        let target = ask.format === FMT.UNKNOWN || ask.format === D3DX_FROM_FILE
            ? formatFromFile(image.format) : ask.format;
        if (!isSupported(target))
        {
            host.divergence?.(api, `format ${target} is not one this loader writes: A8R8G8B8 `
                + 'instead');
            target = FMT.A8R8G8B8;
        }
        const full = Math.floor(Math.log2(Math.max(w, h))) + 1;
        const mips = ask.mips;
        const count = mips === 0 || mips === D3DX_DEFAULT ? full
            : mips === D3DX_FROM_FILE ? Math.min(full, image.mipLevels) : Math.min(full, mips);
        const faces = (image.faces ?? [image.levels]).map(levels=>
            levelsOf(levels, w, h, count, target, ask.colorKey));
        return upload(device, { w, h, depth: 0, count, usage: ask.usage, pool: ask.pool,
            target, faces, out: ask.out, cube, thread });
    };

    /**
     * A volume loader's work: the file's levels as they are, in the format
     * asked. D3DX would resize a volume asked another size and make the
     * levels the file lacks; this keeps the file's, and says so.
     *
     * @param {string} api @param {number} device
     * @param {Uint8Array | null | Promise<Uint8Array | null>} found
     * @param {TextureAsk & { depth: number }} ask @param {any} thread
     * @returns {Promise<number>}
     */
    const buildVolume = async(api, device, found, ask, thread)=>{
        const image = await imageOf(api, found);
        if (typeof image === 'number')
        {
            return image;
        }
        if (!image.depth || !image.volume)
        {
            host.divergence?.(api, `answered D3DXERR_INVALIDDATA: ${image.depth
                ? `a volume of format ${image.format}, not read` : 'not a volume'}`);
            return D3DXERR_INVALIDDATA;
        }
        if (ask.info !== 0)
        {
            writeInfo(ask.info, image);
        }
        /** @param {number} asked @param {number} file */
        const kept = (asked, file)=>asked === 0 || asked === file || asked >= D3DX_FROM_FILE;
        if (!kept(ask.width, image.width) || !kept(ask.height, image.height)
            || !kept(ask.depth, image.depth))
        {
            host.divergence?.(api, `asked ${ask.width}x${ask.height}x${ask.depth}: the `
                + `file's ${image.width}x${image.height}x${image.depth} is kept`);
        }
        const target = ask.format === FMT.UNKNOWN || ask.format === D3DX_FROM_FILE
            ? image.format : ask.format;
        const held = image.volume.length;
        const count = ask.mips === 0 || ask.mips >= D3DX_FROM_FILE ? held
            : Math.min(held, ask.mips);
        const faces = [image.volume.slice(0, count).map(slices=>{
            const converted = slices.map(slice=>(target === slice.format ? slice.data
                : encodeTexels(target, decodeTexels(slice.format, slice.data, slice.width,
                    slice.height), slice.width, slice.height)));
            const out = new Uint8Array(converted.reduce((sum, d)=>sum + d.length, 0));
            let at = 0;
            for (const d of converted)
            {
                out.set(d, at);
                at += d.length;
            }
            return out;
        })];
        return upload(device, { w: image.width, h: image.height, depth: image.depth, count,
            usage: ask.usage, pool: ask.pool, target, faces, out: ask.out, cube: false, thread });
    };

    /**
     * A volume loader's handler, as `loader` is a texture loader's.
     *
     * @param {string} api
     * @param {(args: number[]) => { device: number, given: boolean,
     *     found: () => Uint8Array | null | Promise<Uint8Array | null>,
     *     ask: TextureAsk & { depth: number } }} parse
     * @returns {(args: number[]) => number | Promise<number>}
     */
    const volumeLoader = (api, parse)=>args=>{
        const { device, given, found, ask } = parse(args.map(a=>a >>> 0));
        if (ask.out !== 0)
        {
            putU32s(ask.out, [0]);
        }
        if (device === 0 || !given || ask.out === 0 || !host.callGuest || !host.heap)
        {
            return D3DERR_INVALIDCALL;
        }
        return buildVolume(api, device, found(), ask, host.currentThread?.());
    };

    /**
     * The Ex form's arguments after the image's source: Width, Height, Depth, then
     * as a texture's.
     *
     * @param {number[]} rest
     */
    const volumeAskOf = ([width, height, depth, ...rest])=>({ ...askOf([width, height,
        ...rest]), depth });
    /** @param {number} out */
    const plainVolumeAsk = out=>({ ...plainAsk(out), depth: D3DX_DEFAULT });

    /**
     * A loader's handler: the device, where the image is, and what is asked,
     * from its arguments.
     *
     * @param {string} api @param {boolean} cube
     * @param {(args: number[]) => { device: number, given: boolean,
     *     found: () => Uint8Array | null | Promise<Uint8Array | null>, ask: TextureAsk }} parse
     *     `given` false where the call names no image at all.
     * @returns {(args: number[]) => number | Promise<number>}
     */
    const loader = (api, cube, parse)=>args=>{
        const { device, given, found, ask } = parse(args.map(a=>a >>> 0));
        if (ask.out !== 0)
        {
            putU32s(ask.out, [0]);
        }
        if (device === 0 || !given || ask.out === 0 || !host.callGuest || !host.heap)
        {
            return D3DERR_INVALIDCALL;
        }
        return build(api, device, found(), ask, cube, host.currentThread?.());
    };

    /**
     * HRESULT D3DXCreateTextureFromFileInMemoryEx(LPDIRECT3DDEVICE9 pDevice, LPCVOID pSrcData,
     *     UINT SrcDataSize, UINT Width, UINT Height, UINT MipLevels, DWORD Usage,
     *     D3DFORMAT Format, D3DPOOL Pool, DWORD Filter, DWORD MipFilter, D3DCOLOR ColorKey,
     *     D3DXIMAGE_INFO *pSrcInfo, PALETTEENTRY *pPalette, LPDIRECT3DTEXTURE9 *ppTexture)
     */
    const fromMemory = loader('D3DXCreateTextureFromFileInMemoryEx', false,
        ([device, data, size, ...rest])=>({ device, given: data !== 0 && size !== 0,
            found: ()=>sources.memory(data, size), ask: askOf(rest) }));

    /**
     * The bytes of each level in the texture's format.
     *
     * @param {import('./images.js').Level[]} held  The file's levels, largest first.
     * @param {number} w @param {number} h
     * @param {number} count @param {number} target @param {number} colorKey
     * @returns {Uint8Array[]}
     */
    const levelsOf = (held, w, h, count, target, colorKey)=>{
        /** @type {Uint8Array[]} */
        const out = [];
        /** @type {Uint8Array | null} */
        let previous = null;
        for (let level = 0; level < count; level++)
        {
            const lw = Math.max(1, w >> level);
            const lh = Math.max(1, h >> level);
            const own = held[level];
            const fits = own && own.width === lw && own.height === lh;
            if (fits && own.format === target && colorKey === 0)
            {
                // A compressed level already in the format asked for goes as it is.
                out.push(own.data);
                previous = null;
                continue;
            }
            /** @type {Uint8Array} */
            let bgra;
            if (fits)
            {
                bgra = isCompressed(own.format) ? decodeTexels(own.format, own.data, lw, lh)
                    : own.data.slice();
            }
            else if (previous && level > 0)
            {
                bgra = halve(previous, Math.max(1, w >> (level - 1)),
                    Math.max(1, h >> (level - 1))).bgra;
            }
            else
            {
                const top = held[0];
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
     * The texture made on the device and its levels written: a cube
     * texture's face by face, a volume's level by level, each its slices.
     *
     * @param {number} device
     * @param {{ w: number, h: number, depth: number, count: number, usage: number,
     *     pool: number, target: number, faces: Uint8Array[][], out: number, cube: boolean,
     *     thread: any }} plan  `depth` 0 but for a volume.
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
            const answer = plan.cube
                ? await method(device, DEVICE.CreateCubeTexture, [plan.w, plan.count, usage,
                    plan.target, pool, scratch, 0])
                : plan.depth
                    ? await method(device, DEVICE.CreateVolumeTexture, [plan.w, plan.h,
                        plan.depth, plan.count, usage, plan.target, pool, scratch, 0])
                    : await method(device, DEVICE.CreateTexture, [plan.w, plan.h, plan.count,
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
            for (let face = 0; face < plan.faces.length; face++)
            {
                // A cube texture's LockRect and UnlockRect name the face first.
                const which = plan.cube ? [face] : [];
                for (let level = 0; level < plan.count; level++)
                {
                    // LockBox and UnlockBox stand where LockRect and UnlockRect
                    // do; the box has a slice pitch between the row pitch and the bits.
                    const answer = await method(filled, TEXTURE.LockRect, [...which, level,
                        scratch + 4, 0, 0]);
                    if (answer !== D3D_OK)
                    {
                        await method(filled, UNKNOWN_RELEASE, []);
                        return answer;
                    }
                    const pitch = u32(scratch + 4);
                    const slicePitch = plan.depth ? u32(scratch + 8) : 0;
                    const bits = u32(scratch + (plan.depth ? 12 : 8));
                    const { rowBytes, rows } = layoutOf(plan.target, Math.max(1, plan.w >> level),
                        Math.max(1, plan.h >> level));
                    const bytes = plan.faces[face][level];
                    const slices = plan.depth ? Math.max(1, plan.depth >> level) : 1;
                    for (let z = 0; z < slices; z++)
                    {
                        for (let row = 0; row < rows; row++)
                        {
                            const from = (z * rows + row) * rowBytes;
                            host.writeMemory(bits + z * slicePitch + row * pitch,
                                bytes.subarray(from, from + rowBytes));
                        }
                    }
                    await method(filled, TEXTURE.UnlockRect, [...which, level]);
                }
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

    /**
     * The half both surface loaders share: the source's texels, read as packed
     * rows of its format, brought to the destination's format and the size of
     * its rectangle and written through the destination's lock.
     *
     * @param {string} api
     * @param {number} dest @param {number} destRect @param {number} colorKey
     * @param {(method: GuestMethod, scratch: number)
     *     => Promise<number | { format: number, width: number, height: number }>} sourceArea
     * @param {(area: { format: number, width: number, height: number }, method: GuestMethod,
     *     scratch: number) => Promise<number | Uint8Array>} readSource
     * @returns {Promise<number>}
     */
    const intoSurface = async(api, dest, destRect, colorKey, sourceArea, readSource)=>{
        const thread = host.currentThread?.();
        // As for `upload`: the call into the guest goes below this one once it is in flight.
        await null;
        const heap = /** @type {NonNullable<TextureHost['heap']>} */ (host.heap);
        const scratch = heap.allocate(SURFACE_DESC_BYTES + 8);
        if (scratch === 0)
        {
            return E_OUTOFMEMORY;
        }
        /** @type {GuestMethod} */
        const method = (object, slot, rest)=>call(thread, object, slot, rest);
        try
        {
            const from = await sourceArea(method, scratch);
            const to = await surfaceArea(method, scratch, dest, destRect);
            if (typeof from === 'number' || typeof to === 'number')
            {
                return typeof from === 'number' ? from : /** @type {number} */ (to);
            }
            if (!isSupported(from.format) || !isSupported(to.format)
                || from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0)
            {
                host.divergence?.(api, `answered D3DERR_INVALIDCALL:`
                    + ` format ${from.format} ${from.width}x${from.height} into format`
                    + ` ${to.format} ${to.width}x${to.height} is not a copy this loader makes`);
                return D3DERR_INVALIDCALL;
            }
            const packed = await readSource(from, method, scratch);
            if (typeof packed === 'number')
            {
                return packed;
            }
            let bgra = decodeTexels(from.format, packed, from.width, from.height);
            if (from.width !== to.width || from.height !== to.height)
            {
                bgra = resample(bgra, from.width, from.height, to.width, to.height);
            }
            if (colorKey !== 0)
            {
                applyColorKey(bgra, colorKey);
            }
            const bytes = encodeTexels(to.format, bgra, to.width, to.height);
            const locked = scratch + SURFACE_DESC_BYTES;
            const answer = await method(dest, SURFACE.LockRect, [locked, destRect, 0]);
            if (answer !== D3D_OK)
            {
                host.divergence?.(api, `the destination would not lock (0x${answer.toString(16)})`);
                return answer;
            }
            const write = layoutOf(to.format, to.width, to.height);
            for (let row = 0, pitch = u32(locked), bits = u32(locked + 4); row < write.rows; row++)
            {
                host.writeMemory(bits + row * pitch,
                    bytes.subarray(row * write.rowBytes, (row + 1) * write.rowBytes));
            }
            await method(dest, SURFACE.UnlockRect, []);
            return D3D_OK;
        }
        finally
        {
            heap.free(scratch);
        }
    };

    /**
     * A surface's format and the size of a rectangle of it, the whole surface
     * for a null one.
     *
     * @param {GuestMethod} method @param {number} scratch
     * @param {number} surface @param {number} rect
     */
    const surfaceArea = async(method, scratch, surface, rect)=>{
        const answer = await method(surface, SURFACE.GetDesc, [scratch]);
        if (answer !== D3D_OK)
        {
            return answer;
        }
        const format = u32(scratch);
        const [left, top, right, bottom] = rect === 0
            ? [0, 0, u32(scratch + 24), u32(scratch + 28)]
            : [0, 4, 8, 12].map(at=>u32(rect + at));
        return { format, width: right - left, height: bottom - top };
    };

    /**
     * An area's texels as packed rows, read from rows `pitch` bytes apart.
     *
     * @param {{ format: number, width: number, height: number }} area
     * @param {number} bits @param {number} pitch
     */
    const readRows = (area, bits, pitch)=>{
        const { rowBytes, rows } = layoutOf(area.format, area.width, area.height);
        const packed = new Uint8Array(rowBytes * rows);
        for (let row = 0; row < rows; row++)
        {
            packed.set(host.readMemory(bits + row * pitch, rowBytes), row * rowBytes);
        }
        return packed;
    };

    /**
     * HRESULT D3DXLoadSurfaceFromSurface(LPDIRECT3DSURFACE9 pDestSurface,
     *     const PALETTEENTRY *pDestPalette, const RECT *pDestRect,
     *     LPDIRECT3DSURFACE9 pSrcSurface, const PALETTEENTRY *pSrcPalette,
     *     const RECT *pSrcRect, DWORD Filter, D3DCOLOR ColorKey)
     *
     * The source's rectangle is read through its lock, brought to the
     * destination's format and the size of its rectangle, and written through
     * the destination's lock. A surface that cannot be locked -- a render
     * target in the default pool -- is answered as its lock answered.
     *
     * @param {number[]} args
     * @returns {number | Promise<number>}
     */
    const loadSurface = args=>{
        const [dest, , destRect, source, , sourceRect, , colorKey] = args.map(a=>a >>> 0);
        if (dest === 0 || source === 0 || !host.callGuest || !host.heap)
        {
            return D3DERR_INVALIDCALL;
        }
        const api = 'D3DXLoadSurfaceFromSurface';
        return intoSurface(api, dest, destRect, colorKey,
            (method, scratch)=>surfaceArea(method, scratch, source, sourceRect),
            async(from, method, scratch)=>{
                const locked = scratch + SURFACE_DESC_BYTES;
                const answer = await method(source, SURFACE.LockRect,
                    [locked, sourceRect, D3DLOCK_READONLY]);
                if (answer !== D3D_OK)
                {
                    host.divergence?.(api, `the source would not lock (0x${answer.toString(16)})`);
                    return answer;
                }
                const packed = readRows(from, u32(locked + 4), u32(locked));
                await method(source, SURFACE.UnlockRect, []);
                return packed;
            });
    };

    /**
     * HRESULT D3DXLoadSurfaceFromMemory(LPDIRECT3DSURFACE9 pDestSurface,
     *     const PALETTEENTRY *pDestPalette, const RECT *pDestRect,
     *     LPCVOID pSrcMemory, D3DFORMAT SrcFormat, UINT SrcPitch,
     *     const PALETTEENTRY *pSrcPalette, const RECT *pSrcRect, DWORD Filter,
     *     D3DCOLOR ColorKey)
     *
     * pSrcMemory is the top-left corner of the whole source image, its rows
     * SrcPitch bytes apart -- rows of 4x4 blocks for a compressed format -- and
     * pSrcRect, which may not be null, the part of it read. The rest is
     * D3DXLoadSurfaceFromSurface's.
     *
     * @param {number[]} args
     * @returns {number | Promise<number>}
     */
    const loadSurfaceFromMemory = args=>{
        const [dest, , destRect, bits, format, pitch, , sourceRect, , colorKey]
            = args.map(a=>a >>> 0);
        if (dest === 0 || bits === 0 || sourceRect === 0 || !host.callGuest || !host.heap)
        {
            return D3DERR_INVALIDCALL;
        }
        const [left, top, right, bottom] = [0, 4, 8, 12].map(at=>u32(sourceRect + at));
        return intoSurface('D3DXLoadSurfaceFromMemory', dest, destRect, colorKey,
            async()=>({ format, width: right - left, height: bottom - top }),
            async from=>{
                const block = isCompressed(format) ? 4 : 1;
                const unit = layoutOf(format, block, block).rowBytes;
                return readRows(from, bits + Math.floor(top / block) * pitch
                    + Math.floor(left / block) * unit, pitch);
            });
    };

    /**
     * D3DXLoadSurfaceFromFile's family: the image's first level -- a cube
     * map's first face -- its rectangle pSrcRect or the whole of it, put into
     * the destination as D3DXLoadSurfaceFromSurface puts a surface's.
     *
     * @param {string} api @param {number} dest @param {number} destRect
     * @param {Uint8Array | null | Promise<Uint8Array | null>} found
     * @param {number} sourceRect @param {number} colorKey @param {number} info
     * @returns {Promise<number>}
     */
    const surfaceFromImage = (api, dest, destRect, found, sourceRect, colorKey, info)=>{
        /** @type {{ texels: Uint8Array, width: number, left: number, top: number } | null} */
        let picked = null;
        return intoSurface(api, dest, destRect, colorKey, async()=>{
            const image = await flatImageOf(api, found);
            if (typeof image === 'number')
            {
                return image;
            }
            if (info !== 0)
            {
                writeInfo(info, image);
            }
            const [left, top, right, bottom] = sourceRect === 0
                ? [0, 0, image.width, image.height]
                : [0, 4, 8, 12].map(at=>u32(sourceRect + at) | 0);
            if (left < 0 || top < 0 || right > image.width || bottom > image.height)
            {
                return D3DERR_INVALIDCALL;
            }
            const first = image.levels[0];
            picked = { left, top, width: first.width, texels: isCompressed(first.format)
                ? decodeTexels(first.format, first.data, first.width, first.height)
                : first.data };
            return { format: FMT.A8R8G8B8, width: right - left, height: bottom - top };
        }, async from=>{
            const { texels, width, left, top } = /** @type {NonNullable<typeof picked>} */ (
                picked);
            const out = new Uint8Array(from.width * from.height * 4);
            for (let y = 0; y < from.height; y++)
            {
                const at = ((top + y) * width + left) * 4;
                out.set(texels.subarray(at, at + from.width * 4), y * from.width * 4);
            }
            return out;
        });
    };

    /**
     * A surface loader's handler: the destination, its rectangle, where the
     * image is, the source rectangle, the colour key and pSrcInfo, from its
     * arguments.
     *
     * @param {string} api
     * @param {(args: number[]) => { given: boolean, found: () => Uint8Array | null
     *     | Promise<Uint8Array | null>, sourceRect: number, colorKey: number, info: number }} parse
     * @returns {(args: number[]) => number | Promise<number>}
     */
    const surfaceLoader = (api, parse)=>args=>{
        const [dest, , destRect] = args.map(a=>a >>> 0);
        const { given, found, sourceRect, colorKey, info } = parse(args.map(a=>a >>> 0));
        if (dest === 0 || !given || !host.callGuest || !host.heap)
        {
            return D3DERR_INVALIDCALL;
        }
        return surfaceFromImage(api, dest, destRect, found(), sourceRect, colorKey, info);
    };

    /** @type {Record<string, { argBytes: number, handler: (args: number[]) => any }>} */
    const exports = {
        D3DXCreateTextureFromFileInMemoryEx: { argBytes: 60, handler: fromMemory },
        /**
         * HRESULT D3DXCreateTextureFromFileInMemory(LPDIRECT3DDEVICE9 pDevice, LPCVOID pSrcData,
         *     UINT SrcDataSize, LPDIRECT3DTEXTURE9 *ppTexture)
         */
        D3DXCreateTextureFromFileInMemory: { argBytes: 16,
            handler: loader('D3DXCreateTextureFromFileInMemory', false, ([device, data, size,
                out])=>({ device, given: data !== 0 && size !== 0,
                found: ()=>sources.memory(data, size), ask: plainAsk(out) })) },
        /**
         * HRESULT D3DXCreateCubeTextureFromFileInMemoryEx(LPDIRECT3DDEVICE9 pDevice,
         *     LPCVOID pSrcData, UINT SrcDataSize, UINT Size, UINT MipLevels, DWORD Usage,
         *     D3DFORMAT Format, D3DPOOL Pool, DWORD Filter, DWORD MipFilter,
         *     D3DCOLOR ColorKey, D3DXIMAGE_INFO *pSrcInfo, PALETTEENTRY *pPalette,
         *     LPDIRECT3DCUBETEXTURE9 *ppCubeTexture)
         */
        D3DXCreateCubeTextureFromFileInMemoryEx: { argBytes: 56,
            handler: loader('D3DXCreateCubeTextureFromFileInMemoryEx', true, ([device, data,
                size, edge, ...rest])=>({ device, given: data !== 0 && size !== 0,
                found: ()=>sources.memory(data, size), ask: askOf([edge, edge, ...rest]) })) },
        /** The same without Ex: (pDevice, pSrcData, SrcDataSize, ppCubeTexture). */
        D3DXCreateCubeTextureFromFileInMemory: { argBytes: 16,
            handler: loader('D3DXCreateCubeTextureFromFileInMemory', true, ([device, data,
                size, out])=>({ device, given: data !== 0 && size !== 0,
                found: ()=>sources.memory(data, size), ask: plainAsk(out) })) },
        D3DXGetImageInfoFromFileInMemory: { argBytes: 12, handler: imageInfo },
        /**
         * HRESULT D3DXCreateVolumeTextureFromFileInMemory(LPDIRECT3DDEVICE9 pDevice,
         *     LPCVOID pSrcData, UINT SrcDataSize, LPDIRECT3DVOLUMETEXTURE9 *ppVolumeTexture)
         */
        D3DXCreateVolumeTextureFromFileInMemory: { argBytes: 16,
            handler: volumeLoader('D3DXCreateVolumeTextureFromFileInMemory', ([device, data,
                size, out])=>({ device, given: data !== 0 && size !== 0,
                found: ()=>sources.memory(data, size), ask: plainVolumeAsk(out) })) },
        /**
         * HRESULT D3DXCreateVolumeTextureFromFileInMemoryEx(LPDIRECT3DDEVICE9 pDevice,
         *     LPCVOID pSrcData, UINT SrcDataSize, UINT Width, UINT Height, UINT Depth,
         *     UINT MipLevels, DWORD Usage, D3DFORMAT Format, D3DPOOL Pool, DWORD Filter,
         *     DWORD MipFilter, D3DCOLOR ColorKey, D3DXIMAGE_INFO *pSrcInfo,
         *     PALETTEENTRY *pPalette, LPDIRECT3DVOLUMETEXTURE9 *ppVolumeTexture)
         */
        D3DXCreateVolumeTextureFromFileInMemoryEx: { argBytes: 64,
            handler: volumeLoader('D3DXCreateVolumeTextureFromFileInMemoryEx', ([device, data,
                size, ...rest])=>({ device, given: data !== 0 && size !== 0,
                found: ()=>sources.memory(data, size), ask: volumeAskOf(rest) })) },
        /**
         * HRESULT D3DXLoadSurfaceFromFileInMemory(LPDIRECT3DSURFACE9 pDestSurface,
         *     const PALETTEENTRY *pDestPalette, const RECT *pDestRect, LPCVOID pSrcData,
         *     UINT SrcData, const RECT *pSrcRect, DWORD Filter, D3DCOLOR ColorKey,
         *     D3DXIMAGE_INFO *pSrcInfo)
         */
        D3DXLoadSurfaceFromFileInMemory: { argBytes: 36,
            handler: surfaceLoader('D3DXLoadSurfaceFromFileInMemory', ([, , , data, size,
                sourceRect, , colorKey, info])=>({ given: data !== 0 && size !== 0,
                found: ()=>sources.memory(data, size), sourceRect, colorKey, info })) },
        D3DXLoadSurfaceFromSurface: { argBytes: 32, handler: loadSurface },
        D3DXLoadSurfaceFromMemory: { argBytes: 40, handler: loadSurfaceFromMemory },
    };
    for (const suffix of ['A', 'W'])
    {
        const wide = suffix === 'W';
        /** @param {string} name */
        const named = name=>`${name}${suffix}`;
        Object.assign(exports, {
            /**
             * HRESULT D3DXCreateTextureFromFile(LPDIRECT3DDEVICE9 pDevice, LPCTSTR pSrcFile,
             *     LPDIRECT3DTEXTURE9 *ppTexture)
             */
            [named('D3DXCreateTextureFromFile')]: { argBytes: 12,
                handler: loader(named('D3DXCreateTextureFromFile'), false, ([device, file,
                    out])=>({ device, given: file !== 0, ask: plainAsk(out),
                    found: ()=>sources.file(named('D3DXCreateTextureFromFile'), file, wide) })) },
            /**
             * HRESULT D3DXCreateTextureFromFileEx(LPDIRECT3DDEVICE9 pDevice, LPCTSTR pSrcFile,
             *     UINT Width, UINT Height, UINT MipLevels, DWORD Usage, D3DFORMAT Format,
             *     D3DPOOL Pool, DWORD Filter, DWORD MipFilter, D3DCOLOR ColorKey,
             *     D3DXIMAGE_INFO *pSrcInfo, PALETTEENTRY *pPalette,
             *     LPDIRECT3DTEXTURE9 *ppTexture)
             */
            [named('D3DXCreateTextureFromFileEx')]: { argBytes: 56,
                handler: loader(named('D3DXCreateTextureFromFileEx'), false, ([device, file,
                    ...rest])=>({ device, given: file !== 0, ask: askOf(rest),
                    found: ()=>sources.file(named('D3DXCreateTextureFromFileEx'), file, wide) })) },
            /**
             * HRESULT D3DXCreateTextureFromResource(LPDIRECT3DDEVICE9 pDevice,
             *     HMODULE hSrcModule, LPCTSTR pSrcResource, LPDIRECT3DTEXTURE9 *ppTexture)
             */
            [named('D3DXCreateTextureFromResource')]: { argBytes: 16,
                handler: loader(named('D3DXCreateTextureFromResource'), false, ([device, module,
                    name, out])=>({ device, given: true, ask: plainAsk(out),
                    found: ()=>sources.resource(named('D3DXCreateTextureFromResource'), module,
                        name, wide) })) },
            /** The Ex form: the module and resource, then as D3DXCreateTextureFromFileEx. */
            [named('D3DXCreateTextureFromResourceEx')]: { argBytes: 60,
                handler: loader(named('D3DXCreateTextureFromResourceEx'), false, ([device,
                    module, name, ...rest])=>({ device, given: true, ask: askOf(rest),
                    found: ()=>sources.resource(named('D3DXCreateTextureFromResourceEx'), module,
                        name, wide) })) },
            /**
             * HRESULT D3DXCreateCubeTextureFromFile(LPDIRECT3DDEVICE9 pDevice,
             *     LPCTSTR pSrcFile, LPDIRECT3DCUBETEXTURE9 *ppCubeTexture)
             */
            [named('D3DXCreateCubeTextureFromFile')]: { argBytes: 12,
                handler: loader(named('D3DXCreateCubeTextureFromFile'), true, ([device, file,
                    out])=>({ device, given: file !== 0, ask: plainAsk(out),
                    found: ()=>sources.file(named('D3DXCreateCubeTextureFromFile'), file,
                        wide) })) },
            /**
             * HRESULT D3DXCreateCubeTextureFromFileEx(LPDIRECT3DDEVICE9 pDevice,
             *     LPCTSTR pSrcFile, UINT Size, UINT MipLevels, DWORD Usage, D3DFORMAT Format,
             *     D3DPOOL Pool, DWORD Filter, DWORD MipFilter, D3DCOLOR ColorKey,
             *     D3DXIMAGE_INFO *pSrcInfo, PALETTEENTRY *pPalette,
             *     LPDIRECT3DCUBETEXTURE9 *ppCubeTexture)
             */
            [named('D3DXCreateCubeTextureFromFileEx')]: { argBytes: 52,
                handler: loader(named('D3DXCreateCubeTextureFromFileEx'), true, ([device, file,
                    edge, ...rest])=>({ device, given: file !== 0, ask: askOf([edge, edge,
                    ...rest]), found: ()=>sources.file(named('D3DXCreateCubeTextureFromFileEx'),
                    file, wide) })) },
            /**
             * HRESULT D3DXCreateCubeTextureFromResource(LPDIRECT3DDEVICE9 pDevice,
             *     HMODULE hSrcModule, LPCTSTR pSrcResource,
             *     LPDIRECT3DCUBETEXTURE9 *ppCubeTexture)
             */
            [named('D3DXCreateCubeTextureFromResource')]: { argBytes: 16,
                handler: loader(named('D3DXCreateCubeTextureFromResource'), true, ([device,
                    module, name, out])=>({ device, given: true, ask: plainAsk(out),
                    found: ()=>sources.resource(named('D3DXCreateCubeTextureFromResource'),
                        module, name, wide) })) },
            /** The Ex form: the module and resource, then as D3DXCreateCubeTextureFromFileEx. */
            [named('D3DXCreateCubeTextureFromResourceEx')]: { argBytes: 56,
                handler: loader(named('D3DXCreateCubeTextureFromResourceEx'), true, ([device,
                    module, name, edge, ...rest])=>({ device, given: true,
                    ask: askOf([edge, edge, ...rest]),
                    found: ()=>sources.resource(named('D3DXCreateCubeTextureFromResourceEx'),
                        module, name, wide) })) },
            /**
             * HRESULT D3DXCreateVolumeTextureFromFile(LPDIRECT3DDEVICE9 pDevice,
             *     LPCTSTR pSrcFile, LPDIRECT3DVOLUMETEXTURE9 *ppVolumeTexture)
             */
            [named('D3DXCreateVolumeTextureFromFile')]: { argBytes: 12,
                handler: volumeLoader(named('D3DXCreateVolumeTextureFromFile'), ([device, file,
                    out])=>({ device, given: file !== 0, ask: plainVolumeAsk(out),
                    found: ()=>sources.file(named('D3DXCreateVolumeTextureFromFile'), file,
                        wide) })) },
            /** The Ex form: the file, then as D3DXCreateVolumeTextureFromFileInMemoryEx. */
            [named('D3DXCreateVolumeTextureFromFileEx')]: { argBytes: 60,
                handler: volumeLoader(named('D3DXCreateVolumeTextureFromFileEx'), ([device, file,
                    ...rest])=>({ device, given: file !== 0, ask: volumeAskOf(rest),
                    found: ()=>sources.file(named('D3DXCreateVolumeTextureFromFileEx'), file,
                        wide) })) },
            /** HRESULT D3DXGetImageInfoFromFile(LPCTSTR pSrcFile, D3DXIMAGE_INFO *pSrcInfo) */
            [named('D3DXGetImageInfoFromFile')]: { argBytes: 8,
                handler: (/** @type {number[]} */ [file, info])=>((file >>> 0) === 0
                    ? D3DERR_INVALIDCALL : describe(named('D3DXGetImageInfoFromFile'),
                        sources.file(named('D3DXGetImageInfoFromFile'), file, wide), info)) },
            /**
             * HRESULT D3DXGetImageInfoFromResource(HMODULE hSrcModule, LPCTSTR pSrcResource,
             *     D3DXIMAGE_INFO *pSrcInfo)
             */
            [named('D3DXGetImageInfoFromResource')]: { argBytes: 12,
                handler: (/** @type {number[]} */ [module, name, info])=>describe(
                    named('D3DXGetImageInfoFromResource'), sources.resource(
                        named('D3DXGetImageInfoFromResource'), module, name, wide), info) },
            /**
             * HRESULT D3DXLoadSurfaceFromFile(LPDIRECT3DSURFACE9 pDestSurface,
             *     const PALETTEENTRY *pDestPalette, const RECT *pDestRect, LPCTSTR pSrcFile,
             *     const RECT *pSrcRect, DWORD Filter, D3DCOLOR ColorKey,
             *     D3DXIMAGE_INFO *pSrcInfo)
             */
            [named('D3DXLoadSurfaceFromFile')]: { argBytes: 32,
                handler: surfaceLoader(named('D3DXLoadSurfaceFromFile'), ([, , , file,
                    sourceRect, , colorKey, info])=>({ given: file !== 0, sourceRect, colorKey,
                    info, found: ()=>sources.file(named('D3DXLoadSurfaceFromFile'), file,
                        wide) })) },
            /**
             * HRESULT D3DXLoadSurfaceFromResource(LPDIRECT3DSURFACE9 pDestSurface,
             *     const PALETTEENTRY *pDestPalette, const RECT *pDestRect,
             *     HMODULE hSrcModule, LPCTSTR pSrcResource, const RECT *pSrcRect,
             *     DWORD Filter, D3DCOLOR ColorKey, D3DXIMAGE_INFO *pSrcInfo)
             */
            [named('D3DXLoadSurfaceFromResource')]: { argBytes: 36,
                handler: surfaceLoader(named('D3DXLoadSurfaceFromResource'), ([, , , module,
                    name, sourceRect, , colorKey, info])=>({ given: true, sourceRect, colorKey,
                    info, found: ()=>sources.resource(named('D3DXLoadSurfaceFromResource'),
                        module, name, wide) })) },
        });
    }

    return { exports, fromMemory, imageInfo, loadSurface, loadSurfaceFromMemory };
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
