/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The component categories manager: the class ole32 serves for which
 * categories exist and which classes implement or require each, all of it
 * kept in the registry.
 *
 * A category is a key under HKCR\Component Categories named by its CATID,
 * whose values are its description in each locale, named by the locale in
 * hexadecimal. A class's categories are the keys under its CLSID key's
 * "Implemented Categories" and "Required Categories".
 */

import { HKEY_CLASSES_ROOT, REG_SZ } from '../advapi32/registry.js';
import { canonicalGuid, formatGuid, parseGuid } from './guid.js';
import { publishEnumerator } from './enumerator.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

export const CLSID_STD_COMPONENT_CATEGORIES_MGR = '{0002E005-0000-0000-C000-000000000046}';
const IID_ICATREGISTER = '{0002E012-0000-0000-C000-000000000046}';
const IID_ICATINFORMATION = '{0002E013-0000-0000-C000-000000000046}';
const IID_IENUMCATEGORYINFO = '{0002E011-0000-0000-C000-000000000046}';
const IID_IENUMGUID = '{0002E000-0000-0000-C000-000000000046}';
/** This layer's classes of the two enumerators. */
const CLSID_CATEGORY_ENUMERATOR = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b003c}';
const CLSID_GUID_ENUMERATOR = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b003d}';

const S_OK = 0;
const S_FALSE = 1;
const E_INVALIDARG = 0x80070057 | 0;
const E_POINTER = 0x80004003 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const CAT_E_CATIDNOEXIST = 0x80040160 | 0;
const CAT_E_NODESCRIPTION = 0x80040161 | 0;
const REGDB_E_WRITEREGDB = 0x80040151 | 0;

const CATEGORIES = 'Component Categories';
const IMPLEMENTED = 'Implemented Categories';
const REQUIRED = 'Required Categories';
/** CATEGORYINFO: catid, lcid, szDescription[128]. */
const CATEGORYINFO_BYTES = 16 + 4 + 128 * 2;
const DESCRIPTION_UNITS = 128;
const GUID_BYTES = 16;
/** A count of categories read from the program, at most. */
const MAX_COUNT = 1 << 16;

/**
 * @typedef {Object} CategoryEnv
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => unknown }} heap
 * @property {import('./objects.js').ComRegistry} registry
 * @property {(clsid: string, definition: import('./objects.js').ComClassDefinition)
 *     => import('./objects.js').ComObject | null} makeObject
 * @property {(object: import('./objects.js').ComObject, iid: string) => number} publish
 * @property {() => unknown} callerThread
 * @property {{ root: (id: number) => any, open: (key: any, path: string) => any,
 *     getValue: (key: any, name: string) => { data: Uint8Array } | null,
 *     subkeys?: (key: any) => string[],
 *     values?: (key: any) => { name: string, data: Uint8Array }[],
 *     create?: (key: any, path: string) => { key: any },
 *     setValue?: (key: any, name: string, type: number, data: Uint8Array) => void,
 *     remove?: (key: any, path: string) => string } | undefined} hive
 */

