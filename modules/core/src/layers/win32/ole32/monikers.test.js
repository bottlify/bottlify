/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// Where a case mirrors one of ole32's conformance tests (dlls/ole32/tests/
// moniker.c, compobj.c), its expectation is Windows' answer as that test
// records it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatGuid, parseGuid } from './guid.js';
import { createComRegistry } from './objects.js';
import {
    CLSID_ANTI_MONIKER, CLSID_CLASS_MONIKER, CLSID_COMPOSITE_MONIKER, CLSID_FILE_MONIKER,
    CLSID_ITEM_MONIKER, CLSID_OBJREF_MONIKER, CLSID_POINTER_MONIKER, IID_IBINDCTX, IID_IMONIKER,
    IID_IROTDATA, IID_IUNKNOWN, MKSYS, createMonikerFunctions,
} from './monikers.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_POINTER = 0x80004003 | 0;
const E_FAIL = 0x80004005 | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const E_INVALIDARG = 0x80070057 | 0;
const REGDB_E_CLASSNOTREG = 0x80040154 | 0;
const STG_E_INVALIDFLAG = 0x800300ff | 0;
const MK_E_NEEDGENERIC = 0x800401e2 | 0;
const MK_E_UNAVAILABLE = 0x800401e3 | 0;
const MK_E_SYNTAX = 0x800401e4 | 0;
const MK_E_INVALIDEXTENSION = 0x800401e6 | 0;
const MK_E_NOTBINDABLE = 0x800401e8 | 0;
const MK_E_NOTBOUND = 0x800401e9 | 0;
const MK_E_CANTOPENFILE = 0x800401ea | 0;
const MK_E_NOINVERSE = 0x800401ec | 0;
const MK_E_NOPREFIX = 0x800401ee | 0;
const MK_S_REDUCED_TO_SELF = 0x000401e2;
const MK_S_ME = 0x000401e4;
const MK_S_HIM = 0x000401e5;
const MK_S_US = 0x000401e6;
const CO_S_NOTALLINTERFACES = 0x00080012;

const IID_IPERSIST = '{0000010C-0000-0000-C000-000000000046}';
const IID_IPERSISTSTREAM = '{00000109-0000-0000-C000-000000000046}';
const IID_IPERSISTFILE = '{0000010B-0000-0000-C000-000000000046}';
const IID_IOLEITEMCONTAINER = '{0000011C-0000-0000-C000-000000000046}';
const IID_IOLECONTAINER = '{0000011B-0000-0000-C000-000000000046}';
const IID_IPARSEDISPLAYNAME = '{0000011A-0000-0000-C000-000000000046}';
const IID_ICLASSFACTORY = '{00000001-0000-0000-C000-000000000046}';
const IID_ISTORAGE = '{0000000B-0000-0000-C000-000000000046}';
const IID_IDISPATCH = '{00020400-0000-0000-C000-000000000046}';
const CLSID_STD_COMPONENT_CATEGORIES_MGR = '{0002E005-0000-0000-C000-000000000046}';
const CLSID_MY_COMPUTER = '{20D04FE0-3AEA-1069-A2D8-08002B30309D}';
const CLSID_STD_FONT = '{0BE35203-8F91-11CE-9DE3-00AA004BB851}';
const CLSID_TEST = '{B306BFBC-496E-4F53-B93E-2FF9C83223D7}';

const BINDSPEED_INDEFINITE = 1;
const BINDSPEED_MODERATE = 2;
const BINDSPEED_IMMEDIATE = 3;
const STGM_READ = 0;
const STGM_READWRITE = 2;
const STGM_SHARE_DENY_WRITE = 0x20;

/** IMoniker's slots, by name. */
const IID_IMARSHAL = '{00000003-0000-0000-C000-000000000046}';

const M = Object.freeze({
    QueryInterface: 0, AddRef: 1, Release: 2, GetClassID: 3, IsDirty: 4, Load: 5, Save: 6,
    GetSizeMax: 7, BindToObject: 8, BindToStorage: 9, Reduce: 10, ComposeWith: 11, Enum: 12,
    IsEqual: 13, Hash: 14, IsRunning: 15, GetTimeOfLastChange: 16, Inverse: 17,
    CommonPrefixWith: 18, RelativePathTo: 19, GetDisplayName: 20, ParseDisplayName: 21,
    IsSystemMoniker: 22,
});

/** IBindCtx's slots, by name. */
const B = Object.freeze({
    RegisterObjectBound: 3, RevokeObjectBound: 4, ReleaseBoundObjects: 5, SetBindOptions: 6,
    GetBindOptions: 7, GetRunningObjectTable: 8, RegisterObjectParam: 9, GetObjectParam: 10,
    EnumObjectParam: 11, RevokeObjectParam: 12,
});

/** @param {string} text */
const ascii = text=>Array.from(text, c=>c.charCodeAt(0));
/** @param {string} text  Each character followed by a zero byte. */
const utf16 = text=>Array.from(text, c=>[c.charCodeAt(0), 0]).flat();
/** @param {string} guid */
const guidArray = guid=>Array.from(/** @type {Uint8Array} */ (parseGuid(guid)));

const expectedItemSaved = [0x02, 0, 0, 0, ...ascii('!'), 0, 0x05, 0, 0, 0, ...ascii('Test'), 0];
const expectedItemSaved2 = [0, 0, 0, 0, 0x05, 0, 0, 0, ...ascii('Test'), 0];
const expectedItemSaved3 = [0x01, 0, 0, 0, 0, 0x05, 0, 0, 0, ...ascii('Test'), 0];
const expectedItemSaved4 = [0x03, 0, 0, 0, ...ascii('&&'), 0, 0x05, 0, 0, 0, ...ascii('Test'), 0];
const expectedItemSaved5 = [0x03, 0, 0, 0, ...ascii('ab'), 0, 0x05, 0, 0, 0, ...ascii('Test'), 0];
const expectedItemSaved6 = [0x01, 0, 0, 0, 0, 0x01, 0, 0, 0, 0];
const itemClass = guidArray(CLSID_ITEM_MONIKER);
const expectedItemComparison = [...itemClass, ...utf16('!TEST'), 0, 0];
const expectedItemComparison2 = [...itemClass, ...utf16('TEST'), 0, 0];
const expectedItemComparison4 = [...itemClass, ...utf16('&&TEST'), 0, 0];
const expectedItemComparison5 = [...itemClass, ...utf16('ABTEST'), 0, 0];
const expectedItemComparison6 = [...itemClass, 0, 0];
const expectedClassSaved = [...guidArray(CLSID_STD_COMPONENT_CATEGORIES_MGR), 0, 0, 0, 0];
const expectedClassComparison = [...guidArray(CLSID_CLASS_MONIKER),
    ...guidArray(CLSID_STD_COMPONENT_CATEGORIES_MGR)];
const expectedAntiComparison = [...guidArray(CLSID_ANTI_MONIKER), 1, 0, 0, 0];
const expectedAntiComparison2 = [...guidArray(CLSID_ANTI_MONIKER), 2, 0, 0, 0];
const expectedCompositeSaved = [
    0x02, 0x00, 0x00, 0x00, 0x04, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x46, 0x02, 0x00, 0x00, 0x00, 0x21, 0x00, 0x05, 0x00, 0x00, 0x00, 0x54, 0x65,
    0x73, 0x74, 0x00, 0x04, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x46, 0x02, 0x00, 0x00, 0x00, 0x23, 0x00, 0x05, 0x00, 0x00, 0x00, 0x57, 0x69, 0x6e,
    0x65, 0x00,
];
const expectedCompositeComparison = [...guidArray(CLSID_COMPOSITE_MONIKER),
    ...itemClass, ...utf16('!TEST'), 0, 0, ...itemClass, ...utf16('#WINE'), 0, 0];

/**
 * A bump heap that remembers what is live.
 *
 * @param {number} base
 */
function fakeHeap(base){
    /** @type {Map<number, number>} */
    const live = new Map();
    let next = base;
    return {
        live,
        /** @param {number} size */
        allocate(size){
            const address = next;
            next += Math.max(16, (size + 15) & ~15) + 16;
            live.set(address, size);
            return address;
        },
        /** @param {number} address */
        free: address=>live.delete(address),
    };
}

/**
 * @typedef {Object} GuestObject
 * @property {number} pointer
 * @property {number} refs
 * @property {string[]} calls
 */

