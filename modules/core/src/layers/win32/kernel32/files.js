/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The kernel32 file surface, over an injected virtual filesystem.
 *
 * Nothing here knows where bytes actually live. The filesystem is handed in and
 * speaks in paths and opaque nodes; everything below is the translation between
 * that and what the guest compiled against -- handles, DWORD pairs standing in
 * for 64-bit values, out-parameters, and the last-error slot.
 *
 * Two things about that translation are worth stating up front, because both
 * are places a faithful implementation looks wrong:
 *
 * The last error is part of the return value of half this surface. CreateFile
 * reports through it on success as well as on failure, and SetFilePointer and
 * GetFileSize have return values that are simultaneously a legal answer and a
 * failure -- the only way a caller can tell is that a failure also set an error
 * code. So success clears it wherever the documented idiom depends on that, and
 * a comment says so at each of them.
 *
 * A handle is a handle. Files, searches, events and threads share one space and
 * one CloseHandle, so the table is injected rather than kept here: two handle
 * spaces means a file handle that collides with an event, which the guest has
 * no way to notice.
 */

import { HANDLE_STDIN, HANDLE_STDOUT, HANDLE_STDERR } from './console.js';

/** Codes this surface reports through the last-error slot. */
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NO_MORE_FILES = 18;
const ERROR_FILE_EXISTS = 80;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NEGATIVE_SEEK = 131;
const ERROR_DIR_NOT_EMPTY = 145;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_DIRECTORY = 267;

/** The failure value of each of the four APIs that has its own. */
const INVALID_HANDLE_VALUE = 0xffffffff;
const INVALID_SET_FILE_POINTER = 0xffffffff;
const INVALID_FILE_SIZE = 0xffffffff;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;

/**
 * The access rights we decode. The specific rights (FILE_READ_DATA and its
 * neighbours) are not: a mask that names none of these opens the file for
 * neither reading nor writing, which is what Windows does for the query-only
 * access of zero and is a defined answer for the rest.
 */
const GENERIC_ALL = 0x10000000;
const GENERIC_WRITE = 0x40000000;
const GENERIC_READ = 0x80000000;

/** dwCreationDisposition. */
const CREATE_NEW = 1;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const TRUNCATE_EXISTING = 5;

/** dwMoveMethod. */
const FILE_BEGIN = 0;
const FILE_CURRENT = 1;
const FILE_END = 2;

/**
 * The attributes we can answer for. We keep no attribute bits of our own, so a
 * file is reported as an ordinary archived one and a directory as a directory;
 * SetFileAttributes accepts what it is told and stores nothing, because nothing
 * below enforces read-only or hidden anyway.
 */
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_ARCHIVE = 0x20;

/** The ANSI path limit, and the size of cFileName with it. */
const MAX_PATH = 260;

/** How much of a file to move at a time when copying one. */
const COPY_CHUNK = 1 << 20;

/**
 * What GetTempPathA answers. Windows derives it from the environment; there is
 * one process and no environment block worth consulting, so one directory is
 * chosen and always the same one. The trailing separator is part of the
 * contract -- callers concatenate a file name onto it directly.
 */
const TEMP_PATH = 'C:\\WINDOWS\\TEMP\\';

/**
 * WIN32_FIND_DATAA, laid out the way the guest compiled it.
 *
 * The three FILETIMEs are eight bytes each and the two names are fixed arrays,
 * so nothing here is derivable from a field count -- an offset read from the
 * wrong place produces a plausible file size rather than an error. The tail is
 * cAlternateFileName's 14 bytes, which the structure's four-byte alignment
 * rounds up to a total of 320.
 */
export const WIN32_FIND_DATAA = Object.freeze({
    dwFileAttributes: 0,
    ftCreationTime: 4,
    ftLastAccessTime: 12,
    ftLastWriteTime: 20,
    nFileSizeHigh: 28,
    nFileSizeLow: 32,
    dwReserved0: 36,
    dwReserved1: 40,
    cFileName: 44,
    cAlternateFileName: 304,
    SIZE: 320,
});

