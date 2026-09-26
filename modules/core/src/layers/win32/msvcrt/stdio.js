/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { formatToString } from './format.js';
import { VARIADIC_SLOTS } from './scan.js';
import { EBADF, EILSEQ, EINVAL } from './globals.js';
import { createDescriptors, LF, settle } from './io.js';
import {
    O_U16TEXT, O_U8TEXT, O_WTEXT, bytesOfUnits, unitsOf, wideStringAt,
} from './widetext.js';

/**
 * Buffered file streams: fopen and the calls that take what it hands out.
 *
 * A FILE is a real record in guest memory, laid out as msvcrt's `_iobuf`, so
 * that what a program compiled against still holds: `_fileno` is a macro that
 * reads `_file`, `feof` and `ferror` are macros that read `_flag`, and the
 * inline `getc` and `putc` count `_cnt` down before calling `_filbuf` and
 * `_flsbuf`. The record says it holds no buffered bytes, which sends every
 * such macro to the function it falls back to; those two set `_cnt` back to
 * zero past the macro's decrement, and every change to the flags is written
 * to `_flag` as it happens, so the macros see the end of the file too.
 *
 * A stream stands on a descriptor -- the number in `_file` -- whose position
 * is the stream's, so `ftell(f)` and `_lseek(_fileno(f), 0, SEEK_CUR)` agree.
 * Text mode is the descriptor's: CR LF reads as LF and a ^Z ends the data,
 * LF writes as CR LF. Writes go straight through to the volume, which is why
 * nothing here is ever left to flush.
 */

/** msvcrt's `_iobuf`: eight dwords. */
const FILE_SIZE = 32;
const FILE_CNT = 4;
const FILE_FLAG = 12;
const FILE_FILE = 16;

/**
 * `_iob`: the runtime's own streams, stdin, stdout and stderr first, twenty
 * records in all. A program reaches the first three as `&_iob[n]`, the
 * address it imported plus a record's size per stream.
 */
const IOB_ENTRIES = 20;
const STANDARD_STREAMS = 3;

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

/** A `wint_t` is sixteen bits, and this is the one no character read is. */
const WEOF = 0xffff;

const MAX_STRING = 1 << 20;

/** @param {string} text */
const unitsOfText = text=>Array.from({ length: text.length }, (_, at)=>text.charCodeAt(at));

/** `setvbuf`'s mode argument, at the values msvcrt gives them. */
const IOFBF = 0x0000;
const IOLBF = 0x0040;
const IONBF = 0x0004;

/**
 * The records of stdin, stdout and stderr, where `_iob` keeps them: nothing
 * before the runtime's image has placed `_iob`.
 *
 * @param {number} iob
 */
export const standardRecords = iob=>(iob === 0 ? []
    : Array.from({ length: STANDARD_STREAMS }, (_, index)=>iob + index * FILE_SIZE));

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
 * @property {import('./io.js').Descriptors} [descriptors]
 *           The runtime's descriptor table, shared with `_open` and the rest;
 *           absent, the streams keep one of their own.
 * @property {() => number} [fmode]  The runtime's `_fmode`, for that table.
 * @property {(list: number) => number[]} [varargs]
 *           The argument slots a `va_list` points at, for vprintf.
 */

/**
 * @typedef {Object} Stream
 * @property {number} record   The FILE in guest memory.
 * @property {number} fd       The descriptor it stands on.
 * @property {number} flags    What `_flag` holds.
 * @property {number[]} pushback  What ungetc gave back, the next to read last.
 */

/** fopen's `ccs=` names, case aside, and the Unicode translation each opens in. */
const CCS = new Map([['unicode', O_WTEXT], ['utf-8', O_U8TEXT], ['utf-16le', O_U16TEXT]]);

/**
 * The mode string, read as the runtime reads it: the first letter says what,
 * `+` widens it, and `b` or `t` names the translation; neither leaves it to
 * the runtime's `_fmode`. `D` makes the file temporary, removed when the
 * stream closes. After a comma, `ccs=` names a Unicode translation --
 * UNICODE, UTF-8 or UTF-16LE -- which `b` overrides (Wine's msvcrt
 * test_fopen_s); anything else there makes it no mode at all.
 *
 * @param {string} mode
 * @returns {{ read: boolean, write: boolean, create: boolean, truncate: boolean,
 *            append: boolean, flags: number, text: boolean | null,
 *            temporary: boolean, unicode: number } | null}
 */
