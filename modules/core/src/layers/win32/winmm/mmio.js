/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Multimedia file I/O: a file on the volume walked as RIFF chunks.
 *
 * A chunk is a four-character id, a size, and for RIFF and LIST chunks a
 * form type; its data starts after the header and the next chunk starts
 * after the data, rounded up to an even offset. Descend reads a header where
 * the file stands or searches forward for one; ascend steps past the chunk it
 * was given. That is the whole of what a program reads a wave file with, and
 * the positions it sees are the file's own: what `mmioSeek` reports is where
 * the next read begins, chunk arithmetic included.
 *
 * Only files are opened here. The memory-file form (an `fccIOProc` of `MEM`)
 * and custom procedures are refused with the open error a caller checks for.
 */

const MMIO_READ = 0x0000;
const MMIO_WRITE = 0x0001;
const MMIO_READWRITE = 0x0002;
const MMIO_RWMODE = 0x0003;
const MMIO_CREATE = 0x1000;
const MMIO_EXIST = 0x4000;

const MMIO_FINDCHUNK = 0x0010;
const MMIO_FINDRIFF = 0x0020;
const MMIO_FINDLIST = 0x0040;

const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

const MMSYSERR_NOERROR = 0;
const MMSYSERR_INVALHANDLE = 5;
const MMIOERR_FILENOTFOUND = 257;
const MMIOERR_CANNOTOPEN = 260;
const MMIOERR_CHUNKNOTFOUND = 275;

/** MMIOINFO: where wErrorRet and fccIOProc live. */
const MMIOINFO_FCCIOPROC = 4;
const MMIOINFO_WERRORRET = 12;
const FOURCC_MEM = 0x204d454d; // 'MEM '

/** MMCKINFO, five dwords. */
const MMCKINFO_CKID = 0;
const MMCKINFO_CKSIZE = 4;
const MMCKINFO_FCCTYPE = 8;
const MMCKINFO_DWDATAOFFSET = 12;
const MMCKINFO_DWFLAGS = 16;
const MMCKINFO_SIZE = 20;

const FOURCC_RIFF = 0x46464952;
const FOURCC_LIST = 0x5453494c;

const MAX_PATH = 260;

/**
 * @typedef {Object} MmioHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {any} files  The volume: open, read, write, close, stat.
 */

/**
 * @typedef {Object} ChunkHeader
 * @property {number} id
 * @property {number} size
 * @property {number} type
 * @property {number} data
 * @property {number} after
 */

/**
 * @typedef {Object} MmioFile
 * @property {any} node
 * @property {string} path
 * @property {number} position
 */

