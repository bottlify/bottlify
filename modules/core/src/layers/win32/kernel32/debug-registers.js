/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The debug registers of a 32-bit CONTEXT (CONTEXT_DEBUG_REGISTERS: Dr0-Dr3,
 * Dr6, Dr7), kept per thread as Windows keeps them: what SetThreadContext,
 * NtContinue or a handler's continued context gives a thread is what its
 * GetThreadContext and its next exception's context read back, and a thread
 * starts with all six clear - a new thread does not inherit its creator's.
 *
 * Every path a context travels goes through here, as the floating-point groups
 * go through `fpu-context.js`. The values are kept, not acted on: the
 * processor here raises neither a breakpoint at a Dr0-Dr3 address nor a single
 * step, so a thread given an enabled breakpoint is said once (a debugger, a
 * protection testing for one, a runtime's own watchpoints all set them).
 */

/** ContextFlags' debug-register group (winnt.h). */
export const CONTEXT_DEBUG_REGISTERS = 0x10010;
/** Dr0-Dr3, Dr6 and Dr7, in the record's order, right after ContextFlags. */
const NAMES = /** @type {const} */ (['dr0', 'dr1', 'dr2', 'dr3', 'dr6', 'dr7']);
const FIRST_AT = 0x04;
/** Dr7's local and global enables of the four breakpoints. */
const DR7_ENABLES = 0xff;

/** @typedef {Record<typeof NAMES[number], number>} DebugRegisters */

/** The six of a thread that has never been given any: all clear. @returns {DebugRegisters} */
const clear = ()=>({ dr0: 0, dr1: 0, dr2: 0, dr3: 0, dr6: 0, dr7: 0 });

/**
 * Whether a record's flags name the group.
 *
 * @param {number} flags
 */
export const hasDebugRegisters = flags=>
    (flags & CONTEXT_DEBUG_REGISTERS) === CONTEXT_DEBUG_REGISTERS;

/**
 * A thread's debug registers, clear for one never given any.
 *
 * @param {any} thread
 * @returns {DebugRegisters}
 */
export const debugRegistersOf = thread=>({ ...thread?.debugRegisters ?? clear() });

/**
 * Lays a thread's debug registers into a record's bytes, when its flags name them.
 *
 * @param {any} thread @param {Uint8Array} bytes @param {number} flags
 */
export function writeDebugGroup(thread, bytes, flags){
    if (!hasDebugRegisters(flags))
    {
        return;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = debugRegistersOf(thread);
    NAMES.forEach((name, index)=>view.setUint32(FIRST_AT + index * 4, values[name] >>> 0, true));
}

/**
 * The debug registers a record carries, or null when its flags do not name them.
 *
 * @param {Uint8Array} bytes @param {number} flags
 * @returns {DebugRegisters | null}
 */
export function debugGroupOf(bytes, flags){
    if (!hasDebugRegisters(flags))
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = clear();
    NAMES.forEach((name, index)=>{
        values[name] = view.getUint32(FIRST_AT + index * 4, true);
    });
    return values;
}

/**
 * Gives a thread its debug registers. An enabled breakpoint is kept and not
 * raised, which is said.
 *
 * @param {any} thread @param {DebugRegisters} values
 * @param {((api: string, detail: string) => void) | undefined} divergence
 * @param {string} api  the call that set them
 */
export function setDebugRegisters(thread, values, divergence, api){
    if (!thread)
    {
        return;
    }
    thread.debugRegisters = { ...values };
    if ((values.dr7 & DR7_ENABLES) !== 0)
    {
        divergence?.(api, 'hardware breakpoints are kept and not raised');
    }
}
