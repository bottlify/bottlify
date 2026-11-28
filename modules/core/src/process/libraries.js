/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a process's loader knows of libraries without a process: the names a
 * load is tried under and the directories searched, how a library's export
 * table and resources are read, where a library is placed, the loader's
 * flags and the errors it answers - read by the process's library loader
 * (`app.js`) and nothing kept between calls.
 */

import { mangledCall } from '../layers/loader/internal/mangling.js';
import { parsePe, rvaToFileOffset } from '../layers/loader/internal/pe.js';
import { findResource, listResources } from '../layers/loader/internal/resources.js';
import { BLOCK_CACHE_BYTES } from '../layers/cache/account.js';

/**
 * One event's payload as a line.
 *
 * Built now rather than left as a template argument, which is the journal's
 * usual economy: an event carries an object, and an object read later is the
 * object as it ended up rather than as it was reported. Events are occasional
 * -- a library loading, a write, a failure -- so the string costs nothing that
 * matters, and it is the difference between a log that can be read and one
 * that says [object Object].
 *
 * @param {any} payload
 * @returns {string}
 */
export function describeEvent(payload){
    if (payload === null || payload === undefined)
    {
        return '';
    }
    if (typeof payload !== 'object')
    {
        return String(payload);
    }
    return Object.entries(payload)
        .map(([key, value])=>{
            if (value instanceof Error)
            {
                return `${key}=${value.message}`;
            }
            if (Array.isArray(value))
            {
                return `${key}=[${value.map(item=>(item !== null && typeof item === 'object'
                    ? JSON.stringify(item) : item)).join(' ')}]`;
            }
            // A picture's bytes are not a line: a cursor told every frame
            // would fill the journal with its pixels.
            if (ArrayBuffer.isView(value))
            {
                return `${key}=<${value.byteLength} bytes>`;
            }
            return `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`;
        })
        .join(' ');
}

/**
 * What a call to an import nothing claims may do: return to its caller, taking
 * the arguments it was passed off the stack as the caller expects, or not
 * return at all -- the stack is the one thing a stub must get right.
 *
 * A C++ name says its own convention and, mostly, its argument bytes: a C
 * runtime's classes are `thiscall` whatever the rest of the library is. A
 * `_name@N` name is stdcall with N bytes. Anything else is cdecl when its
 * library is, and otherwise stdcall with a count nobody knows. A library the
 * program brought is a mismatch between two of its own files, and answers
 * as its name says.
 *
 * @param {string | null} name
 * @param {{ own: boolean, cdeclLibrary: boolean }} library
 * @returns {{ returns: boolean, argBytes: number }}
 */
export function missingImportCall(name, { own, cdeclLibrary }){
    const mangled = name === null ? null : mangledCall(name);
    if (mangled)
    {
        return { returns: mangled.argBytes !== null || own, argBytes: mangled.argBytes ?? 0 };
    }
    const decorated = name === null ? null : /@(\d+)$/.exec(name);
    return {
        returns: decorated !== null || own || cdeclLibrary,
        argBytes: decorated ? Number(decorated[1]) : 0,
    };
}

/**
 * Binds an import nothing implements, once per label, and bounds what a
 * program that calls it in a loop does to the engine.
 *
 * Leaving the slot alone is not an option: it keeps what the file wrote -- the
 * relative address of the name block -- so a call through it jumps to a small
 * number, runs whatever bytes are there, and dies as an invalid opcode naming
 * an address that has nothing to do with the import. What is wanted instead is
 * the name.
 *
 * Whether the stub may return is decided by the one thing that must be right
 * for the program to go on: what the caller expects of the callee's stack
 * (`missingImportCall`). Where that is known the stub answers zero and returns;
 * where nobody knows the count -- an undecorated name from a stdcall library,
 * a C++ name whose arguments the name does not size -- no stub can return
 * without leaving the stack short, so the first call goes to `fault`, which
 * names the import and its caller and ends the run. That branch cannot flood,
 * since it happens once.
 *
 * The branch that can flood is the returning one. A program calls a missing
 * classifier once per character of every string, and announcing every call puts
 * tens of thousands of structured clones and wake-ups a second through the port
 * to the page, filling its queue until the program freezes. So the event fires
 * once per label, on the first call, which is all a person needs to see that
 * the import exists and is missing; every later call is counted for
 * `diagnostics` and written to the journal, which is a ring in shared memory
 * that never waits and can afford a record a call.
 *
 * @param {Object} deps
 * @param {(name: string, spec: Object) => number} deps.register
 *        The bridge's `register`; the address it answers is what the import
 *        binds to.
 * @param {ReturnType<typeof import('../events.js').createEvents>} deps.events
 * @param {{ write: (level: string, category: string, template: string,
 *     ...args: any[]) => void } | Record<string, any>} deps.journal
 *        The log's api; its `write` is what keeps a record of a call.
 * @param {(dll: string, name: string | null) => { own: boolean,
 *     returns: boolean, argBytes: number }} deps.classify
 *        What the library and the decoration say about the call.
 * @param {(label: string, frame: any) => number} deps.fault
 *        The non-returning branch: raise the fault, hold the thread, answer
 *        zero.
 * @returns {{ bind: (dll: string, name: string | null, ordinal: number | null)
 *     => number, calls: Map<string, number> }}
 */
