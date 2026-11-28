/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Finding a module, and finding a function inside one.
 *
 * A program that only calls through its own import table never comes here. Real
 * programs do more: they ask for an address by name, keep it, and call it much
 * later -- and some ask before anything obliges us to have decided what the
 * answer is. The address must be the same either way (§13.3), because a program
 * that caches yesterday's answer calls yesterday's address.
 *
 * That is why nothing here creates anything. Every system module we implement is
 * synthesised into guest memory once, when the process is assembled, with its
 * exports already at fixed addresses. LoadLibrary then reports what is already
 * there rather than bringing it into being, and an address taken at the first
 * instruction is the address that works at the last.
 */

import { encodeAnsi } from './locale.js';
import { wholeAddress } from '../common/pointers.js';
import { utf16, utf16z } from '../common/utf16.js';

/**
 * How far a name a program hands these is read: whole, as Windows reads it, up to
 * the 32 767 characters a path may have. A name cut shorter names another file.
 */
const WHOLE_NAME = 32767;

/** A module name is at most this long; longer is a pointer that is not a string. */
const MAX_NAME = 260;

/** The path separator, named so it is not confused with an escape. */
const SEPARATOR = String.fromCharCode(92);

/** ERROR_MOD_NOT_FOUND, ERROR_PROC_NOT_FOUND. */
const ERROR_MOD_NOT_FOUND = 126;
const ERROR_PROC_NOT_FOUND = 127;
const ERROR_INVALID_PARAMETER = 87;

/** LoadLibraryEx's LOAD_LIBRARY_SEARCH_* flags: where a library is looked for instead. */
const SEARCH_DLL_LOAD_DIR = 0x100;
const SEARCH_APPLICATION_DIR = 0x200;
const SEARCH_USER_DIRS = 0x400;
const SEARCH_SYSTEM32 = 0x800;
const SEARCH_DEFAULT_DIRS = 0x1000;
const SEARCH_FLAGS = SEARCH_DLL_LOAD_DIR | SEARCH_APPLICATION_DIR | SEARCH_USER_DIRS
    | SEARCH_SYSTEM32 | SEARCH_DEFAULT_DIRS;
/** Which a LOAD_LIBRARY_SEARCH_* search cannot be combined with. */
const LOAD_WITH_ALTERED_SEARCH_PATH = 0x8;
/**
 * LoadLibraryEx's loads of a file for its data (AS_DATAFILE, AS_IMAGE_RESOURCE,
 * AS_DATAFILE_EXCLUSIVE): a file of that name, never a module that is loaded.
 */
const LOAD_AS_DATA = 0x2 | 0x20 | 0x40;

/** The flags SetDefaultDllDirectories takes: all of them but DLL_LOAD_DIR. */
const DEFAULT_DLL_DIRECTORIES = SEARCH_APPLICATION_DIR | SEARCH_USER_DIRS | SEARCH_SYSTEM32
    | SEARCH_DEFAULT_DIRS;

/**
 * The key under which the table answers the directories a library is looked
 * for in, as ntdll's LdrGetDllPath hands them out: `(module, flags)` with
 * LoadLibraryEx's flags and the library whose search it is, answering the
 * directories in order.
 */
export const DLL_SEARCH_PATH = Symbol('dllSearchPath');

/** The system's directories, as GetSystemDirectory and GetWindowsDirectory name them. */
const SYSTEM32_DIRECTORY = 'C:\\WINDOWS\\system32';
const SYSTEM16_DIRECTORY = 'C:\\WINDOWS\\system';
const WINDOWS_DIRECTORY = 'C:\\WINDOWS';

/** Where AddDllDirectory's cookies start: above the null page, four apart. */
const DLL_DIRECTORY_COOKIE_BASE = 0x10000;

/** What FreeLibrary says of a data-file handle that names no mapping. */
const ERROR_BAD_EXE_FORMAT = 193;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NOACCESS = 998;
/** What GetMappedFileName answers for an address no file is mapped at. */
const ERROR_UNEXP_NET_ERR = 59;
/** sizeof(MODULEINFO): the base, the image's size and its entry point. */
const MODULEINFO_SIZE = 12;

/**
 * A pointer whose high word is zero is an ordinal, not a string. It is the rule
 * GetProcAddress has always used, and the reason no string may live in the first
 * 64 KiB of the address space.
 *
 * @param {number} value
 */
const isOrdinal = value=>(value >>> 16) === 0;

/**
 * Whether a run-time load has to look beside the program before it answers
 * from the engine's own table.
 *
 * Windows maps a KnownDLL out of the system directory and never searches the
 * application's own directory for it, so for one of those the table entry is
 * the only answer and a file of the same name beside the program is ignored.
 * For every other name the application's directory is searched first: a file
 * the program brought is what loads, and our table is the fallback for when
 * there is none. A library already mapped out of a file is that file's answer
 * already -- a second LoadLibrary gets the handle it already has.
 *
 * @param {boolean} knownDll       The name is one Windows keeps under KnownDLLs.
 * @param {boolean} mappedFromFile It is already mapped out of a volume file.
 */
