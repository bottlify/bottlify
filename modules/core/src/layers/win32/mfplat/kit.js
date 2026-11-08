/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What Media Foundation's objects share: guest memory in the shapes they
 * read and write, the objects this library made, and the references they
 * hold on interfaces a program hands them.
 *
 * An interface pointer a program passes in is one of two kinds. One this
 * library made is acted on directly: its count moves on the host and, when
 * it reaches zero here, its pointers are given back as a release through the
 * guest would give them back. Any other -- the program's own buffer, another
 * library's object -- is called through its vtable like any COM object,
 * which is a call into the guest: those are made after the handler has
 * returned its promise, never inside it.
 *
 * A Release owed while an object dies on the host (a sample letting its
 * buffers go) cannot call into the guest there and then; it is queued and
 * made before the call that caused it answers.
 */

import { createDeviceCalls } from '../d3dx9/device.js';
import { canonicalGuid, formatGuid, parseGuid } from '../ole32/guid.js';
import { IID_IUNKNOWN, createComObject } from '../ole32/objects.js';

export const S_OK = 0;
export const S_FALSE = 1;
export const E_NOTIMPL = 0x80004001 | 0;
export const E_NOINTERFACE = 0x80004002 | 0;
export const E_POINTER = 0x80004003 | 0;
export const E_FAIL = 0x80004005 | 0;
export const E_UNEXPECTED = 0x8000ffff | 0;
export const E_OUTOFMEMORY = 0x8007000e | 0;
export const E_INVALIDARG = 0x80070057 | 0;
/** STRSAFE_E_INSUFFICIENT_BUFFER, which is E_NOT_SUFFICIENT_BUFFER too. */
export const E_NOT_SUFFICIENT_BUFFER = 0x8007007a | 0;

/** IUnknown's slots, which every interface starts with. */
export const SLOT = Object.freeze({ QueryInterface: 0, AddRef: 1, Release: 2 });

/**
 * @typedef {Object} MfHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} heap
 *     The process heap, which is the task allocator too: what CoTaskMemFree
 *     takes back.
 * @property {{ publish: (object: any, interfaceId: string) => number,
 *     unpublish: (object: any, interfaceId: string) => boolean }} [vtables]
 * @property {(pointer: number) => any} [objectAt]  the object behind a pointer the engine published
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {() => any} [callerThread]
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 */

/**
 * @typedef {Object} Made
 * @property {import('../ole32/objects.js').ComInterfaceDescriptor} primary
 *     The interface whose pointer the object is known by.
 * @property {string[]} [aliases]
 *     Interfaces answered with the primary's pointer: the ones its table
 *     begins with (IMFAttributes for IMFSample), as COM identity asks.
 * @property {{ descriptor: import('../ole32/objects.js').ComInterfaceDescriptor,
 *     when?: (object: any) => boolean }[]} [extras]
 *     Interfaces with a table of their own, answered only while `when` says so.
 * @property {any} state
 * @property {() => void} [destroy]
 */

/**
 * Runs a generator whose yields may be promises: synchronously for as long
 * as none is, so a call that needs no guest answers at once, and on from
 * the first promise when one does.
 *
 * @template T
 * @param {Generator<any, T, any>} steps
 * @param {any} [input]
 * @returns {T | Promise<T>}
 */
export function drive(steps, input){
    for (;;)
    {
        const { value, done } = steps.next(input);
        if (done)
        {
            return value;
        }
        if (value !== null && typeof value?.then === 'function')
        {
            return value.then((/** @type {any} */ answer)=>drive(steps, answer));
        }
        input = value;
    }
}

/**
 * @param {MfHost} host
 */
