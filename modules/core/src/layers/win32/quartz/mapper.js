/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The filter mapper: IFilterMapper2 and IFilterMapper3, where a filter's
 * DllRegisterServer registers it, the first IFilterMapper the SDK's base
 * classes fall back to, and EnumMatchingFilters, which finds registered filters
 * by merit, by what their pins render and by the media types they take or give.
 * One store of registrations serves both mappers and the device enumerator
 * (`devenum/devenum.js`): a filter registered either way is found either way,
 * as the documentation describes the two.
 *
 * A request matches a filter when the filter's merit reaches it, when a filter
 * asked to render has an input pin marked to render, and when an input (or
 * output) pin is asked for, the filter has one whose types meet the types
 * asked: GUID_NULL on either side matches any type.
 */

import { createComObject } from '../ole32/objects.js';
import { describe } from './describe.js';
import { formatGuid } from '../ole32/guid.js';
import { CLSID_LEGACY_AM_FILTER_CATEGORY, encodeFilterData } from '../devenum/devenum.js';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
/** VFW_E_NOT_FOUND: no such filter, pin or registration. */
const VFW_E_NOT_FOUND = 0x80040216;
/** HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND), what unregistering nothing answers. */
const NOT_REGISTERED = 0x80070002;

const GUID_NULL = '{00000000-0000-0000-0000-000000000000}';

/** REGFILTERPINS2::dwFlags. */
const REG_PINFLAG_B_ZERO = 0x1;
const REG_PINFLAG_B_RENDERER = 0x2;
const REG_PINFLAG_B_MANY = 0x4;
const REG_PINFLAG_B_OUTPUT = 0x8;

/** REGFILTER2, REGFILTERPINS, REGFILTERPINS2 and REGPINTYPES as a 32-bit process lays them out. */
const REGFILTER2 = { VERSION: 0, MERIT: 4, PINS: 8, PIN_ARRAY: 12 };
const PINS1 = {
    NAME: 0, RENDERED: 4, OUTPUT: 8, ZERO: 12, MANY: 16, TYPES: 28, TYPE_ARRAY: 32, BYTES: 36,
};
const PINS2 = { FLAGS: 0, TYPES: 8, TYPE_ARRAY: 12, BYTES: 28 };
const PIN_TYPE = { MAJOR: 0, MINOR: 4, BYTES: 8 };
/** REGFILTER: the class, then a pointer to the name, which follows it in one block. */
const REGFILTER_BYTES = 20;

/** A name read whole, as long as a registry key name may be. */
const NAME_BYTES = 255 * 2;

/** @type {[string, number][]} */
export const IENUM_REG_FILTERS_SLOTS = [['Next', 3], ['Skip', 1], ['Reset', 0], ['Clone', 1]];
export const IID_IENUM_REG_FILTERS = '{56A868A4-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IAM_FILTER_DATA = '{97F7C4D4-547B-4A5F-8332-536430AD2E4D}';
/** @type {[string, number][]} */
export const IAM_FILTER_DATA_SLOTS = [['ParseFilterData', 3], ['CreateFilterData', 3]];

/**
 * @typedef {import('../devenum/devenum.js').RegisteredFilter} RegisteredFilter
 * @typedef {import('../devenum/devenum.js').RegisteredPin} RegisteredPin
 */

/**
 * @typedef {Object} MapperHost
 * @property {(address: number) => number} readU32
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate  Task memory.
 * @property {(object: import('../ole32/objects.js').ComObject, iid: string) => number} publish
 * @property {() => import('../devenum/devenum.js').RegisteredFilter[]} [dmos]
 *     The DMOs registered, enumerated beside the filters as Windows 7 and later do.
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

/**
 * The mappers' methods over the store.
 *
 * @param {MapperHost} host
 * @param {import('../devenum/devenum.js').FilterStore} store
 * @param {ReturnType<typeof import('../devenum/devenum.js').createDeviceEnumeration>} devices
 */
