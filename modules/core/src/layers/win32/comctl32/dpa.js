/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * comctl32's data structures and memory: the dynamic pointer array (DPA_*),
 * the dynamic structure array (DSA_*), the shell's allocator (Alloc,
 * ReAlloc, Free, GetSize) and the string slots (Str_GetPtr, Str_SetPtr).
 *
 * The arrays live in guest memory in the layout the SDK's macros read
 * directly - DPA_GetPtrCount and DSA_GetItemCount take the first int,
 * DPA_FastGetPtr the pointer block after it - so a program that reads them
 * inline sees what the calls see. Every call reads the array where it is,
 * since a sort's comparator or an enumeration's callback may change it
 * through the same calls. The memory comes from kernel32, as comctl32's own
 * does on Windows: the arrays from the heap a DPA was made on (the process
 * heap unless DPA_CreateEx names one), the allocator through LocalAlloc.
 *
 * A 64-bit process's arrays are its own layout: the pointer fields and the
 * DPA's slots eight bytes wide, an int beside a pointer padded to it, as the
 * SDK's structures are for x86-64.
 */

import { stableSort } from './stable-sort.js';
import { pointerWidth, wholeAddress } from '../common/pointers.js';
import { WHOLE } from '../common/guest.js';
import { struct } from '../../../system/layout.js';

/**
 * @typedef {Object} DataHost
 * @property {import('../common/guest.js').Guest} guest  the guest's memory at the process's width
 * @property {(name: string) => ((args: number[]) => any) | undefined} [kernel32]
 *           kernel32's handlers, looked up when called.
 * @property {(entry: number, args: (number | bigint)[], thread?: unknown)
 *     => number | Promise<number>} [call]
 * @property {() => unknown} [callerThread]
 */

/**
 * The arrays' fields. DPA: count, the pointer block, its heap, how many slots
 * it has, how many it grows by. DSA: count, the item block, how many items it
 * has room for, an item's size, the growth.
 */
const DPA_LAYOUT = struct([['COUNT', 'i32'], ['PTRS', 'ptr'], ['HEAP', 'handle'],
    ['CAPACITY', 'i32'], ['GROW', 'i32']]);
const DSA_LAYOUT = struct([['COUNT', 'i32'], ['ITEMS', 'ptr'], ['CAPACITY', 'i32'],
    ['ITEM_SIZE', 'i32'], ['GROW', 'i32']]);

/** @param {4 | 8} pointer */
const layoutOf = pointer=>({ DPA: DPA_LAYOUT.at(pointer), DSA: DSA_LAYOUT.at(pointer) });

const DPA_APPEND = 0x7fffffff;
const DPA_ERR = -1;
const DPAS_SORTED = 0x1;
const DPAS_INSERTBEFORE = 0x2;
const DPAS_INSERTAFTER = 0x4;
const DPAM_SORTED = 0x1;
const DPAM_NORMAL = 0x2;
const DPAM_UNION = 0x4;
const DPAM_INTERSECT = 0x8;
const DPAMM_MERGE = 1;
const DPAMM_DELETE = 2;
const DPAMM_INSERT = 3;
/** DPA_LoadStream's header: its size, the format (always 1), the number of items. */
const STREAM_HEADER = 12;
const STREAM_FORMAT = 1;

const HEAP_ZERO_MEMORY = 0x8;
const LMEM_MOVEABLE = 0x2;
const LMEM_ZEROINIT = 0x40;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;

/** IStream's methods, by their place in the vtable. */
const ISTREAM_READ = 3;
const ISTREAM_WRITE = 4;
const ISTREAM_SEEK = 5;
const STREAM_SEEK_SET = 0;
const STREAM_SEEK_CUR = 1;

