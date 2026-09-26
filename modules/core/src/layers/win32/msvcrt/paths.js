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

import { EACCES, EEXIST, ENOENT, ENOTEMPTY, ERANGE } from './globals.js';

const MAX_STRING = 1 << 20;

/**
 * Splits a path into drive, directory, filename and extension.
 *
 * @param {string} path
 * @returns {{ drive: string, directory: string, name: string, extension: string }}
 */
export function splitPath(path){
    let rest = path;
    let drive = '';
    if (/^[A-Za-z]:/.test(rest))
    {
        drive = rest.slice(0, 2);
        rest = rest.slice(2);
    }

    // Both separators count: a path assembled from a configuration file and a
    // constant usually contains one of each.
    const lastSeparator = Math.max(rest.lastIndexOf('\\'), rest.lastIndexOf('/'));
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
 * @property {any} files  The volume: stat, remove, rename, mkdir and the
 *           current directory.
 * @property {(code: number) => void} [errno]  Where a failure says why.
 */

/**
 * @param {PathHost} host
 */
export function createPathFunctions(host){
    /** @param {number} pointer */
    const readString = pointer=>host.readCString(pointer, MAX_STRING);

    /** @param {number} pointer @param {string} text */
    const writeString = (pointer, text)=>{
        if ((pointer >>> 0) === 0)
        {
            return;
        }
        const bytes = new Uint8Array(text.length + 1);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at] = text.charCodeAt(at) & 0xff;
        }
        host.writeMemory(pointer, bytes);
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
     */
    const operation = (argBytes, act)=>({
        convention: 'cdecl',
        argBytes,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ args)=>{
            const code = act(args);
            if (code === 0)
            {
                return 0;
            }
            fail(code);
            return -1;
        },
    });

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
                const parts = splitPath(readString(path));
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
                let text = read(drive);
                if (text.length > 0 && !text.endsWith(':'))
                {
                    text += ':';
                }
                let folder = read(directory);
                if (folder.length > 0 && !/[\\/]$/.test(folder))
                {
                    folder += '\\';
                }
                let suffix = read(extension);
                if (suffix.length > 0 && !suffix.startsWith('.'))
                {
                    suffix = `.${suffix}`;
                }
                writeString(path, text + folder + read(name) + suffix);
                return 0;
            },
        },

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
        }),

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
    };
}