function parseMode(mode){
    const comma = mode.indexOf(',');
    const named = comma < 0 ? null : /^ *ccs=([\w-]+) *$/i.exec(mode.slice(comma + 1));
    const ccs = named ? CCS.get(named[1].toLowerCase()) ?? 0 : 0;
    if (comma >= 0 && ccs === 0)
    {
        return null;
    }
    const rest = mode.slice(1, comma < 0 ? mode.length : comma);
    const plus = rest.includes('+');
    const text = /[bt]/.test(rest) ? rest.lastIndexOf('t') > rest.lastIndexOf('b') : null;
    const temporary = rest.includes('D');
    const unicode = text === false ? 0 : ccs;
    switch (mode[0]){
        case 'r':
            return { read: true, write: plus, create: false, truncate: false, append: false,
                flags: plus ? IORW : IOREAD, text, temporary, unicode };
        case 'w':
            return { read: plus, write: true, create: true, truncate: true, append: false,
                flags: plus ? IORW : IOWRT, text, temporary, unicode };
        case 'a':
            return { read: plus, write: true, create: true, truncate: false, append: true,
                flags: plus ? IORW : IOWRT, text, temporary, unicode };
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

    const descriptors = host.descriptors ?? createDescriptors({
        files: host.files, write: host.write, errno: host.errno, fmode: host.fmode,
    });

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

    /** @param {string} text */
    const bytesOf = text=>Uint8Array.from(text, character=>character.charCodeAt(0) & 0xff);

    /**
     * Which of `_iob`'s standard three a record is, or -1.
     *
     * @param {number} pointer
     */
    const standardIndex = pointer=>{
        const base = host.iob?.() ?? 0;
        const offset = (pointer >>> 0) - base;
        return base === 0 || offset < 0 || offset % FILE_SIZE !== 0
            || offset / FILE_SIZE >= STANDARD_STREAMS ? -1 : offset / FILE_SIZE;
    };

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
        const index = standardIndex(pointer);
        if (index < 0)
        {
            return null;
        }
        /** @type {Stream} */
        const stream = {
            record: pointer >>> 0, fd: index, flags: index === 0 ? IOREAD : IOWRT, pushback: [],
        };
        streams.set(pointer >>> 0, stream);
        return stream;
    };

    /**
     * stdin, stdout or stderr by its index in `_iob`, or null before the
     * runtime's image has placed it.
     *
     * @param {number} index
     */
    const standardStream = index=>{
        const base = host.iob?.() ?? 0;
        return base === 0 ? null : streamOf(base + index * FILE_SIZE);
    };

    /**
     * The stream, or null -- a null pointer being the one case a call is
     * documented to report, as EINVAL.
     *
     * @param {number} pointer
     */
    const argument = pointer=>{
        const stream = streamOf(pointer);
        if (!stream && (pointer >>> 0) === 0)
        {
            fail(EINVAL);
        }
        return stream;
    };

    /** @param {Stream} stream @param {number} flags */
    const setFlags = (stream, flags)=>{
        stream.flags = flags;
        writeU32(stream.record + FILE_FLAG, flags);
    };

    /** @param {Stream} stream @param {number} bit */
    const raise = (stream, bit)=>setFlags(stream, stream.flags | bit);

    /** @param {Stream} stream */
    const readable = stream=>(stream.flags & (IOREAD | IORW)) !== 0;

    /** @param {Stream} stream */
    const writable = stream=>(stream.flags & (IOWRT | IORW)) !== 0;

    /** @param {Stream} stream */
    const descriptorOf = stream=>descriptors.get(stream.fd);

    /**
     * Points a stream at a descriptor: what `_fileno` and the macros read
     * from the record, and no bytes held, so the macros call back in.
     *
     * @param {Stream} stream @param {number} fd @param {number} flags
     */
    const standOn = (stream, fd, flags)=>{
        stream.fd = fd;
        stream.pushback.length = 0;
        writeU32(stream.record + FILE_FILE, fd);
        writeU32(stream.record + FILE_CNT, 0);
        setFlags(stream, flags);
    };

    /**
     * A new record for a stream on a descriptor, the program's to pass back
     * until fclose frees it; 0 when the heap has no room.
     *
     * @param {number} fd @param {number} flags
     */
    const attach = (fd, flags)=>{
        const record = host.allocate(FILE_SIZE);
        if (record === 0)
        {
            return 0;
        }
        host.writeMemory(record, new Uint8Array(FILE_SIZE));
        const stream = { record, fd, flags: 0, pushback: [] };
        standOn(stream, fd, flags);
        streams.set(record, stream);
        return record;
    };

    /**
     * Ends a stream whose descriptor is already closed. Its record is freed,
     * unless it is one of the standard three, which are the runtime's: one
     * that freopen moved to a file goes back on the console it started on.
     *
     * @param {Stream} stream
     */
    const forget = stream=>{
        const index = standardIndex(stream.record);
        if (index < 0)
        {
            streams.delete(stream.record);
            host.free(stream.record);
        }
        else if (stream.fd !== index)
        {
            standOn(stream, index, index === 0 ? IOREAD : IOWRT);
        }
    };

    /**
     * fclose's body: the descriptor closes -- the console's stays open, as it
     * always does -- and the stream ends.
     *
     * @param {Stream} stream @returns {boolean} whether the descriptor closed
     */
    const release = stream=>{
        const closed = descriptors.close(stream.fd);
        forget(stream);
        return closed;
    };

    /**
     * Where the program is in the stream: the descriptor's position, less
     * what ungetc gave back and the program has not read again.
     *
     * @param {Stream} stream
     */
    const tellOf = stream=>
        Math.max(0, (descriptorOf(stream)?.position ?? 0) - stream.pushback.length);

    /**
     * Moves a stream to a place in its file. The end-of-file condition
     * clears, which a program that rewinds to read again depends on, and
     * what ungetc gave back is forgotten. False for the console, which does
     * not seek, and with EINVAL for a place before the start.
     *
     * @param {Stream} stream @param {number} position
     */
    const reposition = (stream, position)=>{
        const descriptor = descriptorOf(stream);
        if (!descriptor || descriptor.node === null)
        {
            return false;
        }
        if (position < 0)
        {
            fail(EINVAL);
            return false;
        }
        descriptors.seek(descriptor, position);
        stream.pushback.length = 0;
        setFlags(stream, stream.flags & ~IOEOF);
        return true;
    };

    /**
     * Whether a stream's descriptor is in a Unicode translation, which the
     * narrow character calls do not read or write -- "fputc doesn't
     * currently support output into a UNICODE stream", and the runtime
     * asserts on a narrow print into one; here it is an error on the stream
     * and EINVAL. Such a stream is for the wide calls, and for fread and
     * fwrite, whose bytes in a Unicode translation are UTF-16.
     *
     * @param {Stream} stream
     */
    const narrowRefused = stream=>{
        if ((descriptorOf(stream)?.unicode ?? 0) === 0)
        {
            return false;
        }
        raise(stream, IOERR);
        fail(EINVAL);
        return true;
    };

    /**
     * Up to `limit` bytes as the program reads them: what ungetc gave back
     * first, then the file, stopping after a line feed when `line` says so --
     * with `width` 2, after the two bytes of an LF in UTF-16.
     *
     * @param {Stream} stream @param {number} limit @param {boolean} line
     * @param {1 | 2} [width]
     * @returns {Uint8Array | Promise<Uint8Array>}
     */
    const take = (stream, limit, line, width = 1)=>{
        /** @type {number[]} */
        const head = [];
        while (stream.pushback.length > 0 && head.length < limit)
        {
            head.push(/** @type {number} */ (stream.pushback.pop()));
            if (line && head.length % width === 0 && head[head.length - width] === LF
                && head[head.length - 1] === (width === 1 ? LF : 0))
            {
                return Uint8Array.from(head);
            }
        }
        const descriptor = descriptorOf(stream);
        if (head.length === limit || !descriptor)
        {
            return Uint8Array.from(head);
        }
        return settle(descriptors.pull(descriptor, limit - head.length, line, width === 2), rest=>{
            if (head.length === 0)
            {
                return rest;
            }
            const joined = new Uint8Array(head.length + rest.length);
            joined.set(head);
            joined.set(rest, head.length);
            return joined;
        });
    };

    /**
     * Writes the caller's bytes and answers with how many were stored; a
     * short write is an error the stream keeps.
     *
     * @param {Stream} stream @param {Uint8Array} bytes
     */
    const emit = (stream, bytes)=>{
        const descriptor = descriptorOf(stream);
        const stored = descriptor ? descriptors.put(descriptor, bytes) : 0;
        if (stored < bytes.length)
        {
            raise(stream, IOERR);
        }
        return stored;
    };

    /**
     * A write to a stream not open for writing: an error on the stream, and
     * EBADF, the descriptor refusing it.
     *
     * @param {Stream} stream
     */
    const refuseWrite = stream=>{
        raise(stream, IOERR);
        fail(EBADF);
    };

    /**
     * The byte `fgetc` answers with, or EOF, the end of the file marking the
     * stream so `feof` sees it.
     *
     * @param {Stream} stream
     * @returns {number | Promise<number>}
     */
    const nextByte = stream=>{
        if (narrowRefused(stream))
        {
            return EOF;
        }
        if (!readable(stream))
        {
            raise(stream, IOERR);
            return EOF;
        }
        return settle(take(stream, 1, false), bytes=>{
            if (bytes.length === 0)
            {
                raise(stream, IOEOF);
                return EOF;
            }
            return bytes[0];
        });
    };

    /**
     * fprintf's body: the count of characters formatted; a negative one on a
     * stream not open for writing, or when not all of them were stored.
     *
     * @param {Stream} stream @param {number} format @param {number[]} values
     */
    const printTo = (stream, format, values)=>{
        if (narrowRefused(stream))
        {
            return EOF;
        }
        if (!writable(stream))
        {
            refuseWrite(stream);
            return EOF;
        }
        const text = formatToString(readString(format), values, readString);
        return emit(stream, bytesOf(text)) === text.length ? text.length : EOF;
    };

    /**
     * fopen's body, for a name and a mode already read: the new record, or
     * NULL -- with EINVAL for an empty name or a mode that is not one, and the
     * descriptor saying why a name could not be opened.
     *
     * @param {string} name @param {string | null} mode
     * @returns {number | Promise<number>}
     */
    const openStream = (name, mode)=>{
        const parsed = mode === null ? null : parseMode(mode);
        if (!parsed || name === '')
        {
            fail(EINVAL);
            return 0;
        }
        return settle(descriptors.open(name, parsed), fd=>{
            if (fd < 0)
            {
                return 0;
            }
            const record = attach(fd, parsed.flags);
            if (record === 0)
            {
                descriptors.close(fd);
            }
            return record;
        });
    };

    /**
     * How many bytes of the stream a wide call takes to a character: the
     * two of a UTF-16 unit in a Unicode translation, where the descriptor
     * deals in them, and in binary mode, where they are what the file holds;
     * one in text mode, where a character is a multibyte one and the C
     * locale, this runtime's only locale, makes it a byte to U+00FF.
     *
     * @param {Stream} stream @returns {1 | 2}
     */
    const widthOf = stream=>{
        const descriptor = descriptorOf(stream);
        return descriptor && (descriptor.unicode !== 0 || !descriptor.text) ? 2 : 1;
    };

    /**
     * The character `fgetwc` answers with, or WEOF, the end of the file
     * marking the stream so `feof` sees it.
     *
     * @param {Stream} stream
     * @returns {number | Promise<number>}
     */
    const nextUnit = stream=>{
        if (!readable(stream))
        {
            raise(stream, IOERR);
            return WEOF;
        }
        const width = widthOf(stream);
        return settle(take(stream, width, false, width), bytes=>{
            if (bytes.length < width)
            {
                raise(stream, IOEOF);
                return WEOF;
            }
            return width === 2 ? bytes[0] | bytes[1] << 8 : bytes[0];
        });
    };

    /**
     * Writes UTF-16 units as the stream takes them (see `widthOf`) and
     * answers with how many went, or -1: for a stream not open for writing,
     * a short write, and a character text mode has no byte for, which is
     * EILSEQ with what came before it written.
     *
     * @param {Stream} stream @param {number[]} units
     */
    const putUnits = (stream, units)=>{
        if (!writable(stream))
        {
            refuseWrite(stream);
            return -1;
        }
        if (widthOf(stream) === 2)
        {
            return emit(stream, bytesOfUnits(units)) === units.length * 2 ? units.length : -1;
        }
        const unfit = units.findIndex(unit=>unit > 0xff);
        const bytes = Uint8Array.from(unfit < 0 ? units : units.slice(0, unfit));
        if (bytes.length > 0 && emit(stream, bytes) !== bytes.length)
        {
            return -1;
        }
        if (unfit >= 0)
        {
            fail(EILSEQ);
            return -1;
        }
        return units.length;
    };

    /** @param {number} pointer */
    const readWide = pointer=>wideStringAt(host.readMemory, pointer);

    /**
     * fwprintf's body: the count of wide characters written, or -1.
     *
     * @param {Stream} stream @param {number} format @param {number[]} values
     */
    const printWide = (stream, format, values)=>{
        if ((format >>> 0) === 0)
        {
            fail(EINVAL);
            return -1;
        }
        const text = formatToString(readWide(format), values, readString,
            { readWideString: readWide, wide: true });
        return putUnits(stream, unitsOfText(text)) < 0 ? -1 : text.length;
    };

    /** @param {Stream} stream @param {number} c */
    const putByte = (stream, c)=>{
        if (narrowRefused(stream))
        {
            return EOF;
        }
        if (!writable(stream))
        {
            refuseWrite(stream);
            return EOF;
        }
        return emit(stream, Uint8Array.of(c & 0xff)) === 1 ? c & 0xff : EOF;
    };

    /**
     * A cdecl entry: the caller cleans up, so `argBytes` is only what the
     * bridge reads off the stack.
     *
     * @param {number} argBytes
     * @param {(args: number[]) => number | Promise<number>} handler
     */
    const cdecl = (argBytes, handler)=>({ convention: 'cdecl', argBytes, handler });

    /** int fgetc(FILE *stream) / int getc(FILE *stream) */
    const fgetc = cdecl(4, ([pointer])=>{
        const stream = argument(pointer);
        return stream ? nextByte(stream) : EOF;
    });

    /** int fputc(int c, FILE *stream) / int putc(int c, FILE *stream) */
    const fputc = cdecl(8, ([c, pointer])=>{
        const stream = argument(pointer);
        return stream ? putByte(stream, c) : EOF;
    });

    /** wint_t fgetwc(FILE *stream) / wint_t getwc(FILE *stream) */
    const fgetwc = cdecl(4, ([pointer])=>{
        const stream = argument(pointer);
        return stream ? nextUnit(stream) : WEOF;
    });

    /** wint_t fputwc(wchar_t c, FILE *stream) / wint_t putwc(wchar_t c, FILE *stream) */
    const fputwc = cdecl(8, ([c, pointer])=>{
        const stream = argument(pointer);
        return stream && putUnits(stream, [c & 0xffff]) === 1 ? c & 0xffff : WEOF;
    });

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
                for (let index = 0; index < STANDARD_STREAMS; index++)
                {
                    view.setUint32(index * FILE_SIZE + FILE_FLAG,
                        index === 0 ? IOREAD : IOWRT, true);
                    view.setUint32(index * FILE_SIZE + FILE_FILE, index, true);
                }
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
         * or empty name and a mode that is not one are EINVAL; the descriptor
         * says why a name could not be opened.
         */
        fopen: cdecl(8, ([path, mode])=>openStream(
            (path >>> 0) === 0 ? '' : readString(path),
            (mode >>> 0) === 0 ? null : readString(mode))),

        /** FILE *_wfopen(const wchar_t *filename, const wchar_t *mode) -- fopen, wide. */
        _wfopen: cdecl(8, ([path, mode])=>openStream(
            (path >>> 0) === 0 ? '' : wideStringAt(host.readMemory, path),
            (mode >>> 0) === 0 ? null : wideStringAt(host.readMemory, mode))),

        /**
         * FILE *freopen(const char *filename, const char *mode, FILE *stream)
         *
         * Closes the stream's file and opens the one named in the same
         * record, which is the answer. When the new file cannot be opened
         * the old one is closed all the same, the stream with it, and the
         * answer is NULL (Wine's msvcrt test_freopen). A null or empty name,
         * a null stream and a mode that is not one are EINVAL, and close
         * nothing.
         */
        freopen: cdecl(12, ([path, mode, pointer])=>{
            const stream = argument(pointer);
            const parsed = (mode >>> 0) === 0 ? null : parseMode(readString(mode));
            const text = (path >>> 0) === 0 ? '' : readString(path);
            if (stream && (!parsed || text === ''))
            {
                fail(EINVAL);
            }
            if (!stream || !parsed || text === '')
            {
                return 0;
            }
            descriptors.close(stream.fd);
            return settle(descriptors.open(text, parsed), fd=>{
                if (fd < 0)
                {
                    forget(stream);
                    return 0;
                }
                standOn(stream, fd, parsed.flags);
                return stream.record;
            });
        }),

        /**
         * FILE *_fdopen(int fd, const char *mode)
         *
         * A stream on a descriptor already open, reading and writing from
         * where it stands; fclose closes the two together. The mode says
         * what the stream may do, and the translation stays the
         * descriptor's. A mode that is not one is EINVAL, checked before the
         * number, which is EBADF when it is not open.
         */
        _fdopen: cdecl(8, ([fd, mode])=>{
            const parsed = (mode >>> 0) === 0 ? null : parseMode(readString(mode));
            if (!parsed)
            {
                fail(EINVAL);
                return 0;
            }
            if (!descriptors.get(fd | 0))
            {
                fail(EBADF);
                return 0;
            }
            return attach(fd | 0, parsed.flags);
        }),

        /**
         * int fclose(FILE *stream)
         *
         * EOF for a stream that is not one; a null one is also EINVAL, where
         * one closed already leaves errno as it was.
         */
        fclose: cdecl(4, ([pointer])=>{
            const stream = argument(pointer);
            if (!stream)
            {
                return EOF;
            }
            return release(stream) ? 0 : EOF;
        }),

        /**
         * int _fcloseall(void)
         *
         * fclose on every stream but stdin, stdout and stderr, and the count
         * of them (Wine's msvcrt test_fopen_fclose_fcloseall).
         */
        _fcloseall: cdecl(0, ()=>{
            const opened = [...streams.values()].filter(stream=>standardIndex(stream.record) < 0);
            opened.forEach(release);
            return opened.length;
        }),

        /**
         * int _flushall(void)
         *
         * fflush on every stream: nothing waits to be written, and what
         * ungetc gave back is forgotten, so the next read comes from where
         * the descriptor is (Wine's msvcrt test_fflush). The answer is the
         * count of streams open, the standard three always among them.
         */
        _flushall: cdecl(0, ()=>{
            let opened = (host.iob?.() ?? 0) === 0 ? 0 : STANDARD_STREAMS;
            for (const stream of streams.values())
            {
                stream.pushback.length = 0;
                opened += standardIndex(stream.record) < 0 ? 1 : 0;
            }
            return opened;
        }),

        /**
         * size_t fread(void *buffer, size_t size, size_t count, FILE *stream)
         *
         * The count of whole elements read; every byte read is delivered and
         * consumed, a partial last element included, as the position is
         * documented to advance by what was read. The bytes may be on their
         * way, in which case the caller parks on them.
         */
        fread: cdecl(16, ([buffer, size, count, pointer])=>{
            const stream = argument(pointer);
            const wanted = (size >>> 0) * (count >>> 0);
            if (!stream || wanted === 0)
            {
                return 0;
            }
            if (!readable(stream))
            {
                raise(stream, IOERR);
                return 0;
            }
            return settle(take(stream, wanted, false), bytes=>{
                if (bytes.length > 0)
                {
                    host.writeMemory(buffer >>> 0, bytes);
                }
                if (bytes.length < wanted)
                {
                    raise(stream, IOEOF);
                }
                return Math.floor(bytes.length / (size >>> 0));
            });
        }),

        /**
         * size_t fwrite(const void *buffer, size_t size, size_t count, FILE *stream)
         *
         * In a Unicode translation the bytes are UTF-16, and an odd count of
         * them is EINVAL with nothing written.
         */
        fwrite: cdecl(16, ([buffer, size, count, pointer])=>{
            const stream = argument(pointer);
            const wanted = (size >>> 0) * (count >>> 0);
            if (!stream || wanted === 0)
            {
                return 0;
            }
            if (!writable(stream))
            {
                refuseWrite(stream);
                return 0;
            }
            if ((descriptorOf(stream)?.unicode ?? 0) !== 0 && wanted % 2 !== 0)
            {
                fail(EINVAL);
                return 0;
            }
            const stored = emit(stream, host.readMemory(buffer >>> 0, wanted).slice());
            return Math.floor(stored / (size >>> 0));
        }),

        /** int fseek(FILE *stream, long offset, int origin) -- zero on success. */
        fseek: cdecl(12, ([pointer, offset, origin])=>{
            const stream = argument(pointer);
            const descriptor = stream ? descriptorOf(stream) : null;
            if (!stream || !descriptor || descriptor.node === null)
            {
                return -1;
            }
            const base = origin === SEEK_SET ? 0
                : origin === SEEK_CUR ? tellOf(stream)
                    : origin === SEEK_END ? descriptors.size(descriptor) : -1;
            if (base < 0)
            {
                fail(EINVAL);
                return -1;
            }
            return reposition(stream, base + (offset | 0)) ? 0 : -1;
        }),

        /** long ftell(FILE *stream) -- -1 for a stream that is not one. */
        ftell: cdecl(4, ([pointer])=>{
            const stream = argument(pointer);
            return stream ? tellOf(stream) : -1;
        }),

        /**
         * int fgetpos(FILE *stream, fpos_t *pos)
         *
         * The position ftell answers, stored as the eight bytes of an fpos_t;
         * nonzero with EINVAL for a null argument.
         */
        fgetpos: cdecl(8, ([pointer, pos])=>{
            const stream = argument(pointer);
            if (stream && (pos >>> 0) === 0)
            {
                fail(EINVAL);
            }
            if (!stream || (pos >>> 0) === 0)
            {
                return -1;
            }
            const bytes = new Uint8Array(8);
            new DataView(bytes.buffer).setBigInt64(0, BigInt(tellOf(stream)), true);
            host.writeMemory(pos >>> 0, bytes);
            return 0;
        }),

        /**
         * int fsetpos(FILE *stream, const fpos_t *pos)
         *
         * fseek to what fgetpos stored: the end of the file clears and what
         * ungetc gave back is gone. Nonzero with EINVAL for a null argument or
         * a position before the start, EBADF for the console.
         */
        fsetpos: cdecl(8, ([pointer, pos])=>{
            const stream = argument(pointer);
            if (stream && (pos >>> 0) === 0)
            {
                fail(EINVAL);
            }
            if (!stream || (pos >>> 0) === 0)
            {
                return -1;
            }
            if (descriptorOf(stream)?.node === null)
            {
                fail(EBADF);
                return -1;
            }
            const stored = host.readMemory(pos >>> 0, 8);
            const position = new DataView(stored.buffer, stored.byteOffset, 8).getBigInt64(0, true);
            return reposition(stream, Number(position)) ? 0 : -1;
        }),

        /** void rewind(FILE *stream) -- the start, with both conditions cleared. */
        rewind: cdecl(4, ([pointer])=>{
            const stream = argument(pointer);
            const descriptor = stream ? descriptorOf(stream) : null;
            if (stream && descriptor && descriptor.node !== null)
            {
                descriptors.seek(descriptor, 0);
                stream.pushback.length = 0;
                setFlags(stream, stream.flags & ~(IOEOF | IOERR));
            }
            return 0;
        }),

        /**
         * int feof(FILE *stream) / int ferror(FILE *stream)
         *
         * The functions behind the macros, reading the same flags the macros
         * read from `_flag`.
         */
        feof: cdecl(4, ([pointer])=>(argument(pointer)?.flags ?? 0) & IOEOF),
        ferror: cdecl(4, ([pointer])=>(argument(pointer)?.flags ?? 0) & IOERR),

        /** void clearerr(FILE *stream) -- the descriptor's ^Z end of data too. */
        clearerr: cdecl(4, ([pointer])=>{
            const stream = argument(pointer);
            if (stream)
            {
                setFlags(stream, stream.flags & ~(IOEOF | IOERR));
                const descriptor = descriptorOf(stream);
                if (descriptor)
                {
                    descriptor.ended = false;
                }
            }
            return 0;
        }),

        /**
         * int fflush(FILE *stream)
         *
         * Every write has already reached the volume, so there is nothing to
         * flush and the answer is 0 -- for NULL, which means every stream,
         * too. What it still does is documented: what ungetc gave back is gone.
         */
        fflush: cdecl(4, ([pointer])=>{
            if ((pointer >>> 0) === 0)
            {
                return 0;
            }
            const stream = streamOf(pointer);
            if (!stream)
            {
                return EOF;
            }
            stream.pushback.length = 0;
            return 0;
        }),

        fgetc,
        getc: fgetc,

        /**
         * int _filbuf(FILE *stream)
         *
         * What the `getc` macro calls once it has counted `_cnt` below zero:
         * the next byte, or EOF, with `_cnt` back at zero so the next macro
         * comes here again.
         */
        _filbuf: cdecl(4, ([pointer])=>{
            const stream = streamOf(pointer);
            if (!stream)
            {
                return EOF;
            }
            writeU32(stream.record + FILE_CNT, 0);
            return nextByte(stream);
        }),

        /**
         * char *fgets(char *buffer, int count, FILE *stream)
         *
         * A line, its line feed kept, of at most `count - 1` bytes, and the
         * terminator; NULL when the stream was already at its end. Reaching
         * the end partway is not a failure but is the end of the file, which
         * `feof` then reports.
         */
        fgets: cdecl(12, ([buffer, count, pointer])=>{
            const stream = argument(pointer);
            if (stream && ((buffer >>> 0) === 0 || (count | 0) <= 0))
            {
                fail(EINVAL);
            }
            if (!stream || (buffer >>> 0) === 0 || (count | 0) <= 0 || narrowRefused(stream))
            {
                return 0;
            }
            if (!readable(stream))
            {
                raise(stream, IOERR);
                return 0;
            }
            const limit = (count | 0) - 1;
            return settle(take(stream, limit, true), bytes=>{
                if (bytes.length < limit && bytes[bytes.length - 1] !== LF)
                {
                    raise(stream, IOEOF);
                }
                if (bytes.length === 0 && limit > 0)
                {
                    return 0;
                }
                const line = new Uint8Array(bytes.length + 1);
                line.set(bytes);
                host.writeMemory(buffer >>> 0, line);
                return buffer >>> 0;
            });
        }),

        fputc,
        putc: fputc,

        /**
         * int getchar(void) / int putchar(int c)
         *
         * getc on stdin and putc on stdout: the same streams, and so the same
         * records, the program's own macros read.
         */
        getchar: cdecl(0, ()=>{
            const stream = standardStream(0);
            return stream ? nextByte(stream) : EOF;
        }),
        putchar: cdecl(4, ([c])=>{
            const stream = standardStream(1);
            return stream ? putByte(stream, c) : EOF;
        }),

        /**
         * int _flsbuf(int c, FILE *stream)
         *
         * What the `putc` macro calls once it has counted `_cnt` below zero:
         * the byte written, `_cnt` back at zero, and the byte as an unsigned
         * char -- or EOF for a stream not open for writing (Wine's msvcrt
         * test_flsbuf).
         */
        _flsbuf: cdecl(8, ([c, pointer])=>{
            const stream = streamOf(pointer);
            if (!stream)
            {
                return EOF;
            }
            writeU32(stream.record + FILE_CNT, 0);
            return putByte(stream, c);
        }),

        /** int fputs(const char *str, FILE *stream) -- 0, or EOF on an error. */
        fputs: cdecl(8, ([string, pointer])=>{
            const stream = argument(pointer);
            if (stream && (string >>> 0) === 0)
            {
                fail(EINVAL);
            }
            if (!stream || (string >>> 0) === 0 || narrowRefused(stream))
            {
                return EOF;
            }
            if (!writable(stream))
            {
                refuseWrite(stream);
                return EOF;
            }
            const bytes = bytesOf(readString(string));
            return emit(stream, bytes) === bytes.length ? 0 : EOF;
        }),

        /**
         * int ungetc(int c, FILE *stream)
         *
         * Gives a byte back to be read next, clearing the end of the file;
         * EOF itself cannot be given back and changes nothing.
         */
        ungetc: cdecl(8, ([c, pointer])=>{
            const stream = argument(pointer);
            if (!stream || (c | 0) === EOF || !readable(stream) || narrowRefused(stream))
            {
                return EOF;
            }
            stream.pushback.push(c & 0xff);
            setFlags(stream, stream.flags & ~IOEOF);
            return c & 0xff;
        }),

        fgetwc,
        getwc: fgetwc,
        fputwc,
        putwc: fputwc,

        /** wint_t getwchar(void) / wint_t putwchar(wchar_t c) -- on stdin and stdout. */
        getwchar: cdecl(0, ()=>{
            const stream = standardStream(0);
            return stream ? nextUnit(stream) : WEOF;
        }),
        putwchar: cdecl(4, ([c])=>{
            const stream = standardStream(1);
            return stream && putUnits(stream, [c & 0xffff]) === 1 ? c & 0xffff : WEOF;
        }),

        /**
         * wchar_t *fgetws(wchar_t *buffer, int count, FILE *stream)
         *
         * fgets in characters: a line, its LF kept, of at most `count - 1`,
         * and the terminator; NULL when the stream was already at its end.
         * In binary mode CR LF is two characters, in the other modes one LF
         * (Wine's msvcrt test_fgetwc).
         */
        fgetws: cdecl(12, ([buffer, count, pointer])=>{
            const stream = argument(pointer);
            if (stream && ((buffer >>> 0) === 0 || (count | 0) <= 0))
            {
                fail(EINVAL);
            }
            if (!stream || (buffer >>> 0) === 0 || (count | 0) <= 0)
            {
                return 0;
            }
            if (!readable(stream))
            {
                raise(stream, IOERR);
                return 0;
            }
            const limit = (count | 0) - 1;
            const width = widthOf(stream);
            return settle(take(stream, limit * width, true, width), bytes=>{
                const units = width === 2 ? unitsOf(bytes) : [...bytes];
                if (units.length < limit && units[units.length - 1] !== LF)
                {
                    raise(stream, IOEOF);
                }
                if (units.length === 0 && limit > 0)
                {
                    return 0;
                }
                host.writeMemory(buffer >>> 0, bytesOfUnits([...units, 0]));
                return buffer >>> 0;
            });
        }),

        /** int fputws(const wchar_t *str, FILE *stream) -- 0, or EOF on an error. */
        fputws: cdecl(8, ([string, pointer])=>{
            const stream = argument(pointer);
            if (stream && (string >>> 0) === 0)
            {
                fail(EINVAL);
            }
            if (!stream || (string >>> 0) === 0)
            {
                return EOF;
            }
            return putUnits(stream, unitsOfText(readWide(string))) < 0 ? EOF : 0;
        }),

        /**
         * wint_t ungetwc(wint_t c, FILE *stream)
         *
         * ungetc for a character, given back as the bytes the stream reads it
         * from; WEOF, and one text mode has no byte for, change nothing.
         */
        ungetwc: cdecl(8, ([c, pointer])=>{
            const stream = argument(pointer);
            const unit = c & 0xffff;
            if (!stream || unit === WEOF || !readable(stream))
            {
                return WEOF;
            }
            const width = widthOf(stream);
            if (width === 1 && unit > 0xff)
            {
                return WEOF;
            }
            stream.pushback.push(...(width === 2 ? [unit >>> 8, unit & 0xff] : [unit]));
            setFlags(stream, stream.flags & ~IOEOF);
            return unit;
        }),

        /** int _putws(const wchar_t *str) -- the string and an LF on stdout: 0, or WEOF. */
        _putws: cdecl(4, ([string])=>{
            const stream = standardStream(1);
            if ((string >>> 0) === 0)
            {
                fail(EINVAL);
                return WEOF;
            }
            return stream && putUnits(stream, [...unitsOfText(readWide(string)), LF]) >= 0
                ? 0 : WEOF;
        }),

        /**
         * int fwprintf(FILE *stream, const wchar_t *format, ...)
         *
         * The count of wide characters written, or -1. In this family %s is a
         * wide string and %S a narrow one.
         */
        fwprintf: cdecl(8 + VARIADIC_SLOTS * 4, args=>{
            const stream = argument(args[0]);
            return stream ? printWide(stream, args[1], args.slice(2)) : -1;
        }),

        /** int wprintf(const wchar_t *format, ...) -- fwprintf on stdout. */
        wprintf: cdecl(4 + VARIADIC_SLOTS * 4, args=>{
            const stream = standardStream(1);
            return stream ? printWide(stream, args[0], args.slice(1)) : -1;
        }),

        /** int _fileno(FILE *stream) -- the descriptor, as the macro reads `_file`. */
        _fileno: cdecl(4, ([pointer])=>argument(pointer)?.fd ?? -1),

        /**
         * int fprintf(FILE *stream, const char *format, ...)
         *
         * The count of characters formatted; a negative one on a stream not
         * open for writing, or when not all of them were stored.
         */
        fprintf: cdecl(8 + VARIADIC_SLOTS * 4, args=>{
            const stream = argument(args[0]);
            return stream ? printTo(stream, args[1], args.slice(2)) : EOF;
        }),

        /**
         * int printf(const char *format, ...)
         *
         * fprintf on stdout, so a program that moved stdout with freopen
         * finds the text where it moved it. The variadic arguments sit above
         * the format on the caller's stack and arrive as the tail of `args`.
         */
        printf: cdecl(4 + VARIADIC_SLOTS * 4, args=>{
            const stream = standardStream(1);
            return stream ? printTo(stream, args[0], args.slice(1)) : EOF;
        }),

        /** int puts(const char *str) -- the string and a newline on stdout: 0, or EOF. */
        puts: cdecl(4, ([string])=>{
            const stream = standardStream(1);
            if (!stream || narrowRefused(stream) || !writable(stream))
            {
                if (stream && !writable(stream))
                {
                    refuseWrite(stream);
                }
                return EOF;
            }
            const line = bytesOf(`${readString(string)}\n`);
            return emit(stream, line) === line.length ? 0 : EOF;
        }),

        // A `va_list` carries no count, so it is read through whoever knows
        // how far the caller's stack reaches; without that, the four below
        // stay unexported.
        ...(host.varargs
            ? {
                /** int vprintf(const char *format, va_list args) -- printf from a list. */
                vprintf: cdecl(8, ([format, list])=>{
                    const stream = standardStream(1);
                    const values = /** @type {(list: number) => number[]} */ (host.varargs);
                    return stream ? printTo(stream, format, values(list)) : EOF;
                }),

                /** int vfprintf(FILE *stream, const char *format, va_list args) */
                vfprintf: cdecl(12, ([pointer, format, list])=>{
                    const stream = argument(pointer);
                    const values = /** @type {(list: number) => number[]} */ (host.varargs);
                    return stream ? printTo(stream, format, values(list)) : EOF;
                }),

                /** int vfwprintf(FILE *stream, const wchar_t *format, va_list args) */
                vfwprintf: cdecl(12, ([pointer, format, list])=>{
                    const stream = argument(pointer);
                    const values = /** @type {(list: number) => number[]} */ (host.varargs);
                    return stream ? printWide(stream, format, values(list)) : -1;
                }),

                /** int vwprintf(const wchar_t *format, va_list args) */
                vwprintf: cdecl(8, ([format, list])=>{
                    const stream = standardStream(1);
                    const values = /** @type {(list: number) => number[]} */ (host.varargs);
                    return stream ? printWide(stream, format, values(list)) : -1;
                }),
            }
            : {}),

        /**
         * int setvbuf(FILE *stream, char *buffer, int mode, size_t size)
         *
         * Every stream here writes straight through to the volume, so a
         * valid request is accepted and does nothing -- which is the
         * buffering this call already promised.
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