function setup(){
    const bytes = new Uint8Array(0x200000);
    const view = new DataView(bytes.buffer);
    const heap = fakeHeap(0x10000);
    const registry = createComRegistry();
    /** @type {Map<number, any>} */
    const records = new Map();
    /** @type {Map<any, number>} */
    const published = new Map();
    let nextPointer = 0x100000;
    /** @type {Map<number, { object: GuestObject, slots: Record<number, (args: number[]) => any> }>} */
    const guests = new Map();
    let nextGuest = 0x180000;
    /** @type {string[]} */
    const reported = [];

    /** @param {number} address */
    const u32 = address=>view.getUint32(address, true);
    /** @param {number} address @param {number} value */
    const put = (address, value)=>view.setUint32(address, value >>> 0, true);
    /** @param {string} text */
    const wide = text=>{
        const address = heap.allocate((text.length + 1) * 2);
        for (let index = 0; index < text.length; index++)
        {
            view.setUint16(address + index * 2, text.charCodeAt(index), true);
        }
        view.setUint16(address + text.length * 2, 0, true);
        return address;
    };
    /** @param {number} address */
    const readWide = address=>{
        let text = '';
        for (let at = address; ; at += 2)
        {
            const unit = view.getUint16(at, true);
            if (unit === 0)
            {
                return text;
            }
            text += String.fromCharCode(unit);
        }
    };
    /** @param {string} text */
    const guid = text=>{
        const address = heap.allocate(16);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(text)), address);
        return address;
    };
    /** @param {number} [value] */
    const out = (value = 0)=>{
        const address = heap.allocate(8);
        put(address, value);
        put(address + 4, 0);
        return address;
    };

    const vtables = {
        /** @param {any} object @param {string} interfaceId */
        publish(object, interfaceId){
            const record = object.interfaceFor(interfaceId);
            if (!record)
            {
                return 0;
            }
            const existing = published.get(record);
            if (existing)
            {
                return existing;
            }
            nextPointer += 0x10;
            published.set(record, nextPointer);
            records.set(nextPointer, record);
            return nextPointer;
        },
    };

    /**
     * A method call through an interface pointer: ours dispatch into the
     * published table, IUnknown's three as the vtable layer answers them;
     * the fake guest's into its slots.
     *
     * @param {number} pointer @param {number} slot @param {number[]} args
     * @returns {Promise<number>}
     */
    const callMethod = async(pointer, slot, args)=>{
        const record = records.get(pointer);
        if (record)
        {
            assert.ok(!record.object.destroyed, `call on a released object at ${pointer}`);
            const method = record.methods[slot];
            assert.ok(method, `no slot ${slot} on ${record.id}`);
            if (method.builtin === 'queryInterface')
            {
                const [iidAt, outAt] = args;
                if (outAt === 0)
                {
                    return E_POINTER;
                }
                const found = record.object.queryInterface(formatGuid(bytes.subarray(iidAt,
                    iidAt + 16)));
                put(outAt, found ? vtables.publish(found.object, found.id) : 0);
                return found ? S_OK : E_NOINTERFACE;
            }
            if (method.builtin === 'addRef')
            {
                return record.object.addRef();
            }
            if (method.builtin === 'release')
            {
                // As the bridge does: what the object owes is made, and
                // waited for, inside the last Release.
                if (record.object.refCount === 1 && record.object.lastRelease)
                {
                    await record.object.lastRelease();
                }
                return record.object.release();
            }
            return method.invoke(record.object, args);
        }
        const guestObject = guests.get(pointer);
        assert.ok(guestObject, `no object at 0x${pointer.toString(16)}`);
        const fn = guestObject.slots[slot];
        assert.ok(fn, `the guest object has no slot ${slot}`);
        return (await fn(args)) | 0;
    };

    /**
     * A program's object: QueryInterface for the IIDs it lists answers
     * itself, AddRef and Release count, the rest is what `slots` says.
     *
     * @param {string[]} iids
     * @param {Record<number, (args: number[], self: GuestObject) => any>} slots
     * @param {number} [refs]
     * @returns {GuestObject}
     */
    const guestObject = (iids, slots, refs = 1)=>{
        nextGuest += 0x10;
        /** @type {GuestObject} */
        const object = { pointer: nextGuest, refs, calls: [] };
        /** @type {Record<number, (args: number[]) => any>} */
        const table = {
            0: ([iidAt, outAt])=>{
                const iid = formatGuid(bytes.subarray(iidAt, iidAt + 16));
                if (iids.includes(iid))
                {
                    put(outAt, object.pointer);
                    object.refs++;
                    return S_OK;
                }
                put(outAt, 0);
                return E_NOINTERFACE;
            },
            1: ()=>++object.refs,
            2: ()=>--object.refs,
        };
        for (const [slot, fn] of Object.entries(slots))
        {
            table[Number(slot)] = args=>fn(args, object);
        }
        guests.set(object.pointer, { object, slots: table });
        return object;
    };

    /** A guest IStream over a byte array. */
    const stream = (initial = new Uint8Array(0))=>{
        let data = Uint8Array.from(initial);
        let position = 0;
        const object = guestObject([IID_IUNKNOWN], {
            3: ([pv, cb, pcbRead])=>{
                const chunk = data.subarray(position, position + cb);
                bytes.set(chunk, pv);
                position += chunk.length;
                if (pcbRead !== 0)
                {
                    put(pcbRead, chunk.length);
                }
                return chunk.length === cb ? S_OK : S_FALSE;
            },
            4: ([pv, cb, pcbWritten])=>{
                const grown = new Uint8Array(Math.max(data.length, position + cb));
                grown.set(data);
                grown.set(bytes.subarray(pv, pv + cb), position);
                data = grown;
                position += cb;
                if (pcbWritten !== 0)
                {
                    put(pcbWritten, cb);
                }
                return S_OK;
            },
        });
        return {
            pointer: object.pointer,
            get data(){
                return Array.from(data);
            },
            rewind(){
                position = 0;
            },
            /** @param {number[]} values */
            reset(values){
                data = Uint8Array.from(values);
                position = 0;
            },
        };
    };

    /**
     * Comparison data of a moniker, as the running object table reads it.
     *
     * @param {number} moniker
     */
    const comparisonKey = async moniker=>{
        const slot = out();
        if (await callMethod(moniker, 0, [guid(IID_IROTDATA), slot]) !== S_OK)
        {
            return `pointer ${moniker}`;
        }
        const data = u32(slot);
        const buffer = heap.allocate(512);
        const size = out();
        assert.equal(await callMethod(data, 3, [buffer, 512, size]), S_OK);
        await callMethod(data, 2, []);
        return Array.from(bytes.subarray(buffer, buffer + u32(size))).join(',');
    };

    /** @type {Map<string, { object: number, cookie: number }>} */
    const running = new Map();
    let cookies = 0;
    const table = guestObject([IID_IUNKNOWN], {
        3: async([, unknown, moniker, cookieAt])=>{
            await callMethod(unknown, 1, []);
            const cookie = ++cookies;
            running.set(await comparisonKey(moniker), { object: unknown, cookie });
            put(cookieAt, cookie);
            return S_OK;
        },
        4: async([cookie])=>{
            for (const [key, entry] of running)
            {
                if (entry.cookie === cookie)
                {
                    running.delete(key);
                    await callMethod(entry.object, 2, []);
                    return S_OK;
                }
            }
            return E_INVALIDARG;
        },
        5: async([moniker])=>(running.has(await comparisonKey(moniker)) ? S_OK : S_FALSE),
        6: async([moniker, outAt])=>{
            const entry = running.get(await comparisonKey(moniker));
            put(outAt, entry ? entry.object : 0);
            if (!entry)
            {
                return MK_E_UNAVAILABLE;
            }
            await callMethod(entry.object, 1, []);
            return S_OK;
        },
        8: async([moniker, filetime])=>{
            if (!running.has(await comparisonKey(moniker)))
            {
                return MK_E_UNAVAILABLE;
            }
            put(filetime, 0x1234);
            put(filetime + 4, 0);
            return S_OK;
        },
    });

    /** @type {Map<string, number>} Class objects by CLSID, as CoRegisterClassObject leaves them. */
    const classObjects = new Map();
    /** @type {Map<string, { lastWrite: bigint }>} */
    const files = new Map();
    /** @type {Map<string, string>} */
    const storages = new Map();
    /** @type {Map<string, string>} HKCR default values by key path. */
    const classes = new Map();
    /** @type {{ path: string, mode: number }[]} */
    const storageOpens = [];

    const env = {
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        heap,
        /** @param {number} size */
        taskAlloc: size=>heap.allocate(size),
        /** @param {number} address */
        taskFree: address=>heap.free(address),
        callMethod,
        callerThread: ()=>'thread',
        registry,
        vtables,
        /**
         * @param {string} clsid @param {number} outer @param {number} context
         * @param {string} iid @param {number} outAt
         */
        async createInstance(clsid, outer, context, iid, outAt){
            const factory = classObjects.get(clsid);
            if (factory)
            {
                return callMethod(factory, 3, [outer, guid(iid), outAt]);
            }
            const object = registry.create(clsid);
            if (!object)
            {
                return REGDB_E_CLASSNOTREG;
            }
            const pointer = vtables.publish(object, iid);
            if (pointer === 0)
            {
                object.release();
                return E_NOINTERFACE;
            }
            put(outAt, pointer);
            return S_OK;
        },
        /** @param {string} clsid @param {number} context @param {string} iid @param {number} outAt */
        async getClassObject(clsid, context, iid, outAt){
            const object = classObjects.get(clsid);
            if (!object)
            {
                put(outAt, 0);
                return REGDB_E_CLASSNOTREG;
            }
            return callMethod(object, 0, [guid(iid), outAt]);
        },
        /** @param {number} outAt */
        async runningObjectTable(outAt){
            table.refs++;
            put(outAt, table.pointer);
            return S_OK;
        },
        /** @param {string} path */
        storageClassOf: async path=>storages.get(path.toUpperCase()) ?? null,
        /** @param {string} path */
        fileInfo: path=>files.get(path.toUpperCase()) ?? null,
        /** @param {string} path @param {number} mode */
        openStorage(path, mode){
            storageOpens.push({ path, mode });
            return (mode & 0x70) === 0 ? STG_E_INVALIDFLAG : (mode & 3) === STGM_READ
                ? S_OK : STG_E_INVALIDFLAG;
        },
        hive: {
            root: ()=>'HKCR',
            /** @param {string} _root @param {string} path */
            open: (_root, path)=>(classes.has(path.toUpperCase()) ? path.toUpperCase() : null),
            /** @param {string} key */
            getValue: key=>({ data: Uint8Array.from([...ascii(/** @type {string} */ (
                classes.get(key))), 0]) }),
        },
        locale: ()=>0x419,
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),
    };

    const functions = createMonikerFunctions(env);

    /**
     * An export of the module, called as the guest calls it.
     *
     * @param {keyof typeof functions} name @param {number[]} args
     */
    const fn = async(name, ...args)=>(await functions[name].handler(args)) | 0;

    /**
     * An IMoniker method on any moniker.
     *
     * @param {number} pointer @param {keyof typeof M} name @param {number[]} args
     */
    const m = async(pointer, name, ...args)=>(await callMethod(pointer, M[name], args)) | 0;

    /** @param {number} pointer @param {keyof typeof B} name @param {number[]} args */
    const b = async(pointer, name, ...args)=>(await callMethod(pointer, B[name], args)) | 0;

    /**
     * A moniker made by an export that answers it through its last argument.
     *
     * @param {keyof typeof functions} name @param {number[]} args
     */
    const made = async(name, ...args)=>{
        const slot = out();
        assert.equal(await fn(name, ...args, slot), S_OK, `${name} failed`);
        return u32(slot);
    };

    /** @param {string | null} delimiter @param {string} name */
    const item = (delimiter, name)=>made('CreateItemMoniker', delimiter === null ? 0
        : wide(delimiter), wide(name));
    /** @param {string} path */
    const file = path=>made('CreateFileMoniker', wide(path));
    /** @param {number} count */
    const anti = async count=>{
        const moniker = await made('CreateAntiMoniker');
        const source = stream(Uint8Array.from([count, count >>> 8, count >>> 16, 0]));
        assert.equal(await m(moniker, 'Load', source.pointer), S_OK);
        return moniker;
    };
    /** Wine's pointer moniker object: an IUnknown that never dies. */
    const pmObject = guestObject([IID_IUNKNOWN], {});

    /**
     * A moniker from Wine's test descriptions: I<c> an item "!I<c>", A<n> an
     * anti moniker of n, P a pointer moniker, C<left><right> their generic
     * composite.
     *
     * @param {string} text
     * @returns {Promise<{ moniker: number, used: number }>}
     */
    const parseDescription = async text=>{
        switch (text[0])
        {
            case 'I':
                return { moniker: await item('!', `I${text[1]}`), used: 2 };
            case 'A':
                return { moniker: await anti(Number(text[1])), used: 2 };
            case 'P':
                return { moniker: await made('CreatePointerMoniker', pmObject.pointer), used: 1 };
            default: {
                const left = await parseDescription(text.slice(1));
                const right = await parseDescription(text.slice(1 + left.used));
                const composite = await made('CreateGenericComposite', left.moniker,
                    right.moniker);
                await m(left.moniker, 'Release');
                await m(right.moniker, 'Release');
                return { moniker: composite, used: 1 + left.used + right.used };
            }
        }
    };
    /** @param {string} text */
    const desc = async text=>(await parseDescription(text)).moniker;

    const bindContext = ()=>made('CreateBindCtx', 0);

    /** @param {number} moniker @param {number} [context] */
    const display = async(moniker, context)=>{
        const owned = context === undefined ? await bindContext() : 0;
        const slot = out();
        const hr = await m(moniker, 'GetDisplayName', context ?? owned, 0, slot);
        if (owned !== 0)
        {
            await callMethod(owned, 2, []);
        }
        if (hr !== S_OK)
        {
            return hr;
        }
        const text = readWide(u32(slot));
        assert.ok(heap.live.has(u32(slot)), 'the display name is in task memory');
        heap.free(u32(slot));
        return text;
    };

    /** @param {number} moniker */
    const mksys = async moniker=>{
        const slot = out();
        assert.equal(await m(moniker, 'IsSystemMoniker', slot), S_OK);
        return u32(slot);
    };

    /** @param {number} moniker */
    const hash = async moniker=>{
        const slot = out(0xdeadbeef);
        const hr = await m(moniker, 'Hash', slot);
        return hr === S_OK ? u32(slot) : hr;
    };

    /** @param {number} moniker */
    const comparison = async moniker=>{
        const data = out();
        assert.equal(await callMethod(moniker, 0, [guid(IID_IROTDATA), data]), S_OK);
        const buffer = heap.allocate(256);
        const size = out();
        const hr = await callMethod(u32(data), 3, [buffer, 256, size]);
        await callMethod(u32(data), 2, []);
        return hr === S_OK ? Array.from(bytes.subarray(buffer, buffer + u32(size))) : hr;
    };

    /** @param {number} moniker */
    const saved = async moniker=>{
        const target = stream();
        const hr = await m(moniker, 'Save', target.pointer, 1);
        return hr === S_OK ? target.data : hr;
    };

    /** @param {number} moniker */
    const sizeMax = async moniker=>{
        const slot = out();
        assert.equal(await m(moniker, 'GetSizeMax', slot), S_OK);
        return u32(slot);
    };

    /**
     * QueryInterface that keeps nothing: whether it answers.
     *
     * @param {number} pointer @param {string} iid
     */
    const supports = async(pointer, iid)=>{
        const slot = out();
        const hr = await callMethod(pointer, 0, [guid(iid), slot]);
        if (hr === S_OK)
        {
            await callMethod(u32(slot), 2, []);
        }
        return hr === S_OK;
    };

    /** @param {number} pointer */
    const refs = pointer=>{
        const record = records.get(pointer);
        return record && !record.object.destroyed ? record.object.refCount : 0;
    };

    /** Lets the releases a final Release starts run to their end. */
    const settle = ()=>new Promise(resolve=>setImmediate(resolve));

    return {
        bytes, view, heap, registry, env, functions, fn, m, b, made, item, file, anti, desc,
        bindContext, display, mksys, hash, comparison, saved, sizeMax, supports, refs, settle,
        stream, guestObject, out, u32, put, wide, readWide, guid, table, running, classObjects,
        files, storages, classes, storageOpens, reported, pmObject, callMethod,
    };
}

/**
 * Wine's test moniker: a program's own IMoniker that is also a container for
 * the items to its right.
 *
 * @param {ReturnType<typeof setup>} t
 * @param {string} [inverse]  The description of the item its Inverse makes.
 */
function testMoniker(t, inverse){
    /** @type {string[]} */
    const calls = [];
    const parser = t.guestObject([IID_IUNKNOWN, IID_IPARSEDISPLAYNAME], {
        3: ()=>E_NOTIMPL,
    });
    const container = t.guestObject([IID_IUNKNOWN, IID_IOLEITEMCONTAINER, IID_IOLECONTAINER,
        IID_IPARSEDISPLAYNAME], {
        5: ([lock])=>{
            calls.push(`LockContainer(${lock})`);
            return S_OK;
        },
        6: ([, speed, , iidAt, outAt])=>{
            if (formatGuid(t.bytes.subarray(iidAt, iidAt + 16)) === IID_IPARSEDISPLAYNAME)
            {
                t.put(outAt, parser.pointer);
            }
            return 0x8bee0000 | speed;
        },
        7: ()=>0x8bee0001,
        8: ()=>{
            calls.push('IOleItemContainer::IsRunning');
            return E_NOTIMPL;
        },
    });
    const moniker = t.guestObject([IID_IUNKNOWN, IID_IPERSIST, IID_IPERSISTSTREAM, IID_IMONIKER], {
        3: ([outAt])=>{
            t.bytes.set(/** @type {Uint8Array} */ (parseGuid(CLSID_TEST)), outAt);
            return S_OK;
        },
        4: ()=>S_FALSE,
        8: ([, , iidAt, outAt])=>{
            if (formatGuid(t.bytes.subarray(iidAt, iidAt + 16)) === IID_IOLEITEMCONTAINER)
            {
                t.put(outAt, container.pointer);
                return S_OK;
            }
            calls.push('Moniker_BindToObject');
            return E_NOTIMPL;
        },
        10: ([, , , outAt], self)=>{
            self.refs++;
            t.put(outAt, self.pointer);
            return MK_S_REDUCED_TO_SELF;
        },
        11: ()=>MK_E_NEEDGENERIC,
        13: ()=>E_NOTIMPL,
        14: ()=>E_NOTIMPL,
        15: ()=>{
            calls.push('Moniker_IsRunning');
            return 0x8beef000 | 0;
        },
        17: async([outAt])=>{
            calls.push('Moniker_Inverse');
            const made = await t.desc(/** @type {string} */ (inverse));
            t.put(outAt, made);
            return S_OK;
        },
        20: ([, , outAt])=>{
            const text = t.wide('**Gemma');
            t.put(outAt, text);
            return S_OK;
        },
        22: ([outAt])=>{
            t.put(outAt, MKSYS.NONE);
            return S_FALSE;
        },
    });
    return { pointer: moniker.pointer, calls, container, parser };
}

