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
 * Not the shape the emulator keeps -- that is an array of registers in the
 * processor's own order -- so every field here is a translation, and the
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

/** CONTEXT_FULL: control, integer and segment registers. */
export const CONTEXT_FULL = 0x00010007;

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

/** The chain ends with this, not with zero -- zero is an address. */
export const END_OF_CHAIN = 0xffffffff;

/** ExceptionFlags. */
export const EXCEPTION_NONCONTINUABLE = 0x01;
export const EH_UNWINDING = 0x02;

/** What a filter answers. */
export const EXCEPTION_EXECUTE_HANDLER = 1;
export const EXCEPTION_CONTINUE_SEARCH = 0;

/** Codes raised by the processor rather than by a program. */
export const STATUS = Object.freeze({
    ACCESS_VIOLATION: 0xc0000005,
    ILLEGAL_INSTRUCTION: 0xc000001d,
    INTEGER_DIVIDE_BY_ZERO: 0xc0000094,
    PRIVILEGED_INSTRUCTION: 0xc0000096,
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
});

/**
 * How much stack a dispatch reserves below the fault.
 *
 * The record, a context, the two pointers a filter is handed, and room for the
 * handlers themselves to run below all of it. Handlers run on the faulting
 * thread's own stack, so anything they push has to land below what they were
 * given rather than on top of it.
 */
const SCRATCH = RECORD.SIZE + CONTEXT.SIZE + 0x20;

/** @param {number} value */
const hex = value=>`0x${(value >>> 0).toString(16)}`;

/**
 * @typedef {Object} SehHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number) => boolean} isMapped
 *           Whether a frame's memory is there. A bounds test and nothing more.
 * @property {() => number} teb  The running thread's block; its first word is
 *           the head of the chain.
 * @property {() => Record<string, number>} registers  EFLAGS among them
 *           (`eflags`) when the host can read them; without them a handler
 *           starts with the flags as they stand and continues with them.
 * @property {(values: Record<string, number>) => void} setRegisters
 * @property {(options: { entry: number, args: number[], thread?: any,
 *                        stackAtRest?: number,
 *                        registers?: Record<string, number> }) => Promise<number>} callGuest
 *           Runs guest code with its frame built at `stackAtRest`, which is
 *           where a handler has to start: the record and context it is handed
 *           sit on this same stack, and a frame built anywhere above them is
 *           a handler writing over what it is reading. `registers.eflags`,
 *           when given, is the flags word it starts with.
 * @property {() => any} [currentThread]
 * @property {(text: string) => void} [trace]
 * @property {(what: { code: number, address: number }) => void} [terminate]
 *           Ends the process for an exception nothing handled, with the
 *           exception's code as its exit code -- what Windows does once the
 *           last-chance filter has had its say.
 */

/** EXCEPTION_EXIT_UNWIND: an unwind with no target, taking every frame. */
export const EXCEPTION_EXIT_UNWIND = 0x04;

/** What a filter answers to have the faulting instruction run again. */
export const EXCEPTION_CONTINUE_EXECUTION = -1;

/**
 * @param {SehHost} host
 */
