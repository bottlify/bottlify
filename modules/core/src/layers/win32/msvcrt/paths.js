/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Paths and the directory operations that go with them.
 *
 * The splitting half is pure text and has no filesystem behind it at all:
 * `_splitpath` never asks whether anything exists, which is why it is safe to
 * call on a name that is about to be created. Its rules are entirely
 * positional -- the drive is what precedes a colon, the directory is everything
 * through the last separator, the extension is the last dot in what remains --
 * and every one of its four outputs may be null, meaning the caller did not
 * want that piece.
 *
 * The operating half returns zero for success and -1 for failure, the C
 * convention and the opposite of the Win32 one sitting beside it in this
 * runtime. Getting that backwards makes every operation appear to fail. A
 * failure says why in errno, with the codes each function documents.
 */

import { EACCES, EBADF, EEXIST, EINVAL, ENOENT, ENOTEMPTY, ERANGE } from './globals.js';
import { encodeAnsi } from '../kernel32/locale.js';

const MAX_STRING = 1 << 20;

/** `struct _finddata_t` as msvcrt.dll lays it out: 32-bit times, 260 bytes of name. */
const FINDDATA = Object.freeze({
    ATTRIB: 0, TIME_CREATE: 4, TIME_ACCESS: 8, TIME_WRITE: 12, SIZE: 16, WIDE_SIZE: false,
    NAME: 20, WIDE_NAME: false, BYTES: 280,
});

/**
 * `struct _finddatai64_t`: the same with a 64-bit size, which moves the name
 * to 24, and the whole rounded up to the size's 8-byte alignment.
 */
const FINDDATAI64 = Object.freeze({
    ATTRIB: 0, TIME_CREATE: 4, TIME_ACCESS: 8, TIME_WRITE: 12, SIZE: 16, WIDE_SIZE: true,
    NAME: 24, WIDE_NAME: false, BYTES: 288,
});

/** `struct _wfinddata_t`: `_finddata_t` with 260 wide characters of name. */
const WFINDDATA = Object.freeze({
    ATTRIB: 0, TIME_CREATE: 4, TIME_ACCESS: 8, TIME_WRITE: 12, SIZE: 16, WIDE_SIZE: false,
    NAME: 20, WIDE_NAME: true, BYTES: 540,
});

/** `struct _wfinddatai64_t`: `_finddatai64_t` with 260 wide characters of name. */
const WFINDDATAI64 = Object.freeze({
    ATTRIB: 0, TIME_CREATE: 4, TIME_ACCESS: 8, TIME_WRITE: 12, SIZE: 16, WIDE_SIZE: true,
    NAME: 24, WIDE_NAME: true, BYTES: 544,
});

/**
 * @typedef {typeof FINDDATA | typeof FINDDATAI64 | typeof WFINDDATA
 *           | typeof WFINDDATAI64} FindLayout
 */
const MAX_NAME = 259;

/** The attributes FindFirstFile reports, which `_findfirst` passes on. */
const A_SUBDIR = 0x10;
const A_ARCH = 0x20;

/** The fixed part of a tmpnam name, as the runtime spells it from its process. */
const TMPNAM_STEM = '1c';
const TMPNAM_BUFFER = 260;

/**
 * Splits a path into drive, directory, filename and extension.
 *
 * Under a double-byte code page a byte that trails a lead byte is part of its
 * character, whatever byte it is: the second byte of a Shift-JIS character
 * may be a backslash's, and is no separator.
 *
 * @param {string} path  Read in the ANSI page, a character a byte -- or, `wide`,
 *     in UTF-16, where every unit is a character and none is a lead byte.
 * @param {(byte: number) => boolean} [isLead]  The multibyte page's lead bytes.
 * @param {boolean} [wide]
 * @returns {{ drive: string, directory: string, name: string, extension: string }}
 */
