/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Resources: what a program packed into its own image and reads back at runtime.
 *
 * Four calls that look like a pipeline and are not. FindResource locates an
 * entry, SizeofResource says how long it is, LoadResource is documented as
 * loading it and LockResource as pinning it — but the bytes were mapped with
 * the image and were never anywhere else, so LoadResource is arithmetic and
 * LockResource the identity. Both still exist because a program calls all four
 * in order and checks each result.
 *
 * The reader itself lives in the loader, where the PE format is understood, and
 * arrives through the host. This layer may not reach into that one, and the
 * split is worth keeping for a reason beyond the boundary check: what a
 * resource *means* is this file's business, and where it sits in a file is not.
 */

/** Codes this surface reports. */
const ERROR_RESOURCE_DATA_NOT_FOUND = 1812;
const ERROR_RESOURCE_TYPE_NOT_FOUND = 1813;
const ERROR_RESOURCE_NAME_NOT_FOUND = 1814;
const ERROR_RESOURCE_LANG_NOT_FOUND = 1815;

/**
 * A pointer below this cannot be a string, so it is an integer identifier.
 * MAKEINTRESOURCE is exactly this trick, and the reason no resource name may
 * live in the first 64 KiB of the address space.
 */
const MAX_INTEGER_RESOURCE = 0x10000;

/** A resource name is at most this long; longer is a pointer that is not one. */
const MAX_NAME = 260;

/**
 * What a found resource is, from the guest's side.
 *
 * @typedef {Object} FoundResource
 * @property {number} rva   Where it sits in the image that holds it.
 * @property {number} size
 * @property {number} base  The module it came out of.
 */

/**
 * @typedef {Object} ResourceHost
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} [readWideString]
 *           For the W calls' names. Absent, a W call finds by integer
 *           identifier alone.
 * @property {(code: number) => void} setLastError
 * @property {(instance: number, type: number | string, name: number | string,
 *            language?: number | null) => { rva: number, size: number } | null} findResource
 *           The loader's reader, bound to a module. An instance of zero means
 *           the running program, which is what a program passes for its own.
 *           No language means the first there is.
 * @property {(instance: number) => { type: number | string, name: number | string,
 *            language: number }[]} [listResources]
 *           Everything that module carries, for the enumerations. Absent in a
 *           build with no loader behind it, and then a module carries nothing.
 * @property {(instance: number) => number} moduleBase
 *           Where that module was mapped, so an RVA can become an address.
 * @property {(entry: number, args: number[], thread?: unknown) => number | Promise<number>} [call]
 *           Runs an enumeration callback. Absent in a build with no bridge.
 * @property {() => unknown} [callerThread]
 *           The thread whose call is being answered, named on every callback
 *           after the first because the bridge has let the call go by then.
 */

/**
 * @param {ResourceHost} host
 */
