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
 *
 * The same guard serves any call the host makes into guest code on behalf of
 * someone the exception must not reach: a COM stub running a method for
 * another process catches what the method raises and answers the caller with
 * RPC_E_SERVERFAULT, as COM's own stubs do.
 */

/** The flags a handler is shown during an unwind rather than a dispatch. */
const EH_UNWINDING = 0x2;
const EH_EXIT_UNWIND = 0x4;
/** ExceptionContinueSearch: not this frame's. */
const CONTINUE_SEARCH = 1;
/** Room left between the caller's stack pointer and the guard's record. */
const CLEARANCE = 64;

/**
 * @typedef {Object} GuardHost
 * @property {(name: string, fn: any) => number} register  A guest address for a host routine.
 * @property {(call: any) => Promise<number>} callGuest
 * @property {(registers: Record<string, number>, options?: { below?: number }) => any} continueAt
 * @property {(frame: number, address: number, options?: any) => Promise<any>} unwind
 * @property {(address: number) => number} readU32
 * @property {(address: number, value: number) => void} writeU32
 * @property {(thread: any) => number} stackPointer  Where the calling thread's stack is free from.
 * @property {(thread: any) => number} teb
 * @property {(detail: string) => void} [divergence]
 */

/**
 * A stdcall into guest code inside a frame of the host's own: an exception
 * the routine raises and does not handle ends the routine, whose caller is
 * answered `failed`.
 *
 * @param {GuardHost} host
 */
export function createGuardedCaller(host){
    /** The frames in flight, by the record's address. @type {Map<number, any>} */
    const guarded = new Map();
    /** Where a caught routine returns from, by its argument words and answer. */
    /** @type {Map<string, number>} */
    const abandoned = new Map();
    let handler = 0;

    /** @param {number} words @param {number} answer */
    const abandonedFor = (words, answer)=>{
        const key = `${words}:${answer >>> 0}`;
        let address = abandoned.get(key);
        if (address === undefined)
        {
            // `ret` over the routine's own arguments to the callback's own
            // return, with the answer in EAX.
            address = host.register(`<guarded-abandoned-${key}>`,
                { argBytes: 4 * words, handler: ()=>answer | 0 });
            abandoned.set(key, address);
        }
        return address;
    };

    const place = ()=>{
        if (handler !== 0)
        {
            return;
        }
        handler = host.register('<guarded-call>', {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([record, frame])=>{
                const call = guarded.get(frame >>> 0);
                if (!call || (host.readU32(record + 4) & (EH_UNWINDING | EH_EXIT_UNWIND)) !== 0)
                {
                    return CONTINUE_SEARCH;
                }
                call.report?.((host.readU32(record) >>> 0).toString(16),
                    (host.readU32(record + 12) >>> 0).toString(16));
                return host.unwind(frame >>> 0, call.resume,
                    { record: record >>> 0, thread: call.thread })
                    .then(()=>host.continueAt({ eip: call.resume, esp: call.frameBase },
                        { below: call.frameBase }));
            },
        });
    };

    /**
     * @param {{ entry: number, args: number[], thread: any, failed: number,
     *     report?: (code: string, address: string) => void }} call
     * @returns {Promise<number>} what the routine answered, `failed` when it raised
     */
    return ({ entry, args, thread, failed, report })=>{
        const teb = host.teb(thread);
        // A thread with no TEB has no chain to stand on.
        if (teb === 0)
        {
            return host.callGuest({ entry, args, thread });
        }
        place();
        const record = (host.stackPointer(thread) - CLEARANCE & ~3) >>> 0;
        const previous = host.readU32(teb) >>> 0;
        host.writeU32(record, previous);
        host.writeU32(record + 4, handler);
        host.writeU32(teb, record);
        // bridge.callGuest puts the return, the arguments and a spare word
        // below the resting stack.
        const frameBase = record - 4 * (args.length + 2);
        guarded.set(record, { thread, frameBase, report,
            resume: abandonedFor(args.length, failed) });
        const done = ()=>{
            guarded.delete(record);
            host.writeU32(teb, previous);
        };
        return host.callGuest({ entry, args, thread, stackAtRest: record })
            .then(answer=>{
                done();
                return answer;
            });
    };
}

/**
 * What the loader tells an image: each of its routines -- its TLS callbacks,
 * then its entry point -- called with DllMain's three arguments, one after
 * another, every one guarded. The first waits until the call that asked has
 * suspended, and each later one until the one before has returned: the frame
 * goes below where the thread's own call left its stack, and by then the
 * processor may be running another thread, whose stack pointer is not this
 * one's.
 *
 * @param {GuardHost} host
 */
export function createEntryPointCaller(host){
    const call = createGuardedCaller(host);
    /**
     * @param {{ routines: number[], base: number, reason: number, reserved: number,
     *     thread: any }} image
     * @returns {Promise<number>} what the last routine answered, 0 when it raised
     */
    return ({ routines, base, reason, reserved, thread })=>routines.reduce(
        (told, entry)=>told.then(()=>call({
            entry, args: [base, reason, reserved], thread, failed: 0,
            report: code=>host.divergence?.(`exception 0x${code} in the routine at 0x${
                (entry >>> 0).toString(16)} of the image at 0x${(base >>> 0).toString(16)}`
                + ` (reason ${reason}), taken by the loader`),
        })),
        Promise.resolve(0));
}
