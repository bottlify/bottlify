/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * C++ exceptions, as the compiler lays them out and the runtime runs them.
 *
 * A `throw` compiles to a call to `_CxxThrowException` with the object and a
 * description of its type, and that raises an ordinary structured exception
 * with the code 0xE06D7363 carrying both. Every function with a `try` or an
 * object to destroy registers a frame on the same chain `__try` uses, whose
 * handler is a small stub of the compiler's that loads EAX with the function's
 * tables and jumps here. So nothing about C++ needs a dispatcher of its own:
 * the system walk finds the frames, and this is what each of them answers.
 *
 * The frame the compiler pushes:
 *
 *     -0x04  the stack pointer the function's body runs at
 *     +0x00  previous frame
 *     +0x04  the handler stub
 *     +0x08  the state: which objects are alive and which try block is entered
 *
 * and every funclet the tables name -- a destructor to run, a catch block --
 * addresses the function's locals through EBP set to the frame plus 0x0c.
 *
 * What a frame answers, in the order the runtime does it:
 *
 * - Being unwound, it runs the destructors of every object still alive, from
 *   its state back to the empty one, and declines the exception.
 * - Otherwise it looks for a catch among the try blocks around its state,
 *   innermost first, comparing each handler's type with every type the thrown
 *   object can be caught as. On a match: the frames below are unwound, the
 *   catch object is built in the frame, the objects the try block's own scope
 *   made are destroyed, the catch block runs -- on the stack below the throw,
 *   where the thrown object still lives -- and the function goes on at the
 *   address the block returns, on the stack the block itself recorded. The
 *   thrown object is destroyed when the block ends, unless the block threw it
 *   again.
 *
 * A structured exception that is not a C++ one reaches a `catch (...)` only
 * in code built to allow it, and passes through a translator first when the
 * program installed one.
 */

import { Disposition, EH_UNWINDING, EXCEPTION_EXIT_UNWIND, EXCEPTION_NONCONTINUABLE, RECORD }
    from '../kernel32/seh.js';

/** The exception code every C++ throw raises: 0xE0 followed by "msc". */
export const EH_EXCEPTION_NUMBER = 0xe06d7363;

/** What the first parameter of such an exception says, one per compiler generation. */
export const EH_MAGIC = Object.freeze({ V1: 0x19930520, V2: 0x19930521, V3: 0x19930522 });

/** The frame a C++ function registers. */
export const EH_FRAME = Object.freeze({
    SAVED_ESP: -0x04,
    PREVIOUS: 0x00,
    HANDLER: 0x04,
    STATE: 0x08,
    /** What EBP is, relative to the frame, while a funclet runs. */
    EBP: 0x0c,
});

/** No object alive and no try block entered. */
const EMPTY_STATE = -1;

/** FuncInfo, the tables the stub hands over in EAX. */
const FUNC_INFO = Object.freeze({
    MAGIC: 0, MAX_STATE: 4, UNWIND_MAP: 8, TRY_BLOCKS: 12, TRY_MAP: 16,
    ES_TYPE_LIST: 28, EH_FLAGS: 32,
});

/** EHFlags: built with /EHs, so a catch (...) does not take a structured exception. */
const FI_EHS = 1;

/** Sizes of the table entries. */
const UNWIND_ENTRY = 8;
const TRY_ENTRY = Object.freeze({
    LOW: 0, HIGH: 4, CATCH_HIGH: 8, CATCHES: 12, HANDLERS: 16, SIZE: 20,
});
const HANDLER = Object.freeze({ ADJECTIVES: 0, TYPE: 4, CATCH_OBJECT: 8, ADDRESS: 12, SIZE: 16 });
const THROW_INFO = Object.freeze({ ATTRIBUTES: 0, UNWIND: 4, CATCHABLE_TYPES: 12 });
const CATCHABLE = Object.freeze({
    PROPERTIES: 0, TYPE: 4, MDISP: 8, PDISP: 12, VDISP: 16, SIZE: 20, COPY: 24,
});

/** A type descriptor's decorated name begins after two words. */
const TYPE_NAME = 8;

