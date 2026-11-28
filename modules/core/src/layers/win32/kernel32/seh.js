/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Structured exception handling: the walk, and what it calls.
 *
 * A thread's handler chain lives in guest memory, at the first word of its
 * thread block, and a program edits it directly -- the prologue of any function
 * with a handler pushes a two-word frame and points that word at it. Nothing
 * here is told when that happens, so nothing here may remember the chain. It is
 * read fresh on every dispatch, every time.
 *
 * Seven things about this are settled by having been got wrong before, and each
 * is marked where it is honoured rather than restated as a rule:
 *
 * - The record is eighty bytes and a caller's return slot needs its own word
 *   after it, not a corner of it.
 * - The record is built on the program's own stack, per dispatch. A fixed
 *   address aliases the record a rethrow still points at.
 * - Every frame's handler is called, in chain order. Skipping one that cannot
 *   be understood lands the exception in an outer handler that should never
 *   have seen it.
 * - A walk that stops because the chain is damaged must not write the frame it
 *   stopped on back as the new head, which would leave the damage for the next
 *   throw.
 * - A frame is checked by asking whether its memory is there, and nothing else.
 *   Images are mapped readable rather than executable, so demanding execute
 *   permission rejects the program's own handler.
 * - Unwinding calls each frame's own handler with the unwinding flag. A runtime
 *   that is not this compiler's depends on exactly that.
 * - A handler starts with the direction flag clear, whatever the faulting code
 *   had: compiled code assumes DF clear at every call, and a fault inside a
 *   copy going down (`std; rep movs`) would otherwise have every `rep` in the
 *   handler run backwards. The context keeps the flags the fault had.
 */

import { DBG_CONTINUE, DEBUG_EVENT } from './debug-events.js';
import { privilegedAt, storeMachineStatus } from './machine-status.js';
import { TEB } from './teb.js';
import {
    CONTEXT_EXTENDED_REGISTERS, CONTEXT_FLOATING_POINT, floatGroupsOf, writeFloatGroups,
} from './fpu-context.js';
import {
    CONTEXT_DEBUG_REGISTERS, debugGroupOf, setDebugRegisters, writeDebugGroup,
} from './debug-registers.js';
import { wholeAddress } from '../common/pointers.js';

/** EXCEPTION_RECORD, and the size the whole of one occupies. */
export const RECORD = Object.freeze({
    CODE: 0x00,
    FLAGS: 0x04,
    NESTED: 0x08,
    ADDRESS: 0x0c,
    PARAMETER_COUNT: 0x10,
    INFORMATION: 0x14,
    SIZE: 0x50,
});

/**
 * CONTEXT, as a program sees it.
 *
 * Not the shape the engine keeps -- its state block holds the registers in
 * the processor's own order -- so every field here is a translation, and the
 * offsets are the ones a handler was compiled against.
 */
export const CONTEXT = Object.freeze({
    FLAGS: 0x000,
    FLOAT_SAVE: 0x01c,
    FLOAT_CONTROL_WORD: 0x01c,
    FLOAT_STATUS_WORD: 0x020,
    GS: 0x08c,
    FS: 0x090,
    ES: 0x094,
    DS: 0x098,
    EDI: 0x09c,
    ESI: 0x0a0,
    EBX: 0x0a4,
    EDX: 0x0a8,
    ECX: 0x0ac,
    EAX: 0x0b0,
    EBP: 0x0b4,
    EIP: 0x0b8,
    CS: 0x0bc,
    EFLAGS: 0x0c0,
    ESP: 0x0c4,
    SS: 0x0c8,
    SIZE: 0x2cc,
});

/**
 * The flat selectors a 32-bit thread of x86 Windows runs under: user code at
 * RPL 3, FS the thread's TEB, GS unused. A CONTEXT that says it holds the
 * segment registers carries these, wherever it is written.
 */
export const SELECTORS = Object.freeze({ CODE: 0x1b, DATA: 0x23, FS: 0x3b, GS: 0 });

/** CONTEXT_FULL: control, integer and segment registers. */
const CONTEXT_FULL = 0x00010007;

/** EFLAGS: the trap, direction and alignment-check flags. */
export const EFLAGS_TF = 0x100;
export const EFLAGS_DF = 0x400;
export const EFLAGS_AC = 0x40000;

/**
 * What the system clears before it runs a handler, as Windows enters its
 * dispatcher: a handler is a function like any other, called with DF clear,
 * and neither single-stepped nor alignment-checked on the faulting code's
 * account.
 */
const HANDLER_CLEARS = EFLAGS_TF | EFLAGS_DF | EFLAGS_AC;

/**
 * The flags a handler may change in the context it continues from: the
 * arithmetic six, TF, DF, AC and ID. The rest -- the reserved bit, IF, IOPL
 * and the mode bits -- are the thread's and stay as they were, as the system
 * keeps them when it continues from a context a program edited.
 */
const EFLAGS_FROM_CONTEXT = 0x0cd5 | EFLAGS_TF | EFLAGS_DF | EFLAGS_AC | 0x200000;

/** What a handler answers with. */
export const Disposition = Object.freeze({
    CONTINUE_EXECUTION: 0,
    CONTINUE_SEARCH: 1,
    NESTED_EXCEPTION: 2,
    COLLIDED_UNWIND: 3,
});

/**
 * The handles AddVectored*Handler answers: never null, and apart from each
 * other. A program only hands one back to remove what it registered.
 */
const VECTORED_HANDLE_BASE = 0x00ec0000;
const VECTORED_HANDLE_STRIDE = 8;

/** The chain ends with this, not with zero -- zero is an address. */
export const END_OF_CHAIN = 0xffffffff;

/** ExceptionFlags. */
export const EXCEPTION_NONCONTINUABLE = 0x01;
export const EH_UNWINDING = 0x02;

/** What a filter answers. */
export const EXCEPTION_EXECUTE_HANDLER = 1;
const EXCEPTION_CONTINUE_SEARCH = 0;

/** Codes raised by the processor rather than by a program. */
export const STATUS = Object.freeze({
    ACCESS_VIOLATION: 0xc0000005,
    ILLEGAL_INSTRUCTION: 0xc000001d,
    INTEGER_DIVIDE_BY_ZERO: 0xc0000094,
    PRIVILEGED_INSTRUCTION: 0xc0000096,
    GUARD_PAGE_VIOLATION: 0x80000001,
    BREAKPOINT: 0x80000003,
    SINGLE_STEP: 0x80000004,
    FLOAT_DIVIDE_BY_ZERO: 0xc000008e,
    STACK_OVERFLOW: 0xc00000fd,
    UNWIND: 0xc0000027,
    INTEGER_OVERFLOW: 0xc0000095,
    ARRAY_BOUNDS_EXCEEDED: 0xc000008c,
    DATATYPE_MISALIGNMENT: 0x80000002,
    FLOAT_MULTIPLE_TRAPS: 0xc00002b5,
});