export function createMissingImports({ register, events, journal, classify, fault }){
    /** @type {Map<string, number>} */
    const addresses = new Map();
    // How often a program actually called an import nothing claims. Binding one
    // is routine and mostly harmless -- a program imports far more than it
    // calls -- so the list of unresolved names says little on its own. Being
    // called is the event that matters, and without this counter it leaves no
    // trace anywhere a run can be read.
    /** @type {Map<string, number>} */
    const calls = new Map();

    /**
     * One stub per name, because a program is quite capable of calling the same
     * missing import a thousand times before it gives up.
     *
     * @param {string} label
     * @param {'program' | 'system'} origin
     * @param {boolean} returns
     */
    const handlerFor = (label, origin, returns)=>
        (/** @type {number[]} */ _args, /** @type {any} */ frame)=>{
            const count = (calls.get(label) ?? 0) + 1;
            calls.set(label, count);
            const payload = { import: label, origin, count };
            journal.write('warn', 'unimplemented', '{0}', describeEvent(payload));
            if (count === 1)
            {
                events.emit('unimplemented', payload);
            }
            if (returns)
            {
                // Zero, and back to the caller. It reads as failure for the
                // commonest shapes -- a null pointer, a null handle, FALSE, a
                // count of none -- so such a caller takes its own failure path
                // and says something about what it wanted. Not for every shape:
                // an HRESULT or an error code of zero is success, and a C
                // runtime call that fails with -1 or EOF (fgetc, _read) or
                // answers "not yet" with zero (feof) reads it as a result, which
                // can leave a read loop going round for ever. No one value
                // fails under every convention; this one fails under most.
                return 0;
            }
            return fault(label, frame);
        };

    /** @param {string} dll @param {string | null} name @param {number | null} ordinal */
    const bind = (dll, name, ordinal)=>{
        const label = `${dll}!${name ?? `#${ordinal}`}`;
        const known = addresses.get(label);
        if (known !== undefined)
        {
            return known;
        }
        const { own, returns, argBytes } = classify(dll, name);
        const address = register(label, {
            argBytes,
            handler: handlerFor(label, own ? 'program' : 'system', returns),
        });
        addresses.set(label, address);
        // Said at bind time as well as when called: a program that is about
        // to run is the moment to read what it imports and nobody answers,
        // before the first of them corrupts a stack.
        events.emit('import-unresolved', { import: label, origin: own ? 'program' : 'system' });
        return address;
    };

    return { bind, calls };
}

/**
 * The API sets Windows 10 resolves by its schema rather than by file, and the
 * library each is: a program imports `api-ms-win-crt-stdio-l1-1-0.dll` and is
 * bound to ucrtbase.dll, which GetModuleHandle names it too -- one module, not
 * a copy for each set, and a copy of one a program carries is never loaded.
 * The core sets are kernelbase's on Windows, whose functions kernel32 holds
 * here, but for the registry, event tracing and security ones, which are
 * advapi32's, and the Windows Runtime's, which are combase's; the first match
 * wins.
 *
 * @type {[RegExp, string][]}
 */
const API_SETS = [
    [/^api-ms-win-crt-[a-z0-9-]+$/, 'ucrtbase'],
    [/^api-ms-win-(core-(localregistry|registry)|eventing|security)-[a-z0-9-]+$/, 'advapi32'],
    [/^api-ms-win-core-winrt-[a-z0-9-]+$/, 'combase'],
    [/^api-ms-win-shcore-[a-z0-9-]+$/, 'shcore'],
    [/^api-ms-win-power-[a-z0-9-]+$/, 'powrprof'],
    [/^api-ms-win-core-(?!winrt|com-)[a-z0-9-]+$/, 'kernel32'],
];

