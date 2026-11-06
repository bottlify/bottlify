/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * SetPrivateData, GetPrivateData and FreePrivateData: the bytes, or the one
 * interface pointer, a program files on a DirectDraw surface or a Direct3D 8
 * or 9 resource under a GUID of its own and reads back later -- its own
 * bookkeeping, kept where the object is.
 *
 * Each object keeps its own entries: a texture's are not its levels', and a
 * level's are not its texture's. An interface entry holds a reference on the
 * object until the entry is replaced, freed, or goes with the object that
 * holds it. The versions part in three places, which is what `rules` carries:
 * the codes; whether reading an interface entry hands the caller a reference
 * of its own (Direct3D's does, DirectDraw's does not); and what a read with no
 * buffer means (Direct3D answers the size, DirectDraw only answers a size too
 * small, and refuses the rest). DirectDraw alone has DDSPD_VOLATILE, an entry
 * that expires once the surface's contents change.
 *
 * A pointer this layer did not publish -- one of the program's own objects --
 * is held by a call into its own AddRef, on the calling thread, and let go
 * of by its Release: at once where a call replaces or frees the entry, and
 * once the Release that ended the holding object is done otherwise
 * (`publisher.owe`). Windows makes these calls under the program's own x87
 * control word (Wine's d3d8 and d3d9 test_fpu_setup).
 */

import { createFields } from './structs.js';

/** @param {unknown} value @param {(answer: any) => any} then */
const andThen = (value, then)=>(typeof (/** @type {any} */ (value))?.then === 'function'
    ? /** @type {Promise<unknown>} */ (value).then(then) : then(value));

/** The flag that makes the data an interface pointer: D3DSPD_IUNKNOWN, DDSPD_IUNKNOWNPOINTER. */
const IUNKNOWN = 0x1;
/** DDSPD_VOLATILE. */
const VOLATILE = 0x2;

/**
 * @typedef {Object} PrivateDataRules
 * @property {number} ok
 * @property {number} invalid
 * @property {number} notFound
 * @property {number} moreData
 * @property {number} [expired]  DirectDraw's answer for a volatile entry past its contents.
 * @property {boolean} readTakesReference
 * @property {boolean} bufferlessReadAnswersSize
 */

/** The rules of Direct3D 8 and 9, which agree. */
export const D3D_PRIVATE_DATA = Object.freeze({
    ok: 0,
    invalid: 0x8876086c,
    notFound: 0x88760866,
    moreData: 0x88760867,
    readTakesReference: true,
    bufferlessReadAnswersSize: true,
});

/** DirectDraw's. */
export const DDRAW_PRIVATE_DATA = Object.freeze({
    ok: 0,
    invalid: 0x80070057,
    notFound: 0x887600ff,
    moreData: 0x887602b2,
    expired: 0x887602b3,
    readTakesReference: false,
    bufferlessReadAnswersSize: false,
});

/**
 * @typedef {Object} PrivateEntry
 * @property {Uint8Array | null} bytes
 * @property {number} pointer   The interface pointer, for an interface entry.
 * @property {any} adapter      Who holds the reference that entry took, if it took one.
 * @property {string | null} held  The interface that reference was taken through.
 * @property {boolean} guest    Whether that reference is the program's object's own.
 * @property {number | null} stamp  The surface's uniqueness when a volatile entry was set.
 */

/**
 * A GUID's sixteen bytes as a key: equal GUIDs, equal keys.
 *
 * @param {any} memory @param {number} address
 */
const keyOf = (memory, address)=>Array.from(memory.readMemory(address >>> 0, 16),
    (/** @type {number} */ byte)=>byte.toString(16).padStart(2, '0')).join('');

/**
 * @param {Object} deps
 * @param {any} deps.memory      readMemory/writeMemory.
 * @param {any} deps.publisher   From createPublisher: the way from a pointer to its object.
 * @param {PrivateDataRules} deps.rules
 * @param {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [deps.callGuest]  A call into the program, for its own objects' AddRef and Release.
 * @param {() => any} [deps.currentThread]
 */
export function createPrivateData({ memory, publisher, rules, callGuest, currentThread }){
    const fields = createFields(memory);
    /**
     * A program's object's AddRef (slot 1) or Release (slot 2), called as the
     * program would call it.
     *
     * @param {number} pointer @param {1 | 2} slot @param {unknown} [thread]
     * @returns {unknown}
     */
    const callUnknown = (pointer, slot, thread = currentThread?.())=>{
        if (!callGuest)
        {
            return 0;
        }
        const table = fields.readU32(pointer >>> 0);
        const entry = table === 0 ? 0 : fields.readU32(table + slot * 4);
        return entry === 0 ? 0 : callGuest({ entry, args: [pointer >>> 0], thread });
    };
    /** Whether an entry holds a reference on one of the program's own objects. */
    const holdsGuest = (/** @type {PrivateEntry | undefined} */ entry)=>entry?.guest === true;
    /** @type {WeakMap<object, Map<string, PrivateEntry>>} */
    const stores = new WeakMap();
    /**
     * The objects whose entries hold one of the program's objects, which a
     * device going takes with it (`sweep`) though the program let go of them
     * before -- a back buffer, which its device keeps.
     *
     * @type {Set<any>}
     */
    const holders = new Set();

    /** @param {object} object */
    const storeOf = object=>{
        let store = stores.get(object);
        if (!store)
        {
            store = new Map();
            stores.set(object, store);
        }
        return store;
    };

    /**
     * The reference an entry took, given back now.
     *
     * @param {PrivateEntry | undefined} entry
     * @returns {unknown} a promise while the program's Release runs
     */
    const letGo = entry=>{
        entry?.adapter?.release(entry?.held ?? undefined);
        return holdsGuest(entry) ? callUnknown(/** @type {PrivateEntry} */ (entry).pointer, 2) : 0;
    };

    /** @param {PrivateEntry} entry */
    const sizeOf = entry=>(entry.bytes ? entry.bytes.length : 4);

    /**
     * The adapter of an object this layer published, with a reference taken
     * through the interface the pointer is, as the program's AddRef through
     * it would (ddraw4 test_private_data: an IDirectDraw4 counts on its
     * own); null for a pointer that names none of ours.
     *
     * @param {number} pointer
     */
    const hold = pointer=>{
        const object = publisher.objectAt(pointer);
        const adapter = object ? publisher.adapterFor(object) : null;
        adapter?.addRef(publisher.interfaceAt(pointer) ?? undefined);
        return adapter;
    };

    return {
        methods: {
            /** @param {any} object @param {number[]} args */
            SetPrivateData: (object, [guid, data, size, flags])=>{
                if ((guid >>> 0) === 0 || (data >>> 0) === 0)
                {
                    return rules.invalid;
                }
                /** @type {PrivateEntry} */
                const entry = {
                    bytes: null, pointer: 0, adapter: null, held: null, stamp: null, guest: false,
                };
                if ((flags & IUNKNOWN) !== 0)
                {
                    if ((size >>> 0) !== 4)
                    {
                        return rules.invalid;
                    }
                    entry.pointer = data >>> 0;
                    entry.adapter = hold(entry.pointer);
                    entry.held = entry.adapter ? publisher.interfaceAt(entry.pointer) : null;
                    entry.guest = !entry.adapter && entry.pointer !== 0 && !!callGuest;
                }
                else
                {
                    entry.bytes = memory.readMemory(data >>> 0, size >>> 0).slice();
                }
                if ((flags & VOLATILE) !== 0 && rules.expired !== undefined)
                {
                    entry.stamp = object.uniquenessValue?.() ?? null;
                }
                const store = storeOf(object);
                const key = keyOf(memory, guid);
                const thread = currentThread?.();
                // The new reference first, then the old one given back, as a
                // program's own object may be both.
                return andThen(entry.guest ? callUnknown(entry.pointer, 1, thread) : 0, ()=>{
                    const before = store.get(key);
                    store.set(key, entry);
                    if (entry.guest)
                    {
                        holders.add(object);
                    }
                    return andThen(letGo(before), ()=>rules.ok);
                });
            },

            /** @param {any} object @param {number[]} args */
            GetPrivateData: (object, [guid, data, sizeAt])=>{
                if ((guid >>> 0) === 0)
                {
                    return rules.invalid;
                }
                const entry = stores.get(object)?.get(keyOf(memory, guid));
                if (!entry)
                {
                    return rules.notFound;
                }
                if (entry.stamp !== null && entry.stamp !== object.uniquenessValue?.())
                {
                    return /** @type {number} */ (rules.expired);
                }
                if ((sizeAt >>> 0) === 0)
                {
                    return rules.invalid;
                }
                const size = sizeOf(entry);
                if ((data >>> 0) === 0 && rules.bufferlessReadAnswersSize)
                {
                    fields.writeU32(sizeAt >>> 0, size);
                    return rules.ok;
                }
                if (fields.readU32(sizeAt >>> 0) < size)
                {
                    fields.writeU32(sizeAt >>> 0, size);
                    return rules.moreData;
                }
                if ((data >>> 0) === 0)
                {
                    return rules.invalid;
                }
                if (entry.bytes)
                {
                    memory.writeMemory(data >>> 0, entry.bytes);
                }
                else
                {
                    fields.writeU32(data >>> 0, entry.pointer);
                    if (rules.readTakesReference)
                    {
                        entry.adapter?.addRef();
                        if (entry.guest)
                        {
                            fields.writeU32(sizeAt >>> 0, size);
                            return andThen(callUnknown(entry.pointer, 1), ()=>rules.ok);
                        }
                    }
                }
                fields.writeU32(sizeAt >>> 0, size);
                return rules.ok;
            },

            /** @param {any} object @param {number[]} args */
            FreePrivateData: (object, [guid])=>{
                if ((guid >>> 0) === 0)
                {
                    return rules.invalid;
                }
                const store = stores.get(object);
                const key = keyOf(memory, guid);
                const entry = store?.get(key);
                if (!store || !entry)
                {
                    return rules.notFound;
                }
                store.delete(key);
                return andThen(letGo(entry), ()=>rules.ok);
            },
        },

        /**
         * A device went, and with it the objects it kept: what their entries
         * held of the program's goes too.
         *
         * @param {(holder: any) => boolean} gone  Whether an object went with it.
         */
        sweep(gone){
            for (const holder of [...holders])
            {
                if (holder.destroyed === true || gone(holder))
                {
                    this.released(holder);
                }
            }
        },

        /**
         * The object is gone: every reference its entries held goes with it.
         *
         * @param {object} object
         */
        released(object){
            const store = stores.get(object);
            stores.delete(object);
            holders.delete(object);
            for (const entry of store?.values() ?? [])
            {
                entry.adapter?.release();
                if (holdsGuest(entry))
                {
                    publisher.owe?.((/** @type {unknown} */ thread)=>
                        callUnknown(entry.pointer, 2, thread));
                }
            }
        },
    };
}
