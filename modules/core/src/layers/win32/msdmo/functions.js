/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * msdmo — the registry of DirectX Media Objects and the media type helpers
 * every DMO and DirectShow filter shares.
 *
 * A DMO is registered where Windows keeps it, under
 * `HKCR\DirectShow\MediaObjects`: one key per object named by its CLSID,
 * whose default value is the object's name and whose `InputTypes` and
 * `OutputTypes` values are its DMO_PARTIAL_MEDIATYPE pairs, and a key under
 * `Categories\{category}` for each category it is in. A program that reads
 * the registry itself sees what DMOEnum sees, because there is nothing else.
 *
 * The Mo* calls are AM_MEDIA_TYPE's lifetime in task memory: a format block
 * is CoTaskMemAlloc'd beside the structure and freed with it.
 */

import { createComObject } from '../ole32/objects.js';
import { formatGuid, parseGuid } from '../ole32/guid.js';
import { wholeAddress } from '../common/pointers.js';

const S_OK = 0;
const S_FALSE = 1;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const E_FAIL = 0x80004005 | 0;

const GUID_NULL = '{00000000-0000-0000-0000-000000000000}';
const IID_IENUM_DMO = '{2C3CD98A-2BFA-4A53-9C27-5249BA64BA0F}';

/** DMORegister's one flag, and DMOEnum's: a keyed DMO needs a key to be used. */
const DMO_REGISTERF_IS_KEYED = 0x1;
const DMO_ENUMF_INCLUDE_KEYED = 0x1;

/** DMOGetName's buffer: eighty wide characters, the terminator included. */
const NAME_UNITS = 80;
const NAME_BYTES = NAME_UNITS * 2;

/** DMO_PARTIAL_MEDIATYPE: a major type and a subtype. */
const PARTIAL_TYPE_BYTES = 32;

/** AM_MEDIA_TYPE as a 32-bit process lays it out. */
const MEDIA_TYPE = { UNKNOWN: 0x3c, FORMAT_BYTES: 0x40, FORMAT: 0x44, BYTES: 0x48 };

const ROOT = 'DirectShow\\MediaObjects';
const CATEGORIES = `${ROOT}\\Categories`;
const INPUT_TYPES = 'InputTypes';
const OUTPUT_TYPES = 'OutputTypes';
const KEYED = 'Keyed';

/**
 * @typedef {Object} DmoRegistry  The classes root, as far as DMOs need it.
 * @property {(path: string) => boolean} exists
 * @property {(path: string) => string[]} subkeys
 * @property {(path: string, name: string) => Uint8Array | null} get
 * @property {(path: string, name: string, data: Uint8Array, binary: boolean) => void} set
 * @property {(path: string) => void} create
 * @property {(path: string) => void} remove  A key and everything under it.
 */

/**
 * @typedef {Object} MsdmoHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(bytes: number) => number} allocate  CoTaskMemAlloc's.
 * @property {(address: number) => void} free     CoTaskMemFree's.
 * @property {DmoRegistry} registry
 * @property {(object: import('../ole32/objects.js').ComObject, iid: string) => number} publish
 */

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/** @param {string} text */
const wide = text=>new Uint8Array(
    Uint16Array.from([...text, '\0'], char=>char.charCodeAt(0)).buffer);

/**
 * @typedef {{ type: string, subtype: string }} PartialType
 */

/**
 * The pairs a registry value holds, or a caller's array of them.
 *
 * @param {Uint8Array} bytes @returns {PartialType[]}
 */
const partialTypes = bytes=>{
    /** @type {PartialType[]} */
    const types = [];
    for (let at = 0; at + PARTIAL_TYPE_BYTES <= bytes.length; at += PARTIAL_TYPE_BYTES)
    {
        types.push({ type: formatGuid(bytes.subarray(at, at + 16)),
            subtype: formatGuid(bytes.subarray(at + 16, at + 32)) });
    }
    return types;
};

/**
 * Whether a registered pair answers a pair asked for: GUID_NULL asked for is
 * any, and a registered GUID_NULL subtype is every subtype of its type.
 *
 * @param {PartialType} registered @param {PartialType} asked
 */
const answers = (registered, asked)=>(asked.type === GUID_NULL || asked.type === registered.type)
    && (asked.subtype === GUID_NULL || registered.subtype === GUID_NULL
        || asked.subtype === registered.subtype);

