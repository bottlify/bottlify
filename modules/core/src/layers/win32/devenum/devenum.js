/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * devenum.dll: the system device enumerator (CLSID_SystemDeviceEnum) and the
 * device moniker each registered filter is named by, over the one store of
 * filter registrations the filter mapper writes (`quartz/mapper.js`).
 *
 * A category is a GUID - CLSID_LegacyAmFilterCategory, a renderer category, a
 * capture category - and an entry in it is a filter's class, its friendly name,
 * its merit and its pins, as a filter's DllRegisterServer gives them to
 * IFilterMapper2::RegisterFilter. ICreateDevEnum::CreateClassEnumerator hands a
 * category out as an IEnumMoniker of device monikers; a moniker binds to the
 * filter (BindToObject: CoCreateInstance of its class) and to its properties
 * (BindToStorage: an IPropertyBag with FriendlyName and CLSID), and names itself
 * `@device:sw:{category}\{instance}`, as Windows' software devices are named.
 *
 * The registrations live as long as the process: Windows keeps them in the
 * registry under the category's Instance key (decisions.md A252).
 */

import { createComObject } from '../ole32/objects.js';
import { formatGuid, parseGuid } from '../ole32/guid.js';
import { describe } from '../quartz/describe.js';

export const CLSID_SYSTEM_DEVICE_ENUM = '{62BE5D10-60EB-11D0-BD3B-00A0C911CE86}';
export const CLSID_DEVICE_MONIKER = '{4315D437-5B8C-11D0-BD3B-00A0C911CE86}';
export const CLSID_LEGACY_AM_FILTER_CATEGORY = '{083863F1-70DE-11D0-BD40-00A0C911CE86}';
export const IID_ICREATE_DEV_ENUM = '{29840822-5B84-11D0-BD3B-00A0C911CE86}';
export const IID_IENUM_MONIKER = '{00000102-0000-0000-C000-000000000046}';
export const IID_IMONIKER = '{0000000F-0000-0000-C000-000000000046}';
export const IID_IPERSIST_STREAM = '{00000109-0000-0000-C000-000000000046}';
export const IID_IPERSIST = '{0000010C-0000-0000-C000-000000000046}';
export const IID_IPROPERTY_BAG = '{55272A00-42CB-11CE-8135-00AA004BB851}';
export const IID_IPARSE_DISPLAY_NAME = '{0000011A-0000-0000-C000-000000000046}';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
/** HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND): a property the bag does not hold. */
const PROPERTY_NOT_FOUND = 0x80070002;
const MK_E_NOSTORAGE = 0x800401ed;
const MK_E_SYNTAX = 0x800401e4;
const REGDB_E_CLASSNOTREG = 0x80040154;
/** MK_S_REDUCED_TO_SELF: a device moniker reduces to nothing simpler. */
const MK_S_REDUCED_TO_SELF = 0x000401e2;
/** MKSYS_NONE: not one of the system's monikers. */
const MKSYS_NONE = 0;

const VT_EMPTY = 0;
const VT_I4 = 3;
const VT_BSTR = 8;
const VT_UI1 = 17;
const VT_ARRAY = 0x2000;
const E_OUTOFMEMORY = 0x8007000e;

/** @type {[string, number][]} */
const ICREATE_DEV_ENUM_SLOTS = [['CreateClassEnumerator', 3]];
/** @type {[string, number][]} */
const IENUM_MONIKER_SLOTS = [['Next', 3], ['Skip', 1], ['Reset', 0], ['Clone', 1]];
/** IPersist, IPersistStream, then IMoniker's own. @type {[string, number][]} */
const IMONIKER_SLOTS = [
    ['GetClassID', 1],
    ['IsDirty', 0],
    ['Load', 1],
    ['Save', 2],
    ['GetSizeMax', 1],
    ['BindToObject', 4],
    ['BindToStorage', 4],
    ['Reduce', 4],
    ['ComposeWith', 3],
    ['Enum', 2],
    ['IsEqual', 1],
    ['Hash', 1],
    ['IsRunning', 3],
    ['GetTimeOfLastChange', 3],
    ['Inverse', 1],
    ['CommonPrefixWith', 2],
    ['RelativePathTo', 2],
    ['GetDisplayName', 3],
    ['ParseDisplayName', 5],
    ['IsSystemMoniker', 1],
];
/** @type {[string, number][]} */
const IPROPERTY_BAG_SLOTS = [['Read', 3], ['Write', 2]];
/** @type {[string, number][]} */
const IPARSE_DISPLAY_NAME_SLOTS = [['ParseDisplayName', 4]];