export function searchesBesideProgram(knownDll, mappedFromFile){
    return !knownDll && !mappedFromFile;
}

/**
 * @typedef {Object} ModuleRecord
 * @property {string} name
 * @property {number} base
 * @property {(name: string) => number | null} addressOf
 * @property {(ordinal: number) => number | null} addressOfOrdinal
 * @property {string} [path]  Where it was loaded from, when it came from a file.
 * @property {() => number | Promise<number>} [release]
 *           Gives back one reference a LoadLibrary took; the last one unloads
 *           the module, its DllMain told first. A module without one -- the
 *           program, and every library it imports -- is never unloaded.
 */

/**
 * A search LoadLibraryEx's LOAD_LIBRARY_SEARCH_* flags asked for, or the
 * default SetDefaultDllDirectories set: which of the places are looked in.
 *
 * @typedef {Object} LibrarySearch
 * @property {boolean} application  The program's directory.
 * @property {string[]} user        What AddDllDirectory and SetDllDirectory named.
 * @property {boolean} system       The system directory: the engine's own libraries.
 * @property {boolean} [loadDirectory]  A library's imports are looked for in its own
 *           directory first (LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR).
 * @property {string} [from]        That directory, for one library's imports.
 */

/**
 * An export's address, or the error GetProcAddress leaves for it.
 *
 * @typedef {{ address: number, module?: any } | { error: number }} ExportFound
 */

/**
 * @typedef {Object} ModulesHost
 * @property {import('../common/guest.js').Guest} guest
 * @property {(name: string | null) => ModuleRecord | null} find
 *           A module by name; null asks for the running program's own image.
 * @property {(base: number) => ModuleRecord | null} byBase
 * @property {(code: number) => void} setLastError
 * @property {() => string} imagePath  The path the running program was loaded from.
 * @property {(name: string) => string | null} [libraryHome]  The folder a library this
 *           build synthesises is installed in when it is not the system folder.
 * @property {(name: string, flags?: number,
 *           search?: LibrarySearch | null) => number | Promise<number>} [load]
 *           Brings a library in if it is not here yet, answering with its base
 *           or zero. Answers synchronously whenever it can -- see LoadLibraryA.
 *           `flags` are LoadLibraryEx's, which say how it is to be loaded;
 *           `search` the places a LOAD_LIBRARY_SEARCH_* search looks in
 *           instead of the standard ones.
 * @property {(name: string) => string | undefined} [environmentVariable]  A variable
 *           of the process's environment as it is now: PATH, the standard search's end.
 * @property {(name: string) => number | null} [loadError]
 *           Why `load` answered zero for that name, when it was not that nothing
 *           was found: ERROR_BAD_EXE_FORMAT for a file that is no image for the
 *           process. Null: ERROR_MOD_NOT_FOUND.
 * @property {4 | 8} [pointerSize]  8 in a 64-bit process, whose HMODULE is a quadword
 * @property {(handle: number) => ModuleRecord | null} [dataFile]
 *           A library LoadLibraryEx mapped as data, by the handle it gave out:
 *           no module, so not among the ones `byBase` knows.
 * @property {(code: number) => any} [exitThread]
 *           Ends the calling thread as ExitThread does, parking it: for a call
 *           still in flight.
 * @property {() => any} [currentThread]
 * @property {(thread: any, code: number) => Promise<number> | null} [endThread]
 *           Ends a thread that ended itself, without parking it: for a call
 *           that has already been suspended, whose thread is no longer the one
 *           on the processor. Null once it has ended, or the promise of
 *           telling the libraries of its detach on it first and then ending it.
 * @property {(base: number) => void} [disableThreadCalls]
 *           Stops telling a library of the threads that start and end. A
 *           library with static thread-local storage goes on being told: its
 *           TLS callbacks build each thread's thread-local objects.
 * @property {() => { base: number, name: string, path?: string }[]} [list]
 *           Every module of the process, the image first: what psapi's
 *           EnumProcessModules hands out.
 * @property {(path: string) => string | null} [nativePath]  A path as the object
 *           manager names it (`\Device\HarddiskVolumeN\...`), null where it has none.
 * @property {(module: ModuleRecord, name: string | null, ordinal: number | null)
 *           => ExportFound | Promise<ExportFound>} [exportOf]
 *           An export followed through its forwarders, a forwarder's target
 *           loaded first; absent, a module answers only what it defines.
 * @property {(asked: { module: string, name: string, found: number }) => void} [resolved]
 *           Told what a program looked up at runtime and what it was given. A
 *           name we answer zero to is one the program then decides about, and
 *           what it decides is usually invisible from anywhere else.
 */

/**
 * An export a module defines itself, with no forwarder followed.
 *
 * @param {ModuleRecord} module @param {string | null} name @param {number | null} ordinal
 * @returns {ExportFound}
 */
