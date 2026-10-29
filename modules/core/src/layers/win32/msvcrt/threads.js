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
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
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

/** The block: routine, argument, handle, thread id. */
const BLOCK = Object.freeze({ ROUTINE: 0, ARGUMENT: 4, HANDLE: 8, ID: 12, BYTES: 16 });

/**
 * @param {ThreadSeam} seam
 */
export function createThreadFunctions(seam){
    const { runtime } = seam;

    /** `_beginthread`'s threads by id: the handle the runtime closes and the block. */
    const owned = /** @type {Map<number, { handle: number, block: number }>} */ (new Map());

    /** The start routine, made once; 0 where there is none to make. */
    let start = 0;
    const startAddress = ()=>{
        const endthread = runtime?.endthread() ?? 0;
        if (start === 0 && runtime && endthread !== 0)
        {
            const code = startRoutine(endthread);
            start = runtime.allocateCode(code.length);
            if (start !== 0)
            {
                runtime.writeMemory(start, code);
            }
        }
        return start;
    };

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        runtime?.writeMemory(address, bytes);
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
        _beginthread: cdecl(12, ([routine, stackSize, argument])=>{
            const entry = startAddress();
            const block = entry === 0 || !runtime ? 0 : runtime.allocate(BLOCK.BYTES);
            if (block === 0 || !runtime)
            {
                const handle = seam.start({
                    entry: routine >>> 0, stackSize: stackSize >>> 0,
                    parameter: argument >>> 0, threadIdOut: 0, flags: 0,
                });
                return handle === 0 ? -1 : handle;
            }
            writeU32(block + BLOCK.ROUTINE, routine);
            writeU32(block + BLOCK.ARGUMENT, argument);
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
            writeU32(block + BLOCK.HANDLE, handle);
            const id = new DataView(runtime.readMemory(block + BLOCK.ID, 4).slice().buffer)
                .getUint32(0, true);
            owned.set(id, { handle, block });
            return handle;
        }),

        /**
         * uintptr_t _beginthreadex(void *security, unsigned stackSize,
         *   unsigned(__stdcall *start)(void *), void *argList, unsigned initFlag,
         *   unsigned *threadId)
         *
         * Zero when no thread could be made. CREATE_SUSPENDED is CreateThread's:
         * the thread waits for ResumeThread.
         */
        _beginthreadex: cdecl(24, ([, stackSize, routine, argument, flags, threadIdOut])=>
            seam.start({
                entry: routine >>> 0, stackSize: stackSize >>> 0,
                parameter: argument >>> 0, threadIdOut: threadIdOut >>> 0, flags: flags >>> 0,
            })),

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
