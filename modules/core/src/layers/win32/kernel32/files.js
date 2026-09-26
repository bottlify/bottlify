/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
import { msToFileTime } from './filetime.js';

/** Codes this surface reports through the last-error slot. */
const ERROR_SUCCESS = 0;
const ERROR_INVALID_FUNCTION = 1;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NO_MORE_FILES = 18;
const ERROR_FILE_EXISTS = 80;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NEGATIVE_SEEK = 131;
const ERROR_NOT_SUPPORTED = 50;
const ERROR_DIR_NOT_EMPTY = 145;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_DIRECTORY = 267;
const ERROR_IO_DEVICE = 1117;

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
/** A search path list is many of them; longer is a pointer that is not a string. */
const MAX_PATH_LIST = 32767;

/**
 * The path separator, as a named constant rather than a literal, because it is
 * also this file's escape character and the two are easy to confuse when one
 * appears inside a template or a regular expression.
 */
const SEPARATOR = '\\';

/**
 * OFSTRUCT, which OpenFile fills in. The path is eight-bit text in a fixed
 * array at the end, and cBytes counts the whole structure rather than the path.
 */
const OFSTRUCT_SIZE = 136;
const OFSTRUCT_PATH = 8;
const OFSTRUCT_PATH_MAX = 128;

/** OpenFile's uStyle bits, and its failure value. */
const OF_WRITE = 0x0001;
const OF_READWRITE = 0x0002;
const OF_CREATE = 0x1000;
const OF_DELETE = 0x0200;
const OF_EXIST = 0x4000;
const HFILE_ERROR = 0xffffffff;

/** MoveFileEx's flags: the two an installer actually passes. */
const MOVEFILE_REPLACE_EXISTING = 0x0001;
const MOVEFILE_DELAY_UNTIL_REBOOT = 0x0004;

/** How much of a file to move at a time when copying one. */
const COPY_CHUNK = 1 << 20;

/**
 * What GetTempPathA answers. Windows derives it from the environment; there is
 * one process and no environment block worth consulting, so one directory is
 * chosen and always the same one. The trailing separator is part of the
 * contract -- callers concatenate a file name onto it directly.
 */
const TEMP_PATH = 'C:\\WINDOWS\\TEMP\\';
/** The two system directories a search with no path of its own ends in. */
const WINDOWS_DIRECTORY = 'C:\\WINDOWS';
const SYSTEM_DIRECTORY = 'C:\\WINDOWS\\system32';
const PROGRAM_FILES = 'C:\\Program Files';

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
 * @property {number} [modified]  Milliseconds since the epoch; absent means unknown.
 */

