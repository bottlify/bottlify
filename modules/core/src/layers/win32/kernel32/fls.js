/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fibre-local storage: FlsAlloc, FlsFree, FlsGetValue and FlsSetValue.
 *
 * Each fiber has its own values, and a thread that runs no fiber is one for
 * this purpose: the running one's values are the block the thread block's
 * FlsSlots points at, made the first time a value is set, and SwitchToFiber
 * points it at the next fiber's (fibers.js); FlsAlloc makes its caller's
 * too. A block is a LIST_ENTRY and then
 * a pointer for each of the 128 indexes; index 0 is no index, 1 to 127 are
 * handed out, lowest first.
 *
 * The callback FlsAlloc takes is what makes the slots worth having: a C
 * runtime keeps a thread's data there and frees it in the callback. It is
 * called, on the calling thread, with each value still set: in every block
 * when FlsFree frees the index, in a fiber's block when DeleteFiber deletes
 * it, in a thread's when the thread ends (before its libraries are told),
 * and the value is cleared. A null value is not called back.
 *
 * FlsGetValue and FlsSetValue are called on every runtime call that reaches
 * its per-thread data, so both are guest code (`flsGetValueCode` and the rest):
 * an index out of range, or a fiber with no block yet, is handed to the
 * host, which answers ERROR_INVALID_PARAMETER for the first, and for a read
 * with no block (a new fiber's, as Windows answers it), and makes the block
 * for a value set. A thread gets its block when it starts once the process has
 * allocated an index (`threadStarts`), so its libraries' DLL_THREAD_ATTACH
 * reads NULL there. As on Windows, a value may be set and read at an index
 * nobody allocated, and success clears the last error on a read and leaves it
 * on a write.
 */

import { TEB, TEB64 } from './teb.js';
import { wholeAddress } from '../common/pointers.js';

/** FLS_MAXIMUM_AVAILABLE: indexes 1 to 127, 0 being none. */
const FLS_SLOTS = 128;
const FLS_OUT_OF_INDEXES = 0xffffffff;
const ERROR_SUCCESS = 0;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NO_MORE_ITEMS = 259;

/** @param {number} value @returns {number[]} */
const dword = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * FlsGetValue as i386: the value at the index in the running fiber's block,
 * the last error cleared; index 0, one past 127 or no block yet goes to the
 * host.
 *
 *     mov eax, [esp+4]; dec eax; cmp eax, 127; jae slow
 *     mov ecx, fs:[FlsSlots]; test ecx, ecx; jz slow
 *     mov dword fs:[LastError], 0; mov eax, [ecx+eax*4+12]; ret 4
 *     slow: jmp trap
 *
 * @param {number} at  Where the code lands. @param {number} trap
 */
export function flsGetValueCode(at, trap){
    const slow = 39;
    return Uint8Array.of(
        0x8b, 0x44, 0x24, 0x04, 0x48, 0x83, 0xf8, FLS_SLOTS - 1, 0x73, slow - 10,
        0x64, 0x8b, 0x0d, ...dword(TEB.FLS_SLOTS), 0x85, 0xc9, 0x74, slow - 21,
        0x64, 0xc7, 0x05, ...dword(TEB.LAST_ERROR), ...dword(0),
        0x8b, 0x44, 0x81, 0x0c, 0xc2, 0x04, 0x00,
        0xe9, ...dword(trap - (at + slow + 5)));
}

/**
 * FlsSetValue as i386: the value into the running fiber's block, the last
 * error left alone; what the read hands the host, this does too.
 *
 *     mov eax, [esp+4]; dec eax; cmp eax, 127; jae slow
 *     mov ecx, fs:[FlsSlots]; test ecx, ecx; jz slow
 *     mov edx, [esp+8]; mov [ecx+eax*4+12], edx; mov eax, 1; ret 8
 *     slow: jmp trap
 *
 * @param {number} at @param {number} trap
 */
export function flsSetValueCode(at, trap){
    const slow = 37;
    return Uint8Array.of(
        0x8b, 0x44, 0x24, 0x04, 0x48, 0x83, 0xf8, FLS_SLOTS - 1, 0x73, slow - 10,
        0x64, 0x8b, 0x0d, ...dword(TEB.FLS_SLOTS), 0x85, 0xc9, 0x74, slow - 21,
        0x8b, 0x54, 0x24, 0x08, 0x89, 0x54, 0x81, 0x0c,
        0xb8, ...dword(1), 0xc2, 0x08, 0x00,
        0xe9, ...dword(trap - (at + slow + 5)));
}

/**
 * FlsGetValue as x86-64, the index in ECX; its trap's rel32 is at `jump`.
 *
 *     lea eax, [rcx-1]; cmp eax, 127; jae slow
 *     mov rdx, gs:[FlsSlots]; test rdx, rdx; jz slow
 *     mov dword gs:[LastError], 0; mov rax, [rdx+rax*8+24]; ret
 *     slow: jmp trap
 */
export function flsGetValueLongCode(){
    const slow = 40;
    const code = Uint8Array.of(
        0x8d, 0x41, 0xff, 0x83, 0xf8, FLS_SLOTS - 1, 0x73, slow - 8,
        0x65, 0x48, 0x8b, 0x14, 0x25, ...dword(TEB64.FLS_SLOTS), 0x48, 0x85, 0xd2,
        0x74, slow - 22,
        0x65, 0xc7, 0x04, 0x25, ...dword(TEB64.LAST_ERROR), ...dword(0),
        0x48, 0x8b, 0x44, 0xc2, 0x18, 0xc3,
        0xe9, ...dword(0));
    return { code, jump: slow + 1 };
}

/**
 * FlsSetValue as x86-64, the index in ECX and the value in RDX.
 *
 *     lea eax, [rcx-1]; cmp eax, 127; jae slow
 *     mov r8, gs:[FlsSlots]; test r8, r8; jz slow
 *     mov [r8+rax*8+24], rdx; mov eax, 1; ret
 *     slow: jmp trap
 */
function flsSetValueLongCode(){
    const slow = 33;
    const code = Uint8Array.of(
        0x8d, 0x41, 0xff, 0x83, 0xf8, FLS_SLOTS - 1, 0x73, slow - 8,
        0x65, 0x4c, 0x8b, 0x04, 0x25, ...dword(TEB64.FLS_SLOTS), 0x4d, 0x85, 0xc0,
        0x74, slow - 22,
        0x49, 0x89, 0x54, 0xc0, 0x18, 0xb8, ...dword(1), 0xc3,
        0xe9, ...dword(0));
    return { code, jump: slow + 1 };
}

/**
 * @typedef {Object} FlsHost
 * @property {number} [pointerSize]  8 in a 64-bit process; absent, 4.
 * @property {(address: number) => number} readPointer
 * @property {(address: number, value: number) => void} writePointer
 * @property {() => number} teb  The calling thread's block.
 * @property {(bytes: number) => number} allocate  Guest memory, zeroed, or 0.
 * @property {(address: number) => void} free
 * @property {() => unknown} callerThread  The thread whose call is being answered,
 *           asked once, before any callback: after the first, another may be running.
 * @property {(entry: number, args: number[], thread: unknown) => unknown} call
 *           A guest routine called on that thread: a callback.
 * @property {(code: number) => void} setLastError
 * @property {(bytes: number) => number} [allocateCode]
 *           Room for the i386 fast paths; absent, the exports stay host calls.
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 */

/**
 * @param {FlsHost} host
 */
export function createFiberLocalStorage(host){
    const pointer = host.pointerSize === 8 ? 8 : 4;
    const slotsAt = host.pointerSize === 8 ? TEB64.FLS_SLOTS : TEB.FLS_SLOTS;
    /** Where index `i` lies in a block: past the LIST_ENTRY. @param {number} index */
    const slot = index=>2 * pointer + index * pointer;
    /** The callback of each allocated index, 0 for none. @type {Map<number, number>} */
    const allocated = new Map();
    /** Every block made and not yet released, a thread's or a fiber's. @type {Set<number>} */
    const blocks = new Set();

    /** The running fiber's block, 0 for none yet. */
    const current = ()=>{
        const teb = host.teb() >>> 0;
        return teb === 0 ? 0 : host.readPointer(teb + slotsAt);
    };

    /** @param {number} index */
    const inRange = index=>index >= 1 && index < FLS_SLOTS;

    /**
     * How the call being answered calls its callbacks: on its own thread,
     * named now, before the first callback lets another thread run.
     *
     * @returns {(entry: number, args: number[]) => unknown}
     */
    const callerCalls = ()=>{
        const thread = host.callerThread();
        return (entry, args)=>host.call(entry, args, thread);
    };

    /**
     * Each value of `block` with a callback, the callback called and the
     * value cleared: what a block's end, or an index's, does.
     *
     * @param {number} block @param {number[]} indexes
     * @param {(entry: number, args: number[]) => unknown} call
     */
    const callBack = async(block, indexes, call)=>{
        for (const index of indexes)
        {
            const value = host.readPointer(block + slot(index));
            const callback = allocated.get(index) ?? 0;
            if (value === 0)
            {
                continue;
            }
            host.writePointer(block + slot(index), 0);
            if (callback !== 0)
            {
                await call(callback, [value]);
            }
        }
    };

    /**
     * A block's values called back and the block let go: a fiber's when it
     * is deleted, a thread's running one when the thread ends. A thread's end
     * keeps the block (`keep`) while its libraries are told: Windows calls
     * the values back before DLL_THREAD_DETACH and DLL_PROCESS_DETACH and
     * frees the block after, so a DllMain reading FlsGetValue then gets NULL
     * and success (Wine's loader.c dll_entry_point); `forget` lets it go.
     *
     * @param {number} block
     * @param {{ call?: (entry: number, args: number[]) => unknown, teb?: number,
     *     keep?: boolean }} [ending]
     *     A thread's end: how its callbacks are called (it has no call of its own left
     *     to answer, so as the loader calls a DllMain), its thread block, named by
     *     the caller since another thread may be running once they have been, and
     *     whether the block stays until `forget`
     * @returns {Promise<void>}
     */
    const release = async(block, ending = {})=>{
        if (block === 0 || !blocks.has(block))
        {
            return;
        }
        const teb = ending.teb ?? host.teb() >>> 0;
        await callBack(block, [...allocated.keys()].sort((a, b)=>a - b),
            ending.call ?? callerCalls());
        if (!ending.keep)
        {
            forget(block, teb);
        }
    };

    /**
     * A block let go, its values already called back. FlsSlots left at the
     * freed block would hand whoever reads it next the heap's own links as
     * its data, so it is cleared where it still points there.
     *
     * @param {number} block @param {number} teb
     */
    const forget = (block, teb)=>{
        if (!blocks.has(block))
        {
            return;
        }
        if (teb !== 0 && host.readPointer(teb + slotsAt) === block)
        {
            host.writePointer(teb + slotsAt, 0);
        }
        blocks.delete(block);
        host.free(block);
    };

    /**
     * The running fiber's block, made when it has none: by the first value
     * set, and by FlsAlloc, which gives its caller one as Windows does. 0
     * when there is no memory.
     */
    const ownBlock = ()=>{
        const block = current();
        if (block !== 0)
        {
            return block;
        }
        const made = host.allocate(slot(FLS_SLOTS)) >>> 0;
        if (made !== 0)
        {
            blocks.add(made);
            host.writePointer(host.teb() + slotsAt, made);
        }
        return made;
    };

    const table = {
        /** DWORD FlsAlloc(PFLS_CALLBACK_FUNCTION lpCallback) */
        FlsAlloc: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([callback])=>{
                for (let index = 1; index < FLS_SLOTS; index++)
                {
                    if (!allocated.has(index))
                    {
                        if (ownBlock() === 0)
                        {
                            host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
                            return FLS_OUT_OF_INDEXES;
                        }
                        allocated.set(index, wholeAddress(callback));
                        // A new index reads as nothing in every fiber, whatever
                        // was left at it.
                        for (const block of blocks)
                        {
                            host.writePointer(block + slot(index), 0);
                        }
                        return index;
                    }
                }
                host.setLastError(ERROR_NO_MORE_ITEMS);
                return FLS_OUT_OF_INDEXES;
            },
        },

        /** BOOL FlsFree(DWORD dwFlsIndex) */
        FlsFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([index])=>{
                const at = index >>> 0;
                if (!allocated.has(at))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const call = callerCalls();
                return (async()=>{
                    for (const block of [...blocks])
                    {
                        await callBack(block, [at], call);
                    }
                    allocated.delete(at);
                    return 1;
                })();
            },
        },

        /** PVOID FlsGetValue(DWORD dwFlsIndex) */
        FlsGetValue: {
            returns: 'pointer',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([index])=>{
                const at = index >>> 0;
                const block = current();
                if (!inRange(at) || block === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                host.setLastError(ERROR_SUCCESS);
                return host.readPointer(block + slot(at));
            },
        },

        /** BOOL FlsSetValue(DWORD dwFlsIndex, PVOID lpFlsData) */
        FlsSetValue: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([index, value])=>{
                const at = index >>> 0;
                if (!inRange(at))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const block = ownBlock();
                if (block === 0)
                {
                    host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
                    return 0;
                }
                host.writePointer(block + slot(at), value);
                return 1;
            },
        },
    };

    /**
     * An i386 fast path placed in guest memory, its slow path the export's
     * own handler; 0 where there is no room, and the export is a host call.
     *
     * @param {(at: number, trap: number) => Uint8Array} make
     * @param {string} label @param {any} spec
     */
    const placed = (make, label, spec)=>(/** @type {any} */ builder)=>{
        const trap = builder.register(label, { argBytes: spec.argBytes, handler: spec.handler,
            returns: spec.returns });
        const size = make(0, trap).length;
        const at = host.allocateCode?.(size) ?? 0;
        if (at !== 0)
        {
            host.writeMemory?.(at, make(at, trap));
        }
        return at;
    };
    /**
     * The x86-64 fast path, its slow path the export's own trap.
     *
     * @param {() => { code: Uint8Array, jump: number }} make @param {any} spec
     */
    const long = (make, spec)=>(/** @type {any} */ builder)=>{
        const { code, jump } = make();
        builder.jump(jump, builder.register(spec));
        return code;
    };
    Object.assign(table.FlsGetValue, {
        guest: placed(flsGetValueCode, '<fls-get>', table.FlsGetValue),
        long: long(flsGetValueLongCode, table.FlsGetValue),
    });
    Object.assign(table.FlsSetValue, {
        guest: placed(flsSetValueCode, '<fls-set>', table.FlsSetValue),
        long: long(flsSetValueLongCode, table.FlsSetValue),
    });

    return {
        table,
        /** The running fiber's block, for SwitchToFiber to keep. */
        current,
        /**
         * Lets a fiber's or an ended thread's block go, its values called back.
         *
         * @param {number} block
         * @param {{ call?: (entry: number, args: number[]) => unknown, teb?: number,
         *     keep?: boolean }} [ending]
         */
        release,
        /**
         * Lets a block kept at a thread's end go, once its libraries are told.
         *
         * @param {number} block @param {number} teb
         */
        forget,
        /**
         * A thread starting, on itself, before its libraries hear of it: it
         * gets its block once the process has allocated an index, as a thread
         * Windows starts reads an allocated index as NULL and success in its
         * DLL_THREAD_ATTACH (Wine's loader.c dll_entry_point) where a new
         * fiber is refused (fiber.c FiberMainProc).
         */
        threadStarts: ()=>{
            if (allocated.size > 0)
            {
                ownBlock();
            }
        },
        /** Where FlsSlots is in this process's thread block. */
        slotsAt,
    };
}