/**
 * What Wine's test_moniker checks of every system moniker.
 *
 * @param {ReturnType<typeof setup>} t @param {number} moniker
 * @param {{ saved: number[], comparison: number[], size: number, name: string }} expected
 */
async function checkMoniker(t, moniker, expected){
    assert.equal(await t.m(moniker, 'IsDirty'), S_FALSE);
    assert.equal(await t.display(moniker), expected.name);
    assert.equal(await t.m(moniker, 'IsDirty'), S_FALSE);
    assert.deepEqual(await t.comparison(moniker), expected.comparison);
    assert.equal(await t.sizeMax(moniker), expected.size);
    assert.deepEqual(await t.saved(moniker), expected.saved);
}

test('a name ending just short of the end of its memory is read without reading past it',
    async()=>{
        // Past the end lies another allocation, or nothing: memory refuses a read
        // that runs into it, as the memory layer refuses one past a region's end.
        const t = setup();
        const end = t.bytes.length;
        const read = t.env.readMemory;
        t.env.readMemory = (address, length)=>{
            assert.ok(address >= end || address + length <= end, `read of ${length} bytes`
                + ` at 0x${address.toString(16)} runs past the end of memory`);
            return read(address, length);
        };
        const path = 'C:\\data\\a.txt';
        const at = end - 8 - (path.length + 1) * 2;
        [...path, '\0'].forEach((c, index)=>
            t.view.setUint16(at + index * 2, c.charCodeAt(0), true));
        const moniker = await t.made('CreateFileMoniker', at);
        assert.equal(await t.display(moniker), path);
    });

test('the exports take the stack Windows gives them', ()=>{
    const t = setup();
    const sizes = Object.fromEntries(Object.entries(t.functions).map(([name, entry])=>
        [name, entry.argBytes]));
    assert.deepEqual(sizes, {
        CreateBindCtx: 8, CreateItemMoniker: 12, CreateFileMoniker: 8, CreateClassMoniker: 8,
        CreatePointerMoniker: 8, CreateObjrefMoniker: 8, CreateAntiMoniker: 4,
        CreateGenericComposite: 12,
        MkParseDisplayName: 16, BindMoniker: 16, MonikerCommonPrefixWith: 12,
        MonikerRelativePathTo: 16, GetClassFile: 8, CoGetInstanceFromFile: 32,
    });
});

test('a bind context holds its options, parameters and bound objects', async()=>{
    const t = setup();
    assert.equal(await t.fn('CreateBindCtx', 0, 0), E_INVALIDARG);
    assert.equal(await t.fn('CreateBindCtx', 0xdeadbeef, t.out()), E_INVALIDARG);
    const context = await t.bindContext();
    assert.equal(await t.supports(context, IID_IBINDCTX), true);

    assert.ok(await t.b(context, 'GetRunningObjectTable', 0) < 0);
    const rot = t.out();
    assert.equal(await t.b(context, 'GetRunningObjectTable', rot), S_OK);
    assert.equal(t.u32(rot), t.table.pointer);

    const options = t.heap.allocate(64);
    t.put(options, 0xffffffff);
    assert.equal(await t.b(context, 'GetBindOptions', options), S_OK);
    assert.equal(t.u32(options), 36);
    t.put(options, 16);
    assert.equal(await t.b(context, 'GetBindOptions', options), S_OK);
    assert.equal(t.u32(options), 16);
    t.bytes.fill(0xfe, options, options + 36);
    t.put(options, 36);
    assert.equal(await t.b(context, 'GetBindOptions', options), S_OK);
    assert.deepEqual([0, 4, 8, 12, 16, 20, 24, 28, 32].map(at=>t.u32(options + at)),
        [36, 0, STGM_READWRITE, 0, 0, 0x15, 0x419, 0, 0]);
    t.put(options, 0xffffffff);
    assert.equal(await t.b(context, 'SetBindOptions', options), E_INVALIDARG);
    t.put(options, 16);
    t.put(options + 12, 1234);
    assert.equal(await t.b(context, 'SetBindOptions', options), S_OK);
    t.put(options, 36);
    t.put(options + 12, 0);
    assert.equal(await t.b(context, 'GetBindOptions', options), S_OK);
    assert.equal(t.u32(options + 12), 1234);
    assert.equal(t.u32(options + 20), 0x15, 'what the shorter structure did not carry is kept');

    const name = t.wide('Gemma');
    const nonExistent = t.wide('NonExistent');
    assert.equal(await t.b(context, 'RegisterObjectParam', name, 0), E_INVALIDARG);
    const param = t.guestObject([IID_IUNKNOWN], {});
    assert.equal(await t.b(context, 'RegisterObjectParam', name, param.pointer), S_OK);
    const got = t.out();
    assert.equal(await t.b(context, 'GetObjectParam', name, got), S_OK);
    assert.equal(t.u32(got), param.pointer);
    assert.equal(param.refs, 3);
    param.refs--;
    const missing = t.out(0xdeadbeef);
    assert.equal(await t.b(context, 'GetObjectParam', nonExistent, missing), E_FAIL);
    assert.equal(t.u32(missing), 0);
    assert.equal(await t.b(context, 'RevokeObjectParam', nonExistent), E_FAIL);
    const enumerator = t.out(0xdeadbeef);
    assert.equal(await t.b(context, 'EnumObjectParam', enumerator), E_NOTIMPL);
    assert.equal(t.u32(enumerator), 0);

    assert.equal(await t.b(context, 'RegisterObjectBound', 0), S_OK);
    assert.equal(await t.b(context, 'RevokeObjectBound', 0), E_INVALIDARG);
    const bound = t.guestObject([IID_IUNKNOWN], {});
    assert.equal(await t.b(context, 'RegisterObjectBound', bound.pointer), S_OK);
    assert.equal(bound.refs, 2);
    assert.equal(await t.b(context, 'RevokeObjectBound', bound.pointer), S_OK);
    assert.equal(bound.refs, 1);
    assert.equal(await t.b(context, 'RevokeObjectBound', bound.pointer), MK_E_NOTBOUND);

    const kept = t.guestObject([IID_IUNKNOWN], {});
    assert.equal(await t.b(context, 'RegisterObjectBound', kept.pointer), S_OK);
    assert.equal(await t.b(context, 'ReleaseBoundObjects'), S_OK);
    assert.equal(kept.refs, 1);
    assert.equal(param.refs, 2, 'parameters outlive ReleaseBoundObjects');

    assert.equal(await t.b(context, 'RegisterObjectBound', kept.pointer), S_OK);
    await t.callMethod(context, 2, []);
    await t.settle();
    assert.equal(param.refs, 1);
    assert.equal(kept.refs, 1);
});

test('item monikers persist, compare and name themselves as Windows does', async()=>{
    const t = setup();
    const plain = await t.item(null, 'Test');
    assert.equal(await t.supports(plain, CLSID_ITEM_MONIKER), true);
    assert.equal(await t.supports(plain, IID_IPERSISTSTREAM), true);
    await checkMoniker(t, plain, { saved: expectedItemSaved2, comparison: expectedItemComparison2,
        size: 46, name: 'Test' });
    await checkMoniker(t, await t.item('', 'Test'), { saved: expectedItemSaved3,
        comparison: expectedItemComparison2, size: 50, name: 'Test' });
    await checkMoniker(t, await t.item('&&', 'Test'), { saved: expectedItemSaved4,
        comparison: expectedItemComparison4, size: 58, name: '&&Test' });
    await checkMoniker(t, await t.item('ab', 'Test'), { saved: expectedItemSaved5,
        comparison: expectedItemComparison5, size: 58, name: 'abTest' });
    const moniker = await t.item('!', 'Test');
    await checkMoniker(t, moniker, { saved: expectedItemSaved, comparison: expectedItemComparison,
        size: 54, name: '!Test' });
    assert.equal(await t.mksys(moniker), MKSYS.ITEMMONIKER);

    // The UTF-16 tail of a record, when there is one, is what counts.
    const loaded = await t.item(null, 'object');
    const source = t.stream();
    for (const [data, name] of /** @type {[number[], string][]} */ ([
        [[5, 0, 0, 0, 0xff, 0xff, 0, 0x21, 0, 2, 0, 0, 0, 0x41, 0], '!A'],
        [[2, 0, 0, 0, 0x21, 0, 5, 0, 0, 0, 0xff, 0xff, 0, 0x42, 0], '!B'],
        [[5, 0, 0, 0, 0xff, 0xff, 0, 0x21, 0, 6, 0, 0, 0, 0xff, 0xff, 0xff, 0, 0x43, 0], '!C'],
    ]))
    {
        source.reset(data);
        assert.equal(await t.m(loaded, 'Load', source.pointer), S_OK);
        assert.equal(await t.display(loaded), name);
    }

    for (const [delimiter, name, expected] of /** @type {[string, string, number][]} */ ([
        ['!', 'Test', 0x73c], ['%', 'Test', 0x73c], ['%', 'TEST', 0x73c], ['%', 'T', 0x54],
        ['%', 'A', 0x41], ['%', 'a', 0x41],
    ]))
    {
        assert.equal(await t.hash(await t.item(delimiter, name)), expected);
    }

    /** @type {[string | null, string, string | null, string, number][]} */
    const pairs = [
        ['!', 'Item1', '!', 'ITEM1', S_OK], [null, 'Item1', '!', 'ITEM1', S_OK],
        ['', 'Item1', '!', 'ITEM1', S_OK], ['&', 'Item1', '!', 'ITEM1', S_OK],
        ['&&', 'Item1', '&', '&Item1', S_FALSE], [null, 'Item1', null, 'Item2', S_FALSE],
        [null, 'Item1', null, 'ITEM1', S_OK],
    ];
    for (const [d1, i1, d2, i2, expected] of pairs)
    {
        const a = await t.item(d1, i1);
        const b = await t.item(d2, i2);
        assert.equal(await t.m(a, 'IsEqual', b), expected);
        assert.equal(await t.m(b, 'IsEqual', a), expected);
    }
    assert.equal(await t.m(moniker, 'IsEqual', 0), E_INVALIDARG);

    // The default instance CoCreateInstance makes.
    const object = /** @type {any} */ (t.registry.create(CLSID_ITEM_MONIKER));
    const fresh = t.env.vtables.publish(object, IID_IMONIKER);
    await checkMoniker(t, fresh, { saved: expectedItemSaved6, comparison: expectedItemComparison6,
        size: 34, name: '' });
});

test('an item moniker runs, binds and parses through its container', async()=>{
    const t = setup();
    const moniker = await t.item('!', 'Test');
    const context = await t.bindContext();
    const container = testMoniker(t);

    assert.equal(await t.m(moniker, 'IsRunning', 0, 0, 0), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'IsRunning', 0, container.pointer, 0), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'IsRunning', context, 0, 0), S_FALSE);
    const same = await t.item('!', 'Test');
    assert.equal(await t.m(moniker, 'IsRunning', context, 0, same), S_OK);
    const other = await t.item('!', 'Item123');
    assert.equal(await t.m(moniker, 'IsRunning', context, 0, other), S_FALSE);
    const cookie = t.out();
    assert.equal(await t.callMethod(t.table.pointer, 3, [1, moniker, moniker, cookie]), S_OK);
    assert.equal(await t.m(moniker, 'IsRunning', context, 0, other), S_FALSE);
    assert.equal(await t.m(moniker, 'IsRunning', context, 0, 0), S_OK);
    assert.equal(await t.callMethod(t.table.pointer, 4, [t.u32(cookie)]), S_OK);
    assert.equal(await t.m(moniker, 'IsRunning', context, container.pointer, 0), 0x8beef000 | 0);
    assert.equal(await t.m(moniker, 'IsRunning', context, container.pointer, other),
        0x8beef000 | 0);
    assert.deepEqual(container.calls, ['Moniker_IsRunning', 'Moniker_IsRunning']);

    const object = t.out();
    const unknown = t.guid(IID_IUNKNOWN);
    assert.equal(await t.m(moniker, 'BindToObject', context, 0, unknown, object), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'BindToObject', context, container.pointer, unknown, object),
        0x8bee0000 | BINDSPEED_INDEFINITE);
    assert.ok(container.calls.includes('LockContainer(1)'), 'the container is locked');
    const options = t.heap.allocate(16);
    t.put(options, 16);
    assert.equal(await t.b(context, 'GetBindOptions', options), S_OK);
    for (const [deadline, speed] of [[1, BINDSPEED_IMMEDIATE], [2499, BINDSPEED_IMMEDIATE],
        [2500, BINDSPEED_MODERATE]])
    {
        t.put(options + 12, deadline);
        assert.equal(await t.b(context, 'SetBindOptions', options), S_OK);
        assert.equal(await t.m(moniker, 'BindToObject', context, container.pointer, unknown,
            object), 0x8bee0000 | speed);
    }

    assert.equal(await t.m(moniker, 'BindToStorage', context, 0, unknown, object), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'BindToStorage', context, container.pointer, unknown, object),
        0x8bee0001 | 0);

    const name = t.wide('display name');
    const eaten = t.out();
    const parsed = t.out();
    assert.equal(await t.m(moniker, 'ParseDisplayName', context, 0, name, eaten, parsed),
        MK_E_SYNTAX);
    for (const [deadline, speed] of [[0, BINDSPEED_INDEFINITE], [1, BINDSPEED_IMMEDIATE],
        [2499, BINDSPEED_IMMEDIATE], [2500, BINDSPEED_MODERATE]])
    {
        t.put(options + 12, deadline);
        assert.equal(await t.b(context, 'SetBindOptions', options), S_OK);
        assert.equal(await t.m(moniker, 'ParseDisplayName', context, container.pointer, name,
            eaten, parsed), 0x8bee0000 | speed);
    }

    // The locks go with the bind context's bound objects.
    await t.b(context, 'ReleaseBoundObjects');
    await t.settle();
    assert.ok(container.calls.includes('LockContainer(0)'));
});

