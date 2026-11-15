/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * shlwapi's helpers over a program's own COM objects: each is a few method
 * calls through the object's vtable, made as guest calls on the thread that
 * asked. Among them the references a thread and the process hold to keep
 * someone alive - a thread's, and Explorer's, which a shell extension's
 * worker takes to keep its host from ending under it.
 */

import { IID_IUNKNOWN, IUNKNOWN_METHODS } from '../ole32/objects.js';

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;

/** The vtable slots these call: IUnknown's three, then IServiceProvider's one. */
const SLOT_QUERY_INTERFACE = 0;
const SLOT_ADD_REF = 1;
const SLOT_RELEASE = 2;
const SLOT_QUERY_SERVICE = 3;

/** IID_IServiceProvider, {6d5140c1-7436-11ce-8034-00aa006009fa}, as the structure holds it. */
const IID_ISERVICEPROVIDER = Uint8Array.from([
    0xc1, 0x40, 0x51, 0x6d, 0x36, 0x74, 0xce, 0x11,
    0x80, 0x34, 0x00, 0xaa, 0x00, 0x60, 0x09, 0xfa,
]);

/** The ordinals these are exported by (Wine's shlwapi.spec). */
export const UNKNOWN_ORDINALS = Object.freeze({ 169: 'IUnknown_AtomicRelease',
    176: 'IUnknown_QueryService', 199: 'IUnknown_Set' });

/**
 * @typedef {Object} UnknownHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {(entry: number, args: number[], thread: unknown) => Promise<number> | number} call
 *           A guest function called with these arguments on that thread.
 * @property {() => unknown} callerThread  The thread whose call this is.
 * @property {(object: any, iid: string) => number} [publish]  An object of the
 *           engine's own as the interface pointer a program is handed, 0 when
 *           none can be published.
 */

