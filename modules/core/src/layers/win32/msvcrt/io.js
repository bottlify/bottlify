/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's file descriptors: `_open` and the calls that take the small
 * number it hands out, and the stat family.
 *
 * A descriptor is what a FILE stands on. fopen opens one and writes its number
 * into the record's `_file`, so `_fileno(f)` is a number `_read`, `_lseek` and
 * `_fstat` accept, and the position is one position whichever of the two
 * moves it. 0, 1 and 2 are the console, open from the start and never closed.
 *
 * A descriptor's open file is the same record a kernel32 file handle holds,
 * which is how `_get_osfhandle` hands one out as the other and
 * `_open_osfhandle` takes a handle in: the two share one position, and the
 * descriptor, which owns the handle, closes it.
 *
 * Text mode belongs to the descriptor: a read folds CR LF into LF and stops at
 * a ^Z, a write puts CR before every LF. Which mode a file opens in is the
 * caller's `_O_TEXT` or `_O_BINARY`, and when it names neither, the runtime's
 * `_fmode`, which starts out text. A Unicode translation is text mode over
 * UTF-16, which the file keeps as UTF-16 or UTF-8 (see widetext.js).
 */

import { HANDLE_STDERR, HANDLE_STDIN, HANDLE_STDOUT } from '../kernel32/console.js';
import { decodeAnsi } from '../kernel32/locale.js';
import { EACCES, EBADF, EEXIST, EINVAL, EMFILE, ENOENT, ENOSPC } from './globals.js';
import {
    O_UNICODE, O_WTEXT, bytesOfUnits, decodeUnits, encodeUnits, encodingOf, foldUnits, markIn,
    markOf, textOfUnits, unitsOf, unmarkedEncodingOf, wideStringAt,
} from './widetext.js';

/** `_open` flags, at msvcrt's values (fcntl.h). */
const O_WRONLY = 0x0001;
const O_RDWR = 0x0002;
const O_ACCMODE = 0x0003;
const O_APPEND = 0x0008;
const O_TEMPORARY = 0x0040;
const O_CREAT = 0x0100;
const O_TRUNC = 0x0200;
const O_EXCL = 0x0400;
const O_TEXT = 0x4000;
export const O_BINARY = 0x8000;

/**
 * The Unicode translation a set of flags names, or 0.
 *
 * @param {number} flags
 */
const unicodeOf = flags=>O_UNICODE.find(mode=>(flags & mode) !== 0) ?? 0;

/** msvcrt's own ceiling on open descriptors. */
const MAX_DESCRIPTORS = 2048;

/** 0, 1 and 2: stdin, stdout and stderr. */
const STANDARD_DESCRIPTORS = 3;
const STANDARD_HANDLES = [HANDLE_STDIN, HANDLE_STDOUT, HANDLE_STDERR];

/** What `_get_osfhandle` answers for a number not open. */
const INVALID_HANDLE_VALUE = -1;

/**
 * `__pioinfo`, msvcrt.dll's table of descriptors as a program reads it in
 * place: a pointer per block of 32, then the first block, each entry 36 bytes
 * -- the handle, `wxflag`, three bytes of lookahead, `exflag` and a critical
 * section.
 */
const IOINFO = Object.freeze({
    BLOCK: 32, SIZE: 36, BLOCKS: MAX_DESCRIPTORS / 32, HANDLE: 0, WXFLAG: 4,
});
/** `wxflag`'s bits: open, appending, a character device, text mode. */
const WX_OPEN = 0x01;
const WX_APPEND = 0x20;
const WX_TTY = 0x40;
const WX_TEXT = 0x80;

const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

export const CR = 0x0d;
export const LF = 0x0a;
const CTRL_Z = 0x1a;

/**
 * How much a stream read takes from the volume at a time, the size of the
 * runtime's own stream buffer: a program reading a line or a byte per call
 * is served from what the last call read rather than asking the volume again.
 */
const READ_AHEAD = 4096;

/** `struct _stat` with msvcrt.dll's 32-bit times: 36 bytes. */
const STAT = Object.freeze({
    DEV: 0, INO: 4, MODE: 6, NLINK: 8, UID: 10, GID: 12, RDEV: 16, SIZE: 20, WIDE_SIZE: false,
    ATIME: 24, MTIME: 28, CTIME: 32, BYTES: 36,
});

/**
 * `struct _stati64`: the same fields with a 64-bit size, which the structure's
 * 8-byte alignment puts at 24 rather than 20, and the whole rounded up to 48.
 */
const STATI64 = Object.freeze({
    DEV: 0, INO: 4, MODE: 6, NLINK: 8, UID: 10, GID: 12, RDEV: 16, SIZE: 24, WIDE_SIZE: true,
    ATIME: 32, MTIME: 36, CTIME: 40, BYTES: 48,
});

/** `st_mode` bits, as sys/stat.h numbers them. */
const S_IFDIR = 0x4000;
const S_IFCHR = 0x2000;
const S_IFREG = 0x8000;
const ALL_READ = 0o444;
const ALL_WRITE = 0o222;
const ALL_EXEC = 0o111;

/** The extensions `_stat` reports as executable. */
const EXECUTABLE = /\.(exe|com|bat|cmd)$/i;

const MAX_STRING = 1 << 20;

/**
 * An answer that may still be on its way: a volume read hands back bytes, or
 * a promise of them when the blocks are not resident yet.
 *
 * @template T, U
 * @param {T | Promise<T>} value
 * @param {(value: T) => U | Promise<U>} then
 * @returns {U | Promise<U>}
 */
export function settle(value, then){
    return typeof (/** @type {any} */ (value))?.then === 'function'
        ? /** @type {Promise<T>} */ (value).then(then)
        : then(/** @type {T} */ (value));
}

/**
 * How many bytes run to the end of the first line: through its LF, a byte or
 * the two of a UTF-16 unit, or all of them when there is none.
 *
 * @param {Uint8Array} raw @param {1 | 2} width
 */
function lineEnd(raw, width){
    for (let at = 0; at < raw.length; at += width)
    {
        if (raw[at] === LF && (width === 1 || raw[at + 1] === 0))
        {
            return Math.min(raw.length, at + width);
        }
    }
    return raw.length;
}

