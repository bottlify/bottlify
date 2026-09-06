/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The ole32 surface a program touches before it can ask for an interface:
 * entering an apartment, asking a class for an object, the task allocator, and
 * the conversions between a GUID and its string.
 *
 * Two things about this file decide whether anything built on it works.
 *
 * Everything here returns an HRESULT, which is not a BOOL and not an error code:
 * zero is success, and both success and failure carry more than one value. A
 * program written as `if (FAILED(hr))` reads the top bit, so S_FALSE is a
 * success it will proceed from -- which is exactly why the second CoInitialize
 * on a thread has to return S_FALSE rather than S_OK, and why the matching
 * CoUninitialize count has to be right.
 *
 * And an out-parameter is zeroed on every failure. Programs check the pointer
 * rather than the HRESULT more often than they should, and one that keeps
 * whatever was on the stack is a pointer they will call through.
 *
 * The vtable itself is not built here. `host.vtables.publish` turns an interface
 * into an address in guest memory; that is marshaling, and marshaling belongs to
 * the bridge.
 */

import { GUID_NULL, GUID_SIZE, GUID_STRING_LENGTH, readGuid, writeGuid } from './guid.js';

/** HRESULTs this file produces. */
const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_NOINTERFACE = 0x80004002;
const E_POINTER = 0x80004003;
const E_OUTOFMEMORY = 0x8007000e;
const E_INVALIDARG = 0x80070057;
const RPC_E_CHANGED_MODE = 0x80010106;
const CLASS_E_NOAGGREGATION = 0x80040110;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111;
const REGDB_E_CLASSNOTREG = 0x80040154;
const CO_E_NOTINITIALIZED = 0x800401f0;
const CO_E_CLASSSTRING = 0x800401f3;

/**
 * The apartment models. COINIT_MULTITHREADED is zero, so the model is one bit
 * and the rest of dwCoInit (COINIT_DISABLE_OLE1DDE, COINIT_SPEED_OVER_MEMORY)
 * says nothing about which apartment the thread joined.
 */
const COINIT_APARTMENTTHREADED = 0x2;

/**
 * @typedef {Object} OleHeap
 * @property {(bytes: number) => number} allocate  The address, or 0 if nothing fits.
 * @property {(address: number) => boolean} free
 * @property {(address: number) => { size: number } | null} block
 * @property {(address: number, bytes: number) => boolean} resize
 *           Whether the block can hold that many bytes where it already is.
 */

/**
 * @typedef {Object} OleHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => any} currentThread  The record apartment state hangs on.
 * @property {OleHeap} heap             Where task memory comes from.
 * @property {import('./objects.js').ComRegistry} registry
 * @property {{ publish: (object: import('./objects.js').ComObject,
 *                        interfaceId: string) => number }} vtables
 *           Puts an interface into guest memory and answers with the interface
 *           pointer, or 0 if it cannot. It must answer with the same address for
 *           the same object and interface every time: a program compares the
 *           IUnknown it got through two interfaces to decide whether they belong
 *           to one object, and two addresses for one interface fails that test
 *           however correct the object model underneath is.
 */

/**
 * Builds the function table: name -> { argBytes, handler }.
 *
 * All of these are stdcall, which is the bridge's default, so none of them says
 * so. `argBytes` is the size of the argument list the guest compiled against.
 *
 * @param {OleHost} host
 */