/**
 * The ordinals these exports have in the 5.82 library. The allocator and the
 * string slots are exported by number alone, named here as the engine names
 * such an export.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const DATA_ORDINALS = Object.freeze({
    9: 'DPA_LoadStream', 10: 'DPA_SaveStream', 11: 'DPA_Merge',
    71: '#71', 72: '#72', 73: '#73', 74: '#74',
    233: '#233', 234: '#234', 235: '#235', 236: '#236',
    320: 'DSA_Create', 321: 'DSA_Destroy', 322: 'DSA_GetItem', 323: 'DSA_GetItemPtr',
    324: 'DSA_InsertItem', 325: 'DSA_SetItem', 326: 'DSA_DeleteItem', 327: 'DSA_DeleteAllItems',
    328: 'DPA_Create', 329: 'DPA_Destroy', 330: 'DPA_Grow', 331: 'DPA_Clone', 332: 'DPA_GetPtr',
    333: 'DPA_GetPtrIndex', 334: 'DPA_InsertPtr', 335: 'DPA_SetPtr', 336: 'DPA_DeletePtr',
    337: 'DPA_DeleteAllPtrs', 338: 'DPA_Sort', 339: 'DPA_Search', 340: 'DPA_CreateEx',
    385: 'DPA_EnumCallback', 386: 'DPA_DestroyCallback', 387: 'DSA_EnumCallback',
    388: 'DSA_DestroyCallback',
});

/** @param {DataHost} host */
export function createDataStructureFunctions(host){
    const { guest } = host;
    /** A pointer's bytes: a DPA's slot, a pointer field. */
    const P = guest.pointerSize;
    const { DPA, DSA } = layoutOf(P);
    /** @param {string} name @param {number[]} args */
    const kernel = (name, args)=>{
        const handler = host.kernel32?.(name);
        if (!handler)
        {
            throw new Error(`comctl32: kernel32!${name} is not there to take memory from`);
        }
        return handler(args);
    };
    const processHeap = ()=>wholeAddress(kernel('GetProcessHeap', []));
    /** DPASTREAMINFO: the item's place, and the item, a pointer after it. */
    const INFO_SIZE = 2 * P;
    const call = (/** @type {number} */ entry, /** @type {(number | bigint)[]} */ args)=>
        /** @type {NonNullable<DataHost['call']>} */ (host.call)(entry >>> 0, args,
            host.callerThread?.());

    // The DPA in guest memory, read and written a field at a time.
    const count = (/** @type {number} */ dpa)=>guest.u32(dpa + DPA.COUNT) | 0;
    const ptrs = (/** @type {number} */ dpa)=>guest.ptr(dpa + DPA.PTRS);
    const item = (/** @type {number} */ dpa, /** @type {number} */ index)=>
        guest.ptr(ptrs(dpa) + index * P);
    const setItem = (/** @type {number} */ dpa, /** @type {number} */ index,
        /** @type {number} */ value)=>
        guest.setPtr(ptrs(dpa) + index * P, value);
    /** @param {number} dpa @returns {number[]} */
    const items = dpa=>{
        const base = ptrs(dpa);
        return Array.from({ length: count(dpa) }, (_, i)=>guest.ptr(base + i * P));
    };
    /** @param {number} dpa @param {number[]} values */
    const writeItems = (dpa, values)=>{
        const base = values.length > 0 ? ptrs(dpa) : 0;
        values.forEach((value, i)=>guest.setPtr(base + i * P, value));
    };

    /**
     * Room for at least `slots` pointers, in whole steps of the array's growth,
     * from its own heap. False, with ERROR_NOT_ENOUGH_MEMORY, when the heap has
     * no more.
     *
     * @param {number} dpa @param {number} slots
     */
    const reserve = (dpa, slots)=>{
        const capacity = guest.u32(dpa + DPA.CAPACITY) | 0;
        if (slots <= capacity)
        {
            return true;
        }
        const grow = Math.max(1, guest.u32(dpa + DPA.GROW) | 0);
        const wanted = Math.ceil(slots / grow) * grow;
        const heap = guest.ptr(dpa + DPA.HEAP);
        const old = ptrs(dpa);
        const block = wholeAddress(old === 0
            ? kernel('HeapAlloc', [heap, HEAP_ZERO_MEMORY, wanted * P])
            : kernel('HeapReAlloc', [heap, HEAP_ZERO_MEMORY, old, wanted * P]));
        if (block === 0)
        {
            kernel('SetLastError', [ERROR_NOT_ENOUGH_MEMORY]);
            return false;
        }
        guest.setPtr(dpa + DPA.PTRS, block);
        guest.set32(dpa + DPA.CAPACITY, wanted);
        return true;
    };

    /** @param {number} grow @param {number} heap */
    const createDpa = (grow, heap)=>{
        const on = wholeAddress(heap) || processHeap();
        const dpa = wholeAddress(kernel('HeapAlloc', [on, HEAP_ZERO_MEMORY, DPA.SIZE]));
        if (dpa === 0)
        {
            return 0;
        }
        guest.setPtr(dpa + DPA.HEAP, on);
        // A growth of nothing would never grow; the library's own default is eight.
        guest.set32(dpa + DPA.GROW, (grow | 0) > 0 ? grow | 0 : 8);
        return dpa;
    };

    /** @param {number} dpa */
    const destroyDpa = dpa=>{
        if (dpa === 0)
        {
            return 0;
        }
        const heap = guest.ptr(dpa + DPA.HEAP);
        const block = ptrs(dpa);
        if (block !== 0)
        {
            kernel('HeapFree', [heap, 0, block]);
        }
        return kernel('HeapFree', [heap, 0, dpa]) ? 1 : 0;
    };

    /** @param {number} dpa @param {number} index @param {number} value */
    const insert = (dpa, index, value)=>{
        if (dpa === 0 || (index | 0) < 0)
        {
            return DPA_ERR;
        }
        const n = count(dpa);
        const at = Math.min(index | 0, n);
        if (!reserve(dpa, n + 1))
        {
            return DPA_ERR;
        }
        const values = items(dpa);
        values.splice(at, 0, wholeAddress(value));
        writeItems(dpa, values);
        guest.set32(dpa + DPA.COUNT, n + 1);
        return at;
    };

    /** @param {number} dpa @param {number} index */
    const remove = (dpa, index)=>{
        const n = count(dpa);
        if (dpa === 0 || (index | 0) < 0 || (index | 0) >= n)
        {
            return 0;
        }
        const values = items(dpa);
        const [removed] = values.splice(index | 0, 1);
        writeItems(dpa, values);
        guest.set32(dpa + DPA.COUNT, n - 1);
        return removed;
    };

    /**
     * The array sorted by the program's comparator, called with two items
     * and the program's word; equal items keep their order.
     *
     * @param {number} dpa @param {number} compare @param {number} lParam
     */
    const sort = async(dpa, compare, lParam)=>{
        if (dpa === 0 || compare === 0)
        {
            return 0;
        }
        writeItems(dpa, await stableSort(items(dpa), (a, b)=>call(compare, [a, b, lParam])));
        return 1;
    };

    // DSA, the same way.
    const dsaCount = (/** @type {number} */ dsa)=>guest.u32(dsa + DSA.COUNT) | 0;
    const dsaSize = (/** @type {number} */ dsa)=>guest.u32(dsa + DSA.ITEM_SIZE);
    const dsaItem = (/** @type {number} */ dsa, /** @type {number} */ index)=>
        guest.ptr(dsa + DSA.ITEMS) + index * dsaSize(dsa);
    /** @param {number} dsa @param {number} slots */
    const dsaReserve = (dsa, slots)=>{
        const capacity = guest.u32(dsa + DSA.CAPACITY) | 0;
        if (slots <= capacity)
        {
            return true;
        }
        const grow = Math.max(1, guest.u32(dsa + DSA.GROW) | 0);
        const wanted = Math.ceil(slots / grow) * grow;
        const old = guest.ptr(dsa + DSA.ITEMS);
        const heap = processHeap();
        const bytes = wanted * dsaSize(dsa);
        const block = wholeAddress(old === 0
            ? kernel('HeapAlloc', [heap, HEAP_ZERO_MEMORY, bytes])
            : kernel('HeapReAlloc', [heap, HEAP_ZERO_MEMORY, old, bytes]));
        if (block === 0)
        {
            kernel('SetLastError', [ERROR_NOT_ENOUGH_MEMORY]);
            return false;
        }
        guest.setPtr(dsa + DSA.ITEMS, block);
        guest.set32(dsa + DSA.CAPACITY, wanted);
        return true;
    };
    /** @param {number} dsa */
    const destroyDsa = dsa=>{
        if (dsa === 0)
        {
            return 0;
        }
        const heap = processHeap();
        const block = guest.ptr(dsa + DSA.ITEMS);
        if (block !== 0)
        {
            kernel('HeapFree', [heap, 0, block]);
        }
        return kernel('HeapFree', [heap, 0, dsa]) ? 1 : 0;
    };
    /**
     * Calls the program's callback with each item until it answers zero; the
     * count is read again each time, as the callback may change the array.
     *
     * @param {(index: number) => number} at @param {() => number} size
     * @param {number} callback @param {number} data
     */
    const enumerate = async(at, size, callback, data)=>{
        if (callback === 0)
        {
            return;
        }
        for (let index = 0; index < size(); index++)
        {
            if (((await call(callback, [at(index), data])) | 0) === 0)
            {
                return;
            }
        }
    };

    /** @param {number} address @param {boolean} wide */
    const stringLength = (address, wide)=>guest.stringBytes(address, wide, WHOLE).length
        / (wide ? 2 : 1);
    /**
     * Str_GetPtrA/W: the string's length with its terminator, or what fitted, terminator counted.
     */
    const strGetPtr = (/** @type {boolean} */ wide)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([source, dest, size])=>{
            const unit = wide ? 2 : 1;
            const cch = size | 0;
            if (source >>> 0 === 0)
            {
                if (dest >>> 0 !== 0 && cch > 0)
                {
                    guest.fill(dest, 0, unit);
                }
                return 0;
            }
            const length = stringLength(source, wide);
            if (dest >>> 0 === 0 || cch <= 0)
            {
                return length + 1;
            }
            const copied = Math.min(length, cch - 1);
            guest.copy(dest, source, copied * unit);
            guest.fill(dest + copied * unit, 0, unit);
            return copied + 1;
        },
    });
    /** Str_SetPtrA/W: the slot holds its own copy of the string, or nothing for NULL. */
    const strSetPtr = (/** @type {boolean} */ wide)=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([slot, source])=>{
            const unit = wide ? 2 : 1;
            const old = guest.ptr(slot);
            if (source >>> 0 === 0)
            {
                if (old !== 0)
                {
                    kernel('LocalFree', [old]);
                }
                guest.setPtr(slot, 0);
                return 1;
            }
            const bytes = (stringLength(source, wide) + 1) * unit;
            const block = old === 0
                ? kernel('LocalAlloc', [LMEM_ZEROINIT, bytes]) >>> 0
                : kernel('LocalReAlloc', [old, bytes, LMEM_ZEROINIT | LMEM_MOVEABLE]) >>> 0;
            if (block === 0)
            {
                return 0;
            }
            guest.copy(block, source, bytes);
            guest.setPtr(slot, block);
            return 1;
        },
    });

    /** IStream::Read, Write or Seek on the program's stream. */
    const stream = {
        /** @param {number} stm @param {number} method @param {(number | bigint)[]} rest */
        invoke: async(stm, method, rest)=>{
            const vtable = guest.ptr(stm);
            return (await call(guest.ptr(vtable + method * P), [stm, ...rest])) | 0;
        },
        /** @param {number} stm @param {number} origin @param {number} offset */
        seek: async(stm, offset, origin, scratch = 0)=>
            stream.invoke(stm, ISTREAM_SEEK,
                [...pointerWidth(P).quadword(offset), origin, scratch]),
    };
    /** A guest block the stream calls write into, from the process heap. */
    const scratch = (/** @type {number} */ bytes)=>kernel('HeapAlloc', [processHeap(),
        HEAP_ZERO_MEMORY, bytes]) >>> 0;
    const release = (/** @type {number} */ block)=>kernel('HeapFree', [processHeap(), 0, block]);

    return {
        /** HDPA DPA_Create(int cpGrow) */
        DPA_Create: { returns: 'pointer', argBytes: 4, handler: (/** @type {number[]} */ [grow])=>createDpa(grow, 0) },

        /** HDPA DPA_CreateEx(int cpGrow, HANDLE hheap) */
        DPA_CreateEx: { returns: 'pointer', argBytes: 8, handler: (/** @type {number[]} */ [grow, heap])=>
            createDpa(grow, heap) },

        /** BOOL DPA_Destroy(HDPA hdpa) */
        DPA_Destroy: { argBytes: 4, handler: (/** @type {number[]} */ [dpa])=>
            destroyDpa(dpa >>> 0) },

        /** BOOL DPA_Grow(HDPA hdpa, int cp) - room for that many pointers. */
        DPA_Grow: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [dpa, slots])=>
                dpa >>> 0 !== 0 && reserve(dpa >>> 0, slots | 0) ? 1 : 0,
        },

        /** HDPA DPA_Clone(const HDPA hdpaSource, HDPA hdpaNew) - into hdpaNew, or a new one. */
        DPA_Clone: {
            returns: 'pointer',
            argBytes: 8,
            handler: (/** @type {number[]} */ [source, into])=>{
                if (source >>> 0 === 0)
                {
                    return 0;
                }
                const target = into >>> 0
                    || createDpa(guest.u32(source + DPA.GROW),
                        guest.ptr(source + DPA.HEAP));
                if (target === 0)
                {
                    return 0;
                }
                const values = items(source >>> 0);
                if (!reserve(target, values.length))
                {
                    if (into >>> 0 === 0)
                    {
                        destroyDpa(target);
                    }
                    return 0;
                }
                writeItems(target, values);
                guest.set32(target + DPA.COUNT, values.length);
                return target;
            },
        },

        /** void *DPA_GetPtr(HDPA hdpa, INT_PTR i) - NULL past either end. */
        DPA_GetPtr: {
            returns: 'pointer',
            argBytes: 8,
            handler: (/** @type {number[]} */ [dpa, index])=>
                dpa >>> 0 !== 0 && (index | 0) >= 0 && (index | 0) < count(dpa >>> 0)
                    ? item(dpa >>> 0, index | 0) : 0,
        },

        /** int DPA_GetPtrIndex(HDPA hdpa, const void *p) */
        DPA_GetPtrIndex: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [dpa, pointer])=>
                dpa >>> 0 === 0 ? DPA_ERR : items(wholeAddress(dpa)).indexOf(wholeAddress(pointer)),
        },

        /** int DPA_InsertPtr(HDPA hdpa, int i, void *p) - past the end (or DPA_APPEND) appends. */
        DPA_InsertPtr: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [dpa, index, pointer])=>
                insert(dpa >>> 0, (index | 0) === DPA_APPEND ? 0x7fffffff : index, pointer),
        },

        /**
         * BOOL DPA_SetPtr(HDPA hdpa, int i, void *p) - past the end, the gap is filled with NULL.
         */
        DPA_SetPtr: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [handle, index, pointer])=>{
                const dpa = wholeAddress(handle);
                if (dpa === 0 || (index | 0) < 0)
                {
                    return 0;
                }
                if ((index | 0) >= count(dpa))
                {
                    if (!reserve(dpa, (index | 0) + 1))
                    {
                        return 0;
                    }
                    const values = items(dpa);
                    while (values.length <= (index | 0))
                    {
                        values.push(0);
                    }
                    guest.set32(dpa + DPA.COUNT, values.length);
                    writeItems(dpa, values);
                }
                setItem(dpa, index | 0, wholeAddress(pointer));
                return 1;
            },
        },

        /** void *DPA_DeletePtr(HDPA hdpa, int i) - the pointer removed, NULL past either end. */
        DPA_DeletePtr: {
            returns: 'pointer',
            argBytes: 8,
            handler: (/** @type {number[]} */ [dpa, index])=>remove(dpa >>> 0, index),
        },

        /** BOOL DPA_DeleteAllPtrs(HDPA hdpa) - empty, its slots given back. */
        DPA_DeleteAllPtrs: {
            argBytes: 4,
            handler: (/** @type {number[]} */ [handle])=>{
                const dpa = wholeAddress(handle);
                if (dpa === 0)
                {
                    return 0;
                }
                const block = ptrs(dpa);
                if (block !== 0)
                {
                    kernel('HeapFree', [guest.ptr(dpa + DPA.HEAP), 0, block]);
                }
                guest.setPtr(dpa + DPA.PTRS, 0);
                guest.set32(dpa + DPA.CAPACITY, 0);
                guest.set32(dpa + DPA.COUNT, 0);
                return 1;
            },
        },

        /** BOOL DPA_Sort(HDPA hdpa, PFNDPACOMPARE pfnCompare, LPARAM lParam) */
        DPA_Sort: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [dpa, compare, lParam])=>sort(dpa >>> 0,
                wholeAddress(compare), lParam),
        },

        /**
         * int DPA_Search(HDPA hdpa, void *pFind, int iStart, PFNDPACOMPARE pfnCompare,
         *                LPARAM lParam, UINT options)
         *
         * A linear search from iStart; a sorted array's is binary and from the
         * start, and with DPAS_INSERTBEFORE or DPAS_INSERTAFTER answers where
         * the item would go when it is not there.
         */
        DPA_Search: {
            argBytes: 24,
            handler: async(/** @type {number[]} */ [handle, find, start, compare, lParam,
                options])=>{
                const dpa = wholeAddress(handle);
                if (dpa === 0 || wholeAddress(compare) === 0)
                {
                    return DPA_ERR;
                }
                const values = items(dpa);
                if (options & DPAS_SORTED)
                {
                    let low = 0;
                    let high = values.length - 1;
                    while (low <= high)
                    {
                        const middle = (low + high) >> 1;
                        const order = (await call(compare, [find, values[middle], lParam])) | 0;
                        if (order === 0)
                        {
                            return middle;
                        }
                        if (order < 0)
                        {
                            high = middle - 1;
                        }
                        else
                        {
                            low = middle + 1;
                        }
                    }
                    return options & (DPAS_INSERTBEFORE | DPAS_INSERTAFTER) ? low : DPA_ERR;
                }
                for (let index = Math.max(0, start | 0); index < values.length; index++)
                {
                    if (((await call(compare, [find, values[index], lParam])) | 0) === 0)
                    {
                        return index;
                    }
                }
                return DPA_ERR;
            },
        },

        /**
         * BOOL DPA_Merge(HDPA hdpaDest, HDPA hdpaSrc, DWORD dwFlags, PFNDPACOMPARE pfnCompare,
         *                PFNDPAMERGE pfnMerge, LPARAM lParam)
         *
         * Both arrays sorted (unless DPAM_SORTED says they are), then walked
         * together from their ends: an item in both is merged (DPAMM_MERGE, its
         * answer replacing the destination's); one only in the destination is
         * deleted under DPAM_INTERSECT or DPAM_NORMAL (DPAMM_DELETE told after);
         * one only in the source is inserted under DPAM_UNION or DPAM_NORMAL
         * (DPAMM_INSERT answering what goes in). A merge or an insertion that
         * answers NULL stops the merge, FALSE.
         */
        DPA_Merge: {
            argBytes: 24,
            handler: async(/** @type {number[]} */ [destHandle, sourceHandle, flags, compare,
                merge, lParam])=>{
                const dest = wholeAddress(destHandle);
                const source = wholeAddress(sourceHandle);
                if (dest === 0 || source === 0 || wholeAddress(compare) === 0
                    || wholeAddress(merge) === 0)
                {
                    return 0;
                }
                if (!(flags & DPAM_SORTED))
                {
                    await sort(dest, wholeAddress(compare), lParam);
                    await sort(source, wholeAddress(compare), lParam);
                }
                const deleting = (flags & (DPAM_INTERSECT | DPAM_NORMAL)) !== 0;
                const inserting = (flags & (DPAM_UNION | DPAM_NORMAL)) !== 0;
                const from = items(source);
                let d = count(dest) - 1;
                let s = from.length - 1;
                while (d >= 0 || s >= 0)
                {
                    const order = d < 0 ? -1 : s < 0 ? 1
                        : (await call(wholeAddress(compare), [item(dest, d), from[s], lParam])) | 0;
                    if (order === 0)
                    {
                        const merged = (await call(wholeAddress(merge), [DPAMM_MERGE, item(dest, d),
                            from[s], lParam])) >>> 0;
                        if (merged === 0)
                        {
                            return 0;
                        }
                        setItem(dest, d, merged);
                        d--;
                        s--;
                    }
                    else if (order > 0)
                    {
                        // Only in the destination.
                        if (deleting)
                        {
                            const removed = remove(dest, d);
                            await call(wholeAddress(merge), [DPAMM_DELETE, removed, 0, lParam]);
                        }
                        d--;
                    }
                    else
                    {
                        // Only in the source: it goes after the destination's item at d.
                        if (inserting)
                        {
                            const added = (await call(wholeAddress(merge), [DPAMM_INSERT, from[s],
                                0,
                                lParam])) >>> 0;
                            if (added === 0)
                            {
                                return 0;
                            }
                            if (insert(dest, d + 1, added) === DPA_ERR)
                            {
                                return 0;
                            }
                        }
                        s--;
                    }
                }
                return 1;
            },
        },

        /** void DPA_EnumCallback(HDPA hdpa, PFNDAENUMCALLBACK pfnCB, void *pData) */
        DPA_EnumCallback: {
            argBytes: 12,
            handler: async(/** @type {number[]} */ [dpa, callback, data])=>{
                if (dpa >>> 0 !== 0)
                {
                    await enumerate(index=>item(dpa >>> 0, index), ()=>count(dpa >>> 0),
                        wholeAddress(callback), data);
                }
                return 0;
            },
        },

        /** void DPA_DestroyCallback(HDPA hdpa, PFNDAENUMCALLBACK pfnCB, void *pData) */
        DPA_DestroyCallback: {
            argBytes: 12,
            handler: async(/** @type {number[]} */ [dpa, callback, data])=>{
                if (dpa >>> 0 !== 0)
                {
                    await enumerate(index=>item(dpa >>> 0, index), ()=>count(dpa >>> 0),
                        wholeAddress(callback), data);
                    destroyDpa(dpa >>> 0);
                }
                return 0;
            },
        },

        /**
         * HRESULT DPA_SaveStream(HDPA hdpa, PFNDPASTREAM pfn, IStream *pstm, void *pvInstData)
         *
         * A header (its size, format 1, the number of items) and then whatever
         * the callback writes for each item, told the item and its place; the
         * header is written again at the end with what was written.
         */
        DPA_SaveStream: {
            argBytes: 16,
            handler: async(/** @type {number[]} */ [handle, pfn, stm, data])=>{
                const dpa = wholeAddress(handle);
                if (dpa === 0 || wholeAddress(pfn) === 0 || wholeAddress(stm) === 0)
                {
                    return E_INVALIDARG;
                }
                const block = scratch(8 + INFO_SIZE + STREAM_HEADER);
                if (block === 0)
                {
                    return E_OUTOFMEMORY;
                }
                const position = block;
                const info = block + 8;
                const header = info + INFO_SIZE;
                try
                {
                    let result = await stream.seek(wholeAddress(stm), 0, STREAM_SEEK_CUR, position);
                    if (result < 0)
                    {
                        return result;
                    }
                    const start = guest.u32(position);
                    result = await stream.invoke(wholeAddress(stm), ISTREAM_WRITE, [header,
                        STREAM_HEADER, 0]);
                    if (result < 0)
                    {
                        return result;
                    }
                    let saved = 0;
                    for (; saved < count(dpa); saved++)
                    {
                        guest.set32(info, saved);
                        guest.setPtr(info + P, item(dpa, saved));
                        result = (await call(wholeAddress(pfn), [info, stm, data])) | 0;
                        if (result < 0)
                        {
                            break;
                        }
                    }
                    await stream.seek(wholeAddress(stm), 0, STREAM_SEEK_CUR, position);
                    const end = guest.u32(position);
                    guest.set32(header, end - start);
                    guest.set32(header + 4, STREAM_FORMAT);
                    guest.set32(header + 8, saved);
                    await stream.seek(wholeAddress(stm), start, STREAM_SEEK_SET);
                    await stream.invoke(wholeAddress(stm), ISTREAM_WRITE, [header, STREAM_HEADER,
                        0]);
                    await stream.seek(wholeAddress(stm), end, STREAM_SEEK_SET);
                    return result < 0 ? result : S_OK;
                }
                finally
                {
                    release(block);
                }
            },
        },

        /**
         * HRESULT DPA_LoadStream(HDPA *phdpa, PFNDPASTREAM pfn, IStream *pstm, void *pvInstData)
         *
         * The header DPA_SaveStream writes, and the callback told each place to
         * read an item for. A short header puts the stream back where it was;
         * one of another format is refused, both E_FAIL.
         */
        DPA_LoadStream: {
            argBytes: 16,
            handler: async(/** @type {number[]} */ [out, pfn, stm, data])=>{
                if (wholeAddress(out) === 0 || wholeAddress(pfn) === 0 || wholeAddress(stm) === 0)
                {
                    return E_INVALIDARG;
                }
                const block = scratch(8 + INFO_SIZE + STREAM_HEADER + 4);
                if (block === 0)
                {
                    return E_OUTOFMEMORY;
                }
                const position = block;
                const info = block + 8;
                const header = info + INFO_SIZE;
                const got = header + STREAM_HEADER;
                try
                {
                    await stream.seek(wholeAddress(stm), 0, STREAM_SEEK_CUR, position);
                    const start = guest.u32(position);
                    let result = await stream.invoke(wholeAddress(stm), ISTREAM_READ, [header,
                        STREAM_HEADER, got]);
                    if (result < 0 || guest.u32(got) < STREAM_HEADER)
                    {
                        await stream.seek(wholeAddress(stm), start, STREAM_SEEK_SET);
                        return result < 0 ? result : E_FAIL;
                    }
                    if (guest.u32(header + 4) !== STREAM_FORMAT)
                    {
                        return E_FAIL;
                    }
                    const total = guest.u32(header + 8) | 0;
                    const dpa = createDpa(Math.max(total, 1), 0);
                    if (dpa === 0 || !reserve(dpa, total))
                    {
                        return E_OUTOFMEMORY;
                    }
                    result = S_OK;
                    let loaded = 0;
                    for (; loaded < total; loaded++)
                    {
                        guest.set32(info, loaded);
                        guest.setPtr(info + P, 0);
                        result = (await call(wholeAddress(pfn), [info, stm, data])) | 0;
                        if (result < 0)
                        {
                            break;
                        }
                        setItem(dpa, loaded, guest.ptr(info + P));
                    }
                    guest.set32(dpa + DPA.COUNT, loaded);
                    guest.setPtr(out, dpa);
                    return result < 0 ? result : S_OK;
                }
                finally
                {
                    release(block);
                }
            },
        },

        /** HDSA DSA_Create(int cbItem, int cItemGrow) */
        DSA_Create: {
            returns: 'pointer',
            argBytes: 8,
            handler: (/** @type {number[]} */ [size, grow])=>{
                if ((size | 0) <= 0)
                {
                    return 0;
                }
                const dsa = wholeAddress(kernel('HeapAlloc', [processHeap(), HEAP_ZERO_MEMORY,
                    DSA.SIZE]));
                if (dsa !== 0)
                {
                    guest.set32(dsa + DSA.ITEM_SIZE, size | 0);
                    guest.set32(dsa + DSA.GROW, (grow | 0) > 0 ? grow | 0 : 8);
                }
                return dsa;
            },
        },

        /** BOOL DSA_Destroy(HDSA hdsa) */
        DSA_Destroy: { argBytes: 4, handler: (/** @type {number[]} */ [dsa])=>
            destroyDsa(dsa >>> 0) },

        /** BOOL DSA_GetItem(HDSA hdsa, int i, void *pitem) - copied out. */
        DSA_GetItem: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [handle, index, dest])=>{
                const dsa = wholeAddress(handle);
                if (dsa === 0 || wholeAddress(dest) === 0 || (index | 0) < 0
                    || (index | 0) >= dsaCount(dsa))
                {
                    return 0;
                }
                guest.copy(dest, dsaItem(dsa, index | 0), dsaSize(dsa));
                return 1;
            },
        },

        /** void *DSA_GetItemPtr(HDSA hdsa, int i) */
        DSA_GetItemPtr: {
            returns: 'pointer',
            argBytes: 8,
            handler: (/** @type {number[]} */ [handle, index])=>{
                const dsa = wholeAddress(handle);
                return dsa !== 0 && (index | 0) >= 0 && (index | 0) < dsaCount(dsa)
                    ? dsaItem(dsa, index | 0) : 0;
            },
        },

        /**
         * int DSA_InsertItem(HDSA hdsa, int i, const void *pitem) - a copy, past the end appended.
         */
        DSA_InsertItem: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [handle, index, source])=>{
                const dsa = wholeAddress(handle);
                if (dsa === 0 || (index | 0) < 0 || wholeAddress(source) === 0)
                {
                    return DPA_ERR;
                }
                const n = dsaCount(dsa);
                const at = Math.min(index | 0, n);
                if (!dsaReserve(dsa, n + 1))
                {
                    return DPA_ERR;
                }
                const size = dsaSize(dsa);
                if (at < n)
                {
                    guest.copy(dsaItem(dsa, at + 1), dsaItem(dsa, at), (n - at) * size);
                }
                guest.copy(dsaItem(dsa, at), source, size);
                guest.set32(dsa + DSA.COUNT, n + 1);
                return at;
            },
        },

        /**
         * BOOL DSA_SetItem(HDSA hdsa, int i, const void *pitem) - past the end, the array grows to
         * it.
         */
        DSA_SetItem: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [handle, index, source])=>{
                const dsa = wholeAddress(handle);
                if (dsa === 0 || (index | 0) < 0 || wholeAddress(source) === 0)
                {
                    return 0;
                }
                if ((index | 0) >= dsaCount(dsa))
                {
                    if (!dsaReserve(dsa, (index | 0) + 1))
                    {
                        return 0;
                    }
                    guest.set32(dsa + DSA.COUNT, (index | 0) + 1);
                }
                guest.copy(dsaItem(dsa, index | 0), source, dsaSize(dsa));
                return 1;
            },
        },

        /** BOOL DSA_DeleteItem(HDSA hdsa, int i) */
        DSA_DeleteItem: {
            argBytes: 8,
            handler: (/** @type {number[]} */ [handle, index])=>{
                const dsa = wholeAddress(handle);
                const n = dsa === 0 ? 0 : dsaCount(dsa);
                if (dsa === 0 || (index | 0) < 0 || (index | 0) >= n)
                {
                    return 0;
                }
                const size = dsaSize(dsa);
                if ((index | 0) < n - 1)
                {
                    guest.copy(dsaItem(dsa, index | 0), dsaItem(dsa, (index | 0) + 1),
                        (n - 1 - (index | 0)) * size);
                }
                guest.set32(dsa + DSA.COUNT, n - 1);
                return 1;
            },
        },

        /** BOOL DSA_DeleteAllItems(HDSA hdsa) */
        DSA_DeleteAllItems: {
            argBytes: 4,
            handler: (/** @type {number[]} */ [handle])=>{
                const dsa = wholeAddress(handle);
                if (dsa === 0)
                {
                    return 0;
                }
                const block = guest.ptr(dsa + DSA.ITEMS);
                if (block !== 0)
                {
                    kernel('HeapFree', [processHeap(), 0, block]);
                }
                guest.setPtr(dsa + DSA.ITEMS, 0);
                guest.set32(dsa + DSA.CAPACITY, 0);
                guest.set32(dsa + DSA.COUNT, 0);
                return 1;
            },
        },

        /**
         * void DSA_EnumCallback(HDSA hdsa, PFNDAENUMCALLBACK pfnCB, void *pData) - each item's
         * address.
         */
        DSA_EnumCallback: {
            argBytes: 12,
            handler: async(/** @type {number[]} */ [dsa, callback, data])=>{
                if (dsa >>> 0 !== 0)
                {
                    await enumerate(index=>dsaItem(dsa >>> 0, index), ()=>dsaCount(dsa >>> 0),
                        wholeAddress(callback), data);
                }
                return 0;
            },
        },

        /** void DSA_DestroyCallback(HDSA hdsa, PFNDAENUMCALLBACK pfnCB, void *pData) */
        DSA_DestroyCallback: {
            argBytes: 12,
            handler: async(/** @type {number[]} */ [dsa, callback, data])=>{
                if (dsa >>> 0 !== 0)
                {
                    await enumerate(index=>dsaItem(dsa >>> 0, index), ()=>dsaCount(dsa >>> 0),
                        wholeAddress(callback), data);
                    destroyDsa(dsa >>> 0);
                }
                return 0;
            },
        },

        /** LPVOID Alloc(DWORD cb) - #71: zeroed, from LocalAlloc as the library's own memory is. */
        '#71': {
            returns: 'pointer',
            argBytes: 4,
            handler: (/** @type {number[]} */ [bytes])=>wholeAddress(kernel('LocalAlloc', [LMEM_ZEROINIT,
                bytes >>> 0])),
        },

        /** LPVOID ReAlloc(LPVOID lpSrc, DWORD cb) - #72: NULL is a new block; the growth zeroed. */
        '#72': {
            returns: 'pointer',
            argBytes: 8,
            handler: (/** @type {number[]} */ [block, bytes])=>wholeAddress(block >>> 0 === 0
                ? kernel('LocalAlloc', [LMEM_ZEROINIT, bytes >>> 0])
                : kernel('LocalReAlloc', [wholeAddress(block), bytes >>> 0,
                    LMEM_ZEROINIT | LMEM_MOVEABLE])),
        },

        /** BOOL Free(LPVOID lpMem) - #73: NULL is nothing to free, TRUE. */
        '#73': {
            argBytes: 4,
            handler: (/** @type {number[]} */ [block])=>
                block >>> 0 === 0 || kernel('LocalFree', [wholeAddress(block)]) >>> 0 === 0 ? 1 : 0,
        },

        /** DWORD GetSize(LPVOID lpMem) - #74: what the block was asked for. */
        '#74': {
            argBytes: 4,
            handler: (/** @type {number[]} */ [block])=>kernel('LocalSize', [block >>> 0]) >>> 0,
        },

        /** INT Str_GetPtrA(LPCSTR, LPSTR, INT) - #233 */
        '#233': strGetPtr(false),
        /** BOOL Str_SetPtrA(LPSTR *, LPCSTR) - #234 */
        '#234': strSetPtr(false),
        /** INT Str_GetPtrW(LPCWSTR, LPWSTR, INT) - #235 */
        '#235': strGetPtr(true),
        /** BOOL Str_SetPtrW(LPWSTR *, LPCWSTR) - #236 */
        '#236': strSetPtr(true),
    };
}