/**
 * @typedef {Object} FileStat
 * @property {boolean} exists
 * @property {boolean} isDirectory
 * @property {number} size
 */

/**
 * @typedef {Object} DirectoryEntry
 * @property {string} name
 * @property {boolean} isDirectory
 * @property {number} size
 */

/**
 * @typedef {Object} OpenMode
 * @property {boolean} [read]
 * @property {boolean} [write]
 * @property {boolean} [create]        Make the file when it is not there.
 * @property {boolean} [truncate]      Discard whatever it already holds.
 * @property {boolean} [failIfExists]  Refuse rather than open an existing file.
 */

/**
 * The virtual filesystem this surface is built on. Paths reaching it are
 * absolute and carry no trailing separator except at a drive root.
 *
 * @typedef {Object} FileSystem
 * @property {(path: string) => FileStat | null} stat
 * @property {(path: string, mode: OpenMode) => any} open   Opaque node, or null.
 * @property {(node: any, offset: number, length: number) => Uint8Array} read
 *           Short at the end of the file; empty past it, which is not an error.
 * @property {(node: any, offset: number, bytes: Uint8Array) => number} write
 * @property {(node: any, size: number) => void} truncate
 * @property {(node: any) => void} close
 * @property {(path: string) => boolean} remove
 * @property {(path: string) => boolean} mkdir
 * @property {(from: string, to: string) => boolean} rename
 * @property {(path: string, pattern: string) => DirectoryEntry[]} list
 * @property {() => string} currentDirectory
 * @property {(path: string) => void} setCurrentDirectory
 */

/**
 * @typedef {Object} FileHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {FileSystem} files
 * @property {(code: number) => void} setLastError
 * @property {(handle: number, text: string) => void} writeConsole
 *           Where a write to a standard handle goes instead of the filesystem.
 * @property {{ open: (type: string, object: any) => number,
 *              resolve: (handle: number, type?: string) => any,
 *              close: (handle: number) => any }} handles
 *           The one handle table, shared with every other kind of object.
 */

/** @param {number} value */
const low = value=>value >>> 0;

/** @param {number} value */
const high = value=>Math.floor(value / 0x100000000) >>> 0;

/**
 * Reassembles the signed 64-bit value a pair of DWORDs stands for. Distances
 * are signed -- seeking backwards from the end is the common case -- and only
 * the low half arrives as a two's-complement number.
 *
 * @param {number} lowPart @param {number} highPart
 */
const int64 = (lowPart, highPart)=>(highPart | 0) * 0x100000000 + (lowPart >>> 0);

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * `argBytes` is the size of the argument list the guest compiled against; all
 * of these are stdcall, the bridge's default, so none of them says so. Note
 * SetFilePointerEx, whose LARGE_INTEGER is passed by value and therefore costs
 * eight of its twenty bytes.
 *
 * @param {FileHost} host
 */
