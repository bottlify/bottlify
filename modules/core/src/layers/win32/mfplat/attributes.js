/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IMFAttributes: the key-value store every Media Foundation object is built
 * on -- a media type, a sample and an event are each one, with methods of
 * their own after these thirty.
 *
 * A value is one of seven types, each a PROPVARIANT type: UINT32 (VT_UI4),
 * UINT64 (VT_UI8), DOUBLE (VT_R8), GUID (VT_CLSID), STRING (VT_LPWSTR), BLOB
 * (VT_VECTOR | VT_UI1) and IUNKNOWN (VT_UNKNOWN). The store holds them on
 * the host; what a getter hands out (a string, a blob, a GUID inside a
 * PROPVARIANT) is the caller's in task memory, and an interface handed out
 * carries a reference of its own.
 *
 * The contract is Wine's mfplat test_attributes and test_media_type, which
 * hold what Windows answers: a typed getter of another type is
 * MF_E_INVALIDTYPE and leaves its out alone; SetItem of a type the store
 * does not hold refuses with MF_E_INVALIDTYPE yet keeps the key, empty;
 * GetItem with no PROPVARIANT asks only whether the key is there; a string
 * buffer too short is STRSAFE_E_INSUFFICIENT_BUFFER with the length still
 * said; CopyAllItems empties the destination first; Compare's match types
 * past MF_ATTRIBUTES_MATCH_SMALLER are E_INVALIDARG.
 */

import { E_INVALIDARG, E_NOT_SUFFICIENT_BUFFER, E_OUTOFMEMORY, E_POINTER, S_OK, drive }
    from './kit.js';
import { parseGuid } from '../ole32/guid.js';

export const MF_E_ATTRIBUTENOTFOUND = 0xc00d36e6 | 0;
export const MF_E_INVALIDTYPE = 0xc00d36bd | 0;

/** MF_ATTRIBUTE_TYPE: the PROPVARIANT type of each kind of value. */
export const TYPE = Object.freeze({ EMPTY: 0, DOUBLE: 5, IUNKNOWN: 13, UINT32: 19, UINT64: 21,
    STRING: 31, GUID: 72, BLOB: 0x1011 });
/** @type {Set<number>} */
const HELD = new Set([TYPE.DOUBLE, TYPE.IUNKNOWN, TYPE.UINT32, TYPE.UINT64, TYPE.STRING, TYPE.GUID,
    TYPE.BLOB]);

/** MF_ATTRIBUTES_MATCH_TYPE. */
export const MATCH = Object.freeze({ OUR_ITEMS: 0, THEIR_ITEMS: 1, ALL_ITEMS: 2, INTERSECTION: 3,
    SMALLER: 4 });

/** IMFAttributes' slots, after IUnknown's, as a foreign store is called. */
export const ATTRIBUTES_SLOT = Object.freeze({ SetItem: 18, DeleteAllItems: 20, GetCount: 30,
    GetItemByIndex: 31 });

export const IID_IMFATTRIBUTES = '{2CD2D921-C447-44A7-A13C-4ADABFC247E3}';

/**
 * A value: its type and, by type, a number, a bigint, a GUID's canonical
 * string, a string, the bytes or an interface pointer.
 *
 * @typedef {{ vt: number, value: any }} Item
 */

/** A PROPVARIANT's bytes. */
const PROPVARIANT_SIZE = 16;

/**
 * Two values the same: of one type and one value, an interface by its
 * pointer, a blob by its bytes.
 *
 * @param {Item | undefined} a @param {Item | undefined} b
 */
export function sameItem(a, b){
    if (!a || !b || a.vt !== b.vt)
    {
        return false;
    }
    if (a.vt === TYPE.BLOB)
    {
        return a.value.length === b.value.length
            && a.value.every((/** @type {number} */ byte, /** @type {number} */ i)=>byte === b.value[i]);
    }
    return a.value === b.value;
}

/**
 * Compare's answer for two stores.
 *
 * @param {Map<string, Item>} ours @param {Map<string, Item>} theirs @param {number} type
 * @returns {boolean}
 */