/**
 * An open file as a kernel32 file handle holds it, and as a descriptor reads
 * and writes through it: a handle and a descriptor on one file share this,
 * and so share its position.
 *
 * @typedef {Object} OpenFile
 * @property {any} node          The volume's open file; null for the console.
 * @property {string} path
 * @property {number} position   The file offset the next read or write starts at.
 * @property {boolean} read
 * @property {boolean} write
 */

/**
 * @typedef {Object} Descriptor
 * @property {OpenFile} file
 * @property {any} node          The file's, as are the four below: see `over`.
 * @property {string} path
 * @property {number} position
 * @property {boolean} read
 * @property {boolean} write
 * @property {number} handle     The kernel32 handle that stands for the file,
 *           once one has been asked for or the descriptor was made from one;
 *           0 before. Closing the descriptor closes it.
 * @property {boolean} append    Every write goes to the end of the file first.
 * @property {boolean} text
 * @property {number} unicode    The Unicode translation the descriptor is in,
 *           `_O_WTEXT`, `_O_U16TEXT` or `_O_U8TEXT`; 0 for none.
 * @property {import('./widetext.js').Encoding} encoding
 *           How the file keeps the UTF-16 of a Unicode translation.
 * @property {boolean} ended     A ^Z was read: reads answer nothing until a seek.
 * @property {boolean} temporary The file is removed when the descriptor closes.
 * @property {number} [console]  The standard handle a console descriptor stands for.
 * @property {{ offset: number, bytes: Uint8Array, whole: boolean } | null} ahead
 *           What a stream read last took from the volume; `whole` when that
 *           read reached the end of the file.
 */

/**
 * kernel32's handle table, as far as files go.
 *
 * @typedef {Object} FileHandles
 * @property {(file: OpenFile) => number} open  Files an open file under a new handle.
 * @property {(handle: number) => OpenFile | null} file
 *           The open file a handle names; null for one that names none.
 * @property {(handle: number) => boolean} close  CloseHandle, the file's node with it.
 */

/**
 * A descriptor over an open file. The node, the access and the position are
 * the file's, read through rather than copied: a kernel32 handle on the same
 * file moves the one position both of them stand at.
 *
 * @param {OpenFile} file
 * @param {{ text: boolean, append?: boolean, temporary?: boolean, handle?: number,
 *           console?: number, unicode?: number }} settings
 * @returns {Descriptor}
 */
const over = (file, settings)=>({
    file,
    get node(){
        return file.node;
    },
    get path(){
        return file.path;
    },
    get read(){
        return file.read;
    },
    get write(){
        return file.write;
    },
    get position(){
        return file.position;
    },
    set position(value){
        file.position = value;
    },
    handle: settings.handle ?? 0,
    append: Boolean(settings.append),
    text: settings.text || Boolean(settings.unicode),
    unicode: settings.unicode ?? 0,
    encoding: encodingOf(settings.unicode ?? 0),
    ended: false,
    temporary: Boolean(settings.temporary),
    console: settings.console,
    ahead: null,
});

/**
 * A descriptor on the console, for the standard handle it stands for.
 *
 * @param {number} handle
 * @param {{ text: boolean, append?: boolean, unicode?: number }} settings
 */
const onConsole = (handle, settings)=>{
    const read = handle === HANDLE_STDIN;
    return over({ node: null, path: '', position: 0, read, write: !read },
        { ...settings, handle, console: handle });
};

/**
 * @typedef {Object} OpenRequest
 * @property {boolean} read
 * @property {boolean} write
 * @property {boolean} [create]
 * @property {boolean} [truncate]
 * @property {boolean} [exclusive]  Refuse a file that is already there.
 * @property {boolean} [append]
 * @property {boolean | null} [text]  Null: whatever `_fmode` says.
 * @property {boolean} [temporary]  Remove the file when the descriptor closes.
 * @property {number} [unicode]  A Unicode translation to open it in.
 */

/**
 * @typedef {Object} DescriptorHost
 * @property {any} files  The volume: open, read, write, close, stat, remove.
 * @property {(handle: number, text: string) => void} [write]  The console.
 * @property {(code: number) => void} [errno]
 * @property {() => number} [fmode]  The runtime's `_fmode`.
 * @property {FileHandles} [handles]
 *           Where a descriptor's file becomes a handle and a handle a
 *           descriptor. Absent, neither is asked for.
 * @property {() => number} [ioinfo]  Where `__pioinfo` is, 0 before the
 *           runtime's image is placed; each change to a descriptor of the
 *           first block is written there.
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 */

/**
 * @typedef {ReturnType<typeof createDescriptors>} Descriptors
 */

/**
 * The descriptor table, shared by the low-level calls and the streams.
 *
 * @param {DescriptorHost} host
 */
