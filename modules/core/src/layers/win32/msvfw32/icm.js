/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The installable-compressor manager (ICM) of Video for Windows: which
 * codecs the machine has, an HIC for each one opened, and the messages a
 * program sends through it (vfw.h, "Video Compression Manager").
 *
 * A codec is one of three kinds, as on Windows:
 *
 * - a driver the registry names, `HKLM\Software\Microsoft\Windows NT\CurrentVersion\Drivers32`
 *   value `vidc.cvid` = `iccvid.dll`: a system codec this layer answers itself
 *   (`codecs.js`), or a DLL a game installed, loaded and sent messages through
 *   its exported DriverProc;
 * - a function a program installed with ICInstall(ICINSTALL_FUNCTION): its own
 *   code, called as a DriverProc;
 * - none, and the manager says so: ICOpen answers NULL.
 *
 * FOURCCs name codecs without regard to case when a program opens one, as
 * Windows matches them; what a codec accepts in a stream's header is its own
 * business, and the system codecs take their FOURCC only as streams spell it.
 *
 * Drivers the registry lists are read once, when the library is loaded, for
 * enumeration by index (ICInfo's fccHandler below 256): one installed later is
 * found by its FOURCC but not by its index, as on Windows. A function installed
 * at any time is both.
 */

import {
    SYSTEM_CODECS, ICERR_OK, ICERR_BADHANDLE, ICERR_UNSUPPORTED, ICM_GETINFO, ICM_COMPRESS_QUERY,
    ICM_DECOMPRESS_QUERY, ICM_DECOMPRESS_GET_FORMAT, ICM_DECOMPRESS_GET_PALETTE,
    ICM_COMPRESS_GET_FORMAT, ICM_COMPRESS_GET_SIZE, ICM_COMPRESS_BEGIN, ICM_COMPRESS,
    ICM_COMPRESS_END, ICINFO_SIZE, ICVERSION, HEADER_SIZE, BI_RGB, BI_BITFIELDS, fourcc,
    infoOf, readHeader, strideOf, coloursOf,
} from './codecs.js';

/** Where the registry lists the drivers, its values `type.handler`. */
export const DRIVERS32 = 'Software\\Microsoft\\Windows NT\\CurrentVersion\\Drivers32';

const DRV_LOAD = 1;
const DRV_ENABLE = 2;
const DRV_OPEN = 3;
const DRV_CLOSE = 4;
const DRV_DISABLE = 5;
const DRV_FREE = 6;

export const ICMODE_COMPRESS = 1;
export const ICMODE_DECOMPRESS = 2;
export const ICMODE_FASTDECOMPRESS = 3;
export const ICMODE_QUERY = 4;
export const ICMODE_FASTCOMPRESS = 5;
export const ICMODE_DRAW = 8;
const ICM_DRAW_QUERY = 0x401f;

const ICINSTALL_FUNCTION = 0x0001;
const ICINSTALL_DRIVER = 0x0002;
const ICINSTALL_UNICODE = 0x8000;

/**
 * sizeof(ICOPEN): dwSize, fccType, fccHandler, dwVersion, dwFlags, dwError, two reserved,
 *     dnDevNode.
 */
const ICOPEN_SIZE = 36;
/** sizeof(ICCOMPRESS). */
const ICCOMPRESS_SIZE = 48;
const ICCOMPRESS_KEYFRAME = 1;
const AVIIF_KEYFRAME = 0x10;
/** The longest driver file name, in characters. */
const MAX_PATH = 260;
/** The first HIC handed out, and the step between: small and never zero. */
const FIRST_HIC = 0x2000;

/** A FOURCC, a type or a handler, as one compares it: lower case. */
const folded = (/** @type {number} */ code)=>{
    let out = 0;
    for (let shift = 0; shift < 32; shift += 8)
    {
        let byte = code >>> shift & 255;
        if (byte >= 0x41 && byte <= 0x5a)
        {
            byte |= 0x20;
        }
        out |= byte << shift;
    }
    return out >>> 0;
};

/** A FOURCC as the four characters the registry names it with. */
const textOf = (/** @type {number} */ code)=>String.fromCharCode(code & 255, code >>> 8 & 255,
    code >>> 16 & 255, code >>> 24 & 255);

/**
 * @typedef {Object} IcmHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {{ values: (path: string) => [string, string][], get: (path: string, name: string) =>
 *     string | null,
 * set: (path: string, name: string, value: string) => void, remove: (path: string, name: string) =>
 *     boolean }} drivers
 *     the registry's driver list
 * @property {(entry: number, args: number[], thread?: any) => Promise<number>} call the program's
 *     code
 * @property {() => any} [callerThread]
 * @property {(bytes: number) => number} allocate  guest memory, GlobalAlloc's
 * @property {(address: number) => void} free
 * @property {(name: string) => Promise<number> | number} [loadDriver] a codec DLL's DriverProc, 0
 *     if none
 * @property {(name: string) => string | null} [iniDriver]  system.ini's [drivers32] entry of a name
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @typedef {Object} Driver
 * @property {number} type @property {number} handler
 * @property {'system' | 'function' | 'library'} kind
 * @property {import('./codecs.js').Codec} [codec]
 * @property {number} [proc]  the DriverProc of a function or a library
 * @property {string} [file]  the file the registry names
 */

/** @param {IcmHost} host */
export function createIcm(host){
    const { readMemory, writeMemory } = host;
    const memory = { readMemory, writeMemory };
    /** @type {Driver[]} */
    const installed = [];
    /**
     * @type {Map<number, { driver: Driver, id: number, send: (message: number, first: number,
     *     second: number) => number | Promise<number> }>}
     */
    const open = new Map();
    let nextHic = FIRST_HIC;

    /**
     * A driver as a registry value names it: `type.handler` and its file.
     *
     * @param {string} name @param {string} value @returns {Driver | null}
     */
    const fromRegistry = (name, value)=>{
        const dot = name.indexOf('.');
        if (dot !== 4 || name.length !== 9)
        {
            return null;
        }
        const type = fourcc(name.slice(0, 4));
        const handler = fourcc(name.slice(5));
        const codec = SYSTEM_CODECS.find(one=>one.driver.toLowerCase() === value.toLowerCase()
            && folded(one.handler) === folded(handler));
        return codec ? { type, handler, kind: 'system', codec, file: value }
            : { type, handler, kind: 'library', file: value };
    };
    /** The drivers the registry lists as the library loads: what an index enumerates. */
    const listed = host.drivers.values(DRIVERS32)
        .map(([name, value])=>fromRegistry(name, value)).filter(driver=>driver !== null)
        .filter(driver=>/** @type {Driver} */ (driver).type === fourcc('vidc')
            || /** @type {Driver} */ (driver).type === fourcc('vids'));

    /** Every driver an index counts, the registry's then the functions'. */
    const enumerated = ()=>[.../** @type {Driver[]} */ (listed), ...installed];

    /** @param {number} type @param {number} handler @returns {Driver | null} */
    const find = (type, handler)=>{
        const fun = installed.find(one=>folded(one.type) === folded(type)
            && folded(one.handler) === folded(handler));
        if (fun)
        {
            return fun;
        }
        const name = `${textOf(type)}.${textOf(handler)}`;
        const value = host.drivers.values(DRIVERS32)
            .find(([key])=>key.toLowerCase() === name.toLowerCase());
        if (value)
        {
            return fromRegistry(value[0], value[1]);
        }
        // An older program installs its codec in system.ini's [drivers32], as
        // the registry's list was before NT; the manager reads it after the registry.
        const file = host.iniDriver?.(name);
        return file ? fromRegistry(name, file) : null;
    };

    /**
     * @param {Driver} driver @param {number} id @param {number} hic @param {number} message @param
     *     {number} first @param {number} second
     */
    const callDriver = (driver, id, hic, message, first, second)=>
        host.call(/** @type {number} */ (driver.proc),
            [id, hic, message, first >>> 0, second >>> 0], host.callerThread?.());

    /**
     * Opens a driver: a system codec at once, a function or a library through
     * DRV_LOAD, DRV_ENABLE and DRV_OPEN, whose answer is the instance's id.
     *
     * @param {Driver} driver @param {number} type @param {number} handler @param {number} mode
     * @returns {Promise<number>}
     */
    const openDriver = async(driver, type, handler, mode)=>{
        const hic = nextHic;
        if (driver.kind === 'system')
        {
            const codec = /** @type {import('./codecs.js').Codec} */ (driver.codec);
            nextHic += 4;
            open.set(hic, { driver, id: 0, send: codec.open(memory) });
            return hic;
        }
        if (driver.kind === 'library' && driver.proc === undefined)
        {
            const proc = await (host.loadDriver?.(driver.file ?? '') ?? 0);
            if (!proc)
            {
                host.divergence?.('msvfw32',
                    `the codec ${textOf(driver.type)}.${textOf(driver.handler)}`
                    + ` names ${driver.file}, which has no DriverProc to load`);
                return 0;
            }
            driver.proc = proc;
        }
        nextHic += 4;
        const icopen = host.allocate(ICOPEN_SIZE);
        const bytes = new Uint8Array(ICOPEN_SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, ICOPEN_SIZE, true);
        view.setUint32(4, type, true);
        view.setUint32(8, handler, true);
        view.setUint32(12, ICVERSION, true);
        view.setUint32(16, mode, true);
        writeMemory(icopen, bytes);
        await callDriver(driver, 0, hic, DRV_LOAD, 0, 0);
        await callDriver(driver, 0, hic, DRV_ENABLE, 0, 0);
        const id = await callDriver(driver, 0, hic, DRV_OPEN, 0, icopen) >>> 0;
        host.free(icopen);
        if (id === 0)
        {
            return 0;
        }
        open.set(hic, { driver, id,
            send: (message, first, second)=>callDriver(driver, id, hic, message, first, second) });
        return hic;
    };

    /** @param {number} type @param {number} handler @param {number} mode */
    const icOpen = async(type, handler, mode)=>{
        const driver = handler === 0
            ? enumerated().find(one=>folded(one.type) === folded(type)) ?? null
            : find(type, handler);
        return driver ? openDriver(driver, type >>> 0, handler >>> 0, mode >>> 0) : 0;
    };

    /** @param {number} hic @param {number} message @param {number} first @param {number} second */
    const send = async(hic, message, first, second)=>{
        const instance = open.get(hic >>> 0);
        if (!instance)
        {
            return ICERR_BADHANDLE;
        }
        return (await instance.send(message >>> 0, first >>> 0, second >>> 0)) | 0;
    };

    /** @param {number} hic */
    const close = async hic=>{
        const instance = open.get(hic >>> 0);
        if (!instance)
        {
            return ICERR_BADHANDLE;
        }
        open.delete(hic >>> 0);
        if (instance.driver.kind !== 'system')
        {
            await instance.send(DRV_CLOSE, 0, 0);
            await callDriver(instance.driver, 0, hic, DRV_DISABLE, 0, 0);
            await callDriver(instance.driver, 0, hic, DRV_FREE, 0, 0);
        }
        return ICERR_OK;
    };

    /**
     * ICINFO as the manager knows a driver without opening it: its type,
     * handler and file, no name - a name is the codec's to give through
     * ICGetInfo.
     *
     * @param {number} type @param {number} handler @param {string} file
     */
    const managerInfo = (type, handler, file)=>{
        const bytes = new Uint8Array(ICINFO_SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, ICINFO_SIZE, true);
        view.setUint32(4, type, true);
        view.setUint32(8, handler, true);
        view.setUint32(20, ICVERSION, true);
        for (let i = 0; i < Math.min(file.length, 127); i++)
        {
            view.setUint16(312 + i * 2, file.charCodeAt(i), true);
        }
        return bytes;
    };

    /**
     * BOOL ICInfo(fccType, fccHandler, ICINFO *info): a handler below 256 is an
     * index among the drivers of the type (any type for 0). A function driver
     * fills its own ICINFO: the manager clears it and sends ICM_GETINFO.
     *
     * @param {number} type @param {number} handler @param {number} info
     */
    const icInfo = async(type, handler, info)=>{
        type >>>= 0;
        handler >>>= 0;
        let driver;
        if (handler < 256)
        {
            const ofType = enumerated().filter(one=>type === 0
                || folded(one.type) === folded(type));
            driver = ofType[handler] ?? null;
        }
        else
        {
            driver = find(type, handler);
        }
        if (!driver)
        {
            if (info >>> 0)
            {
                writeMemory(info >>> 0, managerInfo(type, handler, ''));
            }
            return 0;
        }
        if (!(info >>> 0))
        {
            return 1;
        }
        if (driver.kind === 'function')
        {
            writeMemory(info >>> 0, managerInfo(0, 0, ''));
            await callDriver(driver, 0, 0, ICM_GETINFO, info, ICINFO_SIZE);
            return 1;
        }
        writeMemory(info >>> 0, managerInfo(driver.type, driver.handler, driver.file ?? ''));
        return 1;
    };

    /** @param {number} hic @param {number} info @param {number} size */
    const icGetInfo = async(hic, info, size)=>{
        const instance = open.get(hic >>> 0);
        if (!instance || !(info >>> 0))
        {
            return 0;
        }
        if (instance.driver.kind === 'system')
        {
            const bytes = infoOf(/** @type {import('./codecs.js').Codec} */ (instance.driver.codec))
                .subarray(0, Math.min(size >>> 0, ICINFO_SIZE));
            writeMemory(info >>> 0, bytes);
            return bytes.length;
        }
        return send(hic, ICM_GETINFO, info, size);
    };

    /**
     * HIC ICLocate(fccType, fccHandler, in, out, wFlags): the first codec that
     * answers the mode's query for the formats - the one the stream names
     * first, then every codec of the type.
     *
     * @param {number} type @param {number} handler @param {number} input @param {number} output
     * @param {number} mode
     */
    const icLocate = async(type, handler, input, output, mode)=>{
        const message = (mode & 0xff) === ICMODE_COMPRESS || (mode & 0xff) === ICMODE_FASTCOMPRESS
            ? ICM_COMPRESS_QUERY : (mode & 0xff) === ICMODE_DRAW ? ICM_DRAW_QUERY
                : ICM_DECOMPRESS_QUERY;
        /** @param {Driver} driver */
        const tryDriver = async driver=>{
            const hic = await openDriver(driver, driver.type, driver.handler, mode);
            if (!hic)
            {
                return 0;
            }
            if (await send(hic, message, input, output) === ICERR_OK)
            {
                return hic;
            }
            await close(hic);
            return 0;
        };
        if (handler >>> 0)
        {
            const driver = find(type, handler);
            return driver ? tryDriver(driver) : 0;
        }
        const named = readHeader(memory, input)?.compression ?? 0;
        /** @type {Driver[]} */
        const order = [];
        if (named > 0xffff)
        {
            const first = find(type, named);
            if (first)
            {
                order.push(first);
            }
        }
        for (const driver of enumerated())
        {
            if (folded(driver.type) === folded(type) && !order.includes(driver))
            {
                order.push(driver);
            }
        }
        for (const driver of order)
        {
            const hic = await tryDriver(driver);
            if (hic)
            {
                return hic;
            }
        }
        return 0;
    };

    /**
     * HIC ICGetDisplayFormat(hic, in, out, BitDepth, dx, dy): an output the
     * codec decompresses to for a display: the depth asked (32 for none) at the
     * size asked (the input's for none), then 16 bits as RGB and as 5-6-5
     * bitfields, 24 and 32 - none shallower than asked - then 32 bits at the
     * input's size, and last whatever the codec's own default output is. An
     * 8-bit answer asks the codec for its palette.
     *
     * @param {number} hic @param {number} input @param {number} output
     * @param {number} depth @param {number} width @param {number} height
     */
    const icGetDisplayFormat = async(hic, input, output, depth, width, height)=>{
        const source = readHeader(memory, input);
        if (!source || !(output >>> 0))
        {
            return 0;
        }
        if (!(hic >>> 0))
        {
            hic = await icLocate(fourcc('vidc'), 0, input, 0, ICMODE_DECOMPRESS);
            if (!hic)
            {
                return 0;
            }
        }
        depth = depth | 0 || 32;
        if ((width | 0) <= 0 || (height | 0) <= 0)
        {
            width = source.width;
            height = source.height;
        }
        const base = readMemory(input >>> 0, HEADER_SIZE).slice();
        /** @param {number} w @param {number} h @param {number} bits @param {number} compression */
        const tryFormat = async(w, h, bits, compression)=>{
            const bytes = base.slice();
            const view = new DataView(bytes.buffer);
            view.setUint32(0, HEADER_SIZE, true);
            view.setInt32(4, w, true);
            view.setInt32(8, h, true);
            view.setUint16(14, bits, true);
            view.setUint32(16, compression, true);
            view.setUint32(20, strideOf(w, bits) * Math.abs(h), true);
            writeMemory(output >>> 0, bytes);
            if (compression === BI_BITFIELDS)
            {
                const masks = new Uint8Array(12);
                const maskView = new DataView(masks.buffer);
                maskView.setUint32(0, 0xf800, true);
                maskView.setUint32(4, 0x07e0, true);
                maskView.setUint32(8, 0x001f, true);
                writeMemory((output >>> 0) + HEADER_SIZE, masks);
            }
            return await send(hic, ICM_DECOMPRESS_QUERY, input, output) === ICERR_OK;
        };
        /** @type {[number, number, number, number][]} */
        const tries = [[width, height, depth, BI_RGB]];
        if (depth <= 16)
        {
            tries.push([width, height, 16, BI_RGB], [width, height, 16, BI_BITFIELDS]);
        }
        if (depth <= 24)
        {
            tries.push([width, height, 24, BI_RGB]);
        }
        if (depth <= 32)
        {
            tries.push([width, height, 32, BI_RGB]);
        }
        tries.push([source.width, source.height, 32, BI_RGB]);
        for (const [w, h, bits, compression] of tries)
        {
            if (await tryFormat(w, h, bits, compression))
            {
                if (bits === 8)
                {
                    await send(hic, ICM_DECOMPRESS_GET_PALETTE, input, output);
                }
                return hic;
            }
        }
        await send(hic, ICM_DECOMPRESS_GET_FORMAT, input, output);
        return hic;
    };

    /** @param {number} at @param {number} value */
    const setU32 = (at, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        writeMemory(at >>> 0, bytes);
    };
    /** @param {number} at */
    const getU32 = at=>new DataView(readMemory(at >>> 0, 4).slice().buffer).getUint32(0, true);

    /**
     * COMPVARS: cbSize, dwFlags, hic, fccType, fccHandler, lpbiIn, lpbiOut,
     * lpBitsOut, lpBitsPrev, lFrame, lKey, lDataRate, lQ, lKeyCount, lpState,
     * cbState - 64 bytes.
     */
    const COMPVARS = { flags: 4, hic: 8, biIn: 20, biOut: 24, bitsOut: 28, bitsPrev: 32,
        frame: 36, key: 40, quality: 48, keyCount: 52, state: 56 };
    const ICMF_COMPVARS_VALID = 0x0001;

    /**
     * BOOL ICSeqCompressFrameStart(COMPVARS *pc, BITMAPINFO *lpbiIn): copies the
     * input format, asks the codec for its output format, makes the buffers a
     * frame is compressed into and from, and begins.
     *
     * @param {number} pc @param {number} info
     */
    const seqStart = async(pc, info)=>{
        const header = readHeader(memory, info);
        const hic = getU32(pc + COMPVARS.hic);
        if (!header || !open.has(hic))
        {
            return 0;
        }
        const inSize = (header.size || HEADER_SIZE) + coloursOf(header) * 4;
        const biIn = host.allocate(inSize);
        writeMemory(biIn, readMemory(info >>> 0, inSize).slice());
        const outSize = await send(hic, ICM_COMPRESS_GET_FORMAT, biIn, 0);
        if (outSize <= 0)
        {
            host.free(biIn);
            return 0;
        }
        const biOut = host.allocate(outSize);
        if (await send(hic, ICM_COMPRESS_GET_FORMAT, biIn, biOut) !== ICERR_OK)
        {
            host.free(biIn);
            host.free(biOut);
            return 0;
        }
        const bitsSize = Math.max(await send(hic, ICM_COMPRESS_GET_SIZE, biIn, biOut),
            readHeader(memory, biOut)?.sizeImage ?? 0);
        const bitsOut = host.allocate(Math.max(bitsSize, 4));
        const bitsPrev = host.allocate(Math.max(strideOf(header.width, header.bitCount)
            * Math.abs(header.height), 4));
        if (await send(hic, ICM_COMPRESS_BEGIN, biIn, biOut) !== ICERR_OK)
        {
            [biIn, biOut, bitsOut, bitsPrev].forEach(host.free);
            return 0;
        }
        setU32(pc + COMPVARS.biIn, biIn);
        setU32(pc + COMPVARS.biOut, biOut);
        setU32(pc + COMPVARS.bitsOut, bitsOut);
        setU32(pc + COMPVARS.bitsPrev, bitsPrev);
        setU32(pc + COMPVARS.frame, 0);
        setU32(pc + COMPVARS.keyCount, getU32(pc + COMPVARS.key));
        return 1;
    };

    /**
     * LPVOID ICSeqCompressFrame(COMPVARS *pc, UINT uiFlags, LPVOID lpBits,
     *     BOOL *pfKey, LONG *plSize): compresses one frame - a key frame every
     * lKey frames, the first always - and hands back the buffer it is in.
     *
     * @param {number} pc @param {number} bits @param {number} keyOut @param {number} sizeOut
     */
    const seqFrame = async(pc, bits, keyOut, sizeOut)=>{
        const hic = getU32(pc + COMPVARS.hic);
        const biIn = getU32(pc + COMPVARS.biIn);
        const biOut = getU32(pc + COMPVARS.biOut);
        const bitsOut = getU32(pc + COMPVARS.bitsOut);
        const bitsPrev = getU32(pc + COMPVARS.bitsPrev);
        const frame = getU32(pc + COMPVARS.frame);
        const every = getU32(pc + COMPVARS.key) | 0;
        const header = readHeader(memory, biIn);
        if (!open.has(hic) || !header || !biOut)
        {
            return 0;
        }
        const key = frame === 0 || (every > 0 && frame % every === 0);
        const call = host.allocate(ICCOMPRESS_SIZE + 8);
        const bytes = new Uint8Array(ICCOMPRESS_SIZE + 8);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, key ? ICCOMPRESS_KEYFRAME : 0, true);
        view.setUint32(4, biOut, true);
        view.setUint32(8, bitsOut, true);
        view.setUint32(12, biIn, true);
        view.setUint32(16, bits >>> 0, true);
        view.setUint32(20, call + ICCOMPRESS_SIZE, true);
        view.setUint32(24, call + ICCOMPRESS_SIZE + 4, true);
        view.setUint32(28, frame, true);
        view.setUint32(32, (sizeOut >>> 0) ? getU32(sizeOut) : 0, true);
        view.setUint32(36, getU32(pc + COMPVARS.quality), true);
        view.setUint32(40, key ? 0 : biIn, true);
        view.setUint32(44, key ? 0 : bitsPrev, true);
        writeMemory(call, bytes);
        const answer = await send(hic, ICM_COMPRESS, call, ICCOMPRESS_SIZE);
        const flags = getU32(call + ICCOMPRESS_SIZE + 4);
        host.free(call);
        if (answer !== ICERR_OK)
        {
            return 0;
        }
        const length = strideOf(header.width, header.bitCount) * Math.abs(header.height);
        writeMemory(bitsPrev, readMemory(bits >>> 0, length).slice());
        setU32(pc + COMPVARS.frame, frame + 1);
        if (keyOut >>> 0)
        {
            setU32(keyOut, (flags & AVIIF_KEYFRAME) !== 0 || key ? 1 : 0);
        }
        if (sizeOut >>> 0)
        {
            setU32(sizeOut, readHeader(memory, biOut)?.sizeImage ?? 0);
        }
        return bitsOut;
    };

    /**
     * void ICSeqCompressFrameEnd(COMPVARS *pc): ends, and frees the frame buffers. @param {number}
     *     pc
     */
    const seqEnd = async pc=>{
        const hic = getU32(pc + COMPVARS.hic);
        if (open.has(hic))
        {
            await send(hic, ICM_COMPRESS_END, 0, 0);
        }
        for (const field of [COMPVARS.biIn, COMPVARS.bitsOut, COMPVARS.bitsPrev])
        {
            const at = getU32(pc + field);
            if (at)
            {
                host.free(at);
                setU32(pc + field, 0);
            }
        }
    };

    /**
     * void ICCompressorFree(COMPVARS *pc): frees what the structure still owns
     * and closes its compressor, when the flags say the structure is one the
     * manager filled.
     *
     * @param {number} pc
     */
    const compressorFree = async pc=>{
        if (!(pc >>> 0) || (getU32(pc + COMPVARS.flags) & ICMF_COMPVARS_VALID) === 0)
        {
            return;
        }
        for (const field of [COMPVARS.biIn, COMPVARS.biOut, COMPVARS.bitsOut, COMPVARS.bitsPrev,
            COMPVARS.state])
        {
            const at = getU32(pc + field);
            if (at)
            {
                host.free(at);
                setU32(pc + field, 0);
            }
        }
        const hic = getU32(pc + COMPVARS.hic);
        if (hic)
        {
            await close(hic);
            setU32(pc + COMPVARS.hic, 0);
        }
        setU32(pc + COMPVARS.flags, 0);
    };

    /**
     * BOOL ICInstall(fccType, fccHandler, LPARAM lParam, LPSTR szDesc, UINT wFlags):
     * a function the program's own (ICINSTALL_FUNCTION), or a driver file the
     * registry is to name (ICINSTALL_DRIVER, the name ANSI or, with
     * ICINSTALL_UNICODE, wide).
     *
     * @param {number} type @param {number} handler @param {number} param @param {number} flags
     */
    const install = (type, handler, param, flags)=>{
        if (flags & ICINSTALL_FUNCTION)
        {
            const at = installed.findIndex(one=>folded(one.type) === folded(type)
                && folded(one.handler) === folded(handler));
            if (at >= 0)
            {
                installed.splice(at, 1);
            }
            installed.push({ type: type >>> 0, handler: handler >>> 0, kind: 'function',
                proc: param >>> 0 });
            return 1;
        }
        if (flags & ICINSTALL_DRIVER)
        {
            if (!(param >>> 0))
            {
                return 0;
            }
            const file = flags & ICINSTALL_UNICODE ? host.readWideString(param >>> 0, MAX_PATH * 2)
                : host.readCString(param >>> 0, MAX_PATH);
            host.drivers.set(DRIVERS32, `${textOf(type)}.${textOf(handler)}`, file);
            return 1;
        }
        return 0;
    };

    /**
     * BOOL ICRemove(fccType, fccHandler, UINT wFlags) @param {number} type @param {number} handler
     */
    const remove = (type, handler)=>{
        const at = installed.findIndex(one=>folded(one.type) === folded(type)
            && folded(one.handler) === folded(handler));
        if (at >= 0)
        {
            installed.splice(at, 1);
            return 1;
        }
        const name = `${textOf(type)}.${textOf(handler)}`;
        const value = host.drivers.values(DRIVERS32)
            .find(([key])=>key.toLowerCase() === name.toLowerCase());
        return value && host.drivers.remove(DRIVERS32, value[0]) ? 1 : 0;
    };

    return { icOpen, close, send, icInfo, icGetInfo, icLocate, icGetDisplayFormat, seqStart,
        seqFrame,
        seqEnd, compressorFree, install, remove,
        /** Whether a handle is an open codec. @param {number} hic */
        isOpen: hic=>open.has(hic >>> 0),
        ICERR_UNSUPPORTED };
}