/** @param {CategoryEnv} env */
export function registerComponentCategories(env){
    /** @param {number} address */
    const readU32 = address=>new DataView(env.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        env.writeMemory(address >>> 0, bytes);
    };
    /** @param {number} address */
    const guidAt = address=>formatGuid(env.readMemory(address >>> 0, GUID_BYTES));
    /** @param {string} text */
    const wide = text=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let index = 0; index < text.length; index++)
        {
            bytes[index * 2] = text.charCodeAt(index) & 0xff;
            bytes[index * 2 + 1] = text.charCodeAt(index) >>> 8;
        }
        return bytes;
    };
    /** @param {Uint8Array} data  A REG_SZ's bytes, as the hive keeps them. */
    const text = data=>{
        const end = data.indexOf(0);
        return decodeAnsi(end < 0 ? data : data.subarray(0, end));
    };
    /** @param {number} address @param {number} units */
    const readWide = (address, units)=>{
        let result = '';
        for (let index = 0; index < units; index++)
        {
            const bytes = env.readMemory((address >>> 0) + index * 2, 2);
            const unit = bytes[0] | (bytes[1] << 8);
            if (unit === 0)
            {
                break;
            }
            result += String.fromCharCode(unit);
        }
        return result;
    };
    const root = ()=>env.hive?.root(HKEY_CLASSES_ROOT) ?? null;
    /** @param {string} path */
    const open = path=>{
        const base = root();
        return base ? env.hive?.open(base, path) ?? null : null;
    };
    /** @param {string} path */
    const create = path=>{
        const base = root();
        return base && env.hive?.create ? env.hive.create(base, path).key : null;
    };
    /** @param {string} path */
    const remove = path=>{
        const base = root();
        if (base)
        {
            env.hive?.remove?.(base, path);
        }
    };
    /** The CATIDs a list of the program's names, at most MAX_COUNT of them. @param {number} count @param {number} list */
    const catids = (count, list)=>{
        /** @type {string[]} */
        const ids = [];
        for (let index = 0; index < Math.min(count >>> 0, MAX_COUNT); index++)
        {
            ids.push(guidAt((list >>> 0) + index * GUID_BYTES));
        }
        return ids;
    };
    /** The categories a key lists as subkeys. @param {any} key */
    const listed = key=>(key ? (env.hive?.subkeys?.(key) ?? [])
        .map(name=>canonicalGuid(name)).filter(id=>id !== null) : []);

    /**
     * Writes a class's implemented or required categories, or takes them away.
     *
     * @param {string} which @param {boolean} add
     * @returns {(object: unknown, args: number[]) => number}
     */
    const classCategories = (which, add)=>(_object, [clsid, count, list])=>{
        if ((clsid >>> 0) === 0 || ((count >>> 0) !== 0 && (list >>> 0) === 0))
        {
            return E_INVALIDARG;
        }
        const base = `CLSID\\${guidAt(clsid)}\\${which}`;
        for (const catid of catids(count, list))
        {
            if (add)
            {
                if (!create(`${base}\\${catid}`))
                {
                    return REGDB_E_WRITEREGDB;
                }
            }
            else
            {
                remove(`${base}\\${catid}`);
            }
        }
        if (!add && listed(open(base)).length === 0)
        {
            remove(base);
        }
        return S_OK;
    };

    /**
     * The description of a category in a locale: the one asked for, else
     * the first the category has.
     *
     * @param {any} key @param {number} lcid
     * @returns {{ lcid: number, text: string } | null}
     */
    const describe = (key, lcid)=>{
        const own = env.hive?.getValue(key, (lcid >>> 0).toString(16));
        if (own)
        {
            return { lcid: lcid >>> 0, text: text(own.data) };
        }
        const first = (env.hive?.values?.(key) ?? []).find(value=>/^[0-9a-f]+$/i.test(value.name));
        return first ? { lcid: Number.parseInt(first.name, 16), text: text(first.data) } : null;
    };

    /** @param {string[]} ids @param {number} out */
    const publishGuids = (ids, out)=>publishEnumerator(env,
        { clsid: CLSID_GUID_ENUMERATOR, iid: IID_IENUMGUID, size: GUID_BYTES }, {
            items: ids,
            write: (at, id)=>{
                env.writeMemory(at, /** @type {Uint8Array} */ (parseGuid(id)));
                return true;
            },
        }, out >>> 0);

    /** @type {import('./objects.js').ComMethod[]} */
    const REGISTER_METHODS = [
        { name: 'RegisterCategories', argBytes: 12, invoke: (_object, [count, infos])=>{
            if ((count >>> 0) !== 0 && (infos >>> 0) === 0)
            {
                return E_POINTER;
            }
            for (let index = 0; index < Math.min(count >>> 0, MAX_COUNT); index++)
            {
                const at = (infos >>> 0) + index * CATEGORYINFO_BYTES;
                const key = create(`${CATEGORIES}\\${guidAt(at)}`);
                if (!key || !env.hive?.setValue)
                {
                    return REGDB_E_WRITEREGDB;
                }
                const description = readWide(at + 20, DESCRIPTION_UNITS);
                env.hive.setValue(key, readU32(at + 16).toString(16), REG_SZ,
                    encodeAnsi(`${description}\0`));
            }
            return S_OK;
        } },
        { name: 'UnRegisterCategories', argBytes: 12, invoke: (_object, [count, list])=>{
            if ((count >>> 0) !== 0 && (list >>> 0) === 0)
            {
                return E_POINTER;
            }
            for (const catid of catids(count, list))
            {
                remove(`${CATEGORIES}\\${catid}`);
            }
            return S_OK;
        } },
        { name: 'RegisterClassImplCategories', argBytes: 16,
            invoke: classCategories(IMPLEMENTED, true) },
        { name: 'UnRegisterClassImplCategories', argBytes: 16,
            invoke: classCategories(IMPLEMENTED, false) },
        { name: 'RegisterClassReqCategories', argBytes: 16,
            invoke: classCategories(REQUIRED, true) },
        { name: 'UnRegisterClassReqCategories', argBytes: 16,
            invoke: classCategories(REQUIRED, false) },
    ];

    /** @type {import('./objects.js').ComMethod[]} */
    const INFORMATION_METHODS = [
        { name: 'EnumCategories', argBytes: 12, invoke: (_object, [lcid, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const base = open(CATEGORIES);
            const items = listed(base).map(catid=>{
                const key = env.hive?.open(base, catid);
                return { catid, about: key ? describe(key, lcid) : null };
            });
            return publishEnumerator(env, { clsid: CLSID_CATEGORY_ENUMERATOR,
                iid: IID_IENUMCATEGORYINFO, size: CATEGORYINFO_BYTES }, {
                items,
                write: (at, item)=>{
                    const record = new Uint8Array(CATEGORYINFO_BYTES);
                    record.set(/** @type {Uint8Array} */ (parseGuid(item.catid)), 0);
                    new DataView(record.buffer).setUint32(16, item.about?.lcid ?? lcid >>> 0, true);
                    record.set(wide((item.about?.text ?? '').slice(0, DESCRIPTION_UNITS - 1)), 20);
                    env.writeMemory(at, record);
                    return true;
                },
            }, out >>> 0);
        } },
        { name: 'GetCategoryDesc', argBytes: 16, invoke: (_object, [catid, lcid, out])=>{
            if ((catid >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const key = open(`${CATEGORIES}\\${guidAt(catid)}`);
            if (!key)
            {
                return CAT_E_CATIDNOEXIST;
            }
            const about = describe(key, lcid);
            if (!about)
            {
                return CAT_E_NODESCRIPTION;
            }
            const bytes = wide(about.text);
            const block = env.heap.allocate(bytes.length);
            if (block === 0)
            {
                return E_OUTOFMEMORY;
            }
            env.writeMemory(block, bytes);
            writeU32(out, block);
            return S_OK;
        } },
        { name: 'EnumClassesOfCategories', argBytes: 24,
            invoke: (_object, [implementedCount, implemented, requiredCount, required, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                // A count of -1 means the list does not matter.
                const wanted = (implementedCount | 0) === -1 ? null
                    : catids(implementedCount, implemented);
                const needs = (requiredCount | 0) === -1 ? null : catids(requiredCount, required);
                const classes = listed(open('CLSID')).filter(clsid=>
                    matches(clsid, wanted, needs));
                return publishGuids(classes, out);
            } },
        { name: 'IsClassOfCategories', argBytes: 24,
            invoke: (_object, [clsid, implementedCount, implemented, requiredCount, required])=>{
                if ((clsid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const wanted = (implementedCount | 0) === -1 ? null
                    : catids(implementedCount, implemented);
                const needs = (requiredCount | 0) === -1 ? null : catids(requiredCount, required);
                return matches(guidAt(clsid), wanted, needs) ? S_OK : S_FALSE;
            } },
        { name: 'EnumImplCategoriesOfClass', argBytes: 12, invoke: (_object, [clsid, out])=>{
            if ((clsid >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            return publishGuids(listed(open(`CLSID\\${guidAt(clsid)}\\${IMPLEMENTED}`)), out);
        } },
        { name: 'EnumReqCategoriesOfClass', argBytes: 12, invoke: (_object, [clsid, out])=>{
            if ((clsid >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            return publishGuids(listed(open(`CLSID\\${guidAt(clsid)}\\${REQUIRED}`)), out);
        } },
    ];

    /**
     * Whether a class implements at least one of `wanted` and requires
     * nothing outside `needs`; null for either is no condition.
     *
     * @param {string} clsid @param {string[] | null} wanted @param {string[] | null} needs
     */
    const matches = (clsid, wanted, needs)=>{
        const implemented = listed(open(`CLSID\\${clsid}\\${IMPLEMENTED}`));
        const requires = listed(open(`CLSID\\${clsid}\\${REQUIRED}`));
        const implementsOne = wanted === null
            || wanted.some(catid=>implemented.includes(catid));
        const needsNothingElse = needs === null
            || requires.every(catid=>needs.includes(catid));
        return implementsOne && needsNothingElse;
    };

    env.registry.registerClass(CLSID_STD_COMPONENT_CATEGORIES_MGR, ()=>({
        interfaces: [
            { id: IID_ICATREGISTER, methods: REGISTER_METHODS },
            { id: IID_ICATINFORMATION, methods: INFORMATION_METHODS },
        ],
    }));
}