/** @param {Uint8Array} bytes */
const u32 = bytes=>(bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/** @param {UnknownHost} host */
export function createUnknownFunctions(host){
    /**
     * A method of an object, `this` first, as a COM method takes it.
     *
     * @param {number} object @param {number} slot @param {number[]} args @param {unknown} thread
     */
    const callMethod = async(object, slot, args, thread)=>{
        const entry = u32(host.readMemory(u32(host.readMemory(object, 4)) + slot * 4, 4));
        return (await host.call(entry, [object, ...args], thread)) | 0;
    };

    /** @param {number} at */
    const readLong = at=>new DataView(host.readMemory(at, 4).slice().buffer).getInt32(0, true);

    /** The reference each thread was given to hold (SHSetThreadRef). @type {Map<unknown, number>} */
    const threadReferences = new Map();
    /** The one the process holds (SetProcessReference); 0 for none. */
    let processReference = 0;

    /**
     * Hands out a reference someone holds, one more on it for the caller:
     * E_INVALIDARG with nowhere to put it, the absent answer with none held.
     *
     * @param {number} held @param {number} out @param {number} absent
     */
    const handOut = async(held, out, absent)=>{
        if ((out >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        host.writeMemory(out >>> 0, dword(held));
        if (held === 0)
        {
            return absent;
        }
        await callMethod(held, SLOT_ADD_REF, [], host.callerThread());
        return S_OK;
    };

    return {
        /**
         * void IUnknown_AtomicRelease(IUnknown **ppunk)
         *
         * The pointer cleared first and the object released after, so nothing
         * that runs while it goes finds it still there.
         */
        IUnknown_AtomicRelease: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([slot])=>{
                const object = (slot >>> 0) === 0 ? 0 : u32(host.readMemory(slot >>> 0, 4));
                if (object !== 0)
                {
                    host.writeMemory(slot >>> 0, dword(0));
                    await callMethod(object, SLOT_RELEASE, [], host.callerThread());
                }
                return 0;
            },
        },

        /**
         * void IUnknown_Set(IUnknown **ppunk, IUnknown *punk)
         *
         * The slot takes the new object, a reference added, and lets the old
         * one go after.
         */
        IUnknown_Set: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([slot, object])=>{
                const thread = host.callerThread();
                const old = u32(host.readMemory(slot >>> 0, 4));
                if (old === (object >>> 0))
                {
                    return 0;
                }
                if ((object >>> 0) !== 0)
                {
                    await callMethod(object >>> 0, SLOT_ADD_REF, [], thread);
                }
                host.writeMemory(slot >>> 0, dword(object >>> 0));
                if (old !== 0)
                {
                    await callMethod(old, SLOT_RELEASE, [], thread);
                }
                return 0;
            },
        },

        /**
         * HRESULT SHCreateThreadRef(LONG *pcRef, IUnknown **ppunk)
         *
         * An object whose count is the caller's LONG: set to one, raised and
         * lowered by AddRef and Release, which answer it, so the thread that
         * owns the LONG sees when the last holder let go.
         */
        SHCreateThreadRef: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([count, out])=>{
                if ((count >>> 0) === 0 || (out >>> 0) === 0)
                {
                    if ((out >>> 0) !== 0)
                    {
                        host.writeMemory(out >>> 0, dword(0));
                    }
                    return E_INVALIDARG;
                }
                if (!host.publish)
                {
                    host.writeMemory(out >>> 0, dword(0));
                    return E_OUTOFMEMORY;
                }
                host.writeMemory(count >>> 0, dword(1));
                const at = count >>> 0;
                const object = {
                    state: null,
                    /** @param {string} asked */
                    interfaceFor: asked=>(asked === IID_IUNKNOWN
                        ? { id: asked, methods: IUNKNOWN_METHODS } : null),
                    addRef(){
                        const next = readLong(at) + 1;
                        host.writeMemory(at, dword(next));
                        return next;
                    },
                    release(){
                        const next = readLong(at) - 1;
                        host.writeMemory(at, dword(next));
                        return Math.max(next, 0);
                    },
                    get refCount(){
                        return readLong(at);
                    },
                    get destroyed(){
                        return readLong(at) <= 0;
                    },
                };
                const pointer = host.publish(object, IID_IUNKNOWN) >>> 0;
                host.writeMemory(out >>> 0, dword(pointer));
                return pointer === 0 ? E_OUTOFMEMORY : S_OK;
            },
        },

        /**
         * HRESULT SHSetThreadRef(IUnknown *punk)
         *
         * The reference the calling thread holds, kept as it is given - no
         * reference added; NULL clears it.
         */
        SHSetThreadRef: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([object])=>{
                threadReferences.set(host.callerThread(), object >>> 0);
                return S_OK;
            },
        },

        /**
         * HRESULT SHGetThreadRef(IUnknown **ppunk)
         *
         * The calling thread's reference with one more on it, or NULL and
         * E_NOINTERFACE when it holds none.
         */
        SHGetThreadRef: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>handOut(threadReferences.get(host.callerThread()) ?? 0, out,
                E_NOINTERFACE),
        },

        /**
         * HRESULT SHReleaseThreadRef(void)
         *
         * The calling thread's reference released and forgotten; E_FAIL when
         * it holds none.
         */
        SHReleaseThreadRef: {
            argBytes: 0,
            handler: async()=>{
                const thread = host.callerThread();
                const held = threadReferences.get(thread) ?? 0;
                threadReferences.delete(thread);
                if (held === 0)
                {
                    return E_FAIL;
                }
                await callMethod(held, SLOT_RELEASE, [], thread);
                return S_OK;
            },
        },

        /**
         * void SetProcessReference(IUnknown *punk)
         *
         * The reference the process holds - Explorer's in Explorer - kept as
         * it is given; shell32's SHSetInstanceExplorer.
         */
        SetProcessReference: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([object])=>{
                processReference = object >>> 0;
                return 0;
            },
        },

        /**
         * HRESULT GetProcessReference(IUnknown **ppunk)
         *
         * The process's reference with one more on it; E_FAIL and NULL until
         * one was set, which in a process that is not Explorer is every time
         * unless the program set its own. shell32's SHGetInstanceExplorer.
         */
        GetProcessReference: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>handOut(processReference, out, E_FAIL),
        },

        /**
         * HRESULT IUnknown_QueryService(IUnknown *punk, REFGUID guidService,
         *   REFIID riid, void **ppvOut)
         *
         * The object's IServiceProvider asked for the service, and let go
         * after: whatever QueryInterface or QueryService answers is the
         * answer, and E_FAIL with no object or nowhere to put one, NULL
         * written first wherever there is somewhere, as Wine's conformance
         * tests have it.
         */
        IUnknown_QueryService: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([object, service, interfaceId, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_FAIL;
                }
                host.writeMemory(out >>> 0, dword(0));
                if ((object >>> 0) === 0)
                {
                    return E_FAIL;
                }
                const thread = host.callerThread();
                const block = host.allocate(IID_ISERVICEPROVIDER.length + 4);
                if (block === 0)
                {
                    return E_OUTOFMEMORY;
                }
                try
                {
                    host.writeMemory(block, IID_ISERVICEPROVIDER);
                    const slot = block + IID_ISERVICEPROVIDER.length;
                    host.writeMemory(slot, dword(0));
                    const asked = await callMethod(object >>> 0, SLOT_QUERY_INTERFACE,
                        [block, slot], thread);
                    const provider = u32(host.readMemory(slot, 4));
                    if (asked !== S_OK || provider === 0)
                    {
                        return asked;
                    }
                    const answer = await callMethod(provider, SLOT_QUERY_SERVICE,
                        [service >>> 0, interfaceId >>> 0, out >>> 0], thread);
                    await callMethod(provider, SLOT_RELEASE, [], thread);
                    return answer;
                }
                finally
                {
                    host.free(block);
                }
            },
        },
    };
}