function definedExport(module, name, ordinal){
    const address = name !== null ? module.addressOf(name) : module.addressOfOrdinal(ordinal ?? -1);
    return address === null ? { error: ERROR_PROC_NOT_FOUND } : { address };
}

/**
 * @param {ModulesHost} host
 */
export function createModuleFunctions(host){
    const { guest } = host;
    /**
     * Where a module's file is, as a program asking about it expects.
     *
     * This matters more than it looks. A library is asked where it lives and
     * then looks for its own data beside itself, so a wrong directory does not
     * fail here: it fails much later, as data that is not where the program is
     * certain it put it.
     *
     * A library read off the volume knows its own path, and a library a game
     * ships does not live in a system directory. A module we synthesised is
     * where Windows would have had it -- the system directory, or the folder it
     * is installed in, as the Steam client is in Steam's -- and its image stands
     * there as a file (`withSystemLibraries`): a program comparing that path
     * against the system directory is right to find them equal.
     *
     * @param {{ name: string, path?: string }} module
     */
    const fileNameOf = module=>module.path ?? `${host.libraryHome?.(module.name)
            ?? `C:${SEPARATOR}Windows${SEPARATOR}System32`}${SEPARATOR}${module.name}`;

    /**
     * What both LoadLibrary entry points do.
     *
     * The answer is a number when it can be, and a promise only when a library
     * has to be read off the volume. That distinction is the whole of it: the
     * dispatcher decides a call is asynchronous by whether a promise came back,
     * so an implementation that always returned one would park and unpark the
     * guest thread on every call -- including a library that is already here
     * and one that is known not to exist, which titles ask about once a frame
     * while probing for hardware that may have been plugged in.
     *
     * Which is also why there is no separate "is it loaded" predicate beside
     * this. A second decision function drifts from the first, and then the
     * answer about whether waiting is needed stops matching the waiting.
     *
     * @param {string} asked
     * @param {number} [flags]  LoadLibraryEx's.
     * @returns {number | Promise<number>}
     */
    const load = (asked, flags = 0)=>{
        // A path's trailing spaces are not part of it: Windows drops them
        // from a name as it makes it a path ("kernel32   " is kernel32.dll).
        const name = asked.replace(/ +$/, '');
        /** @param {number} base @param {string} [tried] */
        const settle = (base, tried = name)=>{
            if (base === 0)
            {
                host.setLastError(host.loadError?.(tried) ?? ERROR_MOD_NOT_FOUND);
            }
            return base;
        };
        // An empty name names no file; the search would find the program's
        // own directory and answer with whatever it holds.
        if (name.trim() === '')
        {
            return settle(0);
        }
        // The library's own folder is known only of a path from the root:
        // LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR with a name relative to anything
        // is refused, as Windows refuses it.
        if (((flags & SEARCH_FLAGS) !== 0 && (flags & LOAD_WITH_ALTERED_SEARCH_PATH) !== 0)
            || ((flags & SEARCH_DLL_LOAD_DIR) !== 0 && !/^([A-Za-z]:)?[\\/]/.test(name)))
        {
            host.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        const search = searchOf(flags);
        if (search !== 0)
        {
            const found = loadOnce(name, flags & ~SEARCH_FLAGS, {
                application: (search & SEARCH_APPLICATION_DIR) !== 0,
                user: (search & SEARCH_USER_DIRS) !== 0 ? userSearched() : [],
                system: (search & SEARCH_SYSTEM32) !== 0,
                loadDirectory: (search & SEARCH_DLL_LOAD_DIR) !== 0,
            });
            return typeof found === 'number' ? settle(found) : found.then(base=>settle(base));
        }
        const answer = loadOnce(name, flags);
        // The directory SetDllDirectory named, for a bare name nothing else
        // found. Windows looks there before the system directories rather
        // than after them; the loader's own search is one step that cannot
        // be split, so a name the system also answers for comes from the
        // system here.
        // Then each directory AddDllDirectory named, in the order added.
        const bare = !/[\\/:]/.test(name);
        const besides = (bare ? [dllDirectory, ...userDirectories.values()] : [])
            .filter(directory=>directory !== null && directory !== '')
            .map(directory=>`${/** @type {string} */ (directory).replace(/\\+$/, '')}\\${name}`);
        /**
         * @param {number} base @param {number} next
         * @returns {number | Promise<number>}
         */
        const retry = (base, next)=>{
            if (base !== 0 || next >= besides.length)
            {
                return settle(base, next === 0 ? name : besides[next - 1]);
            }
            const again = loadOnce(besides[next], flags);
            return typeof again === 'number' ? retry(again, next + 1)
                : again.then(found=>retry(found, next + 1));
        };
        return typeof answer === 'number' ? retry(answer, 0)
            : answer.then(found=>retry(found, 0));
    };

    /**
     * The places a load with these LoadLibraryEx flags looks in instead of the
     * standard search, as LOAD_LIBRARY_SEARCH_* bits with DEFAULT_DIRS spelled
     * out: the flags' own, or the default SetDefaultDllDirectories set for a
     * load that names none. Zero is the standard search, which
     * LOAD_WITH_ALTERED_SEARCH_PATH also keeps.
     *
     * @param {number} flags
     */
    const searchOf = flags=>{
        const search = (flags & SEARCH_FLAGS) !== 0 ? flags & SEARCH_FLAGS
            : (flags & LOAD_WITH_ALTERED_SEARCH_PATH) !== 0 ? 0 : defaultDirectories;
        return (search & SEARCH_DEFAULT_DIRS) !== 0
            ? search | SEARCH_APPLICATION_DIR | SEARCH_USER_DIRS | SEARCH_SYSTEM32 : search;
    };

    /**
     * The directories LOAD_LIBRARY_SEARCH_USER_DIRS looks in: AddDllDirectory's, the one
     * added last first, then SetDllDirectory's (Wine's kernel32:module, test_LoadLibraryEx).
     */
    const userSearched = ()=>/** @type {string[]} */ ([...userDirectories.values()].reverse()
        .concat(dllDirectory ?? '').filter(directory=>directory !== ''));

    /**
     * One look for a library by the name given.
     *
     * @param {string} name @param {number} flags
     * @param {LibrarySearch} [search]  Where a
     *     LOAD_LIBRARY_SEARCH_* search looks instead.
     * @returns {number | Promise<number>}
     */
    const loadOnce = (name, flags, search = undefined)=>{
        // Through the loader even for a module already here: only it knows
        // whether this is the load that has to run the module's entry point.
        if (host.load)
        {
            const answer = search ? host.load(name, flags, search) : host.load(name, flags);
            return typeof answer === 'number' && answer === 0 && !search
                && (flags & LOAD_AS_DATA) === 0 ? host.find(name)?.base ?? 0 : answer;
        }
        return host.find(name)?.base ?? 0;
    };

    /**
     * The places SetDefaultDllDirectories set for a load that names none
     * (LOAD_LIBRARY_SEARCH_* flags), zero for the standard search.
     */
    let defaultDirectories = 0;

    /**
     * What SetDllDirectory last named: null for the default search, an empty
     * string for the default without the current directory.
     *
     * @type {string | null}
     */
    let dllDirectory = null;
    /**
     * The directories AddDllDirectory added, by the cookie it handed back.
     *
     * @type {Map<number, string>}
     */
    const userDirectories = new Map();
    /** The next cookie: a nonzero value no other handle is, counting up. */
    let nextCookie = DLL_DIRECTORY_COOKIE_BASE;

    /**
     * GetModuleFileName, either width: the path and its terminator where they
     * fit, the length without it answered and the last error cleared; where
     * they do not, as many
     * characters as fit with the terminator last, nSize answered and
     * ERROR_INSUFFICIENT_BUFFER left - the one way a caller tells a cut path
     * from a whole one. No room at all is the same error and nothing written.
     *
     * @param {number} handle @param {number} buffer @param {number} size
     * @param {boolean} wide
     */
    const moduleFileName = (handle, buffer, size, wide)=>{
        const module = handle === 0 ? host.find(null) : host.byBase(handle >>> 0);
        if (!module)
        {
            host.setLastError(ERROR_MOD_NOT_FOUND);
            return 0;
        }
        const path = handle === 0 ? host.imagePath() : fileNameOf(module);
        const room = size >>> 0;
        if (room === 0)
        {
            host.setLastError(ERROR_INSUFFICIENT_BUFFER);
            return 0;
        }
        const fits = path.length < room;
        const kept = `${fits ? path : path.slice(0, room - 1)}\0`;
        if (wide)
        {
            guest.setBytes(wholeAddress(buffer), utf16(kept));
        }
        else
        {
            guest.setBytes(wholeAddress(buffer), encodeAnsi(kept));
        }
        // A whole path clears the last error, as Windows' does.
        host.setLastError(fits ? 0 : ERROR_INSUFFICIENT_BUFFER);
        return fits ? path.length : room;
    };

    /**
     * A module's path or its file name, ANSI or wide, cut to `size`
     * characters with the terminator inside them; the characters written.
     *
     * @param {number} handle @param {number} buffer @param {number} size
     * @param {boolean} wide @param {boolean} baseName
     */
    const moduleText = (handle, buffer, size, wide, baseName)=>{
        const module = handle === 0 ? host.find(null) : host.byBase(handle >>> 0);
        if (!module)
        {
            host.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        }
        const path = handle === 0 ? host.imagePath() : fileNameOf(module);
        return cutText(baseName ? path.slice(path.lastIndexOf(SEPARATOR) + 1) : path,
            buffer, size, wide);
    };

    /**
     * Text cut to `size` characters with the terminator inside them, ANSI or
     * wide, as psapi's name queries write it; the characters written.
     *
     * @param {string} text @param {number} buffer @param {number} size @param {boolean} wide
     */
    const cutText = (text, buffer, size, wide)=>{
        if ((size >>> 0) === 0)
        {
            host.setLastError(ERROR_INSUFFICIENT_BUFFER);
            return 0;
        }
        if (!wide)
        {
            return guest.writeAnsi(wholeAddress(buffer), text, size >>> 0);
        }
        const kept = text.slice(0, (size >>> 0) - 1);
        guest.setBytes(wholeAddress(buffer), utf16z(kept));
        return kept.length;
    };

    /**
     * DWORD K32GetMappedFileNameA/W(HANDLE hProcess, LPVOID lpv, LPSTR/LPWSTR
     *     lpFilename, DWORD nSize)
     *
     * The file mapped at an address, in the object manager's terms: here an
     * image of the process, whose span its headers give (SizeOfImage), named
     * as GetModuleFileName names it - one of the system's libraries under the
     * folder it is found in. An
     * address no image covers has no file: ERROR_UNEXP_NET_ERR, as Windows
     * answers memory of its own (Wine's psapi test).
     * ponytail: images only; a view of a file a program mapped itself is
     * answered the same way once a program asks for one.
     *
     * @param {boolean} wide
     */
    const mappedFileName = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([process, address, buffer, size])=>{
            // Another process's memory is not this one's to read.
            if ((process >>> 0) !== 0xffffffff)
            {
                host.setLastError(ERROR_INVALID_HANDLE);
                return 0;
            }
            const at = wholeAddress(address);
            const read = (/** @type {number} */ where)=>new DataView(
                guest.snapshot(where, 4).buffer ?? new ArrayBuffer(4))
                .getUint32(0, true);
            const image = (host.list?.() ?? []).find(module=>at >= module.base
                && at < module.base + read(module.base + read(module.base + 0x3c) + 24 + 56));
            const path = image ? host.nativePath?.(fileNameOf(image)) ?? null : null;
            if (path === null)
            {
                host.setLastError(ERROR_UNEXP_NET_ERR);
                return 0;
            }
            return cutText(path, buffer, size, wide);
        },
    });

    /**
     * @param {number} size @param {number} buffer @param {boolean} wide
     */
    const getDllDirectory = (size, buffer, wide)=>{
        const text = dllDirectory ?? '';
        if (text.length + 1 > size || buffer === 0)
        {
            // A buffer with room for anything is left an empty string, as
            // Windows leaves it; one of no size is not touched.
            if (size > 0 && buffer !== 0)
            {
                guest.setBytes(buffer, new Uint8Array(wide ? 2 : 1));
            }
            return text.length + 1;
        }
        if (wide)
        {
            guest.setBytes(buffer, utf16z(text));
        }
        else
        {
            guest.setBytes(buffer, encodeAnsi(`${text}\0`));
        }
        return text.length;
    };

    /** A NULL name, or the reserved file handle given: no library, and nothing read. */
    const noName = ()=>{
        host.setLastError(ERROR_INVALID_PARAMETER);
        return 0;
    };

    /** @param {number} handle */
    const freeLibrary = handle=>{
        const module = host.byBase(handle >>> 0) ?? host.dataFile?.(handle >>> 0) ?? null;
        if (!module)
        {
            // A handle with the low bits set is a data file's, and one
            // that names no mapping is not an image at all.
            host.setLastError(
                (handle & 3) !== 0 ? ERROR_BAD_EXE_FORMAT : ERROR_MOD_NOT_FOUND);
            return 0;
        }
        return module.release ? module.release() : 1;
    };

    /** A module handle's bytes: a quadword in a 64-bit process. */
    const handleSize = host.pointerSize ?? 4;
    /**
     * As many module handles as fit in `size` bytes, the image first, and the bytes
     * all of them take: what EnumProcessModules writes.
     *
     * @param {number} handles @param {number} size @param {number} needed
     */
    const enumModules = (handles, size, needed)=>{
        if ((needed >>> 0) === 0)
        {
            host.setLastError(ERROR_NOACCESS);
            return 0;
        }
        const bases = (host.list?.() ?? []).map(module=>module.base >>> 0);
        const fits = Math.min(bases.length, Math.floor((size >>> 0) / handleSize));
        if (fits > 0)
        {
            const out = new DataView(new ArrayBuffer(fits * handleSize));
            bases.slice(0, fits).forEach((base, at)=>out.setUint32(at * handleSize, base, true));
            guest.setBytes(wholeAddress(handles), new Uint8Array(out.buffer));
        }
        const total = new DataView(new ArrayBuffer(4));
        total.setUint32(0, bases.length * handleSize, true);
        guest.setBytes(wholeAddress(needed), new Uint8Array(total.buffer));
        return 1;
    };

    /**
     * The directories a library is looked for in (`DLL_SEARCH_PATH`): under
     * LOAD_LIBRARY_SEARCH_* flags, or the default SetDefaultDllDirectories
     * set, the library's own directory (DLL_LOAD_DIR), the program's, the
     * user's and the system directory; otherwise the standard search, the
     * program's directory - or the library's, for LOAD_WITH_ALTERED_SEARCH_PATH
     * - SetDllDirectory's, the system's three, the current one (`.`, unless
     * SetDllDirectory took it out) and PATH's.
     *
     * @param {string} module @param {number} flags
     * @returns {string[]}
     */
    const searchPath = (module, flags)=>{
        const image = host.imagePath();
        const program = image.slice(0, Math.max(image.lastIndexOf(SEPARATOR), 0));
        const own = /[\\/]/.test(module)
            ? module.slice(0, Math.max(module.lastIndexOf(SEPARATOR), module.lastIndexOf('/')))
            : null;
        const search = searchOf(flags);
        if (search !== 0)
        {
            return [
                ...(search & SEARCH_DLL_LOAD_DIR) !== 0 && own !== null ? [own] : [],
                ...(search & SEARCH_APPLICATION_DIR) !== 0 ? [program] : [],
                ...(search & SEARCH_USER_DIRS) !== 0 ? userSearched() : [],
                ...(search & SEARCH_SYSTEM32) !== 0 ? [SYSTEM32_DIRECTORY] : [],
            ];
        }
        return [
            (flags & LOAD_WITH_ALTERED_SEARCH_PATH) !== 0 && own !== null ? own : program,
            ...dllDirectory ? [dllDirectory] : [],
            SYSTEM32_DIRECTORY, SYSTEM16_DIRECTORY, WINDOWS_DIRECTORY,
            ...dllDirectory === null ? ['.'] : [],
            ...(host.environmentVariable?.('PATH') ?? '').split(';')
                .filter(directory=>directory !== ''),
        ];
    };

    return {
        [DLL_SEARCH_PATH]: searchPath,
        /**
         * HMODULE LoadLibraryA(LPCSTR lpLibFileName)
         *
         * An HMODULE is the base address the module is mapped at, which is why
         * a program can pass one straight to GetProcAddress and why some pass
         * it to code that reads the PE header there.
         */
        LoadLibraryA: {
            returns: 'pointer',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>(wholeAddress(name) === 0 ? noName()
                : load(guest.cstr(wholeAddress(name), WHOLE_NAME))),
        },

        /**
         * HMODULE LoadLibraryExA(LPCSTR lpLibFileName, HANDLE hFile, DWORD dwFlags)
         * HMODULE LoadLibraryExW(LPCWSTR lpLibFileName, HANDLE hFile, DWORD dwFlags)
         *
         * The flags say how the library is loaded -- as data for its resources,
         * or mapped without its imports resolved or its entry point run -- and
         * the loader acts on them. hFile is reserved and must be NULL.
         */
        LoadLibraryExA: {
            returns: 'pointer',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, file, flags])=>{
                if ((file >>> 0) !== 0 || wholeAddress(name) === 0)
                {
                    return noName();
                }
                return load(guest.cstr(wholeAddress(name), WHOLE_NAME), flags >>> 0);
            },
        },
        LoadLibraryExW: {
            returns: 'pointer',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name, file, flags])=>{
                if ((file >>> 0) !== 0 || wholeAddress(name) === 0)
                {
                    return noName();
                }
                return load(guest.wstr(wholeAddress(name), WHOLE_NAME * 2), flags >>> 0);
            },
        },

        /**
         * BOOL SetDllDirectoryA/W(LPCSTR lpPathName) and
         * DWORD GetDllDirectoryA/W(DWORD nBufferLength, LPSTR lpBuffer)
         *
         * The directory LoadLibrary looks in for a bare name (`load`); NULL
         * puts the default search back. Getting it answers as the path calls
         * do: the length without the terminator when it fits, the size
         * needed with it when it does not, and an empty string when none is
         * set.
         */
        SetDllDirectoryA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>{
                dllDirectory = (path >>> 0) === 0 ? null : guest.cstr(wholeAddress(path),
                    WHOLE_NAME);
                return 1;
            },
        },
        /**
         * BOOL SetDefaultDllDirectories(DWORD DirectoryFlags)
         *
         * Narrows where LoadLibrary looks to the flags' directories, which a
         * program sets once at its start to keep its own directory and the
         * current one out of the search: every load that names no
         * LOAD_LIBRARY_SEARCH_* flags of its own searches as if it had named
         * these. A flag outside the documented set is ERROR_INVALID_PARAMETER.
         */
        SetDefaultDllDirectories: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([flags])=>{
                if ((flags >>> 0) === 0 || ((flags >>> 0) & ~DEFAULT_DLL_DIRECTORIES) !== 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                defaultDirectories = flags >>> 0;
                return 1;
            },
        },
        /**
         * DLL_DIRECTORY_COOKIE AddDllDirectory(PCWSTR NewDirectory)
         *
         * A directory searched for a bare name after the default search (and
         * after SetDllDirectory's), until RemoveDllDirectory takes it out; a
         * path that is not absolute is ERROR_INVALID_PARAMETER and no cookie.
         */
        AddDllDirectory: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>{
                const directory = wholeAddress(path) === 0 ? ''
                    : guest.wstr(wholeAddress(path), MAX_NAME * 2);
                if (!/^([a-z]:\\|\\\\)/i.test(directory))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const cookie = nextCookie;
                nextCookie += 4;
                userDirectories.set(cookie, directory);
                return cookie;
            },
        },

        /** BOOL RemoveDllDirectory(DLL_DIRECTORY_COOKIE Cookie): a cookie never handed out refused. */
        RemoveDllDirectory: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([cookie])=>{
                if (!userDirectories.delete(cookie >>> 0))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                return 1;
            },
        },

        SetDllDirectoryW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>{
                dllDirectory = (path >>> 0) === 0 ? null
                    : guest.wstr(wholeAddress(path), MAX_NAME * 2);
                return 1;
            },
        },
        GetDllDirectoryA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, buffer])=>getDllDirectory(size >>> 0, wholeAddress(buffer), false),
        },
        GetDllDirectoryW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, buffer])=>getDllDirectory(size >>> 0, wholeAddress(buffer), true),
        },

        /** BOOL FreeLibrary(HMODULE hLibModule) */
        FreeLibrary: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>freeLibrary(handle),
        },

        /**
         * VOID FreeLibraryAndExitThread(HMODULE hLibModule, DWORD dwExitCode) --
         * does not return
         *
         * What a thread running a library's code calls to unload that library
         * and end itself, which it could not do in two calls.
         */
        FreeLibraryAndExitThread: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, code])=>{
                // Held before anything can wait: once the library's DllMain
                // has to hear the detach, this call is suspended and the loop
                // turns, and whichever thread is on the processor by the time
                // it is done -- if any, and on this executor at all -- is not
                // the one to end.
                const thread = host.currentThread?.();
                const freed = freeLibrary(handle);
                if (!(freed instanceof Promise))
                {
                    return host.exitThread?.(code >>> 0) ?? 0;
                }
                // Its call is no longer in flight to be parked; the answer it
                // is suspended on only has to arrive, and a thread that has
                // ended never returns to read it. Not before the libraries
                // still loaded are told of its end on it, as ExitThread tells
                // them: answered sooner, the call would resume the thread
                // under its own detach.
                return freed.then(()=>host.endThread?.(thread, code >>> 0) ?? 0);
            },
        },

        /**
         * BOOL DisableThreadLibraryCalls(HMODULE hLibModule)
         *
         * A library saying it does not want DLL_THREAD_ATTACH and
         * DLL_THREAD_DETACH for every thread that comes and goes: from now on
         * neither its entry point nor its TLS callbacks hear of a thread. Asked
         * from inside its own attach, as the documentation advises, and a
         * library that checks the answer is told yes -- also when it has static
         * thread-local storage, which goes on being told, the call making "no
         * optimisation" for it (decisions.md).
         */
        DisableThreadLibraryCalls: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const module = host.byBase(wholeAddress(handle));
                if (!module)
                {
                    host.setLastError(ERROR_MOD_NOT_FOUND);
                    return 0;
                }
                host.disableThreadCalls?.(wholeAddress(handle));
                return 1;
            },
        },

        /**
         * FARPROC DelayLoadFailureHook(LPCSTR pszDllName, LPCSTR pszProcName)
         *
         * The failure hook a library's delay-load helper may call when a
         * delay-loaded library or function is not there. NULL offers no
         * stand-in, and the helper raises its delay-load exception as it would
         * with no hook.
         */
        DelayLoadFailureHook: { returns: 'pointer', argBytes: 8, handler: ()=>0 },

        /**
         * FARPROC GetProcAddress(HMODULE hModule, LPCSTR lpProcName)
         *
         * The address is the export's own trampoline inside the module, the
         * same one its import table entry was bound to -- so a program that
         * compares the two finds them equal, as it does on Windows.
         */
        GetProcAddress: {
            returns: 'pointer',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, name])=>{
                // No module is the program's own, as GetModuleHandle(NULL)
                // answers it: what it does not export is a procedure not found.
                const module = wholeAddress(handle) === 0 ? host.find(null)
                    : host.byBase(wholeAddress(handle));
                if (!module)
                {
                    host.setLastError(wholeAddress(handle) === 0 ? ERROR_PROC_NOT_FOUND
                        : ERROR_MOD_NOT_FOUND);
                    return 0;
                }

                const ordinal = isOrdinal(wholeAddress(name)) ? wholeAddress(name) : null;
                const wanted = ordinal !== null ? `#${ordinal}`
                    : guest.cstr(wholeAddress(name), WHOLE_NAME);
                /** @param {{ address: number } | { error: number }} found */
                const answer = found=>{
                    const address = 'address' in found ? found.address : 0;
                    host.resolved?.({ module: module.name, name: wanted, found: address });
                    if ('error' in found)
                    {
                        host.setLastError(found.error);
                        return 0;
                    }
                    return address;
                };
                // Followed through the module's forwarders, a forwarder's
                // target loaded first when it is not yet (`exportOf`).
                const found = host.exportOf
                    ? host.exportOf(module, ordinal === null ? wanted : null, ordinal)
                    : definedExport(module, ordinal === null ? wanted : null, ordinal);
                return found instanceof Promise ? found.then(answer) : answer(found);
            },
        },

        /** HMODULE LoadLibraryW(LPCWSTR lpLibFileName) */
        LoadLibraryW: {
            returns: 'pointer',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>(wholeAddress(name) === 0 ? noName()
                : load(guest.wstr(wholeAddress(name), MAX_NAME * 2))),
        },

        /**
         * DWORD GetModuleFileNameW(HMODULE hModule, LPWSTR lpFilename, DWORD nSize)
         *
         * The same path as the ANSI form, written wide. A C runtime asks for its
         * own module path early and compares it with what it finds elsewhere, so
         * the two spellings must name one file.
         */
        GetModuleFileNameW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, buffer, size])=>moduleFileName(handle, buffer, size, true),
        },

        /**
         * BOOL K32GetModuleInformation(HANDLE hProcess, HMODULE hModule,
         *     LPMODULEINFO lpmodinfo, DWORD cb)
         *
         * psapi's GetModuleInformation as kernel32 exports it: where a module
         * of this process is mapped, the size of its image and where it starts,
         * read from its own headers -- a NULL handle is the program's.
         */
        K32GetModuleInformation: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, handle, info, size])=>{
                const module = handle === 0 ? host.find(null) : host.byBase(wholeAddress(handle));
                if (!module)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                if ((size >>> 0) < MODULEINFO_SIZE)
                {
                    host.setLastError(ERROR_INSUFFICIENT_BUFFER);
                    return 0;
                }
                const read = (/** @type {number} */ address)=>new DataView(
                    guest.snapshot(address, 4).buffer ?? new ArrayBuffer(4))
                    .getUint32(0, true);
                const optional = module.base + read(module.base + 0x3c) + 24;
                const entry = read(optional + 16);
                const out = new DataView(new ArrayBuffer(MODULEINFO_SIZE));
                out.setUint32(0, module.base, true);
                out.setUint32(4, read(optional + 56), true);
                out.setUint32(8, entry === 0 ? 0 : module.base + entry, true);
                guest.setBytes(wholeAddress(info), new Uint8Array(out.buffer));
                return 1;
            },
        },

        /**
         * BOOL K32EnumProcessModules(HANDLE hProcess, HMODULE *lphModule, DWORD cb,
         *     LPDWORD lpcbNeeded)
         *
         * psapi's EnumProcessModules: as many module handles as fit in `cb`
         * bytes, the image first, and in `lpcbNeeded` the bytes all of them
         * take -- a caller sizes its array from a first call that fits none.
         */
        K32EnumProcessModules: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, handles, size, needed])=>enumModules(handles, size, needed),
        },

        /**
         * BOOL K32EnumProcessModulesEx(HANDLE hProcess, HMODULE *lphModule, DWORD cb,
         *     LPDWORD lpcbNeeded, DWORD dwFilterFlag)
         *
         * The same, filtered to the 32- or 64-bit modules: every module of a process
         * is of its own width here, so the filter keeps them all.
         */
        K32EnumProcessModulesEx: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, handles, size, needed])=>enumModules(handles, size, needed),
        },

        /**
         * DWORD K32GetModuleFileNameExA(HANDLE hProcess, HMODULE hModule,
         *     LPSTR lpFilename, DWORD nSize) and the wide form: GetModuleFileName
         *     asked about a process, which here is always this one.
         */
        K32GetModuleFileNameExA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, handle, buffer, size])=>moduleText(handle, buffer, size, false, false),
        },
        K32GetModuleFileNameExW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, handle, buffer, size])=>moduleText(handle, buffer, size, true, false),
        },

        /**
         * DWORD K32GetModuleBaseNameA(HANDLE hProcess, HMODULE hModule,
         *     LPSTR lpBaseName, DWORD nSize) and the wide form: the file name
         *     of a module's path, without its directory.
         */
        K32GetModuleBaseNameA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, handle, buffer, size])=>moduleText(handle, buffer, size, false, true),
        },
        K32GetModuleBaseNameW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, handle, buffer, size])=>moduleText(handle, buffer, size, true, true),
        },

        K32GetMappedFileNameA: mappedFileName(false),
        K32GetMappedFileNameW: mappedFileName(true),

        /** DWORD GetModuleFileNameA(HMODULE hModule, LPSTR lpFilename, DWORD nSize) */
        GetModuleFileNameA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, buffer, size])=>moduleFileName(handle, buffer, size, false),
        },
    };
}
