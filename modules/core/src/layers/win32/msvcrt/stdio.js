/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

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

/**
 * @typedef {Object} StdioHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => boolean} free
 * @property {any} files  The volume: open, read, write, close, stat.
 */

/**
 * @typedef {Object} Stream
 * @property {any} node       The volume's open file.
 * @property {string} path
 * @property {number} position
 * @property {number} flags
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

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>host.writeMemory(address, new Uint8Array([
        value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
    ]));

    /** @param {number} pointer */
    const streamOf = pointer=>streams.get(pointer >>> 0) ?? null;

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
         * FILE *fopen(const char *filename, const char *mode)
         *
         * NULL when the volume has no such file, or the mode is not one; the
         * record is the program's to pass back until fclose frees it.
         */
        fopen: cdecl(8, ([path, mode])=>{
            const parsed = parseMode(readString(mode));
            if (!parsed)
            {
                return 0;
            }
            const text = readString(path);
            const node = host.files.open(text, {
                read: parsed.read, write: parsed.write, create: parsed.create,
                truncate: parsed.truncate,
            });
            if (!node)
            {
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

        /** int fclose(FILE *stream) -- EOF for a stream that is not one. */
        fclose: cdecl(4, ([pointer])=>{
            const stream = streamOf(pointer);
            if (!stream)
            {
                return EOF;
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
            if (!stream)
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
    };
}
