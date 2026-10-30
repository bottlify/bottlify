/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Table-based structured exception handling, as a 64-bit process uses it.
 *
 * A 64-bit thread keeps no handler chain. Every function's prologue is
 * described once in the image (`unwind.js`), and a function with a `__try` or
 * an object to destroy names a language handler in its unwind data. When an
 * exception is raised the dispatcher walks the frames from the fault upward,
 * undoing each with the unwinder to find the next, and offers the exception to
 * each frame's handler. A handler that takes it -- a `__except` whose filter
 * accepts, a `catch` whose type matches -- unwinds the frames below it,
 * running every `__finally` and destructor on the way, and sends the thread to
 * the handler's code. Nothing handling it ends the process.
 *
 * This is ntdll's `RtlDispatchException` and `RtlUnwindEx`. The language
 * handlers are the runtime's on a real machine; here the runtime is this
 * engine's, so the ones it exports -- the C handler `__C_specific_handler`
 * and the C++ frame handlers (`msvcrt/eh64.js`) -- are interpreted: given the
 * frame and the walk directly, they read the tables the compiler emitted and
 * call its filters, funclets and destructors as guest code with the frame
 * base the x64 convention gives them. A handler that is the program's own
 * code is called as Windows calls it, with the record, the frame, the context
 * and a DISPATCHER_CONTEXT, and a runtime handler it hands the frame on to
 * finds the walk again through that dispatcher context.
 *
 * Funclets run on the stack below the point the exception was raised at, as
 * they do under the system's dispatcher, so the frames being searched -- and
 * the thrown object a C++ catch reads -- stay whole until they are unwound.
 * A catch block is called by the dispatcher and keeps running after the
 * frames below its function are gone; a walk that leaves it continues in the
 * function it belongs to, at the registers the function had when the catch
 * was entered, as the system's consolidation frame makes it.
 */

import { EXCEPTION_NONCONTINUABLE, STATUS } from './seh.js';
import { UNW_FLAG, copyContext, stackOf } from './unwind.js';

export { STATUS };

/** EXCEPTION_RECORD at 64 bits: the code and flags, then quadword fields. */
export const RECORD64 = Object.freeze({
    CODE: 0x00,
    FLAGS: 0x04,
    NESTED: 0x08,
    ADDRESS: 0x10,
    PARAMETER_COUNT: 0x18,
    INFORMATION: 0x20,
    SIZE: 0x20 + 15 * 8,
});

/** EH_UNWINDING, EH_EXIT_UNWIND and EH_TARGET_UNWIND, as winnt.h names them. */
export const EH_UNWINDING = 0x02;
export const EH_EXIT_UNWIND = 0x04;
export const EH_TARGET_UNWIND = 0x20;

/** What a filter answers. */
const EXCEPTION_CONTINUE_SEARCH = 0;
const EXCEPTION_EXECUTE_HANDLER = 1;
const EXCEPTION_CONTINUE_EXECUTION = -1;

/** A disposition a language handler returns. */
export const Disposition = Object.freeze({
    CONTINUE_EXECUTION: 0,
    CONTINUE_SEARCH: 1,
    NESTED_EXCEPTION: 2,
    COLLIDED_UNWIND: 3,
});

/**
 * CONTEXT at 64 bits, the fields a handler's funclet reads or the engine
 * writes: the integer registers, RIP, the flags, MXCSR and the XMM registers.
 * The offsets are winnt.h's.
 */
export const CONTEXT64 = Object.freeze({
    FLAGS: 0x30,
    MXCSR: 0x34,
    EFLAGS: 0x44,
    RAX: 0x78,
    RIP: 0xf8,
    XMM0: 0x1a0,
    SIZE: 0x4d0,
});

/**
 * DISPATCHER_CONTEXT, what the dispatcher hands a language handler beside
 * the frame: quadwords but for the scope index.
 */
export const DISPATCHER64 = Object.freeze({
    CONTROL_PC: 0x00,
    IMAGE_BASE: 0x08,
    FUNCTION_ENTRY: 0x10,
    ESTABLISHER_FRAME: 0x18,
    TARGET_IP: 0x20,
    CONTEXT_RECORD: 0x28,
    LANGUAGE_HANDLER: 0x30,
    HANDLER_DATA: 0x38,
    HISTORY_TABLE: 0x40,
    SCOPE_INDEX: 0x48,
    SIZE: 0x50,
});

/** CONTEXT_AMD64 | CONTROL | INTEGER | FLOATING_POINT: what a captured one says it holds. */
const CONTEXT_FULL64 = 0x0010000b;

/** Frames a walk takes at most before the stack is taken as damaged. */
const WALK_LIMIT = 4096;

/**
 * How far below the point an exception was raised at its funclets start:
 * clear of the raising call's own frame, 16-aligned.
 */
const FLOOR_GAP = 0x100;

/**
 * Where a funclet the dispatcher called stands, once its frame has been
 * undone: the return into the call the bridge built, a few quadwords below
 * the stack the call was given.
 */
const NESTED_REACH = 0x100;

/** Codes raised by the processor, by their vector, reused from the 32-bit table's values. */
const VECTOR_TO_STATUS = Object.freeze({
    0: STATUS.INTEGER_DIVIDE_BY_ZERO,
    1: STATUS.SINGLE_STEP,
    3: STATUS.BREAKPOINT,
    4: STATUS.INTEGER_OVERFLOW,
    5: STATUS.ARRAY_BOUNDS_EXCEEDED,
    6: STATUS.ILLEGAL_INSTRUCTION,
    13: STATUS.ACCESS_VIOLATION,
    14: STATUS.ACCESS_VIOLATION,
    16: STATUS.FLOAT_DIVIDE_BY_ZERO,
    17: STATUS.DATATYPE_MISALIGNMENT,
    19: STATUS.FLOAT_MULTIPLE_TRAPS,
});

