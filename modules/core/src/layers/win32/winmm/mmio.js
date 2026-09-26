/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Multimedia file I/O: a file walked as RIFF chunks, through a buffer the
 * program may reach into.
 *
 * A chunk is a four-character id, a size, and for RIFF and LIST chunks a
 * form type; its data starts after the header and the next chunk starts
 * after the data, rounded up to an even offset. Descend reads a header where
 * the file stands or searches forward for one; ascend steps past the chunk it
 * was given, and fixes up the size and the pad byte of one this handle wrote.
 * The positions a program sees are the file's own: what `mmioSeek` reports is
 * where the next read begins, chunk arithmetic included.
 *
 * Two kinds of file open. A DOS file is a file on the volume; a memory file
 * (an `fccIOProc` of `MEM `) is a block of guest memory, the caller's or one
 * mmio allocates, and the block is the whole file. Either may be buffered, and
 * the buffer is guest memory too: mmioGetInfo hands its pointers to the
 * program, which reads or writes at pchNext itself and calls mmioAdvance when
 * it meets the end -- the way a wave loader copies a data chunk out. So the
 * state below is the buffer's window on the file (where it starts, how much
 * of it holds file data, where the program stands in it, whether it holds
 * bytes the file does not have yet), and every call moves through it.
 *
 * Procedures a program installs are remembered by their code; opening a file
 * through one needs the program's own code run for every read, and is refused.
 */

const MMIO_READ = 0x0000;
const MMIO_WRITE = 0x0001;
const MMIO_READWRITE = 0x0002;
const MMIO_RWMODE = 0x0003;
const MMIO_CREATE = 0x1000;
const MMIO_PARSE = 0x0100;
const MMIO_DELETE = 0x0200;
const MMIO_EXIST = 0x4000;
const MMIO_ALLOCBUF = 0x10000;
const MMIO_GETTEMP = 0x20000;
const MMIO_DIRTY = 0x10000000;

/** The open flags that ask for something once rather than describe the file. */
const MMIO_ONCE = MMIO_CREATE | MMIO_PARSE | MMIO_DELETE | MMIO_EXIST | MMIO_ALLOCBUF
    | MMIO_GETTEMP;

const MMIO_FINDCHUNK = 0x0010;
const MMIO_FINDRIFF = 0x0020;
const MMIO_FINDLIST = 0x0040;
const MMIO_CREATERIFF = 0x0020;
const MMIO_CREATELIST = 0x0040;
const MMIO_TOUPPER = 0x0010;
const MMIO_INSTALLPROC = 0x10000;
const MMIO_REMOVEPROC = 0x20000;
const MMIO_FINDPROC = 0x40000;

/** What a buffer mmio allocates holds when the caller named no size. */
const MMIO_DEFAULTBUFFER = 8192;

const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

const MMSYSERR_NOERROR = 0;
const MMSYSERR_INVALHANDLE = 5;
const MMIOERR_FILENOTFOUND = 257;
const MMIOERR_OUTOFMEMORY = 258;
const MMIOERR_CANNOTOPEN = 260;
const MMIOERR_CANNOTWRITE = 262;
const MMIOERR_CANNOTEXPAND = 264;
const MMIOERR_UNBUFFERED = 266;
const MMIOERR_CHUNKNOTFOUND = 275;

/** MMIOINFO, eighteen dwords. */
const MMIOINFO = Object.freeze({
    dwFlags: 0,
    fccIOProc: 4,
    pIOProc: 8,
    wErrorRet: 12,
    cchBuffer: 20,
    pchBuffer: 24,
    pchNext: 28,
    pchEndRead: 32,
    pchEndWrite: 36,
    lBufOffset: 40,
    lDiskOffset: 44,
    adwInfo: 48,
    hmmio: 68,
    size: 72,
});

