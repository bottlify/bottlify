/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A library's entry point, called the way the loader calls it: inside a frame
 * of the loader's own on the chain, whose handler takes whatever the entry
 * point raises and does not raise. An exception out of DllMain ends DllMain,
 * as though it had answered FALSE; it never reaches the frames of the program
 * that called FreeLibrary or ExitProcess, whose handlers would take it for
 * their own crash. Wine's loader wraps every entry-point call the same way.
 *
 * The frame is an EXCEPTION_REGISTRATION the caller's stack holds just above
 * the entry point's own: the next record, and a handler here. Taking an
 * exception, the handler unwinds every frame the entry point pushed -- their
 * handlers run with the unwinding flag, as for any catch -- and sends the
 * thread to a routine that answers 0 from where the entry point's own return
 * would have landed.
 */

/** The flags a handler is shown during an unwind rather than a dispatch. */
const EH_UNWINDING = 0x2;
const EH_EXIT_UNWIND = 0x4;
/** ExceptionContinueSearch: not this frame's. */
const CONTINUE_SEARCH = 1;
/** Room left between the caller's stack pointer and the loader's record. */
const CLEARANCE = 64;
/** The words bridge.callGuest puts below its resting stack: return, three arguments, spare. */
const CALL_WORDS = 5;

/**
 * @param {Object} host
 * @param {(name: string, fn: any) => number} host.register  A guest address for a host routine.
 * @param {(call: any) => Promise<number>} host.callGuest
 * @param {(registers: Record<string, number>, options?: { below?: number }) => any} host.continueAt
 * @param {(frame: number, address: number, options?: any) => Promise<any>} host.unwind
 * @param {(address: number) => number} host.readU32
 * @param {(address: number, value: number) => void} host.writeU32
 * @param {() => number} host.stackPointer  The calling thread's, now.
 * @param {(thread: any) => number} host.teb
 * @param {(detail: string) => void} [host.divergence]
 */
export function createEntryPointCaller(host){
    /** The loader's frames in flight, by the record's address. @type {Map<number, any>} */
    const guarded = new Map();
    let handler = 0;
    let abandoned = 0;

    const place = ()=>{
        if (handler !== 0)
        {
            return;
        }
        // Where a caught entry point returns from: `ret 12` to the callback's
        // own return, with 0 in EAX.
        abandoned = host.register('<dll-entry-abandoned>', { argBytes: 12, handler: ()=>0 });
        handler = host.register('<dll-entry-guard>', {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([record, frame])=>{
                const call = guarded.get(frame >>> 0);
                if (!call || (host.readU32(record + 4) & (EH_UNWINDING | EH_EXIT_UNWIND)) !== 0)
                {
                    return CONTINUE_SEARCH;
                }
                const code = (host.readU32(record) >>> 0).toString(16);
                host.divergence?.(`exception 0x${code} in the entry point of the library at`
                    + ` 0x${call.base.toString(16)}, taken by the loader`);
                return host.unwind(frame >>> 0, abandoned,
                    { record: record >>> 0, thread: call.thread })
                    .then(()=>host.continueAt({ eip: abandoned, esp: call.frameBase },
                        { below: call.frameBase }));
            },
        });
    };

    /**
     * @param {{ entry: number, base: number, reason: number, reserved: number, thread: any }} call
     * @returns {Promise<number>} what the entry point answered, 0 when it raised
     */
    return ({ entry, base, reason, reserved, thread })=>{
        const teb = host.teb(thread);
        // A thread with no TEB has no chain to stand on.
        if (teb === 0)
        {
            return host.callGuest({ entry, args: [base, reason, reserved], thread });
        }
        place();
        const record = (host.stackPointer() - CLEARANCE & ~3) >>> 0;
        const previous = host.readU32(teb) >>> 0;
        host.writeU32(record, previous);
        host.writeU32(record + 4, handler);
        host.writeU32(teb, record);
        guarded.set(record, { base: base >>> 0, thread, frameBase: record - 4 * CALL_WORDS });
        const done = ()=>{
            guarded.delete(record);
            host.writeU32(teb, previous);
        };
        return host.callGuest({
            entry, args: [base, reason, reserved], thread, stackAtRest: record,
        })
            .then(answer=>{
                done();
                return answer;
            });
    };
}