test('an item moniker reduces, inverts, enumerates and composes as Windows does', async()=>{
    const t = setup();
    const moniker = await t.item('!', 'Item');

    const inverse = t.out();
    assert.equal(await t.m(moniker, 'Inverse', inverse), S_OK);
    assert.equal(await t.mksys(t.u32(inverse)), MKSYS.ANTIMONIKER);

    const reduced = t.out();
    assert.equal(await t.m(moniker, 'Reduce', 0, 0, 0, reduced), MK_S_REDUCED_TO_SELF);
    assert.equal(t.u32(reduced), moniker);

    for (const forward of [1, 0])
    {
        const enumerator = t.out(0xdeadbeef);
        assert.equal(await t.m(moniker, 'Enum', forward, enumerator), S_OK);
        assert.equal(t.u32(enumerator), 0);
    }
    assert.equal(await t.m(moniker, 'Enum', 0, 0), E_INVALIDARG);

    const composite = t.out();
    assert.equal(await t.m(moniker, 'ComposeWith', await t.anti(1), 1, composite), S_OK);
    assert.equal(t.u32(composite), 0);
    assert.equal(await t.m(moniker, 'ComposeWith', await t.anti(2), 1, composite), S_OK);
    assert.equal(await t.mksys(t.u32(composite)), MKSYS.ANTIMONIKER);
    assert.equal(await t.hash(t.u32(composite)), 0x80000001);

    // Simplification goes through the generic composite, even when what it
    // leaves is not a composite.
    const c = await t.desc('CA1A3');
    assert.equal(await t.m(moniker, 'ComposeWith', c, 1, composite), MK_E_NEEDGENERIC);
    assert.equal(await t.m(moniker, 'ComposeWith', c, 0, composite), S_OK);
    assert.equal(await t.mksys(t.u32(composite)), MKSYS.ANTIMONIKER);
    assert.equal(await t.hash(t.u32(composite)), 0x80000003);

    const prefix = t.out();
    assert.equal(await t.m(moniker, 'CommonPrefixWith', await t.item('#', 'Item'), prefix),
        MK_S_US);
    assert.equal(t.u32(prefix), moniker);
    t.put(prefix, 0xdeadbeef);
    assert.equal(await t.m(moniker, 'CommonPrefixWith', await t.item('!', 'Item2'), prefix),
        MK_E_NOPREFIX);
    assert.equal(t.u32(prefix), 0);

    const i1 = await t.desc('I1');
    const i2 = await t.desc('I2');
    const relative = t.out(0xdeadbeef);
    assert.equal(await t.m(i1, 'RelativePathTo', 0, 0), E_INVALIDARG);
    assert.equal(await t.m(i1, 'RelativePathTo', 0, relative), E_INVALIDARG);
    assert.equal(await t.m(i1, 'RelativePathTo', i2, 0), E_INVALIDARG);
    assert.equal(await t.m(i1, 'RelativePathTo', i2, relative), MK_E_NOTBINDABLE);
    assert.equal(t.u32(relative), 0);

    // Against a composite it begins, the prefix is the composite's own first.
    const ci1i2 = await t.desc('CI1I2');
    assert.equal(await t.m(i1, 'CommonPrefixWith', ci1i2, prefix), MK_S_ME);
    assert.notEqual(t.u32(prefix), i1);
    assert.equal(await t.m(i1, 'IsEqual', t.u32(prefix)), S_OK);
});

test('anti monikers count what they cancel', async()=>{
    const t = setup();
    const moniker = await t.made('CreateAntiMoniker');
    assert.equal(await t.supports(moniker, IID_IPERSIST), false);
    assert.equal(await t.supports(moniker, IID_IPERSISTSTREAM), true);
    assert.equal(await t.supports(moniker, CLSID_ANTI_MONIKER), true);
    assert.equal(await t.supports(moniker, IID_IROTDATA), true);
    await checkMoniker(t, moniker, { saved: [1, 0, 0, 0], comparison: expectedAntiComparison,
        size: 20, name: '\\..' });
    assert.equal(await t.hash(moniker), 0x80000001);
    assert.equal(await t.mksys(moniker), MKSYS.ANTIMONIKER);

    const inverse = t.out(0xdeadbeef);
    assert.equal(await t.m(moniker, 'Inverse', inverse), MK_E_NOINVERSE);
    assert.equal(t.u32(inverse), 0);

    const context = await t.bindContext();
    const unknown = t.guid(IID_IUNKNOWN);
    assert.equal(await t.m(moniker, 'IsRunning', context, 0, 0), S_FALSE);
    assert.equal(await t.m(moniker, 'GetTimeOfLastChange', context, 0, t.out()), E_NOTIMPL);
    assert.equal(await t.m(moniker, 'BindToObject', context, 0, unknown, t.out()), E_NOTIMPL);
    assert.equal(await t.m(moniker, 'BindToStorage', context, 0, unknown, t.out()), E_NOTIMPL);

    const second = await t.made('CreateAntiMoniker');
    const composite = t.out(moniker);
    assert.equal(await t.m(moniker, 'ComposeWith', second, 1, composite), MK_E_NEEDGENERIC);
    assert.equal(t.u32(composite), 0);
    assert.equal(await t.m(moniker, 'ComposeWith', second, 0, composite), S_OK);
    assert.equal(await t.mksys(t.u32(composite)), MKSYS.GENERICCOMPOSITE);

    const source = t.stream();
    /** @param {number} target @param {number} count */
    const load = async(target, count)=>{
        source.reset([count & 0xff, (count >>> 8) & 0xff, (count >>> 16) & 0xff, count >>> 24]);
        return t.m(target, 'Load', source.pointer);
    };
    assert.equal(await load(moniker, 2), S_OK);
    await checkMoniker(t, moniker, { saved: [2, 0, 0, 0], comparison: expectedAntiComparison2,
        size: 20, name: '\\..\\..' });
    assert.equal(await t.m(moniker, 'IsEqual', second), S_FALSE);
    assert.equal(await t.m(second, 'IsEqual', moniker), S_FALSE);
    assert.equal(await t.hash(moniker), 0x80000002);
    assert.equal(await load(moniker, 0xfffff), S_OK);
    assert.equal(await t.hash(moniker), 0x800fffff);
    assert.equal(await load(moniker, 0x100000), E_INVALIDARG);
    assert.equal(await t.hash(moniker), 0x800fffff);
    assert.equal(await load(moniker, 0), S_OK);
    assert.equal(await t.hash(moniker), 0x80000000);
    assert.equal(await t.display(moniker), '');
    assert.equal(await load(moniker, 1), S_OK);
    assert.equal(await t.m(moniker, 'IsEqual', second), S_OK);
    assert.equal(await t.m(moniker, 'IsEqual', 0), E_INVALIDARG);

    const reduced = t.out();
    assert.equal(await t.m(moniker, 'Reduce', 0, 0, 0, reduced), MK_S_REDUCED_TO_SELF);
    assert.equal(t.u32(reduced), moniker);
    assert.equal(await t.m(moniker, 'Enum', 1, 0), E_INVALIDARG);

    const prefix = t.out();
    assert.equal(await load(moniker, 0), S_OK);
    assert.equal(await t.m(moniker, 'CommonPrefixWith', second, prefix), MK_S_ME);
    assert.equal(t.u32(prefix), moniker);
    assert.equal(await t.m(second, 'CommonPrefixWith', moniker, prefix), MK_S_HIM);
    assert.equal(t.u32(prefix), moniker);
    assert.equal(await load(moniker, 10), S_OK);
    assert.equal(await load(second, 5), S_OK);
    assert.equal(await t.m(moniker, 'CommonPrefixWith', second, prefix), MK_S_HIM);
    assert.equal(t.u32(prefix), second);
    assert.equal(await t.m(second, 'CommonPrefixWith', moniker, prefix), MK_S_ME);
    assert.equal(t.u32(prefix), second);
    assert.equal(await load(moniker, 2), S_OK);
    assert.equal(await load(second, 2), S_OK);
    assert.equal(await t.m(moniker, 'CommonPrefixWith', second, prefix), MK_S_US);
    assert.equal(t.u32(prefix), moniker);

    const one = await t.anti(1);
    const i1 = await t.desc('I1');
    const relative = t.out();
    assert.equal(await t.m(one, 'RelativePathTo', 0, 0), E_INVALIDARG);
    assert.equal(await t.m(one, 'RelativePathTo', i1, relative), MK_S_HIM);
    assert.equal(t.u32(relative), i1);
    const two = await t.anti(2);
    assert.equal(await t.m(two, 'RelativePathTo', one, relative), MK_S_HIM);
    assert.equal(t.u32(relative), one);
});

test('class monikers parse, persist and bind as Windows does', async()=>{
    const t = setup();
    const context = await t.bindContext();
    for (const [name, eaten, hr] of /** @type {[string, number, number][]} */ ([
        ['clsid:11111111-0000-0000-2222-444444444444;extra data:', 54, S_OK],
        ['clsid:11111111-0000-0000-2222-444444444444extra data', 52, S_OK],
        ['clsid:11111111-0000-0000-2222-444444444444:', 43, S_OK],
        ['clsid:11111111-0000-0000-2222-444444444444', 42, S_OK],
        ['clsid:{11111111-0000-0000-2222-444444444444}', 44, S_OK],
        ['clsid:{11111111-0000-0000-2222-444444444444', 0, MK_E_SYNTAX],
        ['clsid:11111111-0000-0000-2222-444444444444}', 43, S_OK],
    ]))
    {
        const eatenAt = t.out(0xdeadbeef);
        const out = t.out();
        assert.equal(await t.fn('MkParseDisplayName', context, t.wide(name), eatenAt, out), hr,
            name);
        assert.equal(t.u32(eatenAt), eaten, name);
        if (hr === S_OK)
        {
            assert.equal(await t.mksys(t.u32(out)), MKSYS.CLASSMONIKER);
        }
    }

    // The extended syntax: the class is all that counts for equality.
    const eatenAt = t.out();
    const first = t.out();
    const second = t.out();
    assert.equal(await t.fn('MkParseDisplayName', context,
        t.wide('clsid:11111111-0000-0000-2222-444444444444;extra data:'), eatenAt, first), S_OK);
    assert.equal(await t.fn('MkParseDisplayName', context,
        t.wide('clsid:11111111-0000-0000-2222-444444444444;different extra data:'), eatenAt,
        second), S_OK);
    assert.equal(await t.display(t.u32(first)),
        'clsid:11111111-0000-0000-2222-444444444444;extra data:');
    assert.equal(await t.sizeMax(t.u32(first)), 44);
    assert.equal(await t.m(t.u32(first), 'IsEqual', t.u32(second)), S_OK);
    assert.equal(await t.m(t.u32(second), 'IsEqual', t.u32(first)), S_OK);

    const nulled = await t.made('CreateClassMoniker',
        t.guid('{00000000-0000-0000-0000-000000000000}'));
    for (const [iid, expected] of /** @type {[string, boolean][]} */ ([[IID_IMONIKER, true],
        [IID_IPERSIST, true], [IID_IPERSISTSTREAM, true], [CLSID_CLASS_MONIKER, true],
        [IID_IROTDATA, true]]))
    {
        assert.equal(await t.supports(nulled, iid), expected, iid);
    }
    assert.equal(await t.sizeMax(nulled), 20);
    const source = t.stream(Uint8Array.from([...guidArray(CLSID_STD_COMPONENT_CATEGORIES_MGR),
        10, 0, 0, 0, ...utf16('data'), 0, 0]));
    assert.equal(await t.m(nulled, 'Load', source.pointer), S_OK);
    assert.equal(await t.sizeMax(nulled), 30);
    assert.equal(await t.display(nulled), 'clsid:0002E005-0000-0000-C000-000000000046data:');
    const persisted = /** @type {number[]} */ (await t.saved(nulled));
    assert.equal(persisted.length, 30);
    assert.deepEqual(persisted.slice(16, 20), [10, 0, 0, 0]);
    assert.deepEqual(await t.comparison(nulled), expectedClassComparison);

    const moniker = await t.made('CreateClassMoniker', t.guid(CLSID_STD_COMPONENT_CATEGORIES_MGR));
    await checkMoniker(t, moniker, { saved: expectedClassSaved,
        comparison: expectedClassComparison, size: 20,
        name: 'clsid:0002E005-0000-0000-C000-000000000046:' });
    assert.equal(await t.hash(moniker), 0x0002e005);
    assert.equal(await t.mksys(moniker), MKSYS.CLASSMONIKER);
    assert.equal(await t.m(moniker, 'IsRunning', 0, 0, 0), E_NOTIMPL);
    assert.equal(await t.m(moniker, 'IsRunning', context, 0, 0), E_NOTIMPL);
    assert.equal(await t.m(moniker, 'GetTimeOfLastChange', context, 0, t.out()), MK_E_UNAVAILABLE);

    const factory = t.guestObject([IID_IUNKNOWN, IID_ICLASSFACTORY], {});
    t.classObjects.set(CLSID_STD_COMPONENT_CATEGORIES_MGR, factory.pointer);
    const unknown = t.guid(IID_IUNKNOWN);
    const object = t.out();
    assert.equal(await t.m(moniker, 'BindToObject', context, 0, unknown, object), S_OK);
    assert.equal(t.u32(object), factory.pointer);
    assert.equal(await t.m(moniker, 'BindToStorage', context, 0, unknown, object), S_OK);
    assert.equal(factory.refs, 3);

    const inverse = t.out();
    assert.equal(await t.m(moniker, 'Inverse', inverse), S_OK);
    assert.equal(await t.mksys(t.u32(inverse)), MKSYS.ANTIMONIKER);
    const reduced = t.out();
    assert.equal(await t.m(moniker, 'Reduce', 0, 0, 0, reduced), MK_S_REDUCED_TO_SELF);
    assert.equal(t.u32(reduced), moniker);
    const enumerator = t.out(0xdeadbeef);
    assert.equal(await t.m(moniker, 'Enum', 1, enumerator), S_OK);
    assert.equal(t.u32(enumerator), 0);
    assert.equal(await t.m(moniker, 'Enum', 0, 0), E_INVALIDARG);

    const composite = t.out();
    assert.equal(await t.m(moniker, 'ComposeWith', await t.anti(1), 1, composite), S_OK);
    assert.equal(t.u32(composite), 0);
    assert.equal(await t.m(moniker, 'ComposeWith', await t.anti(2), 1, composite), S_OK);
    assert.equal(t.u32(composite), 0, 'a class moniker is cancelled whatever the count');
    const c = await t.desc('CA1I1');
    assert.equal(await t.m(moniker, 'ComposeWith', c, 1, composite), MK_E_NEEDGENERIC);
    assert.equal(await t.m(moniker, 'ComposeWith', c, 0, composite), S_OK);
    assert.equal(await t.mksys(t.u32(composite)), MKSYS.ITEMMONIKER);
});