export function createMfKit(host){
    const { u32, putU32s, method, string } = createDeviceCalls(host);
    /** The objects this library made: the ones acted on directly. */
    const mine = new WeakSet();
    /** Foreign interfaces whose Release is owed. */
    /** @type {number[]} */
    const owed = [];
    /** What has been said once. */
    const said = new Set();

    /** @param {number} at */
    const guidAt = at=>formatGuid(host.readMemory(at >>> 0, 16));
    /** @param {number} at @param {string} guid */
    const putGuid = (at, guid)=>host.writeMemory(at >>> 0, /** @type {Uint8Array} */ (parseGuid(guid)));
    /** @param {number} at */
    const u64 = at=>{
        const bytes = host.readMemory(at >>> 0, 8);
        return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
    };
    /** @param {number} at @param {bigint} value */
    const putU64 = (at, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
        host.writeMemory(at >>> 0, bytes);
    };
    /** @param {number} at */
    const f64 = at=>{
        const bytes = host.readMemory(at >>> 0, 8);
        return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
    };
    /** @param {number} at @param {number} value */
    const putF64 = (at, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setFloat64(0, value, true);
        host.writeMemory(at >>> 0, bytes);
    };
    /** Two stack words as the 64-bit value they are. @param {number} low @param {number} high */
    const wide = (low, high)=>BigInt(high >>> 0) << 32n | BigInt(low >>> 0);
    /** Two stack words as the double they are. @param {number} low @param {number} high */
    const double = (low, high)=>{
        const view = new DataView(new ArrayBuffer(8));
        view.setUint32(0, low >>> 0, true);
        view.setUint32(4, high >>> 0, true);
        return view.getFloat64(0, true);
    };
    /** Four stack words as the GUID passed by value. @param {number[]} words */
    const guidOf = words=>formatGuid(
        new Uint8Array(Uint32Array.from(words.map(w=>w >>> 0)).buffer));
    /** @param {number} at */
    const wideString = at=>string(at >>> 0, true, 1 << 20);
    /** @param {string} text */
    const encodeWide = text=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let i = 0; i < text.length; i++)
        {
            bytes[i * 2] = text.charCodeAt(i) & 0xff;
            bytes[i * 2 + 1] = text.charCodeAt(i) >>> 8;
        }
        return bytes;
    };
    /**
     * Task memory holding these bytes, as CoTaskMemAlloc would hand it out:
     * at least one byte, so an empty blob is a pointer all the same.
     *
     * @param {Uint8Array} bytes
     */
    const taskCopy = bytes=>{
        const at = host.heap.allocate(Math.max(bytes.length, 1)) >>> 0;
        if (at !== 0 && bytes.length > 0)
        {
            host.writeMemory(at, bytes);
        }
        return at;
    };
    /** @param {string} api @param {string} detail @param {'loss'} [kind] */
    const sayOnce = (api, detail, kind)=>{
        if (!said.has(`${api}|${detail}`))
        {
            said.add(`${api}|${detail}`);
            host.divergence?.(api, detail, kind);
        }
    };

    /**
     * A method of an interface in guest memory, deferred until the handler
     * that wants it has returned its promise.
     *
     * @param {any} thread @param {number} pointer @param {number} slot @param {number[]} args
     * @returns {Promise<number>}
     */
    const guest = (thread, pointer, slot, args)=>Promise.resolve().then(()=>
        method(thread, pointer >>> 0, slot, args));

    /** This library's object behind a pointer, or null. @param {number} pointer */
    const ownAt = pointer=>{
        const object = (pointer >>> 0) === 0 ? null : host.objectAt?.(pointer >>> 0);
        return object && mine.has(object) ? object : null;
    };

    /**
     * A reference given back on the host, the pointers of an object that
     * goes forgotten as a release through the guest would forget them.
     *
     * @param {any} object
     */
    const releaseOwn = object=>{
        const left = object.release();
        if (left === 0)
        {
            for (const id of object.state.interfaceIds)
            {
                host.vtables?.unpublish(object, id);
            }
        }
        return left;
    };

    /**
     * A reference taken on an interface: on the host for one of ours, through
     * the guest for any other.
     *
     * @param {number} pointer @param {any} thread
     * @returns {void | Promise<number>}
     */
    const addRef = (pointer, thread)=>{
        if ((pointer >>> 0) === 0)
        {
            return;
        }
        const object = ownAt(pointer);
        if (object)
        {
            object.addRef();
            return;
        }
        return guest(thread, pointer, SLOT.AddRef, []);
    };

    /**
     * A reference given back. With no thread to call on -- an object dying
     * on the host -- a foreign one is queued for `settle`.
     *
     * @param {number} pointer @param {any} [thread]
     * @returns {void | Promise<number>}
     */
    const release = (pointer, thread)=>{
        if ((pointer >>> 0) === 0)
        {
            return;
        }
        const object = ownAt(pointer);
        if (object)
        {
            releaseOwn(object);
            return;
        }
        if (thread === undefined)
        {
            owed.push(pointer >>> 0);
            return;
        }
        return guest(thread, pointer, SLOT.Release, []);
    };

    /**
     * The answer of a call, once the Releases it caused are made.
     *
     * @param {number} hr @param {any} thread
     * @returns {number | Promise<number>}
     */
    const settle = (hr, thread)=>{
        if (owed.length === 0)
        {
            return hr;
        }
        const pending = owed.splice(0);
        return pending.reduce((chain, pointer)=>chain.then(()=>guest(thread, pointer,
            SLOT.Release, [])), Promise.resolve(0)).then(()=>settle(hr, thread));
    };

    /**
     * QueryInterface on a pointer: answered on the host for one of ours.
     *
     * @param {number} pointer @param {number} iid  where the IID is
     * @param {number} out @param {any} thread
     * @returns {number | Promise<number>}
     */
    const query = (pointer, iid, out, thread)=>{
        const object = ownAt(pointer);
        if (!object)
        {
            return guest(thread, pointer, SLOT.QueryInterface, [iid >>> 0, out >>> 0]);
        }
        const id = guidAt(iid);
        if (!object.interfaceFor(id))
        {
            putU32s(out, [0]);
            return E_NOINTERFACE;
        }
        const at = host.vtables?.publish(object, id) ?? 0;
        if (at === 0)
        {
            putU32s(out, [0]);
            return E_OUTOFMEMORY;
        }
        object.addRef();
        putU32s(out, [at]);
        return S_OK;
    };

    /**
     * An object of this library: one pointer for its primary interface and
     * the ones that table begins with, a table of its own for each extra.
     *
     * @param {Made} made
     */
    const make = made=>{
        const primary = /** @type {string} */ (canonicalGuid(made.primary.id));
        const aliases = new Set([IID_IUNKNOWN, ...made.aliases ?? []].map(id=>
            /** @type {string} */ (canonicalGuid(id))));
        const extras = new Map((made.extras ?? []).map(extra=>[
            /** @type {string} */ (canonicalGuid(extra.descriptor.id)), extra]));
        const object = createComObject(primary, {
            interfaces: [made.primary, ...[...extras.values()].map(extra=>extra.descriptor)],
            state: { ...made.state, interfaceIds: [primary, ...extras.keys()] },
            destroy: made.destroy,
        });
        const declared = object.interfaceFor.bind(object);
        /** @param {string} id */
        object.interfaceFor = id=>{
            const key = canonicalGuid(id);
            if (key === null || object.destroyed)
            {
                return null;
            }
            if (key === primary)
            {
                return declared(key);
            }
            if (aliases.has(key))
            {
                const base = declared(primary);
                return base && { object, id: key, methods: base.methods, sharedWith: primary };
            }
            const extra = extras.get(key);
            return extra && (extra.when?.(object) ?? true) ? declared(key) : null;
        };
        // What dying owed foreign interfaces is made before the Release that
        // killed it answers.
        /** @type {any} */ (object).afterRelease = ()=>(owed.length === 0 ? undefined
            : settle(0, host.callerThread?.()));
        mine.add(object);
        return object;
    };

    /**
     * An object's primary pointer written out, its one reference the caller's.
     *
     * @param {number} out @param {any} object
     * @returns {number} the HRESULT
     */
    const give = (out, object)=>{
        const pointer = host.vtables?.publish(object, object.clsid) ?? 0;
        if (pointer === 0)
        {
            object.release();
            putU32s(out, [0]);
            return E_OUTOFMEMORY;
        }
        putU32s(out, [pointer]);
        return S_OK;
    };

    return { u32, putU32s, u64, putU64, f64, putF64, guidAt, putGuid, wide, double, guidOf,
        wideString, encodeWide, taskCopy, sayOnce, guest, ownAt, releaseOwn, addRef, release,
        settle, query, make, give, mine };
}

/** @typedef {ReturnType<typeof createMfKit>} MfKit */