export function createResourceFunctions(host){
    /**
     * Everything FindResource hands out, by the number the guest holds.
     *
     * A HRSRC is opaque and is only ever passed back to us, so it can be a
     * small integer rather than a pointer into anything. Keeping the record
     * here is what lets SizeofResource answer without finding the resource
     * again -- and a program calls it on every resource it loads.
     *
     * @type {Map<number, FoundResource>}
     */
    const found = new Map();
    let nextHandle = 4;

    /**
     * A resource type or name argument. Below 64 KiB it is an integer; above,
     * a pointer to a string. Reading the wrong one of the two turns a numeric
     * type into a wild pointer. A string that is `#` and decimal digits names
     * that integer, which is how a resource script's numeric id travels as
     * text.
     *
     * @param {number} value
     * @param {boolean} [wide]
     * @returns {number | string | null}  null for a wide name there is no reader for
     */
    const identifier = (value, wide = false)=>{
        const raw = value >>> 0;
        if (raw < MAX_INTEGER_RESOURCE)
        {
            return raw;
        }
        if (wide && !host.readWideString)
        {
            return null;
        }
        const text = wide
            ? /** @type {NonNullable<typeof host.readWideString>} */ (host.readWideString)(
                raw, MAX_NAME)
            : host.readCString(raw, MAX_NAME);
        const numbered = /^#(\d+)$/.exec(text);
        if (numbered)
        {
            const number = Number(numbered[1]);
            return number < MAX_INTEGER_RESOURCE ? number : text;
        }
        return text;
    };

    /** @param {number} code */
    const fail = code=>{
        host.setLastError(code);
        return 0;
    };

    /** @param {number | string} key @param {number | string | null} asked */
    const sameKey = (key, asked)=>typeof key === 'string' && typeof asked === 'string'
        ? key.toLowerCase() === asked.toLowerCase()
        : key === asked;

    /**
     * Which level of the tree a failed lookup stopped at: Windows says whether
     * the type, the name within it or the language was missing, and a program
     * that falls back from one language to another reads which.
     *
     * @param {number} instance @param {number | string | null} type
     * @param {number | string | null} name
     */
    const missing = (instance, type, name)=>{
        const listed = host.listResources?.(instance);
        if (!listed)
        {
            return ERROR_RESOURCE_TYPE_NOT_FOUND;
        }
        const ofType = listed.filter(entry=>sameKey(entry.type, type));
        if (ofType.length === 0)
        {
            return ERROR_RESOURCE_TYPE_NOT_FOUND;
        }
        return ofType.some(entry=>sameKey(entry.name, name))
            ? ERROR_RESOURCE_LANG_NOT_FOUND : ERROR_RESOURCE_NAME_NOT_FOUND;
    };

    /**
     * @param {number} instance @param {number} type @param {number} name
     * @param {number | null} language @param {boolean} [wide]
     */
    const find = (instance, type, name, language, wide = false)=>{
        const wantedType = identifier(type, wide);
        const wantedName = identifier(name, wide);
        const entry = wantedType === null || wantedName === null ? null
            : host.findResource(instance >>> 0, wantedType, wantedName, language);
        if (!entry)
        {
            return fail(missing(instance >>> 0, wantedType, wantedName));
        }
        const handle = nextHandle;
        nextHandle += 4;
        found.set(handle, { ...entry, base: host.moduleBase(instance >>> 0) });
        return handle;
    };

    /**
     * EnumResourceLanguages, either width.
     *
     * @param {number[]} args @param {boolean} wide
     * @returns {number | Promise<number>}
     */
    const enumLanguages = ([instance, type, name, callback, lParam], wide)=>{
        if (!host.call || (callback >>> 0) === 0)
        {
            return fail(ERROR_RESOURCE_TYPE_NOT_FOUND);
        }
        const wantedType = identifier(type, wide);
        const wantedName = identifier(name, wide);
        const languages = (host.listResources?.(instance >>> 0) ?? [])
            .filter(entry=>sameKey(entry.type, wantedType)
                && sameKey(entry.name, wantedName))
            .map(entry=>entry.language);
        if (languages.length === 0)
        {
            return fail(missing(instance >>> 0, wantedType, wantedName));
        }
        const thread = host.callerThread?.();
        const call = /** @type {NonNullable<typeof host.call>} */ (host.call);
        /** @param {number} at @returns {number | Promise<number>} */
        const next = at=>{
            if (at === languages.length)
            {
                return 1;
            }
            const answer = call(callback >>> 0,
                [instance >>> 0, type >>> 0, name >>> 0, languages[at], lParam >>> 0],
                thread);
            /** @param {number} went */
            const then = went=>((went | 0) === 0 ? 1 : next(at + 1));
            return typeof answer === 'number' ? then(answer) : answer.then(then);
        };
        return next(0);
    };

    /**
     * A language of zero, MAKELANGID(LANG_NEUTRAL, SUBLANG_NEUTRAL), is none.
     *
     * @param {number} value
     */
    const languageOf = value=>((value & 0xffff) === 0 ? null : value & 0xffff);

    return {
        /**
         * HRSRC FindResourceExA(HMODULE hModule, LPCSTR lpType, LPCSTR lpName,
         *                       WORD wLanguage)
         *
         * The type before the name here, the other way round from
         * FindResourceA -- the one place in the API where the two orders sit
         * side by side. A language of zero, MAKELANGID(LANG_NEUTRAL, ...), is
         * "whatever is there"; any other is looked for as asked, which is how
         * a program with a string table per language picks its user's.
         */
        FindResourceExA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([instance, type, name, language])=>
                find(instance, type, name, languageOf(language)),
        },

        /**
         * HRSRC FindResourceExW(HMODULE hModule, LPCWSTR lpType, LPCWSTR lpName,
         *                       WORD wLanguage)
         */
        FindResourceExW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([instance, type, name, language])=>
                find(instance, type, name, languageOf(language), true),
        },

        /**
         * BOOL EnumResourceLanguagesA(HMODULE hModule, LPCSTR lpType, LPCSTR lpName,
         *                             ENUMRESLANGPROCA lpEnumFunc, LONG_PTR lParam)
         *
         * The callback is handed the type and name exactly as the caller
         * passed them -- a pointer stays a pointer -- and each language in
         * turn until one of them answers FALSE. A program picks the string
         * table for its user's language this way, and a table it is never
         * shown is one it cannot pick.
         */
        EnumResourceLanguagesA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>enumLanguages(args, false),
        },

        /**
         * BOOL EnumResourceLanguagesW(HMODULE hModule, LPCWSTR lpType, LPCWSTR lpName,
         *                             ENUMRESLANGPROCW lpEnumFunc, LONG_PTR lParam)
         */
        EnumResourceLanguagesW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>enumLanguages(args, true),
        },

        /**
         * HRSRC FindResourceA(HMODULE hModule, LPCSTR lpName, LPCSTR lpType)
         *
         * Note the argument order: the name comes before the type, which is the
         * opposite of how the resource tree is walked and of how nearly every
         * caller reads. Swapping them finds nothing, silently.
         */
        FindResourceA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([instance, name, type])=>find(instance, type, name, null),
        },

        /** HRSRC FindResourceW(HMODULE hModule, LPCWSTR lpName, LPCWSTR lpType) */
        FindResourceW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([instance, name, type])=>find(instance, type, name, null, true),
        },

        /** DWORD SizeofResource(HMODULE hModule, HRSRC hResInfo) */
        SizeofResource: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, resource])=>{
                const entry = found.get(resource >>> 0);
                return entry ? entry.size : fail(ERROR_RESOURCE_DATA_NOT_FOUND);
            },
        },

        /**
         * HGLOBAL LoadResource(HMODULE hModule, HRSRC hResInfo)
         *
         * Nothing is loaded. The bytes came into memory with the image and have
         * not moved, so the HGLOBAL is their address -- on Win32 it always is,
         * and a program that reads through it without locking works there.
         */
        LoadResource: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, resource])=>{
                if ((resource >>> 0) === 0)
                {
                    return 0;
                }
                const entry = found.get(resource >>> 0);
                return entry ? (entry.base + entry.rva) >>> 0 : fail(ERROR_RESOURCE_DATA_NOT_FOUND);
            },
        },

        /**
         * LPVOID LockResource(HGLOBAL hResData)
         *
         * The handle already is the pointer, so it comes back as it went in.
         */
        LockResource: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>handle >>> 0,
        },

        /**
         * BOOL FreeResource(HGLOBAL hResData)
         *
         * Nothing was allocated, so nothing is released. Windows documents this
         * as obsolete and always succeeding for the same reason.
         */
        FreeResource: {
            argBytes: 4,
            handler: ()=>1,
        },
    };
}