/**
 * The key a module is known by: its file name, without directory, case or
 * the extension a program is free to leave off.
 *
 * A library is asked for by bare name in an import descriptor and by full
 * path from a loader that found the file itself, and both must find the one
 * module -- a second copy at a second address has globals its first copy's
 * callers do not share.
 *
 * @param {string} name
 */
export function moduleKeyOf(name){
    const file = name.slice(Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1);
    const key = file.toLowerCase().replace(/\.dll$/, '');
    return API_SETS.find(([set])=>set.test(key))?.[1] ?? key;
}

/**
 * Where a program starts: its own directory.
 *
 * That is where the shell puts a process it starts from an icon or a disc's
 * autorun, and a program that opens its files by bare name -- a companion
 * library, a configuration beside it -- is written against it. The root of
 * the drive keeps its backslash, since `C:` alone names a drive's current
 * directory rather than its root.
 *
 * @param {string} imagePath
 */
export function startDirectoryOf(imagePath){
    const cut = Math.max(imagePath.lastIndexOf('\\'), imagePath.lastIndexOf('/'));
    const directory = imagePath.slice(0, cut + 1);
    return /^[A-Za-z]:[\\/]$/.test(directory) ? directory : directory.replace(/[\\/]$/, '');
}

/**
 * The one place a library name fixes, or null when the name is searched for.
 *
 * A name that already says where it is, is where it is: a full path, a path
 * from the root of the current drive, one from the current directory of a
 * drive (`C:plugins\x.dll`) and one that starts at the current directory
 * (`.\x.dll`, `..\x.dll`). Prefixing one again asks for C:\App\C:\App\...,
 * which is not there, and the library is reported missing while sitting
 * exactly where it was asked for. Any other name - a bare one, or a relative
 * one with a directory in it (`plugins\x.dll`) - is searched for, each place
 * of the search taking the name after it, as LoadLibrary's documentation
 * says of a relative path.
 *
 * @param {string} name
 * @param {string} [currentDirectory]  The process's, which a drive-relative or
 *     dot-relative name starts from.
 * @returns {string | null}
 */
export function fixedLibraryPath(name, currentDirectory){
    if (/^[A-Za-z]:[\\/]/.test(name) || /^[\\/]/.test(name))
    {
        return name;
    }
    const here = currentDirectory?.replace(/[\\/]+$/, '');
    const drive = /^([A-Za-z]):(.*)$/.exec(name);
    if (drive)
    {
        const onDrive = here && here[0].toLowerCase() === drive[1].toLowerCase();
        return `${onDrive ? here : `${drive[1]}:`}\\${drive[2]}`;
    }
    if (/^\.\.?[\\/]/.test(name) && here)
    {
        return `${here}\\${name}`;
    }
    return null;
}

/**
 * The file LoadLibrary looks for under a name: one whose last component has no
 * extension gets `.dll`, and a trailing dot says "no extension" and is dropped.
 * A program that asks for `rglsw` means `rglsw.dll`.
 *
 * @param {string} name
 * @returns {string}
 */
export function withLibraryExtension(name){
    if (name.endsWith('.'))
    {
        return name.slice(0, -1);
    }
    const file = name.slice(Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1);
    return file.includes('.') ? name : `${name}.dll`;
}

/**
 * An image's exports as its module hands them out: by name and by ordinal,
 * the address of one the image defines, or the forwarder string ("LIB.Name",
 * "LIB.#7") of one that names another library's export (PE/COFF 6.3.2), which
 * `exportOf` follows.
 *
 * @param {{ name: string | number | null, ordinal: number, rva: number,
 *     forwards: string | null }[]} exports
 * @param {number} base
 */
export function exportTables(exports, base){
    /** @type {Map<string, number | string>} */
    const byName = new Map();
    /** @type {Map<number, number | string>} */
    const byOrdinal = new Map();
    for (const entry of exports)
    {
        const value = entry.forwards ?? base + entry.rva;
        if (entry.name !== null)
        {
            byName.set(String(entry.name), value);
        }
        byOrdinal.set(entry.ordinal, value);
    }
    /** @param {number | string | undefined} value */
    const address = value=>(typeof value === 'number' ? value : null);
    /** @param {number | string | undefined} value */
    const forward = value=>(typeof value === 'string' ? value : null);
    return {
        /** @param {string} exported */
        addressOf: exported=>address(byName.get(exported)),
        /** @param {number} ordinal */
        addressOfOrdinal: ordinal=>address(byOrdinal.get(ordinal)),
        /** @param {string | null} exported @param {number | null} ordinal */
        forwardOf: (exported, ordinal)=>forward(exported !== null ? byName.get(exported)
            : byOrdinal.get(ordinal ?? -1)),
    };
}

