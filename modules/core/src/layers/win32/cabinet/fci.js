/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * cabinet.dll's File Compression Interface: how a program makes a cabinet.
 *
 * As with FDI the program supplies every service -- memory, files, a
 * temporary file's name -- as C callbacks, and the library knows only the
 * format. FCIAddFile reads a file through the program's open-info, read and
 * close callbacks into the folder being filled; a change of compression, or
 * FCIFlushFolder, closes the folder; FCIFlushCabinet writes the cabinet to
 * CCAB's szCabPath and szCab through the program's open, write and close,
 * telling its file-placed callback of each file and its status callback of
 * each file and the cabinet. The folders are kept here rather than in the
 * program's temporary files, which nothing but the library reads.
 *
 * A cabinet is written uncompressed or MSZIP: each block "CK" and a raw
 * DEFLATE stream of up to 32 KiB, compressed by the platform's deflate-raw
 * (CompressionStream), with a checksum. A set of cabinets -- a folder
 * spilling into the next as CCAB's cb asks -- is not made: one cabinet
 * holds everything, and a cabinet larger than cb is reported.
 */

import { cabinetChecksum, COMPRESSION } from './cabinet.js';
import { encodeAnsi } from '../kernel32/locale.js';

/** FCIERR values an ERF's erfOper carries. */
export const FCIERR = Object.freeze({
    NONE: 0, OPEN_SRC: 1, READ_SRC: 2, ALLOC_FAIL: 3, TEMP_FILE: 4, BAD_COMPR_TYPE: 5,
    CAB_FILE: 6, USER_ABORT: 7, MCI_FAIL: 8, CAB_FORMAT_LIMIT: 9,
});

/** The progress callback's kinds. */
const statusFile = 0;
const statusFolder = 1;
const statusCabinet = 2;

/** An uncompressed CFDATA block's largest size, MSZIP's too. */
const BLOCK = 32768;

/** CCAB's fields (fci.h, packed to four): sizes, reserves, numbers, then the names. */
const CCAB = Object.freeze({ CB: 0, RESERVE_HEADER: 8, RESERVE_FOLDER: 12, RESERVE_DATA: 16,
    ICAB: 20, IDISK: 24, SETID: 32, DISK: 34, CAB: 290, CAB_PATH: 546, NAME: 256 });

/** _A_EXEC: the file is to be run when extracted. */
const A_EXEC = 0x40;

/** How the program is asked to open the cabinet: _O_RDWR | _O_CREAT | _O_TRUNC | _O_BINARY. */
const O_CABINET = 0x0002 | 0x0100 | 0x0200 | 0x8000;
/** _S_IREAD | _S_IWRITE. */
const S_READ_WRITE = 0x0100 | 0x0080;

/** How much of a file is read from the program, or written to it, in one callback. */
const CHUNK = 64 * 1024;

/**
 * @typedef {Object} CabinetFileSpec
 * @property {string} name @property {Uint8Array} data
 * @property {number} date @property {number} time @property {number} attribs
 *
 * @typedef {Object} CabinetFolderSpec
 * @property {number} compression  COMPRESSION.NONE or MSZIP.
 * @property {CabinetFileSpec[]} files
 *
 * @typedef {Object} CabinetSpec
 * @property {number} setID @property {number} iCabinet
 * @property {{ header: number, folder: number, data: number }} [reserve]
 * @property {CabinetFolderSpec[]} folders
 */

/**
 * One MSZIP block: "CK", then the bytes as a raw DEFLATE stream of its own.
 *
 * @param {Uint8Array} bytes
 */
async function mszipBlock(bytes){
    const stream = new Blob([bytes.slice()]).stream()
        .pipeThrough(new CompressionStream('deflate-raw'));
    const deflated = new Uint8Array(await new Response(stream).arrayBuffer());
    const block = new Uint8Array(deflated.length + 2);
    block.set([0x43, 0x4b]);
    block.set(deflated, 2);
    return block;
}