/**
 * Which exception a processor vector is, for the ones a program can handle.
 *
 * A general protection fault is an access violation to a program -- the
 * system reports it with an unknown address -- and never a privileged
 * instruction here: the guest runs at ring zero, where nothing is privileged.
 */
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
    0x2d: STATUS.BREAKPOINT,
});

/** `int 0x2d`, the kernel debugger's service call: eax the service, ecx and edx its arguments. */
const DEBUG_SERVICE = 0x2d;
/** BREAKPOINT_PRINT, BREAKPOINT_LOAD_SYMBOLS, BREAKPOINT_UNLOAD_SYMBOLS: nothing to raise without a debugger. */
const SILENT_SERVICES = new Set([1, 3, 4]);

/**
 * How much stack a dispatch reserves below the fault.
 *
 * The record, a context, the two pointers a filter is handed, and room for the
 * handlers themselves to run below all of it. Handlers run on the faulting
 * thread's own stack, so anything they push has to land below what they were
 * given rather than on top of it.
 */
const SCRATCH = RECORD.SIZE + CONTEXT.SIZE + 0x20;

const PAGE_SIZE = 0x1000;

/** How much of the stack above esp the last-chance trace shows, in bytes. */
const STACK_TRACED = 0x1000;

/** @param {number} value */
const hex = value=>`0x${(value >>> 0).toString(16)}`;

/**
 * @typedef {Object} SehHost
 * @property {import('../common/guest.js').Guest} guest
 * @property {(address: number) => boolean} isMapped
 *           Whether a frame's memory is there. A bounds test and nothing more.
 * @property {() => number} teb  The running thread's block; its first word is
 *           the head of the chain.
 * @property {() => Record<string, number>} registers  EFLAGS among them
 *           (`eflags`) when the host can read them; without them a handler
 *           starts with the flags as they stand and continues with them.
 * @property {(registers: Record<string, number>) => any} [continueAt]
 *           An answer that sends the calling thread on at `registers`, its
 *           `eip` and `esp` among them, instead of back to its call (the
 *           bridge's `continueAt`): where RaiseException's caller goes once a
 *           handler has said to continue.
 * @property {(value: number, registers: Record<string, number>) => any} answerWith
 *           An answer that returns `value` and sets `registers` on the
 *           calling thread as it resumes (the bridge's `answerWith`).
 * @property {(options: { entry: number, args: number[], thread?: any,
 *                        stackAtRest?: number,
 *                        registers?: Record<string, number> }) => Promise<number>} callGuest
 *           Runs guest code with its frame built at `stackAtRest`, which is
 *           where a handler has to start: the record and context it is handed
 *           sit on this same stack, and a frame built anywhere above them is
 *           a handler writing over what it is reading. `registers.eflags`,
 *           when given, is the flags word it starts with.
 * @property {() => number} [dispatcherHandler]  The handler of the frame the
 *           dispatch registers while it calls a frame's handler: guest code
 *           that answers ExceptionContinueSearch. Without it the frame names
 *           no handler and every walk passes over it.
 * @property {() => any} [currentThread]
 * @property {import('./fpu-context.js').FloatState | null} [float]  The processor's
 *           images of a thread's x87 and SSE state, which a context carries.
 * @property {{ touch: (address: number) => boolean,
 *     commitGuard: (page: number) => boolean }} [guardPages]  The reservations'
 *           guard pages (heap.js `GUARD_PAGES`): a refused touch of one takes
 *           its guard away, and a stack grows by committing its next one.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(text: string) => void} [trace]
 * @property {(what: { code: number, address: number }) => void} [terminate]
 * @property {(report: import('./debug-events.js').DebugReport) => Promise<number>}
 *     [debugReport]  This process's debugger, when its parent debugs it: told of an
 *     exception first and again once nothing handled it, answering how to go on.
 * @property {() => boolean} [debugged]  Whether a debugger hears this process now:
 *     from its start, or since one attached; absent, whenever `debugReport` is given.
 *           Ends the process for an exception nothing handled, with the
 *           exception's code as its exit code -- what Windows does once the
 *           last-chance filter has had its say.
 */

/** EXCEPTION_EXIT_UNWIND: an unwind with no target, taking every frame. */
export const EXCEPTION_EXIT_UNWIND = 0x04;

/** What a filter answers to have the faulting instruction run again. */
const EXCEPTION_CONTINUE_EXECUTION = -1;

/**
 * @param {SehHost} host
 */