const FOURCC_DOS = 0x20534f44; // 'DOS '
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
 * @property {(bytes: number) => number} [allocate]
 *           Guest memory for a buffer mmio makes itself: the address, or 0
 *           when nothing fits. Absent in a build that cannot allocate, and a
 *           file that asked for such a buffer is opened unbuffered.
 * @property {(address: number) => void} [free]
 * @property {(api: string, detail: string) => void} [divergence]
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
 * An open file. For a memory file the buffer is the file, and `origin` stays
 * at zero with everything past `size` beyond its end.
 *
 * @typedef {Object} MmioFile
 * @property {number} handle
 * @property {boolean} memory
 * @property {any} node       The volume's open file, for a DOS file.
 * @property {string} path
 * @property {number} flags   The open flags as mmioGetInfo reports them.
 * @property {number} fcc
 * @property {number} buffer  pchBuffer, which may be set with no buffer behind it.
 * @property {number} size    cchBuffer: zero for an unbuffered file.
 * @property {boolean} owned  mmio allocated the buffer, and frees it.
 * @property {number} origin  lBufOffset: where in the file the buffer starts.
 * @property {number} next    Where the program stands in the buffer.
 * @property {number} end     How much of the buffer holds the file's bytes.
 * @property {boolean} dirty  The buffer holds bytes the file does not yet.
 * @property {number} disk    lDiskOffset: where the file itself stands.
 * @property {number[]} info  adwInfo; for a memory file, how much it grows by.
 */

