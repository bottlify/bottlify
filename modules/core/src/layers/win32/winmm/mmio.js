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
 * Two kinds of file open. A DOS file is a file on the volume, by its name or
 * by the handle of one the program already has open; a memory file
 * (an `fccIOProc` of `MEM `) is a block of guest memory, the caller's or one
 * mmio allocates, and the block is the whole file. Either may be buffered, and
 * the buffer is guest memory too: mmioGetInfo hands its pointers to the
 * program, which reads or writes at pchNext itself and calls mmioAdvance when
 * it meets the end -- the way a wave loader copies a data chunk out. So the
 * state below is the buffer's window on the file (where it starts, how much
 * of it holds file data, where the program stands in it, whether it holds
 * bytes the file does not have yet), and every call moves through it.
 *
 * A file may also be the program's own: an I/O procedure it installed under
 * a code, named by a compound name's extension (`archive.xyz+member`), or
 * handed in the MMIOINFO. The buffer and the position are mmio's as for any
 * file, and what reaches the file itself is a message to the procedure --
 * MMIOM_OPEN, READ, WRITE, WRITEFLUSH, SEEK and CLOSE -- run as a call into
 * the program's code. The procedure is handed an MMIOINFO of mmio's own in
 * guest memory, whose adwInfo and lDiskOffset are the procedure's to keep:
 * where it stands is where it says it stands, and a seek goes first whenever
 * that is not where the bytes are.
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
const MMIO_EMPTYBUF = 0x0010;
const MMIO_FHOPEN = 0x0010;
const MMIO_INSTALLPROC = 0x10000;
const MMIO_REMOVEPROC = 0x20000;
const MMIO_FINDPROC = 0x40000;

/** What a buffer mmio allocates holds when the caller named no size. */
const MMIO_DEFAULTBUFFER = 8192;

/** The messages an I/O procedure is sent. */
const MMIOM_READ = 0;
const MMIOM_WRITE = 1;
const MMIOM_SEEK = 2;
const MMIOM_OPEN = 3;
const MMIOM_CLOSE = 4;
const MMIOM_WRITEFLUSH = 5;
const MMIOM_RENAME = 6;
/** Where a program's own messages to its procedure start. */
const MMIOM_USER = 0x8000;

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
const MMIOERR_ACCESSDENIED = 268;
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
 * @property {{ file: (handle: number) => { path: string, node: any, position: number } | null,
 *              close: (handle: number) => boolean }} [handles]
 *           kernel32's file handles, for a file a program opened itself and
 *           hands mmio by its handle. Absent, no such file opens.
 * @property {(bytes: number) => number} [allocate]
 *           Guest memory for a buffer mmio makes itself: the address, or 0
 *           when nothing fits. Absent in a build that cannot allocate, and a
 *           file that asked for such a buffer is opened unbuffered.
 * @property {(address: number) => void} [free]
 * @property {(entry: number, args: number[], thread?: unknown) => Promise<number>} [call]
 *           A stdcall into the program's code: how its own I/O procedure is
 *           sent a message. The thread names whose call a message answers.
 *           Absent, a file through such a procedure is refused.
 * @property {() => unknown} [callerThread]  Whose call is being handled.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * A procedure a program's file goes through: its code, and whether it takes
 * the name MMIOM_OPEN hands it as UTF-16.
 *
 * @typedef {Object} Procedure
 * @property {number} entry
 * @property {boolean} wide
 */

/**
 * Where a file's bytes are, for any file but a memory file: the volume, or a
 * procedure of the program's. Each may answer with a promise.
 *
 * @typedef {Object} FileStore
 * @property {(at: number, length: number) => Uint8Array | Promise<Uint8Array>} read
 *           Short at the end of the file, and empty past it or on a failure.
 * @property {(at: number, bytes: Uint8Array, flushing: boolean) => number | Promise<number>}
 *           write  How many were taken. `flushing` for a buffer written out
 *           because the program asked, which a procedure is told.
 * @property {() => number | Promise<number>} size  -1 when it cannot be learned.
 * @property {() => void} release  Lets go of what the store holds itself.
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
 * An open file. For a memory file the buffer is the file, `origin` stays at
 * zero, and `end` is how much of the block the file fills: all of it as
 * opened, none of a block mmioSetBuffer puts in its place until it is written.
 *
 * @typedef {Object} MmioFile
 * @property {number} handle
 * @property {boolean} memory
 * @property {any} node       The volume's open file, for a DOS file.
 * @property {number} hfile   The program's own handle the file was opened by,
 *                            which it shares; zero for a file mmio opened.
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
 * @property {FileStore | null} store  Null for a memory file.
 * @property {Procedure | null} procedure  The program's, when the file is its.
 * @property {number} record  The MMIOINFO the procedure is handed, whose
 *                            adwInfo and lDiskOffset are the procedure's.
 * @property {unknown} caller  Whose call on the file is being answered.
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
 * A name as a terminated string of either width. Narrowed, a character with
 * no single-byte form becomes a question mark.
 *
 * @param {string} text @param {boolean} wide
 */