export function createDescriptors(host){
    /** @type {Map<number, Descriptor>} */
    const table = new Map();

    table.set(0, onConsole(HANDLE_STDIN, { text: true }));
    table.set(1, onConsole(HANDLE_STDOUT, { text: true }));
    table.set(2, onConsole(HANDLE_STDERR, { text: true }));

    /**
     * A descriptor's `__pioinfo` entry, its handle and `wxflag`: a number not
     * open has no handle. A file's handle is made only when one is asked
     * for, so until then the entry holds none, though `wxflag` says it is
     * open.
     *
     * @param {number} fd
     */
    const entryOf = fd=>{
        const descriptor = table.get(fd);
        const bytes = new Uint8Array(IOINFO.WXFLAG + 1);
        new DataView(bytes.buffer).setInt32(IOINFO.HANDLE,
            descriptor?.handle || INVALID_HANDLE_VALUE, true);
        bytes[IOINFO.WXFLAG] = !descriptor ? 0 : WX_OPEN | (descriptor.append ? WX_APPEND : 0)
            | (descriptor.console !== undefined ? WX_TTY : 0) | (descriptor.text ? WX_TEXT : 0);
        return bytes;
    };

    /**
     * Writes a descriptor's entry where the program reads it.
     * ponytail: the first block only, the one msvcrt.dll starts with; the
     * next are made as descriptors past 31 are opened, when one is read.
     *
     * @param {number} fd
     */
    const mirror = fd=>{
        const at = host.ioinfo?.() ?? 0;
        if (at !== 0 && fd >= 0 && fd < IOINFO.BLOCK)
        {
            host.writeMemory?.(at + IOINFO.BLOCKS * 4 + fd * IOINFO.SIZE, entryOf(fd));
        }
    };

    /** @param {number} code */
    const fail = code=>{
        host.errno?.(code);
    };

    /** The lowest number free, or -1 with EMFILE past the runtime's ceiling. */
    const lowestFree = ()=>{
        let fd = 0;
        while (table.has(fd))
        {
            fd++;
        }
        if (fd >= MAX_DESCRIPTORS)
        {
            fail(EMFILE);
            return -1;
        }
        return fd;
    };

    /**
     * Whether a descriptor's file is still open. The handle is the file's
     * for a descriptor that has one, and a program that closed the handle
     * itself -- which the documentation tells it not to -- has closed the
     * file under the descriptor, as it would on Windows.
     *
     * @param {Descriptor} descriptor
     */
    const alive = descriptor=>descriptor.handle === 0 || descriptor.console !== undefined
        || host.handles?.file(descriptor.handle) === descriptor.file;

    /** @param {Descriptor} descriptor */
    const sizeOf = descriptor=>host.files.stat(descriptor.path)?.size ?? 0;

    /**
     * A file opened in a Unicode translation: an empty one open for writing
     * starts with the mark of the translation's encoding, and one with
     * something in it is read and written the way its own mark says -- the
     * mark skipped, so the first read is of the text -- or, with no mark, the
     * way the translation reads such a file (Wine's msvcrt
     * test_file_write_read and test_fgetwc_unicode). A file opened only to
     * append to is looked at through a read of its own, as `_open` and fopen
     * are documented to, so what is added matches what is there; when that
     * cannot be opened the translation's own encoding stands. The answer
     * waits for the file's first bytes when the volume has not got them yet.
     *
     * @param {Descriptor} descriptor
     * @returns {void | Promise<void>}
     */
    const markFile = descriptor=>{
        const size = sizeOf(descriptor);
        if (size === 0 && descriptor.write)
        {
            const mark = markOf(descriptor.encoding);
            descriptor.position = host.files.write(descriptor.node, 0, mark);
            return;
        }
        const own = descriptor.read;
        const look = size === 0 ? null : own ? descriptor.node
            : host.files.open(descriptor.path, { read: true, write: false });
        if (!look)
        {
            return;
        }
        return settle(host.files.read(look, 0, 3), head=>{
            if (!own)
            {
                host.files.close(look);
            }
            const mark = markIn(head);
            descriptor.encoding = mark?.encoding ?? unmarkedEncodingOf(descriptor.unicode);
            if (mark && descriptor.position === 0)
            {
                descriptor.position = mark.length;
            }
        });
    };

    /**
     * Up to `limit` bytes of the program's UTF-16 from a descriptor in a
     * Unicode translation: the file's units, CR LF folded to LF, stopping
     * after an LF when `line` says so, and the position moved past the bytes
     * of the file they came from. As many bytes are asked for as the units
     * could take, and a unit more, which says whether a CR is the first half
     * of a CR LF.
     *
     * @param {Descriptor} descriptor @param {number} limit @param {boolean} line
     * @returns {Uint8Array | Promise<Uint8Array>}
     */
    const pullUnicode = (descriptor, limit, line)=>{
        const units = Math.floor(limit / 2);
        const widest = descriptor.encoding === 'utf16' ? 2 : descriptor.encoding === 'utf8' ? 3 : 1;
        const start = descriptor.position;
        return settle(host.files.read(descriptor.node, start, (units + 2) * widest + 2), raw=>{
            const folded = foldUnits(decodeUnits(raw, descriptor.encoding), units, line);
            descriptor.position = start + folded.consumed;
            return bytesOfUnits(folded.units);
        });
    };

    /**
     * A stretch of the file for a stream, from what the last one read when it
     * holds the stretch -- or holds the end of the file, when that read found
     * it and some of what it read is still unconsumed. Past that, the volume
     * is asked again, which is when a file that grew is seen to have.
     *
     * @param {Descriptor} descriptor @param {number} offset @param {number} length
     * @returns {Uint8Array | Promise<Uint8Array>}
     */
    const readAhead = (descriptor, offset, length)=>{
        const ahead = descriptor.ahead;
        const end = ahead ? ahead.offset + ahead.bytes.length : 0;
        if (ahead && offset >= ahead.offset
            && (offset + length <= end || (ahead.whole && offset < end)))
        {
            return ahead.bytes.subarray(offset - ahead.offset, offset - ahead.offset + length);
        }
        const size = Math.max(length, READ_AHEAD);
        return settle(host.files.read(descriptor.node, offset, size), bytes=>{
            descriptor.ahead = { offset, bytes, whole: bytes.length < size };
            return bytes.subarray(0, length);
        });
    };

    return {
        /**
         * The descriptor a number is, or null for one not open -- or whose
         * file closed under it.
         *
         * @param {number} fd @returns {Descriptor | null}
         */
        get: fd=>{
            const descriptor = table.get(fd | 0) ?? null;
            return descriptor && alive(descriptor) ? descriptor : null;
        },

        /** Whether descriptors and kernel32 handles can be made of each other. */
        handles: host.handles !== undefined,

        /**
         * Opens a file and answers with the lowest number free, or -1 with
         * errno saying why: the name is not there, it is and was to be made
         * new, or it is and cannot be opened this way. In a Unicode
         * translation the answer waits for the file's mark, when that is
         * still on its way.
         *
         * @param {string} path @param {OpenRequest} request
         * @returns {number | Promise<number>}
         */
        open(path, request){
            const fd = lowestFree();
            if (fd < 0)
            {
                return -1;
            }
            const node = path === '' ? null : host.files.open(path, {
                read: request.read, write: request.write, create: request.create,
                truncate: request.truncate, failIfExists: request.exclusive,
            });
            if (!node)
            {
                const there = path !== '' && host.files.stat(path);
                fail(!there ? ENOENT : (request.exclusive ? EEXIST : EACCES));
                return -1;
            }
            const file = { node, path, position: 0, read: request.read, write: request.write };
            const descriptor = over(file, {
                append: request.append,
                text: request.text ?? ((host.fmode?.() ?? 0) & O_BINARY) === 0,
                temporary: request.temporary,
                unicode: request.unicode,
            });
            table.set(fd, descriptor);
            mirror(fd);
            return descriptor.unicode === 0 ? fd : settle(markFile(descriptor), ()=>fd);
        },

        /**
         * The kernel32 handle a descriptor's file is: the standard handle for
         * the console, and for a file the one it was made from or first
         * asked for, filed then. From then on the handle is what holds the
         * file open, so the descriptor closes through it.
         *
         * @param {Descriptor} descriptor
         */
        handleOf(descriptor){
            if (descriptor.handle === 0 && host.handles)
            {
                descriptor.handle = host.handles.open(descriptor.file);
                for (const [fd, held] of table)
                {
                    if (held === descriptor)
                    {
                        mirror(fd);
                    }
                }
            }
            return descriptor.handle;
        },

        /**
         * A descriptor on a kernel32 handle, which the descriptor owns from
         * then on: the lowest number free, or -1 with EBADF for a handle
         * that is not an open file. A standard handle is the console.
         *
         * @param {number} handle
         * @param {{ text: boolean, append: boolean, unicode: number }} settings
         */
        adopt(handle, settings){
            const standard = handle === HANDLE_STDIN || handle === HANDLE_STDOUT
                || handle === HANDLE_STDERR;
            const file = standard ? null : host.handles?.file(handle) ?? null;
            if (!standard && !file)
            {
                fail(EBADF);
                return -1;
            }
            const fd = lowestFree();
            if (fd >= 0)
            {
                table.set(fd, file
                    ? over(file, { ...settings, handle })
                    : onConsole(handle, settings));
                mirror(fd);
            }
            return fd;
        },

        /**
         * Gives a descriptor back, closing its file: through its handle when
         * it has one, which answers false when the program closed that handle
         * itself. The console's three stay: they are the runtime's, and a
         * program that closes one to silence it still has its standard
         * streams. A temporary file is removed when the descriptor that asked
         * for that closes, which with one descriptor on the file, the usual
         * case, is the last.
         *
         * @param {number} fd @returns {boolean} false for a number not open
         */
        close(fd){
            const number = fd | 0;
            const descriptor = table.get(number);
            if (!descriptor)
            {
                return false;
            }
            if (number < STANDARD_DESCRIPTORS && descriptor.console !== undefined)
            {
                return true;
            }
            // A file `_dup2` or freopen put on a standard number closes, and the
            // number is the console's again.
            if (number < STANDARD_DESCRIPTORS)
            {
                table.set(number, onConsole(STANDARD_HANDLES[number], { text: true }));
            }
            else
            {
                table.delete(number);
            }
            mirror(number);
            if (descriptor.console !== undefined)
            {
                return true;
            }
            const live = alive(descriptor);
            if (live && descriptor.handle !== 0)
            {
                host.handles?.close(descriptor.handle);
            }
            else if (live)
            {
                host.files.close(descriptor.node);
            }
            if (descriptor.temporary)
            {
                host.files.remove(descriptor.path);
            }
            return live;
        },

        /**
         * A second descriptor on what `fd` has open, sharing its position, as
         * `_dup` and `_dup2` make one: the lowest number free, or `onto`,
         * closing what was there first -- a standard number included, which
         * is how a program sends its output to a file. -1 with EBADF for a
         * number not open or a target out of range.
         *
         * @param {number} fd @param {number} [onto]
         */
        duplicate(fd, onto){
            const source = table.get(fd | 0);
            const outOfReach = onto !== undefined
                && ((onto | 0) < 0 || (onto | 0) >= MAX_DESCRIPTORS);
            if (!source || outOfReach)
            {
                fail(EBADF);
                return -1;
            }
            if (onto !== undefined && (onto | 0) === (fd | 0))
            {
                return fd | 0;
            }
            const target = onto === undefined ? lowestFree() : onto | 0;
            if (target < 0)
            {
                return -1;
            }
            if (table.has(target))
            {
                this.close(target);
            }
            // Each descriptor holds the file once: a copy takes a hold of its
            // own, which its close gives back.
            if (source.console === undefined)
            {
                host.files.retain?.(source.node);
            }
            const copy = over(source.file, {
                append: source.append, text: source.text, unicode: source.unicode,
                console: source.console, handle: source.console === undefined ? 0 : source.handle,
            });
            copy.encoding = source.encoding;
            table.set(target, copy);
            mirror(target);
            return target;
        },

        /**
         * Closes every descriptor but the console's three, as the end of the
         * process closes every handle it held, however it ended: a temporary
         * file goes then if it has not gone before.
         */
        closeAll(){
            for (const fd of [...table.keys()].filter(number=>number >= STANDARD_DESCRIPTORS))
            {
                this.close(fd);
            }
        },

        /**
         * `__pioinfo` as the image starts with it: the first block's pointer,
         * filled by the loader, and the block with every descriptor open now.
         */
        ioinfoBytes(){
            const bytes = new Uint8Array(IOINFO.BLOCKS * 4 + IOINFO.BLOCK * IOINFO.SIZE);
            for (let fd = 0; fd < IOINFO.BLOCK; fd++)
            {
                bytes.set(entryOf(fd), IOINFO.BLOCKS * 4 + fd * IOINFO.SIZE);
            }
            return bytes;
        },

        size: sizeOf,

        /**
         * Moves the position. A seek ends a ^Z's end of data and lets go of
         * what a stream read ahead, so a stream that seeks back reads the
         * file as it is now.
         *
         * @param {Descriptor} descriptor @param {number} position
         */
        seek(descriptor, position){
            descriptor.position = position;
            descriptor.ended = false;
            descriptor.ahead = null;
        },

        /**
         * Up to `limit` bytes as a stream reads them, stopping after a line
         * feed when `line` says so. Only what comes back is consumed, so the
         * position stays the offset of the next byte the program has not
         * seen; in text mode a CR LF is one LF that consumed two bytes, a CR
         * not before an LF is itself, and a ^Z ends the data, the position
         * going to the end of the file since nothing after it is data. In a
         * Unicode translation the bytes are the program's UTF-16. `units`
         * says the caller reads a binary file as UTF-16, so a line ends
         * after an LF unit rather than after an LF byte.
         *
         * @param {Descriptor} descriptor @param {number} limit @param {boolean} line
         * @param {boolean} [units]
         * @returns {Uint8Array | Promise<Uint8Array>}
         */
        pull(descriptor, limit, line, units = false){
            if (descriptor.node === null || descriptor.ended || limit <= 0)
            {
                return new Uint8Array(0);
            }
            if (descriptor.unicode !== 0)
            {
                return pullUnicode(descriptor, limit, line);
            }
            if (!descriptor.text)
            {
                return settle(readAhead(descriptor, descriptor.position, limit), raw=>{
                    const taken = raw.slice(0, line ? lineEnd(raw, units ? 2 : 1) : raw.length);
                    descriptor.position += taken.length;
                    return taken;
                });
            }
            const out = new Uint8Array(limit);
            let filled = 0;
            /** @returns {Uint8Array | Promise<Uint8Array>} */
            const round = ()=>{
                // One byte more than is wanted, so a CR at the end of the
                // stretch knows whether an LF follows it.
                const wanted = limit - filled + 1;
                return settle(readAhead(descriptor, descriptor.position, wanted), raw=>{
                    let at = 0;
                    while (filled < limit && at < raw.length)
                    {
                        const byte = raw[at];
                        if (byte === CTRL_Z)
                        {
                            descriptor.ended = true;
                            descriptor.position = sizeOf(descriptor);
                            return out.slice(0, filled);
                        }
                        if (byte === CR && at + 1 === raw.length && raw.length === wanted)
                        {
                            break;
                        }
                        const folded = byte === CR && raw[at + 1] === LF;
                        out[filled++] = folded ? LF : byte;
                        at += folded ? 2 : 1;
                        if (line && out[filled - 1] === LF)
                        {
                            descriptor.position += at;
                            return out.slice(0, filled);
                        }
                    }
                    descriptor.position += at;
                    return filled === limit || raw.length < wanted ? out.slice(0, filled) : round();
                });
            };
            return round();
        },

        /**
         * Writes at the position -- at the end first when the descriptor
         * appends -- and answers with how many of the caller's bytes were
         * stored whole; in text mode each LF goes out as CR LF. In a Unicode
         * translation the caller's bytes are UTF-16, kept in the file's
         * encoding, and on the console they are the characters they spell.
         *
         * @param {Descriptor} descriptor @param {Uint8Array} bytes
         */
        put(descriptor, bytes){
            if (descriptor.node === null)
            {
                host.write?.(/** @type {number} */ (descriptor.console), descriptor.unicode === 0
                    ? decodeAnsi(bytes)
                    : textOfUnits(unitsOf(bytes)));
                return bytes.length;
            }
            if (descriptor.append)
            {
                descriptor.position = sizeOf(descriptor);
            }
            if (descriptor.unicode !== 0)
            {
                const { bytes: raw, ends } = encodeUnits(unitsOf(bytes), descriptor.encoding);
                const stored = host.files.write(descriptor.node, descriptor.position, raw);
                descriptor.position += stored;
                descriptor.ahead = null;
                return ends.filter(end=>end <= stored).length * 2;
            }
            let raw = bytes;
            if (descriptor.text)
            {
                const feeds = bytes.reduce((count, byte)=>count + (byte === LF ? 1 : 0), 0);
                raw = new Uint8Array(bytes.length + feeds);
                let to = 0;
                for (const byte of bytes)
                {
                    if (byte === LF)
                    {
                        raw[to++] = CR;
                    }
                    raw[to++] = byte;
                }
            }
            const stored = host.files.write(descriptor.node, descriptor.position, raw);
            descriptor.position += stored;
            descriptor.ahead = null;
            if (stored === raw.length || !descriptor.text)
            {
                return Math.min(stored, bytes.length);
            }
            // A short text write: the source bytes whose whole expansion made it.
            let used = 0;
            for (let taken = 0; used < bytes.length; used++)
            {
                taken += bytes[used] === LF ? 2 : 1;
                if (taken > stored)
                {
                    break;
                }
            }
            return used;
        },
    };
}