/** HandlerType adjectives. */
const HT = Object.freeze({ CONST: 1, VOLATILE: 2, UNALIGNED: 4, REFERENCE: 8 });

/** CatchableType properties. */
const CT = Object.freeze({ SIMPLE: 1, BY_REFERENCE_ONLY: 2, VIRTUAL_BASE: 4 });

/** ThrowInfo attributes. */
const TI = Object.freeze({ CONST: 1, VOLATILE: 2, UNALIGNED: 4 });

/** Walks that could otherwise follow a damaged table for ever end here. */
const WALK_LIMIT = 4096;

/**
 * @typedef {Object} CxxEhHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number) => boolean} isMapped
 * @property {() => Record<string, number>} registers
 * @property {(options: { entry: number, args: number[], thread?: any,
 *              stackAtRest?: number, registers?: Record<string, number> })
 *              => Promise<number>} callGuest
 * @property {(registers: Record<string, number>, options?: { below?: number }) => any} continueAt
 * @property {() => any} currentThread
 * @property {(what: { code: number, flags?: number, address: number, parameters?: number[] })
 *              => Promise<{ handled: boolean, registers?: Record<string, number> }>} raise
 *           Raises on the running thread and settles only if the exception is
 *           continued; a catch continues elsewhere and nothing handling it
 *           ends the process.
 * @property {(targetFrame: number, address: number, options?: { record?: number,
 *              registers?: Record<string, number>, thread?: any }) => Promise<any>} unwind
 * @property {(message: string) => void} abort  How `terminate` ends the process.
 * @property {() => any} park  The answer of a call that does not return, for
 *           the ones that end the process from where they stand.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * One catch the thread is inside.
 *
 * @typedef {Object} Caught
 * @property {number} object      The thrown object.
 * @property {number} throwInfo
 * @property {number} frame       The frame whose block is running.
 * @property {number} tryLow      Which try block of that frame, by its range.
 * @property {number} catchHigh
 * @property {boolean} rethrown   Thrown on again by the block, so it is the
 *                                next catch's object to destroy, not this one's.
 * @property {number} savedEsp    The frame's saved stack before the block ran.
 */

/**
 * @param {CxxEhHost} host
 */
