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
import { fileAttributes, msToFileTime } from './filetime.js';
import { decodeAnsi, decodeOem, encodeAnsi, encodeOem } from './locale.js';
import { createCommFunctions } from './comm.js';
import { createResourceUpdates } from './resource-update.js';
import { readToTerminator } from '../common/scan-windows.js';

/** Codes this surface reports through the last-error slot. */
const ERROR_SUCCESS = 0;
const ERROR_INVALID_FUNCTION = 1;
const ERROR_FILE_NOT_FOUND = 2;
/** What CreateSymbolicLink answers a user who may not make links. */
const ERROR_PRIVILEGE_NOT_HELD = 1314;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
/** CreateFile's dwShareMode bit that lets another handle write the file too. */
const FILE_SHARE_WRITE = 0x2;
/** A buffer the call cannot read from, as NT answers a null one. */
const ERROR_INVALID_USER_BUFFER = 1784;
/** What NT answers a read into a null buffer. */
const ERROR_NOACCESS = 998;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NO_MORE_FILES = 18;
const ERROR_WRITE_PROTECT = 19;
const ERROR_FILE_EXISTS = 80;
const ERROR_INVALID_PARAMETER = 87;
/** The unit a FILE_SEGMENT_ELEMENT names: one page of the caller's memory. */
const PAGE_SIZE = 4096;
/** GetFileAttributesEx's one information level. */
const GET_FILE_EX_INFO_STANDARD = 0;
const WIN32_FILE_ATTRIBUTE_DATA_SIZE = 36;
const ERROR_NEGATIVE_SEEK = 131;
const ERROR_NOT_SUPPORTED = 50;
const ERROR_DIR_NOT_EMPTY = 145;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_SHARING_VIOLATION = 32;
const ERROR_LOCK_VIOLATION = 33;
const ERROR_NOT_LOCKED = 158;
const ERROR_INVALID_NAME = 123;
const ERROR_REQUEST_ABORTED = 1235;
const ERROR_DIRECTORY = 267;
const ERROR_IO_DEVICE = 1117;
const ERROR_HANDLE_EOF = 38;

/** Where an OVERLAPPED keeps its status, its count and its starting offset. */
const OVERLAPPED_INTERNAL = 0;
const OVERLAPPED_INTERNAL_HIGH = 4;
const OVERLAPPED_OFFSET = 8;

/** The failure value of each of the four APIs that has its own. */
const INVALID_HANDLE_VALUE = 0xffffffff;
const INVALID_SET_FILE_POINTER = 0xffffffff;
const INVALID_FILE_SIZE = 0xffffffff;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;

/**
 * The access rights we decode: the generic ones and the specific data rights
 * they stand for. A mask that names none of these opens the file for neither
 * reading nor writing, which is what Windows does for the query-only access of
 * zero and for DELETE alone.
 */
const FILE_READ_DATA = 0x0001;
const FILE_WRITE_DATA = 0x0002;
const FILE_APPEND_DATA = 0x0004;
const DELETE = 0x00010000;
const GENERIC_ALL = 0x10000000;
const GENERIC_WRITE = 0x40000000;
const GENERIC_READ = 0x80000000;

/** dwFlagsAndAttributes' flag that ends the file with its handle. */
const FILE_FLAG_DELETE_ON_CLOSE = 0x04000000;
const FILE_FLAG_OVERLAPPED = 0x40000000;

/** LockFileEx's flag for an exclusive lock; without it the lock is shared. */
const LOCKFILE_EXCLUSIVE_LOCK = 0x2;

/** NtCreateFile's CreateDisposition, and what IO_STATUS_BLOCK.Information reports. */
const FILE_SUPERSEDE = 0;
const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_OPEN_IF = 3;
const FILE_OVERWRITE = 4;
const FILE_OVERWRITE_IF = 5;
const FILE_SUPERSEDED = 0;
const FILE_OPENED = 1;
const FILE_CREATED = 2;
const FILE_OVERWRITTEN = 3;

/** NtCreateFile's CreateOptions this surface acts on. */
const FILE_DIRECTORY_FILE = 0x0001;
const FILE_NON_DIRECTORY_FILE = 0x0040;
const FILE_DELETE_ON_CLOSE = 0x1000;

/** The statuses the native opens answer with. */
const STATUS_SUCCESS = 0;
const STATUS_BUFFER_OVERFLOW = 0x80000005;
const STATUS_INVALID_INFO_CLASS = 0xc0000003;
const STATUS_INVALID_DEVICE_REQUEST = 0xc0000010;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
/** The FILE_INFORMATION_CLASS values NtQueryInformationFile answers. */
const FILE_STANDARD_INFORMATION = 5;
const FILE_NAME_INFORMATION = 9;
const FILE_POSITION_INFORMATION = 14;
const STATUS_UNSUCCESSFUL = 0xc0000001;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_ACCESS_DENIED = 0xc0000022;
const STATUS_OBJECT_NAME_INVALID = 0xc0000033;
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
const STATUS_OBJECT_NAME_COLLISION = 0xc0000035;
const STATUS_OBJECT_PATH_NOT_FOUND = 0xc000003a;
const STATUS_OBJECT_PATH_SYNTAX_BAD = 0xc000003b;
const STATUS_LOCK_NOT_GRANTED = 0xc0000055;
const STATUS_RANGE_NOT_LOCKED = 0xc000007e;
const STATUS_MEDIA_WRITE_PROTECTED = 0xc00000a2;
const STATUS_FILE_IS_A_DIRECTORY = 0xc00000ba;
const STATUS_NOT_A_DIRECTORY = 0xc0000103;
const STATUS_CANNOT_DELETE = 0xc0000121;

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
 * The attributes answered are `fileAttributes`'s, over what the volume records
 * of what SetFileAttributes and a creating call set. The ones a program may
 * set are these; the rest (directory, compressed, encrypted, reparse point)
 * say what a file is, and a request naming them sets nothing of them.
 */
const FILE_ATTRIBUTE_READONLY = 0x0001;
const FILE_ATTRIBUTE_ARCHIVE = 0x0020;
const FILE_ATTRIBUTE_NORMAL = 0x0080;
const SETTABLE_ATTRIBUTES = 0x0001 | 0x0002 | 0x0004 | 0x0020 | 0x0080 | 0x0100
    | 0x1000 | 0x2000;

/** The ANSI path limit, and the size of cFileName with it. */
const MAX_PATH = 260;
/** A search path list is many of them; longer is a pointer that is not a string. */
const MAX_PATH_LIST = 32767;
/** The longest path the wide spellings take, in characters. */
const MAX_WIDE_PATH = 32767;

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

/** FindFirstFileEx's levels, search operations and flags, as far as they go here. */
const FIND_EX_INFO_BASIC = 1;
const FIND_EX_SEARCH_LIMIT_TO_DIRECTORIES = 1;
const FIND_FIRST_EX_CASE_SENSITIVE = 0x1;
const FIND_FIRST_EX_LARGE_FETCH = 0x2;

/** MoveFileEx's flags: the two an installer actually passes. */
const MOVEFILE_REPLACE_EXISTING = 0x0001;
const MOVEFILE_DELAY_UNTIL_REBOOT = 0x0004;

/** How much of a file to move at a time when copying one. */
const COPY_CHUNK = 1 << 20;
/** CopyFileEx's flag for CopyFile's bFailIfExists. */
const COPY_FILE_FAIL_IF_EXISTS = 0x1;

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
 * @property {boolean} [readOnly]  On read-only media.
 * @property {boolean} [hidden]
 * @property {number} [attributes]  What a program set, when one did.
 */

/**
 * @typedef {Object} DirectoryEntry
 * @property {string} name
 * @property {boolean} isDirectory
 * @property {number} size
 * @property {number} [modified]  Milliseconds since the epoch; absent means unknown.
 * @property {boolean} [readOnly]
 * @property {boolean} [hidden]
 * @property {number} [attributes]
 */

/** The handle kinds that are file objects: what CancelIo takes. */
const FILE_OBJECTS = new Set(['file', 'directory', 'pipe-read', 'pipe-write']);

/**
 * @typedef {Object} OpenMode
 * @property {boolean} [read]
 * @property {boolean} [write]
 * @property {boolean} [create]        Make the file when it is not there.
 * @property {boolean} [truncate]      Discard whatever it already holds.
 * @property {boolean} [failIfExists]  Refuse rather than open an existing file.
 * @property {boolean} [shareWrite]    Another handle may write the file while this one is open.
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
 * @property {(node: any, offset: number, bytes: Uint8Array)
 *     => number | Promise<number>} [writeOrFetch]
 *           write, or a promise when the file must be copied up from blocks
 *           not resident yet -- see WriteFile.
 * @property {(node: any, size: number) => void} truncate
 * @property {(node: any) => void} close
 * @property {(path: string) => boolean} remove
 * @property {(path: string, modified: number) => boolean} [setModified]
 * @property {(path: string) => boolean} mkdir
 * @property {(from: string, to: string) => boolean} rename
 * @property {(path: string, pattern: string) => DirectoryEntry[]} list
 * @property {() => string} currentDirectory
 * @property {(path: string) => void} setCurrentDirectory
 * @property {(path: string) => boolean} [writeProtected]
 *           Whether the path is on read-only media, a disc.
 * @property {(path: string, attributes: number | null) => boolean} [setAttributes]
 *           Records the attributes a program set on a name; `null` forgets
 *           them. Absent, SetFileAttributes changes nothing a later call sees.
 */