/** @param {number} value */
const hex = value=>`0x${(value >>> 0).toString(16)}`;

/**
 * @typedef {import('./unwind.js').UnwindContext} UnwindContext
 * @typedef {import('./unwind.js').FunctionEntry} FunctionEntry
 */

/**
 * An exception as the walk carries it.
 *
 * @typedef {Object} ExceptionRecord
 * @property {number} code
 * @property {number} flags
 * @property {number} address
 * @property {number[]} [parameters]
 */

/**
 * One frame a walk reached.
 *
 * @typedef {Object} FrameVisit
 * @property {FunctionEntry} fn       The entry the frame's address found.
 * @property {number} handler         Its language handler, absolute.
 * @property {number} handlerData     Where the handler's data begins.
 * @property {number} establisher     The frame's establisher frame.
 * @property {UnwindContext} context  The frame's own registers; RIP is its control PC.
 * @property {Map<string, any>} memo  Notes a handler leaves for a later frame of the same walk.
 */

/**
 * A funclet the dispatcher called and whose frame a later walk may meet:
 * where it was called from, and what the walk goes on with past it.
 *
 * @typedef {Object} NestedCall
 * @property {number} stack            The stack the call was given.
 * @property {UnwindContext} resume    The registers the walk takes on past the funclet.
 * @property {(pass: Pass) => Promise<void> | void} [abandoned]
 *     Told when an unwind takes the funclet's frame off the stack, the call
 *     never to return.
 */

/**
 * An exception's dispatch, as a language handler sees it.
 *
 * @typedef {Object} Pass
 * @property {ExceptionRecord} record
 * @property {UnwindContext} faultContext  The registers at the raise.
 * @property {any} thread
 * @property {number} floor  The stack funclets are called on.
 * @property {(entry: number, registers?: { rcx?: number, rdx?: number, r8?: number,
 *     r9?: number }) => Promise<number>} call
 *     Calls guest code on the floor with the argument registers set; answers EAX.
 * @property {(entry: number, registers: { rcx?: number, rdx?: number },
 *     resume: UnwindContext, abandoned?: (pass: Pass) => Promise<void> | void)
 *     => Promise<number>} callNested
 *     The same for a funclet that runs on after the frames below its function
 *     are unwound -- a catch block: a walk from inside it goes on at `resume`.
 * @property {(target: { frame: number, ip: number, state?: number }) => Promise<void>} unwindTo
 *     Runs the termination handlers of every frame from the raise up to the
 *     frame whose establisher is `frame`, that frame's own included.
 * @property {(context: UnwindContext) => any} continueAt
 *     The answer that sends the thread on at `context`, abandoning the rest.
 */

/**
 * A language handler this engine interprets rather than calls.
 *
 * @typedef {Object} Interpreter
 * @property {(visit: FrameVisit, pass: Pass) => Promise<any | null>} search
 *     The exception pass over one frame: the continuation the thread takes
 *     when the frame handles the exception, null to search on.
 * @property {(visit: FrameVisit, pass: Pass,
 *     target: { at: boolean, ip: number, state?: number }) => Promise<void>} unwind
 *     The unwind pass: the frame's termination handlers, down to the target's
 *     scope or state when it is the target.
 */

/**
 * @typedef {Object} Seh64Host
 * @property {ReturnType<typeof import('./unwind.js').createUnwinder>} unwinder
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => { gpr: bigint[], eflags: number, xmm: Uint8Array, mxcsr: number }} longState
 *     The running thread's registers whole (`cpu.longState`).
 * @property {(options: { entry: number, rcx?: number, rdx?: number, r8?: number, r9?: number,
 *     stack: number, thread?: any }) => Promise<number>} callFunclet
 *     Runs a funclet or filter with the x64 argument registers set and its
 *     stack at `stack`; answers EAX.
 * @property {(registers: { rip: number, rsp: number,
 *     long: { gpr: bigint[], xmm: Uint8Array, mxcsr: number } }) => any} continueAt
 *     Sends the thread on at a whole 64-bit context, abandoning the calls below.
 * @property {() => any} currentThread
 * @property {(thread: any, stack: number) => { rip: number, rsp: number } | null}
 *     [callbackCaller]  Where a routine the host called back returns to on the
 *     guest side: the call into the host that made the callback, by the stack
 *     the routine's frame left. Null when the stack is no such return.
 * @property {() => { stubs: number[], interpreter: Interpreter }[]} [interpreters]
 *     The runtime's own language handlers by their guest stub addresses,
 *     resolved once, lazily: the C++ frame handlers.
 * @property {() => number[]} [handlerStubs]  The guest stub addresses of this
 *     engine's own C language handlers.
 * @property {(text: string) => void} [trace]
 * @property {(what: { code: number, address: number }) => void} [terminate]
 */

/**
 * @param {Seh64Host} host
 */
