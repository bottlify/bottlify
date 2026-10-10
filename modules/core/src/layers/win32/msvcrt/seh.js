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
 * The frame the compiler pushes, around the two words every handler frame has:
 *
 *     -0x08  the stack pointer the function's body runs at
 *     -0x04  the exception pointers, written by the handler before a filter
 *     +0x00  previous frame
 *     +0x04  this handler
 *     +0x08  the scope table
 *     +0x0c  the try level currently entered, -1 for none
 *
 * and every block the table names -- a filter, a `__finally`, the body of an
 * `__except` -- addresses the function's locals through EBP, which the handler
 * sets to the frame plus 0x10 before it runs one. That value is part of the
 * contract rather than a detail: the compiler's code reads the exception
 * pointers at [EBP-0x14] and, entering an `__except`, reloads ESP from
 * [EBP-0x18] and adjusts EBP to the function's own from there.
 *
 * Each entry of the table is three words: the level enclosing this one, the
 * filter, and the block to run when the filter accepts. A filter of zero marks
 * a `__finally`, which has no filter and always runs while unwinding -- which
 * is the one asymmetry in the structure and the reason the two passes below
 * read the same table differently.
 *
 * Programs that ship their own C runtime bring their own copy of this and
 * never reach here; it is for the ones that link the system's.
 */

import {
    Disposition, EH_UNWINDING, EXCEPTION_EXECUTE_HANDLER, EXCEPTION_EXIT_UNWIND,
} from '../kernel32/seh.js';