/**
 * A pin as a registration describes it, for matching a request against.
 *
 * @typedef {Object} RegisteredPin
 * @property {string} name
 * @property {boolean} output
 * @property {boolean} renderer
 * @property {boolean} zero
 * @property {boolean} many
 * @property {[string, string][]} types  Major and minor type; GUID_NULL matches anything.
 */

/**
 * @typedef {Object} RegisteredFilter
 * @property {string} category
 * @property {string} instance  The name it is kept under in its category.
 * @property {string} clsid
 * @property {string} name      Its friendly name.
 * @property {number} merit
 * @property {RegisteredPin[]} pins
 * @property {Map<string, string | number | Uint8Array>} properties  What a program wrote
 *     to its property bag, in the type it gave: a string, a number, bytes.
 * @property {string} [display]  Its moniker's display name where it is not a software
 *     device's: a DMO is `@device:dmo:{clsid}{category}`.
 */

/**
 * The process's filter registrations, by category and instance name.
 *
 * @returns {{
 *   register: (filter: RegisteredFilter) => void,
 *   unregister: (category: string, instance: string) => boolean,
 *   find: (category: string, instance: string) => RegisteredFilter | undefined,
 *   list: (category?: string) => RegisteredFilter[],
 * }}
 */
export function createFilterStore(){
    /** @type {Map<string, Map<string, RegisteredFilter>>} */
    const categories = new Map();
    /** @param {string} text */
    const key = text=>text.toUpperCase();
    return {
        register(filter){
            const category = categories.get(key(filter.category)) ?? new Map();
            categories.set(key(filter.category), category);
            category.set(key(filter.instance), filter);
        },
        unregister(category, instance){
            return categories.get(key(category))?.delete(key(instance)) ?? false;
        },
        find(category, instance){
            return categories.get(key(category))?.get(key(instance));
        },
        list(category){
            if (category !== undefined)
            {
                return [...categories.get(key(category))?.values() ?? []];
            }
            return [...categories.values()].flatMap(entries=>[...entries.values()]);
        },
    };
}

/** @typedef {ReturnType<typeof createFilterStore>} FilterStore */

/**
 * @typedef {Object} DevEnumHost
 * @property {(address: number) => number} readU32
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate  Task memory, which CoTaskMemFree frees.
 * @property {(object: import('../ole32/objects.js').ComObject, iid: string) => number} publish
 * @property {(text: string) => number | Promise<number>} allocateString  A BSTR.
 * @property {(bytes: Uint8Array) => number | Promise<number>} [allocateBytes]  A SAFEARRAY
 *           of VT_UI1 holding the bytes, as SafeArrayCreateVector makes one.
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(clsid: string, iid: number, out: number) => number | Promise<number>} createInstance
 *           CoCreateInstance of a class in this process, for the interface at `iid`.
 * @property {(pointer: number) => any} [objectAt]  The engine's object behind an
 *           interface pointer, null where the program made it.
 * @property {() => RegisteredFilter[]} [dmos]  The DMOs registered, as the filter
 *           mapper enumerates them beside the filters.
 */

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/** @param {string} text a wide string with its terminator */
const wide = text=>{
    const bytes = new Uint8Array((text.length + 1) * 2);
    for (let i = 0; i < text.length; i++)
    {
        bytes[i * 2] = text.charCodeAt(i) & 0xff;
        bytes[i * 2 + 1] = text.charCodeAt(i) >>> 8;
    }
    return bytes;
};

/** A name read whole, up to the longest a registry value name may be. */
const NAME_BYTES = 16384 * 2;

/**
 * The device enumerator's class, and the monikers and enumerators the filter
 * mapper hands out over the same store.
 *
 * @param {DevEnumHost} host
 * @param {FilterStore} store
 */