/** RT_MANIFEST: an image's manifests, 1 a program's own and 2 a library's. */
export const RT_MANIFEST = 24;

export const ISOLATIONAWARE_MANIFEST = 2;

/** Where Windows looks for a bare library name after the program's own directory. */
export const SYSTEM_LIBRARY_DIRECTORIES = ['C:\\WINDOWS\\system32\\', 'C:\\WINDOWS\\'];

/**
 * Every place a LoadLibrary at run time looks, in order: beside the
 * executable first, then the system directories -- which is where an
 * installer puts a library it brought and then loads by bare name -- then the
 * current directory, where XP's safe search mode puts it: a setup that changes
 * to a folder of its disc and loads a helper there by bare name finds it. A
 * name that fixes its place (`fixedLibraryPath`) is looked for nowhere else; a
 * relative one with a directory in it is searched for as a bare one is.
 *
 * `ours` drops the system directories: for a name the engine's own table
 * already answers, the system's copy is the engine's, and a runtime an
 * installer put there is not loaded beside it. Two of one library in a process
 * -- the installed D3DX compiling an effect our D3DX is then asked to read --
 * is a format neither side shares.
 *
 * `from` replaces the program's directory with a library's own, as
 * LOAD_WITH_ALTERED_SEARCH_PATH has Windows search for that library's imports;
 * `path` is the directories of the process's PATH, searched last. `only` is
 * the whole search instead, the directories LoadLibraryEx's
 * LOAD_LIBRARY_SEARCH_* flags allow (`searchedDirectories`).
 *
 * @param {string} name
 * @param {string} imagePath
 * @param {string} [currentDirectory]
 * @param {{ ours?: boolean, from?: string, path?: string[], only?: string[] }} [how]
 * @returns {string[]}
 */
export function libraryCandidates(name, imagePath, currentDirectory, how = {}){
    const fixed = fixedLibraryPath(name, currentDirectory);
    if (fixed !== null)
    {
        return [fixed];
    }
    /** @param {string} directory */
    const inside = directory=>`${directory.replace(/[\\/]+$/, '')}\\${name}`;
    if (how.only)
    {
        return how.only.map(inside);
    }
    const first = `${imagePath.slice(0, imagePath.lastIndexOf('\\') + 1)}${name}`;
    const places = [how.from ? inside(how.from) : first,
        ...how.ours ? [] : SYSTEM_LIBRARY_DIRECTORIES.map(directory=>directory + name)];
    for (const directory of [currentDirectory, ...how.path ?? []])
    {
        const place = directory ? inside(directory) : null;
        if (place && !places.some(known=>known.toLowerCase() === place.toLowerCase()))
        {
            places.push(place);
        }
    }
    return places;
}

/**
 * Where LoadLibraryEx looks under its LOAD_LIBRARY_SEARCH_* flags, in the
 * order its documentation gives: the loading library's own directory
 * (LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, for that library's imports), the
 * program's, the ones AddDllDirectory and SetDllDirectory named, and the
 * system directory. Nothing else is looked in - not the current directory,
 * not PATH. Undefined for the standard search.
 *
 * @param {import('../layers/win32/kernel32/modules.js').LibrarySearch | null | undefined} search
 * @param {string} imagePath
 * @returns {string[] | undefined}
 */
export function searchedDirectories(search, imagePath){
    if (!search)
    {
        return undefined;
    }
    return [
        ...search.from ? [search.from] : [],
        ...search.application ? [startDirectoryOf(imagePath)] : [],
        ...search.user,
        ...search.system ? [SYSTEM_LIBRARY_DIRECTORIES[0]] : [],
    ];
}

/**
 * The directories of a PATH value: separated by semicolons, quotes taken off,
 * the empty ones and those not on a drive (a relative entry) left out.
 *
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function pathDirectories(value){
    return (value ?? '').split(';').map(entry=>entry.trim().replace(/^"(.*)"$/, '$1'))
        .filter(entry=>/^[a-z]:[\\/]/i.test(entry));
}

/**
 * What a mapped library's base is rounded up to.
 *
 * Where they start is not a constant: it is wherever the system modules end,
 * because a fixed address chosen in advance is a guess about how much memory
 * the machine was given, and a wrong guess maps a library outside guest RAM.
 */