test('file monikers persist, compare, compose and bind', async()=>{
    const t = setup();
    for (const full of ['\\windows\\system\\test1.doc', '\\abcdefg\\hijkl\\mnopqrstu.mno',
        '\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u00c6\u00c7\u00c8\u00c9\u00ca\u00cb',
        '\u20ac\u2020\u0100\u0101\u0102\u0103\u0104\u0105\u0106'])
    {
        for (let length = full.length; length > 0; length--)
        {
            const path = full.slice(0, length);
            const moniker = await t.file(path);
            assert.equal(await t.supports(moniker, CLSID_FILE_MONIKER), true);
            const inverse = t.out();
            assert.equal(await t.m(moniker, 'Inverse', inverse), S_OK);
            assert.equal(await t.mksys(t.u32(inverse)), MKSYS.ANTIMONIKER);

            // What is saved loads back as the same moniker.
            const saved = await t.saved(moniker);
            assert.ok(Array.isArray(saved));
            const fresh = await t.file('x');
            assert.equal(await t.m(fresh, 'Load', t.stream(Uint8Array.from(saved)).pointer), S_OK);
            assert.equal(await t.m(moniker, 'IsEqual', fresh), S_OK, JSON.stringify(path));
            assert.equal(await t.display(fresh), path);

            const context = await t.bindContext();
            const reduced = t.out();
            assert.equal(await t.m(moniker, 'Reduce', 0, 0, 0, reduced), E_INVALIDARG);
            assert.equal(await t.m(moniker, 'Reduce', context, 0, 0, 0), E_INVALIDARG);
            assert.equal(await t.m(moniker, 'Reduce', context, 0, 0, reduced),
                MK_S_REDUCED_TO_SELF);
            assert.equal(t.u32(reduced), moniker);
            const enumerator = t.out(0xdeadbeef);
            assert.equal(await t.m(moniker, 'Enum', 1, enumerator), S_OK);
            assert.equal(t.u32(enumerator), 0);

            const composite = t.out();
            assert.equal(await t.m(moniker, 'ComposeWith', await t.anti(1), 1, composite), S_OK);
            assert.equal(t.u32(composite), 0);
            assert.equal(await t.m(moniker, 'ComposeWith', await t.anti(2), 1, composite), S_OK);
            assert.equal(await t.mksys(t.u32(composite)), MKSYS.ANTIMONIKER);
            assert.equal(await t.hash(t.u32(composite)), 0x80000001);
        }
    }

    const a = await t.file('test.bmp');
    assert.equal(await t.m(a, 'IsEqual', await t.file('TEST.bmp')), S_OK);
    assert.equal(await t.m(a, 'IsEqual', 0), E_INVALIDARG);
    assert.equal(await t.supports(a, IID_IPERSIST), false);
    assert.deepEqual(await t.comparison(a), [...guidArray(CLSID_FILE_MONIKER),
        ...utf16('TEST.BMP'), 0, 0]);
    assert.equal(await t.sizeMax(a), 0x38 + 4 * 8);
    assert.deepEqual(await t.saved(await t.file('c:\\a.doc')), [0, 0, 9, 0, 0, 0,
        ...ascii('c:\\a.doc'), 0, 0xff, 0xff, 0xad, 0xde, ...new Array(20).fill(0), 0, 0, 0, 0]);
    assert.deepEqual(await t.saved(await t.file('c:\\dir\\')), [0, 0, 8, 0, 0, 0,
        ...ascii('c:\\dir\\'), 0, 0xff, 0xff, 0xad, 0xde, ...new Array(20).fill(0),
        20, 0, 0, 0, 14, 0, 0, 0, 3, 0, ...utf16('c:\\dir\\')]);

    // Windows does not check the constants it writes when it loads them back.
    const written = t.stream();
    assert.equal(await t.m(await t.file('c:\\windows\\test1.doc'), 'Save', written.pointer, 1),
        S_OK);
    const data = written.data;
    data[0] = 0x98;
    data[1] = 0xba;
    const dead = 2 + 4 + 21 + 2;
    data.splice(dead, 2, 0x98, 0xba);
    data.splice(dead + 2, 20, ...new Array(5).fill([0x98, 0xba, 0xdc, 0xfe]).flat());
    const reloaded = await t.file('x');
    assert.equal(await t.m(reloaded, 'Load', t.stream(Uint8Array.from(data)).pointer), S_OK);
    assert.equal(await t.display(reloaded), 'c:\\windows\\test1.doc');

    const composed = t.out();
    assert.equal(await t.m(await t.file('C:\\a\\b'), 'ComposeWith', await t.file('..\\c'), 1,
        composed), S_OK);
    assert.equal(await t.display(t.u32(composed)), 'C:\\a\\c');
    assert.equal(await t.m(await t.file('C:\\a'), 'ComposeWith', await t.file('b.txt'), 1,
        composed), S_OK);
    assert.equal(await t.display(t.u32(composed)), 'C:\\a\\b.txt');
    assert.equal(await t.m(await t.file('C:\\a'), 'ComposeWith', await t.item('!', 'x'), 1,
        composed), MK_E_NEEDGENERIC);

    const relative = t.out();
    assert.equal(await t.m(await t.file('C:\\a\\b.doc'), 'RelativePathTo',
        await t.file('C:\\a\\c\\d.doc'), relative), S_OK);
    assert.equal(await t.display(t.u32(relative)), '..\\c\\d.doc');
    const elsewhere = await t.file('D:\\x');
    assert.equal(await t.m(await t.file('C:\\a'), 'RelativePathTo', elsewhere, relative), MK_S_HIM);
    assert.equal(t.u32(relative), elsewhere);
});

test('a file moniker binds to the object running under it, else to its file', async()=>{
    const t = setup();
    const path = 'C:\\docs\\report.wtf';
    const moniker = await t.file(path);
    const context = await t.bindContext();
    const unknown = t.guid(IID_IUNKNOWN);
    const object = t.out();

    t.files.set(path.toUpperCase(), { lastWrite: 0x1d00000000000000n });
    assert.equal(await t.m(moniker, 'BindToObject', context, 0, unknown, object),
        MK_E_INVALIDEXTENSION);

    /** @type {string[]} */
    const loads = [];
    const document = t.guestObject([IID_IUNKNOWN, IID_IPERSISTFILE], {
        5: ([name, mode])=>{
            loads.push(`${t.readWide(name)}:${mode}`);
            return S_OK;
        },
    });
    const factory = t.guestObject([IID_IUNKNOWN, IID_ICLASSFACTORY], {
        3: ([, iidAt, outAt])=>{
            assert.equal(formatGuid(t.bytes.subarray(iidAt, iidAt + 16)), IID_IPERSISTFILE);
            document.refs++;
            t.put(outAt, document.pointer);
            return S_OK;
        },
    });
    t.classes.set('.WTF', 'Wtf.Document');
    t.classes.set('WTF.DOCUMENT\\CLSID', CLSID_TEST);
    t.classObjects.set(CLSID_TEST, factory.pointer);
    assert.equal(await t.m(moniker, 'BindToObject', context, 0, unknown, object), S_OK);
    assert.equal(t.u32(object), document.pointer);
    assert.deepEqual(loads, [`${path}:${STGM_READ}`]);
    assert.equal(document.refs, 3, 'one for the caller, one the bind context holds');
    await t.b(context, 'ReleaseBoundObjects');
    assert.equal(document.refs, 2);

    // Running, it is not loaded again.
    const running = t.guestObject([IID_IUNKNOWN], {});
    const cookie = t.out();
    assert.equal(await t.callMethod(t.table.pointer, 3, [0, running.pointer, moniker, cookie]),
        S_OK);
    assert.equal(await t.m(moniker, 'IsRunning', context, 0, 0), S_OK);
    assert.equal(await t.m(moniker, 'BindToObject', context, 0, unknown, object), S_OK);
    assert.equal(t.u32(object), running.pointer);
    assert.equal(loads.length, 1);

    const filetime = t.out();
    assert.equal(await t.m(moniker, 'GetTimeOfLastChange', context, 0, filetime), S_OK);
    assert.equal(t.u32(filetime), 0x1234, 'the running object table knows it');
    await t.callMethod(t.table.pointer, 4, [t.u32(cookie)]);
    assert.equal(await t.m(moniker, 'GetTimeOfLastChange', context, 0, filetime), S_OK);
    assert.equal(t.u32(filetime + 4), 0x1d000000);
    assert.equal(await t.m(await t.file('C:\\none'), 'GetTimeOfLastChange', context, 0, filetime),
        0x800401e5 | 0);
});

test('a file moniker opens its storage with the bind options\' mode', async()=>{
    const t = setup();
    const moniker = await t.file('C:\\TEMP\\stg1.tmp');
    assert.equal(await t.supports(moniker, IID_IMARSHAL), true, 'it crosses by value');
    const storage = t.guid(IID_ISTORAGE);
    const out = t.out();
    assert.equal(await t.m(moniker, 'BindToStorage', 0, 0, storage, out), E_INVALIDARG);
    const context = await t.bindContext();
    assert.equal(await t.m(moniker, 'BindToStorage', context, 0, storage, out), STG_E_INVALIDFLAG);
    const options = t.heap.allocate(16);
    t.put(options, 16);
    t.put(options + 8, STGM_READWRITE | STGM_SHARE_DENY_WRITE);
    await t.b(context, 'SetBindOptions', options);
    assert.equal(await t.m(moniker, 'BindToStorage', context, 0, storage, out), STG_E_INVALIDFLAG);
    t.put(options + 8, STGM_READ | STGM_SHARE_DENY_WRITE);
    await t.b(context, 'SetBindOptions', options);
    assert.equal(await t.m(moniker, 'BindToStorage', context, 0, storage, out), S_OK);
    assert.deepEqual(t.storageOpens.map(open=>open.mode), [STGM_READWRITE,
        STGM_READWRITE | STGM_SHARE_DENY_WRITE, STGM_READ | STGM_SHARE_DENY_WRITE]);
    assert.equal(await t.m(moniker, 'BindToStorage', context, 0, t.guid(IID_IDISPATCH), out),
        E_NOINTERFACE);
});

test('generic composites simplify where their components meet', async()=>{
    const t = setup();
    const context = await t.bindContext();
    for (const [left, right, type, name] of /** @type {[string, string, number, string?][]} */ ([
        ['I1', 'I2', MKSYS.GENERICCOMPOSITE, '!I1!I2'],
        ['I1', 'A2', MKSYS.ANTIMONIKER, '\\..'],
        ['A1', 'A1', MKSYS.GENERICCOMPOSITE, '\\..\\..'],
        ['A2', 'A1', MKSYS.GENERICCOMPOSITE, '\\..\\..\\..'],
        ['CI1I2', 'A1', MKSYS.ITEMMONIKER, '!I1'],
        ['I1', 'A1', MKSYS.NONE],
        ['CI1I2', 'A2', MKSYS.NONE],
        ['CI1I2', 'A3', MKSYS.ANTIMONIKER, '\\..'],
        ['CI1I3', 'CA1I2', MKSYS.GENERICCOMPOSITE, '!I1!I2'],
    ]))
    {
        const composite = t.out(0xdeadbeef);
        assert.equal(await t.fn('CreateGenericComposite', await t.desc(left), await t.desc(right),
            composite), S_OK);
        if (type === MKSYS.NONE)
        {
            assert.equal(t.u32(composite), 0, `${left} + ${right}`);
            continue;
        }
        assert.equal(await t.mksys(t.u32(composite)), type, `${left} + ${right}`);
        assert.equal(await t.display(t.u32(composite), context), name);
    }
});

