/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * lz32 — the expansion library, as an installer uses it: open a source that
 * may be compressed, open a destination, copy the one into the other.
 *
 * A handle here is a small integer of this library's own, never a kernel
 * handle: the documented calls take and return `INT`, a program passes them
 * only back to this library, and LZClose is what releases them. The file
 * behind a handle is read whole when it is opened, because an expanded
 * stream cannot be read at an offset without expanding everything before it
 * anyway, and every file this library is asked about is small.
 */

import { expand, expandedName, readHeader } from './expand.js';
import { encodeAnsi } from '../kernel32/locale.js';

/** wStyle bits OpenFile understands and this library acts on. */
const OF_WRITE = 0x0001;
const OF_READWRITE = 0x0002;
const OF_CREATE = 0x1000;
const OF_EXIST = 0x4000;
const OF_DELETE = 0x0200;

/** The answers below zero. */
const LZERROR_BADINHANDLE = -1;
const LZERROR_BADOUTHANDLE = -2;
const LZERROR_READ = -3;
const LZERROR_WRITE = -4;

/** OFSTRUCT: the size byte, and where the path goes. */
const OFSTRUCT_SIZE = 136;
const OFSTRUCT_PATH = 8;
const OFSTRUCT_PATH_LENGTH = 128;

/** A path is at most this long; longer is a pointer that is not a string. */
const MAX_PATH = 260;

/**
 * @typedef {Object} LzHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {any} files  The volume, as `vfs.js` speaks it.
 */

/**
 * @typedef {Object} LzFile
 * @property {string} path
 * @property {Uint8Array | null} content  Read whole, expanded if it was compressed;
 *           null for a destination, which is only ever written.
 * @property {boolean} writable
 */

/**
 * @param {LzHost} host
 */
export function createLzFunctions(host){
    const { files } = host;

    /** @type {Map<number, LzFile>} */
    const open = new Map();
    let next = 1;

    /** @param {string} path @returns {Uint8Array | null} */
    const load = path=>{
        const entry = files.stat(path);
        if (!entry?.exists || entry.isDirectory)
        {
            return null;
        }
        const node = files.open(path, { read: true });
        if (!node)
        {
            return null;
        }
        const read = files.read(node, 0, entry.size);
        files.close(node);
        // A file whose bytes are not resident cannot be answered here in the
        // shape the caller wants; this library reads what a program just
        // extracted beside itself, which is always here.
        return read instanceof Promise ? null : read;
    };

    /** @param {string} path @param {Uint8Array} bytes */
    const store = (path, bytes)=>{
        const node = files.open(path, { read: true, write: true, create: true, truncate: true });
        if (!node)
        {
            return false;
        }
        files.write(node, 0, bytes);
        files.close(node);
        return true;
    };

    /** @param {number} address @param {string} path */
    const writeOfStruct = (address, path)=>{
        const bytes = new Uint8Array(OFSTRUCT_SIZE);
        bytes[0] = OFSTRUCT_SIZE;
        bytes.set(encodeAnsi(path.slice(0, OFSTRUCT_PATH_LENGTH - 1)), OFSTRUCT_PATH);
        host.writeMemory(address, bytes);
    };

    /**
     * LZOpenFile's work once the name is read, whichever width it came in.
     * @param {string} asked @param {number} reopen @param {number} style
     */
    const openFile = (asked, reopen, style)=>{
        const mode = style & 0xffff;
        if ((mode & OF_DELETE) !== 0)
        {
            return files.remove(asked) ? 1 : LZERROR_BADINHANDLE;
        }
        if ((mode & OF_CREATE) !== 0)
        {
            if (!store(asked, new Uint8Array(0)))
            {
                return LZERROR_BADOUTHANDLE;
            }
            const handle = next++;
            open.set(handle, { path: asked, content: null, writable: true });
            writeOfStruct(reopen >>> 0, asked);
            return handle;
        }
        let path = asked;
        let bytes = load(path);
        if (bytes === null && asked.length > 0)
        {
            path = `${asked.slice(0, -1)}_`;
            bytes = load(path);
        }
        if (bytes === null)
        {
            return LZERROR_BADINHANDLE;
        }
        if ((mode & OF_EXIST) !== 0)
        {
            writeOfStruct(reopen >>> 0, path);
            return 1;
        }
        const handle = next++;
        open.set(handle, {
            path,
            content: expand(bytes),
            writable: (mode & (OF_WRITE | OF_READWRITE)) !== 0,
        });
        writeOfStruct(reopen >>> 0, path);
        return handle;
    };

    return {
        /**
         * INT LZOpenFileA(LPSTR lpFileName, LPOFSTRUCT lpReOpenBuf, WORD wStyle)
         *
         * Opened for reading, the file is read whole and expanded when it
         * carries the compressed signature. A name that is not there is tried
         * with its last character replaced by an underscore, which is how a
         * program asking for `SETUP.DLL` finds the `SETUP.DL_` it shipped.
         */
        LZOpenFileA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, reopen, style])=>openFile(host.readCString(name >>> 0, MAX_PATH),
                reopen, style),
        },

        /**
         * INT LZOpenFileW(LPWSTR lpFileName, LPOFSTRUCT lpReOpenBuf, WORD wStyle)
         *
         * LZOpenFileA for a UTF-16 name; the OFSTRUCT's path stays ANSI, as
         * the structure has no wide form.
         */
        LZOpenFileW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, reopen, style])=>openFile(
                host.readWideString?.(name >>> 0, MAX_PATH) ?? '', reopen, style),
        },

        /**
         * LONG LZCopy(INT hfSource, INT hfDest)
         *
         * The expanded bytes of the source become the whole of the
         * destination; the answer is how many there were.
         */
        LZCopy: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([source, destination])=>{
                const from = open.get(source | 0);
                const to = open.get(destination | 0);
                if (!from)
                {
                    return LZERROR_BADINHANDLE >>> 0;
                }
                if (!to || !to.writable)
                {
                    return LZERROR_BADOUTHANDLE >>> 0;
                }
                if (from.content === null)
                {
                    return LZERROR_READ >>> 0;
                }
                return store(to.path, from.content) ? from.content.length : LZERROR_WRITE >>> 0;
            },
        },

        /** void LZClose(INT hFile) */
        LZClose: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                open.delete(handle | 0);
                return 0;
            },
        },

        /**
         * INT GetExpandedNameA(LPSTR lpszSource, LPSTR lpszBuffer)
         *
         * The name the compressor took, from the character it kept in the
         * header; a file that is not compressed is its own answer.
         */
        GetExpandedNameA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, buffer])=>{
                const asked = host.readCString(name >>> 0, MAX_PATH);
                const bytes = load(asked);
                if (bytes === null)
                {
                    return LZERROR_BADINHANDLE >>> 0;
                }
                const answer = expandedName(asked, readHeader(bytes));
                host.writeMemory(buffer >>> 0, encodeAnsi(`${answer}\0`));
                return 1;
            },
        },
    };
}
