/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * cabinet.dll: the File Decompression Interface, how a setup unpacks a
 * cabinet it carries, and beside it the File Compression Interface (fci.js),
 * how a program makes one.
 *
 * The program supplies every service the library needs -- memory, and the
 * opening, reading, writing, seeking in and closing of files, all as
 * callbacks of its own -- and a notification callback that is told of each
 * file the cabinet holds and answers with a handle to write it to, or none
 * to skip it. The library only knows the cabinet's format, so a cabinet is
 * read through the program's callbacks wherever it lies, a file at a time as
 * the folder it is in decodes, and nothing is held that the next block does
 * not need.
 *
 * Every callback is C calling convention, and so are the entry points.
 */

import { CabinetError, COMPRESSION } from './cabinet.js';
import { extractCabinet, readCabinetHead } from './stream.js';
import { createFciFunctions } from './fci.js';
import { encodeAnsi } from '../kernel32/locale.js';

/**
 * How far a name a program hands these is read: whole, as Windows reads it, up to
 * the 32 767 characters a path may have. A name cut shorter names another file.
 */
const WHOLE_NAME = 32767;

/** FDICopy's notifications. */
const fdintCABINET_INFO = 0;
const fdintPARTIAL_FILE = 1;
const fdintCOPY_FILE = 2;
const fdintCLOSE_FILE_INFO = 3;
const fdintNEXT_CABINET = 4;
const fdintENUMERATE = 5;

/** FDIERROR values an ERF's erfOper carries. */
const FDIERROR = Object.freeze({
    NONE: 0, CABINET_NOT_FOUND: 1, NOT_A_CABINET: 2, UNKNOWN_CABINET_VERSION: 3,
    CORRUPT_CABINET: 4, ALLOC_FAIL: 5, BAD_COMPR_TYPE: 6, MDI_FAIL: 7, TARGET_FILE: 8,
    RESERVE_MISMATCH: 9, WRONG_CABINET: 10, USER_ABORT: 11,
});

/** A file whose name is UTF-8 says so in its attributes. */
const A_NAME_IS_UTF = 0x80;

/** Thrown when the program's write callback does not take what it is given. */
class TargetError extends Error {}

/** _O_RDONLY | _O_BINARY: how the program is asked to open the cabinet. */
const O_RDONLY_BINARY = 0x8000;
const SEEK_SET = 0;

/** FDINOTIFICATION's size, and FDICABINETINFO's. */
const NOTIFICATION_SIZE = 40;
const CABINET_INFO_SIZE = 24;

/** How much of the cabinet is read from the program in one callback. */
const READ_CHUNK = 64 * 1024;

/**
 * @typedef {Object} CabinetHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {(entry: number, args: number[], thread?: any) => number | Promise<number>} call
 * @property {() => any} callerThread
 * @property {(code: number) => void} [setLastError]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @typedef {Object} Context
 * @property {number} alloc @property {number} free @property {number} open
 * @property {number} read @property {number} write @property {number} close
 * @property {number} seek @property {number} erf
 */

/**
 * @param {CabinetHost} host
 */