export const LIBRARY_ALIGN = 0x10000;

export const LDR_DLL_NOTIFICATION_REASON_LOADED = 1;

export const LDR_DLL_NOTIFICATION_REASON_UNLOADED = 2;

/** LoadLibraryEx's flags: mapped with nothing resolved or run, or loaded as data. */
export const DONT_RESOLVE_DLL_REFERENCES = 0x1;

const LOAD_LIBRARY_AS_DATAFILE = 0x2;

export const LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x20;

export const LOAD_LIBRARY_AS_DATAFILE_EXCLUSIVE = 0x40;

/** A library named by its path has its imports looked for in its own directory first. */
export const LOAD_WITH_ALTERED_SEARCH_PATH = 0x8;

export const LOAD_AS_DATA = LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE
    | LOAD_LIBRARY_AS_DATAFILE_EXCLUSIVE;

/** LoadLibrary's error for a file that is no image for the process. */
export const ERROR_BAD_EXE_FORMAT = 193;

export const ERROR_NOT_ENOUGH_MEMORY = 8;

/** What an export forwarded to a library found nowhere, or to a name it lacks, answers. */
export const ERROR_MOD_NOT_FOUND = 126;

export const ERROR_PROC_NOT_FOUND = 127;

/**
 * How many forwarders an export is followed through: one more is the image's
 * fault, ERROR_BAD_EXE_FORMAT, as a forwarder to itself is (Wine's loader
 * test, test_export_forwarder_loop: 32 are followed, the 33rd refused).
 */
export const FORWARD_HOPS = 32;

/** LoadLibrary's error for a library whose initialisation failed or raised. */
export const ERROR_DLL_INIT_FAILED = 1114;

/** A data file named by a path that is not there, as CreateFile answers it. */
export const ERROR_FILE_NOT_FOUND = 2;

/** A file another holds open without sharing reading. */
export const ERROR_SHARING_VIOLATION = 32;

/** An empty file, which no view can be made of. */
export const ERROR_FILE_INVALID = 1006;

/** A page: a view of a file is mapped in whole ones. */
export const PAGE_SIZE = 0x1000;

/**
 * One resource of an image's bytes, by type and numeric id -- or, for a null
 * id, the one of the type with the lowest numeric id, in whichever language,
 * as the loader takes an assembly's manifest out of its DLL -- or null for a
 * file that is not an image or has none.
 *
 * @param {Uint8Array | null} file @param {number} type @param {number | null} id
 * @returns {Uint8Array | null}
 */
export function resourceOfImage(file, type, id){
    if (!file)
    {
        return null;
    }
    try
    {
        const image = parsePe(file, { wide: true });
        // No id: the lowest numbered one, whatever languages it has; its
        // language then chosen as FindResource chooses one, neutral first.
        const name = id ?? listResources(file, image)
            .filter(entry=>entry.type === type && typeof entry.name === 'number')
            .map(entry=>Number(entry.name)).sort((a, b)=>a - b)[0];
        if (name === undefined)
        {
            return null;
        }
        const found = findResource(file, image, type, name);
        if (!found)
        {
            return null;
        }
        const at = rvaToFileOffset(image, found.rva);
        return file.slice(at, at + found.size);
    }
    catch {
        return null;
    }
}

/**
 * The most a host-side whole-file read asks of the volume at once: a quarter of
 * what a bundle's fetched blocks are held hot in, so one piece's blocks and the read-ahead
 * beside them are all still held when the read looks again.
 */
export const WHOLE_READ_BYTES = BLOCK_CACHE_BYTES / 4;

/**
 * Reads a whole file off the volume, waiting for whatever is not here yet.
 *
 * A read of a block that has not been fetched reports which blocks it needs
 * rather than waiting -- that is what lets a guest read look synchronous -- so
 * a host-side reader has to do what the guest's would: fetch, and look again.
 * This runs before the first guest instruction, so it may simply wait.
 *
 * A piece at a time (`WHOLE_READ_BYTES`), not the whole file in one read: where
 * the fetched blocks are held in the heap (no store, or one that refused them),
 * the cache keeps a bounded pool, and a file larger than it -- a program image
 * of a hundred megabytes -- was fetched, let go down to the pool and missed
 * again, for ever.
 *
 * Opened as the loader opens an image: for reading, sharing reading and
 * deletion, so a file a program holds open to delete on close - a library it
 * wrote out to load - is read, and one it holds open for writing is refused.
 *
 * @param {any} filesystem
 * @param {any} blocks
 * @param {string} path
 * @param {number} [piece]  the most one read asks for
 * @param {(code: string | undefined) => void} [refused]  Told why a file was
 *     not opened (the volume's error code: SHARING_VIOLATION for one held open
 *     for writing), for a caller that answers each reason apart.
 * @returns {Promise<Uint8Array | null>}
 */