export function matches(ours, theirs, type){
    /** @param {Map<string, Item>} from @param {Map<string, Item>} into */
    const within = (from, into)=>[...from].every(([key, item])=>sameItem(item, into.get(key)));
    switch (type)
    {
        case MATCH.OUR_ITEMS:
            return within(ours, theirs);
        case MATCH.THEIR_ITEMS:
            return within(theirs, ours);
        case MATCH.ALL_ITEMS:
            return ours.size === theirs.size && within(ours, theirs);
        case MATCH.INTERSECTION:
            return [...ours].every(([key, item])=>!theirs.has(key)
                || sameItem(item, theirs.get(key)));
        default:
            return ours.size <= theirs.size ? within(ours, theirs) : within(theirs, ours);
    }
}

/**
 * The thirty methods, over `object.state.items`.
 *
 * @param {import('./kit.js').MfKit} kit
 * @param {import('./kit.js').MfHost} host
 */
export function createAttributes(kit, host){
    const { u32, putU32s, u64, putU64, f64, putF64, guidAt, putGuid, wideString, encodeWide,
        taskCopy } = kit;

    /**
     * The value a PROPVARIANT holds, as the store keeps it, or null for a
     * type it does not hold.
     *
     * @param {number} at
     * @returns {Item | null}
     */
    const itemAt = at=>{
        const vt = u32(at) & 0xffff;
        switch (vt)
        {
            case TYPE.UINT32:
                return { vt, value: u32(at + 8) };
            case TYPE.UINT64:
                return { vt, value: u64(at + 8) };
            case TYPE.DOUBLE:
                return { vt, value: f64(at + 8) };
            case TYPE.GUID:
                return u32(at + 8) === 0 ? null : { vt, value: guidAt(u32(at + 8)) };
            case TYPE.STRING:
                return u32(at + 8) === 0 ? null : { vt, value: wideString(u32(at + 8)) };
            case TYPE.BLOB: {
                const count = u32(at + 8);
                const bytes = count === 0 ? new Uint8Array(0)
                    : host.readMemory(u32(at + 12), count).slice();
                return { vt, value: bytes };
            }
            case TYPE.IUNKNOWN:
                return { vt, value: u32(at + 8) };
            default:
                return null;
        }
    };

    /**
     * A value written into a PROPVARIANT the caller owns: what it points at
     * in task memory, an interface with a reference taken.
     *
     * @param {number} at @param {Item} item @param {any} thread
     * @returns {number | Promise<number>}
     */
    const putItem = (at, item, thread)=>{
        const bytes = new Uint8Array(PROPVARIANT_SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, item.vt, true);
        switch (item.vt)
        {
            case TYPE.UINT32:
            case TYPE.IUNKNOWN:
                view.setUint32(8, item.value >>> 0, true);
                break;
            case TYPE.UINT64:
                view.setBigUint64(8, item.value, true);
                break;
            case TYPE.DOUBLE:
                view.setFloat64(8, item.value, true);
                break;
            case TYPE.GUID:
            case TYPE.STRING: {
                const copy = taskCopy(item.vt === TYPE.GUID
                    ? /** @type {Uint8Array} */ (parseGuid(item.value)) : encodeWide(item.value));
                if (copy === 0)
                {
                    return E_OUTOFMEMORY;
                }
                view.setUint32(8, copy, true);
                break;
            }
            case TYPE.BLOB: {
                const copy = taskCopy(item.value);
                if (copy === 0)
                {
                    return E_OUTOFMEMORY;
                }
                view.setUint32(8, item.value.length, true);
                view.setUint32(12, copy, true);
                break;
            }
            default:
                break;
        }
        host.writeMemory(at >>> 0, bytes);
        const taken = item.vt === TYPE.IUNKNOWN ? kit.addRef(item.value, thread) : undefined;
        return taken ? taken.then(()=>S_OK) : S_OK;
    };

    /**
     * A value stored under a key, the one it replaces let go of.
     *
     * @param {any} object @param {string} key @param {Item} item @param {any} thread
     * @returns {number | Promise<number>}
     */
    const store = (object, key, item, thread)=>{
        /** @type {Map<string, Item>} */
        const items = object.state.items;
        const old = items.get(key);
        items.set(key, item);
        return drive((function* (){
            if (item.vt === TYPE.IUNKNOWN)
            {
                yield kit.addRef(item.value, thread);
            }
            if (old?.vt === TYPE.IUNKNOWN)
            {
                yield kit.release(old.value, thread);
            }
            return yield kit.settle(S_OK, thread);
        })());
    };

    /**
     * Every value let go of: what a store's DeleteAllItems and its death do.
     *
     * @param {Map<string, Item>} items @param {any} [thread]
     */
    const clear = (items, thread)=>{
        const held = [...items.values()].filter(item=>item.vt === TYPE.IUNKNOWN);
        items.clear();
        return drive((function* (){
            for (const item of held)
            {
                yield kit.release(item.value, thread);
            }
            return S_OK;
        })());
    };

    /**
     * A key's value of one type, or why there is none.
     *
     * @param {any} object @param {number} keyAt @param {number} vt
     * @returns {Item | number}
     */
    const typed = (object, keyAt, vt)=>{
        const item = object.state.items.get(guidAt(keyAt));
        if (!item)
        {
            return MF_E_ATTRIBUTENOTFOUND;
        }
        return item.vt === vt ? item : MF_E_INVALIDTYPE;
    };

    /**
     * Another store's values: ours read on the host, a foreign one through
     * its GetCount and GetItemByIndex, what those hand out given back.
     *
     * @param {number} pointer @param {any} thread
     * @returns {Map<string, Item> | Promise<Map<string, Item>>}
     */
    const itemsOf = (pointer, thread)=>{
        const own = kit.ownAt(pointer);
        if (own)
        {
            return own.state.items;
        }
        return drive((function* (){
            const scratch = host.heap.allocate(4 + 16 + PROPVARIANT_SIZE) >>> 0;
            /** @type {Map<string, Item>} */
            const found = new Map();
            try
            {
                if ((yield kit.guest(thread, pointer, ATTRIBUTES_SLOT.GetCount, [scratch])) !== 0)
                {
                    return found;
                }
                const count = u32(scratch);
                for (let i = 0; i < count; i++)
                {
                    host.writeMemory(scratch + 20, new Uint8Array(PROPVARIANT_SIZE));
                    if ((yield kit.guest(thread, pointer, ATTRIBUTES_SLOT.GetItemByIndex,
                        [i, scratch + 4, scratch + 20])) !== 0)
                    {
                        continue;
                    }
                    const item = itemAt(scratch + 20) ?? { vt: TYPE.EMPTY, value: null };
                    found.set(guidAt(scratch + 4), item);
                    const vt = u32(scratch + 20) & 0xffff;
                    if (vt === TYPE.GUID || vt === TYPE.STRING)
                    {
                        host.heap.free(u32(scratch + 28));
                    }
                    else if (vt === TYPE.BLOB)
                    {
                        host.heap.free(u32(scratch + 32));
                    }
                    else if (vt === TYPE.IUNKNOWN)
                    {
                        yield kit.release(u32(scratch + 28), thread);
                    }
                }
                return found;
            }
            finally
            {
                host.heap.free(scratch);
            }
        })());
    };

    /**
     * Values written into another store: ours on the host, a foreign one
     * through its DeleteAllItems and SetItem.
     *
     * @param {number} pointer @param {Map<string, Item>} items @param {any} thread
     * @returns {number | Promise<number>}
     */
    const copyInto = (pointer, items, thread)=>{
        const own = kit.ownAt(pointer);
        if (own)
        {
            const copies = [...items];
            return drive((function* (){
                yield clear(own.state.items, thread);
                for (const [key, item] of copies)
                {
                    yield store(own, key, item, thread);
                }
                return S_OK;
            })());
        }
        return drive((function* (){
            yield kit.guest(thread, pointer, ATTRIBUTES_SLOT.DeleteAllItems, []);
            const scratch = host.heap.allocate(16 + PROPVARIANT_SIZE) >>> 0;
            try
            {
                for (const [key, item] of items)
                {
                    putGuid(scratch, key);
                    const hr = yield putItem(scratch + 16, item, thread);
                    if (hr !== S_OK)
                    {
                        return hr;
                    }
                    yield kit.guest(thread, pointer, ATTRIBUTES_SLOT.SetItem,
                        [scratch, scratch + 16]);
                    // What putItem made for the copy -- task memory, a
                    // reference -- is the copy's to give back, as a
                    // PropVariantClear would.
                    if (item.vt === TYPE.GUID || item.vt === TYPE.STRING)
                    {
                        host.heap.free(u32(scratch + 24));
                    }
                    else if (item.vt === TYPE.BLOB)
                    {
                        host.heap.free(u32(scratch + 28));
                    }
                    else if (item.vt === TYPE.IUNKNOWN)
                    {
                        yield kit.release(item.value, thread);
                    }
                }
                return S_OK;
            }
            finally
            {
                host.heap.free(scratch);
            }
        })());
    };

    /** @param {number} vt @param {(args: number[]) => any} read */
    const setter = (vt, read)=>(/** @type {any} */ object, /** @type {number[]} */ args)=>
        store(object, guidAt(args[0]), { vt, value: read(args) }, host.callerThread?.());

    /**
     * A typed getter: the value written where `out` says, the out left alone
     * on any refusal.
     *
     * @param {number} vt @param {(out: number, item: Item) => void} write
     */
    const getter = (vt, write)=>(/** @type {any} */ object, /** @type {number[]} */ [key, out])=>{
        const item = typed(object, key, vt);
        if (typeof item === 'number')
        {
            return item;
        }
        if ((out >>> 0) === 0)
        {
            return E_POINTER;
        }
        write(out, item);
        return S_OK;
    };

    /** @type {import('../ole32/objects.js').ComMethod[]} */
    const methods = [
        /** HRESULT GetItem(REFGUID key, PROPVARIANT *value) */
        { name: 'GetItem', argBytes: 12, invoke: (object, [key, out])=>{
            const item = object.state.items.get(guidAt(key));
            if (!item)
            {
                return MF_E_ATTRIBUTENOTFOUND;
            }
            return (out >>> 0) === 0 ? S_OK : putItem(out, item, host.callerThread?.());
        } },
        /** HRESULT GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE *type) */
        { name: 'GetItemType', argBytes: 12, invoke: (object, [key, out])=>{
            const item = object.state.items.get(guidAt(key));
            if (!item)
            {
                return MF_E_ATTRIBUTENOTFOUND;
            }
            putU32s(out, [item.vt]);
            return S_OK;
        } },
        /** HRESULT CompareItem(REFGUID key, REFPROPVARIANT value, BOOL *result) */
        { name: 'CompareItem', argBytes: 16, invoke: (object, [key, value, out])=>{
            const given = (value >>> 0) === 0 ? null : itemAt(value);
            putU32s(out, [given && sameItem(object.state.items.get(guidAt(key)), given) ? 1 : 0]);
            return S_OK;
        } },
        /** HRESULT Compare(IMFAttributes *theirs, MF_ATTRIBUTES_MATCH_TYPE type, BOOL *result) */
        { name: 'Compare', argBytes: 16, invoke: (object, [theirs, type, out])=>{
            if ((type >>> 0) > MATCH.SMALLER)
            {
                return E_INVALIDARG;
            }
            if ((theirs >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_POINTER;
            }
            return drive((function* (){
                const other = yield itemsOf(theirs, host.callerThread?.());
                putU32s(out, [matches(object.state.items, other, type >>> 0) ? 1 : 0]);
                return S_OK;
            })());
        } },
        /** HRESULT GetUINT32(REFGUID key, UINT32 *value) */
        { name: 'GetUINT32', argBytes: 12,
            invoke: getter(TYPE.UINT32, (out, item)=>putU32s(out, [item.value])) },
        /** HRESULT GetUINT64(REFGUID key, UINT64 *value) */
        { name: 'GetUINT64', argBytes: 12,
            invoke: getter(TYPE.UINT64, (out, item)=>putU64(out, item.value)) },
        /** HRESULT GetDouble(REFGUID key, double *value) */
        { name: 'GetDouble', argBytes: 12,
            invoke: getter(TYPE.DOUBLE, (out, item)=>putF64(out, item.value)) },
        /** HRESULT GetGUID(REFGUID key, GUID *value) */
        { name: 'GetGUID', argBytes: 12,
            invoke: getter(TYPE.GUID, (out, item)=>putGuid(out, item.value)) },
        /** HRESULT GetStringLength(REFGUID key, UINT32 *length) */
        { name: 'GetStringLength', argBytes: 12,
            invoke: getter(TYPE.STRING, (out, item)=>putU32s(out, [item.value.length])) },
        /** HRESULT GetString(REFGUID key, LPWSTR buffer, UINT32 size, UINT32 *length) */
        { name: 'GetString', argBytes: 20, invoke: (object, [key, buffer, size, length])=>{
            const item = typed(object, key, TYPE.STRING);
            if (typeof item === 'number')
            {
                return item;
            }
            if ((length >>> 0) !== 0)
            {
                putU32s(length, [item.value.length]);
            }
            if (item.value.length + 1 > (size >>> 0))
            {
                return E_NOT_SUFFICIENT_BUFFER;
            }
            host.writeMemory(buffer >>> 0, encodeWide(item.value));
            return S_OK;
        } },
        /** HRESULT GetAllocatedString(REFGUID key, LPWSTR *value, UINT32 *length) */
        { name: 'GetAllocatedString', argBytes: 16, invoke: (object, [key, out, length])=>{
            const item = typed(object, key, TYPE.STRING);
            if (typeof item === 'number')
            {
                return item;
            }
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const copy = taskCopy(encodeWide(item.value));
            if (copy === 0)
            {
                return E_OUTOFMEMORY;
            }
            putU32s(out, [copy]);
            if ((length >>> 0) !== 0)
            {
                putU32s(length, [item.value.length]);
            }
            return S_OK;
        } },
        /** HRESULT GetBlobSize(REFGUID key, UINT32 *size) */
        { name: 'GetBlobSize', argBytes: 12,
            invoke: getter(TYPE.BLOB, (out, item)=>putU32s(out, [item.value.length])) },
        /** HRESULT GetBlob(REFGUID key, UINT8 *buffer, UINT32 size, UINT32 *written) */
        { name: 'GetBlob', argBytes: 20, invoke: (object, [key, buffer, size, written])=>{
            const item = typed(object, key, TYPE.BLOB);
            if (typeof item === 'number')
            {
                return item;
            }
            if (item.value.length > (size >>> 0))
            {
                return E_NOT_SUFFICIENT_BUFFER;
            }
            if (item.value.length > 0)
            {
                host.writeMemory(buffer >>> 0, item.value);
            }
            if ((written >>> 0) !== 0)
            {
                putU32s(written, [item.value.length]);
            }
            return S_OK;
        } },
        /** HRESULT GetAllocatedBlob(REFGUID key, UINT8 **buffer, UINT32 *size) */
        { name: 'GetAllocatedBlob', argBytes: 16, invoke: (object, [key, out, size])=>{
            const item = typed(object, key, TYPE.BLOB);
            if (typeof item === 'number')
            {
                return item;
            }
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const copy = taskCopy(item.value);
            if (copy === 0)
            {
                return E_OUTOFMEMORY;
            }
            putU32s(out, [copy]);
            if ((size >>> 0) !== 0)
            {
                putU32s(size, [item.value.length]);
            }
            return S_OK;
        } },
        /** HRESULT GetUnknown(REFGUID key, REFIID riid, void **out) */
        { name: 'GetUnknown', argBytes: 16, invoke: (object, [key, iid, out])=>{
            const item = typed(object, key, TYPE.IUNKNOWN);
            if (typeof item === 'number')
            {
                return item;
            }
            if ((item.value >>> 0) === 0)
            {
                return MF_E_INVALIDTYPE;
            }
            return kit.query(item.value, iid, out, host.callerThread?.());
        } },
        /** HRESULT SetItem(REFGUID key, REFPROPVARIANT value) */
        { name: 'SetItem', argBytes: 12, invoke: (object, [key, value])=>{
            const item = (value >>> 0) === 0 ? null : itemAt(value);
            const thread = host.callerThread?.();
            if (!item || !HELD.has(item.vt))
            {
                // The key is kept, empty: Windows' own store does (Wine's
                // test_attributes reads it back as VT_EMPTY and deletes it).
                return drive((function* (){
                    yield store(object, guidAt(key), { vt: TYPE.EMPTY, value: null }, thread);
                    return MF_E_INVALIDTYPE;
                })());
            }
            return store(object, guidAt(key), item, thread);
        } },
        /** HRESULT DeleteItem(REFGUID key) */
        { name: 'DeleteItem', argBytes: 8, invoke: (object, [key])=>{
            const id = guidAt(key);
            const old = object.state.items.get(id);
            object.state.items.delete(id);
            const thread = host.callerThread?.();
            return old?.vt === TYPE.IUNKNOWN
                ? drive((function* (){
                    yield kit.release(old.value, thread);
                    return yield kit.settle(S_OK, thread);
                })())
                : S_OK;
        } },
        /** HRESULT DeleteAllItems(void) */
        { name: 'DeleteAllItems', argBytes: 4, invoke: object=>{
            const thread = host.callerThread?.();
            return drive((function* (){
                yield clear(object.state.items, thread);
                return yield kit.settle(S_OK, thread);
            })());
        } },
        /** HRESULT SetUINT32(REFGUID key, UINT32 value) */
        { name: 'SetUINT32', argBytes: 12, invoke: setter(TYPE.UINT32, ([, value])=>value >>> 0) },
        /** HRESULT SetUINT64(REFGUID key, UINT64 value) */
        { name: 'SetUINT64', argBytes: 16,
            invoke: setter(TYPE.UINT64, ([, low, high])=>kit.wide(low, high)) },
        /** HRESULT SetDouble(REFGUID key, double value) */
        { name: 'SetDouble', argBytes: 16,
            invoke: setter(TYPE.DOUBLE, ([, low, high])=>kit.double(low, high)) },
        /** HRESULT SetGUID(REFGUID key, REFGUID value) */
        { name: 'SetGUID', argBytes: 12, invoke: (object, args)=>((args[1] >>> 0) === 0 ? E_POINTER
            : setter(TYPE.GUID, ([, value])=>guidAt(value))(object, args)) },
        /** HRESULT SetString(REFGUID key, LPCWSTR value) */
        { name: 'SetString', argBytes: 12, invoke: (object, args)=>((args[1] >>> 0) === 0
            ? E_POINTER : setter(TYPE.STRING, ([, value])=>wideString(value))(object, args)) },
        /** HRESULT SetBlob(REFGUID key, const UINT8 *buffer, UINT32 size) */
        { name: 'SetBlob', argBytes: 16, invoke: setter(TYPE.BLOB, ([, buffer, size])=>
            ((size >>> 0) === 0 ? new Uint8Array(0)
                : host.readMemory(buffer >>> 0, size >>> 0).slice())) },
        /** HRESULT SetUnknown(REFGUID key, IUnknown *value) */
        { name: 'SetUnknown', argBytes: 12,
            invoke: setter(TYPE.IUNKNOWN, ([, value])=>value >>> 0) },
        /**
         * HRESULT LockStore(void), UnlockStore(void): every call on the store
         * is one host call already, which nothing else runs inside.
         */
        { name: 'LockStore', argBytes: 4, invoke: ()=>S_OK },
        { name: 'UnlockStore', argBytes: 4, invoke: ()=>S_OK },
        /** HRESULT GetCount(UINT32 *count) */
        { name: 'GetCount', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            putU32s(out, [object.state.items.size]);
            return S_OK;
        } },
        /** HRESULT GetItemByIndex(UINT32 index, GUID *key, PROPVARIANT *value) */
        { name: 'GetItemByIndex', argBytes: 16, invoke: (object, [index, key, out])=>{
            /** @type {[string, Item] | undefined} */
            const entry = [...object.state.items][index >>> 0];
            if (!entry)
            {
                return E_INVALIDARG;
            }
            if ((key >>> 0) !== 0)
            {
                putGuid(key, entry[0]);
            }
            return (out >>> 0) === 0 ? S_OK : putItem(out, entry[1], host.callerThread?.());
        } },
        /** HRESULT CopyAllItems(IMFAttributes *destination) */
        { name: 'CopyAllItems', argBytes: 8, invoke: (object, [destination])=>{
            if ((destination >>> 0) === 0)
            {
                return E_POINTER;
            }
            const thread = host.callerThread?.();
            return drive((function* (){
                yield copyInto(destination, new Map(object.state.items), thread);
                return yield kit.settle(S_OK, thread);
            })());
        } },
    ];

    return { methods, itemsOf, clear, store, itemAt, putItem, typed };
}

/** @typedef {ReturnType<typeof createAttributes>} Attributes */
