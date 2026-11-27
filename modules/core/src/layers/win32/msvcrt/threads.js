/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's threads: _beginthread and _beginthreadex, and the two ways a
 * thread they started ends.
 *
 * Both make the same thread CreateThread makes, through the same kernel
 * path, because that is what the real runtime does underneath; what differs
 * is the shape of the routine and who owns the handle. A `_beginthreadex`
 * routine is stdcall and returns the exit code, and its handle is the
 * caller's to close, as CreateThread's is. A `_beginthread` routine is cdecl
 * and returns nothing, and its handle is the runtime's: the thread starts in
 * the runtime's own start routine, which calls the program's and then
 * `_endthread`, and `_endthread` closes the handle of a thread `_beginthread`
 * made. A thread that ends by ExitThread or `_endthreadex` instead keeps its
 * handle open, as on Windows, where the caller may wait on it and close it.
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * @typedef {Object} ThreadSeam
 * @property {(request: { entry: number, stackSize: number, parameter: number,
 *             threadIdOut: number, flags: number }) => number} start
 *           Makes the thread, suspended when the flags say CREATE_SUSPENDED,
 *           and answers with its handle, writing its id where asked; zero
 *           when it cannot.
 * @property {(code: number) => any} exit
 *           Ends the calling thread with the code and answers with what the
 *           call must return, since the call does not come back.
 * @property {(milliseconds: number) => any} [sleep]
 *           Suspends the calling thread for that long, the way Sleep does,
 *           and answers with what the call must return meanwhile. Absent,
 *           `_sleep` stays unexported.
 * @property {ThreadRuntime} [runtime]
 *           Where `_beginthread`'s start routine and its block go. Absent, a
 *           `_beginthread` thread starts in its routine and its handle stays
 *           open whatever way it ends.
 */

/**
 * @typedef {Object} ThreadRuntime
 * @property {() => number} endthread  The address of the runtime's `_endthread`,
 *           0 while the runtime's image is not placed.
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {(bytes: number) => number} allocateCode
 * @property {import('../common/guest.js').Guest} guest  The process's memory: in
 *           an x86-64 one the start routine is in its convention
 *           (`longStartRoutine`) and the block's routine and argument are
 *           pointers of its width.
 * @property {(handle: number) => void} closeHandle
 * @property {() => number} currentThreadId
 */

/**
 * `_beginthread`'s start routine, the block it is handed holding the
 * program's routine, its argument, and the handle: the routine called with
 * its argument, then `_endthread`, which does not return.
 *
 *   mov eax, [esp+4]; push dword [eax+4]; call dword [eax]; add esp, 4
 *   mov eax, _endthread; call eax; int3
 *
 * @param {number} endthread
 */
const startRoutine = endthread=>Uint8Array.of(
    0x8b, 0x44, 0x24, 0x04, 0xff, 0x70, 0x04, 0xff, 0x10, 0x83, 0xc4, 0x04,
    0xb8, endthread & 0xff, endthread >>> 8 & 0xff, endthread >>> 16 & 0xff, endthread >>> 24,
    0xff, 0xd0, 0xcc);

/**
 * The same for an x86-64 process: the block in RCX, the stack eight past a
 * multiple of 16 as a function is entered; the routine, its argument and
 * `_endthread` are whole quadwords, where an image past 4 GiB - a 64-bit
 * program's at its own base - puts them.
 *
 *   sub rsp, 40; mov rax, rcx; mov rcx, [rax+8]; mov rax, [rax]; call rax
 *   mov rax, _endthread; call rax; int3
 *
 * @param {number} endthread
 */
const longStartRoutine = endthread=>{
    const code = Uint8Array.of(
        0x48, 0x83, 0xec, 0x28, 0x48, 0x89, 0xc8, 0x48, 0x8b, 0x48, 0x08, 0x48, 0x8b, 0x00,
        0xff, 0xd0, 0x48, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd0, 0xcc);
    const view = new DataView(code.buffer);
    view.setUint32(18, endthread % 2 ** 32, true);
    view.setUint32(22, Math.floor(endthread / 2 ** 32), true);
    return code;
};

/**
 * The block, at a pointer's width: routine, argument, then the handle and the
 * thread id as dwords.
 *
 * @param {4 | 8} pointer
 */
const blockOf = pointer=>Object.freeze({ ROUTINE: 0, ARGUMENT: pointer, HANDLE: pointer * 2,
    ID: pointer * 2 + 4, BYTES: pointer * 2 + 8 });

/**
 * @param {ThreadSeam} seam
 */
