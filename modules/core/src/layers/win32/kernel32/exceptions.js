/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Structured exception handling, as far as it goes -- which is not far, and the
 * whole design of this file is about not hiding that.
 *
 * Real SEH is a walk of a linked list of handler frames off the thread
 * information block, calling each until one claims the exception, and then a
 * second walk unwinding the frames that were skipped. None of that exists here.
 *
 * What that means for each function is different, and the difference is the
 * point:
 *
 * - The filter functions are *bookkeeping*. A program installs a top-level
 *   filter and expects to get the previous one back so it can chain to it. That
 *   contract is entirely about remembering a pointer, and it is honoured
 *   exactly.
 * - Raising and unwinding are *control flow*. They cannot be approximated,
 *   because both of them are defined by not returning to their caller. A
 *   RaiseException that returns hands control back to code that has already
 *   decided it is not running any more; an RtlUnwind that returns leaves live
 *   frames on a stack the caller believes it has just discarded. Either one
 *   produces a guest that carries on inside a state nothing agrees about, and
 *   the fault surfaces somewhere with no connection to here.
 *
 * So those two fail loudly. A program that never raises never notices, and one
 * that does gets a report naming the exception at the point it was raised --
 * which is the information needed to implement this properly, and which a
 * pretended success would have destroyed.
 */

/** What a filter returns. Only EXECUTE_HANDLER is ever produced here. */
const EXCEPTION_EXECUTE_HANDLER = 1;

/**
 * @typedef {Object} ExceptionHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 */

/**
 * @param {ExceptionHost} host
 */
export function createExceptionFunctions(host){
    /** The last filter installed. Zero means the default, as on Windows. */
    let topLevelFilter = 0;

    return {
        /**
         * LPTOP_LEVEL_EXCEPTION_FILTER SetUnhandledExceptionFilter(
         *     LPTOP_LEVEL_EXCEPTION_FILTER lpTopLevelExceptionFilter)
         *
         * Returns the one it replaces, because a caller chains to it: the usual
         * shape is to install a filter, and call the previous one from inside it
         * when the new one declines. Handing back zero every time would break
         * that chain silently.
         */
        SetUnhandledExceptionFilter: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([filter])=>{
                const previous = topLevelFilter;
                topLevelFilter = filter >>> 0;
                return previous;
            },
        },

        /**
         * LONG UnhandledExceptionFilter(struct _EXCEPTION_POINTERS *ExceptionInfo)
         *
         * On Windows this is what shows the crash dialog and then tells the
         * caller to run its handler; with no debugger attached, EXECUTE_HANDLER
         * is what it answers, and so is this. The installed top-level filter is
         * deliberately not called: doing so would mean calling back into guest
         * code from inside a failure whose stack is already unreliable.
         */
        UnhandledExceptionFilter: {
            argBytes: 4,
            handler: ()=>EXCEPTION_EXECUTE_HANDLER,
        },

        /**
         * VOID RaiseException(DWORD dwExceptionCode, DWORD dwExceptionFlags,
         *                     DWORD nNumberOfArguments, const ULONG_PTR *lpArguments)
         *
         * Does not return on Windows unless a handler resumes it, and there are
         * no handlers here. Reported rather than swallowed -- see the note at the
         * top of this file.
         */
        RaiseException: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([code, flags, count, args])=>{
                const total = Math.min(count >>> 0, 15);
                /** @type {number[]} */
                const parameters = [];
                if (total > 0 && (args >>> 0) !== 0)
                {
                    const bytes = host.readMemory(args >>> 0, total * 4);
                    const view = new DataView(bytes.buffer, bytes.byteOffset, total * 4);
                    for (let at = 0; at < total; at++)
                    {
                        parameters.push(view.getUint32(at * 4, true));
                    }
                }
                throw new Error(
                    `RaiseException: the guest raised 0x${(code >>> 0).toString(16)} `
                    + `(flags 0x${(flags >>> 0).toString(16)}`
                    + `${parameters.length === 0 ? '' : `, arguments ${parameters.join(', ')}`})`
                    + ' and there is no handler chain to deliver it to');
            },
        },

        /**
         * VOID RtlUnwind(PVOID TargetFrame, PVOID TargetIp,
         *                PEXCEPTION_RECORD ExceptionRecord, PVOID ReturnValue)
         *
         * Discards the handler frames between here and TargetFrame and resumes
         * at TargetIp. Returning normally instead would leave every one of those
         * frames live while the caller proceeds as though they were gone.
         */
        RtlUnwind: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([targetFrame, targetIp])=>{
                throw new Error(
                    'RtlUnwind: unwinding to frame '
                    + `0x${(targetFrame >>> 0).toString(16)} at `
                    + `0x${(targetIp >>> 0).toString(16)} is not implemented`);
            },
        },
    };
}