export function createSeh64(host){
    const { unwinder } = host;
    const readU32 = (/** @type {number} */ at)=>{
        const bytes = host.readMemory(at >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} at */
    const readU64Low = at=>readU32(at);
    /** @param {number} at @param {number} value */
    const writeQuad = (at, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, BigInt(value >>> 0), true);
        host.writeMemory(at >>> 0, bytes);
    };

    /** The last top-level filter SetUnhandledExceptionFilter installed. */
    let topLevelFilter = 0;

    /**
     * The funclets each thread is inside that a walk may have to go past: a
     * catch block called by a C++ handler, innermost last.
     *
     * @type {WeakMap<object, NestedCall[]>}
     */
    const nestedBy = new WeakMap();
    /** @param {any} thread */
    const nestedOf = thread=>{
        let list = nestedBy.get(thread);
        if (!list)
        {
            list = [];
            nestedBy.set(thread, list);
        }
        return list;
    };

    /**
     * The dispatcher contexts of the program's own language handlers being
     * called now, by address: how a runtime handler the program's handler
     * hands its frame on to finds the walk.
     *
     * @type {Map<number, { visit: FrameVisit, pass: Pass,
     *     unwinding: { at: boolean, ip: number, state?: number } | null }>}
     */
    const dispatching = new Map();

    /**
     * The running thread's registers as an unwind context.
     *
     * @param {{ gpr?: bigint[], eflags?: number, xmm?: Uint8Array, mxcsr?: number }} [over]
     * @returns {UnwindContext}
     */
    const captureContext = (over = {})=>{
        const state = host.longState();
        return {
            gpr: (over.gpr ?? state.gpr).slice(),
            rip: 0,
            eflags: over.eflags ?? state.eflags,
            xmm: (over.xmm ?? state.xmm).slice(),
            mxcsr: over.mxcsr ?? state.mxcsr,
        };
    };

    /**
     * Writes an unwind context into a guest CONTEXT: the integer registers,
     * RIP, the flags, MXCSR and the XMM registers.
     *
     * @param {number} at @param {UnwindContext} context
     */
    const writeContext = (at, context)=>{
        const bytes = new Uint8Array(CONTEXT64.SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(CONTEXT64.FLAGS, CONTEXT_FULL64, true);
        view.setUint32(CONTEXT64.MXCSR, context.mxcsr >>> 0, true);
        context.gpr.forEach((value, index)=>
            view.setBigUint64(CONTEXT64.RAX + index * 8, BigInt.asUintN(64, value), true));
        view.setBigUint64(CONTEXT64.RIP, BigInt(context.rip >>> 0), true);
        view.setUint32(CONTEXT64.EFLAGS, context.eflags >>> 0, true);
        bytes.set(context.xmm.subarray(0, 256), CONTEXT64.XMM0);
        host.writeMemory(at, bytes);
    };

    /**
     * Reads a guest CONTEXT back into an unwind context.
     *
     * @param {number} at
     * @returns {UnwindContext}
     */
    const readContext = at=>{
        const bytes = host.readMemory(at, CONTEXT64.SIZE);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return {
            gpr: Array.from({ length: 16 }, (_, index)=>
                view.getBigUint64(CONTEXT64.RAX + index * 8, true)),
            rip: Number(view.getBigUint64(CONTEXT64.RIP, true) & 0xffffffffn),
            eflags: view.getUint32(CONTEXT64.EFLAGS, true),
            xmm: bytes.slice(CONTEXT64.XMM0, CONTEXT64.XMM0 + 256),
            mxcsr: view.getUint32(CONTEXT64.MXCSR, true),
        };
    };

    /**
     * Writes an EXCEPTION_RECORD where a filter or handler will read it.
     *
     * @param {number} at @param {ExceptionRecord} what
     */
    const writeRecord = (at, what)=>{
        const bytes = new Uint8Array(RECORD64.SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(RECORD64.CODE, what.code >>> 0, true);
        view.setUint32(RECORD64.FLAGS, what.flags >>> 0, true);
        view.setBigUint64(RECORD64.ADDRESS, BigInt(what.address >>> 0), true);
        const parameters = (what.parameters ?? []).slice(0, 15);
        view.setBigUint64(RECORD64.PARAMETER_COUNT, BigInt(parameters.length), true);
        parameters.forEach((value, index)=>
            view.setBigUint64(RECORD64.INFORMATION + index * 8, BigInt(value >>> 0), true));
        host.writeMemory(at, bytes);
    };

    /** EXCEPTION_POINTERS: the record and the context, each a quadword. */
    const pointerPair = (/** @type {number} */ record, /** @type {number} */ context)=>{
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        view.setBigUint64(0, BigInt(record >>> 0), true);
        view.setBigUint64(8, BigInt(context >>> 0), true);
        return bytes;
    };

    /**
     * The scratch below a floor: an exception record, a context, a
     * dispatcher context and an EXCEPTION_POINTERS, 16-aligned, and the stack
     * the routine handed them runs on below them.
     *
     * @param {number} floor
     */
    const scratchBelow = floor=>{
        const size = RECORD64.SIZE + CONTEXT64.SIZE + DISPATCHER64.SIZE + 0x10;
        const base = (floor - size & ~15) >>> 0;
        return {
            record: base,
            context: base + RECORD64.SIZE,
            dispatcher: base + RECORD64.SIZE + CONTEXT64.SIZE,
            pointers: base + RECORD64.SIZE + CONTEXT64.SIZE + DISPATCHER64.SIZE,
            top: base,
        };
    };

    /** @param {number} stack */
    const floorBelow = stack=>(stack - FLOOR_GAP & ~15) >>> 0;

    /**
     * Where this engine's own C language handler is in the guest, and the
     * interpreted C++ handlers: found by the stub a frame's handler address
     * is, or the import thunk that jumps to it.
     *
     * @type {Map<number, Interpreter>}
     */
    const interpreted = new Map();
    let seeded = false;
    /**
     * @param {number} address
     * @returns {Interpreter | null}
     */
    const interpreterFor = address=>{
        if (!seeded)
        {
            seeded = true;
            for (const stub of host.handlerStubs?.() ?? [])
            {
                if (stub !== 0)
                {
                    interpreted.set(stub >>> 0, scopeTable);
                }
            }
            for (const { stubs, interpreter } of host.interpreters?.() ?? [])
            {
                for (const stub of stubs)
                {
                    if (stub !== 0)
                    {
                        interpreted.set(stub >>> 0, interpreter);
                    }
                }
            }
        }
        const known = interpreted.get(address >>> 0);
        if (known)
        {
            return known;
        }
        // A jmp [rip+disp] thunk: follow it to the import slot and the stub.
        const bytes = host.readMemory(address >>> 0, 6);
        if (bytes[0] === 0xff && bytes[1] === 0x25)
        {
            const disp = (bytes[2] | bytes[3] << 8 | bytes[4] << 16 | bytes[5] << 24) | 0;
            const target = interpreted.get(readU32(address + 6 + disp >>> 0));
            if (target)
            {
                interpreted.set(address >>> 0, target);
                return target;
            }
        }
        return null;
    };

    /**
     * Takes one frame off `context`, which is left as the caller's: the frame
     * with its handler, a leaf, or the place past a funclet or callback the
     * engine itself called. Null where the walk can go no further.
     *
     * @param {UnwindContext} context @param {any} thread @param {number} type
     *     UNW_FLAG.EHANDLER for the exception pass, UHANDLER for the unwind.
     * @param {Map<string, any>} memo
     * @returns {{ visit?: FrameVisit, nested?: NestedCall } | null}
     */
    const step = (context, thread, type, memo)=>{
        const fn = unwinder.lookup(context.rip);
        if (fn)
        {
            const frameContext = copyContext(context);
            const unwound = unwinder.virtualUnwind(type, fn, context.rip, context);
            return { visit: { fn, handler: unwound.handler, handlerData: unwound.handlerData,
                establisher: unwound.establisher, context: frameContext, memo } };
        }
        if (unwinder.known(context.rip))
        {
            unwinder.unwindLeaf(context);
            return {};
        }
        // Outside every image: a return into a call the engine made. A catch
        // block the dispatcher called goes on in its function, at the
        // registers the function had when the catch was entered.
        const stack = stackOf(context);
        const list = nestedOf(thread);
        for (let index = list.length - 1; index >= 0; index--)
        {
            const nested = list[index];
            if (stack <= nested.stack && stack > nested.stack - NESTED_REACH)
            {
                const resume = copyContext(nested.resume);
                Object.assign(context, resume);
                return { nested };
            }
        }
        // A routine the host called back -- a comparator, a window
        // procedure -- returns into the guest code that called the host.
        const caller = host.callbackCaller?.(thread, stack);
        if (caller)
        {
            context.rip = caller.rip >>> 0;
            context.gpr[4] = BigInt(caller.rsp >>> 0);
            return {};
        }
        return null;
    };

    /**
     * Calls the program's own language handler for a frame, as the system
     * does: the record, the establisher frame, the context and a dispatcher
     * context; answers its disposition.
     *
     * @param {FrameVisit} visit @param {Pass} pass
     * @param {{ at: boolean, ip: number, state?: number } | null} unwinding
     */
    const callGuestHandler = async(visit, pass, unwinding)=>{
        const scratch = scratchBelow(pass.floor);
        const flags = unwinding
            ? pass.record.flags | EH_UNWINDING | (unwinding.at ? EH_TARGET_UNWIND : 0)
            : pass.record.flags;
        writeRecord(scratch.record, { ...pass.record, flags });
        writeContext(scratch.context, visit.context);
        const bytes = new Uint8Array(DISPATCHER64.SIZE);
        const view = new DataView(bytes.buffer);
        /** @param {number} at @param {number} value */
        const quad = (at, value)=>view.setBigUint64(at, BigInt(value >>> 0), true);
        quad(DISPATCHER64.CONTROL_PC, visit.context.rip);
        quad(DISPATCHER64.IMAGE_BASE, visit.fn.imageBase);
        quad(DISPATCHER64.FUNCTION_ENTRY, visit.fn.entry);
        quad(DISPATCHER64.ESTABLISHER_FRAME, visit.establisher);
        quad(DISPATCHER64.TARGET_IP, unwinding?.ip ?? 0);
        quad(DISPATCHER64.CONTEXT_RECORD, scratch.context);
        quad(DISPATCHER64.LANGUAGE_HANDLER, visit.handler);
        quad(DISPATCHER64.HANDLER_DATA, visit.handlerData);
        host.writeMemory(scratch.dispatcher, bytes);
        dispatching.set(scratch.dispatcher, { visit,
            pass: passFor(pass.record, pass.faultContext, pass.thread, scratch.top), unwinding });
        try
        {
            const answer = await host.callFunclet({
                entry: visit.handler, rcx: scratch.record, rdx: visit.establisher,
                r8: scratch.context, r9: scratch.dispatcher, stack: scratch.top,
                thread: pass.thread,
            });
            return { answer: answer >>> 0, context: scratch.context };
        }
        finally
        {
            dispatching.delete(scratch.dispatcher);
        }
    };

    /**
     * The unwind pass of a walk: from the raise up to the target frame, each
     * frame's termination handlers, the target's own included. Funclets the
     * unwind takes off the stack are told they will not return.
     *
     * @param {Pass} pass
     * @param {{ frame: number, ip: number, state?: number }} target
     *     The target's establisher frame -- zero to unwind every frame -- and
     *     the address and C++ state the thread goes on at there.
     * @returns {Promise<UnwindContext>} the target frame's own registers, or
     *     where the walk ended when it never met the target
     */
    const unwindFrames = async(pass, target)=>{
        const everything = (target.frame >>> 0) === 0;
        const context = copyContext(pass.faultContext);
        /** @type {Map<string, any>} */
        const memo = new Map();
        const unwindingPass = passFor({ ...pass.record,
            flags: pass.record.flags | EH_UNWINDING | (everything ? EH_EXIT_UNWIND : 0) },
        pass.faultContext, pass.thread, pass.floor);
        const list = nestedOf(pass.thread);
        for (let guard = 0; guard < WALK_LIMIT; guard++)
        {
            const taken = step(context, pass.thread, UNW_FLAG.UHANDLER, memo);
            if (!taken)
            {
                break;
            }
            if (taken.nested)
            {
                const at = list.indexOf(taken.nested);
                if (at >= 0)
                {
                    const gone = list.splice(at);
                    for (const nested of gone.reverse())
                    {
                        await nested.abandoned?.(pass);
                    }
                }
                continue;
            }
            const visit = taken.visit;
            if (!visit)
            {
                continue;
            }
            const atTarget = !everything && (visit.establisher >>> 0) === (target.frame >>> 0);
            if (visit.handler !== 0)
            {
                const options = { at: atTarget, ip: target.ip >>> 0,
                    ...target.state === undefined ? {} : { state: target.state } };
                const interpreter = interpreterFor(visit.handler);
                if (interpreter)
                {
                    await interpreter.unwind(visit, unwindingPass, options);
                }
                else
                {
                    await callGuestHandler(visit, unwindingPass, options);
                }
            }
            if (atTarget)
            {
                return visit.context;
            }
            if (!everything && stackOf(context) > (target.frame >>> 0))
            {
                // Past the target without meeting it: the target is not on the
                // stack, which is the caller's error. Nothing more is unwound.
                break;
            }
        }
        return context;
    };

    /**
     * A dispatch's pass object, from the record and the registers at the raise.
     *
     * @param {ExceptionRecord} record @param {UnwindContext} faultContext @param {any} thread
     * @param {number} [floor]
     * @returns {Pass}
     */
    const passFor = (record, faultContext, thread, floor = floorBelow(stackOf(faultContext)))=>{
        /** @type {Pass} */
        const pass = {
            record,
            faultContext,
            thread,
            floor,
            call: (entry, registers = {})=>host.callFunclet({
                entry, ...registers, stack: pass.floor, thread,
            }),
            callNested: async(entry, registers, resume, abandoned)=>{
                const list = nestedOf(thread);
                /** @type {NestedCall} */
                const nested = { stack: pass.floor, resume: copyContext(resume),
                    ...abandoned ? { abandoned } : {} };
                list.push(nested);
                try
                {
                    return await host.callFunclet({ entry, ...registers, stack: pass.floor,
                        thread });
                }
                finally
                {
                    const at = list.indexOf(nested);
                    if (at >= 0)
                    {
                        list.splice(at, 1);
                    }
                }
            },
            unwindTo: async target=>{
                await unwindFrames(pass, target);
            },
            continueAt: context=>host.continueAt({
                rip: context.rip >>> 0,
                rsp: stackOf(context),
                long: { gpr: context.gpr.slice(), xmm: context.xmm.slice(), mxcsr: context.mxcsr },
            }),
        };
        return pass;
    };

    /**
     * RtlUnwindEx: unwinds from `context` up to `targetFrame`, running every
     * frame's termination handler (the `__finally` funclets and C++
     * destructors) on the way, then sends the thread to `targetIp` with
     * `returnValue` in RAX. The call that started the unwind does not return.
     *
     * @param {UnwindContext} context  Where the unwind starts.
     * @param {number} targetFrame
     * @param {number} targetIp
     * @param {number} returnValue
     * @param {ExceptionRecord} record
     * @param {any} thread
     * @returns {Promise<any>} the continuation the thread takes
     */
    const unwindEx = async(context, targetFrame, targetIp, returnValue, record, thread)=>{
        const pass = passFor(record, context, thread);
        // The target frame is not itself unwound -- execution goes on inside it
        // with its own registers.
        const resume = copyContext(await unwindFrames(pass,
            { frame: targetFrame >>> 0, ip: targetIp >>> 0 }));
        resume.rip = targetIp >>> 0;
        resume.gpr[0] = BigInt(returnValue >>> 0);
        return pass.continueAt(resume);
    };

    /**
     * The C language handler, `__C_specific_handler`: its scope table read
     * from the handler data -- a count, then that many {begin, end, handler,
     * target} as RVAs, innermost first.
     *
     * @type {Interpreter}
     */
    const scopeTable = {
        async search(visit, pass){
            const scopes = readScopeTable(visit.handlerData);
            const controlPc = visit.context.rip - visit.fn.imageBase >>> 0;
            const establisher = visit.establisher;
            for (const scope of scopes)
            {
                if (controlPc < scope.begin || controlPc >= scope.end || scope.target === 0)
                {
                    continue;
                }
                // A filter of 1 is EXCEPTION_EXECUTE_HANDLER with no funclet;
                // else the filter funclet runs with EXCEPTION_POINTERS in RCX
                // and the frame in RDX.
                let answer = EXCEPTION_EXECUTE_HANDLER;
                if (scope.handler !== 1)
                {
                    const scratch = scratchBelow(pass.floor);
                    writeRecord(scratch.record, pass.record);
                    writeContext(scratch.context, visit.context);
                    host.writeMemory(scratch.pointers,
                        pointerPair(scratch.record, scratch.context));
                    answer = await host.callFunclet({
                        entry: visit.fn.imageBase + scope.handler >>> 0,
                        rcx: scratch.pointers, rdx: establisher, stack: scratch.top,
                        thread: pass.thread,
                    }) | 0;
                }
                if (answer === EXCEPTION_CONTINUE_SEARCH)
                {
                    continue;
                }
                if (answer === EXCEPTION_CONTINUE_EXECUTION)
                {
                    return pass.continueAt(pass.faultContext);
                }
                // Accepted: unwind the frames below the __except to it and jump in.
                const targetIp = visit.fn.imageBase + scope.target >>> 0;
                const resume = copyContext(await unwindFrames(pass,
                    { frame: establisher, ip: targetIp }));
                resume.rip = targetIp;
                resume.gpr[0] = BigInt(pass.record.code >>> 0);
                return pass.continueAt(resume);
            }
            return null;
        },

        // The __finally funclets, the scopes with no jump target: every one
        // around the frame's address, and at the target only those inside the
        // scope the unwind goes to. A __finally funclet takes RCX the
        // abnormal-termination flag and RDX the establisher frame.
        async unwind(visit, pass, target){
            const scopes = readScopeTable(visit.handlerData);
            const controlPc = visit.context.rip - visit.fn.imageBase >>> 0;
            const targetPc = target.ip - visit.fn.imageBase >>> 0;
            for (const scope of scopes)
            {
                if (controlPc < scope.begin || controlPc >= scope.end)
                {
                    continue;
                }
                if (target.at && scope.target === targetPc)
                {
                    break;
                }
                if (scope.target !== 0 || scope.handler === 0)
                {
                    continue;
                }
                await pass.call(visit.fn.imageBase + scope.handler >>> 0,
                    { rcx: 1, rdx: visit.establisher });
            }
        },
    };

    /**
     * @param {number} at
     * @returns {{ begin: number, end: number, handler: number, target: number }[]}
     */
    const readScopeTable = at=>{
        const count = readU32(at);
        /** @type {{ begin: number, end: number, handler: number, target: number }[]} */
        const scopes = [];
        for (let index = 0; index < Math.min(count, WALK_LIMIT); index++)
        {
            const entry = at + 4 + index * 16;
            scopes.push({
                begin: readU32(entry), end: readU32(entry + 4),
                handler: readU32(entry + 8), target: readU32(entry + 12),
            });
        }
        return scopes;
    };

    /**
     * RtlDispatchException: walks the frames from the fault, offering the
     * exception to each frame's handler until one takes it.
     *
     * @param {{ code: number, flags?: number, address: number, parameters?: number[] }} what
     * @param {UnwindContext} faultContext
     * @returns {Promise<{ handled: boolean, continuation?: any }>}
     */
    const dispatch = async(what, faultContext)=>{
        /** @type {ExceptionRecord} */
        const record = { code: what.code >>> 0, flags: what.flags ?? 0,
            address: what.address >>> 0,
            ...what.parameters ? { parameters: what.parameters } : {} };
        host.trace?.(`exception ${hex(record.code)} at ${hex(record.address)}`);
        const thread = host.currentThread();
        const pass = passFor(record, faultContext, thread);
        // A dispatcher context below this raise belongs to a walk a handler
        // left by sending the thread on: nothing will hand it on again.
        for (const address of dispatching.keys())
        {
            if (address < pass.floor && dispatching.get(address)?.pass.thread === thread)
            {
                dispatching.delete(address);
            }
        }
        const context = copyContext(faultContext);
        /** @type {Map<string, any>} */
        const memo = new Map();
        for (let guard = 0; guard < WALK_LIMIT; guard++)
        {
            const before = { rip: context.rip >>> 0, stack: stackOf(context) };
            const taken = step(context, thread, UNW_FLAG.EHANDLER, memo);
            if (!taken)
            {
                break;
            }
            const visit = taken.visit;
            if (visit && visit.handler !== 0)
            {
                const interpreter = interpreterFor(visit.handler);
                if (interpreter)
                {
                    const continuation = await interpreter.search(visit, pass);
                    if (continuation)
                    {
                        return { handled: true, continuation };
                    }
                }
                else
                {
                    const { answer, context: written } = await callGuestHandler(visit, pass, null);
                    if (answer === Disposition.CONTINUE_EXECUTION
                        && (record.flags & EXCEPTION_NONCONTINUABLE) === 0)
                    {
                        return { handled: true,
                            continuation: pass.continueAt(readContext(written)) };
                    }
                }
            }
            if ((context.rip >>> 0) === before.rip && stackOf(context) === before.stack)
            {
                break;
            }
        }
        return { handled: false };
    };

    /**
     * An exception nothing took: the last-chance filter, then the process
     * ends with the exception's code.
     *
     * @param {{ code: number, flags?: number, address: number, parameters?: number[] }} what
     * @param {UnwindContext} faultContext
     * @returns {Promise<{ handled: boolean, continuation?: any }>}
     */
    const lastChance = async(what, faultContext)=>{
        if (topLevelFilter !== 0)
        {
            const scratch = scratchBelow(floorBelow(stackOf(faultContext)));
            writeRecord(scratch.record, { code: what.code >>> 0, flags: what.flags ?? 0,
                address: what.address >>> 0,
                ...what.parameters ? { parameters: what.parameters } : {} });
            writeContext(scratch.context, faultContext);
            host.writeMemory(scratch.pointers, pointerPair(scratch.record, scratch.context));
            const answer = await host.callFunclet({
                entry: topLevelFilter, rcx: scratch.pointers, stack: scratch.top,
                thread: host.currentThread(),
            }) | 0;
            if (answer === EXCEPTION_CONTINUE_EXECUTION
                && ((what.flags ?? 0) & EXCEPTION_NONCONTINUABLE) === 0)
            {
                return { handled: true, continuation: host.continueAt({
                    rip: faultContext.rip, rsp: stackOf(faultContext),
                    long: { gpr: faultContext.gpr.slice(), xmm: faultContext.xmm.slice(),
                        mxcsr: faultContext.mxcsr },
                }) };
            }
        }
        host.trace?.(`unhandled exception ${hex(what.code)} at ${hex(what.address)}`);
        host.terminate?.({ code: what.code >>> 0, address: what.address >>> 0 });
        return { handled: false };
    };

    /**
     * An exception raised or faulted: dispatched, then the last chance.
     *
     * @param {{ code: number, flags?: number, address: number, parameters?: number[] }} what
     * @param {UnwindContext} faultContext
     */
    const raiseOn = async(what, faultContext)=>{
        const result = await dispatch(what, faultContext);
        if (result.handled)
        {
            return result;
        }
        return lastChance(what, faultContext);
    };

    /**
     * The caller's registers as it stands at a host call this engine answers:
     * the non-volatiles as the stub left them, RIP the return address at the
     * current RSP and RSP past it. Enough for an unwind, which reads only the
     * stack, RSP, RIP and the non-volatiles.
     */
    const callerContext = ()=>{
        const context = captureContext();
        const rsp = stackOf(context);
        context.rip = readU64Low(rsp);
        context.gpr[4] = BigInt(rsp + 8 >>> 0);
        return context;
    };

    return {
        dispatch,
        unwindEx,
        captureContext,
        writeContext,
        readContext,
        raiseOn,

        /**
         * Raises an exception from the host call being answered, as
         * RaiseException does: dispatched from the caller's registers; the
         * answer is the continuation a handler sent the thread on with, or
         * zero once the process has been ended.
         *
         * @param {{ code: number, flags?: number, parameters?: number[] }} what
         */
        raise(what){
            const context = callerContext();
            return raiseOn({ ...what, address: context.rip }, context)
                .then(result=>result.continuation ?? 0);
        },

        /**
         * The walk a dispatcher context the program's handler was handed
         * belongs to, for a runtime handler it hands the frame on to; with the
         * floor moved below where that handler stands now. Null for a
         * dispatcher context this dispatcher did not make.
         *
         * @param {number} address
         */
        dispatcherContextAt(address){
            const found = dispatching.get(address >>> 0);
            if (!found)
            {
                return null;
            }
            const { pass } = found;
            const floor = Math.min(pass.floor, floorBelow(stackOf(captureContext())));
            return { ...found, pass: passFor(pass.record, pass.faultContext, pass.thread, floor) };
        },

        /** @param {number} vector */
        claims: vector=>Object.hasOwn(VECTOR_TO_STATUS, vector),

        /**
         * A processor fault, offered to the program's handlers before it
         * becomes a failure.
         *
         * @param {{ vector: number, eip: number, errorCode: number | null,
         *     address?: number }} fault
         * @param {UnwindContext} faultContext  The faulting code's registers,
         *        RIP among them.
         * @returns {Promise<{ handled: boolean, continuation?: any }>}
         */
        async onFault(fault, faultContext){
            const code = VECTOR_TO_STATUS[/** @type {keyof typeof VECTOR_TO_STATUS} */
                (fault.vector)];
            if (code === undefined)
            {
                return { handled: false };
            }
            const parameters = code === STATUS.ACCESS_VIOLATION
                ? [(fault.errorCode ?? 0) & 2 ? 1 : 0,
                    fault.vector === 13 ? 0xffffffff : (fault.address ?? 0) >>> 0]
                : [];
            const result = await dispatch({ code, address: faultContext.rip, parameters },
                faultContext);
            if (result.handled)
            {
                return result;
            }
            if (topLevelFilter === 0)
            {
                return { handled: false };
            }
            return lastChance({ code, address: faultContext.rip, parameters }, faultContext);
        },

        /** The host half a 64-bit process binds. */
        table: {
            /**
             * VOID RtlCaptureContext(PCONTEXT ContextRecord)
             *
             * The caller's registers, as they are at the call: the context is
             * what the caller would see on return, so RIP is the return
             * address and RSP is past it.
             */
            RtlCaptureContext: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([out])=>{
                    // The stub has not moved the non-volatiles the unwinder reads.
                    writeContext(out >>> 0, callerContext());
                    return 0;
                },
            },

            /**
             * PVOID RtlPcToFileHeader(PVOID PcValue, PVOID *BaseOfImage)
             *
             * The base of the image holding an address, written and answered;
             * NULL for one in no image. A 64-bit C++ runtime asks it when it
             * throws, to read its throw information's image-relative fields.
             */
            RtlPcToFileHeader: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([pc, baseOut])=>{
                    const base = unwinder.imageBase(pc >>> 0);
                    if ((baseOut >>> 0) !== 0)
                    {
                        writeQuad(baseOut >>> 0, base);
                    }
                    return BigInt(base >>> 0);
                },
            },

            /**
             * PRUNTIME_FUNCTION RtlLookupFunctionEntry(DWORD64 ControlPc,
             *     PDWORD64 ImageBase, PUNWIND_HISTORY_TABLE HistoryTable)
             */
            RtlLookupFunctionEntry: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([pc, imageBaseOut])=>{
                    const fn = unwinder.lookup(pc >>> 0);
                    if (!fn)
                    {
                        return 0n;
                    }
                    if ((imageBaseOut >>> 0) !== 0)
                    {
                        writeQuad(imageBaseOut >>> 0, fn.imageBase);
                    }
                    return BigInt(fn.entry >>> 0);
                },
            },

            /**
             * PEXCEPTION_ROUTINE RtlVirtualUnwind(DWORD HandlerType,
             *     DWORD64 ImageBase, DWORD64 ControlPc, PRUNTIME_FUNCTION FunctionEntry,
             *     PCONTEXT ContextRecord, PVOID *HandlerData, PDWORD64 EstablisherFrame,
             *     PKNONVOLATILE_CONTEXT_POINTERS ContextPointers)
             */
            RtlVirtualUnwind: {
                argBytes: 32,
                /** @param {number[]} args */
                handler: ([type, imageBase, controlPc, functionEntry, contextRecord,
                    handlerDataOut, establisherOut])=>{
                    const fn = unwinder.entryAt(imageBase >>> 0, functionEntry >>> 0);
                    const context = readContext(contextRecord >>> 0);
                    const unwound = unwinder.virtualUnwind(type >>> 0, fn, controlPc >>> 0,
                        context);
                    writeContext(contextRecord >>> 0, context);
                    if ((handlerDataOut >>> 0) !== 0)
                    {
                        writeQuad(handlerDataOut >>> 0, unwound.handlerData);
                    }
                    if ((establisherOut >>> 0) !== 0)
                    {
                        writeQuad(establisherOut >>> 0, unwound.establisher);
                    }
                    return BigInt(unwound.handler >>> 0);
                },
            },

            /**
             * VOID RtlUnwindEx(PVOID TargetFrame, PVOID TargetIp,
             *     PEXCEPTION_RECORD ExceptionRecord, PVOID ReturnValue,
             *     PCONTEXT ContextRecord, PUNWIND_HISTORY_TABLE HistoryTable)
             *
             * Unwinds to the target, running every termination handler, then
             * continues at the target. It does not return.
             */
            RtlUnwindEx: {
                argBytes: 24,
                /** @param {number[]} args */
                handler: ([targetFrame, targetIp, recordPtr, returnValue, contextRecord])=>{
                    const context = (contextRecord >>> 0) !== 0
                        ? readContext(contextRecord >>> 0) : callerContext();
                    const record = (recordPtr >>> 0) !== 0
                        ? { code: readU32(recordPtr + RECORD64.CODE),
                            flags: readU32(recordPtr + RECORD64.FLAGS),
                            address: context.rip }
                        : { code: STATUS.UNWIND, flags: EH_UNWINDING, address: context.rip };
                    return unwindEx(context, targetFrame >>> 0, targetIp >>> 0, returnValue >>> 0,
                        record, host.currentThread());
                },
            },

            /**
             * EXCEPTION_DISPOSITION __C_specific_handler(...)
             *
             * The C language handler named in a function's unwind data. The
             * dispatcher interprets its scope table directly rather than
             * running it, so a direct call -- which is not how it is reached --
             * only says the search goes on.
             */
            __C_specific_handler: {
                argBytes: 32, lastError: false,
                handler: ()=>Disposition.CONTINUE_SEARCH,
            },

            /**
             * BOOLEAN RtlAddFunctionTable(PRUNTIME_FUNCTION FunctionTable,
             *     DWORD EntryCount, DWORD64 BaseAddress)
             */
            RtlAddFunctionTable: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([table, count, base])=>
                    (unwinder.add(table >>> 0, count >>> 0, base >>> 0) ? 1 : 0),
            },

            /** BOOLEAN RtlDeleteFunctionTable(PRUNTIME_FUNCTION FunctionTable) */
            RtlDeleteFunctionTable: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([table])=>(unwinder.remove(table >>> 0) ? 1 : 0),
            },

            /**
             * LPTOP_LEVEL_EXCEPTION_FILTER SetUnhandledExceptionFilter(
             *     LPTOP_LEVEL_EXCEPTION_FILTER)
             */
            SetUnhandledExceptionFilter: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([filter])=>{
                    const previous = topLevelFilter;
                    topLevelFilter = filter >>> 0;
                    return BigInt(previous >>> 0);
                },
            },

            /**
             * VOID RaiseException(DWORD Code, DWORD Flags, DWORD Count,
             *     const ULONG_PTR *Arguments)
             *
             * The exception is dispatched from the caller's context; a handler
             * that takes it sends the thread elsewhere and this never returns,
             * and nothing taking it ends the process.
             */
            RaiseException: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([code, flags, count, argsPtr])=>{
                    const from = argsPtr >>> 0;
                    const total = from === 0 ? 0 : Math.min(count >>> 0, 15);
                    /** @type {number[]} */
                    const parameters = [];
                    for (let index = 0; index < total; index++)
                    {
                        parameters.push(readU64Low(from + index * 8));
                    }
                    const context = callerContext();
                    return raiseOn({ code: code >>> 0,
                        flags: flags >>> 0 & EXCEPTION_NONCONTINUABLE,
                        address: context.rip, parameters }, context)
                        .then(result=>result.continuation ?? 0);
                },
            },
        },
    };
}