export function createThreadFunctions(seam){
    const { runtime } = seam;
    const BLOCK = blockOf(runtime?.guest.pointerSize ?? 4);

    /** `_beginthread`'s threads by id: the handle the runtime closes and the block. */
    const owned = /** @type {Map<number, { handle: number, block: number }>} */ (new Map());

    /** The start routine, made once; 0 where there is none to make. */
    let start = 0;
    const startAddress = ()=>{
        const endthread = runtime?.endthread() ?? 0;
        if (start === 0 && runtime && endthread !== 0)
        {
            const code = (runtime.guest.pointerSize === 8 ? longStartRoutine : startRoutine)(
                endthread);
            start = runtime.allocateCode(code.length);
            if (start !== 0)
            {
                runtime.guest.setBytes(start, code);
            }
        }
        return start;
    };

    /**
     * The calling thread's block let go of, if `_beginthread` made it: its
     * handle closed when the thread ends the runtime's way.
     *
     * @param {boolean} close
     */
    const release = close=>{
        if (!runtime)
        {
            return;
        }
        const id = runtime.currentThreadId();
        const entry = owned.get(id);
        if (!entry)
        {
            return;
        }
        owned.delete(id);
        if (close)
        {
            runtime.closeHandle(entry.handle);
        }
        runtime.free(entry.block);
    };

    /**
     * @param {number} argBytes
     * @param {(args: number[]) => number} handler
     */
    const cdecl = (argBytes, handler)=>({ convention: 'cdecl', argBytes, handler });

    return {
        /**
         * uintptr_t _beginthread(void(__cdecl *start)(void *), unsigned stackSize,
         *   void *argList)
         *
         * -1 when no thread could be made, which is what a caller tests for.
         */
        _beginthread: { ...cdecl(12, ([routine, stackSize, argument])=>{
            const entry = startAddress();
            const block = entry === 0 || !runtime ? 0 : runtime.allocate(BLOCK.BYTES);
            if (block === 0 || !runtime)
            {
                const handle = seam.start({
                    entry: wholeAddress(routine), stackSize: stackSize >>> 0,
                    parameter: wholeAddress(argument), threadIdOut: 0, flags: 0,
                });
                return handle === 0 ? -1 : handle;
            }
            runtime.guest.setPtr(block + BLOCK.ROUTINE, routine);
            runtime.guest.setPtr(block + BLOCK.ARGUMENT, argument);
            const handle = seam.start({
                entry, stackSize: stackSize >>> 0, parameter: block,
                threadIdOut: block + BLOCK.ID, flags: 0,
            });
            if (handle === 0)
            {
                runtime.free(block);
                return -1;
            }
            // Before the thread runs: CreateThread does not switch to it.
            runtime.guest.set32(block + BLOCK.HANDLE, handle);
            const id = runtime.guest.u32(block + BLOCK.ID);
            owned.set(id, { handle, block });
            return handle;
        }), returns: 'pointer' },

        /**
         * uintptr_t _beginthreadex(void *security, unsigned stackSize,
         *   unsigned(__stdcall *start)(void *), void *argList, unsigned initFlag,
         *   unsigned *threadId)
         *
         * Zero when no thread could be made. CREATE_SUSPENDED is CreateThread's:
         * the thread waits for ResumeThread.
         */
        _beginthreadex: { ...cdecl(24, ([, stackSize, routine, argument, flags, threadIdOut])=>
            seam.start({
                entry: wholeAddress(routine), stackSize: stackSize >>> 0,
                parameter: wholeAddress(argument), threadIdOut: wholeAddress(threadIdOut),
                flags: flags >>> 0,
            })), returns: 'pointer' },

        /**
         * void _endthread(void)
         *
         * Ends the thread, closing its handle when `_beginthread` made it.
         */
        _endthread: cdecl(0, ()=>{
            release(true);
            return seam.exit(0);
        }),

        /**
         * void _endthreadex(unsigned code)
         *
         * Ends the thread with the code; the handle stays open, whoever made it.
         */
        _endthreadex: cdecl(4, ([code])=>{
            release(false);
            return seam.exit(code >>> 0);
        }),

        /**
         * void _sleep(unsigned long milliseconds)
         *
         * Sleep under the runtime's older name, except that zero is a wait of
         * one millisecond rather than a yield: a loop that sleeps "nothing"
         * between polls still lets time pass.
         */
        ...(seam.sleep
            ? {
                _sleep: cdecl(4, ([milliseconds])=>
                    /** @type {(ms: number) => any} */ (seam.sleep)((milliseconds >>> 0) || 1)),
            }
            : {}),
    };
}
