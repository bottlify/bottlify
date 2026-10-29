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
 * This is ntdll's `RtlDispatchException` and `RtlUnwindEx`, and the language
 * handler `__C_specific_handler` the C compiler names for `__try`. The handler
 * is the runtime's on a real machine; here the runtime is this engine's, so it
 * is interpreted rather than run as guest code -- the scope table it reads is
 * the one the compiler emitted, and its filters and `__finally` blocks are the
 * funclets the compiler emitted, called as guest code with the frame base the
 * x64 convention gives them.
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

/** EH_UNWINDING and EH_EXIT_UNWIND, as the 32-bit walk names them. */
export const EH_UNWINDING = 0x02;
export const EH_EXIT_UNWIND = 0x04;

/** What a filter answers. */
const EXCEPTION_CONTINUE_SEARCH = 0;
const EXCEPTION_EXECUTE_HANDLER = 1;
const EXCEPTION_CONTINUE_EXECUTION = -1;

/** A disposition a language handler returns. */
export const Disposition = Object.freeze({
    CONTINUE_EXECUTION: 0,
    CONTINUE_SEARCH: 1,
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

/** CONTEXT_AMD64 | CONTROL | INTEGER | FLOATING_POINT: what a captured one says it holds. */
const CONTEXT_FULL64 = 0x0010000b;

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
 * @property {() => number[]} [handlerStubs]  The guest stub addresses of this
 *     engine's own C language handlers, so a frame naming one has its scope
 *     table read directly; resolved once, lazily.
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
    /** @param {number} at @param {number} value */
    const writeQuad = (at, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, BigInt(value >>> 0), true);
        host.writeMemory(at >>> 0, bytes);
    };

    /** The last top-level filter SetUnhandledExceptionFilter installed. */
    let topLevelFilter = 0;

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
     * Writes an EXCEPTION_RECORD where a filter will read it.
     *
     * @param {number} at
     * @param {{ code: number, flags: number, address: number, parameters?: number[] }} what
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

    /**
     * The scratch a handler's funclets run on, below the establisher frame:
     * the record, the context, an EXCEPTION_POINTERS, all clear of where the
     * funclet will push, 16-aligned.
     *
     * @param {number} below
     */
    const scratchBelow = below=>{
        const base = (below - (RECORD64.SIZE + CONTEXT64.SIZE + 0x40) & ~15) >>> 0;
        return { record: base, context: base + RECORD64.SIZE,
            pointers: base + RECORD64.SIZE + CONTEXT64.SIZE, top: base };
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
     * @param {{ code: number, flags: number, address: number, parameters?: number[] }} record
     * @param {any} thread
     * @returns {Promise<any>} the continuation the thread takes
     */
    const unwindEx = async(context, targetFrame, targetIp, returnValue, record, thread)=>{
        const everything = (targetFrame >>> 0) === 0;
        const flags = record.flags | EH_UNWINDING | (everything ? EH_EXIT_UNWIND : 0);
        // The context to resume at: the target frame's own registers, which is
        // the frame reached when its establisher meets the target. The target
        // frame is not itself unwound -- execution goes on inside it.
        let resume = context;
        for (let guard = 0; guard < 4096; guard++)
        {
            const fn = unwinder.lookup(context.rip);
            if (!fn)
            {
                if (!unwinder.known(context.rip))
                {
                    break;
                }
                unwinder.unwindLeaf(context);
                resume = context;
                continue;
            }
            // The frame's own registers, before it is unwound: what its
            // termination handler reads, and -- at the target -- what the
            // thread resumes with.
            const frameContext = copyContext(context);
            const unwound = unwinder.virtualUnwind(UNW_FLAG.UHANDLER, fn, context.rip, context);
            const atTarget = !everything && (unwound.establisher >>> 0) === (targetFrame >>> 0);
            if (unwound.handler !== 0)
            {
                // At the target the frame's own `__finally` blocks between the
                // raising scope and the target scope still run, so its handler
                // is called before the walk stops.
                await runTermination(unwound, fn, frameContext, unwound.establisher,
                    { ...record, flags }, thread);
            }
            if (atTarget)
            {
                resume = frameContext;
                break;
            }
            if (!everything && stackOf(context) > (targetFrame >>> 0))
            {
                // Past the target without meeting it: the target is not on the
                // stack, which is the caller's error. Nothing more is unwound.
                break;
            }
            resume = context;
        }
        resume.rip = targetIp >>> 0;
        resume.gpr[0] = BigInt(returnValue >>> 0);
        return host.continueAt({
            rip: targetIp >>> 0,
            rsp: stackOf(resume),
            long: { gpr: resume.gpr.slice(), xmm: resume.xmm.slice(), mxcsr: resume.mxcsr },
        });
    };

    /**
     * Runs a frame's termination handlers for the unwind pass: the `__finally`
     * funclets `__C_specific_handler` names with a null jump target.
     *
     * @param {import('./unwind.js').Unwound} unwound
     * @param {import('./unwind.js').FunctionEntry} fn
     * @param {UnwindContext} frameContext  The frame's own registers.
     * @param {number} establisher
     * @param {{ code: number, flags: number, address: number }} record
     * @param {any} thread
     */
    const runTermination = async(unwound, fn, frameContext, establisher, record, thread)=>{
        if (!isKnownHandler(unwound.handler))
        {
            return;
        }
        const scopes = readScopeTable(unwound.handlerData);
        const controlPc = frameContext.rip - fn.imageBase >>> 0;
        for (const scope of scopes)
        {
            if (controlPc < scope.begin || controlPc >= scope.end || scope.target !== 0
                || scope.handler === 0)
            {
                continue;
            }
            const scratch = scratchBelow(establisher);
            // A __finally funclet takes RCX the abnormal-termination flag and
            // RDX the establisher frame; it reads its parent's locals through
            // the frame.
            await host.callFunclet({
                entry: fn.imageBase + scope.handler >>> 0,
                rcx: 1, rdx: establisher, stack: scratch.top, thread,
            });
        }
    };

    /**
     * The scope table `__C_specific_handler` reads from its handler data: a
     * count, then that many {begin, end, handler, target} as RVAs.
     *
     * @param {number} at
     * @returns {{ begin: number, end: number, handler: number, target: number }[]}
     */
    const readScopeTable = at=>{
        const count = readU32(at);
        /** @type {{ begin: number, end: number, handler: number, target: number }[]} */
        const scopes = [];
        for (let index = 0; index < Math.min(count, 4096); index++)
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
     * Where this engine's own `__C_specific_handler` is in the guest, resolved
     * through the import thunk its address points at, so a handler data block
     * can be told to be its scope table. Set once the table is bound.
     *
     * @type {Set<number>}
     */
    const knownHandlers = new Set();
    let seeded = false;
    /** @param {number} address */
    const isKnownHandler = address=>{
        if (!seeded)
        {
            seeded = true;
            for (const stub of host.handlerStubs?.() ?? [])
            {
                if (stub !== 0)
                {
                    knownHandlers.add(stub >>> 0);
                }
            }
        }
        if (knownHandlers.has(address >>> 0))
        {
            return true;
        }
        // A jmp [rip+disp] thunk: follow it to the import slot and the stub.
        const bytes = host.readMemory(address >>> 0, 6);
        if (bytes[0] === 0xff && bytes[1] === 0x25)
        {
            const disp = (bytes[2] | bytes[3] << 8 | bytes[4] << 16 | bytes[5] << 24) | 0;
            const slot = address + 6 + disp >>> 0;
            const target = readU32(slot);
            if (knownHandlers.has(target >>> 0))
            {
                knownHandlers.add(address >>> 0);
                return true;
            }
        }
        return false;
    };

    /**
     * The exception pass over one frame with a C handler: finds a `__except`
     * whose filter accepts and, on acceptance, unwinds to it; else says to
     * keep searching.
     *
     * @param {import('./unwind.js').Unwound} unwound
     * @param {import('./unwind.js').FunctionEntry} fn
     * @param {UnwindContext} frameContext  The faulting frame's own registers.
     * @param {UnwindContext} faultContext  The whole thread at the fault, for the unwind.
     * @param {{ code: number, flags: number, address: number, parameters?: number[] }} record
     * @param {any} thread
     * @returns {Promise<{ handled: boolean, continuation?: any }>}
     */
    const runException = async(unwound, fn, frameContext, faultContext, record, thread)=>{
        const scopes = readScopeTable(unwound.handlerData);
        const controlPc = frameContext.rip - fn.imageBase >>> 0;
        const establisher = unwound.establisher;
        for (const scope of scopes)
        {
            if (controlPc < scope.begin || controlPc >= scope.end || scope.target === 0)
            {
                continue;
            }
            // A filter of 1 is EXCEPTION_EXECUTE_HANDLER with no funclet; else
            // the filter funclet runs with EXCEPTION_POINTERS in RCX and the
            // frame in RDX.
            let answer = EXCEPTION_EXECUTE_HANDLER;
            if (scope.handler !== 1)
            {
                const scratch = scratchBelow(establisher);
                writeRecord(scratch.record, record);
                writeContext(scratch.context, frameContext);
                host.writeMemory(scratch.pointers, pointerPair(scratch.record, scratch.context));
                answer = await host.callFunclet({
                    entry: fn.imageBase + scope.handler >>> 0,
                    rcx: scratch.pointers, rdx: establisher, stack: scratch.top, thread,
                }) | 0;
            }
            if (answer === EXCEPTION_CONTINUE_SEARCH)
            {
                continue;
            }
            if (answer === EXCEPTION_CONTINUE_EXECUTION)
            {
                return { handled: true, continuation: host.continueAt({
                    rip: faultContext.rip, rsp: stackOf(faultContext),
                    long: { gpr: faultContext.gpr.slice(), xmm: faultContext.xmm.slice(),
                        mxcsr: faultContext.mxcsr },
                }) };
            }
            // Accepted: unwind the frames below the __except to it and jump in.
            const continuation = await unwindEx(copyContext(faultContext), establisher,
                fn.imageBase + scope.target >>> 0, record.code, record, thread);
            return { handled: true, continuation };
        }
        return { handled: false };
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
     * RtlDispatchException: walks the frames from the fault, offering the
     * exception to each frame's handler until one takes it.
     *
     * @param {{ code: number, flags?: number, address: number, parameters?: number[] }} what
     * @param {UnwindContext} faultContext
     * @returns {Promise<{ handled: boolean, continuation?: any }>}
     */
    const dispatch = async(what, faultContext)=>{
        const record = { code: what.code >>> 0, flags: what.flags ?? 0,
            address: what.address >>> 0, parameters: what.parameters };
        host.trace?.(`exception ${hex(record.code)} at ${hex(record.address)}`);
        const context = copyContext(faultContext);
        for (let guard = 0; guard < 4096; guard++)
        {
            const fn = unwinder.lookup(context.rip);
            if (!fn)
            {
                if (!unwinder.known(context.rip))
                {
                    break;
                }
                unwinder.unwindLeaf(context);
                continue;
            }
            const frameContext = copyContext(context);
            const unwound = unwinder.virtualUnwind(UNW_FLAG.EHANDLER, fn, context.rip, context);
            if (unwound.handler !== 0 && isKnownHandler(unwound.handler))
            {
                const result = await runException(unwound, fn, frameContext, faultContext,
                    record, host.currentThread());
                if (result.handled)
                {
                    return result;
                }
            }
            else if (unwound.handler !== 0)
            {
                host.trace?.(`a handler at ${hex(unwound.handler)} this runtime does not `
                    + 'interpret; the frame is passed over');
            }
            if ((context.rip >>> 0) === (frameContext.rip >>> 0)
                && stackOf(context) === stackOf(frameContext))
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
            const scratch = scratchBelow(stackOf(faultContext));
            writeRecord(scratch.record, { code: what.code >>> 0, flags: what.flags ?? 0,
                address: what.address >>> 0, parameters: what.parameters });
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

    return {
        dispatch,
        unwindEx,
        captureContext,
        writeContext,
        readContext,
        raiseOn,

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
                    // The caller's context: its registers as they are at the
                    // call, RIP the return address and RSP past it. The stub
                    // has not moved the non-volatiles the unwinder reads.
                    const context = callerContext();
                    writeContext(out >>> 0, context);
                    return 0;
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
                        const bytes = new Uint8Array(8);
                        new DataView(bytes.buffer)
                            .setBigUint64(0, BigInt(fn.imageBase >>> 0), true);
                        host.writeMemory(imageBaseOut >>> 0, bytes);
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
                        parameters.push(Number(new DataView(
                            host.readMemory(from + index * 8, 8).buffer.slice())
                            .getBigUint64(0, true) & 0xffffffffn));
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

    /**
     * The caller's registers as it stands at a host call this engine answers:
     * the non-volatiles as the stub left them, RIP the return address at the
     * current RSP and RSP past it. Enough for an unwind, which reads only the
     * stack, RSP, RIP and the non-volatiles.
     */
    function callerContext(){
        const context = captureContext();
        const rsp = stackOf(context);
        context.rip = Number(
            new DataView(host.readMemory(rsp, 8).buffer.slice()).getBigUint64(0, true)
            & 0xffffffffn);
        context.gpr[4] = BigInt(rsp + 8 >>> 0);
        return context;
    }
}
