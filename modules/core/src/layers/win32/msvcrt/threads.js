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
 * is the shape of the routine and who owns the handle. A `_beginthread`
 * routine is cdecl and returns nothing, and its handle is the runtime's --
 * closed when the thread ends, never by the caller. A `_beginthreadex`
 * routine is stdcall and returns the exit code, and its handle is the
 * caller's to close, as CreateThread's is.
 *
 * The cdecl routine leaves its argument on the stack when it returns, where
 * the stdcall one pops it. The stub every thread returns into does not read
 * the stack, so both land in the same place and end the same way.
 */

/**
 * @typedef {Object} ThreadSeam
 * @property {(request: { entry: number, stackSize: number, parameter: number,
 *             threadIdOut: number }) => number} start
 *           Makes the thread and answers with its handle, writing its id
 *           where asked; zero when it cannot.
 * @property {(code: number) => any} exit
 *           Ends the calling thread with the code and answers with what the
 *           call must return, since the call does not come back.
 * @property {(milliseconds: number) => any} [sleep]
 *           Suspends the calling thread for that long, the way Sleep does,
 *           and answers with what the call must return meanwhile. Absent,
 *           `_sleep` stays unexported.
 */

/**
 * @param {ThreadSeam} seam
 */
export function createThreadFunctions(seam){
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
        _beginthread: cdecl(12, ([start, stackSize, argument])=>{
            const handle = seam.start({
                entry: start >>> 0, stackSize: stackSize >>> 0,
                parameter: argument >>> 0, threadIdOut: 0,
            });
            return handle === 0 ? -1 : handle;
        }),

        /**
         * uintptr_t _beginthreadex(void *security, unsigned stackSize,
         *   unsigned(__stdcall *start)(void *), void *argList, unsigned initFlag,
         *   unsigned *threadId)
         *
         * Zero when no thread could be made. The suspended flag is taken as
         * CreateThread takes it here: the thread runs when it gets a turn.
         */
        _beginthreadex: cdecl(24, ([, stackSize, start, argument, , threadIdOut])=>
            seam.start({
                entry: start >>> 0, stackSize: stackSize >>> 0,
                parameter: argument >>> 0, threadIdOut: threadIdOut >>> 0,
            })),

        /** void _endthread(void) */
        _endthread: cdecl(0, ()=>seam.exit(0)),

        /** void _endthreadex(unsigned code) */
        _endthreadex: cdecl(4, ([code])=>seam.exit(code >>> 0)),

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