/**
 * Every DMO the registry holds in a category, each with the category it was
 * found under: what IFilterMapper2 enumerates beside the filters, as Windows 7
 * and later do.
 *
 * @param {DmoRegistry} registry
 * @returns {{ clsid: string, category: string, name: string, inputs: PartialType[],
 *     outputs: PartialType[] }[]}
 */
export function listDmos(registry){
    /** @type {{ clsid: string, category: string, name: string, inputs: PartialType[], outputs: PartialType[] }[]} */
    const found = [];
    for (const category of registry.subkeys(CATEGORIES))
    {
        const canonicalCategory = parseGuid(category) ? formatGuid(/** @type {Uint8Array} */ (parseGuid(category))) : null;
        for (const clsid of registry.subkeys(`${CATEGORIES}\\${category}`))
        {
            const bytes = parseGuid(clsid);
            if (!bytes || !canonicalCategory || !registry.exists(`${ROOT}\\${clsid}`))
            {
                continue;
            }
            const key = `${ROOT}\\${clsid}`;
            const name = registry.get(key, '') ?? new Uint8Array(0);
            const units = new Uint16Array(name.buffer.slice(name.byteOffset,
                name.byteOffset + (name.length & ~1)));
            const end = units.indexOf(0);
            found.push({ clsid: formatGuid(bytes), category: canonicalCategory,
                name: String.fromCharCode(...(end < 0 ? units : units.subarray(0, end))),
                inputs: partialTypes(registry.get(key, INPUT_TYPES) ?? new Uint8Array(0)),
                outputs: partialTypes(registry.get(key, OUTPUT_TYPES) ?? new Uint8Array(0)) });
        }
    }
    return found;
}