export function createFilterMapper(host, store, devices){
    const { readGuid, guidBytes } = devices;
    /** A pointer to a GUID, GUID_NULL for none. @param {number} address */
    const guidAt = address=>((address >>> 0) === 0 ? GUID_NULL : readGuid(address >>> 0));
    /** A GUID passed by value as four dwords. @param {number[]} words */
    const guidOf = words=>{
        const bytes = new Uint8Array(16);
        words.forEach((word, i)=>bytes.set(dword(word), i * 4));
        return formatGuid(bytes);
    };

    /** @param {number} array @param {number} count @returns {[string, string][]} */
    const readTypes = (array, count)=>Array.from({ length: count >>> 0 }, (_, i)=>{
        const at = (array >>> 0) + i * PIN_TYPE.BYTES;
        return [guidAt(host.readU32(at + PIN_TYPE.MAJOR)),
            guidAt(host.readU32(at + PIN_TYPE.MINOR))];
    });

    /**
     * The pins a REGFILTER2 describes, in its first form or its second.
     *
     * @param {number} description
     * @returns {{ merit: number, pins: RegisteredPin[] } | null}
     */
    const readRegistration = description=>{
        const version = host.readU32(description + REGFILTER2.VERSION);
        const merit = host.readU32(description + REGFILTER2.MERIT);
        const count = host.readU32(description + REGFILTER2.PINS);
        const array = host.readU32(description + REGFILTER2.PIN_ARRAY);
        if (version === 1)
        {
            return { merit, pins: Array.from({ length: count }, (_, i)=>{
                const at = array + i * PINS1.BYTES;
                const name = host.readU32(at + PINS1.NAME);
                return {
                    name: name === 0 ? '' : host.readWideString(name, NAME_BYTES),
                    renderer: host.readU32(at + PINS1.RENDERED) !== 0,
                    output: host.readU32(at + PINS1.OUTPUT) !== 0,
                    zero: host.readU32(at + PINS1.ZERO) !== 0,
                    many: host.readU32(at + PINS1.MANY) !== 0,
                    types: readTypes(host.readU32(at + PINS1.TYPE_ARRAY),
                        host.readU32(at + PINS1.TYPES)),
                };
            }) };
        }
        if (version === 2)
        {
            return { merit, pins: Array.from({ length: count }, (_, i)=>{
                const at = array + i * PINS2.BYTES;
                const flags = host.readU32(at + PINS2.FLAGS);
                return {
                    name: `${i}`,
                    renderer: (flags & REG_PINFLAG_B_RENDERER) !== 0,
                    output: (flags & REG_PINFLAG_B_OUTPUT) !== 0,
                    zero: (flags & REG_PINFLAG_B_ZERO) !== 0,
                    many: (flags & REG_PINFLAG_B_MANY) !== 0,
                    instances: host.readU32(at + 4),
                    types: readTypes(host.readU32(at + PINS2.TYPE_ARRAY),
                        host.readU32(at + PINS2.TYPES)),
                };
            }) };
        }
        return null;
    };

    /** A category asked for by pointer; none is the legacy filters'. @param {number} address */
    const categoryOf = address=>(guidAt(address) === GUID_NULL
        ? CLSID_LEGACY_AM_FILTER_CATEGORY : guidAt(address));

    /** @param {string} a @param {string} b */
    const meets = (a, b)=>a === GUID_NULL || b === GUID_NULL || a === b;

    /**
     * Whether a pin of the filter, of the direction asked, takes one of the types
     * asked; any pin of that direction where no type is asked.
     *
     * @param {RegisteredFilter} filter @param {boolean} output @param {[string, string][]} wanted
     */
    const hasPin = (filter, output, wanted)=>filter.pins.some(pin=>pin.output === output
        && (wanted.length === 0 || wanted.some(([major, minor])=>pin.types.some(([m, s])=>
            meets(major, m) && meets(minor, s)))));

    /**
     * The registered filters a request matches, highest merit first, each class once.
     *
     * @param {{ merit: number, render: boolean, inputNeeded: boolean, inputs: [string, string][],
     *     outputNeeded: boolean, outputs: [string, string][] }} request
     */
    const matching = request=>{
        /** @type {Map<string, RegisteredFilter>} */
        const found = new Map();
        for (const filter of [...store.list(), ...host.dmos?.() ?? []])
        {
            if ((filter.merit >>> 0) < (request.merit >>> 0) || found.has(filter.clsid))
            {
                continue;
            }
            if (request.render && !filter.pins.some(pin=>!pin.output && pin.renderer))
            {
                continue;
            }
            if (request.inputNeeded && !hasPin(filter, false, request.inputs))
            {
                continue;
            }
            if (request.outputNeeded && !hasPin(filter, true, request.outputs))
            {
                continue;
            }
            found.set(filter.clsid, filter);
        }
        return [...found.values()].sort((a, b)=>(b.merit >>> 0) - (a.merit >>> 0));
    };

    /** @param {number} array @param {number} count @returns {[string, string][]} */
    const readTypePairs = (array, count)=>Array.from(
        { length: (array >>> 0) === 0 ? 0 : count >>> 0 },
        (_, i)=>[guidAt((array >>> 0) + i * 32), guidAt((array >>> 0) + i * 32 + 16)]);

    /** @type {Record<string, (state: any, args: number[]) => number>} */
    const mapper2 = {
        /** HRESULT CreateCategory(REFCLSID clsidCategory, DWORD dwCategoryMerit, LPCWSTR Description) */
        CreateCategory: (state, [category])=>((category >>> 0) === 0 ? E_POINTER : S_OK),
        /** HRESULT UnregisterFilter(const CLSID *pclsidCategory, LPCOLESTR szInstance, REFCLSID Filter) */
        UnregisterFilter: (state, [category, instance, clsid])=>{
            if ((clsid >>> 0) === 0)
            {
                return E_POINTER;
            }
            const filter = readGuid(clsid >>> 0);
            const name = (instance >>> 0) === 0 ? filter
                : host.readWideString(instance >>> 0, NAME_BYTES);
            return store.unregister(categoryOf(category), name) ? S_OK : NOT_REGISTERED;
        },
        /**
         * HRESULT RegisterFilter(REFCLSID clsidFilter, LPCWSTR Name, IMoniker **ppMoniker,
         *     const CLSID *pclsidCategory, LPCOLESTR szInstance, const REGFILTER2 *prf2)
         */
        RegisterFilter: (state, [clsid, name, moniker, category, instance, description])=>{
            if ((clsid >>> 0) === 0 || (name >>> 0) === 0 || (description >>> 0) === 0)
            {
                return E_POINTER;
            }
            const registration = readRegistration(description >>> 0);
            if (!registration)
            {
                return E_INVALIDARG;
            }
            const filterClass = readGuid(clsid >>> 0);
            /** @type {RegisteredFilter} */
            const filter = {
                category: categoryOf(category),
                instance: (instance >>> 0) === 0 ? filterClass
                    : host.readWideString(instance >>> 0, NAME_BYTES),
                clsid: filterClass,
                name: host.readWideString(name >>> 0, NAME_BYTES),
                merit: registration.merit,
                pins: registration.pins,
                properties: new Map(),
            };
            store.register(filter);
            if ((moniker >>> 0) !== 0)
            {
                host.writeMemory(moniker >>> 0, dword(devices.monikerFor(filter)));
            }
            return S_OK;
        },
        /**
         * HRESULT EnumMatchingFilters(IEnumMoniker **ppEnum, DWORD dwFlags, BOOL bExactMatch,
         *     DWORD dwMerit, BOOL bInputNeeded, DWORD cInputTypes, const GUID *pInputTypes,
         *     const REGPINMEDIUM *pMedIn, const CLSID *pPinCategoryIn, BOOL bRender,
         *     BOOL bOutputNeeded, DWORD cOutputTypes, const GUID *pOutputTypes,
         *     const REGPINMEDIUM *pMedOut, const CLSID *pPinCategoryOut)
         */
        EnumMatchingFilters: (state, args)=>{
            const [out, , , merit, inputNeeded, inputCount, inputs, , ,
                render, outputNeeded, outputCount, outputs] = args;
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const filters = matching({
                merit, render: render !== 0,
                inputNeeded: inputNeeded !== 0, inputs: readTypePairs(inputs, inputCount),
                outputNeeded: outputNeeded !== 0, outputs: readTypePairs(outputs, outputCount),
            });
            host.writeMemory(out >>> 0, dword(devices.enumerate(filters)));
            return S_OK;
        },
        /** HRESULT GetICreateDevEnum(ICreateDevEnum **ppEnum) */
        GetICreateDevEnum: (state, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const object = createComObject('{62BE5D10-60EB-11D0-BD3B-00A0C911CE86}',
                devices.systemDeviceEnum());
            host.writeMemory(out >>> 0, dword(host.publish(object,
                '{29840822-5B84-11D0-BD3B-00A0C911CE86}')));
            return S_OK;
        },
    };

    /** @param {string} clsid */
    const legacy = clsid=>store.find(CLSID_LEGACY_AM_FILTER_CATEGORY, clsid);

    /** @type {Record<string, (state: { reg: RegisteredFilter[], at: number }, args: number[]) => number>} */
    const enumRegFilters = {
        /** HRESULT Next(ULONG cFilters, REGFILTER **apRegFilter, ULONG *pcFetched) */
        Next: (state, [count, out, fetched])=>{
            if ((out >>> 0) === 0 || ((fetched >>> 0) === 0 && (count >>> 0) > 1))
            {
                return E_POINTER;
            }
            let given = 0;
            while (given < (count >>> 0) && state.at < state.reg.length)
            {
                const filter = state.reg[state.at++];
                const name = wide(filter.name);
                const block = host.allocate(REGFILTER_BYTES + name.length);
                host.writeMemory(block, guidBytes(filter.clsid));
                host.writeMemory(block + 16, dword(block + REGFILTER_BYTES));
                host.writeMemory(block + REGFILTER_BYTES, name);
                host.writeMemory((out >>> 0) + given * 4, dword(block));
                given++;
            }
            if ((fetched >>> 0) !== 0)
            {
                host.writeMemory(fetched >>> 0, dword(given));
            }
            return given === (count >>> 0) ? S_OK : S_FALSE;
        },
        Skip: (state, [count])=>{
            const left = state.reg.length - state.at;
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
            host.writeMemory(out >>> 0, dword(regEnumerator(state.reg, state.at)));
            return S_OK;
        },
    };

    /** @param {RegisteredFilter[]} reg @param {number} at */
    const regEnumerator = (reg, at)=>host.publish(createComObject(IID_IENUM_REG_FILTERS, {
        state: { reg: [...reg], at },
        interfaces: [describe(IID_IENUM_REG_FILTERS, IENUM_REG_FILTERS_SLOTS, enumRegFilters)],
    }), IID_IENUM_REG_FILTERS);

    /** @type {Record<string, (state: any, args: number[]) => number>} */
    const mapper1 = {
        /** HRESULT RegisterFilter(CLSID clsid, LPCWSTR Name, DWORD dwMerit) */
        RegisterFilter: (state, [a, b, c, d, name, merit])=>{
            if ((name >>> 0) === 0)
            {
                return E_POINTER;
            }
            const clsid = guidOf([a, b, c, d]);
            store.register({
                category: CLSID_LEGACY_AM_FILTER_CATEGORY, instance: clsid, clsid,
                name: host.readWideString(name >>> 0, NAME_BYTES), merit: merit >>> 0,
                pins: legacy(clsid)?.pins ?? [], properties: new Map(),
            });
            return S_OK;
        },
        /**
         * HRESULT RegisterPin(CLSID Filter, LPCWSTR Name, BOOL bRendered, BOOL bOutput,
         *     BOOL bZero, BOOL bMany, CLSID ConnectsToFilter, LPCWSTR ConnectsToPin)
         */
        RegisterPin: (state, [a, b, c, d, name, rendered, output, zero, many])=>{
            const filter = legacy(guidOf([a, b, c, d]));
            if (!filter)
            {
                return VFW_E_NOT_FOUND;
            }
            const pinName = (name >>> 0) === 0 ? '' : host.readWideString(name >>> 0, NAME_BYTES);
            filter.pins = filter.pins.filter(pin=>pin.name !== pinName);
            filter.pins.push({ name: pinName, renderer: rendered !== 0, output: output !== 0,
                zero: zero !== 0, many: many !== 0, types: [] });
            return S_OK;
        },
        /** HRESULT RegisterPinType(CLSID clsFilter, LPCWSTR strName, CLSID clsMajorType, CLSID clsSubType) */
        RegisterPinType: (state, [a, b, c, d, name, ...types])=>{
            const filter = legacy(guidOf([a, b, c, d]));
            const pinName = (name >>> 0) === 0 ? '' : host.readWideString(name >>> 0, NAME_BYTES);
            const pin = filter?.pins.find(one=>one.name === pinName);
            if (!pin)
            {
                return VFW_E_NOT_FOUND;
            }
            pin.types.push([guidOf(types.slice(0, 4)), guidOf(types.slice(4, 8))]);
            return S_OK;
        },
        /** HRESULT UnregisterFilter(CLSID Filter) */
        UnregisterFilter: (state, [a, b, c, d])=>{
            store.unregister(CLSID_LEGACY_AM_FILTER_CATEGORY, guidOf([a, b, c, d]));
            return S_OK;
        },
        /** HRESULT UnregisterPin(CLSID Filter, LPCWSTR Name) */
        UnregisterPin: (state, [a, b, c, d, name])=>{
            const filter = legacy(guidOf([a, b, c, d]));
            if (!filter)
            {
                return VFW_E_NOT_FOUND;
            }
            const pinName = (name >>> 0) === 0 ? '' : host.readWideString(name >>> 0, NAME_BYTES);
            filter.pins = filter.pins.filter(pin=>pin.name !== pinName);
            return S_OK;
        },
        /**
         * HRESULT EnumMatchingFilters(IEnumRegFilters **ppEnum, DWORD dwMerit,
         *     BOOL bInputNeeded, CLSID clsInMaj, CLSID clsInSub, BOOL bRender,
         *     BOOL bOutputNeeded, CLSID clsOutMaj, CLSID clsOutSub)
         */
        EnumMatchingFilters: (state, [out, merit, inputNeeded, ...rest])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const inputs = /** @type {[string, string][]} */ (
                [[guidOf(rest.slice(0, 4)), guidOf(rest.slice(4, 8))]]);
            const outputs = /** @type {[string, string][]} */ (
                [[guidOf(rest.slice(10, 14)), guidOf(rest.slice(14, 18))]]);
            const filters = matching({
                merit, render: rest[8] !== 0, inputNeeded: inputNeeded !== 0, inputs,
                outputNeeded: rest[9] !== 0, outputs,
            });
            host.writeMemory(out >>> 0, dword(regEnumerator(filters, 0)));
            return S_OK;
        },
    };

    /**
     * The cell ParseFilterData answers through: a pointer to the REGFILTER2 it
     * made, kept by the mapper as Windows keeps it in quartz's data section.
     */
    let parsedCell = 0;

    /**
     * IAMFilterData: the registry's binary FilterData, version 2 - a header
     * (version, merit, pin count, a reserved word), then per pin its signature
     * ("0pi3" with the pin's index in its first byte), flags, instances, type
     * and medium counts and its category's offset, each type after it as
     * "0ty3", a reserved word and the offsets of its major and minor type; the
     * GUIDs come at the end, where the offsets point.
     */
    const filterData = {
        /** HRESULT ParseFilterData(BYTE *rgbFilterData, ULONG cb, BYTE **prgbRegFilter2) */
        ParseFilterData: (/** @type {any} */ state, /** @type {number[]} */ [data, bytes, out])=>{
            if ((data >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const word = (/** @type {number} */ offset)=>(offset + 4 <= (bytes >>> 0)
                ? host.readU32((data >>> 0) + offset) : 0);
            if (word(0) !== 2 || (bytes >>> 0) < 16)
            {
                return E_INVALIDARG;
            }
            const guid = (/** @type {number} */ offset)=>(offset === 0 || offset + 16 > (bytes >>> 0)
                ? GUID_NULL : readGuid((data >>> 0) + offset));
            /** @type {{ flags: number, instances: number, types: [string, string][] }[]} */
            const pins = [];
            let at = 16;
            for (let pin = 0; pin < word(8); pin++)
            {
                const typeCount = word(at + 12);
                const mediums = word(at + 16);
                const entry = { flags: word(at + 4), instances: word(at + 8),
                    /** @type {[string, string][]} */ types: [] };
                at += 24;
                for (let type = 0; type < typeCount; type++)
                {
                    entry.types.push([guid(word(at + 8)), guid(word(at + 12))]);
                    at += 16;
                }
                // A medium is a GUID and two words, by offset.
                at += mediums * 4;
                pins.push(entry);
            }
            // REGFILTER2, its pins, their types and the types' GUIDs: one block,
            // which the caller frees with CoTaskMemFree.
            const typeTotal = pins.reduce((sum, pin)=>sum + pin.types.length, 0);
            const pinsAt = REGFILTER2.PIN_ARRAY + 4;
            const typesAt = pinsAt + pins.length * PINS2.BYTES;
            const guidsAt = typesAt + typeTotal * PIN_TYPE.BYTES;
            const size = guidsAt + typeTotal * 32;
            const block = new Uint8Array(size);
            const view = new DataView(block.buffer);
            const base = host.allocate(size);
            view.setUint32(REGFILTER2.VERSION, 2, true);
            view.setUint32(REGFILTER2.MERIT, word(4), true);
            view.setUint32(REGFILTER2.PINS, pins.length, true);
            view.setUint32(REGFILTER2.PIN_ARRAY, base + pinsAt, true);
            let type = 0;
            pins.forEach((pin, index)=>{
                const pinAt = pinsAt + index * PINS2.BYTES;
                view.setUint32(pinAt + PINS2.FLAGS, pin.flags, true);
                view.setUint32(pinAt + 4, pin.instances, true);
                view.setUint32(pinAt + PINS2.TYPES, pin.types.length, true);
                view.setUint32(pinAt + PINS2.TYPE_ARRAY,
                    base + typesAt + type * PIN_TYPE.BYTES, true);
                for (const [major, minor] of pin.types)
                {
                    const typeAt = typesAt + type * PIN_TYPE.BYTES;
                    const pair = guidsAt + type * 32;
                    block.set(guidBytes(major), pair);
                    block.set(guidBytes(minor), pair + 16);
                    view.setUint32(typeAt + PIN_TYPE.MAJOR, base + pair, true);
                    view.setUint32(typeAt + PIN_TYPE.MINOR, base + pair + 16, true);
                    type++;
                }
            });
            host.writeMemory(base, block);
            parsedCell ||= host.allocate(4);
            host.writeMemory(parsedCell, dword(base));
            host.writeMemory(out >>> 0, dword(parsedCell));
            return S_OK;
        },
        /** HRESULT CreateFilterData(REGFILTER2 *prf2, BYTE **prgbFilterData, ULONG *pcb) */
        CreateFilterData: (/** @type {any} */ state, /** @type {number[]} */ [description, out, size])=>{
            if ((description >>> 0) === 0 || (out >>> 0) === 0 || (size >>> 0) === 0)
            {
                return E_POINTER;
            }
            const registration = readRegistration(description >>> 0);
            if (!registration)
            {
                return E_INVALIDARG;
            }
            const block = encodeFilterData(registration);
            const copy = host.allocate(block.length);
            host.writeMemory(copy, block);
            host.writeMemory(out >>> 0, dword(copy));
            host.writeMemory(size >>> 0, dword(block.length));
            return S_OK;
        },
    };

    return { mapper1, mapper2, filterData };
}
