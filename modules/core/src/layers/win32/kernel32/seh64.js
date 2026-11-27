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
import { pointerArg, wholeAddress } from '../common/pointers.js';

/** EXCEPTION_RECORD at 64 bits: the code and flags, then quadword fields. */
const RECORD64 = Object.freeze({
    CODE: 0x00,
    FLAGS: 0x04,
    NESTED: 0x08,
    ADDRESS: 0x10,
    PARAMETER_COUNT: 0x18,
    INFORMATION: 0x20,
    SIZE: 0x20 + 15 * 8,
});

/** EH_UNWINDING, EH_EXIT_UNWIND and EH_TARGET_UNWIND, as winnt.h names them. */
const EH_UNWINDING = 0x02;
const EH_EXIT_UNWIND = 0x04;
const EH_TARGET_UNWIND = 0x20;

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
const CONTEXT64 = Object.freeze({
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
const DISPATCHER64 = Object.freeze({
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

/** What the x64 runtime's longjmp names its unwind: the record's first parameter is the buffer. */
const STATUS_LONGJUMP = 0x80000026;

/**
 * An unwind that ends in a call: at the target, the record's first parameter
 * is called with the record and answers where the thread goes on. The x64
 * C++ runtime enters a catch block this way.
 */
const STATUS_UNWIND_CONSOLIDATE = 0x80000029;

/**
 * The x64 runtime's _JUMP_BUFFER: the establisher frame setjmp was called
 * with, the registers a callee keeps, where setjmp returns to and the stack
 * as that return leaves it, the two control words, then XMM6 to XMM15.
 */
export const JUMP_BUFFER64 = Object.freeze({
    FRAME: 0x00, RBX: 0x08, RSP: 0x10, RBP: 0x18, RSI: 0x20, RDI: 0x28,
    R12: 0x30, R13: 0x38, R14: 0x40, R15: 0x48, RIP: 0x50,
    MXCSR: 0x58, FPCSR: 0x5c, XMM6: 0x60, SIZE: 0x100,
});

/** The registers of a buffer by their number in a context: RBX, RSP, RBP, RSI, RDI, R12-R15. */
const JUMP_REGISTERS = Object.freeze([
    [3, JUMP_BUFFER64.RBX], [4, JUMP_BUFFER64.RSP], [5, JUMP_BUFFER64.RBP],
    [6, JUMP_BUFFER64.RSI], [7, JUMP_BUFFER64.RDI], [12, JUMP_BUFFER64.R12],
    [13, JUMP_BUFFER64.R13], [14, JUMP_BUFFER64.R14], [15, JUMP_BUFFER64.R15],
]);

/**
 * `_setjmp` and `_setjmpex` of a 64-bit process as the guest runs them: a
 * setjmp is stores of registers the caller already holds, and an interpreter
 * sets one at every protected call - a script engine tens of them a frame,
 * each a crossing into the host otherwise. The handler writes the same buffer
 * and is the reference the code is gated against.
 *
 *     mov [rcx], rdx                      ; the frame
 *     mov [rcx+8], rbx
 *     lea rax, [rsp+8] ; mov [rcx+10h], rax
 *     mov [rcx+18h], rbp ; ... rsi, rdi, r12-r15
 *     mov rax, [rsp] ; mov [rcx+50h], rax ; the return address
 *     stmxcsr [rcx+58h] ; fnstcw [rcx+5Ch]
 *     movups [rcx+60h+16n], xmm6..xmm15
 *     xor eax, eax ; ret
 */
export const SETJMP64_CODE = Uint8Array.from([
    0x48, 0x89, 0x11,
    0x48, 0x89, 0x59, 0x08,
    0x48, 0x8d, 0x44, 0x24, 0x08, 0x48, 0x89, 0x41, 0x10,
    0x48, 0x89, 0x69, 0x18, 0x48, 0x89, 0x71, 0x20, 0x48, 0x89, 0x79, 0x28,
    0x4c, 0x89, 0x61, 0x30, 0x4c, 0x89, 0x69, 0x38,
    0x4c, 0x89, 0x71, 0x40, 0x4c, 0x89, 0x79, 0x48,
    0x48, 0x8b, 0x04, 0x24, 0x48, 0x89, 0x41, 0x50,
    0x0f, 0xae, 0x59, 0x58, 0xd9, 0x79, 0x5c,
    0x0f, 0x11, 0x71, 0x60, 0x0f, 0x11, 0x79, 0x70,
    ...[0x81, 0x89, 0x91, 0x99, 0xa1, 0xa9, 0xb1, 0xb9].flatMap((modrm, index)=>
        [0x44, 0x0f, 0x11, modrm, 0x80 + index * 16, 0, 0, 0]),
    0x31, 0xc0, 0xc3,
]);

/**
 * How far below the point an exception was raised at its funclets start:
 * clear of the raising call's own frame, 16-aligned.
 */
const FLOOR_GAP = 0x100;

/** What RtlAddGrowableFunctionTable answers for a table it cannot hold. */
const STATUS_INVALID_PARAMETER = 0xc000000d;

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

/** @param {number | bigint} value */
const hex = value=>`0x${(typeof value === 'bigint' ? value : wholeAddress(value)).toString(16)}`;

/** The largest integer a number holds exactly: past it, a quadword is kept a bigint. */
const EXACT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * A quadword as the engine carries it: a number while a number holds it
 * exactly - every address and count does - and a bigint past 2^53, which no
 * address is but a ULONG_PTR a program raised may be (a -1).
 *
 * @param {bigint} quad
 * @returns {number | bigint}
 */
const valueOf = quad=>(quad <= EXACT ? Number(quad) : quad);

/**
 * The 64 bits a value is written as: a bigint's own, a number's whole - a
 * dword read signed by its unsigned value.
 *
 * @param {number | bigint} value
 */
const quadOf = value=>(typeof value === 'bigint' ? BigInt.asUintN(64, value)
    : BigInt(value < 0 ? value >>> 0 : Math.trunc(value)));

/** RAX as a funclet answers it, as EAX: a filter's or a handler's int. @param {bigint} rax */
const eaxOf = rax=>Number(BigInt.asIntN(32, rax));

/** A stack address rounded down to 16, whole. @param {number} at */
const align16 = at=>at - at % 16;

/**
 * RAX whole from a call into a 64-bit routine as the bridge makes it
 * (`callGuest`): the dword it resolves with, and the high half it sets on the
 * promise before resolving. A catch block answers where its function goes
 * on, which past 4 GiB the dword alone does not say.
 *
 * @param {Promise<number> & { high?: number }} call
 * @returns {Promise<bigint>}
 */
export const raxOf = call=>call.then(low=>
    BigInt((call.high ?? 0) >>> 0) << 32n | BigInt(low >>> 0));
/** The general registers in the encoding's order, as an UnwindContext keeps them. */
const LONG_NAMES = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
    'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];

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
 * @property {(number | bigint)[]} [parameters]  ExceptionInformation, ULONG_PTRs
 *     whole: a number up to 2^53, a bigint past it.
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
 *     Answers RAX whole: where the thread goes on after it.
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
 *     stack: number, thread?: any }) => Promise<bigint>} callFunclet
 *     Runs a funclet or filter with the x64 argument registers set and its
 *     stack at `stack`; answers RAX whole, as a catch block answers where its
 *     function goes on.
 * @property {(registers: { rip: number, rsp: number,
 *     long: { gpr: bigint[], xmm: Uint8Array, mxcsr: number } }) => any} continueAt
 *     Sends the thread on at a whole 64-bit context, abandoning the calls below.
 * @property {() => any} currentThread
 * @property {() => number} [controlWord]  The x87's control word, which a setjmp keeps.
 * @property {(word: number) => void} [setControlWord]  And a longjmp puts back.
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
        const bytes = host.readMemory(wholeAddress(at), 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** A quadword's 64 bits. @param {number} at */
    const readQuad = at=>{
        const bytes = host.readMemory(wholeAddress(at), 8);
        return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
    };
    /** A pointer-wide field, whole. @param {number} at */
    const addressAt = at=>Number(readQuad(at));
    /** A DWORD64 argument from its two dwords, low first. @param {number} low @param {number} high */
    const joined = (low, high)=>(high >>> 0) * 2 ** 32 + (low >>> 0);
    /** @param {number} at @param {number | bigint} value */
    const writeQuad = (at, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, quadOf(value), true);
        host.writeMemory(wholeAddress(at), bytes);
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
        view.setBigUint64(CONTEXT64.RIP, quadOf(context.rip), true);
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
            rip: Number(view.getBigUint64(CONTEXT64.RIP, true)),
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
        view.setBigUint64(RECORD64.ADDRESS, quadOf(what.address), true);
        const parameters = (what.parameters ?? []).slice(0, 15);
        view.setBigUint64(RECORD64.PARAMETER_COUNT, BigInt(parameters.length), true);
        parameters.forEach((value, index)=>
            view.setBigUint64(RECORD64.INFORMATION + index * 8, quadOf(value), true));
        host.writeMemory(at, bytes);
    };

    /**
     * A record the program made, as it made it: RtlUnwindEx hands the frames
     * it unwinds the program's own, whose parameters a runtime reads its
     * state back from.
     *
     * @param {number} at
     * @returns {ExceptionRecord}
     */
    const readRecord = at=>{
        const count = Math.min(readU32(at + RECORD64.PARAMETER_COUNT), 15);
        return { code: readU32(at + RECORD64.CODE), flags: readU32(at + RECORD64.FLAGS),
            address: addressAt(at + RECORD64.ADDRESS),
            parameters: Array.from({ length: count },
                (_, index)=>valueOf(readQuad(at + RECORD64.INFORMATION + index * 8))) };
    };

    /** EXCEPTION_POINTERS: the record and the context, each a quadword. */
    const pointerPair = (/** @type {number} */ record, /** @type {number} */ context)=>{
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        view.setBigUint64(0, quadOf(record), true);
        view.setBigUint64(8, quadOf(context), true);
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
        const base = align16(floor - size);
        return {
            record: base,
            context: base + RECORD64.SIZE,
            dispatcher: base + RECORD64.SIZE + CONTEXT64.SIZE,
            pointers: base + RECORD64.SIZE + CONTEXT64.SIZE + DISPATCHER64.SIZE,
            top: base,
        };
    };

    /** @param {number} stack */
    const floorBelow = stack=>align16(stack - FLOOR_GAP);

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
                    interpreted.set(wholeAddress(stub), scopeTable);
                }
            }
            for (const { stubs, interpreter } of host.interpreters?.() ?? [])
            {
                for (const stub of stubs)
                {
                    if (stub !== 0)
                    {
                        interpreted.set(wholeAddress(stub), interpreter);
                    }
                }
            }
        }
        const known = interpreted.get(wholeAddress(address));
        if (known)
        {
            return known;
        }
        // A jmp [rip+disp] thunk: follow it to the import slot, a quadword,
        // and the stub.
        const bytes = host.readMemory(wholeAddress(address), 6);
        if (bytes[0] === 0xff && bytes[1] === 0x25)
        {
            const disp = (bytes[2] | bytes[3] << 8 | bytes[4] << 16 | bytes[5] << 24) | 0;
            const target = interpreted.get(addressAt(wholeAddress(address) + 6 + disp));
            if (target)
            {
                interpreted.set(wholeAddress(address), target);
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
     * @returns {Promise<{ visit?: FrameVisit, nested?: NestedCall } | null>}
     */
    const step = async(context, thread, type, memo)=>{
        const fn = await unwinder.resolve(context.rip);
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
            context.rip = wholeAddress(caller.rip);
            context.gpr[4] = BigInt(wholeAddress(caller.rsp));
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
        const quad = (at, value)=>view.setBigUint64(at, quadOf(value), true);
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
            return { answer: eaxOf(answer) >>> 0, context: scratch.context };
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
        const frame = wholeAddress(target.frame);
        const everything = frame === 0;
        const context = copyContext(pass.faultContext);
        /** @type {Map<string, any>} */
        const memo = new Map();
        const unwindingPass = passFor({ ...pass.record,
            flags: pass.record.flags | EH_UNWINDING | (everything ? EH_EXIT_UNWIND : 0) },
        pass.faultContext, pass.thread, pass.floor);
        const list = nestedOf(pass.thread);
        for (let guard = 0; guard < WALK_LIMIT; guard++)
        {
            const taken = await step(context, pass.thread, UNW_FLAG.UHANDLER, memo);
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
            const atTarget = !everything && wholeAddress(visit.establisher) === frame;
            if (visit.handler !== 0)
            {
                const options = { at: atTarget, ip: wholeAddress(target.ip),
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
            if (!everything && stackOf(context) > frame)
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
            }).then(eaxOf),
            callNested: async(entry, registers, resume, abandoned)=>{
                const list = nestedOf(thread);
                /** @type {NestedCall} */
                const nested = { stack: pass.floor, resume: copyContext(resume),
                    ...abandoned ? { abandoned } : {} };
                list.push(nested);
                try
                {
                    // Where the thread goes on, an address: RAX whole.
                    return Number(BigInt.asUintN(64, await host.callFunclet({ entry,
                        ...registers, stack: pass.floor, thread })));
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
                rip: wholeAddress(context.rip),
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
            { frame: wholeAddress(targetFrame), ip: wholeAddress(targetIp) }));
        resume.rip = wholeAddress(targetIp);
        resume.gpr[0] = quadOf(returnValue);
        const callback = record.code === STATUS_UNWIND_CONSOLIDATE
            ? Number(record.parameters?.[0] ?? 0) : 0;
        if (callback !== 0)
        {
            // Called as a catch block is, on the target's registers: an
            // exception it raises walks on from the target frame. It answers
            // RIP, as a catch funclet does.
            const scratch = scratchBelow(pass.floor);
            writeRecord(scratch.record, record);
            const below = passFor(record, pass.faultContext, thread, scratch.top);
            resume.rip = await below.callNested(callback, { rcx: scratch.record }, resume);
        }
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
                        entry: visit.fn.imageBase + scope.handler,
                        rcx: scratch.pointers, rdx: establisher, stack: scratch.top,
                        thread: pass.thread,
                    }).then(eaxOf);
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
                const targetIp = visit.fn.imageBase + scope.target;
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
                await pass.call(visit.fn.imageBase + scope.handler,
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
     * Up to 48 quadwords at a fault's RSP, where a frame's return addresses
     * are, for the fault's trace: as far as the stack is there to read, which
     * near its top is fewer.
     *
     * @param {number} rsp
     */
    const stackWords = rsp=>{
        /** @type {string[]} */
        const words = [];
        try
        {
            while (words.length < 48)
            {
                words.push(readQuad(rsp + words.length * 8).toString(16));
            }
        }
        catch {
            // The stack's end: what was read is all there is.
        }
        return words.length > 0 ? words.join(' ') : 'unreadable';
    };

    /**
     * RtlDispatchException: walks the frames from the fault, offering the
     * exception to each frame's handler until one takes it.
     *
     * @param {{ code: number, flags?: number, address: number,
     *     parameters?: (number | bigint)[] }} what
     * @param {UnwindContext} faultContext
     * @returns {Promise<{ handled: boolean, continuation?: any }>}
     */
    const dispatch = async(what, faultContext)=>{
        /** @type {ExceptionRecord} */
        const record = { code: what.code >>> 0, flags: what.flags ?? 0,
            address: wholeAddress(what.address),
            ...what.parameters ? { parameters: what.parameters } : {} };
        // An error -- an access violation, an illegal instruction -- says
        // what it touched and the registers it had, which is all a fault in
        // code nobody has the source of can be read from; an informational
        // raise (a thread's name) says only its code.
        host.trace?.(`exception ${hex(record.code)} at ${hex(record.address)}${
            record.code >= 0xc0000000 ? ` [${(record.parameters ?? []).map(hex).join(', ')}] ${
                LONG_NAMES.map((name, index)=>`${name}=${
                    faultContext.gpr[index].toString(16)}`).join(' ')} stack=${
                stackWords(stackOf(faultContext))}` : ''}`);
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
        // An error's frames, traced before any handler runs -- a filter may
        // report the crash and end the process from inside the walk: where
        // the fault was called from, which the stack's words alone do not say.
        if (record.code >= 0xc0000000 && host.trace)
        {
            const probe = copyContext(faultContext);
            /** @type {number[]} */
            const frames = [];
            for (let depth = 0; depth < 24; depth++)
            {
                frames.push(wholeAddress(probe.rip));
                const at = { rip: wholeAddress(probe.rip), stack: stackOf(probe) };
                if (!await step(probe, thread, UNW_FLAG.NHANDLER, new Map())
                    || wholeAddress(probe.rip) === at.rip && stackOf(probe) === at.stack)
                {
                    break;
                }
            }
            host.trace(`exception ${hex(record.code)} frames ${frames.map(hex).join(' ')}`);
        }
        for (let guard = 0; guard < WALK_LIMIT; guard++)
        {
            const before = { rip: wholeAddress(context.rip), stack: stackOf(context) };
            const taken = await step(context, thread, UNW_FLAG.EHANDLER, memo);
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
            if (wholeAddress(context.rip) === before.rip && stackOf(context) === before.stack)
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
     * @param {{ code: number, flags?: number, address: number,
     *     parameters?: (number | bigint)[] }} what
     * @param {UnwindContext} faultContext
     * @returns {Promise<{ handled: boolean, continuation?: any }>}
     */
    const lastChance = async(what, faultContext)=>{
        if (topLevelFilter !== 0)
        {
            const scratch = scratchBelow(floorBelow(stackOf(faultContext)));
            writeRecord(scratch.record, { code: what.code >>> 0, flags: what.flags ?? 0,
                address: wholeAddress(what.address),
                ...what.parameters ? { parameters: what.parameters } : {} });
            writeContext(scratch.context, faultContext);
            host.writeMemory(scratch.pointers, pointerPair(scratch.record, scratch.context));
            const answer = await host.callFunclet({
                entry: topLevelFilter, rcx: scratch.pointers, stack: scratch.top,
                thread: host.currentThread(),
            }).then(eaxOf);
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
        host.terminate?.({ code: what.code >>> 0, address: wholeAddress(what.address) });
        return { handled: false };
    };

    /**
     * An exception raised or faulted: dispatched, then the last chance.
     *
     * @param {{ code: number, flags?: number, address: number,
     *     parameters?: (number | bigint)[] }} what
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
    /**
     * RtlUnwindEx's and RtlUnwind's body: the record the program passed, or
     * STATUS_UNWIND's of none.
     *
     * @param {UnwindContext} context @param {number} targetFrame @param {number} targetIp
     * @param {number} recordPtr @param {number} returnValue
     */
    const unwindCalled = (context, targetFrame, targetIp, recordPtr, returnValue)=>{
        const record = wholeAddress(recordPtr) !== 0
            ? readRecord(wholeAddress(recordPtr))
            : { code: STATUS.UNWIND, flags: EH_UNWINDING, address: context.rip };
        return unwindEx(context, targetFrame, targetIp, returnValue, record,
            host.currentThread());
    };

    const callerContext = ()=>{
        const context = captureContext();
        const rsp = stackOf(context);
        context.rip = addressAt(rsp);
        context.gpr[4] = BigInt(rsp + 8);
        return context;
    };

    /**
     * `_setjmp`'s buffer, written from the registers its caller stands at.
     *
     * @param {number} buffer @param {number} frame  The caller's establisher
     *     frame, or zero for a mark a longjmp takes without unwinding.
     */
    const setJump = (buffer, frame)=>{
        const context = callerContext();
        const head = new Uint8Array(JUMP_BUFFER64.FPCSR + 2);
        const view = new DataView(head.buffer);
        view.setBigUint64(JUMP_BUFFER64.FRAME, quadOf(frame), true);
        for (const [register, at] of JUMP_REGISTERS)
        {
            view.setBigUint64(at, BigInt.asUintN(64, context.gpr[register]), true);
        }
        view.setBigUint64(JUMP_BUFFER64.RIP, quadOf(context.rip), true);
        view.setUint32(JUMP_BUFFER64.MXCSR, context.mxcsr >>> 0, true);
        view.setUint16(JUMP_BUFFER64.FPCSR, host.controlWord?.() ?? 0x27f, true);
        host.writeMemory(buffer, head);
        host.writeMemory(buffer + JUMP_BUFFER64.XMM6, context.xmm.subarray(6 * 16, 16 * 16));
        return 0;
    };

    /**
     * `longjmp`: back to the mark with `value` as what setjmp answers there,
     * one for a zero. A mark that kept its frame is reached by an unwind, so
     * the `__finally` blocks and destructors between run first, as
     * RtlUnwindEx does for STATUS_LONGJUMP; the registers are the buffer's
     * either way.
     *
     * @param {number} buffer @param {number} value
     */
    const longJump = async(buffer, value)=>{
        const bytes = host.readMemory(buffer, JUMP_BUFFER64.SIZE);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const frame = Number(view.getBigUint64(JUMP_BUFFER64.FRAME, true));
        const rip = Number(view.getBigUint64(JUMP_BUFFER64.RIP, true));
        const context = callerContext();
        const thread = host.currentThread();
        const pass = passFor({ code: STATUS_LONGJUMP, flags: EH_UNWINDING, address: context.rip,
            parameters: [buffer] }, context, thread);
        const resume = frame === 0 ? copyContext(context)
            : copyContext(await unwindFrames(pass, { frame, ip: rip }));
        for (const [register, at] of JUMP_REGISTERS)
        {
            resume.gpr[register] = view.getBigUint64(at, true);
        }
        resume.rip = rip;
        resume.gpr[0] = BigInt(((value | 0) === 0 ? 1 : value) >>> 0);
        resume.mxcsr = view.getUint32(JUMP_BUFFER64.MXCSR, true);
        resume.xmm.set(bytes.subarray(JUMP_BUFFER64.XMM6, JUMP_BUFFER64.SIZE), 6 * 16);
        host.setControlWord?.(view.getUint16(JUMP_BUFFER64.FPCSR, true));
        return pass.continueAt(resume);
    };

    /**
     * The walk a dispatcher context the program's handler was handed
     * belongs to, for a runtime handler it hands the frame on to; with the
     * floor moved below where that handler stands now. Null for a
     * dispatcher context this dispatcher did not make.
     *
     * @param {number} address
     */
    const dispatcherContextAt = address=>{
        const found = dispatching.get(wholeAddress(address));
        if (!found)
        {
            return null;
        }
        const { pass } = found;
        const floor = Math.min(pass.floor, floorBelow(stackOf(captureContext())));
        return { ...found, pass: passFor(pass.record, pass.faultContext, pass.thread, floor) };
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

        dispatcherContextAt,

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
                    fault.vector === 13 ? 0xffffffff : wholeAddress(fault.address ?? 0)]
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

        /**
         * The C runtime's marks at 64 bits, which stand over the 32-bit
         * runtime's in a 64-bit process (`msvcrt/seh.js`).
         */
        crt: {
            /**
             * int _setjmp(_JUMP_BUFFER *env, void *frame)
             *
             * What the compiler makes of `setjmp(env)`: the frame is the
             * caller's establisher frame, which a longjmp unwinds to.
             */
            _setjmp: {
                convention: 'cdecl', argBytes: 8, addresses: [0, 1],
                long: ()=>SETJMP64_CODE,
                /** @param {number[]} args */
                handler: ([buffer, frame])=>setJump(buffer, frame),
            },

            /** int _setjmpex(_JUMP_BUFFER *env, void *frame) - the same mark. */
            _setjmpex: {
                convention: 'cdecl', argBytes: 8, addresses: [0, 1],
                long: ()=>SETJMP64_CODE,
                /** @param {number[]} args */
                handler: ([buffer, frame])=>setJump(buffer, frame),
            },

            /** vcruntime140's names for the two. */
            __intrinsic_setjmp: {
                convention: 'cdecl', argBytes: 8, addresses: [0, 1],
                long: ()=>SETJMP64_CODE,
                /** @param {number[]} args */
                handler: ([buffer, frame])=>setJump(buffer, frame),
            },
            __intrinsic_setjmpex: {
                convention: 'cdecl', argBytes: 8, addresses: [0, 1],
                long: ()=>SETJMP64_CODE,
                /** @param {number[]} args */
                handler: ([buffer, frame])=>setJump(buffer, frame),
            },

            /** void longjmp(_JUMP_BUFFER *env, int value) */
            longjmp: {
                convention: 'cdecl', argBytes: 8, addresses: [0],
                /** @param {number[]} args */
                handler: ([buffer, value])=>longJump(buffer, value),
            },
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
                    writeContext(wholeAddress(out), callerContext());
                    return 0;
                },
            },

            /**
             * WORD RtlCaptureStackBackTrace(DWORD FramesToSkip, DWORD FramesToCapture,
             *     PVOID *BackTrace, PDWORD BackTraceHash)
             *
             * The return addresses from the caller's up, each frame undone as the
             * exception dispatch undoes it (its .pdata, or a leaf's return address);
             * the walk stops where no frame can be undone. Each address a quadword;
             * the hash, where asked, the sum of their low halves.
             */
            RtlCaptureStackBackTrace: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: async([skip, wanted, out, hash])=>{
                    if (wholeAddress(out) === 0)
                    {
                        return 0;
                    }
                    const context = callerContext();
                    const count = Math.min(wanted >>> 0, 0xffff);
                    /** @type {number[]} */
                    const frames = [];
                    for (let depth = 0; frames.length < count && context.rip !== 0
                        && depth < (skip >>> 0) + count; depth++)
                    {
                        if (depth >= (skip >>> 0))
                        {
                            frames.push(context.rip);
                        }
                        const fn = await unwinder.resolve(context.rip);
                        if (fn)
                        {
                            unwinder.virtualUnwind(0, fn, context.rip, context);
                        }
                        else if (unwinder.known(context.rip))
                        {
                            unwinder.unwindLeaf(context);
                        }
                        else
                        {
                            break;
                        }
                    }
                    let sum = 0;
                    const bytes = new Uint8Array(frames.length * 8);
                    const view = new DataView(bytes.buffer);
                    frames.forEach((address, index)=>{
                        view.setBigUint64(index * 8, quadOf(address), true);
                        sum = (sum + (address >>> 0)) >>> 0;
                    });
                    host.writeMemory(wholeAddress(out), bytes);
                    if (wholeAddress(hash) !== 0)
                    {
                        host.writeMemory(wholeAddress(hash),
                            new Uint8Array(Uint32Array.of(sum).buffer));
                    }
                    return frames.length;
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
                returns: 'pointer',
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([pc, baseOut])=>{
                    const base = unwinder.imageBase(wholeAddress(pc));
                    if (wholeAddress(baseOut) !== 0)
                    {
                        writeQuad(wholeAddress(baseOut), base);
                    }
                    return BigInt(base);
                },
            },

            /**
             * PRUNTIME_FUNCTION RtlLookupFunctionEntry(DWORD64 ControlPc,
             *     PDWORD64 ImageBase, PUNWIND_HISTORY_TABLE HistoryTable)
             */
            RtlLookupFunctionEntry: {
                returns: 'pointer',
                argBytes: 16,
                quadwords: [0],
                /** @param {number[]} args */
                handler: ([pc, pcHigh, imageBaseOut])=>{
                    /** @param {FunctionEntry | null} fn */
                    const answer = fn=>{
                        if (fn && wholeAddress(imageBaseOut) !== 0)
                        {
                            writeQuad(wholeAddress(imageBaseOut), fn.imageBase);
                        }
                        return BigInt(fn ? fn.entry : 0);
                    };
                    // Answered at once from a table; a JIT's range waits on
                    // its callback.
                    const at = joined(pc, pcHigh);
                    const fn = unwinder.lookup(at);
                    return fn || !unwinder.asksCallback(at)
                        ? answer(fn)
                        : unwinder.resolve(at).then(answer);
                },
            },

            /**
             * PEXCEPTION_ROUTINE RtlVirtualUnwind(DWORD HandlerType,
             *     DWORD64 ImageBase, DWORD64 ControlPc, PRUNTIME_FUNCTION FunctionEntry,
             *     PCONTEXT ContextRecord, PVOID *HandlerData, PDWORD64 EstablisherFrame,
             *     PKNONVOLATILE_CONTEXT_POINTERS ContextPointers)
             */
            RtlVirtualUnwind: {
                returns: 'pointer',
                argBytes: 40,
                quadwords: [1, 3],
                /** @param {number[]} args */
                handler: ([type, imageBase, imageBaseHigh, controlPc, controlPcHigh,
                    functionEntry, contextRecord, handlerDataOut, establisherOut])=>{
                    const fn = unwinder.entryAt(joined(imageBase, imageBaseHigh),
                        wholeAddress(functionEntry));
                    const context = readContext(wholeAddress(contextRecord));
                    const unwound = unwinder.virtualUnwind(type >>> 0, fn,
                        joined(controlPc, controlPcHigh), context);
                    writeContext(wholeAddress(contextRecord), context);
                    if (wholeAddress(handlerDataOut) !== 0)
                    {
                        writeQuad(wholeAddress(handlerDataOut), unwound.handlerData);
                    }
                    if (wholeAddress(establisherOut) !== 0)
                    {
                        writeQuad(wholeAddress(establisherOut), unwound.establisher);
                    }
                    return BigInt(unwound.handler);
                },
            },

            /**
             * VOID RtlUnwindEx(PVOID TargetFrame, PVOID TargetIp,
             *     PEXCEPTION_RECORD ExceptionRecord, PVOID ReturnValue,
             *     PCONTEXT ContextRecord, PUNWIND_HISTORY_TABLE HistoryTable)
             *
             * Unwinds from the caller to the target, running every termination
             * handler, then continues at the target. It does not return.
             * ContextRecord is where the system keeps the registers while it
             * unwinds, not where it starts: it captures the caller's into it
             * first, so a C++ frame handler passes a local it never filled.
             * The engine keeps them on the host, and as the call does not
             * return nothing reads that buffer after it.
             */
            RtlUnwindEx: {
                argBytes: 24,
                /** @param {number[]} args */
                handler: ([targetFrame, targetIp, recordPtr, returnValue])=>unwindCalled(
                    callerContext(), targetFrame, targetIp, recordPtr, returnValue),
            },

            /**
             * VOID RtlUnwind(PVOID TargetFrame, PVOID TargetIp,
             *     PEXCEPTION_RECORD ExceptionRecord, PVOID ReturnValue)
             *
             * At 64 bits, RtlUnwindEx from the caller's own context: it does not
             * return. The x64 CRT's longjmp calls it with STATUS_LONGJUMP and
             * loops on it should it come back -- as the chain-based one of a
             * 32-bit process does, which stood here before.
             */
            RtlUnwind: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([targetFrame, targetIp, recordPtr, returnValue])=>{
                    return unwindCalled(callerContext(), targetFrame, targetIp, recordPtr,
                        returnValue);
                },
            },

            /**
             * EXCEPTION_DISPOSITION __C_specific_handler(
             *     struct _EXCEPTION_RECORD *ExceptionRecord, void *EstablisherFrame,
             *     struct _CONTEXT *ContextRecord, struct _DISPATCHER_CONTEXT *DispatcherContext)
             *
             * The C language handler named in a function's unwind data. The
             * dispatcher interprets a frame's scope table itself where the
             * frame names this handler. A frame compiled with a stack cookie
             * names its image's own `__GSHandlerCheck_SEH` instead, which
             * checks the cookie and calls this with the dispatcher context it
             * was given: the frame's scopes are then taken here, from the
             * handler data that context holds, as the walk's own would be.
             * Called with any other context, the search goes on.
             */
            __C_specific_handler: {
                argBytes: 16, lastError: false,
                /** @param {number[]} args */
                handler: ([, , , dispatcher])=>{
                    const found = dispatcherContextAt(dispatcher);
                    if (!found)
                    {
                        return Disposition.CONTINUE_SEARCH;
                    }
                    const visit = { ...found.visit, handlerData:
                        addressAt(wholeAddress(dispatcher) + DISPATCHER64.HANDLER_DATA) };
                    if (found.unwinding)
                    {
                        return scopeTable.unwind(visit, found.pass, found.unwinding)
                            .then(()=>Disposition.CONTINUE_SEARCH);
                    }
                    return scopeTable.search(visit, found.pass)
                        .then(continuation=>continuation ?? Disposition.CONTINUE_SEARCH);
                },
            },

            /**
             * BOOLEAN RtlAddFunctionTable(PRUNTIME_FUNCTION FunctionTable,
             *     DWORD EntryCount, DWORD64 BaseAddress)
             */
            RtlAddFunctionTable: {
                argBytes: 16,
                quadwords: [2],
                /** @param {number[]} args */
                handler: ([table, count, base, baseHigh])=>(unwinder.add(wholeAddress(table),
                    count >>> 0, joined(base, baseHigh)) ? 1 : 0),
            },

            /**
             * BOOLEAN RtlDeleteFunctionTable(PRUNTIME_FUNCTION FunctionTable)
             *
             * A table RtlAddFunctionTable added, or a callback range by the
             * identifier it was installed with.
             */
            RtlDeleteFunctionTable: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([table])=>(unwinder.remove(wholeAddress(table)) ? 1 : 0),
            },

            /**
             * BOOLEAN RtlInstallFunctionTableCallback(DWORD64 TableIdentifier,
             *     DWORD64 BaseAddress, DWORD Length, PGET_RUNTIME_FUNCTION_CALLBACK
             *     Callback, PVOID Context, PCWSTR OutOfProcessCallbackDll)
             *
             * How a JIT - .NET's, Mono's - describes the code it makes: the
             * callback is asked for a function's entry whenever an address in
             * the range is looked up. The out-of-process DLL is a debugger's.
             */
            RtlInstallFunctionTableCallback: {
                // The identifier and the base are DWORD64s: two dwords each in
                // the layout every handler reads.
                argBytes: 32,
                quadwords: [0, 2],
                /** @param {number[]} args */
                handler: ([id, idHigh, base, baseHigh, length, callback, context])=>(
                    unwinder.install(joined(id, idHigh), joined(base, baseHigh), length >>> 0,
                        wholeAddress(callback), wholeAddress(context)) ? 1 : 0),
            },

            /**
             * DWORD RtlAddGrowableFunctionTable(PVOID *DynamicTable,
             *     PRUNTIME_FUNCTION FunctionTable, DWORD EntryCount,
             *     DWORD MaximumEntryCount, ULONG_PTR RangeBase, ULONG_PTR RangeEnd)
             *
             * A table the program grows in place: Windows 8 and later.
             */
            RtlAddGrowableFunctionTable: {
                argBytes: 24,
                // The range's ULONG_PTRs are numbers to the signature, not
                // addresses the bridge joins: read whole from their high halves.
                /** @param {number[] & { high?: number[] }} args */
                handler: args=>{
                    const [out, table, count, max] = args;
                    if (wholeAddress(out) === 0 || wholeAddress(table) === 0
                        || (count >>> 0) > (max >>> 0))
                    {
                        return STATUS_INVALID_PARAMETER;
                    }
                    writeQuad(wholeAddress(out), unwinder.addGrowable(wholeAddress(table),
                        count >>> 0, max >>> 0, pointerArg(args, 4), pointerArg(args, 5)));
                    return 0;
                },
            },

            /** VOID RtlGrowFunctionTable(PVOID DynamicTable, DWORD NewEntryCount) */
            RtlGrowFunctionTable: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([handle, count])=>{
                    unwinder.grow(wholeAddress(handle), count >>> 0);
                    return 0;
                },
            },

            /** VOID RtlDeleteGrowableFunctionTable(PVOID DynamicTable) */
            RtlDeleteGrowableFunctionTable: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([handle])=>{
                    unwinder.deleteGrowable(wholeAddress(handle));
                    return 0;
                },
            },

            /**
             * LPTOP_LEVEL_EXCEPTION_FILTER SetUnhandledExceptionFilter(
             *     LPTOP_LEVEL_EXCEPTION_FILTER)
             */
            SetUnhandledExceptionFilter: {
                returns: 'pointer',
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([filter])=>{
                    const previous = topLevelFilter;
                    topLevelFilter = wholeAddress(filter);
                    return BigInt(previous);
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
                    const from = wholeAddress(argsPtr);
                    const total = from === 0 ? 0 : Math.min(count >>> 0, 15);
                    /** @type {(number | bigint)[]} */
                    const parameters = [];
                    for (let index = 0; index < total; index++)
                    {
                        parameters.push(valueOf(readQuad(from + index * 8)));
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
