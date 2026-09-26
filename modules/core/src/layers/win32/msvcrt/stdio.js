/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { formatToString } from './format.js';
import { VARIADIC_SLOTS } from './scan.js';
import { HANDLE_STDERR, HANDLE_STDIN, HANDLE_STDOUT } from '../kernel32/console.js';
import { EACCES, EINVAL, ENOENT } from './globals.js';

/**
 * Buffered file streams: fopen and the calls that take what it hands out.
 *
 * A FILE is a real record in guest memory, laid out as msvcrt's `_iobuf`, so
 * that what a program compiled against still holds: `_fileno` is a macro that
 * reads `_file`, and the inline `getc` reads `_cnt` before calling `_filbuf`.
 * The record says it holds no buffered bytes, which sends every such macro to
 * the function it falls back to, and the bytes themselves come from the
 * volume on each call: a stream is a position over a volume node, and the
 * volume's own store is the buffer.
 */

/** msvcrt's `_iobuf`: eight dwords. */
const FILE_SIZE = 32;
const FILE_FLAG = 12;
const FILE_FILE = 16;

/**
 * `_iob`: the runtime's own streams, stdin, stdout and stderr first, twenty
 * records in all. A program reaches the first three as `&_iob[n]`, the
 * address it imported plus a record's size per stream.
 */
const IOB_ENTRIES = 20;
const STANDARD_STREAMS = [HANDLE_STDIN, HANDLE_STDOUT, HANDLE_STDERR];

/** `_flag` bits, as the runtime sets them from the mode string. */
const IOREAD = 0x0001;
const IOWRT = 0x0002;
const IORW = 0x0080;
const IOEOF = 0x0010;
const IOERR = 0x0020;

const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;
const EOF = -1;

const MAX_STRING = 1 << 20;

/** `setvbuf`'s mode argument, at the values msvcrt gives them. */
const IOFBF = 0x0000;
const IOLBF = 0x0040;
const IONBF = 0x0004;

/**
 * @typedef {Object} StdioHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => boolean} free
 * @property {any} files  The volume: open, read, write, close, stat.
 * @property {(handle: number, text: string) => void} [write]
 *           The console, for the standard streams.
 * @property {() => number} [iob]  Where `_iob` was placed, once it has been.
 * @property {(code: number) => void} [errno]  Where a failure says why.
 */

/**
 * @typedef {Object} Stream
 * @property {any} node       The volume's open file; null for a standard stream.
 * @property {string} path
 * @property {number} position
 * @property {number} flags
 * @property {number} [console]  The standard handle a standard stream writes to.
 */

/**
 * The mode string, read as the runtime reads it: the first letter says what,
 * `+` widens it, `b` and `t` are accepted and mean nothing on a volume that
 * has no text translation to do.
 *
 * @param {string} mode
 * @returns {{ read: boolean, write: boolean, create: boolean, truncate: boolean,
 *            append: boolean, flags: number } | null}
 */
function parseMode(mode){
    const kind = mode[0];
    const plus = mode.slice(1).includes('+');
    switch (kind){
        case 'r':
            return { read: true, write: plus, create: false, truncate: false, append: false,
                flags: plus ? IORW : IOREAD };
        case 'w':
            return { read: plus, write: true, create: true, truncate: true, append: false,
                flags: plus ? IORW : IOWRT };
        case 'a':
            return { read: plus, write: true, create: true, truncate: false, append: true,
                flags: plus ? IORW : IOWRT };
        default:
            return null;
    }
}

/**
 * @param {StdioHost} host
 */