/**
 * @typedef {Object} FileHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, length: number) => Uint8Array} [windowMemory]
 *           The guest's own bytes, not a copy, valid until the guest runs again:
 *           what a write hands a volume that keeps a copy of what it is given.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 *           `maxLength` in bytes, as the memory layer counts it: a wide path of
 *           MAX_PATH characters is twice that.
 * @property {FileSystem} files
 * @property {(code: number) => void} setLastError
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(record: { path: string, error: number, access: number, share: number,
 *     disposition: number, flags: number }) => void} [openRefused]  told of every open
 *     CreateFile or NtCreateFile refused, with the error and what was asked
 * @property {(handle: number, text: string) => void} writeConsole
 *           Where a write to a standard handle goes instead of the filesystem.
 * @property {{ open: (type: string, object: any) => number,
 *              resolve: (handle: number, type?: string) => any,
 *              close: (handle: number) => any,
 *              typeOf?: (handle: number) => string | undefined,
 *              holds?: (object: any) => boolean }} handles
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
 * @property {(thread: any, routine: number, args: number[]) => void} [queueApc]
 *           Queues a routine to a thread, to run at its next alertable wait:
 *           how ReadFileEx and WriteFileEx deliver their completion routines.
 * @property {string[]} [directories]
 *           The shell folders the configured Windows names (the registry's
 *           `shellFolderDirectories`), parents first, made at start beside the
 *           system's own. Absent, only the system's are made.
 * @property {() => string} [imagePath]
 *           The running program, whose directory is the first place a search
 *           with no path of its own looks. Absent, the search starts at the
 *           current directory.
 * @property {() => string[]} [systemLibraries]
 *           The libraries this build implements, by file name: each stands in
 *           the system folder as a file of its own, where a setup looks for it
 *           before loading it. Absent, the folder shows only what is on it.
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

/** When a library the system folder shows was made: Windows XP SP3's build. */
const SYSTEM_LIBRARY_TIME = Date.UTC(2008, 3, 14, 12);
/** The size such a library reports; nothing reads its bytes through the file. */
const SYSTEM_LIBRARY_SIZE = 0x10000;

/**
 * A volume on which the system folder also holds the libraries this build
 * implements, each by its own name, unless a file of that name is there.
 *
 * Only for the questions a setup asks before it loads one -- is it there, what
 * are its attributes, a search for its exact name (InstallShield's UseDLL looks
 * with FindFirstFile first). A search with a wildcard lists the folder as it
 * is, and the file cannot be read: what it holds is the engine's, not bytes
 * on a volume (decision A41). Opened to be written, it becomes a file on the
 * volume that the program writes -- a setup replacing it, as a DirectX setup
 * replaces what it finds older -- and a program that loads the name still gets
 * the engine's own: what a setup puts there is never in its way.
 *
 * @param {FileSystem} real @param {(() => string[]) | undefined} libraries
 * @returns {FileSystem}
 */
