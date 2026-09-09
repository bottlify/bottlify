/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's half of exception handling: the handler a compiler registers.
 *
 * A program does not write these. The compiler emits a prologue that pushes a
 * frame naming `_except_handler3` and a table it built from the `__try` blocks
 * in the function, and the operating system's dispatcher calls that handler.
 * So this is reached only through the chain walk, never by name.
 *
 * The frame the compiler pushes, past the two words every handler frame has:
 *
 *     +0x00  previous frame
 *     +0x04  this handler
 *     +0x08  the scope table
 *     +0x0c  the try level currently entered, -1 for none
 *     +0x10  the stack pointer the function started with
 *
 * and each entry of that table is three words: the level enclosing this one,
 * the filter, and the block to run when the filter accepts. A filter of zero
 * marks a `__finally`, which has no filter and always runs while unwinding --
 * which is the one asymmetry in the structure and the reason the two passes
 * below read the same table differently.
 *
 * Programs that ship their own C runtime bring their own copy of this and
 * never reach here; it is for the ones that link the system's.
 */

import { Disposition, EH_UNWINDING, EXCEPTION_EXECUTE_HANDLER } from '../kernel32/seh.js';

/** The registration frame a scope-table handler pushes. */
export const SCOPE_FRAME = Object.freeze({
    PREVIOUS: 0x00,
    HANDLER: 0x04,
    TABLE: 0x08,
    TRY_LEVEL: 0x0c,
    SAVED_ESP: 0x10,
});

/** One entry of the table, and how far apart they are. */
export const SCOPE_ENTRY = Object.freeze({
    ENCLOSING: 0x00,
    FILTER: 0x04,
    TARGET: 0x08,
    SIZE: 0x0c,
});

/** No try block is entered. */
export const NO_TRY_LEVEL = 0xffffffff;

/**
 * @typedef {Object} CrtSehHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number) => boolean} isMapped
 * @property {() => Record<string, number>} registers
 * @property {(values: Record<string, number>) => void} setRegisters
 * @property {(options: { entry: number, args: number[], thread?: any })
 *              => Promise<number>} callGuest
 * @property {() => any} [currentThread]
 * @property {(targetFrame: number, address: number) => Promise<any>} unwind
 */

/**
 * @param {CrtSehHost} host
 */
export function createCrtSeh(host){
    const readU32 = (/** @type {number} */ at)=>{
        const bytes = host.readMemory(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    const writeU32 = (/** @type {number} */ at, /** @type {number} */ value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(at, bytes);
    };

    /**
     * One entry of a frame's scope table.
     *
     * @param {number} table
     * @param {number} level
     */
    const entryAt = (table, level)=>{
        const at = table + level * SCOPE_ENTRY.SIZE;
        return {
            enclosing: readU32(at + SCOPE_ENTRY.ENCLOSING),
            filter: readU32(at + SCOPE_ENTRY.FILTER),
            target: readU32(at + SCOPE_ENTRY.TARGET),
        };
    };

    /**
     * The handler itself.
     *
     * Two passes, and they read the same table differently. While unwinding,
     * every level from the one entered outwards runs its `__finally` and the
     * search continues elsewhere -- this frame is being discarded, so it can
     * never claim the exception. Otherwise each level's filter is asked, and
     * the first that accepts takes it.
     *
     * @param {number[]} args  record, frame, context, dispatcher
     * @returns {Promise<number>}
     */
    const exceptHandler3 = async([record, frame])=>{
        // Whose exception this is, read before anything is awaited. A __finally
        // block and a filter are both guest code, the walk runs several of
        // them, and the loop turns in between -- so after the first one the
        // thread on the processor is no longer the one that faulted.
        const asked = host.currentThread?.();
        const flags = readU32((record >>> 0) + 4);
        const table = readU32((frame >>> 0) + SCOPE_FRAME.TABLE);
        let level = readU32((frame >>> 0) + SCOPE_FRAME.TRY_LEVEL);

        if (!host.isMapped(table))
        {
            // Nothing here can be read, so nothing here may be claimed. Saying
            // "not mine" leaves it to the next frame, which is the only answer
            // that cannot be wrong.
            return Disposition.CONTINUE_SEARCH;
        }

        if ((flags & EH_UNWINDING) !== 0)
        {
            while (level !== NO_TRY_LEVEL)
            {
                const scope = entryAt(table, level);
                // A filter of zero is a __finally: no question is asked, the
                // block simply runs as the frame goes away.
                if (scope.filter === 0 && host.isMapped(scope.target))
                {
                    await host.callGuest({ entry: scope.target, args: [], thread: asked });
                }
                level = scope.enclosing;
            }
            return Disposition.CONTINUE_SEARCH;
        }

        while (level !== NO_TRY_LEVEL)
        {
            const scope = entryAt(table, level);
            if (scope.filter !== 0 && host.isMapped(scope.filter))
            {
                const answer = await host.callGuest(
                    { entry: scope.filter, args: [], thread: asked }) | 0;
                if (answer === EXCEPTION_EXECUTE_HANDLER)
                {
                    // The frames between the fault and this one go away before
                    // the block runs, and each of them gets its own handler
                    // called on the way -- that is what unwinding is.
                    writeU32((frame >>> 0) + SCOPE_FRAME.TRY_LEVEL, scope.enclosing);
                    await host.unwind(frame >>> 0, scope.target);
                    host.setRegisters({
                        eip: scope.target,
                        esp: readU32((frame >>> 0) + SCOPE_FRAME.SAVED_ESP),
                    });
                    return Disposition.CONTINUE_EXECUTION;
                }
                if (answer < 0)
                {
                    // EXCEPTION_CONTINUE_EXECUTION: the filter fixed whatever
                    // it was and the faulting instruction runs again.
                    return Disposition.CONTINUE_EXECUTION;
                }
            }
            level = scope.enclosing;
        }
        return Disposition.CONTINUE_SEARCH;
    };

    return {
        exceptHandler3,

        table: {
            /** EXCEPTION_DISPOSITION _except_handler3(record, frame, context, dispatcher) */
            _except_handler3: { argBytes: 16, handler: exceptHandler3 },

            /**
             * int _setjmp(jmp_buf env)
             *
             * The buffer keeps what longjmp has to put back. Its layout is the
             * runtime's own rather than the system's, so this pair only agrees
             * with itself -- which is all a program requires, since it never
             * passes a buffer between two runtimes.
             */
            _setjmp: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([buffer])=>{
                    const registers = host.registers();
                    const at = buffer >>> 0;
                    for (const [index, name] of
                        ['ebp', 'ebx', 'edi', 'esi', 'esp', 'eip'].entries())
                    {
                        writeU32(at + index * 4, registers[name] ?? 0);
                    }
                    // Zero says "this is the call that set the mark", and it is
                    // how the program tells the two arrivals apart.
                    return 0;
                },
            },

            /** void longjmp(jmp_buf env, int value) */
            longjmp: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([buffer, value])=>{
                    const at = buffer >>> 0;
                    host.setRegisters({
                        ebp: readU32(at),
                        ebx: readU32(at + 4),
                        edi: readU32(at + 8),
                        esi: readU32(at + 12),
                        esp: readU32(at + 16),
                        eip: readU32(at + 20),
                        // What setjmp appears to return the second time. Never
                        // zero, or the program cannot tell the arrivals apart
                        // and takes the first branch for ever.
                        eax: (value | 0) === 0 ? 1 : value | 0,
                    });
                    return 0;
                },
            },
        },
    };
}
