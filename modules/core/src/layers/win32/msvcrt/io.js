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
 * Text mode belongs to the descriptor: a read folds CR LF into LF and stops at
 * a ^Z, a write puts CR before every LF. Which mode a file opens in is the
 * caller's `_O_TEXT` or `_O_BINARY`, and when it names neither, the runtime's
 * `_fmode`, which starts out text.
 */

import { HANDLE_STDERR, HANDLE_STDIN, HANDLE_STDOUT } from '../kernel32/console.js';
import { EACCES, EBADF, EEXIST, EINVAL, EMFILE, ENOENT, ENOSPC } from './globals.js';

/** `_open` flags, at msvcrt's values (fcntl.h). */
const O_WRONLY = 0x0001;
const O_RDWR = 0x0002;
const O_ACCMODE = 0x0003;
const O_APPEND = 0x0008;
const O_CREAT = 0x0100;
const O_TRUNC = 0x0200;
const O_EXCL = 0x0400;
const O_TEXT = 0x4000;
export const O_BINARY = 0x8000;

/** msvcrt's own ceiling on open descriptors. */
const MAX_DESCRIPTORS = 2048;

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
    DEV: 0, INO: 4, MODE: 6, NLINK: 8, UID: 10, GID: 12, RDEV: 16, SIZE: 20,
    ATIME: 24, MTIME: 28, CTIME: 32, BYTES: 36,
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
 * Bytes as the string the console sink takes, a byte to a character.
 *
 * @param {Uint8Array} bytes
 */
export function latin1(bytes){
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x2000)
    {
        text += String.fromCharCode(...bytes.subarray(at, at + 0x2000));
    }
    return text;
}

/**
 * @typedef {Object} Descriptor
 * @property {any} node          The volume's open file; null for the console.
 * @property {string} path
 * @property {number} position   The file offset the next read or write starts at.
 * @property {boolean} read
 * @property {boolean} write
 * @property {boolean} append    Every write goes to the end of the file first.
 * @property {boolean} text
 * @property {boolean} ended     A ^Z was read: reads answer nothing until a seek.
 * @property {number} [console]  The standard handle a console descriptor stands for.
 * @property {{ offset: number, bytes: Uint8Array, whole: boolean } | null} ahead
 *           What a stream read last took from the volume; `whole` when that
 *           read reached the end of the file.
 */

/**
 * @typedef {Object} OpenRequest
 * @property {boolean} read
 * @property {boolean} write
 * @property {boolean} [create]
 * @property {boolean} [truncate]
 * @property {boolean} [exclusive]  Refuse a file that is already there.
 * @property {boolean} [append]
 * @property {boolean | null} [text]  Null: whatever `_fmode` says.
 */