/**
 * @typedef {Object} DirectoryEntry
 * @property {string} name
 * @property {boolean} isDirectory
 * @property {number} size
 * @property {number} [modified]  Milliseconds since the epoch; absent means unknown.
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
 * @property {(node: any, offset: number, length: number) => Uint8Array | Promise<Uint8Array>} read
 *           Short at the end of the file; empty past it, which is not an error.
 *           A promise when the bytes are not resident yet -- see ReadFile.
 * @property {(node: any, offset: number, bytes: Uint8Array) => number} write
 * @property {(node: any, size: number) => void} truncate
 * @property {(node: any) => void} close
 * @property {(path: string) => boolean} remove
 * @property {(path: string, modified: number) => boolean} [setModified]
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
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {FileSystem} files
 * @property {(code: number) => void} setLastError
 * @property {(handle: number, text: string) => void} writeConsole
 *           Where a write to a standard handle goes instead of the filesystem.
 * @property {{ open: (type: string, object: any) => number,
 *              resolve: (handle: number, type?: string) => any,
 *              close: (handle: number) => any,
 *              typeOf?: (handle: number) => string | undefined }} handles
 *           The one handle table, shared with every other kind of object.
 * @property {() => any} [currentThread]
 *           Whose call this is, for an answer that arrives after the thread has
 *           been parked -- by then the running thread is somebody else.
 * @property {(thread: any, code: number) => void} [setLastErrorFor]
 * @property {{ offsetOf: (overlapped: number) => number,
 *              completed: (file: number, transferred: number, overlapped: number) => boolean,
 *              closed: (handle: number, object: any) => void }} [ports]
 *           Completion ports. Absent, overlapped I/O still reads and writes;
 *           what it does not do is tell anyone it finished.
 * @property {() => string} [imagePath]
 *           The running program, whose directory is the first place a search
 *           with no path of its own looks. Absent, the search starts at the
 *           current directory.
 * @property {{ forget: (object: any) => void }} [namedObjects]
 *           Told when a handle closes, so a named mutex, event, semaphore,
 *           timer or file mapping can free its name once nothing holds it any
 *           more. Absent, a name is never freed -- the same as never closing
 *           the object, which is what the calls this table serves already do
 *           when there is nothing to tell.
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

    // A machine has these directories before any program runs: GetTempPath
    // and GetSystemDirectory promise them, the registry names the program
    // directories, and an installer's first act is to create its scratch
    // file in one and its last to move a shared library into another. A
    // promise of a directory that is not there fails that create or move
    // with "access denied", which is the wrong answer to a question the
    // program never asked.
    for (const path of [WINDOWS_DIRECTORY, TEMP_PATH.slice(0, -1), SYSTEM_DIRECTORY,
        PROGRAM_FILES, `${PROGRAM_FILES}\\Common Files`])
    {
        try
        {
            if (!files.stat(path)?.exists)
            {
                files.mkdir(path);
            }
        }
        catch (e){
            // A volume that cannot make a directory -- a build assembled
            // without one -- has no directory to promise, and nothing to do
            // about it here.
            void e;
        }
    }

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
        const written = driveRelative(name.replace(/\//g, '\\'));
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

    /**
     * A path that names a drive without a separator -- "C:" or "C:WINDOWS" --
     * is relative to that drive's own current directory, which Windows keeps
     * per drive. A drive the process has never been on has its root for one;
     * the drive it is on has the directory it is in, so "C:" alone is where
     * the process already stands. A caller walking up a path it means to
     * create ends that walk here, and a refusal of it reads as "the whole
     * path is invalid" rather than "the last piece is not there yet".
     *
     * @param {string} path
     */
    const driveRelative = path=>{
        const drive = /^([A-Za-z]:)(?!\\)/.exec(path);
        if (drive === null)
        {
            return path;
        }
        const rest = path.slice(2);
        const current = files.currentDirectory();
        const base = current.slice(0, 2).toLowerCase() === drive[1].toLowerCase()
            ? current
            : drive[1] + '\\';
        if (rest === '')
        {
            return base;
        }
        return base.endsWith('\\') ? base + rest : base + '\\' + rest;
    };

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
        // One time for all three: the volume records when a file was last
        // written and nothing else, and a program comparing dates compares
        // the write time.
        const time = msToFileTime(entry.modified ?? 0);
        view.setBigUint64(WIN32_FIND_DATAA.ftCreationTime, time, true);
        view.setBigUint64(WIN32_FIND_DATAA.ftLastAccessTime, time, true);
        view.setBigUint64(WIN32_FIND_DATAA.ftLastWriteTime, time, true);
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

    /**
     * WIN32_FIND_DATAW: the same fields as the ANSI form, with both names twice
     * as wide. Everything up to cFileName sits at the same offset in both, which
     * is exactly why the tail is easy to get wrong -- a reader that shares the
     * offsets and forgets the widths writes the second name over the first.
     */
    const WIN32_FIND_DATAW = Object.freeze({
        ...WIN32_FIND_DATAA,
        cAlternateFileName: 564,
        SIZE: 592,
    });

    /** @param {string} text @returns {Uint8Array} UTF-16, with no terminator. */
    const utf16 = text=>{
        const bytes = new Uint8Array(text.length * 2);
        for (let at = 0; at < text.length; at++)
        {
            const code = text.charCodeAt(at);
            bytes[at * 2] = code & 0xff;
            bytes[at * 2 + 1] = code >> 8;
        }
        return bytes;
    };

    /**
     * The wide twin of writeStringTo. The two-call protocol is counted in
     * characters in both forms -- a caller passing a character count and reading
     * one back never sees the byte width -- so only the writing differs.
     *
     * @param {number} buffer @param {number} size @param {string} text
     */
    const writeWideStringTo = (buffer, size, text)=>{
        if (buffer === 0 || text.length + 1 > (size >>> 0))
        {
            return text.length + 1;
        }
        host.writeMemory(buffer, utf16(text + String.fromCharCode(0)));
        return text.length;
    };

    /** @param {number} address @param {DirectoryEntry} entry */
    const writeWideFindData = (address, entry)=>{
        const data = new Uint8Array(WIN32_FIND_DATAW.SIZE);
        const view = new DataView(data.buffer);
        view.setUint32(WIN32_FIND_DATAW.dwFileAttributes, attributesOf(entry), true);
        const time = msToFileTime(entry.modified ?? 0);
        view.setBigUint64(WIN32_FIND_DATAW.ftCreationTime, time, true);
        view.setBigUint64(WIN32_FIND_DATAW.ftLastAccessTime, time, true);
        view.setBigUint64(WIN32_FIND_DATAW.ftLastWriteTime, time, true);
        const size = entry.size ?? 0;
        view.setUint32(WIN32_FIND_DATAW.nFileSizeHigh, high(size), true);
        view.setUint32(WIN32_FIND_DATAW.nFileSizeLow, low(size), true);
        data.set(utf16(entry.name.slice(0, MAX_PATH - 1)), WIN32_FIND_DATAW.cFileName);
        host.writeMemory(address, data);
    };

    /**
     * How text arrives and leaves, which is the whole of the difference between
     * an ANSI entry point and its wide twin.
     *
     * Every operation below is written once, over resolved strings, and appears
     * twice in the table with one of these two bound to it. Writing the pair
     * separately is how a file comes to open one way and not the other.
     *
     * @typedef {Object} TextForm
     * @property {(pointer: number) => string} path
     * @property {(pointer: number) => string} raw
     *           What the caller actually wrote, before resolution. One function
     *           needs it: GetFullPathName keeps a trailing separator the caller
     *           put there, and resolution is what takes it off.
     * @property {(pointer: number) => string} list
     *           A path list, which runs longer than any one path.
     * @property {(buffer: number, size: number, text: string) => number} write
     * @property {(address: number, entry: DirectoryEntry) => void} findData
     * @property {number} unit  Bytes per character, for pointer arithmetic.
     */

    /** @type {TextForm} */
    const ANSI = {
        path: pathArgument,
        raw: pointer=>pointer === 0 ? '' : host.readCString(pointer >>> 0, MAX_PATH),
        list: pointer=>host.readCString(pointer >>> 0, MAX_PATH_LIST),
        write: writeStringTo,
        findData: writeFindData,
        unit: 1,
    };

    /** @type {TextForm} */
    const WIDE = {
        path: pointer=>fullPath(
            pointer === 0 ? '' : host.readWideString(pointer >>> 0, MAX_PATH)),
        raw: pointer=>pointer === 0 ? '' : host.readWideString(pointer >>> 0, MAX_PATH),
        list: pointer=>host.readWideString(pointer >>> 0, MAX_PATH_LIST),
        write: writeWideStringTo,
        findData: writeWideFindData,
        unit: 2,
    };

    /**
     * One operation, both spellings.
     *
     * @param {number} argBytes
     * @param {(args: number[], text: TextForm) => any} body
     */
    const bothForms = (argBytes, body)=>({
        ansi: { argBytes, handler: (/** @type {number[]} */ args)=>body(args, ANSI) },
        wide: { argBytes, handler: (/** @type {number[]} */ args)=>body(args, WIDE) },
    });

    const deleteFile = bothForms(4, ([name], text)=>{
        const path = text.path(name);
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
    });

    /**
     * The move both spellings and the extended form share.
     *
     * @param {string} source @param {string} destination @param {boolean} replace
     */
    const renamePath = (source, destination, replace)=>{
        if (!files.stat(source)?.exists)
        {
            return fail(missing(source));
        }
        if (files.stat(destination)?.exists)
        {
            if (!replace)
            {
                return fail(ERROR_ALREADY_EXISTS);
            }
            if (!files.remove(destination))
            {
                return fail(ERROR_ACCESS_DENIED);
            }
        }
        return files.rename(source, destination) ? 1 : fail(ERROR_ACCESS_DENIED);
    };

    /**
     * Where the next generated temporary name starts looking.
     *
     * Counted rather than randomised, as Windows does, and kept across calls so
     * that a caller asking twice in a row is not handed the same name twice --
     * which is the whole reason it asks.
     */
    let nextTempNumber = 1;

    const moveFile = bothForms(8, ([from, to], text)=>
        renamePath(text.path(from), text.path(to), false));

    /**
     * The move an installer makes when it puts an unpacked file in its
     * final place. MOVEFILE_REPLACE_EXISTING is the flag that matters: a
     * second install over the first replaces rather than failing, and
     * without honouring it the second run stops on the first file it
     * already wrote.
     *
     * MOVEFILE_DELAY_UNTIL_REBOOT names a file to move when the machine
     * next starts. There is no next start here, so it is refused rather
     * than accepted and forgotten -- a caller told it succeeded would
     * believe a file it still needs has been scheduled.
     */
    const moveFileEx = bothForms(12, ([from, to, flags], text)=>{
        if ((flags >>> 0 & MOVEFILE_DELAY_UNTIL_REBOOT) !== 0)
        {
            return fail(ERROR_NOT_SUPPORTED);
        }
        return renamePath(text.path(from), text.path(to),
            (flags >>> 0 & MOVEFILE_REPLACE_EXISTING) !== 0);
    });

    /** @param {number[]} args @param {TextForm} text */
    const searchPathBody = ([pathList, fileName, extension, size, buffer, filePart], text)=>{
        let name = text.raw(fileName);
        if (name === '')
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const bare = name.slice(
            Math.max(name.lastIndexOf(SEPARATOR), name.lastIndexOf('/')) + 1);
        if ((extension >>> 0) !== 0 && !bare.includes('.'))
        {
            name += text.raw(extension);
        }
        const qualified = /^[A-Za-z]:|^[\\/]/.test(name)
            || name.includes(SEPARATOR) || name.includes('/');
        const directories = qualified
            ? ['']
            : (pathList >>> 0) !== 0
                ? text.list(pathList).split(';')
                : [parentOf(host.imagePath?.() ?? ''), files.currentDirectory(),
                    SYSTEM_DIRECTORY, WINDOWS_DIRECTORY];
        for (const directory of directories)
        {
            const candidate = fullPath(directory === ''
                ? name
                : `${directory.replace(/[\\/]$/, '')}${SEPARATOR}${name}`);
            const entry = files.stat(candidate);
            if (!entry?.exists || entry.isDirectory)
            {
                continue;
            }
            const written = text.write(buffer >>> 0, size, candidate);
            if (written === candidate.length)
            {
                writeDwordIf(filePart >>> 0,
                    (buffer >>> 0) + (candidate.lastIndexOf(SEPARATOR) + 1) * text.unit);
            }
            return written;
        }
        return fail(ERROR_FILE_NOT_FOUND);
    };
    const searchPath = bothForms(24, searchPathBody);

    const createDirectory = bothForms(8, ([name], text)=>{
        const path = text.path(name);
        if (files.stat(path)?.exists)
        {
            return fail(ERROR_ALREADY_EXISTS);
        }
        // Only one level at a time, as Windows does: a missing parent is a
        // failure, not something to create on the way past.
        return files.mkdir(path) ? 1 : fail(ERROR_PATH_NOT_FOUND);
    });

    const removeDirectory = bothForms(4, ([name], text)=>{
        const path = text.path(name);
        const entry = files.stat(path);
        if (!entry || !entry.exists)
        {
            return fail(missing(path));
        }
        if (!entry.isDirectory)
        {
            return fail(ERROR_DIRECTORY);
        }
        return files.remove(path) ? 1 : fail(ERROR_DIR_NOT_EMPTY);
    });

    const getFileAttributes = bothForms(4, ([name], text)=>{
        const path = text.path(name);
        const entry = files.stat(path);
        if (!entry || !entry.exists)
        {
            return fail(missing(path), INVALID_FILE_ATTRIBUTES);
        }
        return attributesOf(entry);
    });

    const setFileAttributes = bothForms(8, ([name], text)=>{
        const path = text.path(name);
        return files.stat(path)?.exists ? 1 : fail(missing(path));
    });

    const setCurrentDirectory = bothForms(4, ([name], text)=>{
        const path = text.path(name);
        const entry = files.stat(path);
        if (!entry || !entry.exists || !entry.isDirectory)
        {
            return fail(ERROR_PATH_NOT_FOUND);
        }
        files.setCurrentDirectory(path);
        return 1;
    });

    const getCurrentDirectory = bothForms(8, ([size, buffer], text)=>
        text.write(buffer >>> 0, size, files.currentDirectory()));

    const getFullPathName = bothForms(16, ([name, size, buffer, filePart], text)=>{
        const asked = text.raw(name);
        if (asked === '')
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const resolved = text.path(name);
        // A caller that wrote a trailing separator meant a directory and gets
        // one back; resolution is what removed it. The file part is NULL for
        // exactly that case, which is how the caller tells the two apart.
        const trailing = (asked.endsWith(SEPARATOR) || asked.endsWith('/'))
            && !resolved.endsWith(SEPARATOR);
        const written = trailing ? resolved + SEPARATOR : resolved;

        const result = text.write(buffer >>> 0, size, written);
        if (result === written.length)
        {
            const at = written.lastIndexOf(SEPARATOR);
            // Into the caller's own buffer, so the offset is in characters
            // scaled by however wide one is.
            writeDwordIf(filePart >>> 0, written.endsWith(SEPARATOR)
                ? 0
                : (buffer >>> 0) + (at + 1) * text.unit);
        }
        return result;
    });

    /**
     * GetLongPathName, which has nothing to lengthen.
     *
     * Short 8.3 names are a FAT artefact and nothing here produces them, so
     * every path is already its long form. Windows still requires the path to
     * exist, and a caller uses the failure to test exactly that.
     */
    const getLongPathName = bothForms(12, ([name, buffer, size], text)=>{
        const path = text.path(name);
        if (!files.stat(path)?.exists)
        {
            return fail(missing(path));
        }
        return text.write(buffer >>> 0, size, path);
    });

    const findFirstFile = bothForms(8, ([name, data], text)=>{
        const path = text.path(name);
        if (path === '')
        {
            return fail(ERROR_PATH_NOT_FOUND, INVALID_HANDLE_VALUE);
        }
        const directory = parentOf(path);
        const pattern = path.slice(directory.endsWith(SEPARATOR)
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
            return fail(ERROR_FILE_NOT_FOUND, INVALID_HANDLE_VALUE);
        }
        text.findData(data >>> 0, entries[0]);
        host.setLastError(ERROR_SUCCESS);
        return host.handles.open('find', { entries, index: 1 });
    });

    /**
     * CreateFile, in terms of a resolved path, so both spellings open the same
     * file. Sharing, security and the template are accepted and ignored: there
     * is one process, no security descriptor to check against, and no attribute
     * of a template file we could copy. A request Windows would refuse for want
     * of a share mode succeeds here.
     */
    const createFile = bothForms(28, ([name, access, , , disposition], text)=>{
        const path = text.path(name);
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
    });

    const findNextFile = bothForms(8, ([handle, data], text)=>{
        const search = object(handle, 'find');
        if (!search)
        {
            return fail(ERROR_INVALID_HANDLE);
        }
        if (search.index >= search.entries.length)
        {
            return fail(ERROR_NO_MORE_FILES);
        }
        text.findData(data >>> 0, search.entries[search.index]);
        search.index++;
        return 1;
    });

    return {
        /**
         * HANDLE CreateFile(LPCSTR, DWORD dwDesiredAccess, DWORD dwShareMode,
         *   LPSECURITY_ATTRIBUTES, DWORD dwCreationDisposition,
         *   DWORD dwFlagsAndAttributes, HANDLE hTemplateFile)
         *
         * One body, both spellings.
         */
        CreateFileA: createFile.ansi,
        CreateFileW: createFile.wide,

        /**
         * BOOL ReadFile(HANDLE, LPVOID, DWORD, LPDWORD lpNumberOfBytesRead,
         *               LPOVERLAPPED)
         *
         * Every read here finishes before the call answers, so an overlapped
         * read is a synchronous one that also completes: the position comes out
         * of the OVERLAPPED rather than the file pointer, and when it is done
         * the structure, its event and the handle's completion port are all told.
         * Leaving that last part out is invisible until something waits for it,
         * and then it is a pool parked for ever on a packet nobody posts.
         *
         * Reading a standard handle is an immediate end of input rather than a
         * failure -- there is no console to type at, and a program that asks
         * gets the answer it would get from a redirected empty stream.
         */
        ReadFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, read, overlapped])=>{
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
                const pointer = overlapped >>> 0;
                const at = pointer !== 0 && host.ports
                    ? host.ports.offsetOf(pointer)
                    : file.position;
                /** @param {Uint8Array} bytes */
                const deliver = bytes=>{
                    if (bytes.length > 0)
                    {
                        host.writeMemory(buffer >>> 0, bytes);
                    }
                    file.position = at + bytes.length;
                    // Written even when nothing was read: a program that checks
                    // it is exactly the one that has reached the end of a file.
                    writeDwordIf(read >>> 0, bytes.length);
                    if (pointer !== 0)
                    {
                        host.ports?.completed(handle >>> 0, bytes.length, pointer);
                    }
                    return 1;
                };

                const bytes = files.read(file.node, at, length >>> 0);
                // A volume backed by a bundle answers with a promise when the
                // bytes are not here yet. The guest cannot wait, so the bridge
                // parks it -- the same way it does for any call that has no
                // answer at the moment it is asked.
                if (typeof (/** @type {any} */ (bytes))?.then !== 'function')
                {
                    return deliver(/** @type {any} */ (bytes));
                }
                const owner = host.currentThread?.() ?? null;
                return /** @type {any} */ (bytes).then(deliver, ()=>{
                    // A read that fails once the thread is parked answers FALSE
                    // long after the error slot was last written, and whatever
                    // is in it belongs to some other call. A caller reading a
                    // stale code acts on a failure that did not happen -- and
                    // no completion is posted either, because none was accepted.
                    host.setLastErrorFor?.(owner, ERROR_IO_DEVICE);
                    return 0;
                });
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
            handler: ([handle, buffer, length, written, overlapped])=>{
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
                const pointer = overlapped >>> 0;
                const at = pointer !== 0 && host.ports
                    ? host.ports.offsetOf(pointer)
                    : file.position;
                const stored = files.write(file.node, at, bytes);
                file.position = at + stored;
                // Written even for a zero-length write, which is how a program
                // asks whether the handle still works.
                writeDwordIf(written >>> 0, stored);
                // The same debt an overlapped read owes: a save written through
                // a pool hangs if the packet its worker waits on never arrives.
                if (pointer !== 0)
                {
                    host.ports?.completed(handle >>> 0, stored, pointer);
                }
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
                    // A file handle and a mapping over the file each hold
                    // the node, and closing either gives back its own hold:
                    // the node closes with the last of them, in whichever
                    // order the program closes them.
                    const type = host.handles.typeOf?.(handle >>> 0);
                    const closed = host.handles.close(handle >>> 0);
                    if (closed && closed.node
                        && (type === undefined || type === 'file' || type === 'mapping'))
                    {
                        files.close(closed.node);
                    }
                    // A no-op on anything that was never named.
                    host.namedObjects?.forget(closed);
                    // Handle numbers are recycled, so anything keyed by this one
                    // has to go now: a completion-port association that outlives
                    // its handle sends the next file's packets to a port nobody
                    // is reading, and a thread parked on a port that has just
                    // closed waits on something nothing can reach.
                    host.ports?.closed(handle >>> 0, closed);
                    return 1;
                }
                catch (e){
                    void e;
                    return fail(ERROR_INVALID_HANDLE);
                }
            },
        },

        /** BOOL DeleteFile(LPCSTR) -- one body, both spellings. */
        DeleteFileA: deleteFile.ansi,
        DeleteFileW: deleteFile.wide,

        /** BOOL MoveFile(LPCSTR lpExistingFileName, LPCSTR lpNewFileName) -- one body, both spellings. */
        MoveFileA: moveFile.ansi,
        MoveFileW: moveFile.wide,

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
                    const chunk = files.read(input, at, COPY_CHUNK);
                    if (typeof (/** @type {any} */ (chunk))?.then === 'function')
                    {
                        // A copy that would have to wait is not expressible
                        // here: the call is one operation to the guest and has
                        // no partial answer. Copying from a bundle-backed file
                        // needs the same treatment ReadFile got, and until then
                        // failing is better than silently truncating.
                        files.close(input);
                        files.close(output);
                        return fail(ERROR_ACCESS_DENIED);
                    }
                    files.write(output, at, /** @type {any} */ (chunk));
                }
                files.close(input);
                files.close(output);
                return 1;
            },
        },

        /** BOOL CreateDirectory(LPCSTR, LPSECURITY_ATTRIBUTES) -- one body, both spellings. */
        CreateDirectoryA: createDirectory.ansi,
        CreateDirectoryW: createDirectory.wide,

        /** BOOL RemoveDirectory(LPCSTR) -- one body, both spellings. */
        RemoveDirectoryA: removeDirectory.ansi,
        RemoveDirectoryW: removeDirectory.wide,

        /** DWORD GetFileAttributes(LPCSTR) -- one body, both spellings. */
        GetFileAttributesA: getFileAttributes.ansi,
        GetFileAttributesW: getFileAttributes.wide,

        /** BOOL SetFileAttributes(LPCSTR, DWORD dwFileAttributes) -- one body, both spellings. */
        SetFileAttributesA: setFileAttributes.ansi,
        SetFileAttributesW: setFileAttributes.wide,

        /**
         * DWORD SearchPathA(LPCSTR lpPath, LPCSTR lpFileName, LPCSTR lpExtension,
         *                   DWORD nBufferLength, LPSTR lpBuffer, LPSTR *lpFilePart)
         *
         * A path list given is searched, separated by semicolons; none given
         * is the documented order -- the program's directory, the current
         * one, the system and Windows directories. The extension is added
         * only to a name that has none of its own, and a name already
         * qualified with a directory is looked for where it says. The answer
         * is shaped as GetFullPathName's: the length written, the size
         * needed when the buffer is short, zero and ERROR_FILE_NOT_FOUND when
         * nothing is there.
         */
        SearchPathA: searchPath.ansi,
        SearchPathW: searchPath.wide,

        /** DWORD GetFullPathName(LPCSTR, DWORD, LPSTR, LPSTR *lpFilePart) -- one body, both spellings. */
        GetFullPathNameA: getFullPathName.ansi,
        GetFullPathNameW: getFullPathName.wide,

        /** DWORD GetCurrentDirectory(DWORD nBufferLength, LPSTR lpBuffer) -- one body, both spellings. */
        GetCurrentDirectoryA: getCurrentDirectory.ansi,
        GetCurrentDirectoryW: getCurrentDirectory.wide,

        /** BOOL SetCurrentDirectory(LPCSTR) -- one body, both spellings. */
        SetCurrentDirectoryA: setCurrentDirectory.ansi,
        SetCurrentDirectoryW: setCurrentDirectory.wide,

        /** DWORD GetTempPathA(DWORD nBufferLength, LPSTR lpBuffer) */
        GetTempPathA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, buffer])=>writeStringTo(buffer >>> 0, size, TEMP_PATH),
        },

        /**
         * UINT GetTempFileNameA(LPCSTR lpPathName, LPCSTR lpPrefixString,
         *                      UINT uUnique, LPSTR lpTempFileName)
         *
         * The name a self-extractor unpacks itself into. Two behaviours here
         * are the program's contract rather than detail, and both are silent
         * when wrong:
         *
         * - **A zero uUnique creates the file.** That is how the caller
         *   reserves the name against anyone else taking it, and a program
         *   that then opens it for writing expects it to exist. With a
         *   non-zero uUnique nothing is created and the name is simply built.
         * - **The number is returned as well as written.** A caller keeps it
         *   to build the next name in a series without asking again.
         *
         * The prefix contributes at most three characters, as Windows does,
         * because the whole name has to fit an 8.3 form.
         */
        GetTempFileNameA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([directory, prefix, unique, out])=>{
                const folder = (directory >>> 0) === 0
                    ? TEMP_PATH
                    : pathArgument(directory);
                const stem = ((prefix >>> 0) === 0
                    ? ''
                    : host.readCString(prefix >>> 0, MAX_PATH)).slice(0, 3);
                const base = folder.endsWith(SEPARATOR) ? folder : folder + SEPARATOR;

                let number = unique >>> 0;
                let path = '';
                if (number !== 0)
                {
                    path = `${base}${stem}${(number & 0xffff).toString(16)}.TMP`;
                }
                else
                {
                    // A name nothing holds. Windows counts rather than
                    // randomises, and a caller that asks twice must not be
                    // handed the same name -- so the file is created here,
                    // which is what makes the second search skip it.
                    for (number = nextTempNumber; number <= 0xffff; number++)
                    {
                        const candidate = `${base}${stem}${number.toString(16)}.TMP`;
                        const entry = files.stat(candidate);
                        if (!entry || !entry.exists)
                        {
                            path = candidate;
                            break;
                        }
                    }
                    if (path === '')
                    {
                        return fail(ERROR_ACCESS_DENIED, 0);
                    }
                    nextTempNumber = number + 1;
                    const node = files.open(path,
                        { read: true, write: true, create: true, truncate: true });
                    if (!node)
                    {
                        return fail(ERROR_ACCESS_DENIED, 0);
                    }
                    // Created and closed: the name is reserved by the file's
                    // existence, not by holding it open. Held, the caller's own
                    // open of the name it was just given would be refused as
                    // shared with nobody.
                    files.close(node);
                }

                if ((out >>> 0) !== 0)
                {
                    const bytes = latin1(path.slice(0, MAX_PATH - 1));
                    const buffer = new Uint8Array(bytes.length + 1);
                    buffer.set(bytes);
                    host.writeMemory(out >>> 0, buffer);
                }
                host.setLastError(ERROR_SUCCESS);
                return number & 0xffff;
            },
        },

        /**
         * BOOL MoveFileEx(LPCSTR lpExistingFileName, LPCSTR lpNewFileName,
         *                 DWORD dwFlags) -- one body, both spellings.
         */
        MoveFileExA: moveFileEx.ansi,
        MoveFileExW: moveFileEx.wide,

        /** HANDLE FindFirstFile(LPCSTR, LPWIN32_FIND_DATA) -- one body, both spellings. */
        FindFirstFileA: findFirstFile.ansi,
        FindFirstFileW: findFirstFile.wide,

        /** BOOL FindNextFile(HANDLE, LPWIN32_FIND_DATA) -- one body, both spellings. */
        FindNextFileA: findNextFile.ansi,
        FindNextFileW: findNextFile.wide,

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

        /** DWORD GetLongPathName(LPCSTR, LPSTR, DWORD) -- one body, both spellings. */
        GetLongPathNameA: getLongPathName.ansi,
        GetLongPathNameW: getLongPathName.wide,

        /**
         * DWORD GetShortPathNameA(LPCSTR, LPSTR, DWORD)
         *
         * This volume keeps no 8.3 aliases, so a name's short form is the name
         * itself: a program that reopens the file by what it is handed finds
         * it, and only one that counts on the dotted-eight shape sees a
         * difference.
         */
        GetShortPathNameA: getLongPathName.ansi,

        /**
         * HFILE OpenFile(LPCSTR lpFileName, LPOFSTRUCT lpReOpenBuff, UINT uStyle)
         *
         * The 16-bit call that predates CreateFile, still linked against by
         * runtimes of this era. It is expressed in terms of CreateFile rather
         * than reimplemented, because the two differing about whether a file
         * exists would be worse than either being wrong.
         *
         * OF_EXIST is the reason it is worth having at all: a caller uses it to
         * test for a file without opening one, and gets back a boolean-ish
         * result rather than a handle it would have to close.
         */
        OpenFile: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, reopen, style])=>{
                const path = pathArgument(name);
                const entry = files.stat(path);
                const flags = style >>> 0;
                const exists = Boolean(entry && entry.exists);

                if (reopen !== 0)
                {
                    // OFSTRUCT: cBytes, fFixedDisk, nErrCode, two reserved
                    // words, then the path as eight-bit text. A caller reads the
                    // path back out of it, so it is filled even on failure.
                    const data = new Uint8Array(OFSTRUCT_SIZE);
                    data[0] = OFSTRUCT_SIZE;
                    data[1] = 1;
                    data.set(latin1(path.slice(0, OFSTRUCT_PATH_MAX - 1)), OFSTRUCT_PATH);
                    host.writeMemory(reopen >>> 0, data);
                }

                if ((flags & OF_EXIST) !== 0)
                {
                    return exists ? 1 : fail(missing(path), HFILE_ERROR);
                }
                if ((flags & OF_DELETE) !== 0)
                {
                    if (!exists)
                    {
                        return fail(missing(path), HFILE_ERROR);
                    }
                    return files.remove(path) ? 1 : fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
                }

                const write = (flags & (OF_WRITE | OF_READWRITE)) !== 0;
                const create = (flags & OF_CREATE) !== 0;
                if (!exists && !create)
                {
                    return fail(missing(path), HFILE_ERROR);
                }
                const node = files.open(path,
                    { read: !write, write, create, truncate: create });
                if (!node)
                {
                    return fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
                }
                host.setLastError(ERROR_SUCCESS);
                return host.handles.open('file',
                    { path, node, read: !write, write, position: 0 });
            },
        },

        /**
         * BOOL LockFile(HANDLE, DWORD, DWORD, DWORD, DWORD)
         *
         * There is one process, so a byte range nobody else can reach is a range
         * already locked. Succeeding is not a pretence: the guarantee the caller
         * asked for -- that nothing else writes here meanwhile -- holds.
         */
        /**
         * The file family a sixteen-bit program was written against, which an
         * installer of this era is: a self-extractor writes its payload to a
         * temporary directory with these and not with CreateFile.
         *
         * They are the same files and the same handles as everything else here
         * -- an HFILE is a HANDLE, and Windows lets one be passed where the
         * other is expected. Keeping two kinds would mean a program that opens
         * with `_lopen` and closes with `CloseHandle` leaks, and programs do
         * exactly that.
         *
         * HFILE _lopen(LPCSTR lpPathName, int iReadWrite)
         */
        _lopen: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, mode])=>{
                const path = pathArgument(name);
                const write = (mode & OF_READWRITE) !== 0 || (mode & OF_WRITE) !== 0;
                const entry = files.stat(path);
                if (!entry || !entry.exists)
                {
                    return fail(missing(path), HFILE_ERROR);
                }
                const node = files.open(path, { read: true, write, create: false });
                if (!node)
                {
                    return fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
                }
                host.setLastError(ERROR_SUCCESS);
                return host.handles.open('file', { path, node, read: true, write, position: 0 });
            },
        },

        /**
         * HFILE _lcreat(LPCSTR lpPathName, int iAttribute)
         *
         * Always creates and always truncates, which is the difference from
         * `_lopen`: a self-extractor calls this for every file it unpacks and
         * relies on a second pass finding an empty one rather than the tail of
         * the first.
         */
        _lcreat: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name])=>{
                const path = pathArgument(name);
                const node = files.open(path,
                    { read: true, write: true, create: true, truncate: true });
                if (!node)
                {
                    return fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
                }
                host.setLastError(ERROR_SUCCESS);
                return host.handles.open('file',
                    { path, node, read: true, write: true, position: 0 });
            },
        },

        /** UINT _lread(HFILE hFile, LPVOID lpBuffer, UINT uBytes) */
        _lread: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, buffer, count])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE, HFILE_ERROR);
                }
                const bytes = files.read(file.node, file.position, count >>> 0);
                // A bundle-backed volume can answer with a promise. This family
                // has no overlapped form and no way to say "later", so the
                // caller is parked exactly as the modern spelling parks it.
                const deliver = (/** @type {Uint8Array} */ data)=>{
                    host.writeMemory(buffer >>> 0, data);
                    file.position += data.length;
                    host.setLastError(ERROR_SUCCESS);
                    return data.length;
                };
                return typeof (/** @type {any} */ (bytes))?.then === 'function'
                    ? /** @type {any} */ (bytes).then(deliver)
                    : deliver(/** @type {any} */ (bytes));
            },
        },

        /** UINT _lwrite(HFILE hFile, LPCSTR lpBuffer, UINT uBytes) */
        _lwrite: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, buffer, count])=>{
                const file = object(handle, 'file');
                if (!file || !file.write)
                {
                    return fail(ERROR_INVALID_HANDLE, HFILE_ERROR);
                }
                const bytes = count === 0
                    ? new Uint8Array(0)
                    : host.readMemory(buffer >>> 0, count >>> 0).slice();
                const stored = files.write(file.node, file.position, bytes);
                file.position += stored;
                host.setLastError(ERROR_SUCCESS);
                return stored;
            },
        },

        /** LONG _llseek(HFILE hFile, LONG lOffset, int iOrigin) */
        _llseek: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, offset, origin])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE, HFILE_ERROR);
                }
                // The origins are the same three values SetFilePointer uses,
                // and the offset is signed: seeking backwards from the end is
                // how a program reads a trailer.
                const position = seek(file, offset | 0, origin >>> 0);
                if (position === null)
                {
                    return fail(ERROR_NEGATIVE_SEEK, HFILE_ERROR);
                }
                file.position = position;
                host.setLastError(ERROR_SUCCESS);
                return position;
            },
        },

        /**
         * HFILE _lclose(HFILE hFile)
         *
         * Zero for success, which is the opposite of CloseHandle's convention
         * and the kind of difference that is silent when got wrong: a caller
         * that checks for zero would see every close as a failure.
         *
         * The volume is told, as CloseHandle tells it. A handle closed without
         * its file stays open underneath with its sharing terms, and the next
         * open of the same name for writing -- which is exactly what follows a
         * create-and-close -- is refused as shared with nobody.
         */
        _lclose: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                try
                {
                    // A file handle and a mapping over the file each hold
                    // the node, and closing either gives back its own hold:
                    // the node closes with the last of them, in whichever
                    // order the program closes them.
                    const type = host.handles.typeOf?.(handle >>> 0);
                    const closed = host.handles.close(handle >>> 0);
                    if (closed && closed.node
                        && (type === undefined || type === 'file' || type === 'mapping'))
                    {
                        files.close(closed.node);
                    }
                    host.namedObjects?.forget(closed);
                    host.setLastError(ERROR_SUCCESS);
                    return 0;
                }
                catch (e){
                    void e;
                    return fail(ERROR_INVALID_HANDLE, HFILE_ERROR);
                }
            },
        },

        LockFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle])=>object(handle, 'file') ? 1 : fail(ERROR_INVALID_HANDLE),
        },

        /** BOOL UnlockFile(HANDLE, DWORD, DWORD, DWORD, DWORD) */
        UnlockFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle])=>object(handle, 'file') ? 1 : fail(ERROR_INVALID_HANDLE),
        },

        /**
         * BOOL DeviceIoControl(HANDLE hDevice, DWORD dwIoControlCode, LPVOID lpInBuffer,
         *     DWORD nInBufferSize, LPVOID lpOutBuffer, DWORD nOutBufferSize,
         *     LPDWORD lpBytesReturned, LPOVERLAPPED lpOverlapped)
         *
         * No device here answers a control code: the volume is a file store,
         * not a driver. ERROR_INVALID_FUNCTION is what a driver says of a code
         * it does not handle, and a program asking a disk or a VxD for
         * something takes the documented no.
         */
        DeviceIoControl: {
            argBytes: 32,
            handler: ()=>fail(ERROR_INVALID_FUNCTION),
        },
    };
}