test('a generic composite persists, hashes and names itself as Windows does', async()=>{
    const t = setup();
    const first = await t.item('!', 'Test');
    const second = await t.item('#', 'Wine');
    const moniker = await t.made('CreateGenericComposite', first, second);
    assert.equal(await t.supports(moniker, IID_IMONIKER), true);
    assert.equal(await t.supports(moniker, IID_IPERSIST), false);
    assert.equal(await t.supports(moniker, IID_IPERSISTSTREAM), true);
    assert.equal(await t.supports(moniker, IID_IROTDATA), true);
    assert.equal(await t.supports(moniker, CLSID_COMPOSITE_MONIKER), true);
    await checkMoniker(t, moniker, { saved: expectedCompositeSaved,
        comparison: expectedCompositeComparison, size: 160, name: '!Test#Wine' });
    assert.equal(await t.hash(moniker), 0xd87);
    assert.equal(await t.mksys(moniker), MKSYS.GENERICCOMPOSITE);

    // Loaded back, it is the same composite.
    const loaded = /** @type {any} */ (t.registry.create(CLSID_COMPOSITE_MONIKER));
    const fresh = t.env.vtables.publish(loaded, IID_IMONIKER);
    assert.equal(await t.m(fresh, 'Load',
        t.stream(Uint8Array.from(expectedCompositeSaved)).pointer), S_OK);
    assert.equal(await t.display(fresh), '!Test#Wine');
    assert.equal(await t.m(fresh, 'IsEqual', moniker), S_OK);
    assert.equal(await t.m(fresh, 'Load',
        t.stream(Uint8Array.from(expectedCompositeSaved)).pointer), E_UNEXPECTED);

    const context = await t.bindContext();
    assert.equal(await t.m(moniker, 'IsRunning', 0, 0, 0), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'IsRunning', context, 0, 0), S_FALSE);
    assert.equal(await t.m(moniker, 'IsRunning', context, 0, moniker), S_OK);
    assert.equal(await t.m(moniker, 'IsRunning', context, first, moniker), S_FALSE);
    assert.equal(await t.m(moniker, 'IsRunning', 0, first, moniker), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'GetTimeOfLastChange', context, 0, t.out()), MK_E_NOTBINDABLE);
    const unknown = t.guid(IID_IUNKNOWN);
    assert.equal(await t.m(moniker, 'BindToStorage', context, 0, unknown, t.out()), E_INVALIDARG);
    const inverse = t.out();
    assert.equal(await t.m(moniker, 'Inverse', inverse), S_OK);
    assert.equal(await t.mksys(t.u32(inverse)), MKSYS.GENERICCOMPOSITE);

    // Bound with nothing to its left, it is the object running under it.
    const object = t.out();
    assert.equal(await t.m(moniker, 'BindToObject', context, 0, unknown, object), E_INVALIDARG);
    const cookie = t.out();
    assert.equal(await t.callMethod(t.table.pointer, 3, [1, moniker, moniker, cookie]), S_OK);
    assert.equal(await t.m(moniker, 'BindToObject', context, 0, unknown, object), S_OK);
    assert.equal(await t.m(moniker, 'BindToObject', context, 0, t.guid(IID_IMONIKER), object),
        S_OK);
    assert.equal(await t.m(moniker, 'BindToObject', context, 0, t.guid(IID_IDISPATCH), object),
        E_NOINTERFACE);
    assert.equal(await t.callMethod(t.table.pointer, 4, [t.u32(cookie)]), S_OK);

    // With a moniker to its left, its last component binds.
    const pointer = await t.made('CreatePointerMoniker', t.table.pointer);
    const i1 = await t.desc('I1');
    const composite = await t.made('CreateGenericComposite', i1, pointer);
    assert.equal(await t.m(composite, 'BindToObject', context, i1, t.guid(IID_IMONIKER), object),
        E_NOINTERFACE);
});

test('an uninitialised composite refuses what it cannot answer', async()=>{
    const t = setup();
    const object = /** @type {any} */ (t.registry.create(CLSID_COMPOSITE_MONIKER));
    const moniker = t.env.vtables.publish(object, IID_IMONIKER);
    assert.ok((await t.m(moniker, 'Save', t.stream().pointer, 1)) < 0);
    assert.equal(await t.hash(moniker), E_UNEXPECTED);
    const context = await t.bindContext();
    assert.equal(await t.m(moniker, 'GetDisplayName', context, 0, t.out()), E_INVALIDARG);
    const data = t.out();
    assert.equal(await t.callMethod(moniker, 0, [t.guid(IID_IROTDATA), data]), S_OK);
    assert.ok((await t.callMethod(t.u32(data), 3, [0, 0, t.out()])) < 0);
});

test('a generic composite answers about its components', async()=>{
    const t = setup();
    const context = await t.bindContext();
    const moniker = await t.desc('CI1I2');
    const i1 = await t.desc('I1');
    const composed = t.out();
    assert.equal(await t.m(i1, 'ComposeWith', moniker, 1, composed), MK_E_NEEDGENERIC);

    const filetime = t.out();
    assert.equal(await t.m(moniker, 'GetTimeOfLastChange', context, i1, filetime),
        MK_E_NOTBINDABLE);
    assert.equal(await t.m(moniker, 'GetTimeOfLastChange', context, 0, filetime),
        MK_E_NOTBINDABLE);
    assert.equal(await t.m(moniker, 'GetTimeOfLastChange', context, 0, 0), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'GetTimeOfLastChange', 0, 0, filetime), E_INVALIDARG);
    const cookie = t.out();
    assert.equal(await t.callMethod(t.table.pointer, 3, [1, moniker, moniker, cookie]), S_OK);
    assert.equal(await t.m(moniker, 'GetTimeOfLastChange', context, 0, filetime), S_OK);
    assert.equal(await t.m(moniker, 'GetTimeOfLastChange', context, i1, filetime),
        MK_E_NOTBINDABLE);
    await t.callMethod(t.table.pointer, 4, [t.u32(cookie)]);

    const prefix = t.out(0xdeadbeef);
    assert.equal(await t.m(moniker, 'CommonPrefixWith', 0, 0), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'CommonPrefixWith', i1, 0), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'CommonPrefixWith', 0, prefix), E_INVALIDARG);
    assert.equal(t.u32(prefix), 0);
    assert.equal(await t.m(moniker, 'CommonPrefixWith', moniker, prefix), MK_S_US);
    assert.notEqual(t.u32(prefix), moniker);
    assert.equal(await t.m(moniker, 'IsEqual', t.u32(prefix)), S_OK);
    const twin = await t.desc('CI1I2');
    assert.equal(await t.m(moniker, 'CommonPrefixWith', twin, prefix), MK_S_US);
    assert.ok(t.u32(prefix) !== moniker && t.u32(prefix) !== twin);
    assert.equal(await t.m(moniker, 'CommonPrefixWith', await t.desc('I2'), prefix),
        MK_E_NOPREFIX);
    assert.equal(await t.m(moniker, 'CommonPrefixWith', i1, prefix), MK_S_HIM);
    assert.notEqual(t.u32(prefix), i1);
    assert.equal(await t.m(i1, 'IsEqual', t.u32(prefix)), S_OK);

    assert.equal(await t.m(moniker, 'IsEqual', 0), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'IsEqual', twin), S_OK);
    assert.equal(await t.m(moniker, 'IsEqual', moniker), S_OK);

    assert.equal(await t.m(moniker, 'ComposeWith', 0, 0, composed), S_OK);
    assert.equal(t.u32(composed), moniker);
    assert.equal(await t.m(moniker, 'ComposeWith', 0, 1, composed), MK_E_NEEDGENERIC);
    assert.equal(t.u32(composed), 0);

    const inverse = t.out(0xdeadbeef);
    assert.equal(await t.m(moniker, 'Inverse', 0), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'Inverse', inverse), S_OK);
    assert.equal(await t.mksys(t.u32(inverse)), MKSYS.GENERICCOMPOSITE);
    assert.equal(await t.display(t.u32(inverse)), '\\..\\..');
    for (const description of ['CA1A2', 'CI1A2'])
    {
        t.put(inverse, 0xdeadbeef);
        assert.equal(await t.m(await t.desc(description), 'Inverse', inverse), MK_E_NOINVERSE);
        assert.equal(t.u32(inverse), 0);
    }

    // A program's monikers, to see the order the inverses come in.
    const m = testMoniker(t, 'I5');
    const withProgram = await t.made('CreateGenericComposite', i1, m.pointer);
    assert.equal(await t.mksys(withProgram), MKSYS.GENERICCOMPOSITE);
    t.put(inverse, 0xdeadbeef);
    assert.equal(await t.m(withProgram, 'Inverse', inverse), S_OK);
    assert.equal(t.u32(inverse), 0);
    const m2 = testMoniker(t, 'I4');
    const both = await t.made('CreateGenericComposite', m2.pointer, m.pointer);
    assert.equal(await t.m(both, 'Inverse', inverse), S_OK);
    assert.equal(await t.mksys(t.u32(inverse)), MKSYS.GENERICCOMPOSITE);
    assert.equal(await t.display(t.u32(inverse)), '!I5!I4');
    assert.equal(await t.display(both), '**Gemma**Gemma');

    // One component with no display name, and no comparison data.
    const withPointer = await t.desc('CPI1');
    const name = t.out(0xdeadbeef);
    assert.equal(await t.m(withPointer, 'GetDisplayName', 0, 0, name), E_INVALIDARG);
    assert.equal(await t.m(withPointer, 'GetDisplayName', context, 0, 0), E_INVALIDARG);
    assert.equal(await t.m(withPointer, 'GetDisplayName', context, 0, name), E_NOTIMPL);
    const data = t.out();
    assert.equal(await t.callMethod(withPointer, 0, [t.guid(IID_IROTDATA), data]), S_OK);
    const size = t.out(0xdead);
    assert.equal(await t.callMethod(t.u32(data), 3, [t.heap.allocate(100), 100, size]), E_NOTIMPL);
    assert.equal(t.u32(size), 0);

    const reduced = t.out();
    assert.equal(await t.m(moniker, 'Reduce', 0, 0, 0, 0), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'Reduce', context, 0, 0, 0), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'Reduce', 0, 0, 0, reduced), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'Reduce', context, 0, 0, reduced), MK_S_REDUCED_TO_SELF);
    assert.equal(t.u32(reduced), moniker);

    const relative = t.out();
    assert.equal(await t.m(moniker, 'RelativePathTo', 0, 0), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'RelativePathTo', await t.desc('CI2I3'), relative),
        MK_E_NOTBINDABLE);
});

test('a generic composite enumerates its components either way', async()=>{
    const t = setup();
    const moniker = await t.desc('CI1CI2I3');
    assert.equal(await t.m(moniker, 'Enum', 0, 0), E_INVALIDARG);
    for (const [forward, order] of /** @type {[number, string[]][]} */ ([
        [1, ['!I1', '!I2', '!I3']], [0, ['!I3', '!I2', '!I1']]]))
    {
        const slot = t.out();
        assert.equal(await t.m(moniker, 'Enum', forward, slot), S_OK);
        const enumerator = t.u32(slot);
        /** @param {number} slotIndex @param {number[]} args */
        const e = (slotIndex, ...args)=>t.callMethod(enumerator, slotIndex, args);
        const item = t.out(0xdeadbeef);
        const count = t.out(1);
        assert.equal(await e(3, 0, 0, 0), E_INVALIDARG);
        assert.equal(await e(3, 0, item, 0), S_OK);
        assert.equal(t.u32(item), 0);
        t.put(item, 0xdeadbeef);
        assert.equal(await e(3, 0, item, count), S_OK);
        assert.equal(t.u32(count), 0);
        assert.equal(t.u32(item), 0);
        assert.equal(await e(4, 0), S_OK);
        for (const expected of order)
        {
            assert.equal(await e(3, 1, item, count), S_OK);
            assert.equal(t.u32(count), 1);
            assert.equal(await t.display(t.u32(item)), expected);
            await t.m(t.u32(item), 'Release');
        }
        t.put(count, 1);
        assert.equal(await e(3, 1, item, count), S_FALSE);
        assert.equal(t.u32(count), 0);
        assert.equal(await e(4, 0), S_OK);
        assert.equal(await e(4, 1), S_FALSE);
        assert.equal(await e(6, 0), E_INVALIDARG);
        const clone = t.out(0xdeadbeef);
        assert.equal(await e(6, clone), E_NOTIMPL);
        assert.equal(t.u32(clone), 0);
        assert.equal(await e(5), S_OK);
        assert.equal(await e(4, 2), S_OK);
        assert.equal(await e(3, 1, item, count), S_OK);
        assert.equal(await t.display(t.u32(item)), order[2]);
        await e(2);
    }
});