export function createCabinetFunctions(host){
    /** @type {Map<number, Context>} */
    const contexts = new Map();
    let next = 0x0fd10001;

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>host.writeMemory(address >>> 0,
        new Uint8Array(Uint32Array.of(value >>> 0).buffer));

    /**
     * The ERF the program gave: what went wrong, for it to read.
     *
     * @param {Context} context @param {number} code
     */
    const fail = (context, code)=>{
        if (context.erf !== 0)
        {
            writeU32(context.erf, code);
            writeU32(context.erf + 4, 0);
            writeU32(context.erf + 8, code === FDIERROR.NONE ? 0 : 1);
        }
        return 0;
    };

    /** @param {string} kind */
    const errorOf = kind=>(kind === 'unsupported' ? FDIERROR.UNKNOWN_CABINET_VERSION
        : FDIERROR.CORRUPT_CABINET);

    /**
     * A cabinet read through the program's own callbacks.
     *
     * @param {Context} context @param {number} file  The program's handle.
     * @param {any} thread
     * @returns {Promise<import('./stream.js').ByteSource>}
     */
    const sourceOver = async(context, file, thread)=>{
        const end = Number(await host.call(context.seek, [file, 0, 2], thread) | 0);
        const buffer = host.allocate(READ_CHUNK);
        return {
            // A seek that failed -- a handle that is no file -- leaves
            // nothing to read, and so no cabinet; the error is the callback's.
            size: Math.max(end, 0),
            read: async(offset, length)=>{
                const out = new Uint8Array(length);
                let done = 0;
                while (done < length)
                {
                    const place = Number(await host.call(context.seek,
                        [file, offset + done, SEEK_SET], thread) | 0);
                    if (place !== offset + done)
                    {
                        break;
                    }
                    const want = Math.min(READ_CHUNK, length - done);
                    const got = (await host.call(context.read, [file, buffer, want], thread)) >>> 0;
                    if (got === 0 || got > want)
                    {
                        break;
                    }
                    out.set(host.readMemory(buffer, got), done);
                    done += got;
                }
                return done === length ? out : out.subarray(0, done);
            },
            release: ()=>host.free(buffer),
        };
    };

    /** @param {string} text */
    const guestString = text=>{
        const bytes = encodeAnsi(`${text}\0`);
        const block = host.allocate(bytes.length);
        host.writeMemory(block, bytes);
        return block;
    };

    return {
        ...createFciFunctions(host),

        /**
         * HFDI FDICreate(PFNALLOC pfnalloc, PFNFREE pfnfree, PFNOPEN pfnopen,
         *   PFNREAD pfnread, PFNWRITE pfnwrite, PFNCLOSE pfnclose, PFNSEEK pfnseek,
         *   int cpuType, PERF perf)
         */
        FDICreate: {
            convention: 'cdecl',
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([alloc, free, open, read, write, close, seek, , erf])=>{
                const context = { alloc, free, open, read, write, close, seek, erf };
                if ([alloc, free, open, read, write, close, seek].some(entry=>(entry >>> 0) === 0))
                {
                    fail(context, FDIERROR.ALLOC_FAIL);
                    return 0;
                }
                fail(context, FDIERROR.NONE);
                const handle = next;
                next += 4;
                contexts.set(handle, context);
                return handle;
            },
        },

        /** BOOL FDIDestroy(HFDI hfdi) */
        FDIDestroy: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([hfdi])=>(contexts.delete(hfdi >>> 0) ? 1 : 0),
        },

        /**
         * BOOL FDIIsCabinet(HFDI hfdi, INT_PTR hf, PFDICABINETINFO pfdici)
         */
        FDIIsCabinet: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([hfdi, file, info])=>{
                const context = contexts.get(hfdi >>> 0);
                if (!context)
                {
                    return 0;
                }
                const thread = host.callerThread();
                const source = await sourceOver(context, file, thread);
                try
                {
                    const cabinet = await readCabinetHead(source);
                    if ((info >>> 0) !== 0)
                    {
                        const block = new Uint8Array(CABINET_INFO_SIZE);
                        const view = new DataView(block.buffer);
                        view.setInt32(0, cabinet.size, true);
                        view.setUint16(4, cabinet.folders.length, true);
                        view.setUint16(6, cabinet.files.length, true);
                        view.setUint16(8, cabinet.setId, true);
                        view.setUint16(10, cabinet.index, true);
                        view.setInt32(12, (cabinet.flags & 4) !== 0 ? 1 : 0, true);
                        view.setInt32(16, cabinet.previous !== null ? 1 : 0, true);
                        view.setInt32(20, cabinet.next !== null ? 1 : 0, true);
                        host.writeMemory(info >>> 0, block);
                    }
                    return 1;
                }
                catch (e){
                    // A file that is not a cabinet is the answer, not an error to
                    // report: a program probes every file it unpacked with this,
                    // and keeps its ERF in a frame that is gone by then, so a
                    // write to it lands on whatever stands there now.
                    if (e instanceof CabinetError)
                    {
                        return 0;
                    }
                    throw e;
                }
                finally
                {
                    source.release?.();
                }
            },
        },

        /**
         * BOOL FDICopy(HFDI hfdi, char *pszCabinet, char *pszCabPath, int flags,
         *   PFNFDINOTIFY pfnfdin, PFNFDIDECRYPT pfnfdid, void *pvUser)
         */
        FDICopy: {
            convention: 'cdecl',
            argBytes: 28,
            /** @param {number[]} args */
            handler: async([hfdi, cabinetName, cabinetPath, , notify, , user])=>{
                const context = contexts.get(hfdi >>> 0);
                if (!context)
                {
                    return 0;
                }
                const thread = host.callerThread();
                const name = host.readCString(cabinetName >>> 0, WHOLE_NAME);
                const directory = host.readCString(cabinetPath >>> 0, WHOLE_NAME);
                const path = guestString(directory + name);
                /** @param {number} kind @param {(block: Uint8Array) => void} fill */
                const tell = async(kind, fill)=>{
                    const block = new Uint8Array(NOTIFICATION_SIZE);
                    fill(block);
                    const address = host.allocate(NOTIFICATION_SIZE);
                    host.writeMemory(address, block);
                    try
                    {
                        return (await host.call(notify >>> 0, [kind, address], thread)) | 0;
                    }
                    finally
                    {
                        host.free(address);
                    }
                };
                const file = (await host.call(context.open,
                    [path, O_RDONLY_BINARY, 0], thread)) | 0;
                host.free(path);
                if (file === -1)
                {
                    return fail(context, FDIERROR.CABINET_NOT_FOUND);
                }
                const source = await sourceOver(context, file, thread);
                /** @type {string[]} */
                const strings = [];
                /** @param {string} text */
                const string = text=>{
                    const block = guestString(text);
                    strings.push(String(block));
                    return block;
                };
                const buffer = host.allocate(32768 + 8);
                try
                {
                    const cabinet = await readCabinetHead(source);
                    for (const folder of cabinet.folders)
                    {
                        const method = folder.compression & 0x0f;
                        if (method !== COMPRESSION.NONE && method !== COMPRESSION.MSZIP
                            && method !== COMPRESSION.LZX)
                        {
                            return fail(context, FDIERROR.BAD_COMPR_TYPE);
                        }
                    }
                    const info = await tell(fdintCABINET_INFO, block=>{
                        const view = new DataView(block.buffer);
                        view.setUint32(4, string(cabinet.next ?? ''), true);
                        view.setUint32(8, string(''), true);
                        view.setUint32(12, string(directory), true);
                        view.setUint32(16, user >>> 0, true);
                        view.setUint16(28, cabinet.setId, true);
                        view.setUint16(30, cabinet.index, true);
                    });
                    if (info === -1)
                    {
                        return fail(context, FDIERROR.USER_ABORT);
                    }
                    let aborted = false;
                    /** @type {number} */
                    let failure = FDIERROR.NONE;
                    await extractCabinet(source, async entry=>{
                        if (aborted)
                        {
                            return null;
                        }
                        const text = entry.name;
                        const destination = await tell(fdintCOPY_FILE, block=>{
                            const view = new DataView(block.buffer);
                            view.setInt32(0, entry.size, true);
                            view.setUint32(4, string(text), true);
                            view.setUint32(16, user >>> 0, true);
                            view.setUint16(24, entry.date, true);
                            view.setUint16(26, entry.time, true);
                            view.setUint16(28, entry.attributes & ~A_NAME_IS_UTF, true);
                            view.setUint16(30, cabinet.setId, true);
                            view.setUint16(32, cabinet.index, true);
                            view.setUint16(34, entry.folder, true);
                        });
                        if (destination === -1)
                        {
                            aborted = true;
                            failure = FDIERROR.USER_ABORT;
                            return null;
                        }
                        if (destination === 0)
                        {
                            return null;
                        }
                        return {
                            write: async(offset, bytes)=>{
                                void offset;
                                for (let at = 0; at < bytes.length; at += 32768)
                                {
                                    const part = bytes.subarray(at,
                                        Math.min(bytes.length, at + 32768));
                                    host.writeMemory(buffer, part);
                                    const wrote = (await host.call(context.write,
                                        [destination, buffer, part.length], thread)) >>> 0;
                                    if (wrote !== part.length)
                                    {
                                        throw new TargetError('the target would not take it');
                                    }
                                }
                            },
                            close: async()=>{
                                const answer = await tell(fdintCLOSE_FILE_INFO, block=>{
                                    const view = new DataView(block.buffer);
                                    view.setUint32(4, string(text), true);
                                    view.setUint32(16, user >>> 0, true);
                                    view.setInt32(20, destination, true);
                                    view.setUint16(24, entry.date, true);
                                    view.setUint16(26, entry.time, true);
                                    view.setUint16(28, entry.attributes & ~A_NAME_IS_UTF, true);
                                    view.setUint16(34, entry.folder, true);
                                });
                                if (answer === -1)
                                {
                                    aborted = true;
                                    failure = FDIERROR.USER_ABORT;
                                }
                            },
                        };
                    });
                    if (failure !== FDIERROR.NONE)
                    {
                        return fail(context, failure);
                    }
                    return 1;
                }
                catch (e){
                    if (e instanceof TargetError)
                    {
                        return fail(context, FDIERROR.TARGET_FILE);
                    }
                    if (e instanceof CabinetError)
                    {
                        return fail(context, e.kind === 'format' ? FDIERROR.NOT_A_CABINET
                            : errorOf(e.kind));
                    }
                    throw e;
                }
                finally
                {
                    host.free(buffer);
                    for (const block of strings)
                    {
                        host.free(Number(block));
                    }
                    source.release?.();
                    await host.call(context.close, [file], thread);
                }
            },
        },

        /** BOOL FDITruncateCabinet(HFDI hfdi, char *pszCabinetName, USHORT iFolderToDelete) */
        FDITruncateCabinet: {
            convention: 'cdecl',
            argBytes: 12,
            handler: ()=>{
                host.divergence?.('FDITruncateCabinet', 'a cabinet is not rewritten');
                return 0;
            },
        },
    };
}

/** The numbers a notification callback is called with, for its tests. */
export const FDINT = Object.freeze({
    CABINET_INFO: fdintCABINET_INFO, PARTIAL_FILE: fdintPARTIAL_FILE, COPY_FILE: fdintCOPY_FILE,
    CLOSE_FILE_INFO: fdintCLOSE_FILE_INFO, NEXT_CABINET: fdintNEXT_CABINET,
    ENUMERATE: fdintENUMERATE,
});
export { FDIERROR };