export function splitPath(path, isLead = ()=>false, wide = false){
    let rest = path;
    let drive = '';
    if (/^[A-Za-z]:/.test(rest))
    {
        drive = rest.slice(0, 2);
        rest = rest.slice(2);
    }

    // Both separators count: a path assembled from a configuration file and a
    // constant usually contains one of each.
    const bytes = wide ? Array.from(rest, unit=>unit.charCodeAt(0)) : encodeAnsi(rest);
    let lastSeparator = -1;
    for (let at = 0; at < bytes.length; at++)
    {
        if (!wide && isLead(bytes[at]) && at + 1 < bytes.length)
        {
            at++;
        }
        else if (bytes[at] === 0x5c || bytes[at] === 0x2f)
        {
            lastSeparator = at;
        }
    }
    const directory = lastSeparator === -1 ? '' : rest.slice(0, lastSeparator + 1);
    const file = rest.slice(lastSeparator + 1);

    const dot = file.lastIndexOf('.');
    // A leading dot is part of the name, not an empty extension.
    return dot <= 0
        ? { drive, directory, name: file, extension: '' }
        : { drive, directory, name: file.slice(0, dot), extension: file.slice(dot) };
}

/**
 * Resolves a path against a working directory, flattening `.` and `..`.
 *
 * @param {string} path
 * @param {string} current
 */