/** @param {number[]} values @param {number[]} widths */
const fields = (values, widths)=>{
    const bytes = new Uint8Array(widths.reduce((sum, width)=>sum + width, 0));
    const view = new DataView(bytes.buffer);
    let at = 0;
    values.forEach((value, index)=>{
        const width = widths[index];
        if (width === 4)
        {
            view.setUint32(at, value >>> 0, true);
        }
        else if (width === 2)
        {
            view.setUint16(at, value & 0xffff, true);
        }
        else
        {
            view.setUint8(at, value & 0xff);
        }
        at += width;
    });
    return bytes;
};

/**
 * A cabinet's bytes: its header, its folders, its files, and each folder's
 * data blocks, every block checksummed.
 *
 * @param {CabinetSpec} spec
 * @returns {Promise<Uint8Array>}
 */
export async function writeCabinet(spec){
    const reserve = spec.reserve ?? { header: 0, folder: 0, data: 0 };
    const reserved = reserve.header > 0 || reserve.folder > 0 || reserve.data > 0;
    const files = spec.folders.flatMap((folder, index)=>folder.files.map(file=>({ file, index })));
    /** @type {Uint8Array[][]} */
    const blocks = [];
    for (const folder of spec.folders)
    {
        const whole = new Uint8Array(folder.files.reduce((sum, file)=>sum + file.data.length, 0));
        let at = 0;
        for (const file of folder.files)
        {
            whole.set(file.data, at);
            at += file.data.length;
        }
        /** @type {Uint8Array[]} */
        const folderBlocks = [];
        for (let start = 0; start < whole.length; start += BLOCK)
        {
            const plain = whole.subarray(start, start + BLOCK);
            const packed = folder.compression === COMPRESSION.MSZIP ? await mszipBlock(plain)
                : plain;
            const header = fields([packed.length, plain.length], [2, 2]);
            const checksum = cabinetChecksum(new Uint8Array([...header,
                ...new Uint8Array(reserve.data)]), cabinetChecksum(packed, 0));
            folderBlocks.push(new Uint8Array([...fields([checksum], [4]), ...header,
                ...new Uint8Array(reserve.data), ...packed]));
        }
        blocks.push(folderBlocks);
    }
    const headerSize = 36 + (reserved ? 4 + reserve.header : 0);
    const folderSize = 8 + reserve.folder;
    const names = files.map(({ file })=>encodeAnsi(`${file.name}\0`));
    const filesAt = headerSize + folderSize * spec.folders.length;
    const dataAt = filesAt + names.reduce((sum, name)=>sum + 16 + name.length, 0);
    let place = dataAt;
    const folderEntries = blocks.map((folderBlocks, index)=>{
        const entry = new Uint8Array([...fields([place, folderBlocks.length,
            spec.folders[index].compression], [4, 2, 2]), ...new Uint8Array(reserve.folder)]);
        place += folderBlocks.reduce((sum, block)=>sum + block.length, 0);
        return entry;
    });
    const total = place;
    const offsets = new Map();
    const fileEntries = files.map(({ file, index }, at)=>{
        const offset = offsets.get(index) ?? 0;
        offsets.set(index, offset + file.data.length);
        return new Uint8Array([...fields([file.data.length, offset, index, file.date, file.time,
            file.attribs], [4, 4, 2, 2, 2, 2]), ...names[at]]);
    });
    const header = new Uint8Array([0x4d, 0x53, 0x43, 0x46, ...fields([0, total, 0, filesAt, 0,
        3, 1, spec.folders.length, files.length, reserved ? 0x4 : 0, spec.setID, spec.iCabinet],
    [4, 4, 4, 4, 4, 1, 1, 2, 2, 2, 2, 2]), ...(reserved ? [...fields([reserve.header,
        reserve.folder, reserve.data], [2, 1, 1]), ...new Uint8Array(reserve.header)] : [])]);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const part of [header, ...folderEntries, ...fileEntries, ...blocks.flat()])
    {
        bytes.set(part, at);
        at += part.length;
    }
    return bytes;
}