export function createCxxExceptions(host){
    const readU32 = (/** @type {number} */ at)=>{
        const bytes = host.readMemory(at >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    const readI32 = (/** @type {number} */ at)=>readU32(at) | 0;
    const writeU32 = (/** @type {number} */ at, /** @type {number} */ value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(at >>> 0, bytes);
    };

    /**
     * The catches each thread is inside, innermost last.
     *
     * @type {WeakMap<object, Caught[]>}
     */
    const caughtBy = new WeakMap();
    /** @param {any} thread */
    const caught = thread=>{
        let list = caughtBy.get(thread);
        if (!list)
        {
            list = [];
            caughtBy.set(thread, list);
        }
        return list;
    };

    /**
     * Exceptions thrown on each thread and not yet caught, for
     * `__uncaught_exception`.
     *
     * @type {WeakMap<object, number>}
     */
    const inFlight = new WeakMap();

    let terminateHandler = 0;
    let unexpectedHandler = 0;
    let translator = 0;

    /** @param {number} at */
    const funcInfo = at=>{
        const magic = readU32(at + FUNC_INFO.MAGIC) & 0x1fffffff;
        return {
            magic,
            maxState: readI32(at + FUNC_INFO.MAX_STATE),
            unwindMap: readU32(at + FUNC_INFO.UNWIND_MAP),
            tryBlocks: readU32(at + FUNC_INFO.TRY_BLOCKS),
            tryMap: readU32(at + FUNC_INFO.TRY_MAP),
            ehFlags: magic >= EH_MAGIC.V3 ? readU32(at + FUNC_INFO.EH_FLAGS) : 0,
        };
    };

    /** @param {number} magic */
    const knownMagic = magic=>magic >= EH_MAGIC.V1 && magic <= EH_MAGIC.V3;

    /** @param {number} descriptor */
    const typeName = descriptor=>(descriptor === 0
        ? ''
        : host.readCString(descriptor + TYPE_NAME, 256));

    /**
     * Where a base lives inside an object: the member displacement, then,
     * for a virtual base, the offset its vbtable holds.
     *
     * @param {number} object
     * @param {number} catchable
     */
    const adjust = (object, catchable)=>{
        const mdisp = readI32(catchable + CATCHABLE.MDISP);
        const pdisp = readI32(catchable + CATCHABLE.PDISP);
        const vdisp = readI32(catchable + CATCHABLE.VDISP);
        let at = (object + mdisp) >>> 0;
        if (pdisp >= 0)
        {
            const vbtable = readU32(object + pdisp);
            at = (at + readI32(vbtable + vdisp) + pdisp) >>> 0;
        }
        return at;
    };

    /**
     * Whether a handler takes a thrown type, by the compiler's own rule: the
     * same descriptor or the same decorated name, and the thrown object's
     * qualifiers all present on the handler.
     *
     * @param {number} handler
     * @param {number} catchable
     * @param {number} throwInfo
     */
    const matches = (handler, catchable, throwInfo)=>{
        const wanted = readU32(handler + HANDLER.TYPE);
        if (wanted === 0 || typeName(wanted) === '')
        {
            return true;
        }
        const offered = readU32(catchable + CATCHABLE.TYPE);
        if (wanted !== offered && typeName(wanted) !== typeName(offered))
        {
            return false;
        }
        const adjectives = readU32(handler + HANDLER.ADJECTIVES);
        const properties = readU32(catchable + CATCHABLE.PROPERTIES);
        const attributes = readU32(throwInfo + THROW_INFO.ATTRIBUTES);
        if ((properties & CT.BY_REFERENCE_ONLY) !== 0 && (adjectives & HT.REFERENCE) === 0)
        {
            return false;
        }
        for (const [thrown, taken] of [
            [TI.CONST, HT.CONST], [TI.VOLATILE, HT.VOLATILE], [TI.UNALIGNED, HT.UNALIGNED],
        ])
        {
            if ((attributes & thrown) !== 0 && (adjectives & taken) === 0)
            {
                return false;
            }
        }
        return true;
    };

    /** @param {number} handler */
    const isEllipsis = handler=>{
        const wanted = readU32(handler + HANDLER.TYPE);
        return wanted === 0 || typeName(wanted) === '';
    };

    /** @param {number} frame */
    const stateOf = frame=>readI32(frame + EH_FRAME.STATE);

    /**
     * Runs the destructors between the frame's state and `target`, each after
     * the state has been moved past it -- so a destructor that throws does not
     * find its own object still alive when the dispatcher comes back here.
     *
     * @param {number} frame
     * @param {ReturnType<typeof funcInfo>} info
     * @param {number} target
     * @param {{ thread: any, stackAtRest: number }} how
     */
    const unwindTo = async(frame, info, target, how)=>{
        let state = stateOf(frame);
        for (let guard = 0; state !== target && state >= 0 && state < info.maxState
            && guard < WALK_LIMIT; guard++)
        {
            const entry = info.unwindMap + state * UNWIND_ENTRY;
            const next = readI32(entry);
            const action = readU32(entry + 4);
            writeU32(frame + EH_FRAME.STATE, next);
            if (action !== 0 && host.isMapped(action))
            {
                await host.callGuest({
                    entry: action,
                    args: [],
                    thread: how.thread,
                    stackAtRest: how.stackAtRest,
                    registers: { ebp: frame + EH_FRAME.EBP },
                });
            }
            state = next;
        }
    };

    /**
     * Destroys a thrown object with the destructor its type named.
     *
     * @param {number} object
     * @param {number} throwInfo
     * @param {{ thread: any, stackAtRest?: number }} how
     */
    const destroy = async(object, throwInfo, how)=>{
        if (object === 0 || throwInfo === 0)
        {
            return;
        }
        const destructor = readU32(throwInfo + THROW_INFO.UNWIND);
        if (destructor !== 0 && host.isMapped(destructor))
        {
            await host.callGuest({
                entry: destructor, args: [], thread: how.thread,
                stackAtRest: how.stackAtRest, registers: { ecx: object },
            });
        }
    };

    /**
     * Builds the catch block's own object in its frame: a reference is a
     * pointer to the thrown object, a plain type is copied, and a class with
     * a copy constructor is constructed by it.
     *
     * @param {number} frame
     * @param {number} handler
     * @param {number} catchable
     * @param {number} object
     * @param {{ thread: any, stackAtRest: number }} how
     */
    const buildCatchObject = async(frame, handler, catchable, object, how)=>{
        const displacement = readI32(handler + HANDLER.CATCH_OBJECT);
        if (catchable === 0 || displacement === 0 || isEllipsis(handler))
        {
            return;
        }
        const into = (frame + EH_FRAME.EBP + displacement) >>> 0;
        const adjectives = readU32(handler + HANDLER.ADJECTIVES);
        const properties = readU32(catchable + CATCHABLE.PROPERTIES);
        const size = readU32(catchable + CATCHABLE.SIZE);
        const copy = readU32(catchable + CATCHABLE.COPY);
        if ((adjectives & HT.REFERENCE) !== 0)
        {
            writeU32(into, adjust(object, catchable));
            return;
        }
        if ((properties & CT.SIMPLE) !== 0)
        {
            host.writeMemory(into, host.readMemory(object, size).slice());
            // A pointer is caught as the base it is being caught as.
            if (size === 4 && readU32(into) !== 0)
            {
                writeU32(into, adjust(readU32(into), catchable));
            }
            return;
        }
        const source = adjust(object, catchable);
        if (copy === 0 || !host.isMapped(copy))
        {
            host.writeMemory(into, host.readMemory(source, size).slice());
            return;
        }
        await host.callGuest({
            entry: copy,
            args: (properties & CT.VIRTUAL_BASE) !== 0 ? [source, 1] : [source],
            thread: how.thread,
            stackAtRest: how.stackAtRest,
            registers: { ecx: into },
        });
    };

    /**
     * The catches of `frame` that an exception escaping into this try block
     * leaves behind: every one deeper on the stack, and those of this frame
     * whose try block this one encloses. Their thrown objects are destroyed
     * unless they are the one being caught now, or were thrown on.
     *
     * @param {any} thread
     * @param {number} frame
     * @param {number} tryLow
     * @param {number} catchHigh
     * @param {number} object
     * @param {{ thread: any, stackAtRest: number }} how
     */
    const abandon = async(thread, frame, tryLow, catchHigh, object, how)=>{
        const list = caught(thread);
        while (list.length > 0)
        {
            const last = list[list.length - 1];
            const inner = last.frame < frame
                || (last.frame === frame && tryLow <= last.tryLow && last.catchHigh <= catchHigh);
            if (!inner)
            {
                break;
            }
            list.pop();
            // The block's own stack is gone with it, and so is the value it
            // wrote into the frame's slot on entry: the frame goes back to the
            // stack it stood on before that block ran.
            if (last.frame === frame)
            {
                writeU32(frame + EH_FRAME.SAVED_ESP, last.savedEsp);
            }
            if (!last.rethrown && last.object !== object)
            {
                await destroy(last.object, last.throwInfo, how);
            }
        }
    };

    /**
     * The catch was found: everything that happens between finding it and
     * the thread going on after the block.
     *
     * @param {Object} found
     * @param {number} found.record
     * @param {number} found.frame
     * @param {ReturnType<typeof funcInfo>} found.info
     * @param {number} found.tryEntry
     * @param {number} found.handler
     * @param {number} found.catchable  Zero for a catch (...) of a foreign exception.
     * @param {number} found.object
     * @param {number} found.throwInfo
     * @param {Record<string, number>} found.entry  Registers when the handler was called.
     * @param {{ thread: any, stackAtRest: number }} found.how
     */
    const catchIt = async({ record, frame, info, tryEntry, handler, catchable, object, throwInfo,
        entry, how })=>{
        const { thread } = how;
        const tryLow = readI32(tryEntry + TRY_ENTRY.LOW);
        const tryHigh = readI32(tryEntry + TRY_ENTRY.HIGH);
        const catchHigh = readI32(tryEntry + TRY_ENTRY.CATCH_HIGH);

        await host.unwind(frame, readU32(handler + HANDLER.ADDRESS), {
            record, registers: { ...entry, esp: how.stackAtRest }, thread,
        });
        // The record is the exception's, and it is still being handled: a
        // catch block that rethrows raises it again, not an unwinding copy.
        writeU32(record + RECORD.FLAGS,
            readU32(record + RECORD.FLAGS) & ~(EH_UNWINDING | EXCEPTION_EXIT_UNWIND));

        await buildCatchObject(frame, handler, catchable, object, how);
        await unwindTo(frame, info, tryLow, how);
        writeU32(frame + EH_FRAME.STATE, tryHigh + 1);

        await abandon(thread, frame, tryLow, catchHigh, object, how);
        const list = caught(thread);
        // The stack the function goes on at once the block is done, and the
        // line under which everything the thread was doing is over: the
        // function body's own stack, or -- for a try inside a catch block of
        // this frame that is still running -- that block's, which it wrote
        // into the same slot when it began. A catch block writes its own
        // stack there too, for exactly that case, so the value is kept here
        // and put back before the function goes on.
        const saved = readU32(frame + EH_FRAME.SAVED_ESP);
        /** @type {Caught} */
        const mine = {
            object, throwInfo, frame, tryLow, catchHigh, rethrown: false, savedEsp: saved,
        };
        list.push(mine);
        inFlight.set(thread, Math.max(0, (inFlight.get(thread) ?? 1) - 1));

        const continuation = await host.callGuest({
            entry: readU32(handler + HANDLER.ADDRESS),
            args: [],
            thread,
            stackAtRest: how.stackAtRest,
            registers: { ebp: frame + EH_FRAME.EBP },
        }) >>> 0;

        // The block ended by returning, so it is still the innermost catch.
        const at = list.lastIndexOf(mine);
        if (at >= 0)
        {
            list.splice(at, 1);
        }
        if (!mine.rethrown)
        {
            await destroy(object, throwInfo, how);
        }
        writeU32(frame + EH_FRAME.SAVED_ESP, saved);
        return host.continueAt({
            eip: continuation, esp: saved, ebp: frame + EH_FRAME.EBP,
        }, { below: saved });
    };

    /**
     * The handler every C++ frame's stub jumps to, with the function's tables
     * in EAX.
     *
     * @param {number[]} args  record, frame, context, dispatcher
     */
    const frameHandler = async([record, frame, context])=>{
        const entry = host.registers();
        const thread = host.currentThread();
        const info = funcInfo(entry.ecx >>> 0);
        const how = { thread, stackAtRest: (entry.esp - 0x10 & ~0xf) >>> 0 };
        const at = frame >>> 0;
        const flags = readU32((record >>> 0) + RECORD.FLAGS);

        if (!knownMagic(info.magic))
        {
            host.divergence?.('__CxxFrameHandler',
                `the frame's tables carry magic 0x${info.magic.toString(16)}, which no `
                + 'compiler this runtime knows emits; the frame catches nothing');
            return Disposition.CONTINUE_SEARCH;
        }

        if ((flags & EH_UNWINDING) !== 0)
        {
            if (info.maxState > 0)
            {
                await unwindTo(at, info, EMPTY_STATE, how);
            }
            return Disposition.CONTINUE_SEARCH;
        }
        if (info.tryBlocks === 0)
        {
            return Disposition.CONTINUE_SEARCH;
        }

        const code = readU32((record >>> 0) + RECORD.CODE);
        const parameters = readU32((record >>> 0) + RECORD.PARAMETER_COUNT);
        const isCxx = code === EH_EXCEPTION_NUMBER && parameters >= 3
            && knownMagic(readU32((record >>> 0) + RECORD.INFORMATION));
        const state = stateOf(at);

        if (!isCxx && translator !== 0)
        {
            // The program's translator turns a structured exception into a C++
            // one by throwing it. If it returns instead, the exception goes on
            // as it was.
            const pointers = (how.stackAtRest - 8) >>> 0;
            writeU32(pointers, record >>> 0);
            writeU32(pointers + 4, context >>> 0);
            await host.callGuest({
                entry: translator, args: [code, pointers], thread,
                stackAtRest: pointers,
            });
        }

        const object = isCxx ? readU32((record >>> 0) + RECORD.INFORMATION + 4) : 0;
        const throwInfo = isCxx ? readU32((record >>> 0) + RECORD.INFORMATION + 8) : 0;
        const catchables = throwInfo === 0 ? 0 : readU32(throwInfo + THROW_INFO.CATCHABLE_TYPES);
        const catchableCount = catchables === 0 ? 0 : Math.min(readU32(catchables), WALK_LIMIT);

        for (let block = 0; block < Math.min(info.tryBlocks, WALK_LIMIT); block++)
        {
            const tryEntry = info.tryMap + block * TRY_ENTRY.SIZE;
            if (state < readI32(tryEntry + TRY_ENTRY.LOW)
                || state > readI32(tryEntry + TRY_ENTRY.HIGH))
            {
                continue;
            }
            const handlers = readU32(tryEntry + TRY_ENTRY.HANDLERS);
            const count = Math.min(readU32(tryEntry + TRY_ENTRY.CATCHES), WALK_LIMIT);
            for (let index = 0; index < count; index++)
            {
                const handler = handlers + index * HANDLER.SIZE;
                if (!isCxx)
                {
                    // A foreign exception is caught only by a catch (...), and
                    // not at all by code built to leave them alone.
                    if (isEllipsis(handler) && (info.ehFlags & FI_EHS) === 0)
                    {
                        return catchIt({ record: record >>> 0, frame: at, info, tryEntry, handler,
                            catchable: 0, object: 0, throwInfo: 0, entry, how });
                    }
                    continue;
                }
                for (let type = 0; type < catchableCount; type++)
                {
                    const catchable = readU32(catchables + 4 + type * 4);
                    if (matches(handler, catchable, throwInfo))
                    {
                        return catchIt({ record: record >>> 0, frame: at, info, tryEntry, handler,
                            catchable, object, throwInfo, entry, how });
                    }
                }
            }
        }
        return Disposition.CONTINUE_SEARCH;
    };

    /**
     * Ends the process the way `terminate` does: the program's own handler
     * first, then abort.
     *
     * @param {string} why
     */
    const terminate = async why=>{
        const thread = host.currentThread();
        if (terminateHandler !== 0)
        {
            await host.callGuest({ entry: terminateHandler, args: [], thread });
        }
        host.abort(why);
        return new Promise(()=>{});
    };

    // The stub reaches here by a jump with the tables in EAX, and the trap
    // needs EAX for itself: `preserveResult` has the stub move it to ECX first.
    const frameHandlerEntry = {
        convention: 'cdecl', argBytes: 16, preserveResult: true, handler: frameHandler,
    };

    /**
     * void __CxxLongjmpUnwind(jmp_buf *env)
     *
     * The routine `_setjmp3` names for a C++ frame: a longjmp back
     * into it destroys the objects the frame made since the mark, down
     * to the state the mark was set in. The buffer carries the frame's
     * tables as its first word of unwind data.
     *
     * Exported under both spellings: msvcrt.spec names it undecorated, which is
     * what a library linked by the Microsoft toolchain imports, and another
     * toolchain's import library asks for the stdcall-decorated name.
     */
    const cxxLongjmpUnwind = {
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([buffer])=>{
            const at = buffer >>> 0;
            const entry = host.registers();
            const frame = readU32(at + 24);
            const info = funcInfo(readU32(at + 40));
            return unwindTo(frame, info, readI32(at + 28), {
                thread: host.currentThread(),
                stackAtRest: (entry.esp - 0x10 & ~0xf) >>> 0,
            }).then(()=>0);
        },
    };

    return {
        frameHandler,

        table: {
            /**
             * EXCEPTION_DISPOSITION __CxxFrameHandler(record, frame, context,
             *   dispatcher)
             *
             * Reached from the compiler's stub for the frame, with the
             * function's tables in EAX. The three spellings are three
             * compiler generations reading the same tables; the later ones
             * add fields the magic number announces.
             */
            __CxxFrameHandler: frameHandlerEntry,
            __CxxFrameHandler2: frameHandlerEntry,
            __CxxFrameHandler3: frameHandlerEntry,

            /**
             * void _CxxThrowException(void *pExceptionObject, _ThrowInfo *pThrowInfo)
             *
             * A `throw`. With neither argument it is `throw;`, which throws
             * the object of the innermost catch the thread is inside -- and
             * with no catch to be inside, there is nothing to rethrow and the
             * program terminates.
             */
            _CxxThrowException: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([object, throwInfo])=>{
                    const thread = host.currentThread();
                    let thrown = object >>> 0;
                    let info = throwInfo >>> 0;
                    if (info === 0)
                    {
                        const list = caught(thread);
                        const current = list[list.length - 1];
                        if (!current)
                        {
                            return terminate('throw; with no exception being handled');
                        }
                        current.rethrown = true;
                        thrown = current.object;
                        info = current.throwInfo;
                    }
                    inFlight.set(thread, (inFlight.get(thread) ?? 0) + 1);
                    return host.raise({
                        code: EH_EXCEPTION_NUMBER,
                        flags: EXCEPTION_NONCONTINUABLE,
                        address: host.registers().eip,
                        parameters: [EH_MAGIC.V1, thrown, info],
                    }).then(()=>0);
                },
            },

            '__CxxLongjmpUnwind@4': cxxLongjmpUnwind,
            __CxxLongjmpUnwind: cxxLongjmpUnwind,

            /** bool __uncaught_exception(void) -- a C name in msvcrt.dll. */
            __uncaught_exception: {
                convention: 'cdecl',
                argBytes: 0,
                handler: ()=>((inFlight.get(host.currentThread()) ?? 0) > 0 ? 1 : 0),
            },

            /** terminate_function set_terminate(terminate_function) */
            '?set_terminate@@YAP6AXXZP6AXXZ@Z': {
                convention: 'cdecl',
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([handler])=>{
                    const previous = terminateHandler;
                    terminateHandler = handler >>> 0;
                    return previous;
                },
            },

            /** unexpected_function set_unexpected(unexpected_function) */
            '?set_unexpected@@YAP6AXXZP6AXXZ@Z': {
                convention: 'cdecl',
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([handler])=>{
                    const previous = unexpectedHandler;
                    unexpectedHandler = handler >>> 0;
                    return previous;
                },
            },

            /**
             * _se_translator_function _set_se_translator(_se_translator_function)
             *
             * msvcrt.dll exports this one under its C++ name only; the C name
             * is a later runtime's, and an import by it never binds here.
             */
            '?_set_se_translator@@YAP6AXIPAU_EXCEPTION_POINTERS@@@ZP6AXI0@Z@Z': {
                convention: 'cdecl',
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([handler])=>{
                    const previous = translator;
                    translator = handler >>> 0;
                    return previous;
                },
            },

            /**
             * void abort(void)
             *
             * The process ends with exit code 3, the runtime's own, and the
             * call never returns.
             */
            abort: {
                convention: 'cdecl',
                argBytes: 0,
                handler: ()=>{
                    host.abort('abort');
                    return host.park();
                },
            },

            /**
             * void _assert(const char *message, const char *file, unsigned line)
             *
             * A failed assert() in a release-linked program: the runtime's
             * message, then the process ends as abort ends it.
             */
            _assert: {
                convention: 'cdecl',
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([message, file, line])=>{
                    host.abort(`Assertion failed: ${host.readCString(message >>> 0, 1024)}, file ${
                        host.readCString(file >>> 0, 260)}, line ${line >>> 0}`);
                    return host.park();
                },
            },

            /** void terminate(void) */
            '?terminate@@YAXXZ': {
                convention: 'cdecl',
                argBytes: 0,
                handler: ()=>terminate('terminate'),
            },
        },
    };
}