/** The registration frame a scope-table handler pushes. */
export const SCOPE_FRAME = Object.freeze({
    SAVED_ESP: -0x08,
    POINTERS: -0x04,
    PREVIOUS: 0x00,
    HANDLER: 0x04,
    TABLE: 0x08,
    TRY_LEVEL: 0x0c,
    /** What EBP is, relative to the frame, while a block of the table runs. */
    EBP: 0x10,
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
 * The runtime's jmp_buf, as far as this pair reads and writes it: the
 * registers, then where the handler chain stood, so a jump out of guarded
 * code leaves the chain as the function it lands in last saw it.
 */
export const JMP_BUF = Object.freeze({
    EBP: 0, EBX: 4, EDI: 8, ESI: 12, ESP: 16, EIP: 20, REGISTRATION: 24,
    TRY_LEVEL: 28, COOKIE: 32, UNWIND_FUNC: 36, UNWIND_DATA: 40,
});

/**
 * What `_setjmp3` writes to say the fields after the registration are its --
 * the level to unwind the registration's frame to, and the routine that does
 * it -- rather than whatever an older `_setjmp` left there.
 */
export const JMP_COOKIE = 0x56433230;

/** How many words of unwind data a buffer has room for. */
const UNWIND_DATA_WORDS = 6;

/**
 * @typedef {Object} CrtSehHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number) => boolean} isMapped
 * @property {() => Record<string, number>} registers
 * @property {(values: Record<string, number>) => void} setRegisters
 * @property {(options: { entry: number, args: number[], thread?: any,
 *              stackAtRest?: number, registers?: Record<string, number> })
 *              => Promise<number>} callGuest
 * @property {(registers: Record<string, number>, options?: { below?: number }) => any} continueAt
 *           The answer of a handler whose call does not return: the thread
 *           continues at these registers instead.
 * @property {() => any} [currentThread]
 * @property {() => number} [teb]  The running thread's block, whose first word
 *           is the head of the handler chain.
 * @property {(targetFrame: number, address: number, options?: { record?: number,
 *              registers?: Record<string, number>, thread?: any }) => Promise<any>} unwind
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a handler that answers differently from the runtime says so.
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
     * Takes the unwinding flags back off a record once its unwind is done.
     * The record is the exception's own, and the program may still read it --
     * the `__except` block about to run calls GetExceptionCode, a C++ catch
     * may rethrow it -- as an exception being handled rather than one tearing
     * frames down.
     *
     * @param {number} record
     */
    const clearUnwinding = record=>{
        if (record !== 0 && host.isMapped(record))
        {
            writeU32(record + 4, readU32(record + 4) & ~(EH_UNWINDING | EXCEPTION_EXIT_UNWIND));
        }
    };

    /**
     * How many `__finally` blocks each thread is inside that this runtime
     * started, which is what makes a termination abnormal.
     *
     * @type {WeakMap<object, number>}
     */
    const unwinding = new WeakMap();

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
     * Runs the `__finally` blocks of a frame from the level entered out to,
     * but not including, `stop`.
     *
     * The level is lowered before each block runs, not after: a `__finally`
     * that raises an exception of its own sends the dispatcher back through
     * this frame, and the block that is already running must not be found
     * entered and run a second time.
     *
     * @param {number} frame
     * @param {number} stop
     * @param {{ thread?: any, stackAtRest?: number }} how
     */
    const localUnwind = async(frame, stop, how)=>{
        const table = readU32(frame + SCOPE_FRAME.TABLE);
        if (!host.isMapped(table))
        {
            return;
        }
        let level = readU32(frame + SCOPE_FRAME.TRY_LEVEL);
        // A table is finite, and a level that encloses itself is a table the
        // program damaged; walking it would not end.
        for (let guard = 0; level !== NO_TRY_LEVEL && level !== stop && guard < 4096; guard++)
        {
            const scope = entryAt(table, level);
            writeU32(frame + SCOPE_FRAME.TRY_LEVEL, scope.enclosing);
            // A filter of zero is a __finally: no question is asked, the
            // block simply runs as the frame goes away.
            if (scope.filter === 0 && host.isMapped(scope.target))
            {
                const thread = how.thread;
                if (thread)
                {
                    unwinding.set(thread, (unwinding.get(thread) ?? 0) + 1);
                }
                try
                {
                    await host.callGuest({
                        entry: scope.target,
                        args: [],
                        thread,
                        stackAtRest: how.stackAtRest,
                        registers: { ebp: frame + SCOPE_FRAME.EBP },
                    });
                }
                finally
                {
                    if (thread)
                    {
                        unwinding.set(thread, (unwinding.get(thread) ?? 1) - 1);
                    }
                }
            }
            level = scope.enclosing;
        }
    };

    /**
     * The handler itself.
     *
     * Two passes, and they read the same table differently. While unwinding,
     * every level from the one entered outwards runs its `__finally` and the
     * search continues elsewhere -- this frame is being discarded, so it can
     * never claim the exception. Otherwise each level's filter is asked, and
     * the first that accepts takes it: the frames below this one are unwound,
     * the `__finally` blocks nested inside the accepting level run, and the
     * thread goes on in the `__except` block and never returns here.
     *
     * @param {number[]} args  record, frame, context, dispatcher
     * @returns {Promise<any>}
     */
    const exceptHandler3 = async([record, frame, context])=>{
        // Whose exception this is and where its stack stands, read before
        // anything is awaited. A __finally block and a filter are both guest
        // code, the walk runs several of them, and the loop turns in between
        // -- so after the first one the thread on the processor is no longer
        // the one that faulted.
        const asked = host.currentThread?.();
        const at = frame >>> 0;
        const flags = readU32((record >>> 0) + 4);
        const table = readU32(at + SCOPE_FRAME.TABLE);
        let level = readU32(at + SCOPE_FRAME.TRY_LEVEL);
        // The exception pointers a filter reads through its frame, kept below
        // everything the handler was called with, and every block this handler
        // runs is built below them.
        const entry = host.registers();
        const pointers = (entry.esp - 0x10 & ~0xf) >>> 0;
        const how = { thread: asked, stackAtRest: pointers };

        if (!host.isMapped(table))
        {
            // Nothing here can be read, so nothing here may be claimed. Saying
            // "not mine" leaves it to the next frame, which is the only answer
            // that cannot be wrong.
            return Disposition.CONTINUE_SEARCH;
        }

        if ((flags & EH_UNWINDING) !== 0)
        {
            await localUnwind(at, NO_TRY_LEVEL, how);
            return Disposition.CONTINUE_SEARCH;
        }

        writeU32(pointers, record >>> 0);
        writeU32(pointers + 4, context >>> 0);
        writeU32(at + SCOPE_FRAME.POINTERS, pointers);

        for (let guard = 0; level !== NO_TRY_LEVEL && guard < 4096; guard++)
        {
            const scope = entryAt(table, level);
            if (scope.filter !== 0 && host.isMapped(scope.filter))
            {
                const answer = await host.callGuest({
                    entry: scope.filter,
                    args: [],
                    thread: asked,
                    stackAtRest: pointers,
                    registers: { ebp: at + SCOPE_FRAME.EBP },
                }) | 0;
                if (answer === EXCEPTION_EXECUTE_HANDLER)
                {
                    // The frames between the fault and this one go away before
                    // the block runs, and each of them gets its own handler
                    // called on the way -- that is what unwinding is. Then the
                    // __finally blocks inside the one accepting, innermost
                    // first, and only then is its own level left.
                    await host.unwind(at, scope.target, {
                        record: record >>> 0,
                        registers: { ...entry, esp: pointers },
                        thread: asked,
                    });
                    clearUnwinding(record >>> 0);
                    await localUnwind(at, level, how);
                    writeU32(at + SCOPE_FRAME.TRY_LEVEL, scope.enclosing);
                    const esp = readU32(at + SCOPE_FRAME.SAVED_ESP);
                    return host.continueAt({
                        eip: scope.target, esp, ebp: at + SCOPE_FRAME.EBP,
                    }, { below: esp });
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

    /**
     * Where each mark's caller stands once its call to setjmp is over, which
     * the buffer has no field for: the stack pointer it keeps is the one just
     * past the return address, below the arguments the caller has yet to pop.
     *
     * @type {Map<number, number>}
     */
    const standing = new Map();

    /**
     * The mark is where the call returns to, with the stack as the return
     * leaves it -- read from the call, not from the processor, which is
     * standing inside the stub with the return address still on the stack.
     * That slot is below the caller's stack and is written over by the next
     * call it makes, so a mark that kept the stub's position would return
     * through whatever that call left there.
     *
     * @param {number} buffer
     * @param {{ callerStack: number, hostReturn: number } | undefined} frame
     * @param {number} argumentWords  How many words the caller pushed.
     * @param {number[]} [unwind]  What `_setjmp3` was given after its count:
     *        the routine that unwinds the registration's own frame, the level
     *        to unwind it to, and data for the routine.
     * @returns {number}
     */
    const setjmp = (buffer, frame, argumentWords, unwind)=>{
        const registers = host.registers();
        const at = buffer >>> 0;
        const esp = frame ? frame.callerStack + 4 >>> 0 : registers.esp ?? 0;
        writeU32(at + JMP_BUF.EBP, registers.ebp ?? 0);
        writeU32(at + JMP_BUF.EBX, registers.ebx ?? 0);
        writeU32(at + JMP_BUF.EDI, registers.edi ?? 0);
        writeU32(at + JMP_BUF.ESI, registers.esi ?? 0);
        writeU32(at + JMP_BUF.ESP, esp);
        writeU32(at + JMP_BUF.EIP, frame ? frame.hostReturn : registers.eip ?? 0);
        standing.set(at, esp + argumentWords * 4 >>> 0);
        const teb = host.teb?.() ?? 0;
        writeU32(at + JMP_BUF.REGISTRATION, teb === 0 ? 0 : readU32(teb));
        if (unwind)
        {
            writeU32(at + JMP_BUF.COOKIE, JMP_COOKIE);
            writeU32(at + JMP_BUF.UNWIND_FUNC, unwind[0] ?? 0);
            writeU32(at + JMP_BUF.TRY_LEVEL, unwind.length > 1 ? unwind[1] : NO_TRY_LEVEL);
            for (let index = 0; index < UNWIND_DATA_WORDS; index++)
            {
                writeU32(at + JMP_BUF.UNWIND_DATA + index * 4, unwind[index + 2] ?? 0);
            }
        }
        // Zero says "this is the call that set the mark", and it is how the
        // program tells the two arrivals apart.
        return 0;
    };

    /**
     * void _seh_longjmp_unwind(jmp_buf *env)
     *
     * The routine `_setjmp3` names for a frame with `__try` blocks:
     * a longjmp back into that frame runs its `__finally` blocks from
     * the level it is at down to the level the mark was set at.
     *
     * Exported under both spellings: msvcrt.spec names it undecorated, which is
     * what a library linked by the Microsoft toolchain imports, and another
     * toolchain's import library asks for the stdcall-decorated name.
     */
    const sehLongjmpUnwind = {
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([buffer])=>{
            const at = buffer >>> 0;
            const asked = host.currentThread?.();
            return localUnwind(readU32(at + JMP_BUF.REGISTRATION),
                readU32(at + JMP_BUF.TRY_LEVEL), {
                    thread: asked,
                    stackAtRest: (host.registers().esp - 0x10 & ~0xf) >>> 0,
                }).then(()=>0);
        },
    };

    return {
        exceptHandler3,
        localUnwind,

        table: {
            /** EXCEPTION_DISPOSITION _except_handler3(record, frame, context, dispatcher) */
            _except_handler3: { argBytes: 16, handler: exceptHandler3 },

            /**
             * void _local_unwind2(PEXCEPTION_REGISTRATION frame, int stop)
             *
             * What the compiler calls on its own, not the dispatcher: a
             * `return` or `goto` out of a `__try` that has `__finally` blocks
             * inside it runs them this way before it leaves.
             */
            _local_unwind2: {
                convention: 'cdecl',
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([frame, stop])=>{
                    const asked = host.currentThread?.();
                    return localUnwind(frame >>> 0, stop >>> 0, {
                        thread: asked,
                        stackAtRest: (host.registers().esp - 0x10 & ~0xf) >>> 0,
                    }).then(()=>0);
                },
            },

            /**
             * int _abnormal_termination(void)
             *
             * Asked from inside a `__finally`: whether it runs because the
             * guarded block ended normally or because it is being left early
             * -- an exception taking the frame away, or a jump out of the
             * block. The compiler runs a `__finally` inline when its block
             * ends normally, and through this runtime otherwise, so the answer
             * is whether the thread asking is inside a block this runtime
             * started.
             */
            _abnormal_termination: {
                convention: 'cdecl',
                argBytes: 0,
                handler: ()=>{
                    const thread = host.currentThread?.();
                    return thread && (unwinding.get(thread) ?? 0) > 0 ? 1 : 0;
                },
            },

            /**
             * int _setjmp(jmp_buf env)
             *
             * The buffer keeps what longjmp has to put back: the registers the
             * caller relies on, and the head of the handler chain. Its layout
             * is the runtime's own, so this pair only has to agree with itself
             * -- which is all a program requires, since it never passes a
             * buffer between two runtimes.
             */
            _setjmp: {
                convention: 'cdecl',
                argBytes: 4,
                /**
                 * @param {number[]} args
                 * @param {{ callerStack: number, hostReturn: number }} [frame]
                 */
                handler: ([buffer], frame)=>setjmp(buffer, frame, 1),
            },

            /**
             * int _setjmp3(jmp_buf env, int count, ...)
             *
             * The spelling the compiler emits for `setjmp`. After the count
             * come what a longjmp back here needs to unwind the calling
             * frame itself: the routine that does it, the level to unwind to,
             * and whatever data that routine reads.
             */
            _setjmp3: {
                convention: 'cdecl',
                argBytes: 8,
                /**
                 * @param {number[]} args
                 * @param {{ callerStack: number, hostReturn: number }} [frame]
                 */
                handler: ([buffer, count], frame)=>{
                    const from = frame?.callerStack;
                    const words = from === undefined
                        ? 0
                        : Math.min(count >>> 0, UNWIND_DATA_WORDS + 2);
                    /** @type {number[]} */
                    const unwind = [];
                    for (let index = 0; index < words; index++)
                    {
                        unwind.push(readU32(/** @type {number} */ (from) + 12 + index * 4));
                    }
                    return setjmp(buffer, frame, 2 + (count >>> 0), unwind);
                },
            },

            '_seh_longjmp_unwind@4': sehLongjmpUnwind,
            _seh_longjmp_unwind: sehLongjmpUnwind,

            /**
             * void longjmp(jmp_buf env, int value)
             *
             * Back to the mark. Every frame the program registered since then
             * is below it, and each gets its handler called with the unwinding
             * flag on the way, exactly as for an exception that is caught at
             * the mark -- which is how a `__finally` between the two runs.
             */
            longjmp: {
                convention: 'cdecl',
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([buffer, value])=>{
                    const at = buffer >>> 0;
                    const target = {
                        ebp: readU32(at + JMP_BUF.EBP),
                        ebx: readU32(at + JMP_BUF.EBX),
                        edi: readU32(at + JMP_BUF.EDI),
                        esi: readU32(at + JMP_BUF.ESI),
                        esp: readU32(at + JMP_BUF.ESP),
                        eip: readU32(at + JMP_BUF.EIP),
                        // What setjmp appears to return the second time. Never
                        // zero, or the program cannot tell the arrivals apart
                        // and takes the first branch for ever.
                        eax: ((value | 0) === 0 ? 1 : value | 0) >>> 0,
                    };
                    const registration = readU32(at + JMP_BUF.REGISTRATION);
                    const teb = host.teb?.() ?? 0;
                    const across = teb !== 0 && registration !== 0
                        && readU32(teb) !== registration;
                    const own = readU32(at + JMP_BUF.COOKIE) === JMP_COOKIE
                        ? readU32(at + JMP_BUF.UNWIND_FUNC) : 0;
                    if (!across && own === 0)
                    {
                        host.setRegisters(target);
                        return target.eax;
                    }
                    const asked = host.currentThread?.();
                    const stack = (host.registers().esp - 0x10 & ~0xf) >>> 0;
                    return (across
                        ? host.unwind(registration, target.eip, { thread: asked })
                        : Promise.resolve())
                        .then(()=>(own !== 0 && host.isMapped(own)
                            ? host.callGuest({
                                entry: own, args: [at], thread: asked, stackAtRest: stack,
                            })
                            : 0))
                        // The function that set the mark stands above the
                        // arguments it gave setjmp, and everything it has
                        // called since is below that.
                        .then(()=>host.continueAt(target, {
                            below: standing.get(at) ?? target.esp + 4,
                        }));
                },
            },
        },
    };
}