/**
 * @typedef {Object} IoHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {any} files  The volume: stat and currentDirectory, besides what
 *           the descriptors use.
 * @property {(code: number) => void} [errno]
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a call refuses what real Windows would have done.
 * @property {(values: Record<string, number>) => void} [setRegisters]
 *           Where the high half of an __int64 answer goes: EDX.
 */

/**
 * @param {IoHost} host
 * @param {Descriptors} descriptors
 */
export function createIoFunctions(host, descriptors){
    /** @param {number} code */
    const fail = code=>{
        host.errno?.(code);
    };

    /**
     * @param {number} argBytes
     * @param {(args: number[]) => number | Promise<number>} handler
     */
    const cdecl = (argBytes, handler)=>({ convention: 'cdecl', argBytes, handler });

    /** @param {number} milliseconds */
    const seconds = milliseconds=>Math.floor((milliseconds ?? 0) / 1000) >>> 0;

    /**
     * The descriptor of a file, which has a position and a size; null with
     * EBADF for a number not open and for the console, which has neither.
     *
     * @param {number} fd
     */
    const fileAt = fd=>{
        const descriptor = descriptors.get(fd | 0);
        if (!descriptor || descriptor.node === null)
        {
            fail(EBADF);
            return null;
        }
        return descriptor;
    };

    /**
     * What `_open` and its relatives do with a name and the flags.
     *
     * @param {number} path @param {number} oflag  Both as the guest passed them.
     * @param {boolean} wide  Whether the name is UTF-16.
     */
    const openNamed = (path, oflag, wide)=>{
        const flags = oflag >>> 0;
        const access = flags & O_ACCMODE;
        if ((path >>> 0) === 0 || access === O_ACCMODE)
        {
            fail(EINVAL);
            return -1;
        }
        return descriptors.open(wide
            ? wideStringAt(host.readMemory, path >>> 0)
            : host.readCString(path >>> 0, MAX_STRING), {
            read: access !== O_WRONLY,
            write: access === O_WRONLY || access === O_RDWR,
            create: (flags & O_CREAT) !== 0,
            truncate: (flags & O_TRUNC) !== 0,
            exclusive: (flags & (O_CREAT | O_EXCL)) === (O_CREAT | O_EXCL),
            append: (flags & O_APPEND) !== 0,
            text: (flags & O_BINARY) !== 0 ? false : ((flags & O_TEXT) !== 0 ? true : null),
            temporary: (flags & O_TEMPORARY) !== 0,
            unicode: (flags & O_BINARY) !== 0 ? 0 : unicodeOf(flags),
        });
    };

    /**
     * Fills a whole `struct _stat` or `_stati64`, so no field keeps what the
     * caller's buffer held. The volume keeps one time per file, the last
     * write, and it stands for all three.
     *
     * @param {number} address
     * @param {{ device: number, mode: number, size: number, modified: number }} entry
     * @param {typeof STAT | typeof STATI64} [layout]
     */
    const writeStat = (address, entry, layout = STAT)=>{
        const bytes = new Uint8Array(layout.BYTES);
        const view = new DataView(bytes.buffer);
        view.setUint32(layout.DEV, entry.device, true);
        view.setUint16(layout.MODE, entry.mode, true);
        view.setInt16(layout.NLINK, 1, true);
        view.setUint32(layout.RDEV, entry.device, true);
        if (layout.WIDE_SIZE)
        {
            view.setBigUint64(layout.SIZE, BigInt(entry.size), true);
        }
        else
        {
            view.setUint32(layout.SIZE, entry.size >>> 0, true);
        }
        const time = seconds(entry.modified);
        view.setUint32(layout.ATIME, time, true);
        view.setUint32(layout.MTIME, time, true);
        view.setUint32(layout.CTIME, time, true);
        host.writeMemory(address >>> 0, bytes);
    };

    /**
     * The body `_lseek` and `_lseeki64` share: the new position; -1 with
     * EINVAL for an origin that is not one or a position before the start,
     * EBADF for a number that is not a file.
     *
     * @param {number} fd @param {number} offset @param {number} origin
     */
    const seekTo = (fd, offset, origin)=>{
        const descriptor = fileAt(fd);
        if (!descriptor)
        {
            return -1;
        }
        const base = origin === SEEK_SET ? 0
            : origin === SEEK_CUR ? descriptor.position
                : origin === SEEK_END ? descriptors.size(descriptor) : -1;
        const position = base + offset;
        if (base < 0 || position < 0)
        {
            fail(EINVAL);
            return -1;
        }
        descriptors.seek(descriptor, position);
        return position;
    };

    /**
     * An __int64 answer: the high half to EDX, the low half returned for EAX.
     *
     * @param {number} value
     */
    const wide = value=>{
        const bits = BigInt.asUintN(64, BigInt(value));
        host.setRegisters?.({ edx: Number(bits >> 32n) });
        return Number(bits & 0xffffffffn);
    };

    /**
     * The body `_fstat` and `_fstati64` share. A file is a regular file
     * anyone may read and write, on device 0; a console descriptor is a
     * character device whose device is its number.
     *
     * @param {number} fd @param {number} buffer
     * @param {typeof STAT | typeof STATI64} layout
     */
    const statDescriptor = (fd, buffer, layout)=>{
        const descriptor = descriptors.get(fd | 0);
        if (!descriptor)
        {
            fail(EBADF);
            return -1;
        }
        if ((buffer >>> 0) === 0)
        {
            fail(EINVAL);
            return -1;
        }
        if (descriptor.node === null)
        {
            writeStat(buffer, { device: fd | 0, mode: S_IFCHR, size: 0, modified: 0 }, layout);
            return 0;
        }
        const entry = host.files.stat(descriptor.path);
        writeStat(buffer, {
            device: 0, mode: S_IFREG | ALL_READ | ALL_WRITE,
            size: entry?.size ?? 0, modified: entry?.modified ?? 0,
        }, layout);
        return 0;
    };

    /**
     * The body `_stat` and `_stati64` share: -1 and ENOENT for a name that
     * is not there, for a bare "C:", and for a name with a separator after
     * it that is not a drive's root -- as Windows answers, trailing spaces
     * aside. The device is the drive's number, A being 0; a directory and a
     * program are executable.
     *
     * @param {number} path @param {number} buffer
     * @param {typeof STAT | typeof STATI64} layout
     */
    const statPath = (path, buffer, layout)=>{
        if ((path >>> 0) === 0 || (buffer >>> 0) === 0)
        {
            fail(EINVAL);
            return -1;
        }
        const name = host.readCString(path >>> 0, MAX_STRING).replace(/ +$/, '');
        const bare = /^[A-Za-z]:$/.test(name);
        const trailing = /[\\/]$/.test(name) && !/^[A-Za-z]:[\\/]$/.test(name);
        const entry = bare || trailing || name === '' ? null : host.files.stat(name);
        if (!entry)
        {
            fail(ENOENT);
            return -1;
        }
        const drive = /^[A-Za-z]:/.test(name) ? name : host.files.currentDirectory();
        const mode = entry.isDirectory
            ? S_IFDIR | ALL_READ | ALL_WRITE | ALL_EXEC
            : S_IFREG | ALL_READ | ALL_WRITE | (EXECUTABLE.test(name) ? ALL_EXEC : 0);
        writeStat(buffer, {
            device: drive.toUpperCase().charCodeAt(0) - 0x41,
            mode, size: entry.size ?? 0, modified: entry.modified ?? 0,
        }, layout);
        return 0;
    };

    /**
     * What `_read` delivers in text mode from `raw`, the bytes it read: CR LF
     * folds to LF and a ^Z ends the data. A CR that is the last byte read is
     * decided by the byte after it -- see `_read`.
     *
     * @param {Uint8Array} raw
     */
    const fold = raw=>{
        const out = new Uint8Array(raw.length);
        let filled = 0;
        for (let at = 0; at < raw.length; at++)
        {
            const byte = raw[at];
            if (byte === CTRL_Z)
            {
                return { out, filled, ended: true, trailingCr: false };
            }
            if (byte === CR && at + 1 === raw.length)
            {
                return { out, filled, ended: false, trailingCr: true };
            }
            if (byte !== CR || raw[at + 1] !== LF)
            {
                out[filled++] = byte;
            }
        }
        return { out, filled, ended: false, trailingCr: false };
    };

    /**
     * The two calls that cross between descriptors and kernel32's handles,
     * exported only where the handle table is reachable: without it a handle
     * handed out would be one no kernel32 call knows.
     */
    const osHandles = descriptors.handles
        ? {
            /**
             * intptr_t _get_osfhandle(int fd)
             *
             * The handle a descriptor's file is -- one ReadFile, SetEndOfFile
             * or CreateFileMapping take, at the descriptor's own position --
             * which stays the descriptor's to close. INVALID_HANDLE_VALUE with
             * EBADF for a number not open (Wine's msvcrt test_get_osfhandle).
             */
            _get_osfhandle: cdecl(4, ([fd])=>{
                const descriptor = descriptors.get(fd | 0);
                if (!descriptor)
                {
                    fail(EBADF);
                    return INVALID_HANDLE_VALUE;
                }
                return descriptors.handleOf(descriptor);
            }),

            /**
             * int _open_osfhandle(intptr_t osfhandle, int flags)
             *
             * A descriptor on a handle, which it owns from then on: `_close`
             * closes the handle, and a second descriptor on it finds it closed
             * (Wine's msvcrt test__open_osfhandle and test_close). Binary
             * unless `_O_TEXT` or a Unicode translation is named, which
             * writes no mark into a file the handle already has; the access
             * is the handle's. -1 with EBADF for a handle that is not an
             * open file.
             */
            _open_osfhandle: cdecl(8, ([handle, flags])=>descriptors.adopt(handle >>> 0, {
                text: ((flags >>> 0) & O_TEXT) !== 0,
                append: ((flags >>> 0) & O_APPEND) !== 0,
                unicode: unicodeOf(flags >>> 0),
            })),
        }
        : {};

    const duplicates = {
        /** int _dup(int fd) -- a second descriptor on the same file, its position shared. */
        _dup: cdecl(4, ([fd])=>descriptors.duplicate(fd)),

        /**
         * int _dup2(int fd1, int fd2)
         *
         * `fd2` made a second descriptor on `fd1`'s file, closing what it
         * had: 0, or -1 with EBADF for either number out of reach.
         */
        _dup2: cdecl(8, ([fd, onto])=>(descriptors.duplicate(fd, onto) < 0 ? -1 : 0)),
    };

    /**
     * ioinfo *__pioinfo[]
     *
     * Data: the runtime's descriptors as a program reads them in place, its
     * first pointer to the block that follows it.
     */
    const ioinfo = {
        __pioinfo: {
            data: ()=>descriptors.ioinfoBytes(),
            pointers: [{ at: 0, to: '__pioinfo', offset: IOINFO.BLOCKS * 4 }],
        },
    };

    return {
        ...osHandles,
        ...ioinfo,
        ...duplicates,

        /**
         * int _open(const char *filename, int oflag [, int pmode])
         *
         * The permission argument only marks a new file read-only on Windows,
         * and the volume keeps no such bit, so it is read and not used.
         */
        _open: cdecl(12, ([path, oflag])=>openNamed(path, oflag, false)),

        /** int _wopen(const wchar_t *filename, int oflag [, int pmode]) -- `_open`, wide. */
        _wopen: cdecl(12, ([path, oflag])=>openNamed(path, oflag, true)),

        /**
         * int _sopen(const char *filename, int oflag, int shflag [, int pmode])
         *
         * `_open` with a sharing mode. The volume has no share modes -- an
         * open file may be opened again -- so the mode is read and not used.
         */
        _sopen: cdecl(16, ([path, oflag])=>openNamed(path, oflag, false)),

        /** int _wsopen(const wchar_t *filename, int oflag, int shflag [, int pmode]) */
        _wsopen: cdecl(16, ([path, oflag])=>openNamed(path, oflag, true)),

        /**
         * int _chsize(int fd, long size)
         *
         * Cuts the file to `size` bytes or grows it with zeroes; the position
         * stays where it was. 0, or -1 with EBADF for a number not open or
         * not open for writing, and EINVAL for a negative size.
         */
        _chsize: cdecl(8, ([fd, size])=>{
            const descriptor = fileAt(fd);
            if (!descriptor)
            {
                return -1;
            }
            if (!descriptor.write)
            {
                fail(EBADF);
                return -1;
            }
            if ((size | 0) < 0)
            {
                fail(EINVAL);
                return -1;
            }
            host.files.truncate(descriptor.node, size >>> 0);
            descriptor.ahead = null;
            return 0;
        }),

        /** int _close(int fd) -- -1 and EBADF for a number not open. */
        _close: cdecl(4, ([fd])=>{
            if (!descriptors.close(fd | 0))
            {
                fail(EBADF);
                return -1;
            }
            return 0;
        }),

        /**
         * int _read(int fd, void *buffer, unsigned int count)
         *
         * Reads `count` bytes of the file and answers with what they come to.
         * In text mode that is fewer: each CR LF is one LF, and a ^Z ends the
         * data until a seek. A CR that is the last byte read looks one byte
         * further: before an LF it is dropped, the LF left for the next read,
         * unless it is the only byte read, when the LF is read with it; any
         * other CR is kept (Wine's msvcrt test_file_write_read pins each case).
         */
        _read: cdecl(12, ([fd, buffer, count])=>{
            const descriptor = descriptors.get(fd | 0);
            if (!descriptor || !descriptor.read)
            {
                fail(EBADF);
                return -1;
            }
            const wanted = count >>> 0;
            if (wanted === 0)
            {
                return 0;
            }
            if (descriptor.unicode !== 0 && wanted % 2 !== 0)
            {
                fail(EINVAL);
                return -1;
            }
            if (descriptor.node === null || descriptor.ended)
            {
                return 0;
            }
            if (descriptor.unicode !== 0)
            {
                return settle(descriptors.pull(descriptor, wanted, false), bytes=>{
                    if (bytes.length > 0)
                    {
                        host.writeMemory(buffer >>> 0, bytes);
                    }
                    return bytes.length;
                });
            }
            const start = descriptor.position;
            /** @param {Uint8Array} bytes @param {number} consumed */
            const deliver = (bytes, consumed)=>{
                if (bytes.length > 0)
                {
                    host.writeMemory(buffer >>> 0, bytes);
                }
                descriptor.position = start + consumed;
                return bytes.length;
            };
            return settle(host.files.read(descriptor.node, start, wanted), raw=>{
                if (!descriptor.text)
                {
                    return deliver(raw, raw.length);
                }
                const { out, filled, ended, trailingCr } = fold(raw);
                descriptor.ended = ended;
                if (!trailingCr)
                {
                    return deliver(out.subarray(0, filled), raw.length);
                }
                return settle(host.files.read(descriptor.node, start + raw.length, 1), next=>{
                    if (next.length === 1 && next[0] === LF)
                    {
                        return filled === 0
                            ? deliver(Uint8Array.of(LF), raw.length + 1)
                            : deliver(out.subarray(0, filled), raw.length);
                    }
                    out[filled] = CR;
                    return deliver(out.subarray(0, filled + 1), raw.length);
                });
            });
        }),

        /**
         * int _write(int fd, const void *buffer, unsigned int count)
         *
         * The count of the caller's bytes, whatever text mode made of them on
         * the way out; -1 with ENOSPC when they did not all fit.
         */
        _write: cdecl(12, ([fd, buffer, count])=>{
            const descriptor = descriptors.get(fd | 0);
            if (!descriptor || !descriptor.write)
            {
                fail(EBADF);
                return -1;
            }
            const wanted = count >>> 0;
            if (wanted === 0)
            {
                return 0;
            }
            if (descriptor.unicode !== 0 && wanted % 2 !== 0)
            {
                fail(EINVAL);
                return -1;
            }
            const bytes = host.readMemory(buffer >>> 0, wanted).slice();
            if (descriptors.put(descriptor, bytes) < wanted)
            {
                fail(ENOSPC);
                return -1;
            }
            return wanted;
        }),

        /**
         * long _lseek(int fd, long offset, int origin)
         *
         * The new position; -1 with EINVAL for an origin that is not one or a
         * position before the start, EBADF for a number that is not a file.
         */
        _lseek: cdecl(12, ([fd, offset, origin])=>seekTo(fd, offset | 0, origin)),

        /** long _tell(int fd) -- the position, as `_lseek(fd, 0, SEEK_CUR)` answers it. */
        _tell: cdecl(4, ([fd])=>fileAt(fd)?.position ?? -1),

        /**
         * int _eof(int fd)
         *
         * 1 at or past the end of the file, and after a text-mode ^Z, which
         * ends the data a read will see until a seek; 0 before it.
         */
        _eof: cdecl(4, ([fd])=>{
            const descriptor = fileAt(fd);
            if (!descriptor)
            {
                return -1;
            }
            return descriptor.ended || descriptor.position >= descriptors.size(descriptor) ? 1 : 0;
        }),

        /** long _filelength(int fd) -- the size, the position left where it was. */
        _filelength: cdecl(4, ([fd])=>{
            const descriptor = fileAt(fd);
            return descriptor ? descriptors.size(descriptor) : -1;
        }),

        /**
         * int _setmode(int fd, int mode)
         *
         * The translation the descriptor had: `_O_TEXT`, `_O_BINARY`, or
         * `_O_WTEXT` for any of the three Unicode ones. The mode is checked
         * before the number and must be exactly one mode (Wine's msvcrt
         * test_setmode). A Unicode translation keeps its text in the
         * encoding it names, with no mark written.
         */
        _setmode: cdecl(8, ([fd, mode])=>{
            const wanted = mode >>> 0;
            if (wanted !== O_TEXT && wanted !== O_BINARY && !O_UNICODE.includes(wanted))
            {
                fail(EINVAL);
                return -1;
            }
            const descriptor = descriptors.get(fd | 0);
            if (!descriptor)
            {
                fail(EBADF);
                return -1;
            }
            const previous = descriptor.unicode !== 0 ? O_WTEXT
                : (descriptor.text ? O_TEXT : O_BINARY);
            descriptor.text = wanted !== O_BINARY;
            descriptor.unicode = O_UNICODE.includes(wanted) ? wanted : 0;
            descriptor.encoding = encodingOf(descriptor.unicode);
            return previous;
        }),

        /**
         * int _fstat(int fd, struct _stat *buffer)
         *
         * A file is a regular file anyone may read and write, on device 0; a
         * console descriptor is a character device whose device is its number.
         */
        _fstat: cdecl(8, ([fd, buffer])=>statDescriptor(fd, buffer, STAT)),

        /** int _fstati64(int fd, struct _stati64 *buffer) -- `_fstat` with the 64-bit size. */
        _fstati64: cdecl(8, ([fd, buffer])=>statDescriptor(fd, buffer, STATI64)),

        /** int _stat(const char *path, struct _stat *buffer) */
        _stat: cdecl(8, ([path, buffer])=>statPath(path, buffer, STAT)),

        /**
         * int _stati64(const char *path, struct _stati64 *buffer)
         *
         * `_stat` with a size that goes past 4 GiB, and the same answers.
         */
        _stati64: cdecl(8, ([path, buffer])=>statPath(path, buffer, STATI64)),

        // An __int64 answer is EDX:EAX, and only a seam onto the registers
        // reaches EDX: without one these would answer a high half that is
        // whatever the register held, so they stay unexported.
        ...(host.setRegisters
            ? {
                /**
                 * __int64 _lseeki64(int fd, __int64 offset, int origin)
                 *
                 * `_lseek` with an offset and an answer past 4 GiB: -1 as an
                 * __int64, with the same errno, when it fails.
                 */
                _lseeki64: cdecl(16, ([fd, low, high, origin])=>
                    wide(seekTo(fd, (high | 0) * 0x100000000 + (low >>> 0), origin))),

                /** __int64 _telli64(int fd) */
                _telli64: cdecl(4, ([fd])=>wide(fileAt(fd)?.position ?? -1)),

                /** __int64 _filelengthi64(int fd) */
                _filelengthi64: cdecl(4, ([fd])=>{
                    const descriptor = fileAt(fd);
                    return wide(descriptor ? descriptors.size(descriptor) : -1);
                }),
            }
            : {}),
    };
}