export function fullPath(path, current){
    const rooted = /^[A-Za-z]:[\\/]/.test(path)
        ? path
        : (/^[\\/]/.test(path)
            ? `${current.slice(0, 2)}${path}`
            : `${current.replace(/[\\/]+$/, '')}\\${path}`);

    const drive = rooted.slice(0, 2);
    /** @type {string[]} */
    const parts = [];
    for (const part of rooted.slice(2).split(/[\\/]+/))
    {
        if (part === '' || part === '.')
        {
            continue;
        }
        if (part === '..')
        {
            // Above the root is the root: this is what the filesystem does,
            // and letting it go higher would produce a path with no drive.
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    return `${drive}\\${parts.join('\\')}`;
}

/**
 * @typedef {Object} PathHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate
 * @property {() => string[]} [drives]  Letters the filesystem has mounted.
 * @property {any} files  The volume: stat, list, remove, rename, mkdir and the
 *           current directory.
 * @property {(code: number) => void} [errno]  Where a failure says why.
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 *           For a wide pattern. Absent, the wide finds stay unexported.
 * @property {(name: string) => string | null} [getenv]
 *           The runtime's own environment, where `_tempnam` finds TMP and
 *           `_searchenv` the list of directories it is named.
 * @property {(byte: number) => boolean} [isLead]
 *           The multibyte code page's lead bytes, which `_splitpath` reads by.
 */

/**
 * @param {PathHost} host
 */
export function createPathFunctions(host){
    /** @param {number} pointer */
    const readString = pointer=>host.readCString(pointer, MAX_STRING);

    /** In the ANSI page a path is read in. @param {number} pointer @param {string} text */
    const writeString = (pointer, text)=>{
        if ((pointer >>> 0) === 0)
        {
            return;
        }
        host.writeMemory(pointer, encodeAnsi(`${text}\0`));
    };

    /** @param {number} code */
    const fail = code=>{
        host.errno?.(code);
    };

    /** @param {string} path */
    const exists = path=>host.files.stat(path)?.exists === true;

    /**
     * @param {number} argBytes
     * @param {(args: number[]) => number} act  Zero, or the errno it failed with.
     * @param {number} [paths]  How many of the first arguments are paths, which
     *     msvcrt refuses when null with -1 and EINVAL rather than reading.
     */
    const operation = (argBytes, act, paths = 1)=>({
        convention: 'cdecl',
        argBytes,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ args)=>{
            const code = args.slice(0, paths).some(path=>(path >>> 0) === 0) ? EINVAL : act(args);
            if (code === 0)
            {
                return 0;
            }
            fail(code);
            return -1;
        },
    });

    /** @param {number} pointer @param {string} text */
    const writeWide = (pointer, text)=>{
        if ((pointer >>> 0) === 0)
        {
            return;
        }
        const bytes = new Uint8Array((text.length + 1) * 2);
        const view = new DataView(bytes.buffer);
        for (let at = 0; at < text.length; at++)
        {
            view.setUint16(at * 2, text.charCodeAt(at), true);
        }
        host.writeMemory(pointer, bytes);
    };

    /**
     * A directory and a name in it, one separator between.
     *
     * @param {string} directory @param {string} name
     */
    const within = (directory, name)=>(/[\\/]$/.test(directory) ? `${directory}${name}`
        : `${directory}\\${name}`);

    /**
     * _makepath's joining: the drive's first character and a colon, the
     * directory with a separator after it, the name, and the extension after
     * a dot -- each only where it is given.
     *
     * @param {string} drive @param {string} directory @param {string} name
     * @param {string} extension
     */
    const makePath = (drive, directory, name, extension)=>{
        const folder = directory === '' ? '' : within(directory, '');
        const suffix = extension === '' || extension.startsWith('.') ? extension
            : `.${extension}`;
        return (drive === '' ? '' : `${drive[0]}:`) + folder + name + suffix;
    };

    /**
     * _searchenv's search: the current directory, then each directory of the
     * variable's list in turn -- separated by semicolons outside quotes, the
     * quotes themselves dropped, an empty one skipped.
     *
     * @param {string} file @param {string} variable
     * @returns {string | null}
     */
    const searchEnvironment = (file, variable)=>{
        const here = within(host.files.currentDirectory(), file);
        if (exists(here))
        {
            return here;
        }
        /** @type {string[]} */
        const directories = [''];
        let quoted = false;
        for (const character of host.getenv?.(variable) ?? '')
        {
            if (character === '"')
            {
                quoted = !quoted;
            }
            else if (character === ';' && !quoted)
            {
                directories.push('');
            }
            else
            {
                directories[directories.length - 1] += character;
            }
        }
        return directories.filter(entry=>entry !== '').map(entry=>within(entry, file))
            .find(exists) ?? null;
    };

    /**
     * The secure forms' writing of a path: EINVAL for no buffer or no room at
     * all; of a path that does not fit with its terminator, as many characters
     * as leave room for one are written, as msvcrt writes them before it finds
     * it is short, and the first then cleared -- ERANGE.
     *
     * @param {number} pointer @param {number} size  In characters.
     * @param {string | null} text  Null to refuse the arguments.
     * @param {boolean} wide
     */
    const writeSecure = (pointer, size, text, wide)=>{
        if ((pointer >>> 0) === 0 || (size >>> 0) === 0 || text === null)
        {
            fail(EINVAL);
            return EINVAL;
        }
        const units = wide ? Array.from(text, character=>character.charCodeAt(0))
            : Array.from(encodeAnsi(text));
        const fits = units.length < (size >>> 0);
        const written = fits ? [...units, 0] : [0, ...units.slice(1, (size >>> 0) - 1)];
        const bytes = new Uint8Array(written.length * (wide ? 2 : 1));
        const view = new DataView(bytes.buffer);
        written.forEach((unit, at)=>{
            if (wide)
            {
                view.setUint16(at * 2, unit, true);
            }
            else
            {
                bytes[at] = unit;
            }
        });
        host.writeMemory(pointer, bytes);
        if (fits)
        {
            return 0;
        }
        fail(ERANGE);
        return ERANGE;
    };

    /**
     * _searchenv_s and _wsearchenv_s: ENOENT, the result empty, for a file
     * none of the directories has; ERANGE for a path that does not fit.
     *
     * @param {(pointer: number) => string} read
     * @param {(pointer: number, text: string) => void} write
     * @param {number} unit  Bytes a character.
     */
    const searchSecure = (read, write, unit)=>({
        convention: /** @type {'cdecl'} */ ('cdecl'),
        argBytes: 16,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [file, variable, result, size])=>{
            if ((file >>> 0) === 0 || (result >>> 0) === 0 || (size >>> 0) === 0)
            {
                fail(EINVAL);
                return EINVAL;
            }
            const found = searchEnvironment(read(file),
                (variable >>> 0) === 0 ? '' : read(variable));
            const length = found === null ? 0
                : unit === 1 ? encodeAnsi(found).length : found.length;
            if (found === null || length + 1 > (size >>> 0))
            {
                write(result, '');
                const code = found === null ? ENOENT : ERANGE;
                fail(code);
                return code;
            }
            write(result, found);
            return 0;
        },
    });

    /** Where a name comes from next: each one given differs from the last. */
    let nextTemporary = 1;

    /** How many names tmpnam has handed out, and its own buffer once made. */
    let tmpnamCount = 0;
    let tmpnamBuffer = 0;

    /**
     * _tempnam's name: the first directory of TMP's, `dir` and the current
     * one that is a directory, and in it the prefix and a number no file has.
     *
     * @param {string | null} dir @param {string} prefix
     */
    const temporaryName = (dir, prefix)=>{
        /** @param {string | null | undefined} path */
        const isDirectory = path=>!!path && host.files.stat(path)?.isDirectory === true;
        const tmp = host.getenv?.('TMP');
        const directory = [tmp, dir].find(isDirectory) ?? host.files.currentDirectory();
        const joined = /[\\/]$/.test(directory) ? directory : `${directory}\\`;
        for (;; nextTemporary++)
        {
            const name = `${joined}${prefix}${nextTemporary.toString(32)}`;
            if (!exists(name))
            {
                nextTemporary++;
                return name;
            }
        }
    };

    /**
     * The searches `_findfirst` opened, by the handle it answered with: what
     * matched, and how far `_findnext` has walked.
     *
     * @type {Map<number, { entries: any[], next: number }>}
     */
    const searches = new Map();
    let nextSearch = 1;

    /**
     * A wide string, read a character at a time up to its terminator.
     *
     * @param {number} pointer
     */
    const readWide = pointer=>{
        let text = '';
        for (let at = pointer >>> 0; text.length < MAX_STRING; at += 2)
        {
            const unit = host.readMemory?.(at, 2) ?? new Uint8Array(2);
            const code = unit[0] | unit[1] << 8;
            if (code === 0)
            {
                break;
            }
            text += String.fromCharCode(code);
        }
        return text;
    };

    /**
     * Fills a whole `_finddata_t`, `_finddatai64_t` or `_wfinddatai64_t`.
     * The volume keeps one time per file, the last write, and it stands for
     * all three.
     *
     * @param {number} address @param {any} entry @param {FindLayout} layout
     */
    const writeFound = (address, entry, layout)=>{
        const bytes = new Uint8Array(layout.BYTES);
        const view = new DataView(bytes.buffer);
        view.setUint32(layout.ATTRIB, entry.isDirectory ? A_SUBDIR : A_ARCH, true);
        const time = Math.floor((entry.modified ?? 0) / 1000) >>> 0;
        view.setUint32(layout.TIME_CREATE, time, true);
        view.setUint32(layout.TIME_ACCESS, time, true);
        view.setUint32(layout.TIME_WRITE, time, true);
        if (layout.WIDE_SIZE)
        {
            view.setBigUint64(layout.SIZE, BigInt(entry.size ?? 0), true);
        }
        else
        {
            view.setUint32(layout.SIZE, (entry.size ?? 0) >>> 0, true);
        }
        const name = String(entry.name).slice(0, MAX_NAME);
        if (layout.WIDE_NAME)
        {
            for (let at = 0; at < name.length; at++)
            {
                view.setUint16(layout.NAME + at * 2, name.charCodeAt(at), true);
            }
        }
        else
        {
            bytes.set(encodeAnsi(name), layout.NAME);
        }
        host.writeMemory(address >>> 0, bytes);
    };

    /**
     * `_findfirst` for one layout of the record: a handle for `_findnext`
     * with the first match written out, or -1 with ENOENT when nothing
     * matches or the directory is not there -- the same answers
     * FindFirstFile gives, over the same listing. A wide record's pattern is
     * wide too.
     *
     * @param {FindLayout} layout
     */
    const findFirst = layout=>({
        convention: 'cdecl',
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([spec, data])=>{
            if ((spec >>> 0) === 0 || (data >>> 0) === 0)
            {
                fail(EINVAL);
                return -1;
            }
            const { directory, pattern } = splitSearch(
                layout.WIDE_NAME ? readWide(spec) : readString(spec));
            const holder = host.files.stat(directory);
            const entries = pattern !== '' && holder?.isDirectory
                ? host.files.list(directory, pattern) ?? []
                : [];
            if (entries.length === 0)
            {
                fail(ENOENT);
                return -1;
            }
            writeFound(data, entries[0], layout);
            const handle = nextSearch++;
            searches.set(handle, { entries, next: 1 });
            return handle;
        },
    });

    /**
     * `_findnext` for one layout -- ENOENT at the end. The searches are one
     * table, whichever record a program asked for them in.
     *
     * @param {FindLayout} layout
     */
    const findNext = layout=>({
        convention: 'cdecl',
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([handle, data])=>{
            const search = searches.get(handle | 0);
            if (!search || search.next >= search.entries.length)
            {
                fail(ENOENT);
                return -1;
            }
            writeFound(data, search.entries[search.next++], layout);
            return 0;
        },
    });

    /**
     * A search specification as the directory to look in and the pattern its
     * last component is. A root keeps its separator, so "C:\*.*" looks in
     * "C:\" and not in wherever "C:" alone would mean.
     *
     * @param {string} spec
     */
    const splitSearch = spec=>{
        const cut = Math.max(spec.lastIndexOf('\\'), spec.lastIndexOf('/'));
        if (cut < 0)
        {
            const drive = /^[A-Za-z]:/.test(spec) ? spec.slice(0, 2) : '.';
            return { directory: drive, pattern: drive === '.' ? spec : spec.slice(2) };
        }
        const parent = spec.slice(0, cut);
        const rooted = parent === '' || parent.endsWith(':');
        return {
            directory: rooted ? spec.slice(0, cut + 1) : parent,
            pattern: spec.slice(cut + 1),
        };
    };

    /**
     * Why a removal the volume refused failed: the name is not there, or it
     * is and is not the volume's to remove.
     *
     * @param {string} path @param {number} refused
     */
    const removal = (path, refused)=>
        (host.files.remove(path) === true ? 0 : (exists(path) ? refused : ENOENT));

    return {
        /**
         * void _splitpath(const char *path, char *drive, char *dir,
         *                 char *fname, char *ext)
         */
        _splitpath: {
            convention: 'cdecl',
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([path, drive, directory, name, extension])=>{
                const parts = splitPath(readString(path), host.isLead);
                writeString(drive, parts.drive);
                writeString(directory, parts.directory);
                writeString(name, parts.name);
                writeString(extension, parts.extension);
                return 0;
            },
        },

        /**
         * void _makepath(char *path, const char *drive, const char *dir,
         *                const char *fname, const char *ext)
         */
        _makepath: {
            convention: 'cdecl',
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([path, drive, directory, name, extension])=>{
                const read = (/** @type {number} */ pointer)=>(
                    (pointer >>> 0) === 0 ? '' : readString(pointer));
                writeString(path, makePath(read(drive), read(directory), read(name),
                    read(extension)));
                return 0;
            },
        },

        /**
         * errno_t _makepath_s(char *path, size_t size, const char *drive,
         *                     const char *dir, const char *fname, const char *ext)
         */
        _makepath_s: {
            convention: 'cdecl',
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([path, size, drive, directory, name, extension])=>{
                const read = (/** @type {number} */ pointer)=>(
                    (pointer >>> 0) === 0 ? '' : readString(pointer));
                const text = (path >>> 0) === 0 || (size >>> 0) === 0 ? null
                    : makePath(read(drive), read(directory), read(name), read(extension));
                return writeSecure(path, size, text, false);
            },
        },

        ...host.readMemory ? {
            /**
             * void _wmakepath(wchar_t *path, const wchar_t *drive, const wchar_t *dir,
             *                 const wchar_t *fname, const wchar_t *ext)
             */
            _wmakepath: {
                convention: 'cdecl',
                argBytes: 20,
                /** @param {number[]} args */
                handler: ([path, drive, directory, name, extension])=>{
                    const read = (/** @type {number} */ pointer)=>(
                        (pointer >>> 0) === 0 ? '' : readWide(pointer));
                    writeWide(path, makePath(read(drive), read(directory), read(name),
                        read(extension)));
                    return 0;
                },
            },

            /**
             * void _wsplitpath(const wchar_t *path, wchar_t *drive, wchar_t *dir,
             *                  wchar_t *fname, wchar_t *ext)
             *
             * _splitpath's parts in UTF-16; a null part is not written.
             */
            _wsplitpath: {
                convention: 'cdecl',
                argBytes: 20,
                /** @param {number[]} args */
                handler: ([path, drive, directory, name, extension])=>{
                    const parts = splitPath(readWide(path), undefined, true);
                    writeWide(drive, parts.drive);
                    writeWide(directory, parts.directory);
                    writeWide(name, parts.name);
                    writeWide(extension, parts.extension);
                    return 0;
                },
            },

            /**
             * wchar_t *_wfullpath(wchar_t *absolute, const wchar_t *relative, size_t max)
             *
             * _fullpath in UTF-16, `max` counted in characters; a null
             * destination is one allocated for the caller to free.
             */
            _wfullpath: {
                convention: 'cdecl',
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([destination, relative, max])=>{
                    const text = fullPath(readWide(relative), host.files.currentDirectory());
                    if ((destination >>> 0) === 0)
                    {
                        const allocated = host.allocate((text.length + 1) * 2);
                        writeWide(allocated, text);
                        return allocated;
                    }
                    if (text.length + 1 > (max >>> 0))
                    {
                        return 0;
                    }
                    writeWide(destination, text);
                    return destination;
                },
            },

            /** void _wsearchenv(const wchar_t *file, const wchar_t *variable, wchar_t *result) */
            _wsearchenv: {
                convention: 'cdecl',
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([file, variable, result])=>{
                    writeWide(result, searchEnvironment(readWide(file), readWide(variable)) ?? '');
                    return 0;
                },
            },

            /**
             * errno_t _wmakepath_s(wchar_t *path, size_t size, const wchar_t *drive,
             *                      const wchar_t *dir, const wchar_t *fname,
             *                      const wchar_t *ext)
             */
            _wmakepath_s: {
                convention: 'cdecl',
                argBytes: 24,
                /** @param {number[]} args */
                handler: ([path, size, drive, directory, name, extension])=>{
                    const read = (/** @type {number} */ pointer)=>(
                        (pointer >>> 0) === 0 ? '' : readWide(pointer));
                    const text = (path >>> 0) === 0 || (size >>> 0) === 0 ? null
                        : makePath(read(drive), read(directory), read(name), read(extension));
                    return writeSecure(path, size, text, true);
                },
            },

            /**
             * errno_t _wsearchenv_s(const wchar_t *file, const wchar_t *variable,
             *                       wchar_t *result, size_t size)
             */
            _wsearchenv_s: searchSecure(readWide, writeWide, 2),
        } : {},

        /**
         * void _searchenv(const char *file, const char *variable, char *result)
         *
         * The file in the current directory, or else in the first of the
         * directories the variable lists that has it: the directory as the
         * list spells it and the name, or an empty string for none.
         */
        _searchenv: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([file, variable, result])=>{
                writeString(result, searchEnvironment(readString(file), readString(variable))
                    ?? '');
                return 0;
            },
        },

        /**
         * errno_t _searchenv_s(const char *file, const char *variable, char *result,
         *                      size_t size)
         */
        _searchenv_s: searchSecure(readString, writeString, 1),

        /**
         * char *_fullpath(char *absolute, const char *relative, size_t max)
         *
         * A null destination means "allocate one", and the caller frees it.
         */
        _fullpath: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, relative, max])=>{
                const text = fullPath(readString(relative), host.files.currentDirectory());
                if ((destination >>> 0) === 0)
                {
                    const allocated = host.allocate(text.length + 1);
                    writeString(allocated, text);
                    return allocated;
                }
                if (text.length + 1 > (max >>> 0))
                {
                    return 0;
                }
                writeString(destination, text);
                return destination;
            },
        },

        /**
         * char *_getcwd(char *buffer, int size)
         *
         * With no buffer the one allocated is at least `size` bytes, larger
         * only if the path needs it: a caller asks for room to append a file
         * name to the directory and does so in place.
         */
        _getcwd: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, size])=>{
                const text = host.files.currentDirectory();
                if ((buffer >>> 0) === 0)
                {
                    const allocated = host.allocate(Math.max(text.length + 1, size | 0));
                    writeString(allocated, text);
                    return allocated;
                }
                if (text.length + 1 > (size | 0))
                {
                    fail(ERANGE);
                    return 0;
                }
                writeString(buffer, text);
                return buffer;
            },
        },

        /**
         * char *_tempnam(const char *dir, const char *prefix)
         *
         * A name no file has: in the directory TMP names, if it is one, else
         * in `dir` if that is one, else in the current directory -- the
         * prefix and a number, on the heap for the caller to free.
         */
        _tempnam: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([dir, prefix])=>{
                const text = temporaryName((dir >>> 0) === 0 ? null : readString(dir),
                    (prefix >>> 0) === 0 ? '' : readString(prefix));
                const address = host.allocate(encodeAnsi(text).length + 1);
                writeString(address, text);
                return address;
            },
        },

        /**
         * char *tmpnam(char *str)
         *
         * A name in the root of the current drive no file has: a backslash,
         * 's', the stem, a dot and a count -- nothing after the dot the first
         * time. Into the caller's buffer, or one of the runtime's own that
         * the next call writes over.
         */
        tmpnam: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                const next = ()=>`\\s${TMPNAM_STEM}.${tmpnamCount === 0 ? ''
                    : tmpnamCount.toString(32)}`;
                let name = next();
                while (exists(name))
                {
                    tmpnamCount++;
                    name = next();
                }
                tmpnamCount++;
                let at = buffer >>> 0;
                if (at === 0)
                {
                    tmpnamBuffer ||= host.allocate(TMPNAM_BUFFER);
                    at = tmpnamBuffer;
                }
                if (at !== 0)
                {
                    writeString(at, name);
                }
                return at;
            },
        },

        ...host.readMemory ? {
            /** wchar_t *_wtempnam(const wchar_t *dir, const wchar_t *prefix) */
            _wtempnam: {
                convention: 'cdecl',
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([dir, prefix])=>{
                    const text = temporaryName((dir >>> 0) === 0 ? null : readWide(dir),
                        (prefix >>> 0) === 0 ? '' : readWide(prefix));
                    const bytes = new Uint8Array((text.length + 1) * 2);
                    [...text].forEach((c, at)=>new DataView(bytes.buffer)
                        .setUint16(at * 2, c.charCodeAt(0), true));
                    const address = host.allocate(bytes.length);
                    if (address !== 0)
                    {
                        host.writeMemory(address, bytes);
                    }
                    return address;
                },
            },
        } : {},

        /** int _chdir(const char *path) */
        _chdir: operation(4, ([path])=>{
            const text = readString(path);
            if (!exists(text))
            {
                return ENOENT;
            }
            host.files.setCurrentDirectory(text);
            return 0;
        }),

        /** int _mkdir(const char *path) -- EEXIST for any name already taken. */
        _mkdir: operation(4, ([path])=>{
            const text = readString(path);
            if (host.files.mkdir(text) === true)
            {
                return 0;
            }
            return exists(text) ? EEXIST : ENOENT;
        }),

        /**
         * int _rmdir(const char *path)
         *
         * ENOTEMPTY covers every refusal of a name that is there: not a
         * directory, not empty, or the one the process stands in.
         */
        _rmdir: operation(4, ([path])=>removal(readString(path), ENOTEMPTY)),

        /** int _unlink(const char *path) -- EACCES for a directory or a read-only file. */
        _unlink: operation(4, ([path])=>removal(readString(path), EACCES)),

        /** int remove(const char *path) */
        remove: operation(4, ([path])=>removal(readString(path), EACCES)),

        /**
         * int rename(const char *from, const char *to)
         *
         * ENOENT when the old name is not there; any other refusal is EACCES,
         * which is what the new name already existing is.
         */
        rename: operation(8, ([from, to])=>{
            const source = readString(from);
            if (host.files.rename(source, readString(to)) === true)
            {
                return 0;
            }
            return exists(source) ? EACCES : ENOENT;
        }, 2),

        /**
         * int _access(const char *path, int mode)
         *
         * The mode asks about read (4), write (2) and existence (0). Nothing in
         * this runtime marks a file unreadable, so what it really answers is
         * whether the path exists -- and a write check against a read-only file
         * would need a permission bit the filesystem does not carry.
         */
        _access: operation(8, ([path])=>(exists(readString(path)) ? 0 : ENOENT)),

        /**
         * unsigned long _getdrives(void)
         *
         * A bit per letter, A first, and the same set GetLogicalDrives reports.
         * A program populates a drive list from whichever of the two it happens
         * to call, so the two disagreeing means a drive that exists through one
         * name and not through the other.
         */
        _getdrives: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>(host.drives?.() ?? ['C'])
                .reduce((mask, letter)=>
                    mask | 1 << (letter[0].toUpperCase().charCodeAt(0) - 0x41), 0) >>> 0,
        },

        /** intptr_t _findfirst(const char *filespec, struct _finddata_t *fileinfo) */
        _findfirst: findFirst(FINDDATA),

        /** int _findnext(intptr_t handle, struct _finddata_t *fileinfo) */
        _findnext: findNext(FINDDATA),

        /**
         * intptr_t _findfirsti64(const char *filespec, struct _finddatai64_t *fileinfo)
         *
         * `_findfirst` with sizes that go past 4 GiB.
         */
        _findfirsti64: findFirst(FINDDATAI64),

        /** int _findnexti64(intptr_t handle, struct _finddatai64_t *fileinfo) */
        _findnexti64: findNext(FINDDATAI64),

        // A wide pattern is read from memory as it lies, which needs the
        // bytes themselves rather than the narrow string reader.
        ...(host.readMemory
            ? {
                /** intptr_t _wfindfirst(const wchar_t *filespec, struct _wfinddata_t *fileinfo) */
                _wfindfirst: findFirst(WFINDDATA),

                /** int _wfindnext(intptr_t handle, struct _wfinddata_t *fileinfo) */
                _wfindnext: findNext(WFINDDATA),

                /**
                 * intptr_t _wfindfirsti64(const wchar_t *filespec,
                 *                         struct _wfinddatai64_t *fileinfo)
                 */
                _wfindfirsti64: findFirst(WFINDDATAI64),

                /** int _wfindnexti64(intptr_t handle, struct _wfinddatai64_t *fileinfo) */
                _wfindnexti64: findNext(WFINDDATAI64),
            }
            : {}),

        /** int _findclose(intptr_t handle) -- EBADF for a handle not open. */
        _findclose: operation(4, ([handle])=>(searches.delete(handle | 0) ? 0 : EBADF), 0),
    };
}