test('a system moniker marshals by value: its class, its saved bytes, its size at most', async()=>{
    // moniker.c test_moniker: the OBJREF a class or anti moniker crosses in
    // names the moniker's own class, and carries what Save writes, sized by
    // GetSizeMax.
    const t = setup();
    const anti = await t.anti(1);
    const marshal = t.out();
    assert.equal(await t.callMethod(anti, 0, [t.guid(IID_IMARSHAL), marshal]), S_OK);
    const iMarshal = t.u32(marshal);
    const clsid = t.out();
    assert.equal(await t.callMethod(iMarshal, 3, [0, 0, 0, 0, 0, clsid]), S_OK);
    assert.equal(formatGuid(t.bytes.slice(clsid, clsid + 16)), CLSID_ANTI_MONIKER);
    const size = t.out();
    assert.equal(await t.callMethod(iMarshal, 4, [0, 0, 0, 0, 0, size]), S_OK);
    assert.equal(t.u32(size), await t.sizeMax(anti));
    const target = t.stream();
    assert.equal(await t.callMethod(iMarshal, 5, [target.pointer, 0, anti, 0, 0, 0]), S_OK);
    assert.deepEqual(target.data, await t.saved(anti));

    const fresh = await t.anti(3);
    const into = t.out();
    target.rewind();
    const other = t.out();
    assert.equal(await t.callMethod(fresh, 0, [t.guid(IID_IMARSHAL), other]), S_OK);
    assert.equal(await t.callMethod(t.u32(other), 6, [target.pointer, t.guid(IID_IMONIKER),
        into]), S_OK, 'UnmarshalInterface loads what was saved');
    assert.equal(await t.m(t.u32(into), 'IsEqual', anti), S_OK);
    await t.callMethod(iMarshal, 2, []);
});

test('an objref moniker is a pointer moniker that marshals its object', async()=>{
    // moniker.c test_objref_moniker: its own class and MKSYS, answers as a
    // pointer moniker too, and its IMarshal names its class to unmarshal.
    const t = setup();
    const factory = t.guestObject([IID_IUNKNOWN, IID_ICLASSFACTORY], {});
    assert.equal(await t.fn('CreateObjrefMoniker', factory.pointer, 0), E_INVALIDARG);
    const moniker = await t.made('CreateObjrefMoniker', factory.pointer);
    assert.equal(factory.refs, 2);
    assert.equal(await t.supports(moniker, CLSID_OBJREF_MONIKER), true);
    assert.equal(await t.supports(moniker, CLSID_POINTER_MONIKER), true);
    assert.equal(await t.supports(moniker, IID_IROTDATA), false);
    assert.equal(await t.mksys(moniker), MKSYS.OBJREFMONIKER);
    assert.equal(await t.hash(moniker), factory.pointer);
    const clsid = t.out();
    assert.equal(await t.m(moniker, 'GetClassID', clsid), S_OK);
    assert.equal(formatGuid(t.bytes.slice(clsid, clsid + 16)), CLSID_OBJREF_MONIKER);

    const marshal = t.out();
    assert.equal(await t.callMethod(moniker, 0, [t.guid(IID_IMARSHAL), marshal]), S_OK);
    const unmarshalClass = t.out();
    assert.equal(await t.callMethod(t.u32(marshal), 3, [0, 0, 0, 0, 0, unmarshalClass]), S_OK);
    assert.equal(formatGuid(t.bytes.slice(unmarshalClass, unmarshalClass + 16)),
        CLSID_OBJREF_MONIKER);
    await t.callMethod(t.u32(marshal), 2, []);

    await t.m(moniker, 'Release');
    assert.equal(factory.refs, 1, 'its object let go inside its last Release');
});

test('pointer monikers stand for the object they hold', async()=>{
    const t = setup();
    const factory = t.guestObject([IID_IUNKNOWN, IID_ICLASSFACTORY], {});
    assert.equal(await t.fn('CreatePointerMoniker', factory.pointer, 0), E_INVALIDARG);
    const moniker = await t.made('CreatePointerMoniker', factory.pointer);
    assert.equal(await t.supports(moniker, IID_IMONIKER), true);
    assert.equal(await t.supports(moniker, IID_IPERSIST), false);
    assert.equal(await t.supports(moniker, IID_IPERSISTSTREAM), true);
    assert.equal(await t.supports(moniker, CLSID_POINTER_MONIKER), true);
    assert.equal(await t.supports(moniker, IID_IROTDATA), false);
    assert.equal(factory.refs, 2);

    const context = await t.bindContext();
    const name = t.out(0xdeadbeef);
    assert.equal(await t.m(moniker, 'GetDisplayName', context, 0, name), E_NOTIMPL);
    assert.equal(await t.m(moniker, 'GetDisplayName', context, 0, 0), E_INVALIDARG);
    assert.equal(await t.m(moniker, 'GetDisplayName', 0, 0, name), E_INVALIDARG);
    assert.equal(t.u32(name), 0);
    assert.equal(await t.m(moniker, 'IsDirty'), S_FALSE);
    assert.equal(await t.m(moniker, 'Save', t.stream().pointer, 1), E_NOTIMPL);
    assert.equal(await t.hash(moniker), factory.pointer);
    assert.equal(await t.mksys(moniker), MKSYS.POINTERMONIKER);
    const inverse = t.out();
    assert.equal(await t.m(moniker, 'Inverse', inverse), S_OK);
    assert.equal(await t.mksys(t.u32(inverse)), MKSYS.ANTIMONIKER);
    assert.equal(await t.m(moniker, 'IsRunning', context, 0, 0), S_OK);
    assert.equal(await t.m(moniker, 'GetTimeOfLastChange', context, 0, t.out()), E_NOTIMPL);
    const unknown = t.guid(IID_IUNKNOWN);
    const object = t.out();
    assert.equal(await t.m(moniker, 'BindToObject', context, 0, unknown, object), S_OK);
    assert.equal(t.u32(object), factory.pointer);
    assert.equal(await t.m(moniker, 'BindToStorage', context, 0, unknown, object), S_OK);
    factory.refs -= 2;
    await t.m(moniker, 'Release');
    assert.equal(factory.refs, 1, 'the moniker let its object go inside its last Release');

    const empty = await t.made('CreatePointerMoniker', 0);
    assert.equal(await t.m(empty, 'BindToObject', context, 0, unknown, object), E_UNEXPECTED);
    assert.equal(await t.m(empty, 'BindToStorage', context, 0, unknown, object), E_UNEXPECTED);
    assert.equal(await t.m(empty, 'Enum', 1, t.out()), E_NOTIMPL);
    assert.equal(await t.m(empty, 'Enum', 0, t.out()), E_NOTIMPL);

    const a = await t.made('CreatePointerMoniker', factory.pointer);
    const b = await t.made('CreatePointerMoniker', factory.pointer);
    const prefix = t.out();
    assert.equal(await t.m(a, 'IsEqual', 0), E_INVALIDARG);
    assert.equal(await t.m(a, 'IsEqual', b), S_OK);
    assert.equal(await t.m(a, 'CommonPrefixWith', b, 0), E_INVALIDARG);
    assert.equal(await t.m(a, 'CommonPrefixWith', 0, prefix), E_INVALIDARG);
    assert.equal(await t.m(a, 'CommonPrefixWith', b, prefix), MK_S_US);
    assert.equal(t.u32(prefix), a);
    const ofMoniker = await t.made('CreatePointerMoniker', a);
    assert.equal(await t.m(a, 'IsEqual', ofMoniker), S_FALSE);
    assert.equal(await t.m(a, 'CommonPrefixWith', ofMoniker, prefix), MK_E_NOPREFIX);

    const composite = t.out();
    assert.equal(await t.m(a, 'ComposeWith', await t.anti(1), 1, composite), S_OK);
    assert.equal(t.u32(composite), 0);
    assert.equal(await t.m(a, 'ComposeWith', await t.anti(2), 1, composite), S_OK);
    assert.equal(await t.mksys(t.u32(composite)), MKSYS.ANTIMONIKER);
    const c = await t.desc('CA1A3');
    assert.equal(await t.m(a, 'ComposeWith', c, 1, composite), MK_E_NEEDGENERIC);
    assert.equal(await t.m(a, 'ComposeWith', c, 0, composite), S_OK);
    assert.equal(await t.hash(t.u32(composite)), 0x80000003);
    const ai = await t.desc('CA1I1');
    assert.equal(await t.m(a, 'ComposeWith', ai, 0, composite), S_OK);
    assert.equal(await t.mksys(t.u32(composite)), MKSYS.ITEMMONIKER);

    const i1 = await t.desc('I1');
    const relative = t.out(0xdeadbeef);
    assert.equal(await t.m(a, 'RelativePathTo', 0, 0), E_INVALIDARG);
    assert.equal(await t.m(a, 'RelativePathTo', 0, relative), E_INVALIDARG);
    assert.equal(t.u32(relative), 0);
    assert.equal(await t.m(a, 'RelativePathTo', i1, 0), E_INVALIDARG);
    t.put(relative, 0xdeadbeef);
    assert.equal(await t.m(a, 'RelativePathTo', i1, relative), E_NOTIMPL);
    assert.equal(t.u32(relative), 0);
});

test('MkParseDisplayName refuses what it cannot parse and leaves its outputs', async()=>{
    const t = setup();
    const context = await t.bindContext();
    const empty = t.wide('');
    for (const pbc of [0, context])
    {
        for (const name of [0, empty])
        {
            for (const eatenWanted of [false, true])
            {
                for (const outWanted of [false, true])
                {
                    const eaten = t.out(0xdeadbeef);
                    const out = t.out(0xdeadbeef);
                    assert.equal(await t.fn('MkParseDisplayName', pbc, name,
                        eatenWanted ? eaten : 0, outWanted ? out : 0), E_INVALIDARG);
                    assert.equal(t.u32(eaten), 0xdeadbeef);
                    assert.equal(t.u32(out), 0xdeadbeef);
                }
            }
        }
    }
    for (const name of ['NonExistentProgId:', 'clsid:', 'StdFont'])
    {
        const eaten = t.out(0xdeadbeef);
        const out = t.out(0xdeadbeef);
        assert.equal(await t.fn('MkParseDisplayName', context, t.wide(name), eaten, out),
            MK_E_SYNTAX, name);
        assert.equal(t.u32(eaten), 0);
        assert.equal(t.u32(out), 0);
    }
});

test('MkParseDisplayName makes class, ProgID and file monikers', async()=>{
    const t = setup();
    const context = await t.bindContext();
    const factory = t.guestObject([IID_IUNKNOWN, IID_ICLASSFACTORY], {});

    // A class beats a running object of the same name.
    const myComputer = `clsid:${CLSID_MY_COMPUTER.slice(1, -1)}:`;
    const runningFile = await t.file(myComputer);
    const cookie = t.out();
    await t.callMethod(t.table.pointer, 3, [0, factory.pointer, runningFile, cookie]);
    const eaten = t.out();
    const out = t.out();
    assert.equal(await t.fn('MkParseDisplayName', context, t.wide(myComputer), eaten, out), S_OK);
    assert.equal(t.u32(eaten), 43);
    assert.equal(await t.mksys(t.u32(out)), MKSYS.CLASSMONIKER);
    await t.callMethod(t.table.pointer, 4, [t.u32(cookie)]);

    // A name that is running is a file moniker, file or no file.
    const runningName = await t.file('WineTestRunning');
    await t.callMethod(t.table.pointer, 3, [0, factory.pointer, runningName, cookie]);
    assert.equal(await t.fn('MkParseDisplayName', context, t.wide('WineTestRunning'), eaten, out),
        S_OK);
    assert.equal(t.u32(eaten), 15);
    assert.equal(await t.mksys(t.u32(out)), MKSYS.FILEMONIKER);
    await t.callMethod(t.table.pointer, 4, [t.u32(cookie)]);

    // A ProgID's class parses the whole name, handed the program's own string.
    /** @type {number[]} */
    const seen = [];
    const parser = t.guestObject([IID_IUNKNOWN, IID_IPARSEDISPLAYNAME], {
        3: async([, name, eatenAt, outAt])=>{
            seen.push(name);
            t.put(eatenAt, t.readWide(name).length);
            t.put(outAt, await t.made('CreateAntiMoniker'));
            return S_OK;
        },
    }, 1);
    t.classObjects.set(CLSID_STD_FONT, parser.pointer);
    t.classes.set('STDFONT\\CLSID', CLSID_STD_FONT);
    for (const text of ['StdFont:', '@StdFont'])
    {
        const name = t.wide(text);
        assert.equal(await t.fn('MkParseDisplayName', context, name, eaten, out), S_OK);
        assert.equal(t.u32(eaten), 8);
        assert.equal(await t.mksys(t.u32(out)), MKSYS.ANTIMONIKER);
        assert.equal(seen[seen.length - 1], name);
    }
    assert.equal(parser.refs, 1, 'the parser was let go');

    const system = 'C:\\WINDOWS\\system32\\kernel32.dll';
    t.files.set(system.toUpperCase(), { lastWrite: 0n });
    assert.equal(await t.fn('MkParseDisplayName', context, t.wide(system), eaten, out), S_OK);
    assert.equal(t.u32(eaten), system.length);
    assert.equal(await t.mksys(t.u32(out)), MKSYS.FILEMONIKER);

    // The class moniker binds to its class object.
    t.classObjects.set(CLSID_MY_COMPUTER, factory.pointer);
    assert.equal(await t.fn('MkParseDisplayName', context, t.wide(myComputer), eaten, out), S_OK);
    const object = t.out();
    assert.equal(await t.m(t.u32(out), 'BindToObject', context, 0, t.guid(IID_IUNKNOWN), object),
        S_OK);
    assert.equal(t.u32(object), factory.pointer);
});