export function createDeviceEnumeration(host, store){
    /** @param {number} address */
    const readGuid = address=>{
        const bytes = new Uint8Array(16);
        for (let i = 0; i < 16; i += 4)
        {
            bytes.set(dword(host.readU32(address + i)), i);
        }
        return formatGuid(bytes);
    };
    /** @param {string} text */
    const guidBytes = text=>/** @type {Uint8Array} */ (parseGuid(text));

    /** @type {Record<string, (filter: RegisteredFilter, args: number[]) => number | Promise<number>>} */
    const propertyBag = {
        /** HRESULT Read(LPCOLESTR pszPropName, VARIANT *pVar, IErrorLog *pErrorLog) */
        Read: async(filter, [name, variant])=>{
            if ((name >>> 0) === 0 || (variant >>> 0) === 0)
            {
                return E_POINTER;
            }
            const wanted = host.readWideString(name >>> 0, NAME_BYTES);
            const value = wanted === 'FriendlyName' ? filter.name || undefined
                : wanted === 'CLSID' ? filter.clsid || undefined
                    : filter.properties.get(wanted);
            if (value === undefined)
            {
                return PROPERTY_NOT_FOUND;
            }
            // A value answers in the type it is kept in - a string as a BSTR, a
            // number as a VT_I4, bytes as a SAFEARRAY of VT_UI1, as REG_SZ,
            // REG_DWORD and REG_BINARY read back - when that or nothing was asked.
            const natural = typeof value === 'string' ? VT_BSTR
                : typeof value === 'number' ? VT_I4 : VT_ARRAY | VT_UI1;
            const asked = host.readU32(variant >>> 0) & 0xffff;
            if (asked !== VT_EMPTY && asked !== natural)
            {
                return E_INVALIDARG;
            }
            const payload = typeof value === 'string' ? await host.allocateString(value)
                : typeof value === 'number' ? value
                    : await host.allocateBytes?.(value) ?? 0;
            if (typeof value === 'object' && payload === 0)
            {
                return E_OUTOFMEMORY;
            }
            host.writeMemory(variant >>> 0, dword(natural));
            host.writeMemory((variant >>> 0) + 8, dword(payload));
            return S_OK;
        },
        /** HRESULT Write(LPCOLESTR pszPropName, VARIANT *pVar) */
        Write: (filter, [name, variant])=>{
            if ((name >>> 0) === 0 || (variant >>> 0) === 0)
            {
                return E_POINTER;
            }
            const type = host.readU32(variant >>> 0) & 0xffff;
            const data = host.readU32((variant >>> 0) + 8);
            /** @type {string | number | Uint8Array} */
            let written;
            if (type === VT_BSTR)
            {
                written = host.readWideString(data, NAME_BYTES);
            }
            else if (type === VT_I4)
            {
                written = data | 0;
            }
            else if (type === (VT_ARRAY | VT_UI1) && data !== 0)
            {
                // SAFEARRAY: cDims, fFeatures, cbElements, cLocks, pvData, then
                // the one dimension's count.
                written = host.readMemory?.(host.readU32(data + 12), host.readU32(data + 16))
                    ?? new Uint8Array(0);
            }
            else
            {
                return E_INVALIDARG;
            }
            const text = typeof written === 'string' ? written : '';
            const property = host.readWideString(name >>> 0, NAME_BYTES);
            // FriendlyName and CLSID are the registration's own: a moniker
            // parsed from a name nothing was under becomes a device in its
            // category once written to, as the key Windows creates does.
            if (property === 'FriendlyName' && typeof written === 'string')
            {
                filter.name = text;
            }
            else if (property === 'CLSID' && typeof written === 'string')
            {
                filter.clsid = text.toUpperCase();
            }
            else
            {
                filter.properties.set(property, written);
            }
            if (filter.category !== '' && !store.find(filter.category, filter.instance))
            {
                store.register(filter);
            }
            return S_OK;
        },
    };

    /** @param {RegisteredFilter} filter */
    const displayName = filter=>filter.display
        ?? `@device:sw:${filter.category}\\${filter.instance}`;

    /** @type {Record<string, (filter: RegisteredFilter, args: number[], self: any) => number | Promise<number>>} */
    const moniker = {
        GetClassID: (filter, [out])=>{
            // Windows' device moniker answers a missing out pointer here as a
            // bad argument, where its other methods answer E_POINTER.
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            host.writeMemory(out >>> 0, guidBytes(CLSID_DEVICE_MONIKER));
            return S_OK;
        },
        IsDirty: ()=>S_FALSE,
        /** HRESULT BindToObject(IBindCtx*, IMoniker *pmkToLeft, REFIID, void **ppv) */
        BindToObject: (filter, [, , iid, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (!filter.clsid)
            {
                // A device whose key holds no CLSID binds to no class.
                host.writeMemory(out >>> 0, dword(0));
                return REGDB_E_CLASSNOTREG;
            }
            return host.createInstance(filter.clsid, iid >>> 0, out >>> 0);
        },
        /** HRESULT BindToStorage(IBindCtx*, IMoniker *pmkToLeft, REFIID, void **ppv) */
        BindToStorage: (filter, [, , iid, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (readGuid(iid >>> 0) !== IID_IPROPERTY_BAG)
            {
                host.writeMemory(out >>> 0, dword(0));
                return MK_E_NOSTORAGE;
            }
            const bag = createComObject(CLSID_DEVICE_MONIKER, {
                state: filter,
                interfaces: [describe(IID_IPROPERTY_BAG, IPROPERTY_BAG_SLOTS, propertyBag)],
            });
            host.writeMemory(out >>> 0, dword(host.publish(bag, IID_IPROPERTY_BAG)));
            return S_OK;
        },
        Reduce: (filter, [, , , out])=>((out >>> 0) === 0 ? E_POINTER : MK_S_REDUCED_TO_SELF),
        /**
         * HRESULT IsEqual(IMoniker *pmkOtherMoniker): another device moniker
         * naming the same registration; a moniker the program made is not one.
         */
        IsEqual: (filter, [other])=>{
            if ((other >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const peer = host.objectAt?.(other >>> 0);
            const named = peer?.clsid === CLSID_DEVICE_MONIKER ? peer.state : null;
            return named && displayName(named).toLowerCase() === displayName(filter).toLowerCase()
                ? S_OK : S_FALSE;
        },
        /** HRESULT Hash(DWORD *pdwHash) */
        Hash: (filter, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            let hash = 0;
            for (const char of displayName(filter))
            {
                hash = Math.imul(hash, 31) + char.charCodeAt(0) | 0;
            }
            host.writeMemory(out >>> 0, dword(hash));
            return S_OK;
        },
        /** HRESULT GetDisplayName(IBindCtx*, IMoniker *pmkToLeft, LPOLESTR *ppszDisplayName) */
        GetDisplayName: (filter, [, , out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const text = wide(displayName(filter));
            const at = host.allocate(text.length);
            host.writeMemory(at, text);
            host.writeMemory(out >>> 0, dword(at));
            return S_OK;
        },
        /** HRESULT IsSystemMoniker(DWORD *pdwMksys) */
        IsSystemMoniker: (filter, [out])=>{
            if ((out >>> 0) !== 0)
            {
                host.writeMemory(out >>> 0, dword(MKSYS_NONE));
            }
            return S_FALSE;
        },
    };

    /** @param {RegisteredFilter} filter @returns {number} an IMoniker with one reference */
    const monikerFor = filter=>host.publish(createComObject(CLSID_DEVICE_MONIKER, {
        state: filter,
        interfaces: [
            describe(IID_IMONIKER, IMONIKER_SLOTS, moniker),
            describe(IID_IPERSIST_STREAM, IMONIKER_SLOTS.slice(0, 5), moniker),
            describe(IID_IPERSIST, IMONIKER_SLOTS.slice(0, 1), moniker),
        ],
    }), IID_IMONIKER);

    /**
     * @typedef {Object} EnumState
     * @property {RegisteredFilter[]} filters  As they were when the enumerator was made.
     * @property {number} at
     */

    /** @type {Record<string, (state: EnumState, args: number[]) => number>} */
    const enumMoniker = {
        /** HRESULT Next(ULONG celt, IMoniker **rgelt, ULONG *pceltFetched) */
        Next: (state, [count, out, fetched])=>{
            if ((out >>> 0) === 0 || ((fetched >>> 0) === 0 && (count >>> 0) > 1))
            {
                return E_POINTER;
            }
            let given = 0;
            while (given < (count >>> 0) && state.at < state.filters.length)
            {
                const pointer = monikerFor(state.filters[state.at]);
                host.writeMemory((out >>> 0) + given * 4, dword(pointer));
                state.at++;
                given++;
            }
            if ((fetched >>> 0) !== 0)
            {
                host.writeMemory(fetched >>> 0, dword(given));
            }
            return given === (count >>> 0) ? S_OK : S_FALSE;
        },
        Skip: (state, [count])=>{
            const left = state.filters.length - state.at;
            state.at += Math.min(count >>> 0, left);
            return (count >>> 0) <= left ? S_OK : S_FALSE;
        },
        Reset: state=>{
            state.at = 0;
            return S_OK;
        },
        Clone: (state, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            host.writeMemory(out >>> 0, dword(enumerate(state.filters, state.at)));
            return S_OK;
        },
    };

    /**
     * An IEnumMoniker over `filters`, with one reference.
     *
     * @param {RegisteredFilter[]} filters @param {number} [at]
     */
    function enumerate(filters, at = 0){
        return host.publish(createComObject(CLSID_SYSTEM_DEVICE_ENUM, {
            state: { filters: [...filters], at },
            interfaces: [describe(IID_IENUM_MONIKER, IENUM_MONIKER_SLOTS, enumMoniker)],
        }), IID_IENUM_MONIKER);
    }

    /** @type {Record<string, (state: null, args: number[]) => number>} */
    const createDevEnum = {
        /** HRESULT CreateClassEnumerator(REFCLSID clsidDeviceClass, IEnumMoniker **ppEnumMoniker, DWORD dwFlags) */
        CreateClassEnumerator: (state, [category, out])=>{
            if ((category >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const filters = store.list(readGuid(category >>> 0));
            if (filters.length === 0)
            {
                // An empty category hands out no enumerator, as the documentation says.
                host.writeMemory(out >>> 0, dword(0));
                return S_FALSE;
            }
            host.writeMemory(out >>> 0, dword(enumerate(filters)));
            return S_OK;
        },
    };

    /** @returns {import('../ole32/objects.js').ComClassDefinition} */
    const systemDeviceEnum = ()=>({
        state: null,
        interfaces: [describe(IID_ICREATE_DEV_ENUM, ICREATE_DEV_ENUM_SLOTS, createDevEnum)],
    });

    /**
     * The registration a display name names: `@device:sw:{category}\instance`,
     * or a DMO's `@device:dmo:{clsid}{category}`, matched as their monikers
     * name them.
     *
     * @param {string} text
     */
    const named = text=>{
        const lower = text.toLowerCase();
        const dmos = host.dmos?.() ?? [];
        return [...store.list(), ...dmos].find(filter=>displayName(filter).toLowerCase() === lower);
    };

    /**
     * A software device's name nothing is registered under: its moniker all
     * the same, as Windows' parses any well-formed name, binding to nothing
     * until a filter is registered there.
     *
     * @param {string} text
     * @returns {RegisteredFilter | undefined}
     */
    const unregistered = text=>{
        if (!/^@device:/i.test(text))
        {
            return undefined;
        }
        // A name with no category in it parses all the same, and names its
        // own text: nothing is ever registered under it.
        const match = /^@device:sw:(\{[0-9a-f-]{36}\})\\(.+)$/i.exec(text);
        return { category: match ? match[1].toUpperCase() : '', instance: match ? match[2] : text,
            clsid: '', name: '', merit: 0, pins: [], properties: new Map(),
            display: match ? undefined : text };
    };

    /**
     * IParseDisplayName::ParseDisplayName and IMoniker::ParseDisplayName of
     * CLSID_CDeviceMoniker: the moniker of the registration a whole display
     * name names, which MkParseDisplayName reaches through the "device" ProgID.
     *
     * @param {number} nameAt @param {number} eaten @param {number} out
     */
    const parse = (nameAt, eaten, out)=>{
        if ((nameAt >>> 0) === 0 || (eaten >>> 0) === 0 || (out >>> 0) === 0)
        {
            return E_POINTER;
        }
        const text = host.readWideString(nameAt >>> 0, NAME_BYTES);
        host.writeMemory(out >>> 0, dword(0));
        const filter = named(text) ?? unregistered(text);
        if (!filter)
        {
            host.writeMemory(eaten >>> 0, dword(0));
            return MK_E_SYNTAX;
        }
        host.writeMemory(eaten >>> 0, dword(text.length));
        host.writeMemory(out >>> 0, dword(monikerFor(filter)));
        return S_OK;
    };

    /**
     * CLSID_CDeviceMoniker made by CoCreateInstance: a device moniker naming
     * nothing yet, which parses a display name into the one that does.
     *
     * @returns {import('../ole32/objects.js').ComClassDefinition}
     */
    const deviceMoniker = ()=>({
        state: null,
        interfaces: [describe(IID_IPARSE_DISPLAY_NAME, IPARSE_DISPLAY_NAME_SLOTS, {
            /** HRESULT ParseDisplayName(IBindCtx*, LPOLESTR, ULONG *pchEaten, IMoniker **ppmkOut) */
            ParseDisplayName: (state, [, name, eaten, out])=>parse(name, eaten, out),
        })],
    });

    return { systemDeviceEnum, deviceMoniker, monikerFor, enumerate, readGuid, guidBytes };
}

