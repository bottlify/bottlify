/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Media Foundation's asynchronous results and the work queues that call a
 * program back with one.
 *
 * An IMFAsyncResult made here is an MFASYNCRESULT, as Microsoft documents
 * it: the interface pointer is the start of a structure whose fields after
 * the vtable pointer (an OVERLAPPED, the callback, the status, the bytes
 * transferred, an event) a program reads and writes itself, so the status
 * lives in guest memory and GetStatus answers what is there. A callback is
 * invoked on a thread of the platform's own, never on the caller's, in the
 * order the work was put: IMFAsyncCallback::Invoke with the result, the
 * result held until the call returns.
 */

import { E_INVALIDARG, E_POINTER, S_OK, drive } from './kit.js';
import { wholeAddress } from '../common/pointers.js';

const IID_IMFASYNCRESULT = '{AC6B7889-0740-4D51-8619-905994A55CC6}';

/** MFASYNCRESULT's offsets in a 32-bit process. */
const FIELD = Object.freeze({ CALLBACK: 24, STATUS: 28, BYTES: 32, EVENT: 36, SIZE: 40 });
/** IMFAsyncCallback::Invoke, after IUnknown's three and GetParameters. */
const INVOKE_SLOT = 4;
const MF_E_INVALID_WORKQUEUE = 0xc00d36ff | 0;
/** The first id MFAllocateWorkQueue hands out, past the standard queues' (0 to 6). */
const FIRST_QUEUE = 0x10000;

/**
 * @typedef {Object} AsyncHost
 * @property {{ deliver: (entry: number, args: number[], done?: () => void) => void }}
 *     [notices]  The thread a callback is invoked on.
 */

/**
 * @param {import('./kit.js').MfKit} kit
 * @param {import('./kit.js').MfHost & AsyncHost} host
 */
export function createAsync(kit, host){
    const { u32, putU32s } = kit;
    /** Work queues MFAllocateWorkQueue made, with their lock counts. */
    /** @type {Map<number, number>} */
    const queues = new Map();
    let nextQueue = FIRST_QUEUE;

    /** @param {any} object @returns {number} where the structure lies */
    const at = object=>host.vtables?.publish(object, IID_IMFASYNCRESULT) ?? 0;

    /** @param {number} pointer @param {number} out @returns {number | Promise<number>} */
    const handOut = (pointer, out)=>{
        if ((out >>> 0) === 0)
        {
            return E_POINTER;
        }
        if (pointer === 0)
        {
            return E_POINTER;
        }
        // A foreign object's AddRef is a call into the guest, made before the
        // method answers.
        return drive((function* (){
            yield kit.addRef(pointer, host.callerThread?.());
            putU32s(out, [pointer]);
            return S_OK;
        })());
    };

    /** @type {import('../ole32/objects.js').ComMethod[]} */
    const methods = [
        { name: 'GetState', argBytes: 8, invoke: (object, [out])=>
            handOut(/** @type {any} */ (object).state.state, out) },
        { name: 'GetStatus', argBytes: 4, invoke: object=>u32(at(object) + FIELD.STATUS) | 0 },
        { name: 'SetStatus', argBytes: 8, invoke: (object, [status])=>{
            putU32s(at(object) + FIELD.STATUS, [status]);
            return S_OK;
        } },
        { name: 'GetObject', argBytes: 8, invoke: (object, [out])=>
            handOut(/** @type {any} */ (object).state.object, out) },
        { name: 'GetStateNoAddRef', argBytes: 4, invoke: object=>
            /** @type {any} */ (object).state.state >>> 0 },
    ];
    const asyncResult = { id: IID_IMFASYNCRESULT, methods };

    /**
     * MFCreateAsyncResult's work: a result holding a reference on each of
     * the three, its structure written once it has an address.
     *
     * @param {number} object @param {number} callback @param {number} state
     * @returns {{ made: any, pointer: number, held: (number | Promise<number> | void)[] } | null}
     *     `held` the AddRefs made on the three, to be waited for before answering
     */
    const create = (object, callback, state)=>{
        const thread = host.callerThread?.();
        const held = [object, callback, state].map(pointer=>pointer >>> 0);
        const made = kit.make({
            primary: asyncResult,
            state: { object: held[0], callback: held[1], state: held[2] },
            destroy: ()=>{
                for (const pointer of held)
                {
                    void kit.release(pointer);
                }
            },
        });
        if (!made)
        {
            return null;
        }
        // The structure Microsoft documents goes on past the vtable pointer.
        /** @type {any} */ (made).bodyBytes = ()=>FIELD.SIZE;
        const refs = held.filter(pointer=>pointer !== 0)
            .map(pointer=>kit.addRef(pointer, thread));
        const pointer = at(made);
        if (pointer !== 0)
        {
            putU32s(pointer + FIELD.CALLBACK, [held[1], S_OK, 0, 0]);
        }
        return { made, pointer, held: refs };
    };

    /**
     * Calls the result's callback back on the platform's thread, the result
     * held until Invoke returns.
     *
     * @param {number} result @returns {number}
     */
    const invoke = result=>{
        const callback = u32(wholeAddress(result) + FIELD.CALLBACK);
        if ((result >>> 0) === 0 || callback === 0)
        {
            return E_INVALIDARG;
        }
        if (!host.notices)
        {
            kit.sayOnce('MFInvokeCallback', 'no platform thread to call the program back on');
            return E_INVALIDARG;
        }
        kit.addRef(result, host.callerThread?.());
        const entry = u32(u32(callback) + INVOKE_SLOT * 4);
        host.notices.deliver(entry, [callback, result >>> 0], ()=>{
            void kit.release(result >>> 0);
        });
        return S_OK;
    };

    return {
        create,
        invoke,
        /** @returns {number} a new queue's id */
        allocateQueue: ()=>{
            const id = nextQueue++;
            queues.set(id, 1);
            return id;
        },
        /** @param {number} id @param {number} by  +1 to lock, -1 to unlock @returns {number} */
        lockQueue: (id, by)=>{
            const count = queues.get(id >>> 0);
            if (count === undefined)
            {
                // The standard queues are always there and never go.
                return (id >>> 0) < FIRST_QUEUE ? S_OK : MF_E_INVALID_WORKQUEUE;
            }
            if (count + by <= 0)
            {
                queues.delete(id >>> 0);
            }
            else
            {
                queues.set(id >>> 0, count + by);
            }
            return S_OK;
        },
    };
}
