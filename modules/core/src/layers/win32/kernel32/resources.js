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
 * the image and were never anywhere else, so the last two are arithmetic. Both
 * still exist because a program calls all four in order and checks each result.
 *
 * The reader itself lives in the loader, where the PE format is understood, and
 * arrives through the host. This layer may not reach into that one, and the
 * split is worth keeping for a reason beyond the boundary check: what a
 * resource *means* is this file's business, and where it sits in a file is not.
 */

/** Codes this surface reports. */
const ERROR_RESOURCE_DATA_NOT_FOUND = 1812;
const ERROR_RESOURCE_TYPE_NOT_FOUND = 1813;

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
 * @property {(code: number) => void} setLastError
 * @property {(instance: number, type: number | string, name: number | string) =>
 *            { rva: number, size: number } | null} findResource
 *           The loader's reader, bound to a module. An instance of zero means
 *           the running program, which is what a program passes for its own.
 * @property {(instance: number) => number} moduleBase
 *           Where that module was mapped, so an RVA can become an address.
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
     * type into a wild pointer.
     *
     * @param {number} value
     * @returns {number | string}
     */
    const identifier = value=>{
        const raw = value >>> 0;
        return raw < MAX_INTEGER_RESOURCE ? raw : host.readCString(raw, MAX_NAME);
    };

    /** @param {number} code */
    const fail = code=>{
        host.setLastError(code);
        return 0;
    };

    return {
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
            handler: ([instance, name, type])=>{
                const entry = host.findResource(
                    instance >>> 0, identifier(type), identifier(name));
                if (!entry)
                {
                    // Windows distinguishes a type nothing has from a name
                    // missing within a type that exists. We cannot tell the two
                    // apart from here, and the one a caller acts on is the
                    // general "not found", so that is what is reported.
                    return fail(ERROR_RESOURCE_TYPE_NOT_FOUND);
                }
                const handle = nextHandle;
                nextHandle += 4;
                found.set(handle, { ...entry, base: host.moduleBase(instance >>> 0) });
                return handle;
            },
        },

        /**
         * HRSRC FindResourceExA(HMODULE hModule, LPCSTR lpType, LPCSTR lpName,
         *   WORD wLanguage)
         *
         * The same lookup as FindResourceA with a language selector added --
         * and note the argument order swaps type before name, the opposite of
         * FindResourceA. A wLanguage of zero (MAKELANGID(LANG_NEUTRAL, ...))
         * means "whatever language is there", which is how the two spellings
         * agree on a module whose resources carry one language.
         */
        FindResourceExA: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([instance, type, name])=>{
                const entry = host.findResource(
                    instance >>> 0, identifier(type), identifier(name));
                if (!entry)
                {
                    return fail(ERROR_RESOURCE_TYPE_NOT_FOUND);
                }
                const handle = nextHandle;
                nextHandle += 4;
                found.set(handle, { ...entry, base: host.moduleBase(instance >>> 0) });
                return handle;
            },
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
         * not moved, so this hands back the same token and LockResource turns it
         * into the address they are already at.
         */
        LoadResource: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, resource])=>{
                const entry = found.get(resource >>> 0);
                return entry ? resource >>> 0 : fail(ERROR_RESOURCE_DATA_NOT_FOUND);
            },
        },

        /** LPVOID LockResource(HGLOBAL hResData) */
        LockResource: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([resource])=>{
                const entry = found.get(resource >>> 0);
                return entry ? (entry.base + entry.rva) >>> 0 : 0;
            },
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