/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>(bytes[at] | bytes[at + 1] << 8
    | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

/** @param {number} value */
const dword = value=>new Uint8Array([
    value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
]);

/**
 * Runs `next` on a value that may still be on its way, without turning a
 * value that is here into a promise: a chunk walk over a file the volume
 * already holds answers in the same call.
 *
 * @template T, R
 * @param {T | Promise<T>} value
 * @param {(value: T) => R | Promise<R>} next
 * @returns {R | Promise<R>}
 */
const then = (value, next)=>(typeof (/** @type {any} */ (value))?.then === 'function'
    ? /** @type {Promise<T>} */ (value).then(next)
    : next(/** @type {T} */ (value)));

/**
 * @param {MmioHost} host
 */
export function createMmioFunctions(host){
    /** @type {Map<number, MmioFile>} */
    const open = new Map();
    // Handles start well above zero, which is what a caller tests for.
    let nextHandle = 0x4000;

    /** @param {number} handle */
    const fileOf = handle=>open.get(handle >>> 0) ?? null;

    /** @param {MmioFile} file */
    const sizeOf = file=>host.files.stat(file.path)?.size ?? 0;

    /**
     * @param {MmioFile} file @param {number} at @param {number} length
     * @returns {Uint8Array | Promise<Uint8Array>}
     */
    const read = (file, at, length)=>host.files.read(file.node, at, length);

    /** @param {number} address @param {number} offset */
    const field = (address, offset)=>u32(host.readMemory(address + offset, 4), 0);

    /**
     * The next chunk header at a position: null when the file ends first.
     *
     * `data` is the chunk's data offset as MMCKINFO reports it -- for a RIFF
     * or LIST that is the form type, which the size counts -- and `after`
     * is where a reader stands once it has descended, past the form type.
     *
     * @param {MmioFile} file @param {number} at
     * @returns {Promise<ChunkHeader | null> | ChunkHeader | null}
     */
    const headerAt = (file, at)=>then(read(file, at, 12), bytes=>{
        if (bytes.length < 8)
        {
            return null;
        }
        const id = u32(bytes, 0);
        const size = u32(bytes, 4);
        const formed = id === FOURCC_RIFF || id === FOURCC_LIST;
        if (formed && bytes.length < 12)
        {
            return null;
        }
        return { id, size, type: formed ? u32(bytes, 8) : 0, data: at + 8,
            after: at + (formed ? 12 : 8) };
    });

    return {
        /**
         * HMMIO mmioOpenA(LPSTR szFilename, LPMMIOINFO lpmmioinfo, DWORD dwOpenFlags)
         *
         * Null when the file cannot be opened, with the reason in the
         * caller's MMIOINFO when it passed one.
         */
        mmioOpenA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, info, flags])=>{
                /** @param {number} error */
                const refuse = error=>{
                    if ((info >>> 0) !== 0)
                    {
                        host.writeMemory((info >>> 0) + MMIOINFO_WERRORRET, dword(error));
                    }
                    return 0;
                };
                if ((info >>> 0) !== 0 && field(info >>> 0, MMIOINFO_FCCIOPROC) === FOURCC_MEM)
                {
                    return refuse(MMIOERR_CANNOTOPEN);
                }
                if ((name >>> 0) === 0)
                {
                    return refuse(MMIOERR_FILENOTFOUND);
                }
                const path = host.readCString(name >>> 0, MAX_PATH);
                const mode = (flags >>> 0) & MMIO_RWMODE;
                if (((flags >>> 0) & MMIO_EXIST) !== 0)
                {
                    return host.files.stat(path) ? 1 : refuse(MMIOERR_FILENOTFOUND);
                }
                const node = host.files.open(path, {
                    read: mode === MMIO_READ || mode === MMIO_READWRITE,
                    write: mode === MMIO_WRITE || mode === MMIO_READWRITE,
                    create: ((flags >>> 0) & MMIO_CREATE) !== 0,
                    truncate: ((flags >>> 0) & MMIO_CREATE) !== 0,
                });
                if (!node)
                {
                    return refuse(MMIOERR_FILENOTFOUND);
                }
                const handle = nextHandle;
                nextHandle += 4;
                open.set(handle, { node, path, position: 0 });
                return handle;
            },
        },

        /** MMRESULT mmioClose(HMMIO hmmio, UINT wFlags) */
        mmioClose: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const file = fileOf(handle);
                if (!file)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                host.files.close(file.node);
                open.delete(handle >>> 0);
                return MMSYSERR_NOERROR;
            },
        },

        /**
         * LONG mmioRead(HMMIO hmmio, HPSTR pch, LONG cch)
         *
         * The bytes read, which is fewer than asked at the end of the file
         * and zero there; -1 for a handle that is not one.
         */
        mmioRead: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, buffer, count])=>{
                const file = fileOf(handle);
                if (!file)
                {
                    return -1;
                }
                const wanted = count | 0;
                if (wanted <= 0)
                {
                    return 0;
                }
                return then(read(file, file.position, wanted), bytes=>{
                    if (bytes.length > 0)
                    {
                        host.writeMemory(buffer >>> 0, bytes);
                    }
                    file.position += bytes.length;
                    return bytes.length;
                });
            },
        },

        /**
         * LONG mmioSeek(HMMIO hmmio, LONG lOffset, int iOrigin)
         *
         * The new position, which is what a program reads to learn where a
         * chunk's data starts; -1 for a seek before the start.
         */
        mmioSeek: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, offset, origin])=>{
                const file = fileOf(handle);
                if (!file)
                {
                    return -1;
                }
                const base = origin === SEEK_SET ? 0
                    : origin === SEEK_CUR ? file.position
                        : origin === SEEK_END ? sizeOf(file) : -1;
                const target = base + (offset | 0);
                if (base < 0 || target < 0)
                {
                    return -1;
                }
                file.position = target;
                return target;
            },
        },

        /**
         * MMRESULT mmioDescend(HMMIO hmmio, LPMMCKINFO lpck, const MMCKINFO *lpckParent,
         *   UINT wFlags)
         *
         * With no find flag, the chunk at the current position; with one, the
         * first chunk from here on whose id (or, for RIFF and LIST, whose
         * form type) matches, within the parent when one is given. Either way
         * the file is left at the chunk's data and the record says where
         * that is.
         */
        mmioDescend: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, info, parent, flags])=>{
                const file = fileOf(handle);
                if (!file)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                const find = (flags >>> 0) & (MMIO_FINDCHUNK | MMIO_FINDRIFF | MMIO_FINDLIST);
                const wanted = find === 0 ? 0 : field(info >>> 0,
                    find === MMIO_FINDCHUNK ? MMCKINFO_CKID : MMCKINFO_FCCTYPE);
                // Nothing lies past the parent's data: a search that ran on
                // would read the next sibling's chunks as the parent's.
                const limit = (parent >>> 0) === 0
                    ? Number.MAX_SAFE_INTEGER
                    : field(parent >>> 0, MMCKINFO_DWDATAOFFSET)
                        + field(parent >>> 0, MMCKINFO_CKSIZE);

                /** @param {number} at @returns {number | Promise<number>} */
                const walk = at=>{
                    if (at + 8 > limit)
                    {
                        return MMIOERR_CHUNKNOTFOUND;
                    }
                    return then(headerAt(file, at), header=>{
                        if (!header)
                        {
                            return MMIOERR_CHUNKNOTFOUND;
                        }
                        const matches = find === 0
                            || (find === MMIO_FINDCHUNK && header.id === wanted)
                            || (find === MMIO_FINDRIFF && header.id === FOURCC_RIFF
                                && header.type === wanted)
                            || (find === MMIO_FINDLIST && header.id === FOURCC_LIST
                                && header.type === wanted);
                        if (!matches)
                        {
                            return walk(header.data + header.size + (header.size & 1));
                        }
                        const record = new Uint8Array(MMCKINFO_SIZE);
                        record.set(dword(header.id), MMCKINFO_CKID);
                        record.set(dword(header.size), MMCKINFO_CKSIZE);
                        record.set(dword(header.type), MMCKINFO_FCCTYPE);
                        record.set(dword(header.data), MMCKINFO_DWDATAOFFSET);
                        record.set(dword(0), MMCKINFO_DWFLAGS);
                        host.writeMemory(info >>> 0, record);
                        file.position = header.after;
                        return MMSYSERR_NOERROR;
                    });
                };
                return walk(file.position);
            },
        },

        /**
         * MMRESULT mmioAscend(HMMIO hmmio, LPMMCKINFO lpck, UINT wFlags)
         *
         * Steps past the chunk, pad byte included. A chunk this build wrote
         * would have its size fixed up here; none is, so there is nothing to
         * write back.
         */
        mmioAscend: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, info])=>{
                const file = fileOf(handle);
                if (!file)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                const size = field(info >>> 0, MMCKINFO_CKSIZE);
                file.position = field(info >>> 0, MMCKINFO_DWDATAOFFSET) + size + (size & 1);
                return MMSYSERR_NOERROR;
            },
        },
    };
}