export function createFileFunctions(host){
    const { files } = host;

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address, new Uint8Array([
            value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
        ]));
    };

    /** Most out-parameters here are optional, and a NULL one is not an error. */
    const writeDwordIf = (/** @type {number} */ address, /** @type {number} */ value)=>{
        if (address !== 0)
        {
            writeDword(address, value);
        }
    };

    /** @param {number} address @param {number} value */
    const writeQword = (address, value)=>{
        writeDword(address, low(value));
        writeDword(address + 4, high(value));
    };

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    };

    /** @param {string} text */
    const latin1 = text=>{
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++)
        {
            bytes[i] = text.charCodeAt(i) & 0xff;
        }
        return bytes;
    };

    /**
     * The two-call protocol every path-returning function here shares: called
     * with a buffer too small (or none at all) it reports the size it needs
     * *including* the terminator, and having written it reports the length
     * *without* one. Callers switch on exactly that difference.
     *
     * @param {number} buffer @param {number} size @param {string} text
     * @returns {number} what the function returns
     */
    const writeStringTo = (buffer, size, text)=>{
        if (buffer === 0 || text.length + 1 > (size >>> 0))
        {
            return text.length + 1;
        }
        host.writeMemory(buffer, latin1(text + '\0'));
        return text.length;
    };

    /** @param {number} pointer */
    const pathArgument = pointer=>fullPath(
        pointer === 0 ? '' : host.readCString(pointer >>> 0, MAX_PATH));

    /**
     * Turns what the guest wrote into the absolute path the filesystem takes.
     * Forward slashes are accepted because Windows accepts them, `.` and `..`
     * are resolved here rather than below, and the trailing separator is
     * dropped -- the filesystem sees one spelling of a directory, and the one
     * caller that cares about the separator (GetFullPathNameA) puts it back.
     *
     * @param {string} name
     */
    function fullPath(name){
        if (name === '')
        {
            return '';
        }
        const written = name.replace(/\//g, '\\');
        const rooted = isAbsolute(written) ? written : underCurrentDirectory(written);
        // A UNC path's root is its leading pair of separators; anything else
        // rooted here is a drive letter, colon, separator.
        const root = rooted.startsWith('\\\\') ? '\\\\' : rooted.slice(0, 3);
        /** @type {string[]} */
        const parts = [];
        for (const part of rooted.slice(root.length).split('\\'))
        {
            if (part === '' || part === '.')
            {
                continue;
            }
            if (part === '..')
            {
                parts.pop();
                continue;
            }
            parts.push(part);
        }
        return root + parts.join('\\');
    }

    /** @param {string} path */
    const isAbsolute = path=>/^[A-Za-z]:\\/.test(path) || path.startsWith('\\\\');

    /** @param {string} path */
    const underCurrentDirectory = path=>{
        const current = files.currentDirectory();
        // Rooted but driveless -- "\WINDOWS" -- means the drive we are on.
        if (path.startsWith('\\'))
        {
            return current.slice(0, 2) + path;
        }
        return current.endsWith('\\') ? current + path : current + '\\' + path;
    };

    /** @param {string} path @returns {string} the directory holding it */
    const parentOf = path=>{
        const at = path.lastIndexOf('\\');
        if (at < 0)
        {
            return '';
        }
        // "C:\FILE" -- the parent is the root, which keeps its separator.
        return at <= 2 ? path.slice(0, at + 1) : path.slice(0, at);
    };

    /**
     * Which of the two "it isn't there" codes applies. Windows distinguishes
     * them by where the walk stopped, and callers do act on the difference: a
     * missing file is often expected, a missing directory rarely is.
     *
     * @param {string} path
     */
    const missing = path=>{
        const parent = files.stat(parentOf(path));
        return parent && parent.exists && parent.isDirectory
            ? ERROR_FILE_NOT_FOUND
            : ERROR_PATH_NOT_FOUND;
    };

    /**
     * Fails a call with a code, returning whatever that function's failure
     * value is. Everything that fails here does both, and doing only one of
     * them is the bug this exists to make impossible.
     *
     * @param {number} code @param {number} [result]
     */
    const fail = (code, result = 0)=>{
        host.setLastError(code);
        return result;
    };

    /** @param {number} handle */
    const isStandardHandle = handle=>
        handle === HANDLE_STDIN || handle === HANDLE_STDOUT || handle === HANDLE_STDERR;

    /**
     * Resolves a handle to one of ours, or null. A stale or invented handle is
     * a return code rather than an exception: guests do pass them, and Windows
     * answers with a failure.
     *
     * @param {number} handle @param {string} type
     */
    const object = (handle, type)=>{
        try
        {
            return host.handles.resolve(handle >>> 0, type);
        }
        catch (e){
            void e;
            return null;
        }
    };

    /**
     * The size the filesystem currently reports for an open file. Taken by path
     * rather than remembered, because a second handle onto the same file, or a
     * SetEndOfFile through one of them, changes it under us.
     *
     * @param {{ path: string }} file
     */
    const sizeOf = file=>files.stat(file.path)?.size ?? 0;

    /** @param {DirectoryEntry | FileStat} entry */
    const attributesOf = entry=>
        entry.isDirectory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_ARCHIVE;

    /**
     * Fills in a whole WIN32_FIND_DATAA. Written in one piece so that no field
     * can be left holding whatever the caller's buffer had in it -- the times
     * and the alternate 8.3 name we have nothing to say about are zeros the
     * guest can read, not gaps.
     *
     * @param {number} address @param {DirectoryEntry} entry
     */
    const writeFindData = (address, entry)=>{
        const data = new Uint8Array(WIN32_FIND_DATAA.SIZE);
        const view = new DataView(data.buffer);
        view.setUint32(WIN32_FIND_DATAA.dwFileAttributes, attributesOf(entry), true);
        const size = entry.size ?? 0;
        view.setUint32(WIN32_FIND_DATAA.nFileSizeHigh, high(size), true);
        view.setUint32(WIN32_FIND_DATAA.nFileSizeLow, low(size), true);
        data.set(latin1(entry.name.slice(0, MAX_PATH - 1)), WIN32_FIND_DATAA.cFileName);
        host.writeMemory(address, data);
    };

    /**
     * Runs a seek and reports where it landed, or null when the answer is not a
     * legal position. Shared by both SetFilePointer forms, which differ only in
     * how they carry the number and how they report the failure.
     *
     * @param {any} file @param {number} distance @param {number} method
     * @returns {number | null}
     */
    const seek = (file, distance, method)=>{
        let base;
        switch (method){
            case FILE_BEGIN:
                base = 0;
                break;
            case FILE_CURRENT:
                base = file.position;
                break;
            case FILE_END:
                base = sizeOf(file);
                break;
            default:
                return null;
        }
        const position = base + distance;
        // Past the end is legal and is how a file is extended; before the
        // beginning is not.
        return position < 0 ? null : position;
    };

    /**
     * CreateFileA's disposition, as what the filesystem is asked to do.
     *
     * @type {Record<number, OpenMode | undefined>}
     */
    const openModes = {
        [CREATE_NEW]: { create: true, failIfExists: true },
        [CREATE_ALWAYS]: { create: true, truncate: true },
        [OPEN_EXISTING]: {},
        [OPEN_ALWAYS]: { create: true },
        [TRUNCATE_EXISTING]: { truncate: true },
    };

    return {
        /**
         * HANDLE CreateFileA(LPCSTR, DWORD dwDesiredAccess, DWORD dwShareMode,
         *                    LPSECURITY_ATTRIBUTES, DWORD dwCreationDisposition,
         *                    DWORD dwFlagsAndAttributes, HANDLE hTemplateFile)
         *
         * Sharing, security and the template are accepted and ignored: there is
         * one process, no security descriptor to check against, and no
         * attribute of a template file we could copy. A request Windows would
         * refuse for want of a share mode succeeds here.
         */
        CreateFileA: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([name, access, , , disposition])=>{
                const path = pathArgument(name);
                const mode = openModes[disposition >>> 0];
                if (!mode)
                {
                    return fail(ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE);
                }
                const rights = access >>> 0;
                const read = (rights & GENERIC_READ) !== 0 || (rights & GENERIC_ALL) !== 0;
                const write = (rights & GENERIC_WRITE) !== 0 || (rights & GENERIC_ALL) !== 0;
                if (disposition === TRUNCATE_EXISTING && !write)
                {
                    return fail(ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE);
                }

                const existing = files.stat(path);
                const exists = Boolean(existing && existing.exists);
                if (exists && existing?.isDirectory)
                {
                    // Opening a directory needs FILE_FLAG_BACKUP_SEMANTICS,
                    // which nothing here honours.
                    return fail(ERROR_ACCESS_DENIED, INVALID_HANDLE_VALUE);
                }
                if (exists && disposition === CREATE_NEW)
                {
                    return fail(ERROR_FILE_EXISTS, INVALID_HANDLE_VALUE);
                }
                if (!exists && (disposition === OPEN_EXISTING
                    || disposition === TRUNCATE_EXISTING))
                {
                    return fail(missing(path), INVALID_HANDLE_VALUE);
                }

                const node = files.open(path, { read, write, ...mode });
                if (!node)
                {
                    return fail(exists ? ERROR_ACCESS_DENIED : missing(path),
                        INVALID_HANDLE_VALUE);
                }

                // A program reads the error after a *successful* CreateFile:
                // ERROR_ALREADY_EXISTS is how the two dispositions that accept
                // either state say which one they found, and clearing it
                // otherwise is what makes that test mean anything.
                const opened = disposition === CREATE_ALWAYS || disposition === OPEN_ALWAYS;
                host.setLastError(exists && opened ? ERROR_ALREADY_EXISTS : ERROR_SUCCESS);
                return host.handles.open('file', { path, node, read, write, position: 0 });
            },
        },

        /**
         * BOOL ReadFile(HANDLE, LPVOID, DWORD, LPDWORD lpNumberOfBytesRead,
         *               LPOVERLAPPED)
         *
         * The overlapped pointer is accepted and ignored; every read here
         * completes before returning. Reading a standard handle is an immediate
         * end of input rather than a failure -- there is no console to type at,
         * and a program that asks gets the answer it would get from a redirected
         * empty stream.
         */
        ReadFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, read])=>{
                if (isStandardHandle(handle >>> 0))
                {
                    writeDwordIf(read >>> 0, 0);
                    return 1;
                }
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (!file.read)
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                const bytes = files.read(file.node, file.position, length >>> 0);
                if (bytes.length > 0)
                {
                    host.writeMemory(buffer >>> 0, bytes);
                }
                file.position += bytes.length;
                // Written even when nothing was read: a program that checks it
                // is exactly the program that has reached the end of the file.
                writeDwordIf(read >>> 0, bytes.length);
                return 1;
            },
        },

        /**
         * BOOL WriteFile(HANDLE, LPCVOID, DWORD, LPDWORD lpNumberOfBytesWritten,
         *                LPOVERLAPPED)
         *
         * The standard handles are not files and never become them: a console
         * program writes to the same function as one writing a save file, and
         * this is where the two part company.
         */
        WriteFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, written])=>{
                const count = length >>> 0;
                if (isStandardHandle(handle >>> 0))
                {
                    const bytes = host.readMemory(buffer >>> 0, count);
                    host.writeConsole(handle >>> 0, new TextDecoder('latin1').decode(bytes));
                    writeDwordIf(written >>> 0, count);
                    return 1;
                }
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (!file.write)
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                // Copied, not passed on: the memory layer may hand back a view
                // onto guest memory, and what the filesystem stores outlives
                // this call.
                const bytes = count === 0
                    ? new Uint8Array(0)
                    : host.readMemory(buffer >>> 0, count).slice();
                const stored = files.write(file.node, file.position, bytes);
                file.position += stored;
                // Written even for a zero-length write, which is how a program
                // asks whether the handle still works.
                writeDwordIf(written >>> 0, stored);
                return 1;
            },
        },

        /**
         * DWORD SetFilePointer(HANDLE, LONG lDistanceToMove,
         *                      PLONG lpDistanceToMoveHigh, DWORD dwMoveMethod)
         *
         * Its return value is ambiguous by design and cannot be fixed here:
         * 0xffffffff is both the failure value and the low half of a legal
         * position. The documented way out is that a failure also sets the last
         * error, so a caller that cares clears the error first and reads it
         * after. That only works if success clears it too, which is why it does
         * so below.
         */
        SetFilePointer: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, distance, highPointer, method])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE, INVALID_SET_FILE_POINTER);
                }
                // The high half is an in/out parameter: supplied, it carries
                // the top 32 bits of the distance in and the new position out.
                const moveHigh = highPointer >>> 0;
                const wanted = moveHigh === 0
                    ? (distance | 0)
                    : int64(distance, readDword(moveHigh));
                const position = seek(file, wanted, method >>> 0);
                if (position === null)
                {
                    return fail(
                        (method >>> 0) > FILE_END ? ERROR_INVALID_PARAMETER : ERROR_NEGATIVE_SEEK,
                        INVALID_SET_FILE_POINTER);
                }
                file.position = position;
                if (moveHigh !== 0)
                {
                    writeDword(moveHigh, high(position));
                }
                host.setLastError(ERROR_SUCCESS);
                return low(position);
            },
        },

        /**
         * BOOL SetFilePointerEx(HANDLE, LARGE_INTEGER liDistanceToMove,
         *                       PLARGE_INTEGER lpNewFilePointer, DWORD dwMoveMethod)
         *
         * The same seek without the ambiguity: the distance arrives whole (by
         * value, so it occupies two of the argument slots) and the answer comes
         * back through a pointer, leaving the return value free to mean what it
         * says.
         */
        SetFilePointerEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, distanceLow, distanceHigh, newPointer, method])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                const position = seek(file, int64(distanceLow, distanceHigh), method >>> 0);
                if (position === null)
                {
                    return fail((method >>> 0) > FILE_END
                        ? ERROR_INVALID_PARAMETER
                        : ERROR_NEGATIVE_SEEK);
                }
                file.position = position;
                if (newPointer !== 0)
                {
                    writeQword(newPointer >>> 0, position);
                }
                return 1;
            },
        },

        /** BOOL SetEndOfFile(HANDLE) */
        SetEndOfFile: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (!file.write)
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                // The current position is the new end -- that is the whole
                // function; it takes no size of its own.
                files.truncate(file.node, file.position);
                return 1;
            },
        },

        /**
         * BOOL FlushFileBuffers(HANDLE)
         *
         * Nothing between the guest and the filesystem is buffered, so there is
         * nothing to push. Validating the handle is the only observable part,
         * and a program that flushes an invalid one wants to hear about it.
         */
        FlushFileBuffers: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>object(handle, 'file') ? 1 : fail(ERROR_INVALID_HANDLE),
        },

        /**
         * DWORD GetFileSize(HANDLE, LPDWORD lpFileSizeHigh)
         *
         * Ambiguous in the same way as SetFilePointer, and answered the same
         * way: a file whose low size DWORD is 0xffffffff is indistinguishable
         * from a failure except by the last error, so success clears it.
         */
        GetFileSize: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, highPointer])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE, INVALID_FILE_SIZE);
                }
                const size = sizeOf(file);
                writeDwordIf(highPointer >>> 0, high(size));
                host.setLastError(ERROR_SUCCESS);
                return low(size);
            },
        },

        /** BOOL GetFileSizeEx(HANDLE, PLARGE_INTEGER lpFileSize) */
        GetFileSizeEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, pointer])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (pointer === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                writeQword(pointer >>> 0, sizeOf(file));
                return 1;
            },
        },

        /**
         * BOOL CloseHandle(HANDLE)
         *
         * Every kind of object goes through this one function, so it closes the
         * handle whatever it names and only tells the filesystem when what it
         * named was a file or a search of one.
         */
        CloseHandle: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                try
                {
                    const closed = host.handles.close(handle >>> 0);
                    if (closed && closed.node)
                    {
                        files.close(closed.node);
                    }
                    return 1;
                }
                catch (e){
                    void e;
                    return fail(ERROR_INVALID_HANDLE);
                }
            },
        },

        /** BOOL DeleteFileA(LPCSTR) */
        DeleteFileA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>{
                const path = pathArgument(name);
                const entry = files.stat(path);
                if (!entry || !entry.exists)
                {
                    return fail(missing(path));
                }
                if (entry.isDirectory)
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                return files.remove(path) ? 1 : fail(ERROR_ACCESS_DENIED);
            },
        },

        /**
         * BOOL MoveFileA(LPCSTR lpExistingFileName, LPCSTR lpNewFileName)
         *
         * Never replaces: MoveFileA without MOVEFILE_REPLACE_EXISTING fails if
         * the destination is there, and the caller that means to overwrite
         * deletes first.
         */
        MoveFileA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([from, to])=>{
                const source = pathArgument(from);
                const destination = pathArgument(to);
                if (!files.stat(source)?.exists)
                {
                    return fail(missing(source));
                }
                if (files.stat(destination)?.exists)
                {
                    return fail(ERROR_ALREADY_EXISTS);
                }
                return files.rename(source, destination) ? 1 : fail(ERROR_ACCESS_DENIED);
            },
        },

        /**
         * BOOL CopyFileA(LPCSTR, LPCSTR, BOOL bFailIfExists)
         *
         * Copied through the ordinary read and write path rather than by asking
         * the filesystem for a copy, because a copy that is not a read followed
         * by a write is a second implementation of both.
         */
        CopyFileA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([from, to, failIfExists])=>{
                const source = pathArgument(from);
                const destination = pathArgument(to);
                const entry = files.stat(source);
                if (!entry || !entry.exists || entry.isDirectory)
                {
                    return fail(entry?.isDirectory ? ERROR_ACCESS_DENIED : missing(source));
                }
                if (failIfExists !== 0 && files.stat(destination)?.exists)
                {
                    return fail(ERROR_FILE_EXISTS);
                }
                const input = files.open(source, { read: true });
                if (!input)
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                const output = files.open(destination,
                    { write: true, create: true, truncate: true });
                if (!output)
                {
                    files.close(input);
                    return fail(missing(destination));
                }
                // A chunk at a time: the files a game copies are the ones it
                // shipped, and holding one of those whole is a copy that works
                // in a test and runs out of memory on a real install.
                for (let at = 0; at < entry.size; at += COPY_CHUNK)
                {
                    files.write(output, at, files.read(input, at, COPY_CHUNK));
                }
                files.close(input);
                files.close(output);
                return 1;
            },
        },

        /** BOOL CreateDirectoryA(LPCSTR, LPSECURITY_ATTRIBUTES) */
        CreateDirectoryA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name])=>{
                const path = pathArgument(name);
                if (files.stat(path)?.exists)
                {
                    return fail(ERROR_ALREADY_EXISTS);
                }
                // Only one level at a time, as Windows does: a missing parent
                // is a failure, not something to create on the way past.
                return files.mkdir(path) ? 1 : fail(ERROR_PATH_NOT_FOUND);
            },
        },

        /** BOOL RemoveDirectoryA(LPCSTR) */
        RemoveDirectoryA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>{
                const path = pathArgument(name);
                const entry = files.stat(path);
                if (!entry || !entry.exists)
                {
                    return fail(missing(path));
                }
                if (!entry.isDirectory)
                {
                    return fail(ERROR_DIRECTORY);
                }
                // The filesystem refuses to remove a directory with anything in
                // it, and that refusal is the only reason this can fail here.
                return files.remove(path) ? 1 : fail(ERROR_DIR_NOT_EMPTY);
            },
        },

        /** DWORD GetFileAttributesA(LPCSTR) */
        GetFileAttributesA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>{
                const path = pathArgument(name);
                const entry = files.stat(path);
                if (!entry || !entry.exists)
                {
                    return fail(missing(path), INVALID_FILE_ATTRIBUTES);
                }
                return attributesOf(entry);
            },
        },

        /**
         * BOOL SetFileAttributesA(LPCSTR, DWORD dwFileAttributes)
         *
         * Accepted and forgotten. We store no attribute bits and enforce none,
         * so the honest answer to "make this read-only" is that it succeeded and
         * changed nothing; failing instead would stop programs that only clear
         * read-only before deleting.
         */
        SetFileAttributesA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name])=>{
                const path = pathArgument(name);
                return files.stat(path)?.exists ? 1 : fail(missing(path));
            },
        },

        /**
         * DWORD GetFullPathNameA(LPCSTR, DWORD nBufferLength, LPSTR lpBuffer,
         *                        LPSTR *lpFilePart)
         *
         * Purely textual, as on Windows: nothing is required to exist. The file
         * part points into the caller's own buffer, and is NULL when the path
         * names a directory -- which, having no filesystem to ask, is decided
         * by the trailing separator the caller wrote.
         */
        GetFullPathNameA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([name, size, buffer, filePart])=>{
                const written = name === 0 ? '' : host.readCString(name >>> 0, MAX_PATH);
                if (written === '')
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const resolved = fullPath(written);
                const directory = /[\\/]$/.test(written) && !resolved.endsWith('\\');
                const text = directory ? resolved + '\\' : resolved;

                const result = writeStringTo(buffer >>> 0, size, text);
                if (result === text.length)
                {
                    const at = text.lastIndexOf('\\');
                    writeDwordIf(filePart >>> 0,
                        text.endsWith('\\') ? 0 : (buffer >>> 0) + at + 1);
                }
                return result;
            },
        },

        /** DWORD GetCurrentDirectoryA(DWORD nBufferLength, LPSTR lpBuffer) */
        GetCurrentDirectoryA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, buffer])=>writeStringTo(buffer >>> 0, size,
                files.currentDirectory()),
        },

        /** BOOL SetCurrentDirectoryA(LPCSTR) */
        SetCurrentDirectoryA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>{
                const path = pathArgument(name);
                const entry = files.stat(path);
                if (!entry || !entry.exists || !entry.isDirectory)
                {
                    return fail(ERROR_PATH_NOT_FOUND);
                }
                files.setCurrentDirectory(path);
                return 1;
            },
        },

        /** DWORD GetTempPathA(DWORD nBufferLength, LPSTR lpBuffer) */
        GetTempPathA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, buffer])=>writeStringTo(buffer >>> 0, size, TEMP_PATH),
        },

        /**
         * HANDLE FindFirstFileA(LPCSTR, LPWIN32_FIND_DATAA)
         *
         * The whole listing is taken now and walked from memory afterwards. A
         * search is a position in a snapshot rather than a live cursor, which is
         * what keeps a program that deletes as it enumerates -- the usual reason
         * to enumerate at all -- from walking off the end of a shrinking list.
         */
        FindFirstFileA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, data])=>{
                const path = pathArgument(name);
                if (path === '')
                {
                    return fail(ERROR_PATH_NOT_FOUND, INVALID_HANDLE_VALUE);
                }
                const directory = parentOf(path);
                const pattern = path.slice(directory.endsWith('\\')
                    ? directory.length
                    : directory.length + 1);
                const holder = files.stat(directory);
                if (!holder || !holder.exists || !holder.isDirectory)
                {
                    return fail(ERROR_PATH_NOT_FOUND, INVALID_HANDLE_VALUE);
                }
                const entries = files.list(directory, pattern) ?? [];
                if (entries.length === 0)
                {
                    // Nothing matched is not the same as nowhere to look, and
                    // callers branch on which of the two they got.
                    return fail(ERROR_FILE_NOT_FOUND, INVALID_HANDLE_VALUE);
                }
                writeFindData(data >>> 0, entries[0]);
                host.setLastError(ERROR_SUCCESS);
                return host.handles.open('find', { entries, index: 1 });
            },
        },

        /** BOOL FindNextFileA(HANDLE, LPWIN32_FIND_DATAA) */
        FindNextFileA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, data])=>{
                const search = object(handle, 'find');
                if (!search)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (search.index >= search.entries.length)
                {
                    // The end of the enumeration is a specific code, and a loop
                    // that stops on anything else stops for the wrong reason.
                    return fail(ERROR_NO_MORE_FILES);
                }
                writeFindData(data >>> 0, search.entries[search.index]);
                search.index++;
                return 1;
            },
        },

        /**
         * BOOL FindClose(HANDLE)
         *
         * A search handle is not a file handle: it names no open file, and
         * CloseHandle is not what closes it.
         */
        FindClose: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!object(handle, 'find'))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                host.handles.close(handle >>> 0);
                return 1;
            },
        },
    };
}