/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>(bytes[at] | bytes[at + 1] << 8
    | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

/** @param {number} value */
const dword = value=>new Uint8Array([
    value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
]);

/**
 * The code up to four characters spell, padded with spaces.
 *
 * @param {string} name @param {boolean} upper
 */
const fourccOf = (name, upper)=>{
    const padded = (upper ? name.toUpperCase() : name).slice(0, 4).padEnd(4, ' ');
    return (padded.charCodeAt(0) | padded.charCodeAt(1) << 8
        | padded.charCodeAt(2) << 16 | padded.charCodeAt(3) << 24) >>> 0;
};

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

    /**
     * The procedures a program installed, by the code that names them.
     *
     * @type {Map<number, number>}
     */
    const procedures = new Map();

    /** @param {number} handle */
    const fileOf = handle=>open.get(handle >>> 0) ?? null;

    /** @param {number} address @param {number} offset */
    const field = (address, offset)=>u32(host.readMemory(address + offset, 4), 0);

    /** @param {MmioFile} file */
    const position = file=>file.origin + file.next;

    /** Whether the file goes through a buffer at all. @param {MmioFile} file */
    const buffered = file=>file.memory || file.size > 0;

    /** @param {MmioFile} file */
    const readOnly = file=>(file.flags & MMIO_RWMODE) === MMIO_READ;

    /**
     * Writes what the buffer holds and the file does not. The whole window
     * goes: what it read from the file comes back unchanged, and a program
     * that wrote at pchNext did so anywhere in it. A file opened only to be
     * read takes none of it.
     *
     * @param {MmioFile} file @returns {boolean} whether it all reached the file
     */
    const flush = file=>{
        if (!file.dirty || file.memory)
        {
            file.dirty = false;
            return true;
        }
        if (readOnly(file))
        {
            file.dirty = false;
            return false;
        }
        const length = Math.max(file.end, file.next);
        const written = length === 0 ? 0 : host.files.write(file.node, file.origin,
            host.readMemory(file.buffer, length).slice());
        file.dirty = false;
        file.disk = file.origin + written;
        return written === length;
    };

    /** @param {MmioFile} file */
    const sizeOf = file=>{
        if (file.memory)
        {
            return file.size;
        }
        flush(file);
        return host.files.stat(file.path)?.size ?? 0;
    };

    /**
     * Moves where the next read or write happens. A buffer whose window the
     * new position falls in is kept; otherwise it is written out and starts
     * again, empty, where the file now stands.
     *
     * @param {MmioFile} file @param {number} target
     */
    const moveTo = (file, target)=>{
        if (file.memory)
        {
            file.next = target;
            return;
        }
        if (file.size > 0 && target >= file.origin && target <= file.origin + file.end)
        {
            file.next = target - file.origin;
            return;
        }
        flush(file);
        file.origin = target;
        file.next = 0;
        file.end = 0;
        file.disk = target;
    };

    /**
     * Bytes of the file at an offset, the buffer's unwritten ones included,
     * without moving through it.
     *
     * @param {MmioFile} file @param {number} at @param {number} length
     * @returns {Uint8Array | Promise<Uint8Array>}
     */
    const peek = (file, at, length)=>{
        if (file.memory)
        {
            const count = Math.max(0, Math.min(length, file.size - at));
            return host.readMemory(file.buffer + at, count).slice();
        }
        flush(file);
        return host.files.read(file.node, at, length);
    };

    /**
     * Refills the buffer from where the program stands, once what it held
     * has been written out.
     *
     * @param {MmioFile} file @returns {number | Promise<number>} the bytes it now holds
     */
    const refill = file=>{
        const at = position(file);
        file.origin = at;
        file.next = 0;
        file.end = 0;
        return then(host.files.read(file.node, at, file.size), bytes=>{
            if (bytes.length > 0)
            {
                host.writeMemory(file.buffer, bytes);
            }
            file.end = bytes.length;
            file.disk = at + bytes.length;
            return bytes.length;
        });
    };

    /**
     * Makes a memory file big enough for a write, when it may grow: only a
     * block mmio allocated can be replaced by a larger one, and only by the
     * increment the caller named in adwInfo[0].
     *
     * @param {MmioFile} file @param {number} needed
     */
    const expand = (file, needed)=>{
        const step = file.info[0];
        if (needed <= file.size)
        {
            return true;
        }
        if (!file.owned || step === 0 || !host.allocate)
        {
            return false;
        }
        const size = file.size + Math.ceil((needed - file.size) / step) * step;
        const block = host.allocate(size) >>> 0;
        if (block === 0)
        {
            return false;
        }
        if (file.size > 0)
        {
            host.writeMemory(block, host.readMemory(file.buffer, file.size).slice());
        }
        host.free?.(file.buffer);
        file.buffer = block;
        file.size = size;
        return true;
    };

    /**
     * Reads where the program stands and moves it on: out of the buffer while
     * it has bytes, around it for a read at least as large as it, and through
     * a refill otherwise.
     *
     * @param {MmioFile} file @param {number} wanted
     * @returns {Uint8Array | Promise<Uint8Array>}
     */
    const take = (file, wanted)=>{
        if (file.memory)
        {
            const bytes = peek(file, file.next, wanted);
            file.next += /** @type {Uint8Array} */ (bytes).length;
            return bytes;
        }
        if (!buffered(file))
        {
            return then(host.files.read(file.node, file.origin, wanted), bytes=>{
                file.origin += bytes.length;
                file.disk = file.origin;
                return bytes;
            });
        }
        /** @type {Uint8Array[]} */
        const pieces = [];
        let left = wanted;
        const joined = ()=>{
            const all = new Uint8Array(wanted - left);
            let at = 0;
            for (const piece of pieces)
            {
                all.set(piece, at);
                at += piece.length;
            }
            return all;
        };
        /** @returns {Uint8Array | Promise<Uint8Array>} */
        const step = ()=>{
            while (left > 0)
            {
                const available = file.end - file.next;
                if (available > 0)
                {
                    const count = Math.min(available, left);
                    pieces.push(host.readMemory(file.buffer + file.next, count).slice());
                    file.next += count;
                    left -= count;
                    continue;
                }
                if (!flush(file))
                {
                    break;
                }
                if (left >= file.size)
                {
                    const at = position(file);
                    return then(host.files.read(file.node, at, left), bytes=>{
                        pieces.push(bytes);
                        left -= bytes.length;
                        file.origin = at + bytes.length;
                        file.next = 0;
                        file.end = 0;
                        file.disk = file.origin;
                        return joined();
                    });
                }
                return then(refill(file), count=>(count === 0 ? joined() : step()));
            }
            return joined();
        };
        return step();
    };

    /**
     * Writes where the program stands and moves it on.
     *
     * @param {MmioFile} file @param {Uint8Array} bytes
     * @returns {number} how many were taken, which is fewer only when the
     *          file cannot hold them
     */
    const put = (file, bytes)=>{
        if (readOnly(file))
        {
            return 0;
        }
        if (file.memory)
        {
            const fits = expand(file, file.next + bytes.length)
                ? bytes.length : Math.max(0, file.size - file.next);
            if (fits > 0)
            {
                host.writeMemory(file.buffer + file.next, bytes.subarray(0, fits));
            }
            file.next += fits;
            return fits;
        }
        if (!buffered(file))
        {
            const written = host.files.write(file.node, file.origin, bytes);
            file.origin += written;
            file.disk = file.origin;
            return written;
        }
        let done = 0;
        while (done < bytes.length)
        {
            const room = file.size - file.next;
            if (room === 0)
            {
                if (!flush(file))
                {
                    break;
                }
                file.origin = position(file);
                file.next = 0;
                file.end = 0;
                continue;
            }
            const count = Math.min(room, bytes.length - done);
            host.writeMemory(file.buffer + file.next, bytes.subarray(done, done + count));
            file.next += count;
            file.end = Math.max(file.end, file.next);
            file.dirty = true;
            done += count;
        }
        return done;
    };

    /**
     * The MMIOINFO mmioGetInfo hands out: the buffer's pointers as the program
     * may use them directly.
     *
     * @param {MmioFile} file
     */
    const describe = file=>{
        const bytes = new Uint8Array(MMIOINFO.size);
        const view = new DataView(bytes.buffer);
        /** @param {number} offset @param {number} value */
        const set = (offset, value)=>view.setUint32(offset, value >>> 0, true);
        set(MMIOINFO.dwFlags, file.flags | (file.dirty ? MMIO_DIRTY : 0));
        set(MMIOINFO.fccIOProc, file.fcc);
        set(MMIOINFO.cchBuffer, file.size);
        set(MMIOINFO.pchBuffer, file.buffer);
        set(MMIOINFO.pchNext, file.buffer + file.next);
        set(MMIOINFO.pchEndRead, file.buffer + (file.memory ? file.size : file.end));
        set(MMIOINFO.pchEndWrite, file.buffer + file.size);
        set(MMIOINFO.lBufOffset, file.origin);
        set(MMIOINFO.lDiskOffset, file.memory ? 0 : file.disk);
        file.info.forEach((value, index)=>set(MMIOINFO.adwInfo + index * 4, value));
        set(MMIOINFO.hmmio, file.handle);
        return bytes;
    };

    /**
     * Takes back what a program did to the buffer through the pointers it was
     * given: where it now stands, and whether it wrote.
     *
     * @param {MmioFile} file @param {number} record
     */
    const adopt = (file, record)=>{
        const next = field(record, MMIOINFO.pchNext) - file.buffer;
        file.next = Math.max(0, Math.min(file.size, next));
        if ((field(record, MMIOINFO.dwFlags) & MMIO_DIRTY) !== 0)
        {
            file.dirty = true;
            file.end = Math.max(file.end, file.next);
        }
    };

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
    const headerAt = (file, at)=>then(peek(file, at, 12), bytes=>{
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

    /** @param {number} address @param {ChunkHeader} header @param {number} flags */
    const writeChunk = (address, header, flags)=>{
        const record = new Uint8Array(MMCKINFO_SIZE);
        record.set(dword(header.id), MMCKINFO_CKID);
        record.set(dword(header.size), MMCKINFO_CKSIZE);
        record.set(dword(header.type), MMCKINFO_FCCTYPE);
        record.set(dword(header.data), MMCKINFO_DWDATAOFFSET);
        record.set(dword(flags), MMCKINFO_DWFLAGS);
        host.writeMemory(address, record);
    };

    /**
     * mmioOpen for either width, once the name is read: null for a memory
     * file, which has none.
     *
     * @param {string | null} path @param {number} info @param {number} flags
     */
    const openFile = (path, info, flags)=>{
        const record = info >>> 0;
        /** @param {number} error */
        const refuse = error=>{
            if (record !== 0)
            {
                host.writeMemory(record + MMIOINFO.wErrorRet, dword(error));
            }
            return 0;
        };
        const fcc = record === 0 ? 0 : field(record, MMIOINFO.fccIOProc);
        const proc = record === 0 ? 0 : field(record, MMIOINFO.pIOProc);
        const memory = fcc === FOURCC_MEM;
        // A compound name, `archive.xyz+member`, names its procedure by the
        // extension before the last `+`.
        const compound = path?.includes('+')
            ? /\.([^.\\/+]{1,4})$/.exec(path.slice(0, path.lastIndexOf('+')))?.[1] ?? null
            : null;
        if (proc !== 0 || (fcc !== 0 && fcc !== FOURCC_DOS && !memory)
            || (fcc === 0 && compound !== null && procedures.has(fourccOf(compound, true))))
        {
            host.divergence?.('mmioOpen', 'a file through a program\'s own I/O procedure');
            return refuse(MMIOERR_CANNOTOPEN);
        }
        if (procedures.has(memory ? FOURCC_MEM : FOURCC_DOS))
        {
            host.divergence?.('mmioOpen', 'the built-in procedure is used, not the one the '
                + 'program installed in its place');
        }
        let node = null;
        if (!memory)
        {
            if (path === null)
            {
                return refuse(MMIOERR_FILENOTFOUND);
            }
            if ((flags & MMIO_EXIST) !== 0)
            {
                return host.files.stat(path) ? 1 : refuse(MMIOERR_FILENOTFOUND);
            }
            const mode = flags & MMIO_RWMODE;
            node = host.files.open(path, {
                read: mode === MMIO_READ || mode === MMIO_READWRITE,
                write: mode === MMIO_WRITE || mode === MMIO_READWRITE,
                create: (flags & MMIO_CREATE) !== 0,
                truncate: (flags & MMIO_CREATE) !== 0,
            });
            if (!node)
            {
                return refuse(MMIOERR_FILENOTFOUND);
            }
        }

        // The buffer: the caller's when it gave one with a size, one mmio
        // makes when it gave a size and no buffer or asked for one, none
        // otherwise -- the pointer it passed is still reported.
        let buffer = record === 0 ? 0 : field(record, MMIOINFO.pchBuffer);
        let size = record === 0 ? 0 : field(record, MMIOINFO.cchBuffer);
        let owned = false;
        const allocating = (size > 0 && buffer === 0)
            || (size === 0 && (flags & MMIO_ALLOCBUF) !== 0);
        if (allocating && host.allocate)
        {
            size ||= MMIO_DEFAULTBUFFER;
            buffer = host.allocate(size) >>> 0;
            if (buffer === 0)
            {
                if (node)
                {
                    host.files.close(node);
                }
                return refuse(MMIOERR_OUTOFMEMORY);
            }
            owned = true;
        }
        else if (allocating && memory)
        {
            return refuse(MMIOERR_OUTOFMEMORY);
        }
        else if (allocating)
        {
            size = 0;
        }

        const handle = nextHandle;
        nextHandle += 4;
        open.set(handle, {
            handle,
            memory,
            node,
            path: path ?? '',
            flags: flags & ~MMIO_ONCE | (owned ? MMIO_ALLOCBUF : 0),
            fcc: memory ? FOURCC_MEM : FOURCC_DOS,
            buffer,
            size,
            owned,
            origin: 0,
            next: 0,
            end: 0,
            dirty: false,
            disk: 0,
            info: [0, 1, 2].map(index=>(record === 0 ? 0
                : field(record, MMIOINFO.adwInfo + index * 4))),
        });
        if (record !== 0)
        {
            host.writeMemory(record + MMIOINFO.wErrorRet, dword(MMSYSERR_NOERROR));
        }
        return handle;
    };

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
            handler: ([name, info, flags])=>openFile(
                (name >>> 0) === 0 ? null : host.readCString(name >>> 0, MAX_PATH),
                info, flags >>> 0),
        },

        /** HMMIO mmioOpenW(LPWSTR szFilename, LPMMIOINFO lpmmioinfo, DWORD dwOpenFlags) */
        mmioOpenW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, info, flags])=>{
                let path = null;
                // A piece at a time, so a short name near the end of what is
                // mapped is not read past.
                for (let at = name >>> 0; at !== 0 && (path ?? '').length < MAX_PATH; at += 64)
                {
                    const bytes = host.readMemory(at, 64);
                    path ??= '';
                    let unit = 1;
                    for (let index = 0; index + 1 < bytes.length && unit !== 0; index += 2)
                    {
                        unit = bytes[index] | bytes[index + 1] << 8;
                        path += unit === 0 ? '' : String.fromCharCode(unit);
                    }
                    if (unit === 0)
                    {
                        break;
                    }
                }
                return openFile(path, info, flags >>> 0);
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
                const written = flush(file);
                if (file.node)
                {
                    host.files.close(file.node);
                }
                if (file.owned)
                {
                    host.free?.(file.buffer);
                }
                open.delete(handle >>> 0);
                return written ? MMSYSERR_NOERROR : MMIOERR_CANNOTWRITE;
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
                if ((count | 0) <= 0)
                {
                    return 0;
                }
                return then(take(file, count | 0), bytes=>{
                    if (bytes.length > 0)
                    {
                        host.writeMemory(buffer >>> 0, bytes);
                    }
                    return bytes.length;
                });
            },
        },

        /**
         * LONG mmioWrite(HMMIO hmmio, const char *pch, LONG cch)
         *
         * The bytes written; -1 for a handle that is not one or a file opened
         * only to be read.
         */
        mmioWrite: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, buffer, count])=>{
                const file = fileOf(handle);
                if (!file || (file.flags & MMIO_RWMODE) === MMIO_READ)
                {
                    return -1;
                }
                if ((count | 0) <= 0)
                {
                    return 0;
                }
                return put(file, host.readMemory(buffer >>> 0, count | 0).slice());
            },
        },

        /**
         * LONG mmioSeek(HMMIO hmmio, LONG lOffset, int iOrigin)
         *
         * The new position, which is what a program reads to learn where a
         * chunk's data starts; -1 for a seek before the start. SEEK_END counts
         * the offset back from the end, as mmio's own tests find it does.
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
                const target = origin === SEEK_SET ? offset | 0
                    : origin === SEEK_CUR ? position(file) + (offset | 0)
                        : origin === SEEK_END ? sizeOf(file) - (offset | 0) : -1;
                if (target < 0)
                {
                    return -1;
                }
                moveTo(file, target);
                return target;
            },
        },

        /**
         * MMRESULT mmioGetInfo(HMMIO hmmio, LPMMIOINFO lpmmioinfo, UINT wFlags)
         * MMRESULT mmioSetInfo(HMMIO hmmio, LPCMMIOINFO lpmmioinfo, UINT wFlags)
         *
         * The buffer's pointers out to the program, and back: between the
         * two it reads and writes the buffer itself, and nothing here knows
         * until mmioSetInfo or mmioAdvance is told.
         */
        mmioGetInfo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, record])=>{
                const file = fileOf(handle);
                if (!file)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                host.writeMemory(record >>> 0, describe(file));
                return MMSYSERR_NOERROR;
            },
        },
        mmioSetInfo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, record])=>{
                const file = fileOf(handle);
                if (!file)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                adopt(file, record >>> 0);
                return MMSYSERR_NOERROR;
            },
        },

        /**
         * MMRESULT mmioAdvance(HMMIO hmmio, LPMMIOINFO lpmmioinfo, UINT wFlags)
         *
         * The program has reached the end of the buffer it was reading or
         * writing directly: what it wrote goes to the file, the buffer moves
         * on to where it stands, and for reading is filled from there. At
         * the end of the file the buffer comes back empty, which is how the
         * program learns there is no more. A memory file has no more to
         * read, and grows for writing when it can.
         */
        mmioAdvance: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, record, flags])=>{
                const file = fileOf(handle);
                if (!file)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                if (!buffered(file))
                {
                    return MMIOERR_UNBUFFERED;
                }
                if ((record >>> 0) !== 0)
                {
                    adopt(file, record >>> 0);
                }
                /** @param {number} result */
                const answer = result=>{
                    if ((record >>> 0) !== 0)
                    {
                        host.writeMemory(record >>> 0, describe(file));
                    }
                    return result;
                };
                const writing = ((flags >>> 0) & MMIO_WRITE) !== 0;
                if (file.memory)
                {
                    return answer(!writing || file.next < file.size
                        || expand(file, file.size + 1) ? MMSYSERR_NOERROR : MMIOERR_CANNOTEXPAND);
                }
                if (!flush(file))
                {
                    return answer(MMIOERR_CANNOTWRITE);
                }
                file.origin = position(file);
                file.next = 0;
                file.end = 0;
                file.disk = file.origin;
                return writing ? answer(MMSYSERR_NOERROR)
                    : then(refill(file), ()=>answer(MMSYSERR_NOERROR));
            },
        },

        /**
         * MMRESULT mmioDescend(HMMIO hmmio, LPMMCKINFO lpck, const MMCKINFO *lpckParent,
         *   UINT wFlags)
         *
         * With no find flag, the chunk at the current position; with one, the
         * first chunk from here on whose id (or, for RIFF and LIST, whose
         * form type) matches -- a zero one matching any -- within the parent
         * when one is given. Either way the file is left at the chunk's data
         * and the record says where that is; a search that finds nothing
         * leaves the last header it read in the record.
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

                /** @param {number} value */
                const is = value=>wanted === 0 || value === wanted;
                /**
                 * @param {number} at @param {ChunkHeader | null} last
                 * @returns {number | Promise<number>}
                 */
                const walk = (at, last)=>{
                    /** @param {ChunkHeader | null} seen */
                    const notFound = seen=>{
                        if (seen)
                        {
                            writeChunk(info >>> 0, seen, 0);
                        }
                        return MMIOERR_CHUNKNOTFOUND;
                    };
                    if (at + 8 > limit)
                    {
                        return notFound(last);
                    }
                    return then(headerAt(file, at), header=>{
                        if (!header)
                        {
                            return notFound(last);
                        }
                        const matches = find === 0
                            || (find === MMIO_FINDCHUNK && is(header.id))
                            || (find === MMIO_FINDRIFF && header.id === FOURCC_RIFF
                                && is(header.type))
                            || (find === MMIO_FINDLIST && header.id === FOURCC_LIST
                                && is(header.type));
                        if (!matches)
                        {
                            return walk(header.data + header.size + (header.size & 1), header);
                        }
                        writeChunk(info >>> 0, header, 0);
                        moveTo(file, header.after);
                        return MMSYSERR_NOERROR;
                    });
                };
                return walk(position(file), null);
            },
        },

        /**
         * MMRESULT mmioAscend(HMMIO hmmio, LPMMCKINFO lpck, UINT wFlags)
         *
         * Steps past the chunk, pad byte included. A chunk mmioCreateChunk
         * made here (MMIO_DIRTY in its record) ends where the program stands:
         * its size is written into its header if it is not what the header
         * says, and a pad byte after odd-sized data.
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
                const record = info >>> 0;
                const data = field(record, MMCKINFO_DWDATAOFFSET);
                if ((field(record, MMCKINFO_DWFLAGS) & MMIO_DIRTY) === 0)
                {
                    const size = field(record, MMCKINFO_CKSIZE);
                    moveTo(file, data + size + (size & 1));
                    return MMSYSERR_NOERROR;
                }
                const end = position(file);
                const size = end - data;
                if (size !== field(record, MMCKINFO_CKSIZE))
                {
                    moveTo(file, data - 4);
                    if (put(file, dword(size)) !== 4)
                    {
                        return MMIOERR_CANNOTWRITE;
                    }
                    host.writeMemory(record + MMCKINFO_CKSIZE, dword(size));
                }
                moveTo(file, end);
                if ((size & 1) !== 0 && put(file, new Uint8Array(1)) !== 1)
                {
                    return MMIOERR_CANNOTWRITE;
                }
                return MMSYSERR_NOERROR;
            },
        },

        /**
         * MMRESULT mmioCreateChunk(HMMIO hmmio, LPMMCKINFO lpck, UINT wFlags)
         *
         * Writes a chunk header where the file stands -- a RIFF or LIST with
         * its form type when asked for one -- and marks the record so that
         * mmioAscend fixes the size once the data is written.
         */
        mmioCreateChunk: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, info, flags])=>{
                const file = fileOf(handle);
                if (!file)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                const record = info >>> 0;
                const kind = (flags >>> 0) & (MMIO_CREATERIFF | MMIO_CREATELIST);
                const id = kind === MMIO_CREATERIFF ? FOURCC_RIFF
                    : kind === MMIO_CREATELIST ? FOURCC_LIST : field(record, MMCKINFO_CKID);
                const start = position(file);
                const header = [...dword(id), ...dword(field(record, MMCKINFO_CKSIZE)),
                    ...(kind === 0 ? [] : dword(field(record, MMCKINFO_FCCTYPE)))];
                if (put(file, Uint8Array.from(header)) !== header.length)
                {
                    return MMIOERR_CANNOTWRITE;
                }
                host.writeMemory(record + MMCKINFO_CKID, dword(id));
                host.writeMemory(record + MMCKINFO_DWDATAOFFSET, dword(start + 8));
                host.writeMemory(record + MMCKINFO_DWFLAGS, dword(MMIO_DIRTY));
                return MMSYSERR_NOERROR;
            },
        },

        /**
         * FOURCC mmioStringToFOURCCA(LPCSTR sz, UINT uFlags)
         *
         * Up to four characters, padded with spaces; MMIO_TOUPPER upper-cases
         * them first.
         */
        mmioStringToFOURCCA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([text, flags])=>fourccOf((text >>> 0) === 0 ? ''
                : host.readCString(text >>> 0, 4), ((flags >>> 0) & MMIO_TOUPPER) !== 0),
        },

        /**
         * LPMMIOPROC mmioInstallIOProcA(FOURCC fccIOProc, LPMMIOPROC pIOProc, DWORD dwFlags)
         *
         * The table itself: installing answers the procedure, finding and
         * removing answer the one installed, or null. A file opened through
         * one is refused (see mmioOpen), so installing it changes no answer
         * a file already open gives.
         */
        mmioInstallIOProcA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([fcc, proc, flags])=>{
                const code = fcc >>> 0;
                const installed = procedures.get(code) ?? 0;
                if (((flags >>> 0) & MMIO_INSTALLPROC) !== 0)
                {
                    if ((proc >>> 0) === 0)
                    {
                        return 0;
                    }
                    procedures.set(code, proc >>> 0);
                    return proc >>> 0;
                }
                if (((flags >>> 0) & MMIO_REMOVEPROC) !== 0)
                {
                    procedures.delete(code);
                    return installed;
                }
                return ((flags >>> 0) & MMIO_FINDPROC) !== 0 ? installed : 0;
            },
        },
    };
}