/**
 * @typedef {Object} FciHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {(entry: number, args: number[], thread?: any) => number | Promise<number>} call
 * @property {() => any} callerThread
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @typedef {Object} FciContext
 * @property {number} erf @property {number} placed @property {number} open
 * @property {number} read @property {number} write @property {number} close
 * @property {number} ccab  A copy of the program's CCAB, in guest memory.
 * @property {number} pv
 * @property {CabinetFolderSpec[]} folders  Closed folders.
 * @property {CabinetFolderSpec | null} folder  The one being filled.
 */

/**
 * @param {FciHost} host
 */
export function createFciFunctions(host){
    /** @type {Map<number, FciContext>} */
    const contexts = new Map();
    let next = 0x0fc10001;

    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>host.writeMemory(address >>> 0,
        new Uint8Array(Uint32Array.of(value >>> 0).buffer));
    /** @param {number} address */
    const readU16 = address=>new DataView(host.readMemory(address >>> 0, 2).slice().buffer)
        .getUint16(0, true);

    /**
     * The ERF the program gave: what went wrong, and FALSE.
     *
     * @param {number} erf @param {number} code @param {number} [type]  The C runtime's errno.
     */
    const fail = (erf, code, type = 0)=>{
        if ((erf >>> 0) !== 0)
        {
            writeU32(erf, code);
            writeU32(erf + 4, type);
            writeU32(erf + 8, code === FCIERR.NONE ? 0 : 1);
        }
        return 0;
    };

    /**
     * Guest memory for a call's buffers and strings, given back after it.
     */
    const scratch = ()=>{
        /** @type {number[]} */
        const held = [];
        return {
            /** @param {number} size */
            block(size){
                const at = host.allocate(Math.max(size, 4));
                if (!at)
                {
                    throw new Error('the guest heap has no room for an FCI buffer');
                }
                held.push(at);
                return at;
            },
            /** @param {string} text */
            string(text){
                const bytes = encodeAnsi(`${text}\0`);
                const at = this.block(bytes.length);
                host.writeMemory(at, bytes);
                return at;
            },
            release(){
                held.splice(0).forEach(at=>host.free(at));
            },
        };
    };

    /** The folder being filled closed, if there is one. @param {FciContext} context */
    const closeFolder = context=>{
        if (context.folder && context.folder.files.length > 0)
        {
            context.folders.push(context.folder);
        }
        context.folder = null;
    };

    /**
     * The cabinet written through the program's callbacks; the error, 0 for none.
     *
     * @param {FciContext} context @param {number} progress @param {any} thread
     */
    const flush = async(context, progress, thread)=>{
        closeFolder(context);
        const ccab = new DataView(host.readMemory(context.ccab, CCAB.CAB_PATH + CCAB.NAME)
            .slice().buffer);
        const cut = (/** @type {number} */ at)=>host.readCString(context.ccab + at, CCAB.NAME);
        const bytes = await writeCabinet({
            setID: ccab.getUint16(CCAB.SETID, true), iCabinet: ccab.getInt32(CCAB.ICAB, true),
            reserve: { header: ccab.getUint32(CCAB.RESERVE_HEADER, true),
                folder: ccab.getUint32(CCAB.RESERVE_FOLDER, true),
                data: ccab.getUint32(CCAB.RESERVE_DATA, true) },
            folders: context.folders,
        });
        if (bytes.length > ccab.getUint32(CCAB.CB, true))
        {
            host.divergence?.('FCIFlushCabinet', 'the cabinet is larger than CCAB.cb asks, '
                + 'and a set of cabinets is not made');
        }
        if ((progress >>> 0) !== 0
            && ((await host.call(progress, [statusCabinet, bytes.length, bytes.length,
                context.pv], thread)) | 0) === -1)
        {
            return FCIERR.USER_ABORT;
        }
        const memory = scratch();
        try
        {
            const err = memory.block(4);
            const file = (await host.call(context.open, [memory.string(cut(CCAB.CAB_PATH)
                + cut(CCAB.CAB)), O_CABINET, S_READ_WRITE, err, context.pv], thread)) | 0;
            if (file === -1)
            {
                return FCIERR.CAB_FILE;
            }
            const buffer = memory.block(CHUNK);
            for (let at = 0; at < bytes.length; at += CHUNK)
            {
                const part = bytes.subarray(at, at + CHUNK);
                host.writeMemory(buffer, part);
                const wrote = (await host.call(context.write, [file, buffer, part.length, err,
                    context.pv], thread)) | 0;
                if (wrote !== part.length)
                {
                    await host.call(context.close, [file, err, context.pv], thread);
                    return FCIERR.CAB_FILE;
                }
            }
            await host.call(context.close, [file, err, context.pv], thread);
            context.folders = [];
            return FCIERR.NONE;
        }
        finally
        {
            memory.release();
        }
    };

    /** @param {number} handle */
    const contextOf = handle=>contexts.get(handle >>> 0) ?? null;

    return {
        /**
         * HFCI FCICreate(PERF perf, PFNFCIFILEPLACED pfnfcifp, PFNFCIALLOC pfna,
         *     PFNFCIFREE pfnf, PFNFCIOPEN pfnopen, PFNFCIREAD pfnread, PFNFCIWRITE pfnwrite,
         *     PFNFCICLOSE pfnclose, PFNFCISEEK pfnseek, PFNFCIDELETE pfndelete,
         *     PFNFCIGETTEMPFILE pfnfcigtf, PCCAB pccab, void *pv)
         *
         * NULL for a missing callback or CCAB, with FCIERR_NONE in the ERF
         * and nothing more, as Windows answers it.
         */
        FCICreate: {
            convention: 'cdecl',
            argBytes: 52,
            /** @param {number[]} args */
            handler: ([erf, placed, alloc, free, open, read, write, close, seek, remove,
                temp, ccab, pv])=>{
                if ([placed, alloc, free, open, read, write, close, seek, remove, temp, ccab]
                    .some(entry=>(entry >>> 0) === 0) || (erf >>> 0) === 0)
                {
                    return fail(erf, FCIERR.NONE);
                }
                const copy = host.allocate(CCAB.CAB_PATH + CCAB.NAME);
                if (!copy)
                {
                    return fail(erf, FCIERR.ALLOC_FAIL);
                }
                host.writeMemory(copy, host.readMemory(ccab >>> 0, CCAB.CAB_PATH + CCAB.NAME)
                    .slice());
                const handle = next++;
                contexts.set(handle, { erf: erf >>> 0, placed: placed >>> 0, open: open >>> 0,
                    read: read >>> 0, write: write >>> 0, close: close >>> 0, ccab: copy,
                    pv: pv >>> 0, folders: [], folder: null });
                fail(erf, FCIERR.NONE);
                return handle;
            },
        },

        /**
         * BOOL FCIAddFile(HFCI hfci, char *pszSourceFile, char *pszFileName,
         *     BOOL fExecute, PFNFCIGETNEXTCABINET pfnfcignc, PFNFCISTATUS pfnfcis,
         *     PFNFCIGETOPENINFO pfnfcigoi, TCOMP typeCompress)
         *
         * The file read whole through the open-info, read and close
         * callbacks into the folder being filled -- a new one when the
         * compression differs -- and the file-placed callback told.
         */
        FCIAddFile: {
            convention: 'cdecl',
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([handle, sourcePointer, namePointer, execute, , progress, openInfo,
                compress])=>{
                const context = contextOf(handle);
                if (!context)
                {
                    return 0;
                }
                const compression = (compress >>> 0) & 0xf;
                if (compression !== COMPRESSION.NONE && compression !== COMPRESSION.MSZIP)
                {
                    host.divergence?.('FCIAddFile', 'only uncompressed and MSZIP folders are '
                        + 'made, not LZX or Quantum');
                    return fail(context.erf, FCIERR.BAD_COMPR_TYPE);
                }
                if ((sourcePointer >>> 0) === 0 || (namePointer >>> 0) === 0
                    || (openInfo >>> 0) === 0)
                {
                    return fail(context.erf, FCIERR.OPEN_SRC);
                }
                const name = host.readCString(namePointer >>> 0, 256);
                const thread = host.callerThread();
                return (async()=>{
                    const memory = scratch();
                    try
                    {
                        const date = memory.block(2);
                        const time = memory.block(2);
                        const attribs = memory.block(2);
                        const err = memory.block(4);
                        const file = (await host.call(openInfo >>> 0, [sourcePointer >>> 0, date,
                            time, attribs, err, context.pv], thread)) | 0;
                        if (file === -1)
                        {
                            return fail(context.erf, FCIERR.OPEN_SRC, readU32(err));
                        }
                        const buffer = memory.block(CHUNK);
                        /** @type {Uint8Array[]} */
                        const parts = [];
                        for (;;)
                        {
                            const got = (await host.call(context.read, [file, buffer, CHUNK, err,
                                context.pv], thread)) | 0;
                            if (got < 0)
                            {
                                await host.call(context.close, [file, err, context.pv], thread);
                                return fail(context.erf, FCIERR.READ_SRC, readU32(err));
                            }
                            if (got === 0)
                            {
                                break;
                            }
                            parts.push(host.readMemory(buffer, got).slice());
                        }
                        await host.call(context.close, [file, err, context.pv], thread);
                        const data = new Uint8Array(parts.reduce((sum, part)=>sum + part.length,
                            0));
                        parts.reduce((at, part)=>{
                            data.set(part, at);
                            return at + part.length;
                        }, 0);
                        if (context.folder && context.folder.compression !== compression)
                        {
                            closeFolder(context);
                        }
                        context.folder ??= { compression, files: [] };
                        context.folder.files.push({ name, data, date: readU16(date),
                            time: readU16(time),
                            attribs: readU16(attribs) | ((execute >>> 0) !== 0 ? A_EXEC : 0) });
                        if ((progress >>> 0) !== 0 && ((await host.call(progress >>> 0,
                            [statusFile, data.length, data.length, context.pv], thread)) | 0)
                            === -1)
                        {
                            return fail(context.erf, FCIERR.USER_ABORT);
                        }
                        await host.call(context.placed, [context.ccab, namePointer >>> 0,
                            data.length, 0, context.pv], thread);
                        fail(context.erf, FCIERR.NONE);
                        return 1;
                    }
                    finally
                    {
                        memory.release();
                    }
                })();
            },
        },

        /**
         * BOOL FCIFlushFolder(HFCI hfci, PFNFCIGETNEXTCABINET pfnfcignc,
         *     PFNFCISTATUS pfnfcis) -- the folder being filled closed; the next
         *     file starts another
         */
        FCIFlushFolder: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, , progress])=>{
                const context = contextOf(handle);
                if (!context)
                {
                    return 0;
                }
                closeFolder(context);
                if ((progress >>> 0) === 0)
                {
                    return 1;
                }
                const thread = host.callerThread();
                return Promise.resolve(host.call(progress >>> 0, [statusFolder, 0, 0,
                    context.pv], thread)).then(answer=>((answer | 0) === -1
                    ? fail(context.erf, FCIERR.USER_ABORT) : 1));
            },
        },

        /**
         * BOOL FCIFlushCabinet(HFCI hfci, BOOL fGetNextCab,
         *     PFNFCIGETNEXTCABINET pfnfcignc, PFNFCISTATUS pfnfcis)
         *
         * The cabinet written to CCAB's szCabPath and szCab through the
         * program's open, write and close.
         */
        FCIFlushCabinet: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, , , progress])=>{
                const context = contextOf(handle);
                if (!context)
                {
                    return 0;
                }
                const thread = host.callerThread();
                return flush(context, progress >>> 0, thread).then(code=>(code === FCIERR.NONE
                    ? (fail(context.erf, FCIERR.NONE), 1) : fail(context.erf, code)));
            },
        },

        /** BOOL FCIDestroy(HFCI hfci) */
        FCIDestroy: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const context = contextOf(handle);
                if (!context)
                {
                    return 0;
                }
                host.free(context.ccab);
                contexts.delete(handle >>> 0);
                return 1;
            },
        },
    };
}