test('MkParseDisplayName parses what follows a file through its class', async()=>{
    const t = setup();
    const context = await t.bindContext();
    const path = 'C:\\book.wtf';
    t.files.set(path.toUpperCase(), { lastWrite: 0n });
    t.classes.set('.WTF', 'Wtf.Document');
    t.classes.set('WTF.DOCUMENT\\CLSID', CLSID_TEST);
    /** @type {string[]} */
    const parsed = [];
    const parser = t.guestObject([IID_IUNKNOWN, IID_IPARSEDISPLAYNAME], {
        3: async([, name, eatenAt, outAt])=>{
            const text = t.readWide(name);
            parsed.push(text);
            t.put(eatenAt, text.length);
            t.put(outAt, await t.item('!', text.slice(1)));
            return S_OK;
        },
    });
    t.classObjects.set(CLSID_TEST, parser.pointer);
    const eaten = t.out();
    const out = t.out();
    assert.equal(await t.fn('MkParseDisplayName', context, t.wide(`${path}!Sheet1`), eaten, out),
        S_OK);
    assert.deepEqual(parsed, ['!Sheet1']);
    assert.equal(t.u32(eaten), path.length + 7);
    assert.equal(await t.mksys(t.u32(out)), MKSYS.GENERICCOMPOSITE);
    assert.equal(await t.display(t.u32(out)), `${path}!Sheet1`);

    assert.equal(await t.fn('MkParseDisplayName', context, t.wide('C:\\none.wtf!x'), eaten, out),
        MK_E_SYNTAX);
    assert.equal(t.u32(eaten), 0);
});

test('MonikerCommonPrefixWith compares monikers of which one is a composite', async()=>{
    const t = setup();
    const out = t.out(0xdeadbeef);
    assert.equal(await t.fn('MonikerCommonPrefixWith', 0, 0, out), MK_E_NOPREFIX);
    assert.equal(t.u32(out), 0);
    const item = await t.item('!', 'Item');
    t.put(out, 0xdeadbeef);
    assert.equal(await t.fn('MonikerCommonPrefixWith', item, 0, out), MK_E_NOPREFIX);
    assert.equal(t.u32(out), 0);
    assert.equal(await t.fn('MonikerCommonPrefixWith', 0, item, out), MK_E_NOPREFIX);
    assert.equal(await t.fn('MonikerCommonPrefixWith', item, item, out), MK_E_NOPREFIX);
    const file1 = await t.file('C:\\test.txt');
    assert.equal(await t.fn('MonikerCommonPrefixWith', file1, 0, out), MK_E_NOPREFIX);
    assert.equal(await t.fn('MonikerCommonPrefixWith', file1, file1, out), MK_E_NOPREFIX);
    const file2 = await t.file('C:\\a\\test.txt');
    assert.equal(await t.fn('MonikerCommonPrefixWith', file1, file2, out), MK_E_NOPREFIX);
    const composite = await t.made('CreateGenericComposite', file1, item);
    const composite2 = await t.made('CreateGenericComposite', file2, item);

    assert.equal(await t.fn('MonikerCommonPrefixWith', file1, composite, out), MK_S_ME);
    assert.equal(t.u32(out), file1);
    assert.equal(await t.fn('MonikerCommonPrefixWith', file1, composite2, out), S_OK);
    assert.equal(await t.mksys(t.u32(out)), MKSYS.FILEMONIKER);
    assert.equal(await t.display(t.u32(out)), 'C:\\');
    assert.equal(await t.fn('MonikerCommonPrefixWith', composite2, file1, out), S_OK);
    assert.equal(await t.display(t.u32(out)), 'C:\\');
    assert.equal(await t.fn('MonikerCommonPrefixWith', composite, file1, out), MK_S_HIM);
    assert.equal(t.u32(out), file1);
    assert.equal(await t.fn('MonikerCommonPrefixWith', composite, composite, out), MK_S_US);
    assert.equal(await t.mksys(t.u32(out)), MKSYS.GENERICCOMPOSITE);
    assert.equal(await t.display(t.u32(out)), 'C:\\test.txt!Item');
    assert.notEqual(t.u32(out), composite);
    assert.equal(await t.fn('MonikerCommonPrefixWith', composite, composite2, out), S_OK);
    assert.equal(t.u32(out), 0);

    assert.equal(await t.fn('MonikerCommonPrefixWith', await t.desc('CI1CI2I3'),
        await t.desc('CCI1I2I4'), out), S_OK);
    assert.equal(await t.mksys(t.u32(out)), MKSYS.GENERICCOMPOSITE);
    assert.equal(await t.display(t.u32(out)), '!I1!I2');
});

test('MonikerRelativePathTo goes back over what is not shared', async()=>{
    const t = setup();
    const out = t.out();
    assert.equal(await t.fn('MonikerRelativePathTo', 0, 0, out, 1), E_INVALIDARG);
    const from = await t.desc('CI1I2');
    const to = await t.desc('CI1I3');
    assert.equal(await t.fn('MonikerRelativePathTo', from, to, out, 1), S_OK);
    assert.equal(await t.display(t.u32(out)), '\\..!I3');
    const unrelated = await t.desc('I9');
    assert.equal(await t.fn('MonikerRelativePathTo', from, unrelated, out, 1), MK_S_HIM);
    assert.equal(t.u32(out), unrelated);
});

test('GetClassFile reads a storage\'s class, else its extension\'s', async()=>{
    const t = setup();
    const out = t.out();
    assert.equal(await t.fn('GetClassFile', t.wide('dummypath'), out), MK_E_CANTOPENFILE);
    t.files.set('C:\\A.STG', { lastWrite: 0n });
    t.storages.set('C:\\A.STG', CLSID_TEST);
    assert.equal(await t.fn('GetClassFile', t.wide('C:\\a.stg'), out), S_OK);
    assert.equal(formatGuid(t.bytes.subarray(out, out + 16)), CLSID_TEST);
    t.files.set('C:\\B.WTF', { lastWrite: 0n });
    assert.equal(await t.fn('GetClassFile', t.wide('C:\\b.wtf'), out), MK_E_INVALIDEXTENSION);
    t.classes.set('.WTF', 'Wtf.Document');
    t.classes.set('WTF.DOCUMENT\\CLSID', CLSID_STD_FONT);
    assert.equal(await t.fn('GetClassFile', t.wide('C:\\b.wtf'), out), S_OK);
    assert.equal(formatGuid(t.bytes.subarray(out, out + 16)), CLSID_STD_FONT);
    t.files.set('C:\\NOEXT', { lastWrite: 0n });
    assert.equal(await t.fn('GetClassFile', t.wide('C:\\noext'), out), MK_E_INVALIDEXTENSION);
    t.files.set('C:\\DOT.', { lastWrite: 0n });
    assert.equal(await t.fn('GetClassFile', t.wide('C:\\dot.'), out), MK_E_INVALIDEXTENSION);
});

test('CoGetInstanceFromFile loads an instance and answers each interface asked', async()=>{
    const t = setup();
    let persistFile = S_OK;
    let loadAnswer = S_OK;
    const instance = t.guestObject([IID_IUNKNOWN], {
        0: ([iidAt, outAt], self)=>{
            const iid = formatGuid(t.bytes.subarray(iidAt, iidAt + 16));
            if (iid === IID_IUNKNOWN)
            {
                t.put(outAt, self.pointer);
                return S_OK;
            }
            if (iid === IID_IPERSISTFILE)
            {
                t.put(outAt, persistFile >= 0 ? self.pointer : 0);
                return persistFile;
            }
            t.put(outAt, 0);
            return E_NOINTERFACE;
        },
        5: ()=>loadAnswer,
    });
    const factory = t.guestObject([IID_IUNKNOWN, IID_ICLASSFACTORY], {
        3: ([, iidAt, outAt])=>{
            assert.equal(formatGuid(t.bytes.subarray(iidAt, iidAt + 16)), IID_IUNKNOWN);
            t.put(outAt, instance.pointer);
            return S_OK;
        },
    });
    const name = t.wide('dummypath');
    const results = t.heap.allocate(24);
    const unknown = t.guid(IID_IUNKNOWN);
    /** @param {number} index @param {number} itf @param {number} hr */
    const setResult = (index, itf, hr)=>{
        t.put(results + index * 12, unknown);
        t.put(results + index * 12 + 4, itf);
        t.put(results + index * 12 + 8, hr);
    };
    /** @param {number} index */
    const result = index=>[t.u32(results + index * 12 + 4), t.u32(results + index * 12 + 8) | 0];
    const clsid = t.guid(CLSID_TEST);

    setResult(0, 0, E_NOTIMPL);
    assert.equal(await t.fn('CoGetInstanceFromFile', 0, 0, 0, 1, STGM_READ, name, 1, results),
        MK_E_CANTOPENFILE);
    assert.deepEqual(result(0), [0, E_NOINTERFACE]);

    setResult(0, 0, E_NOTIMPL);
    assert.equal(await t.fn('CoGetInstanceFromFile', 0, clsid, 0, 1, STGM_READ, name, 1, results),
        REGDB_E_CLASSNOTREG);
    assert.deepEqual(result(0), [0, REGDB_E_CLASSNOTREG]);

    t.classObjects.set(CLSID_TEST, factory.pointer);
    for (const hr of [S_OK, E_NOTIMPL])
    {
        setResult(0, 0xdeadbeef, hr);
        assert.equal(await t.fn('CoGetInstanceFromFile', 0, clsid, 0, 1, STGM_READ, name, 1,
            results), E_INVALIDARG);
        assert.deepEqual(result(0), [0xdeadbeef, hr]);
    }
    for (const answer of [S_OK, S_FALSE])
    {
        persistFile = answer;
        setResult(0, 0, S_OK);
        assert.equal(await t.fn('CoGetInstanceFromFile', 0, clsid, 0, 1, STGM_READ, name, 1,
            results), S_OK);
        assert.deepEqual(result(0), [instance.pointer, S_OK]);
    }
    persistFile = 0x8000efef | 0;
    setResult(0, 0, S_OK);
    setResult(1, 0, S_OK);
    assert.equal(await t.fn('CoGetInstanceFromFile', 0, clsid, 0, 1, STGM_READ, name, 2, results),
        0x8000efef | 0);
    assert.deepEqual([result(0), result(1)], [[0, 0x8000efef | 0], [0, 0x8000efef | 0]]);
    persistFile = S_OK;
    loadAnswer = 0x8000fefe | 0;
    setResult(0, 0, S_OK);
    setResult(1, 0, S_OK);
    assert.equal(await t.fn('CoGetInstanceFromFile', 0, clsid, 0, 1, STGM_READ, name, 2, results),
        0x8000fefe | 0);
    assert.deepEqual([result(0), result(1)], [[0, 0x8000fefe | 0], [0, 0x8000fefe | 0]]);

    loadAnswer = S_OK;
    setResult(0, 0, S_OK);
    setResult(1, 0, S_OK);
    t.put(results + 12, t.guid(IID_IDISPATCH));
    assert.equal(await t.fn('CoGetInstanceFromFile', 0, clsid, 0, 1, STGM_READ, name, 2, results),
        CO_S_NOTALLINTERFACES);
    assert.deepEqual([result(0), result(1)], [[instance.pointer, S_OK], [0, E_NOINTERFACE]]);
    assert.equal(await t.fn('CoGetInstanceFromFile', 0, clsid, 0, 1, STGM_READ, name, 0, results),
        E_INVALIDARG);
});

test('BindMoniker binds in a bind context of its own', async()=>{
    const t = setup();
    const factory = t.guestObject([IID_IUNKNOWN, IID_ICLASSFACTORY], {});
    t.classObjects.set(CLSID_TEST, factory.pointer);
    const moniker = await t.made('CreateClassMoniker', t.guid(CLSID_TEST));
    const out = t.out();
    assert.equal(await t.fn('BindMoniker', moniker, 0, t.guid(IID_ICLASSFACTORY), out), S_OK);
    assert.equal(t.u32(out), factory.pointer);
    assert.equal(await t.fn('BindMoniker', moniker, 1, t.guid(IID_ICLASSFACTORY), out),
        E_INVALIDARG);
    assert.equal(await t.fn('BindMoniker', await t.anti(1), 0, t.guid(IID_IUNKNOWN), out),
        E_NOTIMPL);
});

test('monikers made by CoCreateInstance are known once asked', async()=>{
    const t = setup();
    for (const [clsid, type, name] of /** @type {[string, number, string][]} */ ([
        [CLSID_FILE_MONIKER, MKSYS.FILEMONIKER, ''],
        [CLSID_CLASS_MONIKER, MKSYS.CLASSMONIKER, 'clsid:00000000-0000-0000-0000-000000000000:'],
        [CLSID_ANTI_MONIKER, MKSYS.ANTIMONIKER, '\\..'],
    ]))
    {
        const object = /** @type {any} */ (t.registry.create(clsid));
        const moniker = t.env.vtables.publish(object, IID_IMONIKER);
        const twin = /** @type {any} */ (t.registry.create(clsid));
        const second = t.env.vtables.publish(twin, IID_IMONIKER);
        // Never called before, the other is still recognised as a system moniker.
        assert.equal(await t.m(moniker, 'IsEqual', second), S_OK);
        assert.equal(await t.mksys(moniker), type);
        assert.equal(await t.display(moniker), name);
    }
    const pointer = /** @type {any} */ (t.registry.create(CLSID_POINTER_MONIKER));
    const moniker = t.env.vtables.publish(pointer, IID_IMONIKER);
    assert.equal(await t.m(moniker, 'BindToObject', 0, 0, t.guid(IID_IUNKNOWN), t.out()),
        E_UNEXPECTED);
    assert.deepEqual(t.reported, []);
});