export function createSeh(host){
    const { guest } = host;

    /**
     * A thread's block, whose first word heads its chain.
     *
     * @param {any} [thread]
     */
    const tebOf = thread=>(thread?.tebAddress ?? host.teb()) >>> 0;

    /** The last top-level filter a program installed. */
    let topLevelFilter = 0;

    /**
     * A refused touch of a guard page, as Windows answers it before any
     * handler sees it: the page loses its guard; one inside the running
     * thread's stack reservation (DeallocationStack to StackBase) becomes the
     * stack's committed limit and the page below it the next guard page, and
     * the touch runs again ('grown'), unless no page would be left between
     * that guard and the reservation's bottom ('overflow',
     * STATUS_STACK_OVERFLOW); anywhere else the touch is
     * STATUS_GUARD_PAGE_VIOLATION ('guard'). Null for a page with no guard.
     *
     * @param {number} address
     * @returns {'grown' | 'overflow' | 'guard' | null}
     */
    const guardTouched = address=>{
        if (!host.guardPages?.touch(address))
        {
            return null;
        }
        const teb = host.teb() >>> 0;
        const top = teb === 0 ? 0 : guest.u32(teb + TEB.STACK_BASE);
        const bottom = teb === 0 ? 0 : guest.u32(teb + TEB.DEALLOCATION_STACK);
        if (address < bottom || address >= top)
        {
            return 'guard';
        }
        const page = (address & ~(PAGE_SIZE - 1)) >>> 0;
        guest.set32(teb + TEB.STACK_LIMIT, page);
        const next = page - PAGE_SIZE;
        return next >= bottom + PAGE_SIZE && host.guardPages.commitGuard(next)
            ? 'grown' : 'overflow';
    };

    /**
     * Writes an exception record where a handler will look for it.
     *
     * @param {number} at
     * @param {{ code: number, flags: number, address: number, parameters?: number[] }} what
     */
    const writeRecord = (at, what)=>{
        guest.setBytes(at, new Uint8Array(RECORD.SIZE));
        guest.set32(at + RECORD.CODE, what.code);
        guest.set32(at + RECORD.FLAGS, what.flags);
        guest.set32(at + RECORD.NESTED, 0);
        guest.set32(at + RECORD.ADDRESS, what.address);
        const parameters = (what.parameters ?? []).slice(0, 15);
        guest.set32(at + RECORD.PARAMETER_COUNT, parameters.length);
        parameters.forEach((value, index)=>
            guest.set32(at + RECORD.INFORMATION + index * 4, value));
    };

    /**
     * Writes the running registers as a program's CONTEXT.
     *
     * @param {number} at
     * @param {Record<string, number>} registers
     */
    const writeContext = (at, registers)=>{
        // With the thread's x87 and SSE state, as Windows hands a handler the
        // whole context: a handler that continues from the record, or from one
        // it laid over it (a .NET runtime resuming a thread it had redirected
        // for a collection), gets that state back (`continuation`).
        // Read here, where the exception is met: the registers on the
        // processor are the thread's own.
        // The debug registers too: a handler reads Dr6 for what stopped the
        // thread and may set Dr0-Dr3/Dr7 in the record it continues from.
        const bytes = new Uint8Array(CONTEXT.SIZE);
        const images = host.float?.images() ?? null;
        writeFloatGroups(images, bytes, CONTEXT_FLOATING_POINT | CONTEXT_EXTENDED_REGISTERS);
        writeDebugGroup(host.currentThread?.(), bytes, CONTEXT_DEBUG_REGISTERS);
        guest.setBytes(at, bytes);
        guest.set32(at + CONTEXT.FLAGS, (images === null ? CONTEXT_FULL | CONTEXT_DEBUG_REGISTERS
            : CONTEXT_FULL | CONTEXT_DEBUG_REGISTERS | CONTEXT_FLOATING_POINT
                | CONTEXT_EXTENDED_REGISTERS) >>> 0);
        for (const [field, name] of [
            [CONTEXT.EDI, 'edi'], [CONTEXT.ESI, 'esi'], [CONTEXT.EBX, 'ebx'],
            [CONTEXT.EDX, 'edx'], [CONTEXT.ECX, 'ecx'], [CONTEXT.EAX, 'eax'],
            [CONTEXT.EBP, 'ebp'], [CONTEXT.EIP, 'eip'], [CONTEXT.EFLAGS, 'eflags'],
            [CONTEXT.ESP, 'esp'],
        ])
        {
            guest.set32(at + Number(field), registers[String(name)] ?? 0);
        }
        for (const [field, selector] of [
            [CONTEXT.GS, SELECTORS.GS], [CONTEXT.FS, SELECTORS.FS],
            [CONTEXT.ES, SELECTORS.DATA], [CONTEXT.DS, SELECTORS.DATA],
            [CONTEXT.CS, SELECTORS.CODE], [CONTEXT.SS, SELECTORS.DATA],
        ])
        {
            guest.set32(at + field, selector);
        }
    };

    /**
     * Reads back what a handler may have changed.
     *
     * @param {number} at
     * @returns {Record<string, number>}
     */
    const readContext = at=>({
        edi: guest.u32(at + CONTEXT.EDI),
        esi: guest.u32(at + CONTEXT.ESI),
        ebx: guest.u32(at + CONTEXT.EBX),
        edx: guest.u32(at + CONTEXT.EDX),
        ecx: guest.u32(at + CONTEXT.ECX),
        eax: guest.u32(at + CONTEXT.EAX),
        ebp: guest.u32(at + CONTEXT.EBP),
        eip: guest.u32(at + CONTEXT.EIP),
        eflags: guest.u32(at + CONTEXT.EFLAGS),
        esp: guest.u32(at + CONTEXT.ESP),
    });

    /**
     * Where a thread continues once a handler has fixed the exception: the
     * context as the handler left it, its flags laid over the ones the thread
     * had at the exception -- or without flags at all when those were never
     * known, rather than with a word nobody filled in.
     *
     * @param {number} at  The context.
     * @param {number | undefined} flags  The thread's at the exception.
     * @param {any} thread  Whose exception it is, which keeps the debug
     *        registers the record names.
     */
    const continuation = (at, flags, thread)=>{
        /** @type {Record<string, number>} */
        const registers = readContext(at);
        const debug = debugGroupOf(guest.snapshot(at, CONTEXT.SIZE), guest.u32(at + CONTEXT.FLAGS));
        if (debug !== null && thread)
        {
            setDebugRegisters(thread, debug, host.divergence, 'exception');
        }
        // The floating-point groups the record names go back with the rest,
        // where the thread resumes: by then the registers on the processor
        // may be another thread's (`resumeContextAt`'s `float`).
        const groups = floatGroupsOf(guest.snapshot(at, CONTEXT.SIZE),
            guest.u32(at + CONTEXT.FLAGS));
        if (groups !== null && host.float)
        {
            /** @type {any} */ (registers).float = groups;
        }
        else if (groups !== null)
        {
            host.divergence?.('exception',
                "the floating-point registers of a handler's context are not put back");
        }
        if (flags === undefined)
        {
            delete registers.eflags;
            return registers;
        }
        registers.eflags = (registers.eflags & EFLAGS_FROM_CONTEXT
            | flags & ~EFLAGS_FROM_CONTEXT) >>> 0;
        return registers;
    };

    /**
     * What a handler's call is told to start with: the flags of the exception
     * less the ones the system clears, when they are known.
     *
     * @param {number | undefined} flags
     * @returns {{ registers?: Record<string, number> }}
     */
    const entryFlags = flags=>(flags === undefined
        ? {}
        : { registers: { eflags: (flags & ~HANDLER_CLEARS) >>> 0 } });

    /**
     * The frames a thread has registered, outermost last.
     *
     * Read fresh, never kept: a program pushes and pops these itself and never
     * tells anybody. A frame whose memory is not there, or that does not lie
     * above the one before it, ends the walk -- a chain that points backwards
     * is a cycle, and following it does not terminate.
     *
     * @param {any} thread  Whose chain. Named by every caller rather than taken
     *        to be the running thread: a dispatch that has awaited anything is
     *        no longer answering for the thread on the processor.
     * @returns {{ frames: { frame: number, handler: number }[], damaged: boolean,
     *     broken?: number }}  `broken` the link a damaged walk stopped at
     */
    const chain = thread=>{
        /** @type {{ frame: number, handler: number }[]} */
        const frames = [];
        let at = guest.u32(tebOf(thread));
        let previous = 0;
        while (at !== END_OF_CHAIN && at !== 0)
        {
            if (!host.isMapped(at) || at <= previous)
            {
                return { frames, damaged: true, broken: at };
            }
            frames.push({ frame: at, handler: guest.u32(at + 4) });
            previous = at;
            at = guest.u32(at);
            if (frames.length > 256)
            {
                return { frames, damaged: true, broken: at };
            }
        }
        return { frames, damaged: false };
    };

    /**
     * Where a damaged chain broke, for the trace: its frames, the link that
     * left them, and the stack the thread block says the thread has - a frame
     * on another thread's stack, or past this one's, is a stack overrun.
     *
     * @param {any} thread @param {{ frame: number }[]} frames @param {number} [broken]
     */
    const damagedAt = (thread, frames, broken)=>{
        const teb = tebOf(thread);
        return ` at ${hex(broken ?? 0)} after [${frames.map(one=>hex(one.frame)).join(' ')}],`
            + ` stack ${hex(guest.u32(teb + 8))}..${hex(guest.u32(teb + 4))}`;
    };

    /**
     * What a program handed its last-chance filter, in the trace: the
     * exception, the registers its context holds, the thread's handler chain,
     * and the words around every register that points at mapped memory - the
     * frame a failed check was reading, the stack it stood on. A program that
     * fails fast (a security cookie found overwritten) calls the filter and
     * ends, and this is all that is left of the state it found broken.
     *
     * @param {number} pointers  EXCEPTION_POINTERS
     */
    const traceLastChance = pointers=>{
        if (!host.trace)
        {
            return;
        }
        // Every read on its own: a page the memory calls mapped may still
        // refuse a read - a stack's guard page, a range reserved and never
        // committed - and one word refused is one word left out.
        const word = (/** @type {number} */ at)=>{
            try
            {
                return host.isMapped(at >>> 0) ? guest.u32(wholeAddress(at)) : null;
            }
            catch {
                return null;
            }
        };
        const shown = (/** @type {number | null} */ value)=>(value === null ? '-' : hex(value));
        const record = word(pointers);
        const context = word(pointers + 4);
        const lines = [`last chance: code ${record === null ? '?' : shown(word(record))}`
            + ` at ${record === null ? '?' : shown(word(record + RECORD.ADDRESS))}`];
        if (context !== null)
        {
            const names = /** @type {const} */ (['EAX', 'EBX', 'ECX', 'EDX', 'ESI', 'EDI',
                'EBP', 'ESP', 'EIP']);
            const values = names.map(name=>word(context + CONTEXT[name]));
            lines.push(names.map((name, at)=>`${name.toLowerCase()}=${shown(values[at])}`)
                .join(' '));
            for (const [at, value] of values.entries())
            {
                if (value !== null && value >= 64 && value <= 0xffffffbf
                    && word(value) !== null)
                {
                    lines.push(`  [${names[at].toLowerCase()}-64] ${Array.from({ length: 32 },
                        (_, index)=>shown(word(value - 64 + index * 4))).join(' ')}`);
                }
            }
            // The stack above esp whole: a fail-fast's reason - a stack walker's state, the
            // frame it judged - sits in the frames of the calls that gave up.
            const esp = values[names.indexOf('ESP')];
            if (esp !== null)
            {
                for (let row = 0; row < STACK_TRACED / 64; row++)
                {
                    const at = (esp + row * 64) >>> 0;
                    lines.push(`  ${hex(at)}: ${Array.from({ length: 16 },
                        (_, index)=>shown(word(at + index * 4))).join(' ')}`);
                }
            }
        }
        try
        {
            const thread = host.currentThread?.();
            const { frames, damaged } = chain(thread);
            lines.push(`  chain of ${thread?.name ?? 'the thread'}: ${frames.map(
                ({ frame, handler })=>`${hex(frame)}>${hex(handler)}`).join(' ')}`
                + `${damaged ? ' (damaged)' : ''}`);
        }
        catch (e){
            lines.push(`  chain: not read (${String(e)})`);
        }
        host.trace(lines.join('\n'));
    };

    /**
     * The vectored handlers AddVectoredExceptionHandler and
     * AddVectoredContinueHandler registered, the whole process's, each under
     * the handle its registration answered.
     */
    const vectored = {
        /** @type {{ handle: number, entry: number }[]} */
        exception: [],
        /** @type {{ handle: number, entry: number }[]} */
        continue: [],
    };
    let nextVectored = VECTORED_HANDLE_BASE;

    /**
     * Calls a list of vectored handlers in order with the exception's
     * pointers, stopping at the first that answers
     * EXCEPTION_CONTINUE_EXECUTION. Over a copy: a handler may add or remove
     * one while it runs.
     *
     * @param {{ entry: number }[]} list
     * @param {number} pointers @param {any} thread @param {number} flags
     * @returns {Promise<boolean>} whether one asked to continue
     */
    const callVectored = async(list, pointers, thread, flags)=>{
        for (const { entry } of [...list])
        {
            const answer = await host.callGuest({
                entry, args: [pointers], thread, stackAtRest: pointers, ...entryFlags(flags),
            }) | 0;
            if (answer === EXCEPTION_CONTINUE_EXECUTION)
            {
                return true;
            }
        }
        return false;
    };

    /**
     * AddVectored*Handler and RemoveVectored*Handler over one list.
     *
     * @param {{ handle: number, entry: number }[]} list
     */
    const vectoredCalls = list=>({
        add: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, entry])=>{
                if ((entry >>> 0) === 0)
                {
                    return 0;
                }
                const handle = nextVectored;
                nextVectored = (nextVectored + VECTORED_HANDLE_STRIDE) >>> 0;
                const record = { handle, entry: wholeAddress(entry) };
                if (first !== 0)
                {
                    list.unshift(record);
                }
                else
                {
                    list.push(record);
                }
                return handle;
            },
        },
        remove: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const at = list.findIndex(one=>one.handle === wholeAddress(handle));
                if (at < 0)
                {
                    return 0;
                }
                list.splice(at, 1);
                return 1;
            },
        },
    });
    const exceptionHandlers = vectoredCalls(vectored.exception);
    const continueHandlers = vectoredCalls(vectored.continue);

    /**
     * Carves the record and context out of the program's own stack, and moves
     * the stack pointer below them.
     *
     * Below, because the handlers about to run use this same stack and push
     * downwards: leaving the pointer where it was would have the first handler
     * write over the record it was handed.
     *
     * @param {Record<string, number>} registers
     */
    const carve = registers=>{
        const base = (registers.esp - SCRATCH & ~0xf) >>> 0;
        return {
            record: base,
            // Its own word, clear of the record. Sharing one with the record's
            // last parameter is invisible until a handler copies the whole
            // structure, and lethal then.
            context: base + RECORD.SIZE + 4,
            top: base,
        };
    };

    /** Whether a debugger hears this process now. */
    const debugging = ()=>Boolean(host.debugReport) && (host.debugged?.() ?? true);

    /**
     * Tells this process's debugger of an exception, the thread stopped until
     * it answers: meanwhile the context the exception carries is the thread's
     * (`debugStop`), which the debugger reads and may change. Null when no
     * debugger debugs this process.
     *
     * A breakpoint the processor raised (`trap`, an int3's length) shows its
     * debugger the thread past the instruction, as Windows' does - the
     * address is the int3's, Eip the next - and goes on from there when
     * continued; declined, the handlers see Eip at the int3 again.
     *
     * @param {{ code: number, flags?: number, address: number, parameters?: number[],
     *     trap?: number }} what
     * @param {any} thread @param {number} context @param {boolean} firstChance
     * @returns {Promise<number | null>}
     */
    const toDebugger = async(what, thread, context, firstChance)=>{
        const report = host.debugReport;
        if (!report || !debugging())
        {
            return null;
        }
        if (thread)
        {
            thread.debugStop = context;
        }
        const past = what.trap ?? 0;
        if (past !== 0)
        {
            guest.set32(context + CONTEXT.EIP, guest.u32(context + CONTEXT.EIP) + past);
        }
        try
        {
            const answer = await report({ code: DEBUG_EVENT.EXCEPTION,
                threadId: (thread?.id ?? 0) >>> 0, exception: {
                    code: what.code >>> 0, flags: what.flags ?? 0, address: what.address >>> 0,
                    parameters: what.parameters ?? [], firstChance } });
            if (past !== 0 && answer !== DBG_CONTINUE)
            {
                guest.set32(context + CONTEXT.EIP, guest.u32(context + CONTEXT.EIP) - past);
            }
            return answer;
        }
        finally
        {
            if (thread)
            {
                thread.debugStop = null;
            }
        }
    };

    /**
     * Walks the chain, calling every handler in order until one takes the
     * exception or the chain runs out.
     *
     * @param {{ code: number, flags?: number, address: number, parameters?: number[],
     *     raisedFrom?: number, call?: string, trap?: number }} what  `raisedFrom` the
     *     return address of RaiseException's caller, `call` the host function it was
     *     met in, `trap` an int3's length (`toDebugger`)
     * @param {Record<string, number>} [given]  The registers at the exception,
     *        when they are not the processor's right now -- a fault is
     *        reported from a stub that has already moved the stack and spent
     *        two of them.
     * @param {Record<string, number>} [shown]  The context handlers are shown, when it
     *        is not those registers: RaiseException shows its caller as it stands once
     *        the call has returned.
     * @returns {Promise<{ handled: boolean, registers?: Record<string, number>,
     *     record?: number, context?: number, top?: number, asked?: any, flags?: number }>}
     *     When nothing handled it, where the record and context were built,
     *     for the last-chance filter to be handed the same ones.
     */
    const dispatch = async(what, given, shown)=>{
        const registers = given ?? host.registers();
        const flags = registers.eflags;
        const at = carve(registers);
        writeRecord(at.record, {
            code: what.code >>> 0,
            flags: what.flags ?? 0,
            address: what.address >>> 0,
            parameters: what.parameters,
        });
        writeContext(at.context, shown ?? registers);

        // Whose fault this is, read before the walk. Each handler is guest
        // code and the loop turns between them, so from the second one onwards
        // the thread on the processor is somebody else's.
        const asked = host.currentThread?.();

        // The vectored handlers first, the whole process's, in their order,
        // each handed EXCEPTION_POINTERS below the record.
        // A debuggee's debugger hears of it before any handler, and may
        // take it: continued with DBG_CONTINUE, the thread goes on from the
        // context as the debugger left it.
        if (await toDebugger(what, asked, at.context, true) === DBG_CONTINUE)
        {
            return { handled: true, registers: continuation(at.context, flags, asked) };
        }

        const pointers = (at.top - 8) >>> 0;
        guest.set32(pointers, at.record);
        guest.set32(pointers + 4, at.context);
        if (await callVectored(vectored.exception, pointers, asked, flags))
        {
            await callVectored(vectored.continue, pointers, asked, flags);
            return { handled: true, registers: continuation(at.context, flags, asked) };
        }

        // The asking thread's chain: after the vectored handlers the thread on
        // the processor, or the one an executor's call is answered for, may
        // be another, and its frames are not this exception's.
        const { frames, damaged, broken } = chain(asked);
        // A jump into the first page is a call through a null pointer, whose
        // return address -- the call's own place -- is the only lead.
        // A raised one's address is inside RaiseException; who raised it is
        // the call's return address.
        // Met in a host function, that function is named: its address is a
        // trap's, which says nothing.
        // The call's own bytes and the registers say which slot it went
        // through (`ff 50 18` is [eax+0x18]) and whose table held the null.
        const nullCall = ()=>{
            const back = guest.u32(wholeAddress(registers.esp)) >>> 0;
            const bytes = host.isMapped((back - 7) >>> 0)
                ? ` (${[...guest.snapshot(wholeAddress((back - 7) >>> 0), 7)]
                    .map(byte=>byte.toString(16).padStart(2, '0')).join(' ')}`
                    + ` eax=${hex(registers.eax)} ecx=${hex(registers.ecx)}`
                    + ` edx=${hex(registers.edx)} esi=${hex(registers.esi)}`
                    + ` edi=${hex(registers.edi)})` : '';
            return `, called from ${hex(back)}${bytes}`;
        };
        const caller = what.raisedFrom !== undefined
            ? `${what.call ? ` in ${what.call}` : ''}, raised from ${hex(what.raisedFrom)}`
            : (what.address >>> 0) < 0x10000 && host.isMapped(registers.esp >>> 0)
                ? nullCall() : '';
        // An instruction the processor refused is named by its bytes: a
        // deliberate trap and an opcode the translator lacks look alike
        // otherwise.
        const refused = what.code === STATUS.ILLEGAL_INSTRUCTION
            && host.isMapped(what.address >>> 0)
            ? ` (${[...guest.snapshot(wholeAddress(what.address), 8)]
                .map(byte=>byte.toString(16).padStart(2, '0')).join(' ')})` : '';
        // An access violation names the address it could not reach, and
        // whether it read or wrote there: what a caught one was after.
        const reached = what.code === STATUS.ACCESS_VIOLATION && what.parameters?.length === 2
            ? ` ${what.parameters[0] ? 'writing' : 'reading'} ${hex(what.parameters[1])}` : '';
        // A raised one's parameters say what it is: a .NET exception's first
        // is its HRESULT, a C++ one's its object and its type's throw info.
        const told = what.raisedFrom !== undefined && (what.parameters?.length ?? 0) > 0
            ? ` [${(what.parameters ?? []).slice(0, 4).map(hex).join(' ')}]` : '';
        // A refused access in the program's own code, with what the processor
        // held: a process that ends on it leaves nothing else to read, and
        // code a protection decrypts as it runs is not in the file to read.
        /** @param {number} where @param {number} length */
        const bytesAt = (where, length)=>(host.isMapped(where >>> 0)
            ? [...guest.snapshot(wholeAddress(where), length)]
                .map(byte=>byte.toString(16).padStart(2, '0')).join(' ') : 'unmapped');
        /** @param {number} index */
        const stackWord = index=>{
            const slot = (registers.esp + index * 4) >>> 0;
            return host.isMapped(slot) ? hex(guest.u32(wholeAddress(slot))) : '?';
        };
        const state = reached && what.raisedFrom === undefined
            ? ` (${['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp']
                .map(name=>`${name}=${hex(registers[name])}`).join(' ')}`
                + `, code ${bytesAt(what.address, 8)}`
                + `, stack ${Array.from({ length: 12 }, (_, index)=>stackWord(index)).join(' ')})`
            : '';
        host.trace?.(`exception ${hex(what.code)}${told} at ${hex(what.address)}${reached}`
            + `${state}${refused}${caller}, `
            + `${frames.length} frame(s)`
            + `${damaged ? `, chain damaged${damagedAt(asked, frames, broken)}` : ''}`
            + ` on ${asked?.name ?? 'the thread'}`);

        // Windows calls each handler with a frame of its own at the head of
        // the chain, and the C runtime's catch counts on it: the frame
        // handler that finds its catch saves the head, unwinds to its own
        // frame, links the saved frame back on above it, and once the catch
        // block has run takes the head off as "the system's" before jumping
        // to the continuation. With no such frame, a catch in the frame at
        // the head linked that frame to itself and then took it off: the
        // head was left on a frame whose function had returned, and the next
        // exception was offered to it alone.
        const teb = tebOf(asked);
        const own = (at.top - 16) >>> 0;
        const ownHandler = host.dispatcherHandler?.() ?? 0;
        for (const { frame, handler } of frames)
        {
            if (!host.isMapped(handler))
            {
                continue;
            }
            guest.set32(own, guest.u32(teb));
            guest.set32(own + 4, ownHandler);
            guest.set32(teb, own);
            // Handlers run below the record they were handed, each with the
            // flags the system gives one.
            const answer = await host.callGuest({
                entry: handler,
                args: [at.record, frame, at.context, 0],
                thread: asked,
                stackAtRest: own,
                ...entryFlags(flags),
            }) >>> 0;
            // The head is whatever the frame links to now: the handler may
            // have relinked it.
            guest.set32(teb, guest.u32(own));

            if (answer === Disposition.CONTINUE_EXECUTION)
            {
                // What the handler put in the context is where execution goes,
                // and that includes the stack pointer: restoring only the
                // instruction pointer leaves the stack a frame out, every time.
                // The flags too: DF is the faulting code's again.
                if (vectored.continue.length > 0)
                {
                    // The frame's handler ran on the stack below the record,
                    // over where the pointers were.
                    guest.set32(pointers, at.record);
                    guest.set32(pointers + 4, at.context);
                    await callVectored(vectored.continue, pointers, asked, flags);
                }
                return { handled: true, registers: continuation(at.context, flags, asked) };
            }
            if (answer === Disposition.NESTED_EXCEPTION
                || answer === Disposition.COLLIDED_UNWIND)
            {
                // Both mean this walk is already inside another one. Carrying
                // on would call the same handlers again and not terminate.
                host.trace?.(`handler at ${hex(handler)} answered ${answer}`);
                break;
            }
        }

        return {
            handled: false, record: at.record, context: at.context, top: at.top, asked, flags,
        };
    };

    /**
     * Calls each frame's handler with the unwinding flag, down to but not
     * including the target, taking each frame off the chain as its handler
     * returns.
     *
     * One at a time, not all at the end: a handler that raises while it runs
     * -- a destructor that throws, a `__finally` that faults -- starts a new
     * dispatch from the head as it stands, and the frames already unwound
     * must not be found on it and unwound a second time.
     *
     * A target of zero or -1 is no target: every frame goes, which is how a
     * thread leaves the chain on its way out.
     *
     * @param {number} targetFrame
     * @param {number} address
     * @param {Object} [options]
     * @param {number} [options.record]  The record the handlers are shown.
     *        The exception being unwound for when there is one -- a handler
     *        reads which exception is taking its frame away -- and a fresh one
     *        when there is not.
     * @param {Record<string, number>} [options.registers]  Where the unwinding
     *        thread stands. Given by a caller that has awaited anything since
     *        it was called: the processor's registers are somebody else's by
     *        then, and a record carved below them lands on another stack.
     * @param {any} [options.thread]  Whose frames these are, for the same reason.
     * @param {Record<string, number>} [options.shown]  The registers the
     *        handlers' context shows, where they are not the ones the record
     *        is carved below: RtlUnwind's caller as it stands once the call
     *        returns.
     * @returns {Promise<{ unwound: boolean, context: number }>}  `context`:
     *        where the handlers' context lies, which they may have changed.
     */
    const unwind = async(targetFrame, address, options = {})=>{
        const asked = options.thread ?? host.currentThread?.();
        const { frames, damaged } = chain(asked);
        const registers = options.registers ?? host.registers();
        const record = options.record ?? 0;
        const at = carve(registers);
        const target = wholeAddress(targetFrame);
        const everything = target === 0 || target === END_OF_CHAIN;
        const flags = EH_UNWINDING | (everything ? EXCEPTION_EXIT_UNWIND : 0);
        let shown = at.record;
        if (record !== 0 && host.isMapped(record))
        {
            shown = record >>> 0;
            guest.set32(shown + RECORD.FLAGS, guest.u32(shown + RECORD.FLAGS) | flags);
        }
        else
        {
            writeRecord(at.record, {
                code: STATUS.UNWIND,
                flags: flags | EXCEPTION_NONCONTINUABLE,
                address,
            });
        }
        writeContext(at.context, options.shown ?? registers);

        // A target that is not on the chain is the program's mistake, and
        // taking every frame off on the way to not finding it would destroy
        // state the program still has. Nothing is unwound.
        if (!everything && !frames.some(({ frame })=>frame === target))
        {
            return { unwound: false, context: at.context };
        }

        const teb = tebOf(asked);
        let reached = everything;
        host.trace?.(`unwind on ${asked?.name ?? 'the thread'} to ${everything ? 'the end'
            : hex(target)}: ${frames.slice(0, frames.findIndex(({ frame })=>frame === target)
            >>> 0).map(({ frame, handler })=>`${hex(frame)}>${hex(handler)}`).join(' ')}`);
        for (let index = 0; index < frames.length; index++)
        {
            const { frame, handler } = frames[index];
            if (frame === target)
            {
                reached = true;
                break;
            }
            // The dispatch's own frame answers nothing worth a call.
            if (host.isMapped(handler) && handler !== host.dispatcherHandler?.())
            {
                await host.callGuest({
                    entry: handler,
                    args: [shown, frame, at.context, 0],
                    thread: asked,
                    stackAtRest: at.top,
                });
            }
            // The next frame is published only when it is one the walk could
            // read. A chain damaged beyond this frame is left where it is
            // rather than having the damage written back as the new head.
            const next = frames[index + 1]?.frame
                ?? (damaged ? null : END_OF_CHAIN);
            if (next !== null)
            {
                guest.set32(teb, next);
            }
        }
        return { unwound: reached && !damaged, context: at.context };
    };

    /**
     * An exception nothing on the chain took: the last-chance filter the
     * program installed is asked, and the process ends unless it says the
     * exception is fixed.
     *
     * @param {{ code: number, flags?: number, address: number }} what
     * @param {{ record: number, context: number, top: number, asked?: any,
     *     flags?: number }} at  `flags`: the thread's at the exception.
     * @returns {Promise<{ handled: boolean, registers?: Record<string, number> }>}
     */
    const lastChance = async(what, at)=>{
        // A debuggee's unhandled exception is its debugger's second chance,
        // and the program's own filter is not asked, as Windows'
        // UnhandledExceptionFilter declines when a debugger is attached.
        if (debugging())
        {
            if (await toDebugger(what, at.asked, at.context, false) === DBG_CONTINUE)
            {
                return { handled: true, registers: continuation(at.context, at.flags, at.asked) };
            }
        }
        else if (topLevelFilter !== 0)
        {
            const pointers = (at.top - 8) >>> 0;
            guest.set32(pointers, at.record);
            guest.set32(pointers + 4, at.context);
            // With the flags a handler starts with: a chain with no frame on
            // it leaves the thread with the faulting code's own.
            const answer = await host.callGuest({
                entry: topLevelFilter,
                args: [pointers],
                thread: at.asked,
                stackAtRest: pointers,
                ...entryFlags(at.flags),
            }) | 0;
            if (answer === EXCEPTION_CONTINUE_EXECUTION
                && ((what.flags ?? 0) & EXCEPTION_NONCONTINUABLE) === 0)
            {
                return { handled: true, registers: continuation(at.context, at.flags, at.asked) };
            }
        }
        host.trace?.(`unhandled exception ${hex(what.code)} at ${hex(what.address)}`);
        host.terminate?.({ code: what.code >>> 0, address: what.address >>> 0 });
        // The process is over; the call that raised never returns.
        return new Promise(()=>{});
    };

    /**
     * Raises an exception on the running thread and answers with what the
     * raising call should do next. Nothing handled means the process ends.
     *
     * @param {{ code: number, flags?: number, address: number, parameters?: number[],
     *     raisedFrom?: number, call?: string }} what  `raisedFrom` the return address of
     *     RaiseException's caller, `call` the host function it was met in
     * @param {Record<string, number>} [shown]  The context handlers are shown, when it
     *     is not the registers on the processor (`dispatch`).
     */
    const raise = async(what, shown)=>{
        const result = await dispatch(what, undefined, shown);
        if (result.handled)
        {
            return result;
        }
        return lastChance(what, {
            record: result.record ?? 0, context: result.context ?? 0,
            top: result.top ?? 0, asked: result.asked, flags: result.flags,
        });
    };

    /**
     * Raises an exception at the host call running now, as RaiseException
     * would have from there: one that continues gets the call back answering
     * zero, with the context it continued from.
     *
     * @param {number} code @param {number} flags @param {number[]} parameters
     * @param {string} [call]  the host function it was met in, for the trace
     */
    const raiseFromCall = (code, flags, parameters, call)=>{
        const registers = host.registers();
        return raise({
            code: code >>> 0,
            flags,
            address: registers.eip,
            parameters,
            raisedFrom: guest.u32(wholeAddress(registers.esp)),
            ...call ? { call } : {},
        }).then(result=>(result.registers ? host.answerWith(0, result.registers) : 0));
    };

    return {
        dispatch,
        raise,
        unwind,
        chain,

        /**
         * A guest access a host call made for the program and memory refused,
         * raised as the access violation Windows raises at the DLL's own
         * instruction: the program's handlers see STATUS_ACCESS_VIOLATION
         * with whether it read (0), wrote (1) or executed (8) and where, and
         * one that continues gets the call back answering zero. Unhandled,
         * the process ends with it, as on Windows.
         *
         * @param {{ address: number, mode: 'read' | 'write' | 'execute', call?: string }} fault
         * @returns {Promise<any>}
         */
        raiseAccess: fault=>raiseFromCall(STATUS.ACCESS_VIOLATION, 0,
            [fault.mode === 'write' ? 1 : fault.mode === 'execute' ? 8 : 0, fault.address >>> 0],
            fault.call),

        /**
         * An exception a host handler raises as Windows' function raises it
         * (`win32/common/raise.js`): the code, flags and information given,
         * at the call. Answered as RaiseException's is.
         *
         * @param {{ status: number, flags: number, parameters: number[], call?: string }} raised
         * @returns {Promise<any>}
         */
        raiseException: raised=>raiseFromCall(raised.status,
            raised.flags & EXCEPTION_NONCONTINUABLE, raised.parameters, raised.call),

        /**
         * Whether a processor exception is one a program can be handed.
         *
         * @param {number} vector
         */
        claims: vector=>Object.hasOwn(VECTOR_TO_STATUS, vector),

        /**
         * A processor exception, offered to the program before it becomes a
         * failure. A program that faults on purpose -- probing a pointer, or
         * catching its own divide by zero -- is ordinary, and halting instead
         * loses every one of them.
         *
         * @param {{ vector: number, eip: number, errorCode: number | null,
         *     address?: number }} fault
         * @param {Record<string, number>} registers  The faulting code's, as
         *        the context shows them.
         * @returns {Promise<{ handled: boolean, registers?: Record<string, number> }>}
         */
        async onFault(fault, registers){
            if (fault.vector === 6)
            {
                const answered = storeMachineStatus(guest.snapshot, registers);
                if (answered)
                {
                    return { handled: true, registers: answered };
                }
            }
            // An instruction ring 3 may not run is a privileged one to the
            // program, whichever fault the processor model raised for it.
            const privileged = (fault.vector === 6 || fault.vector === 13)
                && host.isMapped(registers.eip >>> 0)
                && privilegedAt(guest.snapshot, registers.eip >>> 0);
            // The debug service with no debugger to serve it: the services
            // that only tell a debugger something (a string, a module's
            // symbols) go on one byte past the instruction - the system's
            // return from the service skips it, which is why compilers put a
            // breakpoint byte after `int 0x2d`; the rest are a breakpoint
            // reported just after it, the service and its two arguments as
            // parameters.
            if (fault.vector === DEBUG_SERVICE && SILENT_SERVICES.has(registers.eax >>> 0))
            {
                return { handled: true, registers: { ...registers, eip: registers.eip + 1 >>> 0 } };
            }
            const guarded = fault.vector === 14 && fault.address !== undefined
                ? guardTouched(fault.address >>> 0) : null;
            if (guarded === 'grown')
            {
                return { handled: true, registers };
            }
            const code = privileged ? STATUS.PRIVILEGED_INSTRUCTION
                : guarded === 'overflow' ? STATUS.STACK_OVERFLOW
                    : guarded === 'guard' ? STATUS.GUARD_PAGE_VIOLATION
                        : VECTOR_TO_STATUS[/** @type {keyof typeof VECTOR_TO_STATUS} */ (
                            fault.vector)];
            if (code === undefined)
            {
                return { handled: false };
            }
            // An access violation says whether it was a read or a write, and
            // what address, because a handler is allowed to read them -- one
            // that commits the page it was refused and goes on reads both. A
            // protection fault has no address to give, and says so with -1.
            const parameters = fault.vector === 14 || code === STATUS.ACCESS_VIOLATION
                ? [(fault.errorCode ?? 0) & 2 ? 1 : 0,
                    fault.vector === 13 ? 0xffffffff : (fault.address ?? 0) >>> 0]
                : fault.vector === DEBUG_SERVICE
                    ? [registers.eax >>> 0, registers.ecx >>> 0, registers.edx >>> 0] : [];
            // An int3 the debugger continues goes on past it (`toDebugger`).
            const trap = fault.vector === 3 ? 1 : 0;
            const result = await dispatch({ code, address: registers.eip, parameters,
                ...trap ? { trap } : {} }, registers);
            if (result.handled)
            {
                return result;
            }
            // The last chance, as for a raise -- except that a program with no
            // filter of its own ends with the fault reported rather than with
            // an exit code, since the report is the only account of it; a
            // debuggee's debugger has its second chance first.
            if (topLevelFilter === 0 && !debugging())
            {
                return { handled: false };
            }
            return lastChance({ code, address: registers.eip }, {
                record: result.record ?? 0, context: result.context ?? 0,
                top: result.top ?? 0, asked: result.asked, flags: result.flags,
            });
        },

        /** The guest-callable half. */
        table: {
            /**
             * PVOID AddVectoredExceptionHandler(ULONG First, PVECTORED_EXCEPTION_HANDLER)
             *
             * A handler every exception in the process is offered before any
             * frame's, first in line when First is nonzero; the handle it
             * answers removes it again.
             */
            AddVectoredExceptionHandler: exceptionHandlers.add,
            /** ULONG RemoveVectoredExceptionHandler(PVOID Handle) */
            RemoveVectoredExceptionHandler: exceptionHandlers.remove,
            /**
             * PVOID AddVectoredContinueHandler(ULONG First, PVECTORED_EXCEPTION_HANDLER)
             *
             * Called when a handler has decided an exception is fixed and
             * execution goes on, with the context it will go on with.
             */
            AddVectoredContinueHandler: continueHandlers.add,
            /** ULONG RemoveVectoredContinueHandler(PVOID Handle) */
            RemoveVectoredContinueHandler: continueHandlers.remove,

            /**
             * VOID RaiseException(DWORD dwExceptionCode, DWORD dwExceptionFlags,
             *                     DWORD nNumberOfArguments, const ULONG_PTR *lpArguments)
             */
            RaiseException: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([code, flags, count, args])=>{
                    const from = wholeAddress(args);
                    const total = from === 0 ? 0 : Math.min(count >>> 0, 15);
                    /** @type {number[]} */
                    const parameters = [];
                    for (let at = 0; at < total; at++)
                    {
                        parameters.push(guest.u32(from + at * 4));
                    }
                    // The context handlers are shown is the caller's as it
                    // stands once the call has returned - its return address,
                    // its stack past the four arguments - which is what
                    // RtlRaiseException captures. A handler that continues
                    // goes on from that context whole, wherever it points, as
                    // NtContinue does: left as it was, back in the caller; laid
                    // over with another (a .NET runtime resuming a thread it
                    // redirected for a collection lays the thread's saved
                    // context there), at that one's Eip and Esp. Returned to the
                    // caller with only the other registers taken, such a thread
                    // went on in the runtime's stub with the frame pointer of
                    // the code it was redirected from.
                    const registers = host.registers();
                    const esp = registers.esp >>> 0;
                    const caller = { ...registers, eip: guest.u32(esp), esp: esp + 4 + 16 >>> 0 };
                    return raise({
                        code: code >>> 0,
                        flags: flags >>> 0 & EXCEPTION_NONCONTINUABLE,
                        address: registers.eip,
                        parameters,
                        raisedFrom: caller.eip,
                    }, caller).then(result=>(!result.registers ? 0
                        : host.continueAt ? host.continueAt(result.registers)
                            : host.answerWith(0, result.registers)));
                },
            },

            /**
             * VOID RtlUnwind(PVOID TargetFrame, PVOID TargetIp,
             *                PEXCEPTION_RECORD ExceptionRecord, PVOID ReturnValue)
             *
             * The handlers are shown the caller's context as it stands once
             * the call returns - its return address, its stack past the four
             * arguments, ReturnValue in Eax - and the call returns what Eax
             * holds when they are done: a handler that changes it changes the
             * answer (Wine's exception test, test_unwind). TargetIp is not
             * where the caller goes on: the call returns to it as any does.
             */
            RtlUnwind: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([targetFrame, , record, returnValue])=>{
                    const registers = host.registers();
                    const esp = registers.esp >>> 0;
                    const caller = { ...registers, eip: guest.u32(esp),
                        esp: esp + 4 + 16 >>> 0, eax: wholeAddress(returnValue) };
                    return unwind(wholeAddress(targetFrame), caller.eip,
                        { record: wholeAddress(record), registers, shown: caller })
                        .then(({ context })=>guest.u32(context + CONTEXT.EAX));
                },
            },

            /**
             * LPTOP_LEVEL_EXCEPTION_FILTER SetUnhandledExceptionFilter(
             *     LPTOP_LEVEL_EXCEPTION_FILTER lpTopLevelExceptionFilter)
             *
             * Answers with the one it replaces, because a caller chains to it.
             */
            SetUnhandledExceptionFilter: {
                returns: 'pointer',
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([filter])=>{
                    const previous = topLevelFilter;
                    topLevelFilter = wholeAddress(filter);
                    return previous;
                },
            },

            /**
             * LONG UnhandledExceptionFilter(struct _EXCEPTION_POINTERS *ExceptionInfo)
             *
             * The installed filter is guest code and is called. A program's
             * last-chance handler is where it writes its own crash report, and
             * declining to run it is declining the only account of the failure
             * anybody gets.
             *
             * Under a debugger - the process has a debug port, whatever the
             * process block's BeingDebugged says - the exception is the
             * debugger's second chance: no filter runs and the answer is
             * EXCEPTION_CONTINUE_SEARCH (Wine's kernel32 debugger.c
             * test_unhandled_exception_filter).
             */
            UnhandledExceptionFilter: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([pointers])=>{
                    // A diagnostic: what it could not read is left out, and the
                    // program's call goes on as if it had not looked.
                    try
                    {
                        traceLastChance(wholeAddress(pointers));
                    }
                    catch (e){
                        host.trace?.(`last chance: not traced (${String(e)})`);
                    }
                    if (debugging())
                    {
                        return EXCEPTION_CONTINUE_SEARCH;
                    }
                    if (topLevelFilter === 0)
                    {
                        return EXCEPTION_EXECUTE_HANDLER;
                    }
                    return host.callGuest({
                        entry: topLevelFilter,
                        args: [wholeAddress(pointers)],
                    }).then(answer=>answer | 0);
                },
            },
        },
    };
}