function withSystemLibraries(real, libraries){
    if (!libraries)
    {
        return real;
    }
    const folder = `${SYSTEM_DIRECTORY.toLowerCase()}\\`;
    /** @param {string} path @returns {string | null} the library's own spelling */
    const libraryAt = path=>{
        const lower = path.toLowerCase();
        if (!lower.startsWith(folder) || lower.indexOf('\\', folder.length) !== -1)
        {
            return null;
        }
        const name = lower.slice(folder.length);
        return libraries().find(each=>each.toLowerCase() === name) ?? null;
    };
    const entry = { exists: true, isDirectory: false, size: SYSTEM_LIBRARY_SIZE,
        modified: SYSTEM_LIBRARY_TIME };
    return Object.assign(Object.create(real), {
        /** @param {string} path */
        stat: path=>real.stat(path) ?? (libraryAt(path) ? { ...entry } : null),
        /** @param {string} path @param {any} options */
        open: (path, options)=>real.open(path, options)
            ?? (options?.write && !real.stat(path) && libraryAt(path)
                ? real.open(path, { ...options, create: true }) : null),
        /** @param {string} path @param {string} pattern */
        list: (path, pattern)=>{
            const found = real.list(path, pattern);
            const name = (found?.length ?? 0) === 0 && !/[*?]/.test(pattern ?? '')
                ? libraryAt(`${path.replace(/\\$/, '')}\\${pattern}`) : null;
            return name ? [{ ...entry, name }] : found;
        },
    });
}

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
    const files = withSystemLibraries(host.files, host.systemLibraries);

    // A machine has these directories before any program runs: GetTempPath
    // and GetSystemDirectory promise them, the registry names the program
    // directories and the profile's folders, and an installer's first act is
    // to create its scratch file in one and its last to move a shared library
    // into another. A promise of a directory that is not there fails that
    // create or move with "access denied", which is the wrong answer to a
    // question the program never asked. A driver's setup copies its .sys into
    // system32's drivers folder, which every installation has, the same way.
    for (const path of [WINDOWS_DIRECTORY, TEMP_PATH.slice(0, -1), SYSTEM_DIRECTORY,
        `${SYSTEM_DIRECTORY}\\drivers`, `${SYSTEM_DIRECTORY}\\drivers\\etc`, PROGRAM_FILES,
        `${PROGRAM_FILES}\\Common Files`, ...host.directories ?? []])
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

    /**
     * The end of a ReadFileEx or WriteFileEx: the OVERLAPPED says it finished
     * and how much moved, and the completion routine is queued to the thread
     * that asked.
     *
     * @param {any} thread @param {number} overlapped @param {number} routine
     * @param {number} transferred
     */
    const completeWith = (thread, overlapped, routine, transferred)=>{
        writeDword(overlapped + OVERLAPPED_INTERNAL, ERROR_SUCCESS);
        writeDword(overlapped + OVERLAPPED_INTERNAL_HIGH, transferred >>> 0);
        if ((routine >>> 0) !== 0)
        {
            host.queueApc?.(thread, routine >>> 0,
                [ERROR_SUCCESS, transferred >>> 0, overlapped >>> 0]);
        }
        return 1;
    };

    /**
     * Whether the ANSI spellings of the functions here read and write names in
     * the OEM page rather than the ANSI one: SetFileApisToOEM, which a console
     * program calls so the names it prints are in the page its console shows.
     */
    let fileApisOem = false;

    /** A name in the page the ANSI spellings use now. @param {string} text */
    const encodeName = text=>(fileApisOem ? encodeOem(text) : encodeAnsi(text));

    /**
     * A NUL-terminated name in the page the ANSI spellings use now, at most
     * `limit` bytes; read a window at a time, so one at the end of what the
     * program allocated is not read past.
     *
     * @param {number} address @param {number} limit
     */
    const readName = (address, limit)=>(fileApisOem
        ? decodeOem(readToTerminator(host, address, 1, limit).bytes)
        : host.readCString(address, limit));

    /**
     * The two-call protocol every path-returning function here shares: called
     * with a buffer too small (or none at all) it reports the size it needs
     * *including* the terminator, and having written it reports the length
     * *without* one. Callers switch on exactly that difference. The path goes
     * back in the ANSI page the memory layer read it in, so a name a program
     * gave comes back in its own bytes.
     *
     * @param {number} buffer @param {number} size @param {string} text
     * @returns {number} what the function returns
     */
    const writeStringTo = (buffer, size, text)=>{
        if (buffer === 0 || text.length + 1 > (size >>> 0))
        {
            return text.length + 1;
        }
        host.writeMemory(buffer, encodeName(text + '\0'));
        return text.length;
    };

    /**
     * A name longer than MAX_PATH is still a name: it is read to its end,
     * and then found or not as any other is.
     *
     * @param {number} pointer
     */
    const pathArgument = pointer=>fullPath(
        pointer === 0 ? '' : readName(pointer >>> 0, MAX_PATH_LIST));

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
        // The Win32 file namespace turns the parsing off: no slash is a
        // separator and no dot a step. The filesystem reads it so itself.
        if (name.startsWith('\\\\?\\'))
        {
            return name;
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
    const attributesOf = entry=>fileAttributes(entry);

    /**
     * Whether a change aimed at `path` lands on read-only media. A disc refuses
     * every write, create and delete as the device, before any name on it is
     * looked at, and says so with its own code rather than as a denied access:
     * an installer told the media is write-protected knows it is looking at
     * the disc it was started from.
     *
     * @param {string} path
     */
    const onReadOnlyMedia = path=>files.writeProtected?.(path) === true;

    /** The refusal of a change to `path`, when the volume did not make it. @param {string} path */
    const denied = path=>onReadOnlyMedia(path) ? ERROR_WRITE_PROTECT : ERROR_ACCESS_DENIED;

    /**
     * Whether a file carries the read-only attribute a program set. Such a
     * file refuses to be written, truncated or deleted by name with "access
     * denied" until the attribute is taken off; renaming it is allowed. A
     * directory's read-only bit is advice to the shell and refuses nothing.
     *
     * @param {FileStat | null | undefined} entry
     */
    const readOnlyFile = entry=>Boolean(entry?.exists && !entry.isDirectory
        && ((entry.attributes ?? 0) & FILE_ATTRIBUTE_READONLY) !== 0);

    /**
     * The attributes a creating call gives a new file: what it asked for,
     * archived as every new file is, or nothing recorded when it asked for
     * none.
     *
     * @param {string} path @param {number} asked
     */
    const giveAttributes = (path, asked)=>{
        const bits = (asked >>> 0) & SETTABLE_ATTRIBUTES & ~FILE_ATTRIBUTE_NORMAL;
        files.setAttributes?.(path, bits === 0 ? null : bits | FILE_ATTRIBUTE_ARCHIVE);
    };

    /**
     * A WIN32_FIND_DATAA with its head filled -- attributes, the three times,
     * the size -- which is also the whole of a WIN32_FILE_ATTRIBUTE_DATA.
     *
     * @param {DirectoryEntry | FileStat} entry
     */
    const findDataHead = entry=>{
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
        return data;
    };

    /**
     * Fills in a whole WIN32_FIND_DATAA. Written in one piece so that no field
     * can be left holding whatever the caller's buffer had in it -- the times
     * and the alternate 8.3 name we have nothing to say about are zeros the
     * guest can read, not gaps.
     *
     * @param {number} address @param {DirectoryEntry} entry
     */
    const writeFindData = (address, entry)=>{
        const data = findDataHead(entry);
        data.set(encodeName(entry.name.slice(0, MAX_PATH - 1)), WIN32_FIND_DATAA.cFileName);
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
        raw: pointer=>pointer === 0 ? '' : readName(pointer >>> 0, MAX_PATH),
        list: pointer=>readName(pointer >>> 0, MAX_PATH_LIST),
        write: writeStringTo,
        findData: writeFindData,
        unit: 1,
    };

    /** @type {TextForm} */
    const WIDE = {
        path: pointer=>fullPath(
            pointer === 0 ? '' : host.readWideString(pointer >>> 0, MAX_WIDE_PATH * 2)),
        raw: pointer=>pointer === 0 ? '' : host.readWideString(pointer >>> 0, MAX_WIDE_PATH * 2),
        list: pointer=>host.readWideString(pointer >>> 0, MAX_PATH_LIST * 2),
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
        if (entry.isDirectory || (readOnlyFile(entry) && !onReadOnlyMedia(path)))
        {
            return fail(ERROR_ACCESS_DENIED);
        }
        return files.remove(path) ? 1 : fail(denied(path));
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
        const present = files.stat(destination);
        if (present?.exists)
        {
            if (!replace)
            {
                return fail(ERROR_ALREADY_EXISTS);
            }
            if (readOnlyFile(present) || !files.remove(destination))
            {
                return fail(denied(destination));
            }
        }
        // A move off a disc has to delete what it moved, so the disc refuses
        // it as surely as a move onto one.
        return files.rename(source, destination)
            ? 1 : fail(denied(onReadOnlyMedia(source) ? source : destination));
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

    /** @param {string} base @param {string} stem @param {number} number */
    const tempName = (base, stem, number)=>
        `${base}${stem}${number.toString(16).toUpperCase()}.tmp`;

    const getTempFileName = bothForms(16, ([directory, prefix, unique, out], text)=>{
        const folder = (directory >>> 0) === 0 ? TEMP_PATH : text.path(directory);
        const stem = text.raw(prefix).slice(0, 3);
        const base = folder.endsWith(SEPARATOR) ? folder : folder + SEPARATOR;

        let number = (unique >>> 0) & 0xffff;
        let path = '';
        if (number !== 0)
        {
            path = tempName(base, stem, number);
        }
        else
        {
            // A name nothing holds. Windows counts rather than randomises,
            // and a caller that asks twice must not be handed the same name
            // -- so the file is created here, which is what makes the second
            // search skip it.
            for (number = nextTempNumber; number <= 0xffff; number++)
            {
                const candidate = tempName(base, stem, number);
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
            // existence, not by holding it open. Held, the caller's own open
            // of the name it was just given would be refused as shared with
            // nobody.
            files.close(node);
        }

        text.write(out >>> 0, MAX_PATH, path.slice(0, MAX_PATH - 1));
        host.setLastError(ERROR_SUCCESS);
        return number;
    });

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

    /**
     * MoveFileEx with a routine told of a copy's progress. A move here is a
     * rename on one volume, which copies nothing, so the routine is never
     * called -- as on Windows, where it is called only when the move copies
     * across volumes (MOVEFILE_COPY_ALLOWED).
     */
    const moveFileWithProgress = bothForms(20, ([from, to, , , flags], text)=>
        moveFileEx[text === ANSI ? 'ansi' : 'wide'].handler([from, to, flags]));

    /**
     * The volume has no hard links, as a FAT volume has none, and it answers
     * as FAT does; NTFS would link the name, so the refusal is reported.
     */
    const createHardLink = bothForms(12, ([name, existing], text)=>{
        const target = text.path(existing);
        if (!files.stat(target)?.exists)
        {
            return fail(missing(target));
        }
        host.divergence?.('CreateHardLink', `no hard links; ${text.path(name)} not linked`);
        return fail(ERROR_INVALID_FUNCTION);
    });

    /**
     * The volume has no reparse points to make a link of; the caller is
     * answered as a user without the privilege to create one is.
     */
    const createSymbolicLink = bothForms(12, ([name], text)=>{
        host.divergence?.('CreateSymbolicLink', `no symbolic links; ${text.path(name)} not made`);
        return fail(ERROR_PRIVILEGE_NOT_HELD);
    });

    /**
     * ReplaceFile: the replacement takes the replaced file's name, and the
     * replaced file goes to the backup name when one is given. Either file
     * read-only refuses the whole replacement before anything moves.
     */
    const replaceFile = bothForms(24, ([replaced, replacement, backup], text)=>{
        const target = text.path(replaced);
        const source = text.path(replacement);
        const old = files.stat(target);
        const incoming = files.stat(source);
        if (!old?.exists || !incoming?.exists)
        {
            return fail(ERROR_FILE_NOT_FOUND);
        }
        if (readOnlyFile(old) || readOnlyFile(incoming))
        {
            return fail(ERROR_ACCESS_DENIED);
        }
        if ((backup >>> 0) !== 0)
        {
            const kept = renamePath(target, text.path(backup), true);
            if (kept !== 1)
            {
                return kept;
            }
        }
        else if (!files.remove(target))
        {
            return fail(denied(target));
        }
        return renamePath(source, target, true);
    });

    /**
     * The copy every spelling shares. Copied through the ordinary read and
     * write path rather than by asking the filesystem for a copy, because a
     * copy that is not a read followed by a write is a second implementation
     * of both. The copy carries the source's attributes and its write time,
     * as a copy on Windows does; a file copied onto itself is the destination
     * open colliding with the source's, a sharing violation.
     *
     * @param {string} source @param {string} destination @param {boolean} failIfExists
     * @returns {number | Promise<number>}
     */
    const copyPath = (source, destination, failIfExists)=>{
        if (source === '' || destination === '')
        {
            return fail(ERROR_PATH_NOT_FOUND);
        }
        const entry = files.stat(source);
        if (!entry || !entry.exists || entry.isDirectory)
        {
            return fail(entry?.isDirectory ? ERROR_ACCESS_DENIED : missing(source));
        }
        if (source.toLowerCase() === destination.toLowerCase())
        {
            return fail(ERROR_SHARING_VIOLATION);
        }
        const present = files.stat(destination);
        if (failIfExists && present?.exists)
        {
            return fail(ERROR_FILE_EXISTS);
        }
        if (readOnlyFile(present) || present?.isDirectory)
        {
            return fail(ERROR_ACCESS_DENIED);
        }
        const input = files.open(source, { read: true });
        if (!input)
        {
            return fail(ERROR_ACCESS_DENIED);
        }
        const output = files.open(destination, { write: true, create: true, truncate: true });
        if (!output)
        {
            files.close(input);
            return fail(onReadOnlyMedia(destination) ? ERROR_WRITE_PROTECT
                : present?.exists ? ERROR_ACCESS_DENIED : missing(destination));
        }
        // A chunk at a time: the files a game copies are the ones it
        // shipped, and holding one of those whole is a copy that works
        // in a test and runs out of memory on a real install. A chunk of a
        // bundle's file whose blocks are not here yet is a promise: the
        // thread is parked until they are, as ReadFile's is, and the copy
        // goes on from that chunk -- the source stays open until then, since
        // the read that fetches it reads it again once they have come.
        const owner = host.currentThread?.() ?? null;
        /** @param {number} code @param {boolean} parked */
        const answer = (code, parked)=>{
            if (parked && owner && host.setLastErrorFor)
            {
                host.setLastErrorFor(owner, code);
            }
            else
            {
                host.setLastError(code);
            }
        };
        /** @param {boolean} parked */
        const finish = parked=>{
            files.close(input);
            files.close(output);
            files.setAttributes?.(destination, entry.attributes ?? null);
            if (entry.modified)
            {
                files.setModified?.(destination, entry.modified);
            }
            answer(ERROR_SUCCESS, parked);
            return 1;
        };
        /**
         * @param {number} from @param {boolean} parked
         * @returns {number | Promise<number>}
         */
        const copyFrom = (from, parked)=>{
            for (let at = from; at < entry.size; at += COPY_CHUNK)
            {
                const chunk = files.read(input, at, COPY_CHUNK);
                if (typeof (/** @type {any} */ (chunk))?.then === 'function')
                {
                    return /** @type {Promise<Uint8Array>} */ (chunk).then(bytes=>{
                        files.write(output, at, bytes);
                        return copyFrom(at + COPY_CHUNK, true);
                    }, ()=>{
                        files.close(input);
                        files.close(output);
                        answer(ERROR_IO_DEVICE, true);
                        return 0;
                    });
                }
                files.write(output, at, /** @type {Uint8Array} */ (chunk));
            }
            return finish(parked);
        };
        return copyFrom(0, false);
    };

    const copyFile = bothForms(12, ([from, to, failIfExists], text)=>
        copyPath(text.path(from), text.path(to), failIfExists !== 0));

    /**
     * The progress routine is not called: a copy here is one step with
     * nothing to report between its start and its end, and a caller that
     * would have cancelled from the routine sees the copy complete. The
     * cancel flag is read once, before anything is written.
     */
    const copyFileEx = bothForms(24, ([from, to, , , cancel, flags], text)=>{
        if ((cancel >>> 0) !== 0 && readDword(cancel >>> 0) !== 0)
        {
            return fail(ERROR_REQUEST_ABORTED);
        }
        return copyPath(text.path(from), text.path(to),
            ((flags >>> 0) & COPY_FILE_FAIL_IF_EXISTS) !== 0);
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
            // A directory is found as a file is: the search asks whether the
            // name exists, and an installer looks for its own Disk1 folder so.
            const entry = files.stat(candidate);
            if (!entry?.exists)
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
        return files.mkdir(path)
            ? 1 : fail(onReadOnlyMedia(path) ? ERROR_WRITE_PROTECT : ERROR_PATH_NOT_FOUND);
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
        return files.remove(path)
            ? 1 : fail(onReadOnlyMedia(path) ? ERROR_WRITE_PROTECT : ERROR_DIR_NOT_EMPTY);
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

    /** WIN32_FILE_ATTRIBUTE_DATA is the head of a WIN32_FIND_DATA. */
    const getFileAttributesEx = bothForms(12, ([name, level, out], text)=>{
        if ((level >>> 0) !== GET_FILE_EX_INFO_STANDARD)
        {
            return fail(ERROR_INVALID_PARAMETER);
        }
        const path = text.path(name);
        const entry = files.stat(path);
        if (!entry || !entry.exists)
        {
            return fail(missing(path));
        }
        host.writeMemory(out >>> 0,
            findDataHead(entry).subarray(0, WIN32_FILE_ATTRIBUTE_DATA_SIZE));
        return 1;
    });

    const setFileAttributes = bothForms(8, ([name, attributes], text)=>{
        const path = text.path(name);
        if (!files.stat(path)?.exists)
        {
            return fail(missing(path));
        }
        if (onReadOnlyMedia(path))
        {
            return fail(ERROR_WRITE_PROTECT);
        }
        files.setAttributes?.(path, (attributes >>> 0) & SETTABLE_ATTRIBUTES);
        return 1;
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
        // A path in the Win32 file namespace is already as full as it gets, and
        // is handed back as written: that namespace turns all parsing off.
        if (asked.startsWith('\\\\?\\'))
        {
            const result = text.write(buffer >>> 0, size, asked);
            if (result === asked.length)
            {
                const at = asked.lastIndexOf(SEPARATOR);
                writeDwordIf(filePart >>> 0, asked.endsWith(SEPARATOR)
                    ? 0 : (buffer >>> 0) + (at + 1) * text.unit);
            }
            return result;
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
        // Every folder but a drive's root lists itself and its parent first,
        // as "." and "..", for any pattern of wildcards and dots alone; a
        // program that skips the first two entries unseen relies on it.
        // ponytail: wildcards-and-dots stands in for the volume's own match,
        // which "." and ".." pass exactly then.
        const dots = /^[A-Za-z]:\\?$/.test(directory) || !/^[*?.]+$/.test(pattern) ? []
            : ['.', '..'].map(dot=>({ ...holder, name: dot, isDirectory: true, size: 0 }));
        const entries = [...dots, ...files.list(directory, pattern) ?? []];
        if (entries.length === 0)
        {
            return fail(ERROR_FILE_NOT_FOUND, INVALID_HANDLE_VALUE);
        }
        text.findData(data >>> 0, entries[0]);
        host.setLastError(ERROR_SUCCESS);
        return host.handles.open('find', { entries, index: 1 });
    });

    /**
     * FindFirstFileEx: the same search, with the level of detail, a search
     * operation and flags. The basic level leaves out the 8.3 name, which is
     * never written here anyway; limiting to directories is advice a file
     * system is free not to take, and a caller filters for itself; and the
     * flags ask for case-sensitive matching or larger reads, neither of which
     * changes what is found. Anything else is refused.
     */
    const findFirstFileEx = bothForms(24, ([name, level, data, operation, filter, flags], text)=>{
        if ((level >>> 0) > FIND_EX_INFO_BASIC
            || (operation >>> 0) > FIND_EX_SEARCH_LIMIT_TO_DIRECTORIES
            || filter !== 0
            || ((flags >>> 0) & ~(FIND_FIRST_EX_CASE_SENSITIVE | FIND_FIRST_EX_LARGE_FETCH)) !== 0)
        {
            return fail(ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE);
        }
        return (text === WIDE ? findFirstFile.wide : findFirstFile.ansi).handler([name, data]);
    });

    /**
     * What is wrong with a name a file is opened by, before anything is
     * looked up, or 0. Resolution forgives what the open must not: a wildcard
     * names no one file, and a trailing separator says the name is a
     * directory -- an existing directory spelled so is not a file to open,
     * and a new file cannot be made under a name that ends in one.
     *
     * @param {string} raw  What the caller wrote.
     * @param {string} path  The same, resolved.
     * @param {boolean} creating  Whether the disposition may make the file.
     */
    const nameRefusal = (raw, path, creating)=>{
        const last = path.slice(path.lastIndexOf(SEPARATOR) + 1);
        if (/[*?]/.test(last))
        {
            return ERROR_INVALID_NAME;
        }
        if (!/[\\/]$/.test(raw) || /^[A-Za-z]:[\\/]$/.test(raw))
        {
            return 0;
        }
        const entry = files.stat(path);
        if (entry?.exists)
        {
            return entry.isDirectory ? ERROR_PATH_NOT_FOUND : ERROR_INVALID_NAME;
        }
        return creating ? ERROR_INVALID_NAME : missing(path);
    };

    /**
     * The open CreateFile and NtCreateFile share, over a resolved path: a
     * handle and whether the file was already there, or the Win32 error it
     * failed with. `cannotDelete` marks the one refusal the native call names
     * differently -- a read-only file asked to go away when it closes.
     *
     * @param {string} path
     * @param {{ access: number, share: number, disposition: number, flags: number }} request
     * @returns {{ handle: number, existed: boolean } | { error: number, cannotDelete?: boolean }}
     */
    const openPath = (path, request)=>{
        const result = openPathOnce(path, request);
        if ('error' in result)
        {
            host.openRefused?.({ path, error: result.error, ...request });
        }
        return result;
    };
    /**
     * `openPath` without the account of what it refused.
     *
     * @param {string} path
     * @param {{ access: number, share: number, disposition: number, flags: number }} request
     * @returns {{ handle: number, existed: boolean } | { error: number, cannotDelete?: boolean }}
     */
    const openPathOnce = (path, { access, share, disposition, flags })=>{
        const mode = openModes[disposition >>> 0];
        if (!mode)
        {
            return { error: ERROR_INVALID_PARAMETER };
        }
        const rights = access >>> 0;
        const read = (rights & (GENERIC_READ | GENERIC_ALL | FILE_READ_DATA)) !== 0;
        const write = (rights
            & (GENERIC_WRITE | GENERIC_ALL | FILE_WRITE_DATA | FILE_APPEND_DATA)) !== 0;
        const deleteOnClose = ((flags >>> 0) & FILE_FLAG_DELETE_ON_CLOSE) !== 0;
        if (disposition === TRUNCATE_EXISTING && !write)
        {
            return { error: ERROR_INVALID_PARAMETER };
        }
        if ((write || deleteOnClose) && onReadOnlyMedia(path))
        {
            return { error: ERROR_WRITE_PROTECT };
        }

        const existing = files.stat(path);
        const exists = Boolean(existing && existing.exists);
        if (exists && existing?.isDirectory)
        {
            // Opening a directory needs FILE_FLAG_BACKUP_SEMANTICS,
            // which nothing here honours.
            return { error: ERROR_ACCESS_DENIED };
        }
        if (exists && disposition === CREATE_NEW)
        {
            return { error: ERROR_FILE_EXISTS };
        }
        if (!exists && (disposition === OPEN_EXISTING
                || disposition === TRUNCATE_EXISTING))
        {
            return { error: missing(path) };
        }
        if (readOnlyFile(existing))
        {
            if (write || disposition === CREATE_ALWAYS || disposition === TRUNCATE_EXISTING)
            {
                return { error: ERROR_ACCESS_DENIED };
            }
            if (deleteOnClose)
            {
                return { error: ERROR_ACCESS_DENIED, cannotDelete: true };
            }
        }

        const node = files.open(path, {
            read, write, ...mode, shareWrite: ((share >>> 0) & FILE_SHARE_WRITE) !== 0,
        });
        if (!node)
        {
            return { error: onReadOnlyMedia(path) ? ERROR_WRITE_PROTECT
                : exists ? ERROR_ACCESS_DENIED : missing(path) };
        }
        // A new file takes the attributes it was created with; one that is
        // replaced takes them too, as a file made afresh would.
        if (!exists || disposition === CREATE_ALWAYS)
        {
            giveAttributes(path, flags);
        }
        // A handle opened for overlapped I/O keeps no file pointer of its
        // own that a read or write moves: each says where in its OVERLAPPED.
        const overlapped = ((flags >>> 0) & FILE_FLAG_OVERLAPPED) !== 0;
        const handle = host.handles.open('file', {
            path, node, read, write, position: 0, ...deleteOnClose ? { deleteOnClose } : {},
            ...overlapped ? { overlapped } : {},
        });
        return { handle, existed: exists };
    };

    /**
     * CreateFile, in terms of a resolved path, so both spellings open the same
     * file. Security and the template are accepted and ignored: there is no
     * security descriptor to check against, and no attribute of a template file
     * we could copy. FILE_SHARE_WRITE is honoured, so a second writer the first
     * open agreed to share with gets in; reading is always shared, so an open
     * Windows would refuse for want of FILE_SHARE_READ still succeeds here.
     */
    const createFile = bothForms(28, ([name, access, share, , disposition, flags], text)=>{
        const refusal = nameRefusal(text.raw(name), text.path(name),
            disposition !== OPEN_EXISTING && disposition !== TRUNCATE_EXISTING);
        if (refusal !== 0)
        {
            return fail(refusal, INVALID_HANDLE_VALUE);
        }
        const opened = openPath(text.path(name), { access, share, disposition, flags });
        if ('error' in opened)
        {
            return fail(opened.error, INVALID_HANDLE_VALUE);
        }
        // A program reads the error after a *successful* CreateFile:
        // ERROR_ALREADY_EXISTS is how the two dispositions that accept
        // either state say which one they found, and clearing it
        // otherwise is what makes that test mean anything.
        const either = disposition === CREATE_ALWAYS || disposition === OPEN_ALWAYS;
        host.setLastError(opened.existed && either ? ERROR_ALREADY_EXISTS : ERROR_SUCCESS);
        return opened.handle;
    });

    /**
     * An object name as the native calls take it -- `\??\C:\dir\file`, or
     * `\??\UNC\server\share\file` -- as the path the volume takes, or the
     * status that says why it is not one. A name relative to a directory
     * handle joins that directory's path; the only directory handles are the
     * native open's own.
     *
     * @param {number} attributes  OBJECT_ATTRIBUTES
     * @returns {{ path: string } | { status: number }}
     */
    const nativeName = attributes=>{
        const root = readDword(attributes + 4);
        const string = readDword(attributes + 8);
        if (string === 0)
        {
            return { status: STATUS_OBJECT_NAME_INVALID };
        }
        const descriptor = host.readMemory(string, 8);
        const length = descriptor[0] | (descriptor[1] << 8);
        const buffer = readDword(string + 4);
        const raw = buffer === 0 || length === 0 ? new Uint8Array(0)
            : host.readMemory(buffer, length & ~1);
        let name = '';
        for (let at = 0; at + 1 < raw.length; at += 2)
        {
            name += String.fromCharCode(raw[at] | (raw[at + 1] << 8));
        }
        if (root !== 0)
        {
            const directory = object(root, 'directory');
            if (!directory)
            {
                return { status: STATUS_INVALID_HANDLE };
            }
            return name.startsWith(SEPARATOR)
                ? { status: STATUS_INVALID_PARAMETER }
                : { path: fullPath(name === '' ? directory.path
                    : `${directory.path.replace(/\\$/, '')}${SEPARATOR}${name}`) };
        }
        const prefix = /^\\(\?\?|DosDevices|GLOBAL\?\?)\\/i.exec(name);
        if (!prefix)
        {
            return { status: name.startsWith(SEPARATOR)
                ? STATUS_OBJECT_PATH_NOT_FOUND : STATUS_OBJECT_PATH_SYNTAX_BAD };
        }
        const rest = name.slice(prefix[0].length);
        if (/^UNC\\/i.test(rest))
        {
            return { path: fullPath(`\\\\${rest.slice(4)}`) };
        }
        return /^[A-Za-z]:(\\|$)/.test(rest)
            ? { path: fullPath(rest.length === 2 ? `${rest}\\` : rest) }
            : { status: STATUS_OBJECT_PATH_NOT_FOUND };
    };

    /** @type {Record<number, number>} */
    const NATIVE_FAILURES = {
        [ERROR_FILE_NOT_FOUND]: STATUS_OBJECT_NAME_NOT_FOUND,
        [ERROR_PATH_NOT_FOUND]: STATUS_OBJECT_PATH_NOT_FOUND,
        [ERROR_ACCESS_DENIED]: STATUS_ACCESS_DENIED,
        [ERROR_FILE_EXISTS]: STATUS_OBJECT_NAME_COLLISION,
        [ERROR_ALREADY_EXISTS]: STATUS_OBJECT_NAME_COLLISION,
        [ERROR_INVALID_PARAMETER]: STATUS_INVALID_PARAMETER,
        [ERROR_WRITE_PROTECT]: STATUS_MEDIA_WRITE_PROTECTED,
    };

    /**
     * The native dispositions, as CreateFile's; FILE_SUPERSEDE replaces the
     * file as FILE_OVERWRITE_IF does, and differs only in what it reports.
     *
     * @type {Record<number, number>}
     */
    const NATIVE_DISPOSITIONS = {
        [FILE_SUPERSEDE]: CREATE_ALWAYS,
        [FILE_OPEN]: OPEN_EXISTING,
        [FILE_CREATE]: CREATE_NEW,
        [FILE_OPEN_IF]: OPEN_ALWAYS,
        [FILE_OVERWRITE]: TRUNCATE_EXISTING,
        [FILE_OVERWRITE_IF]: CREATE_ALWAYS,
    };

    /**
     * NTSTATUS NtCreateFile(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
     *   PIO_STATUS_BLOCK, PLARGE_INTEGER AllocationSize, ULONG FileAttributes,
     *   ULONG ShareAccess, ULONG CreateDisposition, ULONG CreateOptions,
     *   PVOID EaBuffer, ULONG EaLength)
     *
     * The same open as CreateFile's, reached by the native name and answered
     * with a status. What the native call adds is its options: a directory
     * may be asked for or ruled out, and a file asked to delete itself when
     * its handle closes must have been opened for DELETE -- a read-only file
     * refuses that with STATUS_CANNOT_DELETE, after any refusal of the write
     * access it was also asked for.
     *
     * @param {number[]} args
     */
    const ntCreateFile = ([out, access, attributes, status, , givenAttributes, share,
        disposition, options])=>{
        const named = nativeName(attributes >>> 0);
        if ('status' in named)
        {
            return named.status;
        }
        const path = named.path;
        const wanted = options >>> 0;
        const directoryOnly = (wanted & FILE_DIRECTORY_FILE) !== 0;
        const fileOnly = (wanted & FILE_NON_DIRECTORY_FILE) !== 0;
        const deleteOnClose = (wanted & FILE_DELETE_ON_CLOSE) !== 0;
        const creation = NATIVE_DISPOSITIONS[disposition >>> 0];
        if (creation === undefined || (directoryOnly && fileOnly)
            || (deleteOnClose && ((access >>> 0) & DELETE) === 0))
        {
            return STATUS_INVALID_PARAMETER;
        }
        /** @param {number} handle @param {number} information */
        const opened = (handle, information)=>{
            writeDword(out >>> 0, handle);
            if ((status >>> 0) !== 0)
            {
                writeDword(status >>> 0, STATUS_SUCCESS);
                writeDword((status >>> 0) + 4, information);
            }
            return STATUS_SUCCESS;
        };

        const existing = files.stat(path);
        if (existing?.exists && existing.isDirectory)
        {
            if (fileOnly)
            {
                return STATUS_FILE_IS_A_DIRECTORY;
            }
            if (creation === CREATE_NEW)
            {
                return STATUS_OBJECT_NAME_COLLISION;
            }
            return opened(host.handles.open('directory',
                { path, ...deleteOnClose ? { deleteOnClose } : {} }), FILE_OPENED);
        }
        if (directoryOnly)
        {
            if (existing?.exists)
            {
                return STATUS_NOT_A_DIRECTORY;
            }
            if (creation !== CREATE_NEW && creation !== OPEN_ALWAYS)
            {
                return STATUS_OBJECT_NAME_NOT_FOUND;
            }
            if (!files.mkdir(path))
            {
                return onReadOnlyMedia(path)
                    ? STATUS_MEDIA_WRITE_PROTECTED : STATUS_OBJECT_PATH_NOT_FOUND;
            }
            return opened(host.handles.open('directory', { path }), FILE_CREATED);
        }

        const result = openPath(path, {
            access, share, disposition: creation,
            flags: (givenAttributes >>> 0) | (deleteOnClose ? FILE_FLAG_DELETE_ON_CLOSE : 0),
        });
        if ('error' in result)
        {
            return result.cannotDelete
                ? STATUS_CANNOT_DELETE
                : NATIVE_FAILURES[result.error] ?? STATUS_UNSUCCESSFUL;
        }
        const replaced = disposition === FILE_SUPERSEDE ? FILE_SUPERSEDED : FILE_OVERWRITTEN;
        return opened(result.handle, !result.existed ? FILE_CREATED
            : creation === CREATE_ALWAYS || creation === TRUNCATE_EXISTING
                ? replaced : FILE_OPENED);
    };

    /**
     * The byte ranges locked in each file, by the file's name folded to one
     * case: a lock belongs to the file and is seen through every handle onto
     * it, while who holds it is the handle that took it.
     *
     * @type {Map<string, { handle: number, start: bigint, length: bigint,
     *     exclusive: boolean }[]>}
     */
    const locks = new Map();
    const QWORD_END = 1n << 64n;

    /** A 64-bit quantity from its two halves. @param {number} lowPart @param {number} highPart */
    const qword = (lowPart, highPart)=>(BigInt(highPart >>> 0) << 32n) | BigInt(lowPart >>> 0);

    /**
     * Whether two ranges touch. A lock of no bytes is a point: it collides
     * with a range that covers it, and with nothing else.
     *
     * @param {bigint} start @param {bigint} length @param {bigint} otherStart
     * @param {bigint} otherLength
     */
    const overlaps = (start, length, otherStart, otherLength)=>{
        if (length === 0n && otherLength === 0n)
        {
            return false;
        }
        if (length === 0n)
        {
            return otherStart <= start && start < otherStart + otherLength;
        }
        if (otherLength === 0n)
        {
            return start <= otherStart && otherStart < start + length;
        }
        return start < otherStart + otherLength && otherStart < start + length;
    };

    /**
     * Takes a lock, or says why not. An exclusive lock collides with every
     * lock it overlaps, the taker's own included; a shared one only with
     * another handle's exclusive lock. A range running past the end of a
     * 64-bit offset is not one.
     *
     * @param {number} handle @param {bigint} start @param {bigint} length
     * @param {boolean} exclusive
     * @returns {number} a Win32 error, ERROR_SUCCESS when taken
     */
    const lockRange = (handle, start, length, exclusive)=>{
        const file = object(handle, 'file');
        if (!file)
        {
            return ERROR_INVALID_HANDLE;
        }
        if (start + length > QWORD_END)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const key = file.path.toLowerCase();
        const held = locks.get(key) ?? [];
        const collides = held.some(lock=>overlaps(start, length, lock.start, lock.length)
            && (exclusive || (lock.exclusive && lock.handle !== handle)));
        if (collides)
        {
            return ERROR_LOCK_VIOLATION;
        }
        held.push({ handle, start, length, exclusive });
        locks.set(key, held);
        return ERROR_SUCCESS;
    };

    /**
     * Gives back a lock the handle holds over exactly this range; an
     * exclusive one goes before a shared one over the same bytes.
     *
     * @param {number} handle @param {bigint} start @param {bigint} length
     * @returns {number} a Win32 error, ERROR_SUCCESS when given back
     */
    const unlockRange = (handle, start, length)=>{
        const file = object(handle, 'file');
        if (!file)
        {
            return ERROR_INVALID_HANDLE;
        }
        const held = locks.get(file.path.toLowerCase()) ?? [];
        const same = (/** @type {{ handle: number, start: bigint, length: bigint }} */ lock)=>
            lock.handle === handle && lock.start === start && lock.length === length;
        let at = held.findIndex(lock=>same(lock) && lock.exclusive);
        if (at < 0)
        {
            at = held.findIndex(same);
        }
        if (at < 0)
        {
            return ERROR_NOT_LOCKED;
        }
        held.splice(at, 1);
        return ERROR_SUCCESS;
    };

    /**
     * Closes a handle of any kind, and whatever it held here with it: the
     * volume's node, its locks, a file it was to delete.
     *
     * @param {number} handle
     * @returns {boolean} whether it was a handle
     */
    const release = handle=>{
        try
        {
            // A file handle and a mapping over the file each hold
            // the node, and closing either gives back its own hold:
            // the node closes with the last of them, in whichever
            // order the program closes them.
            const type = host.handles.typeOf?.(handle);
            const closed = host.handles.close(handle);
            if (closed && closed.node
                && (type === undefined || type === 'file' || type === 'mapping'))
            {
                files.close(closed.node);
            }
            if (type === 'file' && closed?.path)
            {
                const key = closed.path.toLowerCase();
                const kept = (locks.get(key) ?? []).filter(lock=>lock.handle !== handle);
                if (kept.length === 0)
                {
                    locks.delete(key);
                }
                else
                {
                    locks.set(key, kept);
                }
            }
            // With the last handle to the file, not with a duplicate of it.
            if (closed?.deleteOnClose && !host.handles.holds?.(closed))
            {
                files.remove(closed.path);
            }
            // A no-op on anything that was never named.
            host.namedObjects?.forget(closed);
            // Handle numbers are recycled, so anything keyed by this one
            // has to go now: a completion-port association that outlives
            // its handle sends the next file's packets to a port nobody
            // is reading, and a thread parked on a port that has just
            // closed waits on something nothing can reach.
            host.ports?.closed(handle, closed);
            return true;
        }
        catch (e){
            void e;
            return false;
        }
    };

    /**
     * The status block every native file call writes, success or not.
     *
     * @param {number} block @param {number} status @param {number} information
     */
    const report = (block, status, information)=>{
        if (block !== 0)
        {
            writeDword(block, status);
            writeDword(block + 4, information);
        }
        return status;
    };

    /**
     * The native calls over this table's opens, which ntdll publishes.
     */
    const natives = {
        /**
         * NTSTATUS NtLockFile(HANDLE, HANDLE Event, PIO_APC_ROUTINE, PVOID ApcContext,
         *   PIO_STATUS_BLOCK, PLARGE_INTEGER ByteOffset, PLARGE_INTEGER Length,
         *   ULONG Key, BOOLEAN FailImmediately, BOOLEAN ExclusiveLock)
         *
         * LockFileEx's lock; one that would wait is not granted, as there.
         */
        NtLockFile: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([handle, , , , block, offset, length, , , exclusive])=>{
                if ((block >>> 0) === 0 || (offset >>> 0) === 0 || (length >>> 0) === 0)
                {
                    return STATUS_ACCESS_VIOLATION;
                }
                const answer = lockRange(handle >>> 0,
                    qword(readDword(offset >>> 0), readDword((offset >>> 0) + 4)),
                    qword(readDword(length >>> 0), readDword((length >>> 0) + 4)),
                    (exclusive & 0xff) !== 0);
                return report(block >>> 0, answer === ERROR_SUCCESS ? STATUS_SUCCESS
                    : answer === ERROR_LOCK_VIOLATION ? STATUS_LOCK_NOT_GRANTED
                        : answer === ERROR_INVALID_HANDLE ? STATUS_INVALID_HANDLE
                            : STATUS_INVALID_PARAMETER, 0);
            },
        },

        /**
         * NTSTATUS NtUnlockFile(HANDLE, PIO_STATUS_BLOCK, PLARGE_INTEGER ByteOffset,
         *                       PLARGE_INTEGER Length, ULONG Key)
         *
         * The status block is written whatever the answer, and a NULL one is
         * the access violation writing it would be.
         */
        NtUnlockFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, block, offset, length])=>{
                if ((block >>> 0) === 0 || (offset >>> 0) === 0 || (length >>> 0) === 0)
                {
                    return STATUS_ACCESS_VIOLATION;
                }
                const answer = unlockRange(handle >>> 0,
                    qword(readDword(offset >>> 0), readDword((offset >>> 0) + 4)),
                    qword(readDword(length >>> 0), readDword((length >>> 0) + 4)));
                return report(block >>> 0, answer === ERROR_SUCCESS ? STATUS_SUCCESS
                    : answer === ERROR_INVALID_HANDLE ? STATUS_INVALID_HANDLE
                        : STATUS_RANGE_NOT_LOCKED, 0);
            },
        },

        NtCreateFile: { argBytes: 44, handler: ntCreateFile },

        /**
         * NTSTATUS NtFsControlFile(HANDLE, HANDLE Event, PIO_APC_ROUTINE, PVOID,
         *   PIO_STATUS_BLOCK, ULONG FsControlCode, PVOID, ULONG, PVOID, ULONG)
         *
         * The volume answers no file-system control: reparse points,
         * compression and the rest are the requests of a volume it is not.
         */
        NtFsControlFile: {
            argBytes: 40,
            /** @param {number[]} args */
            handler: ([handle, , , , block, code])=>{
                if (!object(handle, 'file'))
                {
                    return report(block >>> 0, STATUS_INVALID_HANDLE, 0);
                }
                host.divergence?.('NtFsControlFile',
                    `control code 0x${(code >>> 0).toString(16)} is not one this volume answers`);
                return report(block >>> 0, STATUS_INVALID_DEVICE_REQUEST, 0);
            },
        },

        /**
         * NTSTATUS NtQueryInformationFile(HANDLE, PIO_STATUS_BLOCK, PVOID,
         *                                 ULONG Length, FILE_INFORMATION_CLASS)
         *
         * The name, the size and the position of an open file; a class
         * this surface keeps nothing for is refused, and the refusal said.
         */
        NtQueryInformationFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, block, out, length, kind])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return report(block >>> 0, STATUS_INVALID_HANDLE, 0);
                }
                /** @type {Uint8Array} */
                let data;
                switch (kind >>> 0)
                {
                    case FILE_STANDARD_INFORMATION: {
                        const size = BigInt(files.stat(file.path)?.size ?? 0);
                        data = new Uint8Array(24);
                        const view = new DataView(data.buffer);
                        // AllocationSize, EndOfFile, NumberOfLinks, DeletePending, Directory.
                        view.setBigUint64(0, size, true);
                        view.setBigUint64(8, size, true);
                        view.setUint32(16, 1, true);
                        data[20] = file.deleteOnClose ? 1 : 0;
                        break;
                    }
                    case FILE_NAME_INFORMATION: {
                        // The path from the volume's root, without its drive.
                        const name = String(file.path).replace(/^[A-Za-z]:/, '');
                        data = new Uint8Array(4 + name.length * 2);
                        new DataView(data.buffer).setUint32(0, name.length * 2, true);
                        for (let at = 0; at < name.length; at++)
                        {
                            data[4 + at * 2] = name.charCodeAt(at) & 0xff;
                            data[5 + at * 2] = name.charCodeAt(at) >>> 8;
                        }
                        break;
                    }
                    case FILE_POSITION_INFORMATION:
                        data = new Uint8Array(8);
                        new DataView(data.buffer).setBigUint64(0, BigInt(file.position), true);
                        break;
                    default:
                        host.divergence?.('NtQueryInformationFile',
                            `information class ${kind >>> 0} is not kept`);
                        return report(block >>> 0, STATUS_INVALID_INFO_CLASS, 0);
                }
                if ((length >>> 0) < data.length)
                {
                    const fits = kind >>> 0 === FILE_NAME_INFORMATION && (length >>> 0) >= 4;
                    if (fits)
                    {
                        host.writeMemory(out >>> 0, data.subarray(0, length >>> 0));
                    }
                    return report(block >>> 0, fits ? STATUS_BUFFER_OVERFLOW
                        : STATUS_INFO_LENGTH_MISMATCH, fits ? length >>> 0 : 0);
                }
                host.writeMemory(out >>> 0, data);
                return report(block >>> 0, STATUS_SUCCESS, data.length);
            },
        },

        /**
         * NTSTATUS NtOpenFile(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
         *                     PIO_STATUS_BLOCK, ULONG ShareAccess, ULONG OpenOptions)
         *
         * NtCreateFile's FILE_OPEN, with no attributes and no extended ones.
         */
        NtOpenFile: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([out, access, attributes, status, share, options])=>
                ntCreateFile([out, access, attributes, status, 0, 0, share, FILE_OPEN,
                    options]),
        },
    };

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

    const table = {
        /**
         * HANDLE CreateFile(LPCSTR, DWORD dwDesiredAccess, DWORD dwShareMode,
         *   LPSECURITY_ATTRIBUTES, DWORD dwCreationDisposition,
         *   DWORD dwFlagsAndAttributes, HANDLE hTemplateFile)
         *
         * One body, both spellings.
         */
        CreateFileA: createFile.ansi,
        CreateFileW: { ...createFile.wide, natives },

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
                if ((buffer >>> 0) === 0 && (length >>> 0) !== 0)
                {
                    writeDwordIf(read >>> 0, 0);
                    return fail(ERROR_NOACCESS);
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
                    // A synchronous handle's pointer moves past what was read,
                    // even when an OVERLAPPED said where; an overlapped one's
                    // does not.
                    if (pointer === 0 || !file.overlapped)
                    {
                        file.position = at + bytes.length;
                    }
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
                    host.writeConsole(handle >>> 0, decodeAnsi(bytes));
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
                if ((buffer >>> 0) === 0 && count !== 0)
                {
                    writeDwordIf(written >>> 0, 0);
                    return fail(ERROR_INVALID_USER_BUFFER);
                }
                // The guest's own bytes where the memory layer lends them: a
                // volume keeps a copy of what it is written, never the array,
                // and an installer writes gigabytes through here -- read into
                // a copy, then copied again, then stored.
                const bytes = count === 0
                    ? new Uint8Array(0)
                    : host.windowMemory?.(buffer >>> 0, count)
                        ?? host.readMemory(buffer >>> 0, count);
                const pointer = overlapped >>> 0;
                const at = pointer !== 0 && host.ports
                    ? host.ports.offsetOf(pointer)
                    : file.position;
                /** @param {number} stored */
                const deliver = stored=>{
                    // An overlapped write on a handle opened for it leaves the
                    // file pointer where it was; the OVERLAPPED says where.
                    if (pointer === 0 || !file.overlapped)
                    {
                        file.position = at + stored;
                    }
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
                };
                const stored = (files.writeOrFetch ?? files.write)
                    .call(files, file.node, at, bytes);
                if (typeof stored === 'number')
                {
                    return deliver(stored);
                }
                // Parked like ReadFile while the bundle's blocks arrive.
                const owner = host.currentThread?.() ?? null;
                return /** @type {any} */ (stored.then(deliver, ()=>{
                    host.setLastErrorFor?.(owner, ERROR_IO_DEVICE);
                    return 0;
                }));
            },
        },

        /**
         * BOOL WriteFileGather(HANDLE, FILE_SEGMENT_ELEMENT aSegmentArray[],
         *   DWORD nNumberOfBytesToWrite, LPDWORD lpReserved, LPOVERLAPPED)
         *
         * One transfer at the OVERLAPPED's offset from a page per segment,
         * completed at once and reported once, as an overlapped WriteFile is.
         */
        WriteFileGather: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, segments, length, , overlapped])=>{
                const file = object(handle, 'file');
                if (!file || (overlapped >>> 0) === 0 || !host.ports)
                {
                    return fail(file ? ERROR_INVALID_PARAMETER : ERROR_INVALID_HANDLE);
                }
                if (!file.write)
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                const bytes = new Uint8Array(length >>> 0);
                for (let at = 0; at < bytes.length; at += PAGE_SIZE)
                {
                    const page = readDword((segments >>> 0) + at / PAGE_SIZE * 8);
                    bytes.set(host.readMemory(page, Math.min(PAGE_SIZE, bytes.length - at)), at);
                }
                const stored = files.write(file.node, host.ports.offsetOf(overlapped >>> 0), bytes);
                host.ports.completed(handle >>> 0, stored, overlapped >>> 0);
                return 1;
            },
        },

        /**
         * BOOL ReadFileScatter(HANDLE, FILE_SEGMENT_ELEMENT aSegmentArray[],
         *   DWORD nNumberOfBytesToRead, LPDWORD lpReserved, LPOVERLAPPED)
         *
         * The read WriteFileGather's write is the mirror of: a page per segment.
         */
        ReadFileScatter: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, segments, length, , overlapped])=>{
                const file = object(handle, 'file');
                const ports = host.ports;
                if (!file || (overlapped >>> 0) === 0 || !ports)
                {
                    return fail(file ? ERROR_INVALID_PARAMETER : ERROR_INVALID_HANDLE);
                }
                if (!file.read)
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                /** @param {Uint8Array} bytes */
                const deliver = bytes=>{
                    for (let at = 0; at < bytes.length; at += PAGE_SIZE)
                    {
                        const page = readDword((segments >>> 0) + at / PAGE_SIZE * 8);
                        host.writeMemory(page, bytes.subarray(at, at + PAGE_SIZE));
                    }
                    ports.completed(handle >>> 0, bytes.length, overlapped >>> 0);
                    return 1;
                };
                const bytes = files.read(file.node, ports.offsetOf(overlapped >>> 0), length >>> 0);
                return typeof (/** @type {any} */ (bytes))?.then === 'function'
                    ? /** @type {Promise<Uint8Array>} */ (bytes).then(deliver)
                    : deliver(/** @type {Uint8Array} */ (bytes));
            },
        },

        /**
         * BOOL ReadFileEx(HANDLE hFile, LPVOID lpBuffer, DWORD nNumberOfBytesToRead,
         *   LPOVERLAPPED lpOverlapped, LPOVERLAPPED_COMPLETION_ROUTINE)
         *
         * Overlapped I/O that reports through a completion routine instead of
         * an event or a port: the transfer is done at the OVERLAPPED's offset,
         * its status and count are written for GetOverlappedResult, and the
         * routine is queued to the calling thread with (error, count,
         * OVERLAPPED) -- it runs at that thread's next alertable wait, never
         * before this returns. hEvent is the program's own to use. A read that
         * starts at the end of the file fails with ERROR_HANDLE_EOF and queues
         * nothing.
         */
        ReadFileEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, overlapped, routine])=>{
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
                if (pointer === 0 || !host.queueApc)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const thread = host.currentThread?.() ?? null;
                /** @param {Uint8Array} bytes */
                const deliver = bytes=>{
                    if (bytes.length === 0 && (length >>> 0) > 0)
                    {
                        // On the thread that asked, which after a wait for
                        // the bytes is no longer the one running.
                        if (thread && host.setLastErrorFor)
                        {
                            host.setLastErrorFor(thread, ERROR_HANDLE_EOF);
                        }
                        else
                        {
                            host.setLastError(ERROR_HANDLE_EOF);
                        }
                        return 0;
                    }
                    if (bytes.length > 0)
                    {
                        host.writeMemory(buffer >>> 0, bytes);
                    }
                    return completeWith(thread, pointer, routine, bytes.length);
                };
                const bytes = files.read(file.node, readDword(pointer + OVERLAPPED_OFFSET),
                    length >>> 0);
                if (typeof (/** @type {any} */ (bytes))?.then !== 'function')
                {
                    return deliver(/** @type {any} */ (bytes));
                }
                return /** @type {any} */ (bytes).then(deliver, ()=>{
                    host.setLastErrorFor?.(thread, ERROR_IO_DEVICE);
                    return 0;
                });
            },
        },

        /**
         * BOOL WriteFileEx(HANDLE hFile, LPCVOID lpBuffer, DWORD nNumberOfBytesToWrite,
         *   LPOVERLAPPED lpOverlapped, LPOVERLAPPED_COMPLETION_ROUTINE)
         *
         * ReadFileEx's counterpart: written at the OVERLAPPED's offset, and the
         * routine queued the same way.
         */
        WriteFileEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, overlapped, routine])=>{
                const file = object(handle, 'file');
                if (!file)
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (!file.write)
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                const pointer = overlapped >>> 0;
                if (pointer === 0 || !host.queueApc)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const count = length >>> 0;
                const bytes = count === 0
                    ? new Uint8Array(0)
                    : host.readMemory(buffer >>> 0, count).slice();
                const stored = files.write(file.node, readDword(pointer + OVERLAPPED_OFFSET),
                    bytes);
                return completeWith(host.currentThread?.() ?? null, pointer, routine, stored);
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
            handler: ([handle])=>(release(handle >>> 0) ? 1 : fail(ERROR_INVALID_HANDLE)),
        },

        /** BOOL DeleteFile(LPCSTR) -- one body, both spellings. */
        DeleteFileA: deleteFile.ansi,
        DeleteFileW: deleteFile.wide,

        /** BOOL MoveFile(LPCSTR lpExistingFileName, LPCSTR lpNewFileName) -- one body, both spellings. */
        MoveFileA: moveFile.ansi,
        MoveFileW: moveFile.wide,

        /** BOOL CopyFile(LPCSTR, LPCSTR, BOOL bFailIfExists) -- one body, both spellings. */
        CopyFileA: copyFile.ansi,
        CopyFileW: copyFile.wide,

        /**
         * BOOL CopyFileEx(LPCSTR, LPCSTR, LPPROGRESS_ROUTINE, LPVOID lpData,
         *                 LPBOOL pbCancel, DWORD dwCopyFlags) -- both spellings.
         */
        CopyFileExA: copyFileEx.ansi,
        CopyFileExW: copyFileEx.wide,

        /** BOOL CreateDirectory(LPCSTR, LPSECURITY_ATTRIBUTES) -- one body, both spellings. */
        CreateDirectoryA: createDirectory.ansi,
        CreateDirectoryW: createDirectory.wide,

        /** BOOL RemoveDirectory(LPCSTR) -- one body, both spellings. */
        RemoveDirectoryA: removeDirectory.ansi,
        RemoveDirectoryW: removeDirectory.wide,

        /** DWORD GetFileAttributes(LPCSTR) -- one body, both spellings. */
        GetFileAttributesA: getFileAttributes.ansi,
        GetFileAttributesW: getFileAttributes.wide,
        GetFileAttributesExA: getFileAttributesEx.ansi,
        GetFileAttributesExW: getFileAttributesEx.wide,

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
         * DWORD GetTempPathW(DWORD nBufferLength, LPWSTR lpBuffer)
         *
         * The same answer, written differently from its ANSI twin, as
         * kernel32's path tests pin: what the path does not fill is zeroed --
         * the whole buffer when it is too short, the rest after the path when
         * it is not -- as far as the longest wide path, and no further.
         */
        GetTempPathW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, buffer])=>{
                const count = Math.min(size >>> 0, MAX_WIDE_PATH);
                if ((buffer >>> 0) !== 0 && count > 0)
                {
                    host.writeMemory(buffer >>> 0, new Uint8Array(count * 2));
                }
                return writeWideStringTo(buffer >>> 0, size, TEMP_PATH);
            },
        },

        /**
         * UINT GetTempFileName(LPCSTR lpPathName, LPCSTR lpPrefixString,
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
         * because the whole name has to fit an 8.3 form; the number is in
         * upper-case hexadecimal before a lower-case `.tmp`, the spelling
         * kernel32's file tests compare byte for byte. One body, both
         * spellings.
         */
        GetTempFileNameA: getTempFileName.ansi,
        GetTempFileNameW: getTempFileName.wide,

        CreateSymbolicLinkA: createSymbolicLink.ansi,
        CreateSymbolicLinkW: createSymbolicLink.wide,
        CreateHardLinkA: createHardLink.ansi,
        CreateHardLinkW: createHardLink.wide,
        ReplaceFileA: replaceFile.ansi,
        ReplaceFileW: replaceFile.wide,
        // kernel32's export of the name with neither suffix, which is the
        // wide call: the name a program written before the A and W forms
        // looks up.
        ReplaceFile: replaceFile.wide,
        /**
         * BOOL MoveFileEx(LPCSTR lpExistingFileName, LPCSTR lpNewFileName,
         *                 DWORD dwFlags) -- one body, both spellings.
         */
        MoveFileExA: moveFileEx.ansi,
        MoveFileExW: moveFileEx.wide,
        MoveFileWithProgressA: moveFileWithProgress.ansi,
        MoveFileWithProgressW: moveFileWithProgress.wide,

        /**
         * void SetFileApisToOEM(void)
         *
         * The ANSI spellings of the file functions take and give names in the
         * OEM page from here on (`fileApisOem`).
         */
        SetFileApisToOEM: {
            argBytes: 0,
            handler: ()=>{
                fileApisOem = true;
                return 0;
            },
        },

        /** void SetFileApisToANSI(void): back to the ANSI page, the default. */
        SetFileApisToANSI: {
            argBytes: 0,
            handler: ()=>{
                fileApisOem = false;
                return 0;
            },
        },

        /** BOOL AreFileApisANSI(void) */
        AreFileApisANSI: {
            argBytes: 0,
            handler: ()=>(fileApisOem ? 0 : 1),
        },

        /** HANDLE FindFirstFile(LPCSTR, LPWIN32_FIND_DATA) -- one body, both spellings. */
        FindFirstFileA: findFirstFile.ansi,
        FindFirstFileW: findFirstFile.wide,

        /**
         * HANDLE FindFirstFileEx(LPCSTR, FINDEX_INFO_LEVELS, LPVOID,
         *   FINDEX_SEARCH_OPS, LPVOID lpSearchFilter, DWORD dwAdditionalFlags)
         */
        FindFirstFileExA: findFirstFileEx.ansi,
        FindFirstFileExW: findFirstFileEx.wide,

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
         * DWORD GetShortPathNameA(LPCSTR, LPSTR, DWORD), and GetShortPathNameW
         *
         * This volume keeps no 8.3 aliases, so a name's short form is the name
         * itself: a program that reopens the file by what it is handed finds
         * it, and only one that counts on the dotted-eight shape sees a
         * difference.
         */
        GetShortPathNameA: getLongPathName.ansi,
        GetShortPathNameW: getLongPathName.wide,

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
                    data.set(encodeAnsi(path.slice(0, OFSTRUCT_PATH_MAX - 1)), OFSTRUCT_PATH);
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
                    if (readOnlyFile(entry))
                    {
                        return fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
                    }
                    return files.remove(path) ? 1 : fail(denied(path), HFILE_ERROR);
                }

                const write = (flags & (OF_WRITE | OF_READWRITE)) !== 0;
                const create = (flags & OF_CREATE) !== 0;
                if (!exists && !create)
                {
                    return fail(missing(path), HFILE_ERROR);
                }
                if ((write || create) && readOnlyFile(entry))
                {
                    return fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
                }
                const node = files.open(path,
                    { read: !write, write, create, truncate: create });
                if (!node)
                {
                    return fail(denied(path), HFILE_ERROR);
                }
                host.setLastError(ERROR_SUCCESS);
                return host.handles.open('file',
                    { path, node, read: !write, write, position: 0 });
            },
        },

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
                // OF_WRITE alone is write-only: a read through it is refused.
                const read = (mode & (OF_READWRITE | OF_WRITE)) !== OF_WRITE;
                const entry = files.stat(path);
                if (!entry || !entry.exists)
                {
                    return fail(missing(path), HFILE_ERROR);
                }
                if (write && readOnlyFile(entry))
                {
                    return fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
                }
                const node = files.open(path, { read, write, create: false });
                if (!node)
                {
                    return fail(denied(path), HFILE_ERROR);
                }
                host.setLastError(ERROR_SUCCESS);
                return host.handles.open('file', { path, node, read, write, position: 0 });
            },
        },

        /**
         * HFILE _lcreat(LPCSTR lpPathName, int iAttribute)
         *
         * Always creates and always truncates, which is the difference from
         * `_lopen`: a self-extractor calls this for every file it unpacks and
         * relies on a second pass finding an empty one rather than the tail of
         * the first. The attribute is the DOS one -- read-only, hidden, system
         * in its low bits -- and the new file carries it, while the handle
         * that made it still writes.
         */
        _lcreat: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, attribute])=>{
                const path = pathArgument(name);
                const refusal = nameRefusal(ANSI.raw(name), path, true);
                if (refusal !== 0)
                {
                    return fail(refusal, HFILE_ERROR);
                }
                if (readOnlyFile(files.stat(path)))
                {
                    return fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
                }
                const node = files.open(path,
                    { read: true, write: true, create: true, truncate: true });
                if (!node)
                {
                    return fail(denied(path), HFILE_ERROR);
                }
                giveAttributes(path, (attribute >>> 0) & 0x7);
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
                if (!file.read)
                {
                    return fail(ERROR_ACCESS_DENIED, HFILE_ERROR);
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
                /** @param {number} stored */
                const deliver = stored=>{
                    file.position += stored;
                    host.setLastError(ERROR_SUCCESS);
                    return stored;
                };
                const stored = (files.writeOrFetch ?? files.write).call(files, file.node,
                    file.position, bytes);
                return typeof stored === 'number'
                    ? deliver(stored)
                    : /** @type {any} */ (stored.then(deliver, ()=>HFILE_ERROR));
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
                if (!release(handle >>> 0))
                {
                    return fail(ERROR_INVALID_HANDLE, HFILE_ERROR);
                }
                host.setLastError(ERROR_SUCCESS);
                return 0;
            },
        },

        /**
         * BOOL LockFile(HANDLE, DWORD dwFileOffsetLow, DWORD dwFileOffsetHigh,
         *               DWORD nNumberOfBytesToLockLow, DWORD nNumberOfBytesToLockHigh)
         *
         * An exclusive lock that does not wait.
         */
        LockFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, offsetLow, offsetHigh, lengthLow, lengthHigh])=>{
                const answer = lockRange(handle >>> 0, qword(offsetLow, offsetHigh),
                    qword(lengthLow, lengthHigh), true);
                return answer === ERROR_SUCCESS ? 1 : fail(answer);
            },
        },

        /** BOOL UnlockFile(HANDLE, DWORD, DWORD, DWORD, DWORD) */
        UnlockFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, offsetLow, offsetHigh, lengthLow, lengthHigh])=>{
                const answer = unlockRange(handle >>> 0, qword(offsetLow, offsetHigh),
                    qword(lengthLow, lengthHigh));
                return answer === ERROR_SUCCESS ? 1 : fail(answer);
            },
        },

        /**
         * BOOL LockFileEx(HANDLE, DWORD dwFlags, DWORD dwReserved,
         *   DWORD nNumberOfBytesToLockLow, DWORD nNumberOfBytesToLockHigh,
         *   LPOVERLAPPED)
         *
         * LockFile's lock at the OVERLAPPED's offset, shared unless
         * LOCKFILE_EXCLUSIVE_LOCK says otherwise. A lock that would have to
         * wait for another handle's is refused rather than waited for: the
         * wait has no end here unless another thread of this process lets go,
         * and a caller told no can retry where one parked for ever cannot.
         */
        LockFileEx: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, flags, reserved, lengthLow, lengthHigh, overlapped])=>{
                if (!object(handle, 'file'))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (reserved !== 0 || overlapped === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const at = overlapped >>> 0;
                const answer = lockRange(handle >>> 0,
                    qword(readDword(at + OVERLAPPED_OFFSET), readDword(at + OVERLAPPED_OFFSET + 4)),
                    qword(lengthLow, lengthHigh), ((flags >>> 0) & LOCKFILE_EXCLUSIVE_LOCK) !== 0);
                return answer === ERROR_SUCCESS ? 1 : fail(answer);
            },
        },

        /**
         * BOOL UnlockFileEx(HANDLE, DWORD dwReserved, DWORD nNumberOfBytesToUnlockLow,
         *   DWORD nNumberOfBytesToUnlockHigh, LPOVERLAPPED)
         */
        UnlockFileEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, reserved, lengthLow, lengthHigh, overlapped])=>{
                if (!object(handle, 'file'))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if (reserved !== 0 || overlapped === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const at = overlapped >>> 0;
                const answer = unlockRange(handle >>> 0,
                    qword(readDword(at + OVERLAPPED_OFFSET), readDword(at + OVERLAPPED_OFFSET + 4)),
                    qword(lengthLow, lengthHigh));
                return answer === ERROR_SUCCESS ? 1 : fail(answer);
            },
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

        /**
         * BOOL CancelIo(HANDLE hFile)
         *
         * Every read and write here has finished by the time its call
         * answers -- a parked one answers before its thread runs again -- so
         * the calling thread has nothing outstanding on any handle and there
         * is nothing to cancel. A handle that is no file object is refused,
         * as NtCancelIoFile refuses one.
         */
        CancelIo: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const kind = isStandardHandle(handle >>> 0) ? 'file'
                    : host.handles.typeOf?.(handle >>> 0);
                return kind && FILE_OBJECTS.has(kind) ? 1 : fail(ERROR_INVALID_HANDLE);
            },
        },

        // The serial port calls, refused on a machine with no serial port.
        ...createCommFunctions(host),

        // A program rewriting an executable's resources on the volume.
        ...createResourceUpdates({ ...host, fullPath }),
    };

    // The long spellings are the same calls on Win32, where every count is
    // 32 bits: _hread and _hwrite were _lread and _lwrite for a huge pointer.
    return { ...table, _hread: table._lread, _hwrite: table._lwrite };
}