export function createSeh(host){
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
     * A thread's block, whose first word heads its chain.
     *
     * @param {any} [thread]
     */
    const tebOf = thread=>(thread?.tebAddress ?? host.teb()) >>> 0;

    /** The last top-level filter a program installed. */
    let topLevelFilter = 0;

    /**
     * Writes an exception record where a handler will look for it.
     *
     * @param {number} at
     * @param {{ code: number, flags: number, address: number, parameters?: number[] }} what
     */
    const writeRecord = (at, what)=>{
        host.writeMemory(at, new Uint8Array(RECORD.SIZE));
        writeU32(at + RECORD.CODE, what.code);
        writeU32(at + RECORD.FLAGS, what.flags);
        writeU32(at + RECORD.NESTED, 0);
        writeU32(at + RECORD.ADDRESS, what.address);
        const parameters = (what.parameters ?? []).slice(0, 15);
        writeU32(at + RECORD.PARAMETER_COUNT, parameters.length);
        parameters.forEach((value, index)=>
            writeU32(at + RECORD.INFORMATION + index * 4, value));
    };

    /**
     * Writes the running registers as a program's CONTEXT.
     *
     * @param {number} at
     * @param {Record<string, number>} registers
     */
    const writeContext = (at, registers)=>{
        host.writeMemory(at, new Uint8Array(CONTEXT.SIZE));
        writeU32(at + CONTEXT.FLAGS, CONTEXT_FULL);
        for (const [field, name] of [
            [CONTEXT.EDI, 'edi'], [CONTEXT.ESI, 'esi'], [CONTEXT.EBX, 'ebx'],
            [CONTEXT.EDX, 'edx'], [CONTEXT.ECX, 'ecx'], [CONTEXT.EAX, 'eax'],
            [CONTEXT.EBP, 'ebp'], [CONTEXT.EIP, 'eip'], [CONTEXT.EFLAGS, 'eflags'],
            [CONTEXT.ESP, 'esp'],
        ])
        {
            writeU32(at + Number(field), registers[String(name)] ?? 0);
        }
    };

    /**
     * Reads back what a handler may have changed.
     *
     * @param {number} at
     * @returns {Record<string, number>}
     */
    const readContext = at=>({
        edi: readU32(at + CONTEXT.EDI),
        esi: readU32(at + CONTEXT.ESI),
        ebx: readU32(at + CONTEXT.EBX),
        edx: readU32(at + CONTEXT.EDX),
        ecx: readU32(at + CONTEXT.ECX),
        eax: readU32(at + CONTEXT.EAX),
        ebp: readU32(at + CONTEXT.EBP),
        eip: readU32(at + CONTEXT.EIP),
        eflags: readU32(at + CONTEXT.EFLAGS),
        esp: readU32(at + CONTEXT.ESP),
    });

    /**
     * Where a thread continues once a handler has fixed the exception: the
     * context as the handler left it, its flags laid over the ones the thread
     * had at the exception -- or without flags at all when those were never
     * known, rather than with a word nobody filled in.
     *
     * @param {number} at  The context.
     * @param {number | undefined} flags  The thread's at the exception.
     */
    const continuation = (at, flags)=>{
        /** @type {Record<string, number>} */
        const registers = readContext(at);
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
     * @param {any} [thread]  Whose chain; the running thread's by default.
     * @returns {{ frames: { frame: number, handler: number }[], damaged: boolean }}
     */
    const chain = thread=>{
        /** @type {{ frame: number, handler: number }[]} */
        const frames = [];
        let at = readU32(tebOf(thread));
        let previous = 0;
        while (at !== END_OF_CHAIN && at !== 0)
        {
            if (!host.isMapped(at) || at <= previous)
            {
                return { frames, damaged: true };
            }
            frames.push({ frame: at, handler: readU32(at + 4) });
            previous = at;
            at = readU32(at);
            if (frames.length > 256)
            {
                return { frames, damaged: true };
            }
        }
        return { frames, damaged: false };
    };

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

    /**
     * Walks the chain, calling every handler in order until one takes the
     * exception or the chain runs out.
     *
     * @param {{ code: number, flags?: number, address: number, parameters?: number[] }} what
     * @param {Record<string, number>} [given]  The registers at the exception,
     *        when they are not the processor's right now -- a fault is
     *        reported from a stub that has already moved the stack and spent
     *        two of them.
     * @returns {Promise<{ handled: boolean, registers?: Record<string, number>,
     *     record?: number, context?: number, top?: number, asked?: any, flags?: number }>}
     *     When nothing handled it, where the record and context were built,
     *     for the last-chance filter to be handed the same ones.
     */
    const dispatch = async(what, given)=>{
        const registers = given ?? host.registers();
        const flags = registers.eflags;
        const at = carve(registers);
        writeRecord(at.record, {
            code: what.code >>> 0,
            flags: what.flags ?? 0,
            address: what.address >>> 0,
            parameters: what.parameters,
        });
        writeContext(at.context, registers);

        // Whose fault this is, read before the walk. Each handler is guest
        // code and the loop turns between them, so from the second one onwards
        // the thread on the processor is somebody else's.
        const asked = host.currentThread?.();
        const { frames, damaged } = chain();
        host.trace?.(`exception ${hex(what.code)} at ${hex(what.address)}, `
            + `${frames.length} frame(s)${damaged ? ', chain damaged' : ''}`);

        for (const { frame, handler } of frames)
        {
            if (!host.isMapped(handler))
            {
                continue;
            }
            // Handlers run below the record they were handed, each with the
            // flags the system gives one.
            const answer = await host.callGuest({
                entry: handler,
                args: [at.record, frame, at.context, 0],
                thread: asked,
                stackAtRest: at.top,
                ...entryFlags(flags),
            }) >>> 0;

            if (answer === Disposition.CONTINUE_EXECUTION)
            {
                // What the handler put in the context is where execution goes,
                // and that includes the stack pointer: restoring only the
                // instruction pointer leaves the stack a frame out, every time.
                // The flags too: DF is the faulting code's again.
                return { handled: true, registers: continuation(at.context, flags) };
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
     */
    const unwind = async(targetFrame, address, options = {})=>{
        const { frames, damaged } = chain(options.thread);
        const registers = options.registers ?? host.registers();
        const record = options.record ?? 0;
        const at = carve(registers);
        const target = targetFrame >>> 0;
        const everything = target === 0 || target === END_OF_CHAIN;
        const flags = EH_UNWINDING | (everything ? EXCEPTION_EXIT_UNWIND : 0);
        let shown = at.record;
        if (record !== 0 && host.isMapped(record))
        {
            shown = record >>> 0;
            writeU32(shown + RECORD.FLAGS, readU32(shown + RECORD.FLAGS) | flags);
        }
        else
        {
            writeRecord(at.record, {
                code: STATUS.UNWIND,
                flags: flags | EXCEPTION_NONCONTINUABLE,
                address,
            });
        }
        writeContext(at.context, registers);

        // A target that is not on the chain is the program's mistake, and
        // taking every frame off on the way to not finding it would destroy
        // state the program still has. Nothing is unwound.
        if (!everything && !frames.some(({ frame })=>frame === target))
        {
            return { unwound: false };
        }

        // As above: the unwind runs a handler per frame, and only the first
        // of them runs on the thread that is standing here now.
        const asked = options.thread ?? host.currentThread?.();
        const teb = tebOf(asked);
        let reached = everything;
        for (let index = 0; index < frames.length; index++)
        {
            const { frame, handler } = frames[index];
            if (frame === target)
            {
                reached = true;
                break;
            }
            if (host.isMapped(handler))
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
                writeU32(teb, next);
            }
        }
        return { unwound: reached && !damaged };
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
        if (topLevelFilter !== 0)
        {
            const pointers = (at.top - 8) >>> 0;
            writeU32(pointers, at.record);
            writeU32(pointers + 4, at.context);
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
                return { handled: true, registers: continuation(at.context, at.flags) };
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
     * @param {{ code: number, flags?: number, address: number, parameters?: number[] }} what
     */
    const raise = async what=>{
        const result = await dispatch(what);
        if (result.handled)
        {
            return result;
        }
        return lastChance(what, {
            record: result.record ?? 0, context: result.context ?? 0,
            top: result.top ?? 0, asked: result.asked, flags: result.flags,
        });
    };

    return {
        dispatch,
        raise,
        unwind,
        chain,

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
         * @param {{ vector: number, eip: number, errorCode: number | null }} fault
         * @param {Record<string, number>} registers  The faulting code's, as
         *        the context shows them.
         * @returns {Promise<{ handled: boolean, registers?: Record<string, number> }>}
         */
        async onFault(fault, registers){
            const code = VECTOR_TO_STATUS[/** @type {keyof typeof VECTOR_TO_STATUS} */
                (fault.vector)];
            if (code === undefined)
            {
                return { handled: false };
            }
            // An access violation says whether it was a read or a write, and
            // what address, because a handler is allowed to read them. A
            // protection fault has no address to give, and says so with -1.
            const parameters = code === STATUS.ACCESS_VIOLATION
                ? [(fault.errorCode ?? 0) & 2 ? 1 : 0, fault.vector === 13 ? 0xffffffff : 0]
                : [];
            const result = await dispatch({ code, address: registers.eip, parameters }, registers);
            if (result.handled)
            {
                return result;
            }
            // The last chance, as for a raise -- except that a program with no
            // filter of its own ends with the fault reported rather than with
            // an exit code, since the report is the only account of it.
            if (topLevelFilter === 0)
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
             * VOID RaiseException(DWORD dwExceptionCode, DWORD dwExceptionFlags,
             *                     DWORD nNumberOfArguments, const ULONG_PTR *lpArguments)
             */
            RaiseException: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([code, flags, count, args])=>{
                    const from = args >>> 0;
                    const total = from === 0 ? 0 : Math.min(count >>> 0, 15);
                    /** @type {number[]} */
                    const parameters = [];
                    for (let at = 0; at < total; at++)
                    {
                        parameters.push(readU32(from + at * 4));
                    }
                    return raise({
                        code: code >>> 0,
                        flags: flags >>> 0 & EXCEPTION_NONCONTINUABLE,
                        address: host.registers().eip,
                        parameters,
                    }).then(result=>{
                        if (result.registers)
                        {
                            host.setRegisters(result.registers);
                        }
                        return 0;
                    });
                },
            },

            /**
             * VOID RtlUnwind(PVOID TargetFrame, PVOID TargetIp,
             *                PEXCEPTION_RECORD ExceptionRecord, PVOID ReturnValue)
             */
            RtlUnwind: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([targetFrame, targetIp, record, returnValue])=>
                    unwind(targetFrame >>> 0, targetIp >>> 0, { record: record >>> 0 })
                        .then(()=>returnValue >>> 0),
            },

            /**
             * LPTOP_LEVEL_EXCEPTION_FILTER SetUnhandledExceptionFilter(
             *     LPTOP_LEVEL_EXCEPTION_FILTER lpTopLevelExceptionFilter)
             *
             * Answers with the one it replaces, because a caller chains to it.
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
             * The installed filter is guest code and is called. A program's
             * last-chance handler is where it writes its own crash report, and
             * declining to run it is declining the only account of the failure
             * anybody gets.
             */
            UnhandledExceptionFilter: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([pointers])=>{
                    if (topLevelFilter === 0)
                    {
                        return EXCEPTION_EXECUTE_HANDLER;
                    }
                    return host.callGuest({
                        entry: topLevelFilter,
                        args: [pointers >>> 0],
                    }).then(answer=>answer | 0);
                },
            },
        },
    };
}