/**
 * @typedef {Object} DescriptorHost
 * @property {any} files  The volume: open, read, write, close, stat.
 * @property {(handle: number, text: string) => void} [write]  The console.
 * @property {(code: number) => void} [errno]
 * @property {() => number} [fmode]  The runtime's `_fmode`.
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

    /** @param {number} handle @param {boolean} read */
    const console = (handle, read)=>({
        node: null, path: '', position: 0, read, write: !read, append: false, text: true,
        ended: false, console: handle, ahead: null,
    });
    table.set(0, console(HANDLE_STDIN, true));
    table.set(1, console(HANDLE_STDOUT, false));
    table.set(2, console(HANDLE_STDERR, false));

    /** @param {number} code */
    const fail = code=>{
        host.errno?.(code);
    };

    /** @param {Descriptor} descriptor */
    const sizeOf = descriptor=>host.files.stat(descriptor.path)?.size ?? 0;

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
        /** @param {number} fd @returns {Descriptor | null} */
        get: fd=>table.get(fd | 0) ?? null,

        /**
         * Opens a file and answers with the lowest number free, or -1 with
         * errno saying why: the name is not there, it is and was to be made
         * new, or it is and cannot be opened this way.
         *
         * @param {string} path @param {OpenRequest} request
         */
        open(path, request){
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
            table.set(fd, {
                node, path, position: 0, read: request.read, write: request.write,
                append: Boolean(request.append),
                text: request.text ?? ((host.fmode?.() ?? 0) & O_BINARY) === 0,
                ended: false, ahead: null,
            });
            return fd;
        },

        /**
         * Gives a descriptor back. The console's three stay: they are the
         * runtime's, and a program that closes one to silence it still has
         * its standard streams.
         *
         * @param {number} fd @returns {boolean} false for a number not open
         */
        close(fd){
            const descriptor = table.get(fd | 0);
            if (!descriptor)
            {
                return false;
            }
            if (descriptor.node !== null)
            {
                table.delete(fd | 0);
                host.files.close(descriptor.node);
            }
            return true;
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
         * going to the end of the file since nothing after it is data.
         *
         * @param {Descriptor} descriptor @param {number} limit @param {boolean} line
         * @returns {Uint8Array | Promise<Uint8Array>}
         */
        pull(descriptor, limit, line){
            if (descriptor.node === null || descriptor.ended || limit <= 0)
            {
                return new Uint8Array(0);
            }
            if (!descriptor.text)
            {
                return settle(readAhead(descriptor, descriptor.position, limit), raw=>{
                    const stop = line ? raw.indexOf(LF) : -1;
                    const taken = raw.slice(0, stop < 0 ? raw.length : stop + 1);
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
         * stored whole; in text mode each LF goes out as CR LF.
         *
         * @param {Descriptor} descriptor @param {Uint8Array} bytes
         */
        put(descriptor, bytes){
            if (descriptor.node === null)
            {
                host.write?.(/** @type {number} */ (descriptor.console), latin1(bytes));
                return bytes.length;
            }
            if (descriptor.append)
            {
                descriptor.position = sizeOf(descriptor);
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
     * Fills a whole `struct _stat`, so no field keeps what the caller's
     * buffer held. The volume keeps one time per file, the last write, and
     * it stands for all three.
     *
     * @param {number} address
     * @param {{ device: number, mode: number, size: number, modified: number }} entry
     */
    const writeStat = (address, entry)=>{
        const bytes = new Uint8Array(STAT.BYTES);
        const view = new DataView(bytes.buffer);
        view.setUint32(STAT.DEV, entry.device, true);
        view.setUint16(STAT.MODE, entry.mode, true);
        view.setInt16(STAT.NLINK, 1, true);
        view.setUint32(STAT.RDEV, entry.device, true);
        view.setUint32(STAT.SIZE, entry.size >>> 0, true);
        const time = seconds(entry.modified);
        view.setUint32(STAT.ATIME, time, true);
        view.setUint32(STAT.MTIME, time, true);
        view.setUint32(STAT.CTIME, time, true);
        host.writeMemory(address >>> 0, bytes);
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

    return {
        /**
         * int _open(const char *filename, int oflag [, int pmode])
         *
         * The permission argument only marks a new file read-only on Windows,
         * and the volume keeps no such bit, so it is read and not used.
         */
        _open: cdecl(12, ([path, oflag])=>{
            const flags = oflag >>> 0;
            const access = flags & O_ACCMODE;
            if ((path >>> 0) === 0 || access === O_ACCMODE)
            {
                fail(EINVAL);
                return -1;
            }
            return descriptors.open(host.readCString(path >>> 0, MAX_STRING), {
                read: access !== O_WRONLY,
                write: access === O_WRONLY || access === O_RDWR,
                create: (flags & O_CREAT) !== 0,
                truncate: (flags & O_TRUNC) !== 0,
                exclusive: (flags & (O_CREAT | O_EXCL)) === (O_CREAT | O_EXCL),
                append: (flags & O_APPEND) !== 0,
                text: (flags & O_BINARY) !== 0 ? false : ((flags & O_TEXT) !== 0 ? true : null),
            });
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
            if (wanted === 0 || descriptor.node === null || descriptor.ended)
            {
                return 0;
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
        _lseek: cdecl(12, ([fd, offset, origin])=>{
            const descriptor = descriptors.get(fd | 0);
            if (!descriptor || descriptor.node === null)
            {
                fail(EBADF);
                return -1;
            }
            const base = origin === SEEK_SET ? 0
                : origin === SEEK_CUR ? descriptor.position
                    : origin === SEEK_END ? descriptors.size(descriptor) : -1;
            const position = base + (offset | 0);
            if (base < 0 || position < 0)
            {
                fail(EINVAL);
                return -1;
            }
            descriptors.seek(descriptor, position);
            return position;
        }),

        /**
         * int _fstat(int fd, struct _stat *buffer)
         *
         * A file is a regular file anyone may read and write, on device 0; a
         * console descriptor is a character device whose device is its number.
         */
        _fstat: cdecl(8, ([fd, buffer])=>{
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
                writeStat(buffer, { device: fd | 0, mode: S_IFCHR, size: 0, modified: 0 });
                return 0;
            }
            const entry = host.files.stat(descriptor.path);
            writeStat(buffer, {
                device: 0, mode: S_IFREG | ALL_READ | ALL_WRITE,
                size: entry?.size ?? 0, modified: entry?.modified ?? 0,
            });
            return 0;
        }),

        /**
         * int _stat(const char *path, struct _stat *buffer)
         *
         * -1 and ENOENT for a name that is not there, for a bare "C:", and for
         * a name with a separator after it that is not a drive's root -- as
         * Windows answers, trailing spaces aside. The device is the drive's
         * number, A being 0; a directory and a program are executable.
         */
        _stat: cdecl(8, ([path, buffer])=>{
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
            });
            return 0;
        }),
    };
}