export function createStdioFunctions(host){
    /** @type {Map<number, Stream>} */
    const streams = new Map();

    /** @param {number} pointer */
    const readString = pointer=>host.readCString(pointer, MAX_STRING);

    /** @param {number} code */
    const fail = code=>{
        host.errno?.(code);
    };

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>host.writeMemory(address, new Uint8Array([
        value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
    ]));

    /**
     * The stream a record is. One of `_iob`'s first three is a standard
     * stream the first time it is used: nothing opens them, and the program's
     * `stdout` is only ever the address of a record in the runtime's image.
     *
     * @param {number} pointer
     * @returns {Stream | null}
     */
    const streamOf = pointer=>{
        const known = streams.get(pointer >>> 0);
        if (known)
        {
            return known;
        }
        const base = host.iob?.() ?? 0;
        const offset = (pointer >>> 0) - base;
        if (base === 0 || offset < 0 || offset % FILE_SIZE !== 0
            || offset / FILE_SIZE >= STANDARD_STREAMS.length)
        {
            return null;
        }
        const index = offset / FILE_SIZE;
        /** @type {Stream} */
        const stream = {
            node: null, path: '', position: 0,
            flags: index === 0 ? IOREAD : IOWRT,
            console: STANDARD_STREAMS[index],
        };
        streams.set(pointer >>> 0, stream);
        return stream;
    };

    /**
     * Writes to a standard stream: the console, a byte to a character.
     *
     * @param {Stream} stream
     * @param {string} text
     */
    const toConsole = (stream, text)=>{
        host.write?.(/** @type {number} */ (stream.console), text);
    };

    /** @param {Stream} stream @param {number} bit */
    const raise = (stream, bit)=>{
        stream.flags |= bit;
    };

    /** @param {Stream} stream */
    const sizeOf = stream=>host.files.stat(stream.path)?.size ?? 0;

    /**
     * A cdecl entry: the caller cleans up, so `argBytes` is only what the
     * bridge reads off the stack.
     *
     * @param {number} argBytes
     * @param {(args: number[]) => number | Promise<number>} handler
     */
    const cdecl = (argBytes, handler)=>({ convention: 'cdecl', argBytes, handler });

    return {
        /**
         * FILE _iob[20]
         *
         * Data, not code: the records themselves, at the address a program
         * imported. The first three are the standard streams, each saying
         * which it is in `_file` as `_fileno` reads it.
         */
        _iob: {
            data: ()=>{
                const bytes = new Uint8Array(IOB_ENTRIES * FILE_SIZE);
                const view = new DataView(bytes.buffer);
                STANDARD_STREAMS.forEach((_, index)=>{
                    view.setUint32(index * FILE_SIZE + FILE_FLAG,
                        index === 0 ? IOREAD : IOWRT, true);
                    view.setUint32(index * FILE_SIZE + FILE_FILE, index, true);
                });
                return bytes;
            },
        },

        /** FILE *__iob_func(void) -- the same array, for a runtime that asks by call. */
        __iob_func: cdecl(0, ()=>host.iob?.() ?? 0),

        /** FILE *__p__iob(void) */
        __p__iob: cdecl(0, ()=>host.iob?.() ?? 0),

        /**
         * FILE *fopen(const char *filename, const char *mode)
         *
         * NULL when the volume has no such file, or the mode is not one; the
         * record is the program's to pass back until fclose frees it. A null
         * or empty name and a mode that is not one are EINVAL; a name that is
         * not there is ENOENT, and one that is and cannot be opened EACCES.
         */
        fopen: cdecl(8, ([path, mode])=>{
            const parsed = (mode >>> 0) === 0 ? null : parseMode(readString(mode));
            const text = (path >>> 0) === 0 ? '' : readString(path);
            if (!parsed || text === '')
            {
                fail(EINVAL);
                return 0;
            }
            const node = host.files.open(text, {
                read: parsed.read, write: parsed.write, create: parsed.create,
                truncate: parsed.truncate,
            });
            if (!node)
            {
                fail(host.files.stat(text) ? EACCES : ENOENT);
                return 0;
            }
            const record = host.allocate(FILE_SIZE);
            if (record === 0)
            {
                host.files.close(node);
                return 0;
            }
            host.writeMemory(record, new Uint8Array(FILE_SIZE));
            writeU32(record + FILE_FLAG, parsed.flags);
            // A descriptor of its own, above the three standard ones, as
            // `_fileno` would read it. Never the address: a program that
            // passes it to _get_osfhandle wants a small number, and a wrong
            // handle is worse than one it cannot use.
            writeU32(record + FILE_FILE, 3 + streams.size);
            const stream = { node, path: text, position: 0, flags: parsed.flags };
            if (parsed.append)
            {
                stream.position = sizeOf(stream);
            }
            streams.set(record, stream);
            return record;
        }),

        /**
         * int fclose(FILE *stream)
         *
         * EOF for a stream that is not one; a null one is also EINVAL, where
         * one closed already leaves errno as it was.
         */
        fclose: cdecl(4, ([pointer])=>{
            const stream = streamOf(pointer);
            if (!stream)
            {
                if ((pointer >>> 0) === 0)
                {
                    fail(EINVAL);
                }
                return EOF;
            }
            // A standard stream is the runtime's, not the program's to free.
            if (stream.console !== undefined)
            {
                return 0;
            }
            host.files.close(stream.node);
            streams.delete(pointer >>> 0);
            host.free(pointer >>> 0);
            return 0;
        }),

        /**
         * size_t fread(void *buffer, size_t size, size_t count, FILE *stream)
         *
         * Whole elements only, as the runtime counts them: a short read of
         * the last element is bytes the caller was not given and a count that
         * does not include them. The bytes may be on their way, in which case
         * the caller parks on them.
         */
        fread: cdecl(16, ([buffer, size, count, pointer])=>{
            const stream = streamOf(pointer);
            const wanted = (size >>> 0) * (count >>> 0);
            if (!stream || wanted === 0 || (stream.flags & (IOREAD | IORW)) === 0)
            {
                return 0;
            }
            // Nobody types into the console, so standard input is at its end.
            if (stream.console !== undefined)
            {
                raise(stream, IOEOF);
                return 0;
            }
            /** @param {Uint8Array} bytes */
            const deliver = bytes=>{
                const elements = Math.floor(bytes.length / (size >>> 0));
                const taken = elements * (size >>> 0);
                if (taken > 0)
                {
                    host.writeMemory(buffer >>> 0, bytes.subarray(0, taken));
                }
                stream.position += taken;
                if (bytes.length < wanted)
                {
                    raise(stream, IOEOF);
                }
                return elements;
            };
            const bytes = host.files.read(stream.node, stream.position, wanted);
            return typeof bytes?.then === 'function' ? bytes.then(deliver) : deliver(bytes);
        }),

        /** size_t fwrite(const void *buffer, size_t size, size_t count, FILE *stream) */
        fwrite: cdecl(16, ([buffer, size, count, pointer])=>{
            const stream = streamOf(pointer);
            const wanted = (size >>> 0) * (count >>> 0);
            if (!stream || wanted === 0 || (stream.flags & (IOWRT | IORW)) === 0)
            {
                return 0;
            }
            const bytes = host.readMemory(buffer >>> 0, wanted).slice();
            if (stream.console !== undefined)
            {
                toConsole(stream, String.fromCharCode(...bytes));
                return count >>> 0;
            }
            const stored = host.files.write(stream.node, stream.position, bytes);
            stream.position += stored;
            if (stored < wanted)
            {
                raise(stream, IOERR);
            }
            return Math.floor(stored / (size >>> 0));
        }),

        /**
         * int fseek(FILE *stream, long offset, int origin)
         *
         * Zero on success; a seek clears the end-of-file condition, which a
         * program that rewinds to read again depends on.
         */
        fseek: cdecl(12, ([pointer, offset, origin])=>{
            const stream = streamOf(pointer);
            if (!stream || stream.console !== undefined)
            {
                return -1;
            }
            const base = origin === SEEK_SET ? 0
                : origin === SEEK_CUR ? stream.position
                    : origin === SEEK_END ? sizeOf(stream) : -1;
            if (base < 0 || base + (offset | 0) < 0)
            {
                return -1;
            }
            stream.position = base + (offset | 0);
            stream.flags &= ~IOEOF;
            return 0;
        }),

        /** long ftell(FILE *stream) -- -1 for a stream that is not one. */
        ftell: cdecl(4, ([pointer])=>streamOf(pointer)?.position ?? -1),

        /**
         * int fprintf(FILE *stream, const char *format, ...)
         *
         * A negative count on a stream that is not open for writing, exactly
         * as `fwrite` answers -- nothing here has an error code of its own to
         * report through, so the same sentinel a failed write already gives.
         */
        fprintf: cdecl(8 + VARIADIC_SLOTS * 4, args=>{
            const [pointer, format] = args;
            const stream = streamOf(pointer);
            if (!stream || (stream.flags & (IOWRT | IORW)) === 0)
            {
                return EOF;
            }
            const text = formatToString(readString(format), args.slice(2), readString);
            if (stream.console !== undefined)
            {
                toConsole(stream, text);
                return text.length;
            }
            const bytes = new TextEncoder().encode(text);
            const stored = host.files.write(stream.node, stream.position, bytes);
            stream.position += stored;
            if (stored < bytes.length)
            {
                raise(stream, IOERR);
                return EOF;
            }
            return text.length;
        }),

        /**
         * int setvbuf(FILE *stream, char *buffer, int mode, size_t size)
         *
         * Every stream here reads and writes straight through to the volume
         * with no buffer of its own, so a valid request is accepted and does
         * nothing -- which is the buffering this call already promised.
         */
        setvbuf: cdecl(16, ([pointer, , mode])=>{
            const stream = streamOf(pointer);
            if (!stream || (mode !== IOFBF && mode !== IOLBF && mode !== IONBF))
            {
                return -1;
            }
            return 0;
        }),
    };
}