const encode = (text, wide)=>{
    const bytes = new Uint8Array((text.length + 1) * (wide ? 2 : 1));
    for (let index = 0; index < text.length; index++)
    {
        const unit = text.charCodeAt(index);
        if (wide)
        {
            bytes[index * 2] = unit & 0xff;
            bytes[index * 2 + 1] = unit >>> 8;
        }
        else
        {
            bytes[index] = unit > 0xff ? 0x3f : unit;
        }
    }
    return bytes;
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
 * Runs steps written as a generator, each yielding a value that may still be
 * on its way, the same way: in the same call for as long as every value is
 * here, and as a promise from the first that is not -- which a file through
 * the program's own procedure always is, its every answer being the
 * program's code run.
 *
 * @template R
 * @param {Generator<any, R, any>} steps
 * @returns {R | Promise<R>}
 */
const drive = steps=>{
    /**
     * @param {() => IteratorResult<any, R>} resume
     * @returns {R | Promise<R>}
     */
    const advance = resume=>{
        for (let next = resume(); ; next = steps.next(next.value))
        {
            if (next.done)
            {
                return next.value;
            }
            if (typeof next.value?.then === 'function')
            {
                return next.value.then(
                    (/** @type {any} */ value)=>advance(()=>steps.next(value)),
                    (/** @type {any} */ error)=>advance(()=>steps.throw(error)));
            }
        }
    };
    return advance(()=>steps.next());
};

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
     * @type {Map<number, Procedure>}
     */
    const procedures = new Map();

    /**
     * The file a handle names. A procedure's messages go out on the thread
     * whose call is being answered, which is only known before anything is
     * awaited -- so it is taken here, where every entry point starts.
     *
     * @param {number} handle
     */
    const fileOf = handle=>{
        const file = open.get(handle >>> 0) ?? null;
        if (file?.procedure)
        {
            file.caller = host.callerThread?.() ?? null;
        }
        return file;
    };

    /** @param {number} address @param {number} offset */
    const field = (address, offset)=>u32(host.readMemory(address + offset, 4), 0);

    /**
     * A UTF-16 string, read a piece at a time so a short one near the end of
     * what is mapped is not read past.
     *
     * @param {number} address @param {number} limit
     */
    const wideAt = (address, limit)=>{
        let text = '';
        for (let at = address; text.length < limit; at += 64)
        {
            const bytes = host.readMemory(at, 64);
            for (let index = 0; index + 1 < bytes.length; index += 2)
            {
                const unit = bytes[index] | bytes[index + 1] << 8;
                if (unit === 0)
                {
                    return text.slice(0, limit);
                }
                text += String.fromCharCode(unit);
            }
            if (bytes.length < 64)
            {
                break;
            }
        }
        return text.slice(0, limit);
    };

    /** @param {MmioFile} file */
    const position = file=>file.origin + file.next;

    /** Whether the file goes through a buffer at all. @param {MmioFile} file */
    const buffered = file=>file.memory || file.size > 0;

    /** @param {MmioFile} file */
    const readOnly = file=>(file.flags & MMIO_RWMODE) === MMIO_READ;

    /** @param {MmioFile} file */
    const storeOf = file=>/** @type {FileStore} */ (file.store);

    /**
     * Writes what the buffer holds and the file does not. The whole window
     * goes: what it read from the file comes back unchanged, and a program
     * that wrote at pchNext did so anywhere in it. A file opened only to be
     * read takes none of it.
     *
     * @param {MmioFile} file @param {boolean} [flushing]  The program asked.
     * @returns {boolean | Promise<boolean>} whether it all reached the file
     */
    const flush = (file, flushing = false)=>{
        if (!file.dirty || file.memory)
        {
            file.dirty = false;
            return true;
        }
        file.dirty = false;
        if (readOnly(file))
        {
            return false;
        }
        const at = file.origin;
        const length = Math.max(file.end, file.next);
        if (length === 0)
        {
            file.disk = at;
            return true;
        }
        return then(storeOf(file).write(at, host.readMemory(file.buffer, length).slice(),
            flushing), written=>{
            file.disk = at + written;
            return written === length;
        });
    };

    /**
     * How long the file is, what the buffer holds included; -1 when a
     * procedure cannot say.
     *
     * @param {MmioFile} file @returns {number | Promise<number>}
     */
    const sizeOf = file=>{
        if (file.memory)
        {
            return file.end;
        }
        return then(flush(file), ()=>storeOf(file).size());
    };

    /**
     * Moves where the next read or write happens. A buffer whose window the
     * new position falls in is kept; otherwise it is written out and starts
     * again, empty, where the file now stands.
     *
     * @param {MmioFile} file @param {number} target
     * @returns {void | Promise<void>}
     */
    const moveTo = (file, target)=>{
        if (file.memory)
        {
            file.next = target;
            return undefined;
        }
        if (file.size > 0 && target >= file.origin && target <= file.origin + file.end)
        {
            file.next = target - file.origin;
            return undefined;
        }
        return then(flush(file), ()=>{
            file.origin = target;
            file.next = 0;
            file.end = 0;
            file.disk = target;
        });
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
            const count = Math.max(0, Math.min(length, file.end - at));
            return host.readMemory(file.buffer + at, count).slice();
        }
        return then(flush(file), ()=>storeOf(file).read(at, length));
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
        return then(storeOf(file).read(at, file.size), bytes=>{
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
     * @returns {Generator<any, Uint8Array, any>}
     */
    function* taking(file, wanted){
        if (file.memory)
        {
            const bytes = /** @type {Uint8Array} */ (peek(file, file.next, wanted));
            file.next += bytes.length;
            return bytes;
        }
        if (!buffered(file))
        {
            /** @type {Uint8Array} */
            const bytes = yield storeOf(file).read(file.origin, wanted);
            file.origin += bytes.length;
            file.disk = file.origin;
            return bytes;
        }
        /** @type {Uint8Array[]} */
        const pieces = [];
        let left = wanted;
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
            if (!(yield flush(file)))
            {
                break;
            }
            if (left >= file.size)
            {
                const at = position(file);
                /** @type {Uint8Array} */
                const bytes = yield storeOf(file).read(at, left);
                pieces.push(bytes);
                left -= bytes.length;
                file.origin = at + bytes.length;
                file.next = 0;
                file.end = 0;
                file.disk = file.origin;
                break;
            }
            if ((yield refill(file)) === 0)
            {
                break;
            }
        }
        const all = new Uint8Array(wanted - left);
        let at = 0;
        for (const piece of pieces)
        {
            all.set(piece, at);
            at += piece.length;
        }
        return all;
    }

    /** @param {MmioFile} file @param {number} wanted */
    const take = (file, wanted)=>drive(taking(file, wanted));

    /**
     * Writes where the program stands and moves it on, answering how many
     * bytes were taken -- fewer only when the file cannot hold them.
     *
     * @param {MmioFile} file @param {Uint8Array} bytes
     * @returns {Generator<any, number, any>}
     */
    function* putting(file, bytes){
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
            file.end = Math.max(file.end, file.next);
            return fits;
        }
        if (!buffered(file))
        {
            /** @type {number} */
            const written = yield storeOf(file).write(file.origin, bytes, false);
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
                if (!(yield flush(file)))
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
    }

    /** @param {MmioFile} file @param {Uint8Array} bytes */
    const put = (file, bytes)=>drive(putting(file, bytes));

    /**
     * The MMIOINFO mmioGetInfo hands out: the buffer's pointers as the program
     * may use them directly. Of a file through the program's procedure,
     * adwInfo and lDiskOffset are what the procedure keeps in its own.
     *
     * @param {MmioFile} file
     */
    const describe = file=>{
        const bytes = new Uint8Array(MMIOINFO.size);
        const view = new DataView(bytes.buffer);
        /** @param {number} offset @param {number} value */
        const set = (offset, value)=>view.setUint32(offset, value >>> 0, true);
        const kept = file.procedure !== null;
        set(MMIOINFO.dwFlags, file.flags | (file.dirty ? MMIO_DIRTY : 0));
        set(MMIOINFO.fccIOProc, file.fcc);
        set(MMIOINFO.pIOProc, file.procedure?.entry ?? 0);
        set(MMIOINFO.cchBuffer, file.size);
        set(MMIOINFO.pchBuffer, file.buffer);
        set(MMIOINFO.pchNext, file.buffer + file.next);
        set(MMIOINFO.pchEndRead, file.buffer + file.end);
        set(MMIOINFO.pchEndWrite, file.buffer + file.size);
        set(MMIOINFO.lBufOffset, file.origin);
        set(MMIOINFO.lDiskOffset, file.memory ? 0
            : kept ? field(file.record, MMIOINFO.lDiskOffset) : file.disk);
        file.info.forEach((value, index)=>set(MMIOINFO.adwInfo + index * 4,
            kept ? field(file.record, MMIOINFO.adwInfo + index * 4) : value));
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
     * Brings the MMIOINFO a procedure is handed up to date with mmio's side
     * of it: everything but what the procedure keeps there itself (adwInfo,
     * lDiskOffset) and the reserved words.
     *
     * @param {MmioFile} file
     */
    const sync = file=>{
        const info = describe(file);
        host.writeMemory(file.record, info.subarray(0, MMIOINFO.lDiskOffset));
        host.writeMemory(file.record + MMIOINFO.hmmio, info.subarray(MMIOINFO.hmmio));
    };

    /**
     * Sends the file's procedure a message, as a call into the program's
     * code on the thread whose call on the file is being answered.
     *
     * @param {MmioFile} file @param {number} message
     * @param {number} first @param {number} second
     * @returns {Promise<number>} the procedure's answer, signed
     */
    const ask = (file, message, first, second)=>{
        const call = /** @type {NonNullable<MmioHost['call']>} */ (host.call);
        const procedure = /** @type {Procedure} */ (file.procedure);
        return call(procedure.entry, [file.record, message, first >>> 0, second >>> 0],
            file.caller).then(answer=>answer | 0);
    };

    /**
     * @param {MmioFile} file @param {number} message
     * @param {number} first @param {number} second
     */
    const send = (file, message, first, second)=>{
        sync(file);
        return ask(file, message, first, second);
    };

    /**
     * The store of a file through the program's procedure. Bytes pass
     * through guest memory of mmio's own, and before each read or write the
     * procedure is sent to where they are, unless it says it is there.
     *
     * @param {MmioFile} file
     * @returns {FileStore}
     */
    const procedureStore = file=>{
        let scratch = 0;
        let room = 0;
        /** Guest memory for at least `length` bytes; 0 if none. @param {number} length */
        const space = length=>{
            if (length > room)
            {
                if (scratch !== 0)
                {
                    host.free?.(scratch);
                }
                scratch = (host.allocate?.(length) ?? 0) >>> 0;
                room = scratch === 0 ? 0 : length;
            }
            return scratch;
        };
        /** @param {number} at @returns {number | Promise<number>} where it now stands */
        const reach = at=>(field(file.record, MMIOINFO.lDiskOffset) === at ? at
            : send(file, MMIOM_SEEK, at, SEEK_SET));
        /**
         * @param {number} at @param {number} length
         * @returns {Generator<any, Uint8Array, any>}
         */
        function* reading(at, length){
            const buffer = length > 0 ? space(length) : 0;
            if (buffer === 0 || (yield reach(at)) !== at)
            {
                return new Uint8Array(0);
            }
            /** @type {number} */
            const count = yield send(file, MMIOM_READ, buffer, length);
            return count > 0 ? host.readMemory(buffer, Math.min(count, length)).slice()
                : new Uint8Array(0);
        }
        /**
         * @param {number} at @param {Uint8Array} bytes @param {boolean} flushing
         * @returns {Generator<any, number, any>}
         */
        function* writing(at, bytes, flushing){
            const buffer = bytes.length > 0 ? space(bytes.length) : 0;
            if (buffer === 0 || (yield reach(at)) !== at)
            {
                return 0;
            }
            host.writeMemory(buffer, bytes);
            /** @type {number} */
            const count = yield send(file, flushing ? MMIOM_WRITEFLUSH : MMIOM_WRITE,
                buffer, bytes.length);
            return Math.max(0, Math.min(count, bytes.length));
        }
        return {
            read: (at, length)=>drive(reading(at, length)),
            write: (at, bytes, flushing)=>drive(writing(at, bytes, flushing)),
            // The end is where a seek to it lands. The procedure is left
            // there, which the next read or write moves it on from.
            size: ()=>send(file, MMIOM_SEEK, 0, SEEK_END),
            release: ()=>{
                if (scratch !== 0)
                {
                    host.free?.(scratch);
                }
                scratch = 0;
                room = 0;
            },
        };
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
     * Which procedure a file is the program's through, for mmioOpen and
     * mmioRename alike: one handed in the MMIOINFO, one installed under the
     * code it names, or under the extension of a compound name
     * (`archive.xyz+member`, the extension before the last `+`); null for
     * the built-in ones.
     *
     * @param {string | null} path @param {number} record  The caller's MMIOINFO, or 0.
     * @param {boolean} wide  The width of the call.
     */
    const procedureFor = (path, record, wide)=>{
        const fcc = record === 0 ? 0 : field(record, MMIOINFO.fccIOProc);
        const proc = record === 0 ? 0 : field(record, MMIOINFO.pIOProc);
        const memory = fcc === FOURCC_MEM;
        const compound = path?.includes('+')
            ? /\.([^.\\/+]{1,4})$/.exec(path.slice(0, path.lastIndexOf('+')))?.[1] ?? null
            : null;
        const named = fcc === 0 && compound !== null ? fourccOf(compound, true) : fcc;
        /** @type {Procedure | null} */
        const procedure = proc !== 0 ? { entry: proc, wide }
            : named !== FOURCC_DOS && !memory ? procedures.get(named) ?? null : null;
        return { fcc, memory, named, procedure };
    };

    /**
     * mmioOpen for either width, once the name is read: null for a memory
     * file, which has none, and for one opened by a handle.
     *
     * @param {string | null} path @param {number} info @param {number} flags
     * @param {boolean} wide  The width of the call, which a procedure handed
     *                        in the MMIOINFO takes its name in.
     * @returns {number | Promise<number>}
     */
    const openFile = (path, info, flags, wide)=>{
        const record = info >>> 0;
        /** @param {number} error */
        const refuse = error=>{
            if (record !== 0)
            {
                host.writeMemory(record + MMIOINFO.wErrorRet, dword(error));
            }
            return 0;
        };
        const { fcc, memory, named, procedure } = procedureFor(path, record, wide);
        if (procedure === null && fcc !== 0 && fcc !== FOURCC_DOS && !memory)
        {
            return refuse(MMIOERR_CANNOTOPEN);
        }
        if (procedure === null && procedures.has(memory ? FOURCC_MEM : FOURCC_DOS))
        {
            host.divergence?.('mmioOpen', 'the built-in procedure is used, not the one the '
                + 'program installed in its place');
        }
        if (procedure !== null && !host.call)
        {
            host.divergence?.('mmioOpen', 'a file through a program\'s own I/O procedure, '
                + 'which this build cannot call');
            return refuse(MMIOERR_CANNOTOPEN);
        }

        let node = null;
        // With no name and no procedure, adwInfo[0] is a file the program
        // already has open, and it is read from where its handle stands.
        let hfile = 0;
        let start = 0;
        if (procedure === null && !memory && path === null)
        {
            hfile = record === 0 ? 0 : field(record, MMIOINFO.adwInfo);
            const shared = hfile === 0 ? null : host.handles?.file(hfile) ?? null;
            if (!shared)
            {
                return refuse(MMIOERR_FILENOTFOUND);
            }
            node = shared.node;
            path = shared.path;
            start = shared.position;
        }
        else if (procedure === null && !memory)
        {
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
        // What a procedure is handed: an MMIOINFO of its own, and the name
        // in the width it takes -- the one it was installed by, or for one
        // handed in the MMIOINFO, the one mmioOpen was called by.
        let own = 0;
        let name = 0;
        if (procedure !== null)
        {
            own = (host.allocate?.(MMIOINFO.size) ?? 0) >>> 0;
            const text = path === null ? null : encode(path, procedure.wide);
            name = own === 0 || text === null ? 0 : (host.allocate?.(text.length) ?? 0) >>> 0;
            if (own === 0 || (text !== null && name === 0))
            {
                if (own !== 0)
                {
                    host.free?.(own);
                }
                return refuse(MMIOERR_OUTOFMEMORY);
            }
            host.writeMemory(own, new Uint8Array(MMIOINFO.size));
            if (text !== null)
            {
                host.writeMemory(name, text);
            }
        }
        /** Lets go of what was taken for a file that does not open after all. */
        const abandon = ()=>{
            if (node && hfile === 0)
            {
                host.files.close(node);
            }
            for (const block of [own, name])
            {
                if (block !== 0)
                {
                    host.free?.(block);
                }
            }
        };

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
                abandon();
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
        /** @type {MmioFile} */
        const file = {
            handle,
            memory,
            node,
            hfile,
            path: path ?? '',
            flags: flags & ~MMIO_ONCE | (owned ? MMIO_ALLOCBUF : 0),
            fcc: memory ? FOURCC_MEM : procedure === null ? FOURCC_DOS : named,
            buffer,
            size,
            owned,
            origin: start,
            next: 0,
            end: memory ? size : 0,
            dirty: false,
            disk: start,
            info: [0, 1, 2].map(index=>(record === 0 ? 0
                : field(record, MMIOINFO.adwInfo + index * 4))),
            store: null,
            procedure,
            record: own,
            caller: procedure === null ? null : host.callerThread?.() ?? null,
        };
        /** @param {number} result */
        const opened = result=>{
            if (result !== MMSYSERR_NOERROR)
            {
                return refuse(result);
            }
            open.set(handle, file);
            if (record !== 0)
            {
                host.writeMemory(record + MMIOINFO.wErrorRet, dword(MMSYSERR_NOERROR));
            }
            return handle;
        };
        if (procedure === null)
        {
            file.store = memory ? null : {
                read: (at, length)=>host.files.read(node, at, length),
                write: (at, bytes)=>host.files.write(node, at, bytes),
                size: ()=>host.files.stat(file.path)?.size ?? 0,
                release: ()=>{},
            };
            return opened(MMSYSERR_NOERROR);
        }

        // The procedure starts from what the caller put in adwInfo, and
        // sees the flags mmioOpen was given, those that ask for something
        // once included.
        file.info.forEach((value, index)=>
            host.writeMemory(own + MMIOINFO.adwInfo + index * 4, dword(value)));
        const store = procedureStore(file);
        file.store = store;
        sync(file);
        host.writeMemory(own + MMIOINFO.dwFlags, dword(flags));
        return ask(file, MMIOM_OPEN, name, 0).then(result=>{
            if (name !== 0)
            {
                host.free?.(name);
            }
            if (result !== MMSYSERR_NOERROR)
            {
                store.release();
                host.free?.(own);
                if (owned)
                {
                    host.free?.(buffer);
                }
            }
            return opened(result);
        });
    };

    /**
     * mmioInstallIOProc, for either width: a procedure installed by the wide
     * call is handed a UTF-16 name.
     *
     * @param {boolean} wide
     */
    const install = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [fcc, proc, flags])=>{
            const code = fcc >>> 0;
            const installed = procedures.get(code)?.entry ?? 0;
            if (((flags >>> 0) & MMIO_INSTALLPROC) !== 0)
            {
                if ((proc >>> 0) === 0)
                {
                    return 0;
                }
                procedures.set(code, { entry: proc >>> 0, wide });
                return proc >>> 0;
            }
            if (((flags >>> 0) & MMIO_REMOVEPROC) !== 0)
            {
                procedures.delete(code);
                return installed;
            }
            return ((flags >>> 0) & MMIO_FINDPROC) !== 0 ? installed : 0;
        },
    });

    /**
     * mmioRename for either width, once the names are read: a file on the
     * volume renamed there, or the program's procedure sent MMIOM_RENAME
     * with both names, in an MMIOINFO of its own, its answer the call's.
     *
     * @param {string} from @param {string} to @param {number} info @param {boolean} wide
     * @returns {number | Promise<number>}
     */
    const renameFile = (from, to, info, wide)=>{
        const record = info >>> 0;
        const { fcc, memory, named, procedure } = procedureFor(from, record, wide);
        if (procedure === null)
        {
            if (memory)
            {
                return MMIOERR_FILENOTFOUND;
            }
            if (fcc !== 0 && fcc !== FOURCC_DOS)
            {
                return MMIOERR_CANNOTOPEN;
            }
            if (from === '' || !host.files.stat(from))
            {
                return MMIOERR_FILENOTFOUND;
            }
            return host.files.rename(from, to) ? MMSYSERR_NOERROR : MMIOERR_ACCESSDENIED;
        }
        const call = host.call;
        if (!call)
        {
            host.divergence?.('mmioRename', 'a file through a program\'s own I/O procedure, '
                + 'which this build cannot call');
            return MMIOERR_CANNOTOPEN;
        }
        const blocks = [MMIOINFO.size, ...[from, to].map(name=>encode(name, procedure.wide))]
            .map(what=>{
                const bytes = typeof what === 'number' ? new Uint8Array(what) : what;
                const block = (host.allocate?.(bytes.length) ?? 0) >>> 0;
                if (block !== 0)
                {
                    host.writeMemory(block, bytes);
                }
                return block;
            });
        const release = ()=>blocks.forEach(block=>{
            if (block !== 0)
            {
                host.free?.(block);
            }
        });
        if (blocks.includes(0))
        {
            release();
            return MMIOERR_OUTOFMEMORY;
        }
        const [own, oldName, newName] = blocks;
        host.writeMemory(own + MMIOINFO.fccIOProc, dword(named));
        host.writeMemory(own + MMIOINFO.pIOProc, dword(procedure.entry));
        if (record !== 0)
        {
            host.writeMemory(own + MMIOINFO.adwInfo,
                host.readMemory(record + MMIOINFO.adwInfo, 12).slice());
        }
        return call(procedure.entry, [own, MMIOM_RENAME, oldName, newName],
            host.callerThread?.() ?? undefined).then(answer=>{
            release();
            return answer | 0;
        });
    };

    /**
     * mmioSetBuffer's work once the old buffer is written: the new one
     * starts empty where the file stands.
     *
     * @param {MmioFile} file @param {number} pointer @param {number} size
     */
    const replaceBuffer = (file, pointer, size)=>{
        let buffer = pointer;
        const owned = size > 0 && buffer === 0;
        if (owned)
        {
            buffer = (host.allocate?.(size) ?? 0) >>> 0;
            if (buffer === 0)
            {
                return MMIOERR_OUTOFMEMORY;
            }
        }
        if (file.owned)
        {
            host.free?.(file.buffer);
        }
        const at = position(file);
        file.buffer = buffer;
        file.size = size;
        file.owned = owned;
        file.flags = file.flags & ~MMIO_ALLOCBUF | (owned ? MMIO_ALLOCBUF : 0);
        file.origin = file.memory ? 0 : at;
        file.disk = file.origin;
        file.next = 0;
        file.end = 0;
        return MMSYSERR_NOERROR;
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
                info, flags >>> 0, false),
        },

        /** HMMIO mmioOpenW(LPWSTR szFilename, LPMMIOINFO lpmmioinfo, DWORD dwOpenFlags) */
        mmioOpenW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, info, flags])=>openFile(
                (name >>> 0) === 0 ? null : wideAt(name >>> 0, MAX_PATH), info, flags >>> 0,
                true),
        },

        /**
         * MMRESULT mmioClose(HMMIO hmmio, UINT wFlags)
         *
         * A file opened by the program's own handle closes that handle too,
         * unless MMIO_FHOPEN keeps it open for the program -- standing where
         * mmio left the file, as a handle mmio read through would. A file
         * through the program's procedure is closed by it, and answers what
         * it answers once the buffer is written.
         */
        mmioClose: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, flags])=>{
                const file = fileOf(handle);
                if (!file)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                open.delete(handle >>> 0);
                return drive((function* (){
                    const written = yield flush(file, true);
                    let answer = MMSYSERR_NOERROR;
                    if (file.procedure)
                    {
                        answer = yield send(file, MMIOM_CLOSE, flags, 0);
                        file.store?.release();
                        host.free?.(file.record);
                    }
                    else if (file.hfile !== 0 && ((flags >>> 0) & MMIO_FHOPEN) !== 0)
                    {
                        const shared = host.handles?.file(file.hfile);
                        if (shared)
                        {
                            shared.position = file.disk;
                        }
                    }
                    else if (file.hfile !== 0)
                    {
                        host.handles?.close(file.hfile);
                    }
                    else if (file.node)
                    {
                        host.files.close(file.node);
                    }
                    if (file.owned)
                    {
                        host.free?.(file.buffer);
                    }
                    return written ? answer : MMIOERR_CANNOTWRITE;
                })());
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
                return drive((function* (){
                    let target = -1;
                    if (origin === SEEK_SET)
                    {
                        target = offset | 0;
                    }
                    else if (origin === SEEK_CUR)
                    {
                        target = position(file) + (offset | 0);
                    }
                    else if (origin === SEEK_END)
                    {
                        /** @type {number} */
                        const size = yield sizeOf(file);
                        target = size < 0 ? -1 : size - (offset | 0);
                    }
                    if (target < 0)
                    {
                        return -1;
                    }
                    yield moveTo(file, target);
                    return target;
                })());
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
                return drive((function* (){
                    if (!(yield flush(file)))
                    {
                        return answer(MMIOERR_CANNOTWRITE);
                    }
                    file.origin = position(file);
                    file.next = 0;
                    file.end = 0;
                    file.disk = file.origin;
                    if (!writing)
                    {
                        yield refill(file);
                    }
                    return answer(MMSYSERR_NOERROR);
                })());
            },
        },

        /**
         * MMRESULT mmioSetBuffer(HMMIO hmmio, LPSTR pchBuffer, LONG cchBuffer, UINT wFlags)
         *
         * What the buffer holds is written first, and the new one starts
         * empty where the file stands: the caller's when it gives a pointer,
         * one mmio makes when it gives a size and no pointer (freeing any it
         * made before), none for no size -- a pointer given with no size is
         * still reported, as mmioOpen reports it. A memory file's block is
         * the file, so a memory file given another is a new, empty one.
         */
        mmioSetBuffer: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, pointer, count])=>{
                const file = fileOf(handle);
                if (!file)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                return then(flush(file), written=>(written
                    ? replaceBuffer(file, pointer >>> 0, count >>> 0) : MMIOERR_CANNOTWRITE));
            },
        },

        /**
         * MMRESULT mmioFlush(HMMIO hmmio, UINT fuFlush)
         *
         * Writes what the buffer holds that the file does not, and keeps it
         * unless MMIO_EMPTYBUF asks for the buffer to start again, empty,
         * where the file stands. A memory file has nothing to write, and its
         * block is the file, so it is never emptied.
         */
        mmioFlush: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, flags])=>{
                const file = fileOf(handle);
                if (!file)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                return then(flush(file, true), written=>{
                    if (!written)
                    {
                        return MMIOERR_CANNOTWRITE;
                    }
                    if (((flags >>> 0) & MMIO_EMPTYBUF) !== 0 && !file.memory)
                    {
                        file.origin = position(file);
                        file.next = 0;
                        file.end = 0;
                    }
                    return MMSYSERR_NOERROR;
                });
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
                        return then(moveTo(file, header.after), ()=>MMSYSERR_NOERROR);
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
                return drive((function* (){
                    const data = field(record, MMCKINFO_DWDATAOFFSET);
                    if ((field(record, MMCKINFO_DWFLAGS) & MMIO_DIRTY) === 0)
                    {
                        const size = field(record, MMCKINFO_CKSIZE);
                        yield moveTo(file, data + size + (size & 1));
                        return MMSYSERR_NOERROR;
                    }
                    const end = position(file);
                    const size = end - data;
                    if (size !== field(record, MMCKINFO_CKSIZE))
                    {
                        yield moveTo(file, data - 4);
                        if ((yield put(file, dword(size))) !== 4)
                        {
                            return MMIOERR_CANNOTWRITE;
                        }
                        host.writeMemory(record + MMCKINFO_CKSIZE, dword(size));
                    }
                    yield moveTo(file, end);
                    if ((size & 1) !== 0 && (yield put(file, new Uint8Array(1))) !== 1)
                    {
                        return MMIOERR_CANNOTWRITE;
                    }
                    return MMSYSERR_NOERROR;
                })());
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
                return then(put(file, Uint8Array.from(header)), written=>{
                    if (written !== header.length)
                    {
                        return MMIOERR_CANNOTWRITE;
                    }
                    host.writeMemory(record + MMCKINFO_CKID, dword(id));
                    host.writeMemory(record + MMCKINFO_DWDATAOFFSET, dword(start + 8));
                    host.writeMemory(record + MMCKINFO_DWFLAGS, dword(MMIO_DIRTY));
                    return MMSYSERR_NOERROR;
                });
            },
        },

        /**
         * LRESULT mmioSendMessage(HMMIO hmmio, UINT uMsg, LPARAM lParam1, LPARAM lParam2)
         *
         * A message to the file's procedure, answered by it: the way a
         * program reaches its own procedure with messages of its own,
         * MMIOM_USER and up. The built-in procedures recognise none of
         * those, and answer zero as a procedure does for a message it does
         * not know; mmio's own messages are not to be sent this way, and a
         * built-in procedure is not moved by one.
         */
        mmioSendMessage: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, message, first, second])=>{
                const file = fileOf(handle);
                if (!file)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                if (file.procedure)
                {
                    return send(file, message >>> 0, first, second);
                }
                if ((message >>> 0) < MMIOM_USER)
                {
                    host.divergence?.('mmioSendMessage', 'one of mmio\'s own messages, sent to '
                        + 'a built-in procedure, is not acted on');
                }
                return 0;
            },
        },

        /**
         * MMRESULT mmioRenameA(LPCSTR pszFileName, LPCSTR pszNewFileName,
         *   LPCMMIOINFO pmmioinfo, DWORD fdwRename)
         * MMRESULT mmioRenameW(LPCWSTR, LPCWSTR, LPCMMIOINFO, DWORD)
         *
         * Zero once renamed; MMIOERR_FILENOTFOUND for a file that is not
         * there, as MMIOM_RENAME is documented to answer, and
         * MMIOERR_ACCESSDENIED when the volume will not rename it.
         */
        mmioRenameA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([from, to, info])=>renameFile(
                (from >>> 0) === 0 ? '' : host.readCString(from >>> 0, MAX_PATH),
                (to >>> 0) === 0 ? '' : host.readCString(to >>> 0, MAX_PATH), info, false),
        },
        mmioRenameW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([from, to, info])=>renameFile(
                (from >>> 0) === 0 ? '' : wideAt(from >>> 0, MAX_PATH),
                (to >>> 0) === 0 ? '' : wideAt(to >>> 0, MAX_PATH), info, true),
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
         * FOURCC mmioStringToFOURCCW(LPCWSTR sz, UINT uFlags)
         *
         * The same code from a UTF-16 string, whose characters are narrowed
         * first: one with no single-byte form becomes a question mark.
         */
        mmioStringToFOURCCW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([text, flags])=>fourccOf((text >>> 0) === 0 ? ''
                : wideAt(text >>> 0, 4).replace(/[^\0-\xff]/g, '?'),
            ((flags >>> 0) & MMIO_TOUPPER) !== 0),
        },

        /**
         * LPMMIOPROC mmioInstallIOProcA(FOURCC fccIOProc, LPMMIOPROC pIOProc, DWORD dwFlags)
         * LPMMIOPROC mmioInstallIOProcW(FOURCC, LPMMIOPROC, DWORD)
         *
         * The table itself, one for both: installing answers the procedure,
         * finding and removing answer the one installed, or null. A file
         * already open keeps the procedure it was opened through.
         */
        mmioInstallIOProcA: install(false),
        mmioInstallIOProcW: install(true),
    };
}