export async function readWholeFile(filesystem, blocks, path, piece = WHOLE_READ_BYTES,
    refused = undefined)
{
    let handle;
    try
    {
        handle = filesystem.open(path, { shareDelete: true });
    }
    catch (e){
        refused?.(/** @type {any} */ (e)?.code);
        return null;
    }

    try
    {
        const size = filesystem.size(handle);
        const bytes = new Uint8Array(size);
        let at = 0;
        while (at < size)
        {
            let chunk;
            try
            {
                chunk = filesystem.read(handle, Math.min(size - at, piece));
            }
            catch (e){
                const miss = /** @type {any} */ (e);
                if (miss?.code !== 'BLOCK_MISS' || !blocks)
                {
                    throw miss;
                }
                await blocks.fetch(miss.blocks);
                continue;
            }
            if (chunk.length === 0)
            {
                break;
            }
            bytes.set(chunk, at);
            at += chunk.length;
        }
        return bytes.subarray(0, at);
    }
    finally
    {
        filesystem.close(handle);
    }
}

/**
 * Where a library goes.
 *
 * One that carries relocations takes the first base at or after `next` that
 * nothing holds. One that does not can run only at its preferred base -- every
 * absolute address in it assumes that base -- and takes it when it lies in the
 * modules' space and nothing holds it, or when `claim` can give up that span
 * from elsewhere: a base such a library names is free memory of a new process
 * on Windows, whatever this layout has put there. Otherwise, with its
 * relocations marked stripped (IMAGE_FILE_RELOCS_STRIPPED), it is refused, as
 * the PE format says a loader refuses such an image; without that mark it is
 * placed as a movable one is, nothing fixed up, as Windows' loader moves an
 * image whose relocation directory is merely absent. A library that can move and finds
 * the modules' space full is put wherever `claim` finds room, as Windows puts
 * one in any free span.
 *
 * @param {{ relocatable: boolean, imageBase: number, sizeOfImage: number,
 *     relocsStripped?: boolean }} image
 * @param {{ next: number, floor: number, limit: number,
 *     holder: (base: number, size: number) => { base: number, size: number } | null,
 *     claim?: (base: number | null, size: number) => number }} space
 *        `floor` and `limit` bound the modules' space: below is the program and
 *        the engine's own, above the thread stacks and the heap. `holder`
 *        answers what already holds part of a span, if anything; `claim` takes
 *        a span outside the space -- at a base, or anywhere for null -- and
 *        answers where, or zero when there is none.
 * @returns {{ base: number } | { refused: string }}
 */
export function placeLibrary(image, { next, floor, limit, holder, claim }){
    if (!image.relocatable)
    {
        const base = image.imageBase;
        if ((base >= floor && base + image.sizeOfImage <= limit
            && !holder(base, image.sizeOfImage)) || claim?.(base, image.sizeOfImage) === base)
        {
            return { base };
        }
        if (image.relocsStripped !== false)
        {
            return { refused: `no relocations, and 0x${base.toString(16)} is not free` };
        }
    }
    // On a 64 KiB granule, as Windows maps every image: the CLR refuses a
    // native image that lies elsewhere.
    let base = Math.ceil(next / LIBRARY_ALIGN) * LIBRARY_ALIGN;
    // Past the limit there is nothing more to search, and a holder that spans
    // to the end of the space answers there for ever.
    for (let held = holder(base, image.sizeOfImage); held && base + image.sizeOfImage <= limit;
        held = holder(base, image.sizeOfImage))
    {
        base = Math.ceil((held.base + held.size) / LIBRARY_ALIGN) * LIBRARY_ALIGN;
    }
    if (base + image.sizeOfImage > limit)
    {
        const anywhere = claim?.(null, image.sizeOfImage) ?? 0;
        return anywhere === 0 ? { refused: 'no room' } : { base: anywhere };
    }
    return { base };
}
