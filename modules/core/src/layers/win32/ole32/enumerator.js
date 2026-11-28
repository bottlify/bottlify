/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * The IEnumXXX objects OLE hands out over a list it fixed when asked: the
 * formats a data object offers, a class's verbs, the sinks an advise holder
 * holds. Every one of them has the same four methods after IUnknown's, the
 * same contract for each, and differs only in the element it writes -- so
 * the contract is written once, here.
 *
 * The list is a snapshot. A clone shares it and starts where its original
 * stands, and what the snapshot holds (a reference on each sink) is let go
 * of when the last enumerator over it goes, not the first.
 */

const S_OK = 0;
const S_FALSE = 1;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;

/**
 * What an enumerator needs of ole32: making one of its own objects and
 * putting it in guest memory.
 *
 * @typedef {Object} EnumeratorEnv
 * @property {import('../common/guest.js').Guest} guest  the guest's memory at the process's width
 * @property {(clsid: string, definition: import('./objects.js').ComClassDefinition)
 *     => import('./objects.js').ComObject | null} makeObject
 * @property {(object: import('./objects.js').ComObject, iid: string) => number} publish
 * @property {() => unknown} callerThread
 */

/**
 * One kind of enumerator: the private class its objects are made under, the
 * interface it answers to and how many bytes one element takes.
 *
 * @typedef {Object} EnumeratorKind
 * @property {string} clsid
 * @property {string} iid
 * @property {number} size
 * @property {boolean} [skipNothingEnds]
 *           Skip(0) answers S_FALSE and leaves nothing to enumerate, as
 *           Windows' property set enumerator does (stg_prop.c
 *           test_propertyset_storage_enum).
 */

/**
 * @template T
 * @typedef {Object} Snapshot
 * @property {readonly T[]} items
 * @property {(at: number, item: T, thread: unknown) => boolean | Promise<boolean>} write
 *           Lays one element down at `at`; false when what it needs (a string
 *           of task memory) cannot be had.
 * @property {() => unknown} [release]  Told when the last enumerator over it goes.
 */

/**
 * Makes an enumerator over `snapshot` and hands it out through `out`. When
 * none can be made the snapshot is released at once, so a caller that took
 * references for it has nothing left to give back.
 *
 * @template T
 * @param {EnumeratorEnv} env @param {EnumeratorKind} kind @param {Snapshot<T>} snapshot
 * @param {number} out
 * @returns {number} an HRESULT
 */
export function publishEnumerator(env, kind, snapshot, out){
    const shared = { snapshot, users: 0 };
    return publishOver(env, kind, shared, 0, out);
}

/**
 * @template T
 * @param {EnumeratorEnv} env @param {EnumeratorKind} kind
 * @param {{ snapshot: Snapshot<T>, users: number, released?: boolean }} shared
 * @param {number} start @param {number} out
 * @returns {number}
 */
function publishOver(env, kind, shared, start, out){
    const { guest } = env;
    const { items } = shared.snapshot;
    let position = start;
    const object = env.makeObject(kind.clsid, {
        interfaces: [{
            id: kind.iid,
            methods: [
                {
                    name: 'Next', argBytes: 16,
                    // A NULL count is allowed only for one element, where
                    // the answer alone says whether it came.
                    invoke: async(_self, [celt, rgelt, fetched])=>{
                        const wanted = wholeAddress(celt);
                        if ((rgelt >>> 0) === 0 || ((fetched >>> 0) === 0 && wanted !== 1))
                        {
                            return E_INVALIDARG;
                        }
                        const thread = env.callerThread();
                        let count = 0;
                        while (count < wanted && position < items.length)
                        {
                            if (!(await shared.snapshot.write((rgelt >>> 0) + count * kind.size,
                                items[position], thread)))
                            {
                                if ((fetched >>> 0) !== 0)
                                {
                                    guest.set32(fetched, count);
                                }
                                return E_OUTOFMEMORY;
                            }
                            position++;
                            count++;
                        }
                        if ((fetched >>> 0) !== 0)
                        {
                            guest.set32(fetched, count);
                        }
                        return count === wanted ? S_OK : S_FALSE;
                    },
                },
                {
                    name: 'Skip', argBytes: 8,
                    invoke: (_self, [celt])=>{
                        if ((celt >>> 0) > items.length - position
                            || ((celt >>> 0) === 0 && kind.skipNothingEnds))
                        {
                            position = items.length;
                            return S_FALSE;
                        }
                        position += celt >>> 0;
                        return S_OK;
                    },
                },
                {
                    name: 'Reset', argBytes: 4,
                    invoke: ()=>{
                        position = 0;
                        return S_OK;
                    },
                },
                {
                    name: 'Clone', argBytes: 8,
                    invoke: (_self, [ppenum])=>{
                        if ((ppenum >>> 0) === 0)
                        {
                            return E_INVALIDARG;
                        }
                        guest.set32(ppenum, 0);
                        return publishOver(env, kind, shared, position, ppenum >>> 0);
                    },
                },
            ],
        }],
        // What the snapshot holds of the program's goes inside the last
        // enumerator's Release, which the program waits on.
        lastRelease: async()=>{
            if (shared.users === 1 && !shared.released)
            {
                shared.released = true;
                await shared.snapshot.release?.();
            }
        },
        destroy: ()=>{
            shared.users--;
            if (shared.users === 0 && !shared.released)
            {
                shared.released = true;
                shared.snapshot.release?.();
            }
        },
    });
    if (!object)
    {
        if (shared.users === 0)
        {
            shared.snapshot.release?.();
        }
        return E_OUTOFMEMORY;
    }
    shared.users++;
    const pointer = env.publish(object, kind.iid);
    if (pointer === 0)
    {
        object.release();
        return E_OUTOFMEMORY;
    }
    guest.set32(out, pointer);
    return S_OK;
}