export function createOleFunctions(host){
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };

    /**
     * Reads an LPCOLESTR that is supposed to be a GUID. Only as far as a GUID
     * string can reach: a longer one is not one, and stopping there means a
     * missing terminator cannot walk off into whatever follows.
     *
     * @param {number} address
     * @returns {string}
     */
    const readOleString = address=>{
        const bytes = host.readMemory(address, (GUID_STRING_LENGTH + 1) * 2);
        const units = Math.min(GUID_STRING_LENGTH + 1, bytes.length >> 1);
        let text = '';
        for (let index = 0; index < units; index++)
        {
            const unit = bytes[index * 2] | (bytes[index * 2 + 1] << 8);
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };

    /** @param {number} address @param {string} text  Written with its terminator. */
    const writeOleString = (address, text)=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let index = 0; index < text.length; index++)
        {
            const unit = text.charCodeAt(index);
            bytes[index * 2] = unit & 0xff;
            bytes[index * 2 + 1] = (unit >>> 8) & 0xff;
        }
        host.writeMemory(address, bytes);
    };

    /**
     * CoInitialize and CoInitializeEx are the same call; the first one names the
     * model rather than taking it.
     *
     * @param {number} mode
     * @returns {number} an HRESULT
     */
    const enterApartment = mode=>{
        const thread = host.currentThread();
        const model = (mode & COINIT_APARTMENTTHREADED) !== 0 ? COINIT_APARTMENTTHREADED : 0;
        const apartment = thread.ole32;
        if (!apartment)
        {
            thread.ole32 = { model, depth: 1 };
            return S_OK;
        }
        if (apartment.model !== model)
        {
            // The thread stays in the apartment it is in, and the count is not
            // touched: this call failed, so no CoUninitialize answers for it.
            return RPC_E_CHANGED_MODE;
        }
        apartment.depth++;
        return S_FALSE;
    };

    /**
     * @param {number} guidPointer  Where a REFCLSID or REFIID argument points.
     * @returns {string | null}
     */
    const guidAt = guidPointer=>{
        const address = guidPointer >>> 0;
        return address === 0 ? null : readGuid(host, address);
    };

    return {
        /** HRESULT CoInitialize(LPVOID pvReserved) */
        CoInitialize: {
            argBytes: 4,
            // Documented as equivalent to CoInitializeEx with
            // COINIT_APARTMENTTHREADED, which is what makes the two nest together.
            handler: ()=>enterApartment(COINIT_APARTMENTTHREADED),
        },

        /** HRESULT CoInitializeEx(LPVOID pvReserved, DWORD dwCoInit) */
        CoInitializeEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, mode])=>enterApartment(mode >>> 0),
        },

        /** void CoUninitialize(void) */
        CoUninitialize: {
            argBytes: 0,
            handler: ()=>{
                const thread = host.currentThread();
                const apartment = thread.ole32;
                // Unbalanced on the other side: documented as something a
                // program must not do, and there is nothing to report it with.
                if (!apartment)
                {
                    return 0;
                }
                apartment.depth--;
                if (apartment.depth === 0)
                {
                    // Windows also releases what the apartment still holds. That
                    // needs per-apartment ownership, which nothing tracks yet, so
                    // an object outliving its apartment stays alive here.
                    thread.ole32 = null;
                }
                return 0;
            },
        },

        /**
         * HRESULT CoCreateInstance(REFCLSID rclsid, LPUNKNOWN pUnkOuter,
         *   DWORD dwClsContext, REFIID riid, LPVOID *ppv)
         *
         * dwClsContext is not consulted: every class here is in-process, and a
         * program asking for CLSCTX_LOCAL_SERVER gets the same object rather than
         * a failure it has no fallback for.
         */
        CoCreateInstance: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([classId, outer, , interfaceId, ppv])=>{
                const out = ppv >>> 0;
                if (out === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, 0);

                if (!host.currentThread().ole32)
                {
                    return CO_E_NOTINITIALIZED;
                }
                const clsid = guidAt(classId);
                const iid = guidAt(interfaceId);
                if (clsid === null || iid === null)
                {
                    return E_INVALIDARG;
                }
                if ((outer >>> 0) !== 0)
                {
                    // Aggregation makes the outer object's IUnknown the one this
                    // object answers with, and nothing here can do that. Saying
                    // so is the documented answer; succeeding would hand back an
                    // object whose identity is wrong.
                    return CLASS_E_NOAGGREGATION;
                }
                if (!host.registry.isRegistered(clsid))
                {
                    return REGDB_E_CLASSNOTREG;
                }

                const object = host.registry.create(clsid);
                if (!object)
                {
                    return CLASS_E_CLASSNOTAVAILABLE;
                }
                const record = object.queryInterface(iid);
                if (!record)
                {
                    object.release();
                    return E_NOINTERFACE;
                }

                const pointer = host.vtables.publish(object, iid) >>> 0;
                if (pointer === 0)
                {
                    object.release();
                    object.release();
                    return E_OUTOFMEMORY;
                }
                // The creation reference goes; what the guest holds is the one
                // QueryInterface took, so the object comes back with exactly one.
                object.release();
                writeU32(out, pointer);
                return S_OK;
            },
        },

        /** HRESULT CoCreateGuid(GUID *pguid) */
        CoCreateGuid: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pguid])=>{
                const address = pguid >>> 0;
                if (address === 0)
                {
                    return E_INVALIDARG;
                }
                const bytes = new Uint8Array(GUID_SIZE);
                crypto.getRandomValues(bytes);
                // Version 4, variant 1: the two fields a reader inspects to tell
                // a random GUID from one carrying a MAC address and a timestamp.
                // Data3 is little-endian, so its high byte is the eighth.
                bytes[7] = (bytes[7] & 0x0f) | 0x40;
                bytes[8] = (bytes[8] & 0x3f) | 0x80;
                host.writeMemory(address, bytes);
                return S_OK;
            },
        },

        /** LPVOID CoTaskMemAlloc(SIZE_T cb) */
        CoTaskMemAlloc: {
            argBytes: 4,
            /** @param {number[]} args */
            // A zero-byte request still yields a pointer that is not NULL, which
            // is what the caller tests for.
            handler: ([bytes])=>host.heap.allocate(bytes >>> 0),
        },

        /** void CoTaskMemFree(LPVOID pv) */
        CoTaskMemFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const address = pointer >>> 0;
                // Documented as a no-op for NULL, so wrappers can pass it on.
                if (address !== 0)
                {
                    host.heap.free(address);
                }
                return 0;
            },
        },

        /** LPVOID CoTaskMemRealloc(LPVOID pv, SIZE_T cb) */
        CoTaskMemRealloc: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, size])=>{
                const address = pointer >>> 0;
                const wanted = size >>> 0;
                if (address === 0)
                {
                    return host.heap.allocate(wanted);
                }
                if (wanted === 0)
                {
                    // Documented: this frees the block and answers NULL, which is
                    // the one case where NULL is not a failure.
                    host.heap.free(address);
                    return 0;
                }
                const block = host.heap.block(address);
                if (!block)
                {
                    return 0;
                }
                if (host.heap.resize(address, wanted))
                {
                    return address;
                }
                const moved = host.heap.allocate(wanted);
                // On failure the original block is untouched, so a caller that
                // kept its pointer still owns its data.
                if (moved === 0)
                {
                    return 0;
                }
                const kept = Math.min(block.size, wanted);
                host.writeMemory(moved, host.readMemory(address, kept).slice());
                host.heap.free(address);
                return moved;
            },
        },

        /** int StringFromGUID2(REFGUID rguid, LPOLESTR lpsz, int cchMax) */
        StringFromGUID2: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([rguid, lpsz, cchMax])=>{
                const out = lpsz >>> 0;
                const guid = guidAt(rguid);
                // The count includes the terminator, so a buffer of exactly 38
                // characters is one short and nothing is written into it.
                if (guid === null || out === 0 || (cchMax | 0) <= GUID_STRING_LENGTH)
                {
                    return 0;
                }
                writeOleString(out, guid);
                return GUID_STRING_LENGTH + 1;
            },
        },

        /**
         * HRESULT CLSIDFromString(LPCOLESTR lpsz, LPCLSID pclsid)
         *
         * On Windows this also resolves a ProgID through the registry, which is
         * why its documented failure is CO_E_CLASSSTRING rather than E_INVALIDARG.
         * There is no ProgID registry here, so anything that is not a GUID string
         * fails that way -- the code a program branches on either way.
         *
         * A NULL string is not a failure: it yields CLSID_NULL and success, which
         * is the observable behaviour rather than anything the documentation says.
         */
        CLSIDFromString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([lpsz, pclsid])=>{
                const out = pclsid >>> 0;
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                writeGuid(host, out, GUID_NULL);
                if ((lpsz >>> 0) === 0)
                {
                    return S_OK;
                }
                return writeGuid(host, out, readOleString(lpsz >>> 0))
                    ? S_OK
                    : CO_E_CLASSSTRING;
            },
        },

        /**
         * HRESULT IIDFromString(LPCOLESTR lpsz, LPIID lpiid)
         *
         * The same conversion, but an interface is never named by a ProgID, so a
         * malformed string is simply a bad argument.
         */
        IIDFromString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([lpsz, lpiid])=>{
                const out = lpiid >>> 0;
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                writeGuid(host, out, GUID_NULL);
                if ((lpsz >>> 0) === 0)
                {
                    return S_OK;
                }
                return writeGuid(host, out, readOleString(lpsz >>> 0))
                    ? S_OK
                    : E_INVALIDARG;
            },
        },

        /**
         * BOOL IsEqualGUID(REFGUID rguid1, REFGUID rguid2)
         *
         * A BOOL, not an HRESULT: the SDK also has this as an inline comparison,
         * and code that calls the export expects the same 0 or 1. Windows would
         * fault on a NULL argument; answering FALSE keeps a guest bug from
         * becoming a host one.
         */
        IsEqualGUID: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, second])=>{
                const left = guidAt(first);
                const right = guidAt(second);
                return left !== null && left === right ? 1 : 0;
            },
        },
    };
}