/** @param {MsdmoHost} host */
export function createMsdmoFunctions(host){
    /** @param {number} address */
    const guidAt = address=>formatGuid(host.readMemory(wholeAddress(address), 16));
    /** @param {number} address @param {number} count */
    const typesAt = (address, count)=>((address >>> 0) === 0 || count === 0 ? []
        : partialTypes(host.readMemory(wholeAddress(address), count * PARTIAL_TYPE_BYTES)));

    /** @param {string} clsid */
    const objectKey = clsid=>`${ROOT}\\${clsid}`;

    /** @param {string} clsid @param {string} name */
    const typesOf = (clsid, name)=>partialTypes(host.registry.get(objectKey(clsid), name)
        ?? new Uint8Array(0));

    /** @param {string} clsid */
    const nameOf = clsid=>{
        const data = host.registry.get(objectKey(clsid), '');
        if (!data)
        {
            return null;
        }
        const units = new Uint16Array(data.buffer.slice(data.byteOffset,
            data.byteOffset + (data.length & ~1)));
        const end = units.indexOf(0);
        return String.fromCharCode(...(end < 0 ? units : units.subarray(0, end)));
    };

    /** The CLSIDs a category holds, every category's for GUID_NULL. @param {string} category */
    const membersOf = category=>{
        const categories = category === GUID_NULL
            ? host.registry.subkeys(CATEGORIES) : [category];
        /** @type {string[]} */
        const found = [];
        for (const each of categories)
        {
            for (const clsid of host.registry.subkeys(`${CATEGORIES}\\${each}`))
            {
                const canonical = formatGuid(/** @type {Uint8Array} */ (parseGuid(clsid)
                    ?? new Uint8Array(16)));
                if (parseGuid(clsid) && !found.includes(canonical))
                {
                    found.push(canonical);
                }
            }
        }
        return found;
    };

    /** @param {PartialType[]} pairs */
    const pairBytes = pairs=>{
        const bytes = new Uint8Array(pairs.length * PARTIAL_TYPE_BYTES);
        pairs.forEach((pair, at)=>{
            bytes.set(/** @type {Uint8Array} */ (parseGuid(pair.type)), at * PARTIAL_TYPE_BYTES);
            bytes.set(/** @type {Uint8Array} */ (parseGuid(pair.subtype)),
                at * PARTIAL_TYPE_BYTES + 16);
        });
        return bytes;
    };

    /**
     * IEnumDMO over a list taken when the enumerator is made: a DMO registered
     * after is not in it, as Windows' enumerator reads the registry once.
     *
     * @param {string[]} clsids @param {number} [position]
     * @returns {number}
     */
    const enumerator = (clsids, position = 0)=>{
        const state = { position };
        const object = createComObject(IID_IENUM_DMO, {
            state,
            interfaces: [{
                id: IID_IENUM_DMO,
                methods: [
                    {
                        // HRESULT Next(DWORD cItemsToFetch, CLSID *pCLSID, WCHAR **Names,
                        //              DWORD *pcItemsFetched)
                        name: 'Next', argBytes: 20,
                        invoke: (_object, [count, clsidsOut, namesOut, fetched])=>{
                            // More than one asked for needs a count to say how many came;
                            // an array is needed only once there is something to put in it.
                            if ((count >>> 0) > 1 && (fetched >>> 0) === 0)
                            {
                                return E_INVALIDARG;
                            }
                            if ((clsidsOut >>> 0) === 0 && state.position < clsids.length
                                && (count >>> 0) > 0)
                            {
                                return E_INVALIDARG;
                            }
                            let given = 0;
                            while (given < (count >>> 0) && state.position < clsids.length)
                            {
                                const clsid = clsids[state.position++];
                                host.writeMemory(wholeAddress(clsidsOut) + given * 16,
                                    /** @type {Uint8Array} */ (parseGuid(clsid)));
                                if ((namesOut >>> 0) !== 0)
                                {
                                    const text = wide(nameOf(clsid) ?? '');
                                    const at = host.allocate(text.length);
                                    if (at === 0)
                                    {
                                        return E_OUTOFMEMORY;
                                    }
                                    host.writeMemory(at, text);
                                    host.writeMemory(wholeAddress(namesOut) + given * 4, dword(at));
                                }
                                given++;
                            }
                            if ((fetched >>> 0) !== 0)
                            {
                                host.writeMemory(wholeAddress(fetched), dword(given));
                            }
                            return given === (count >>> 0) ? S_OK : S_FALSE;
                        },
                    },
                    {
                        // HRESULT Skip(DWORD cItemsToSkip)
                        name: 'Skip', argBytes: 8,
                        invoke: (_object, [count])=>{
                            const left = clsids.length - state.position;
                            state.position = Math.min(clsids.length,
                                state.position + (count >>> 0));
                            return (count >>> 0) <= left ? S_OK : S_FALSE;
                        },
                    },
                    {
                        name: 'Reset', argBytes: 4,
                        invoke: ()=>{
                            state.position = 0;
                            return S_OK;
                        },
                    },
                    {
                        // HRESULT Clone(IEnumDMO **ppEnum)
                        name: 'Clone', argBytes: 8,
                        invoke: (_object, [out])=>{
                            if ((out >>> 0) === 0)
                            {
                                return E_POINTER;
                            }
                            host.writeMemory(wholeAddress(out), dword(enumerator(clsids,
                                state.position)));
                            return S_OK;
                        },
                    },
                ],
            }],
        });
        return host.publish(object, IID_IENUM_DMO);
    };

    /** A media type's format block goes, and its pUnk is released by the caller. @param {number} type */
    const freeFormat = type=>{
        const format = new DataView(host.readMemory(type + MEDIA_TYPE.FORMAT, 4).buffer)
            .getUint32(0, true);
        if (format !== 0)
        {
            host.free(format);
        }
        host.writeMemory(type + MEDIA_TYPE.FORMAT_BYTES, new Uint8Array(8));
    };

    /** @param {number} to @param {number} from */
    const copyType = (to, from)=>{
        const bytes = host.readMemory(from, MEDIA_TYPE.BYTES).slice();
        const view = new DataView(bytes.buffer);
        const formatBytes = view.getUint32(MEDIA_TYPE.FORMAT_BYTES, true);
        const format = view.getUint32(MEDIA_TYPE.FORMAT, true);
        if (formatBytes > 0 && format !== 0)
        {
            const block = host.allocate(formatBytes);
            if (block === 0)
            {
                return E_OUTOFMEMORY;
            }
            host.writeMemory(block, host.readMemory(format, formatBytes).slice());
            view.setUint32(MEDIA_TYPE.FORMAT, block, true);
        }
        else
        {
            view.setUint32(MEDIA_TYPE.FORMAT_BYTES, 0, true);
            view.setUint32(MEDIA_TYPE.FORMAT, 0, true);
        }
        host.writeMemory(to, bytes);
        return S_OK;
    };

    /** @param {number} type @param {number} formatBytes */
    const initType = (type, formatBytes)=>{
        host.writeMemory(type, new Uint8Array(MEDIA_TYPE.BYTES));
        if (formatBytes > 0)
        {
            const block = host.allocate(formatBytes);
            if (block === 0)
            {
                return E_OUTOFMEMORY;
            }
            host.writeMemory(type + MEDIA_TYPE.FORMAT_BYTES, dword(formatBytes));
            host.writeMemory(type + MEDIA_TYPE.FORMAT, dword(block));
        }
        return S_OK;
    };

    return {
        /**
         * HRESULT DMORegister(LPCWSTR szName, REFCLSID clsidDMO, REFGUID guidCategory,
         *     DWORD dwFlags, DWORD cInTypes, const DMO_PARTIAL_MEDIATYPE *pInTypes,
         *     DWORD cOutTypes, const DMO_PARTIAL_MEDIATYPE *pOutTypes)
         */
        DMORegister: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([name, clsid, category, flags, inCount, inTypes, outCount, outTypes])=>{
                // An object is registered in a category: GUID_NULL, which DMOEnum
                // and DMOUnregister read as every category, names none.
                if ((clsid >>> 0) === 0 || (category >>> 0) === 0
                    || guidAt(category) === GUID_NULL)
                {
                    return E_INVALIDARG;
                }
                const id = guidAt(clsid);
                const key = objectKey(id);
                host.registry.create(key);
                // No name is an empty one: the object is still registered.
                host.registry.set(key, '', wide((name >>> 0) === 0 ? ''
                    : host.readWideString(wholeAddress(name), NAME_BYTES * 4)), false);
                host.registry.set(key, INPUT_TYPES,
                    pairBytes(typesAt(inTypes, inCount >>> 0)), true);
                host.registry.set(key, OUTPUT_TYPES,
                    pairBytes(typesAt(outTypes, outCount >>> 0)), true);
                if (flags & DMO_REGISTERF_IS_KEYED)
                {
                    host.registry.set(key, KEYED, dword(1), true);
                }
                host.registry.create(`${CATEGORIES}\\${guidAt(category)}\\${id}`);
                return S_OK;
            },
        },
        /**
         * HRESULT DMOUnregister(REFCLSID clsidDMO, REFGUID guidCategory)
         *
         * GUID_NULL takes the object out of every category; S_FALSE when it
         * was in none of those named.
         */
        DMOUnregister: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([clsid, category])=>{
                if ((clsid >>> 0) === 0 || (category >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const id = guidAt(clsid);
                const asked = guidAt(category);
                const categories = asked === GUID_NULL
                    ? host.registry.subkeys(CATEGORIES) : [asked];
                let removed = false;
                for (const each of categories)
                {
                    const entry = `${CATEGORIES}\\${each}\\${id}`;
                    if (host.registry.exists(entry))
                    {
                        host.registry.remove(entry);
                        removed = true;
                    }
                }
                const anywhere = host.registry.subkeys(CATEGORIES)
                    .some(each=>host.registry.exists(`${CATEGORIES}\\${each}\\${id}`));
                if (!anywhere && host.registry.exists(objectKey(id)))
                {
                    host.registry.remove(objectKey(id));
                    removed = true;
                }
                return removed ? S_OK : S_FALSE;
            },
        },
        /**
         * HRESULT DMOEnum(REFGUID guidCategory, DWORD dwFlags, DWORD cInTypes,
         *     const DMO_PARTIAL_MEDIATYPE *pInTypes, DWORD cOutTypes,
         *     const DMO_PARTIAL_MEDIATYPE *pOutTypes, IEnumDMO **ppEnum)
         */
        DMOEnum: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([category, flags, inCount, inTypes, outCount, outTypes, out])=>{
                if ((out >>> 0) === 0 || (category >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const wantIn = typesAt(inTypes, inCount >>> 0);
                const wantOut = typesAt(outTypes, outCount >>> 0);
                /** @param {PartialType[]} registered @param {PartialType[]} wanted */
                const fits = (registered, wanted)=>wanted.length === 0
                    || wanted.some(asked=>registered.some(each=>answers(each, asked)));
                const clsids = membersOf(guidAt(category)).filter(clsid=>
                    host.registry.exists(objectKey(clsid))
                    && ((flags & DMO_ENUMF_INCLUDE_KEYED)
                        || !host.registry.get(objectKey(clsid), KEYED))
                    && fits(typesOf(clsid, INPUT_TYPES), wantIn)
                    && fits(typesOf(clsid, OUTPUT_TYPES), wantOut));
                host.writeMemory(wholeAddress(out), dword(enumerator(clsids)));
                return S_OK;
            },
        },
        /** HRESULT DMOGetName(REFCLSID clsidDMO, WCHAR szName[80]) */
        DMOGetName: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([clsid, out])=>{
                if ((clsid >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const name = nameOf(guidAt(clsid));
                if (name === null)
                {
                    return E_FAIL;
                }
                host.writeMemory(wholeAddress(out), wide(name.slice(0, NAME_UNITS - 1)));
                return S_OK;
            },
        },
        /**
         * HRESULT DMOGetTypes(REFCLSID clsidDMO, ULONG ulInputTypesRequested,
         *     ULONG *pulInputTypesSupplied, DMO_PARTIAL_MEDIATYPE *pInputTypes,
         *     ULONG ulOutputTypesRequested, ULONG *pulOutputTypesSupplied,
         *     DMO_PARTIAL_MEDIATYPE *pOutputTypes)
         *
         * Each list as far as it fits; the counts say how much was written.
         */
        DMOGetTypes: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([clsid, inAsked, inGiven, inTypes, outAsked, outGiven, outTypes])=>{
                if ((clsid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const id = guidAt(clsid);
                if (!host.registry.exists(objectKey(id)))
                {
                    return E_FAIL;
                }
                /** @param {PartialType[]} types @param {number} asked @param {number} given @param {number} to */
                const give = (types, asked, given, to)=>{
                    const count = Math.min(types.length, asked >>> 0);
                    if ((to >>> 0) !== 0 && count > 0)
                    {
                        host.writeMemory(wholeAddress(to), pairBytes(types.slice(0, count)));
                    }
                    if ((given >>> 0) !== 0)
                    {
                        host.writeMemory(wholeAddress(given), dword(count));
                    }
                };
                give(typesOf(id, INPUT_TYPES), inAsked, inGiven, inTypes);
                give(typesOf(id, OUTPUT_TYPES), outAsked, outGiven, outTypes);
                return S_OK;
            },
        },
        /** HRESULT MoInitMediaType(DMO_MEDIA_TYPE *pmt, DWORD cbFormat) */
        MoInitMediaType: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([type, formatBytes])=>((type >>> 0) === 0 ? E_POINTER
                : initType(type >>> 0, formatBytes >>> 0)),
        },
        /** HRESULT MoFreeMediaType(DMO_MEDIA_TYPE *pmt) */
        MoFreeMediaType: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([type])=>{
                if ((type >>> 0) === 0)
                {
                    return E_POINTER;
                }
                freeFormat(type >>> 0);
                return S_OK;
            },
        },
        /** HRESULT MoCopyMediaType(DMO_MEDIA_TYPE *pmtDest, const DMO_MEDIA_TYPE *pmtSrc) */
        MoCopyMediaType: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([to, from])=>((to >>> 0) === 0 || (from >>> 0) === 0 ? E_POINTER
                : copyType(to >>> 0, from >>> 0)),
        },
        /** HRESULT MoCreateMediaType(DMO_MEDIA_TYPE **ppmt, DWORD cbFormat) */
        MoCreateMediaType: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([out, formatBytes])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const type = host.allocate(MEDIA_TYPE.BYTES);
                if (type === 0)
                {
                    return E_OUTOFMEMORY;
                }
                const made = initType(type, formatBytes >>> 0);
                if (made !== S_OK)
                {
                    host.free(type);
                    host.writeMemory(wholeAddress(out), dword(0));
                    return made;
                }
                host.writeMemory(wholeAddress(out), dword(type));
                return S_OK;
            },
        },
        /** HRESULT MoDeleteMediaType(DMO_MEDIA_TYPE *pmt) */
        MoDeleteMediaType: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([type])=>{
                if ((type >>> 0) === 0)
                {
                    return E_POINTER;
                }
                freeFormat(type >>> 0);
                host.free(type >>> 0);
                return S_OK;
            },
        },
        /** HRESULT MoDuplicateMediaType(DMO_MEDIA_TYPE **ppmtDest, const DMO_MEDIA_TYPE *pmtSrc) */
        MoDuplicateMediaType: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([out, from])=>{
                if ((out >>> 0) === 0 || (from >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const type = host.allocate(MEDIA_TYPE.BYTES);
                if (type === 0)
                {
                    return E_OUTOFMEMORY;
                }
                const copied = copyType(type, from >>> 0);
                if (copied !== S_OK)
                {
                    host.free(type);
                    return copied;
                }
                host.writeMemory(wholeAddress(out), dword(type));
                return S_OK;
            },
        },
    };
}
