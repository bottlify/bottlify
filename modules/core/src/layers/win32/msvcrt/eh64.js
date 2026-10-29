/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * C++ exceptions in a 64-bit process.
 *
 * A `throw` is still a call to `_CxxThrowException` raising 0xE06D7363, now
 * with a fourth parameter: the base of the image whose tables describe the
 * thrown type, since every reference in those tables is an offset from it.
 * What differs is how a frame is found and handled. A function with a `try`
 * or an object to destroy registers nothing; its unwind data names the
 * runtime's frame handler, and the handler data starts with the offset of the
 * function's tables. The dispatcher (`kernel32/seh64.js`) walks the frames
 * and offers each one here.
 *
 * Which objects are alive and which try block is entered -- the state -- is
 * no longer kept in the frame: it is read from the function's IP-to-state
 * map at the frame's control address. A catch block, and every destructor
 * the tables name, is a funclet of its own: a separate function, with its own
 * unwind data, called with the parent's establisher frame in RDX, through
 * which it reaches the parent's locals. A catch funclet answers in RAX the
 * address the parent goes on at.
 *
 * Two layouts of the same facts are read: `__CxxFrameHandler3`'s FuncInfo,
 * fixed-size records with image-relative offsets, and `__CxxFrameHandler4`'s,
 * compressed -- a header byte saying which fields follow, unsigned numbers in
 * one to five bytes whose low bits give their length, an unwind map whose
 * entries name their next state by a backward byte distance, and an
 * IP-to-state map per function or funclet, deltas from its start with each
 * state biased by one.
 *
 * What a frame answers:
 *
 * - Being unwound, it runs the destructors of every object alive at its state
 *   back to the empty one -- or, as the target of the unwind, back to the try
 *   block being entered.
 * - Otherwise it looks among the try blocks around its state for a catch
 *   whose type the thrown object can be caught as. On a match the frames
 *   below are unwound with their destructors, the try block's own objects
 *   destroyed, the catch object built in the frame, and the catch funclet
 *   called -- on the stack below the throw, where the thrown object still
 *   lives -- then the function goes on at the address it answered, with the
 *   registers it had when the exception left it. The thrown object is
 *   destroyed when the catch ends, unless an enclosing catch still holds it.
 *
 * A catch funclet's own frame names the same tables. Its state lies in the
 * catch region of the try block it belongs to; the parent's frame is read
 * from the funclet's own, and only try blocks inside that region are its to
 * search. An exception leaving it reaches the parent function next, at the
 * funclet's state: the parent's own try block does not catch it again, and
 * its objects inside the try block, already destroyed, are not destroyed
 * twice.
 */

import { EXCEPTION_NONCONTINUABLE } from '../kernel32/seh.js';
import { Disposition } from '../kernel32/seh64.js';

/** The exception code every C++ throw raises: 0xE0 followed by "msc". */
export const EH_EXCEPTION_NUMBER = 0xe06d7363;

/** What the first parameter of such an exception says, one per compiler generation. */
export const EH_MAGIC = Object.freeze({ V1: 0x19930520, V2: 0x19930521, V3: 0x19930522 });

/** FuncInfo at 64 bits, `__CxxFrameHandler3`'s. */
const FUNC_INFO = Object.freeze({
    MAGIC: 0, MAX_STATE: 4, UNWIND_MAP: 8, TRY_BLOCKS: 12, TRY_MAP: 16, IP_ENTRIES: 20,
    IP_MAP: 24, UNWIND_HELP: 28, ES_TYPE_LIST: 32, EH_FLAGS: 36,
});

/** EHFlags: built with /EHs, so a catch (...) does not take a structured exception. */
const FI_EHS = 1;

/** The 64-bit records' sizes and fields. */
const UNWIND_ENTRY = 8;
const TRY_ENTRY = Object.freeze({
    LOW: 0, HIGH: 4, CATCH_HIGH: 8, CATCHES: 12, HANDLERS: 16, SIZE: 20,
});
const HANDLER = Object.freeze({
    ADJECTIVES: 0, TYPE: 4, CATCH_OBJECT: 8, ADDRESS: 12, FRAME: 16, SIZE: 20,
});
const IP_ENTRY = 8;
const THROW_INFO = Object.freeze({ ATTRIBUTES: 0, UNWIND: 4, CATCHABLE_TYPES: 12 });
const CATCHABLE = Object.freeze({
    PROPERTIES: 0, TYPE: 4, MDISP: 8, PDISP: 12, VDISP: 16, SIZE: 20, COPY: 24,
});

/** A type descriptor's decorated name, after its vtable pointer and a spare quadword. */
const TYPE_NAME = 16;

/** HandlerType adjectives. */
const HT = Object.freeze({ CONST: 1, VOLATILE: 2, UNALIGNED: 4, REFERENCE: 8 });

/** CatchableType properties. */
const CT = Object.freeze({ SIMPLE: 1, BY_REFERENCE_ONLY: 2, VIRTUAL_BASE: 4 });

/** ThrowInfo attributes. */
const TI = Object.freeze({ CONST: 1, VOLATILE: 2, UNALIGNED: 4 });

/** FuncInfo4 header bits. */
const FH4 = Object.freeze({
    IS_CATCH: 0x01, IS_SEPARATED: 0x02, BBT: 0x04, UNWIND_MAP: 0x08, TRY_BLOCK_MAP: 0x10,
    EHS: 0x20, NO_EXCEPT: 0x40,
});

/** HandlerType4 header bits; the continuation count is bits 4 and 5. */
const HANDLER4 = Object.freeze({
    ADJECTIVES: 0x01, TYPE: 0x02, CATCH_OBJECT: 0x04, CONTINUATION_RVA: 0x08,
});

/** What an unwind map entry of the compressed form runs. */
export const UNWIND_KIND = Object.freeze({
    NONE: 0, OBJECT: 1, POINTER_TO_OBJECT: 2, FUNCLET: 3,
});

/** Walks that could otherwise follow damaged tables for ever end here. */
const WALK_LIMIT = 4096;

/**
 * @typedef {Object} CxxHandler
 * @property {number} adjectives
 * @property {number} type          The type descriptor, absolute; zero for `...`.
 * @property {number} catchObject   Its offset from the parent's frame; zero for none.
 * @property {number} handler       The catch funclet, absolute.
 * @property {number} frame         Where the funclet keeps the parent's frame, from its own.
 * @property {number[]} continuations  Where the parent goes on, when the tables say.
 */

/**
 * @typedef {Object} CxxTryBlock
 * @property {number} low
 * @property {number} high
 * @property {number} catchHigh
 * @property {CxxHandler[]} handlers
 */

/**
 * A function's tables, read into one shape from either layout.
 *
 * @typedef {Object} CxxFunction
 * @property {3 | 4} format
 * @property {{ to: number, action: number, kind: number, object: number }[]} unwind
 * @property {CxxTryBlock[]} tries
 * @property {(pc: number) => number} stateAt
 * @property {boolean} ehs
 * @property {boolean} isCatch      Said by the FH4 header; FH3 tells by the state.
 * @property {number} catchFrame    FH4: where a catch funclet keeps the parent's frame.
 */

/**
 * A byte reader over guest memory: unsigned and signed words, and the
 * compressed numbers of the FH4 tables.
 *
 * @param {(address: number, length: number) => Uint8Array} readMemory
 */
export function createTableReader(readMemory){
    /** @param {number} at */
    const u32 = at=>{
        const bytes = readMemory(at >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    return {
        u32,
        /** @param {number} at */
        i32: at=>u32(at) | 0,
        /** @param {number} at */
        u8: at=>readMemory(at >>> 0, 1)[0],
        /**
         * A compressed unsigned number at `at`: its value and its length.
         *
         * @param {number} at
         */
        compressed(at){
            const bytes = readMemory(at >>> 0, 5);
            const first = bytes[0];
            if ((first & 1) === 0)
            {
                return { value: first >>> 1, length: 1 };
            }
            if ((first & 3) === 1)
            {
                return { value: (first | bytes[1] << 8) >>> 2, length: 2 };
            }
            if ((first & 7) === 3)
            {
                return { value: (first | bytes[1] << 8 | bytes[2] << 16) >>> 3, length: 3 };
            }
            if ((first & 15) === 7)
            {
                return { value: (first | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 4,
                    length: 4 };
            }
            return { value: (bytes[1] | bytes[2] << 8 | bytes[3] << 16 | bytes[4] << 24) >>> 0,
                length: 5 };
        },
    };
}

/**
 * Reads `__CxxFrameHandler3`'s tables at `info`, image-relative to `imageBase`.
 *
 * @param {ReturnType<typeof createTableReader>} read
 * @param {number} imageBase @param {number} info
 * @returns {CxxFunction | null}  null for a magic no compiler emits
 */
export function readFuncInfo3(read, imageBase, info){
    const magic = read.u32(info + FUNC_INFO.MAGIC) & 0x1fffffff;
    if (magic < EH_MAGIC.V1 || magic > EH_MAGIC.V3)
    {
        return null;
    }
    /** @param {number} rva */
    const at = rva=>imageBase + rva >>> 0;
    const maxState = Math.min(Math.max(read.i32(info + FUNC_INFO.MAX_STATE), 0), WALK_LIMIT);
    const unwindMap = read.u32(info + FUNC_INFO.UNWIND_MAP);
    const unwind = Array.from({ length: maxState }, (_unused, state)=>{
        const entry = at(unwindMap) + state * UNWIND_ENTRY;
        const action = read.u32(entry + 4);
        return { to: read.i32(entry), action: action === 0 ? 0 : at(action),
            kind: action === 0 ? UNWIND_KIND.NONE : UNWIND_KIND.FUNCLET, object: 0 };
    });
    const tryCount = Math.min(read.u32(info + FUNC_INFO.TRY_BLOCKS), WALK_LIMIT);
    const tryMap = at(read.u32(info + FUNC_INFO.TRY_MAP));
    const tries = Array.from({ length: tryCount }, (_, index)=>{
        const entry = tryMap + index * TRY_ENTRY.SIZE;
        const handlers = at(read.u32(entry + TRY_ENTRY.HANDLERS));
        const count = Math.min(read.u32(entry + TRY_ENTRY.CATCHES), WALK_LIMIT);
        return {
            low: read.i32(entry + TRY_ENTRY.LOW),
            high: read.i32(entry + TRY_ENTRY.HIGH),
            catchHigh: read.i32(entry + TRY_ENTRY.CATCH_HIGH),
            handlers: Array.from({ length: count }, (_none, which)=>{
                const handler = handlers + which * HANDLER.SIZE;
                const type = read.u32(handler + HANDLER.TYPE);
                return {
                    adjectives: read.u32(handler + HANDLER.ADJECTIVES),
                    type: type === 0 ? 0 : at(type),
                    catchObject: read.i32(handler + HANDLER.CATCH_OBJECT),
                    handler: at(read.u32(handler + HANDLER.ADDRESS)),
                    frame: read.i32(handler + HANDLER.FRAME),
                    continuations: [],
                };
            }),
        };
    });
    const ipCount = Math.min(read.u32(info + FUNC_INFO.IP_ENTRIES), 1 << 20);
    const ipMap = at(read.u32(info + FUNC_INFO.IP_MAP));
    return {
        format: 3,
        unwind,
        tries,
        // The last entry at or before the address: the map is sorted, and a
        // call's return address is placed after it by the compiler, inside
        // the call's state.
        stateAt(pc){
            const rva = pc - imageBase >>> 0;
            let low = 0;
            let high = ipCount - 1;
            let state = -1;
            while (low <= high)
            {
                const middle = low + high >>> 1;
                const entry = ipMap + middle * IP_ENTRY;
                if (read.u32(entry) <= rva)
                {
                    state = read.i32(entry + 4);
                    low = middle + 1;
                }
                else
                {
                    high = middle - 1;
                }
            }
            return state;
        },
        ehs: magic >= EH_MAGIC.V3 && (read.u32(info + FUNC_INFO.EH_FLAGS) & FI_EHS) !== 0,
        isCatch: false,
        catchFrame: 0,
    };
}

/**
 * Reads `__CxxFrameHandler4`'s compressed tables at `info`, for the function
 * or funclet starting at `begin`.
 *
 * @param {ReturnType<typeof createTableReader>} read
 * @param {number} imageBase @param {number} info @param {number} begin
 * @returns {CxxFunction}
 */
export function readFuncInfo4(read, imageBase, info, begin){
    let cursor = info >>> 0;
    const unsigned = ()=>{
        const { value, length } = read.compressed(cursor);
        cursor += length;
        return value;
    };
    const int = ()=>{
        const value = read.i32(cursor);
        cursor += 4;
        return value;
    };
    const header = read.u8(cursor++);
    if ((header & FH4.BBT) !== 0)
    {
        unsigned();
    }
    const unwindRva = (header & FH4.UNWIND_MAP) !== 0 ? int() : 0;
    const tryRva = (header & FH4.TRY_BLOCK_MAP) !== 0 ? int() : 0;
    const ipRva = int();
    const catchFrame = (header & FH4.IS_CATCH) !== 0 ? unsigned() : 0;

    /** @type {CxxFunction['unwind']} */
    const unwind = [];
    if (unwindRva !== 0)
    {
        cursor = imageBase + unwindRva >>> 0;
        const count = Math.min(unsigned(), WALK_LIMIT);
        const start = cursor;
        /** @type {Map<number, number>} the state each entry's offset is */
        const states = new Map();
        /** @type {number[]} */
        const backs = [];
        for (let state = 0; state < count; state++)
        {
            const offset = cursor - start;
            states.set(offset, state);
            const head = unsigned();
            const kind = head & 3;
            const back = head >>> 2;
            let action = 0;
            let object = 0;
            if (kind !== UNWIND_KIND.NONE)
            {
                action = imageBase + int() >>> 0;
            }
            if (kind === UNWIND_KIND.OBJECT || kind === UNWIND_KIND.POINTER_TO_OBJECT)
            {
                object = unsigned();
            }
            backs.push(back === 0 ? -1 : offset - back);
            unwind.push({ to: -1, action, kind, object });
        }
        // An entry names its next state by the distance back to it; past the
        // start of the map is the empty state.
        unwind.forEach((entry, state)=>{
            const target = backs[state];
            entry.to = target < 0 ? -1 : states.get(target) ?? -1;
        });
    }

    /** @type {CxxTryBlock[]} */
    const tries = [];
    if (tryRva !== 0)
    {
        cursor = imageBase + tryRva >>> 0;
        const count = Math.min(unsigned(), WALK_LIMIT);
        /** @type {number[]} */
        const lists = [];
        for (let index = 0; index < count; index++)
        {
            tries.push({ low: unsigned(), high: unsigned(), catchHigh: unsigned(), handlers: [] });
            lists.push(int());
        }
        tries.forEach((block, index)=>{
            if (lists[index] === 0)
            {
                return;
            }
            cursor = imageBase + lists[index] >>> 0;
            const handlers = Math.min(unsigned(), WALK_LIMIT);
            for (let which = 0; which < handlers; which++)
            {
                const flags = read.u8(cursor++);
                const adjectives = (flags & HANDLER4.ADJECTIVES) !== 0 ? unsigned() : 0;
                const type = (flags & HANDLER4.TYPE) !== 0 ? int() : 0;
                const catchObject = (flags & HANDLER4.CATCH_OBJECT) !== 0 ? unsigned() : 0;
                const handler = imageBase + int() >>> 0;
                const continuationCount = flags >>> 4 & 3;
                /** @type {number[]} */
                const continuations = [];
                for (let next = 0; next < Math.min(continuationCount, 2); next++)
                {
                    continuations.push((flags & HANDLER4.CONTINUATION_RVA) !== 0
                        ? imageBase + int() >>> 0
                        : begin + unsigned() >>> 0);
                }
                block.handlers.push({
                    adjectives, type: type === 0 ? 0 : imageBase + type >>> 0, catchObject,
                    handler, frame: 0, continuations,
                });
            }
        });
    }

    // The IP-to-state map of this function or funclet: separated code keeps
    // one per segment, found by the segment's start.
    let ipMap = imageBase + ipRva >>> 0;
    if ((header & FH4.IS_SEPARATED) !== 0)
    {
        cursor = ipMap;
        const segments = Math.min(unsigned(), WALK_LIMIT);
        ipMap = 0;
        for (let index = 0; index < segments; index++)
        {
            const segment = int();
            const map = int();
            if ((imageBase + segment >>> 0) === (begin >>> 0))
            {
                ipMap = imageBase + map >>> 0;
            }
        }
    }
    /** @type {{ ip: number, state: number }[]} */
    const ips = [];
    if (ipRva !== 0 && ipMap !== 0)
    {
        cursor = ipMap;
        const count = Math.min(unsigned(), 1 << 20);
        let ip = begin >>> 0;
        for (let index = 0; index < count; index++)
        {
            ip = ip + unsigned() >>> 0;
            ips.push({ ip, state: unsigned() - 1 });
        }
    }
    return {
        format: 4,
        unwind,
        tries,
        stateAt(pc){
            let state = -1;
            for (const entry of ips)
            {
                if ((pc >>> 0) < entry.ip)
                {
                    break;
                }
                state = entry.state;
            }
            return state;
        },
        ehs: (header & FH4.EHS) !== 0,
        isCatch: (header & FH4.IS_CATCH) !== 0,
        catchFrame,
    };
}

/**
 * @typedef {Object} CxxEh64Host
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number) => boolean} isMapped
 * @property {(address: number) => number} imageBaseOf  The base of the image an
 *     address lies in; zero outside every image.
 * @property {(what: { code: number, flags: number, parameters: number[] }) => Promise<any>} raise
 *     Raises from the host call being answered (`seh64.raise`).
 * @property {(address: number) => { visit: import('../kernel32/seh64.js').FrameVisit,
 *     pass: import('../kernel32/seh64.js').Pass,
 *     unwinding: { at: boolean, ip: number, state?: number } | null } | null}
 *     dispatcherContextAt  The walk a dispatcher context belongs to.
 * @property {() => any} currentThread
 * @property {(entry: number, args: number[], thread: any) => Promise<number>} callGuest
 *     Calls a routine from a host call outside any exception -- the program's
 *     terminate handler.
 * @property {(message: string) => void} abort  How `terminate` ends the process.
 * @property {() => any} park
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * One catch the thread is inside.
 *
 * @typedef {Object} Caught
 * @property {number} object
 * @property {number} throwInfo
 * @property {number} throwBase
 */

/**
 * @param {CxxEh64Host} host
 */
export function createCxxExceptions64(host){
    const read = createTableReader(host.readMemory);
    /** @param {number} at */
    const readPointer = at=>read.u32(at);
    /** @param {number} at @param {number} value */
    const writePointer = (at, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, BigInt(value >>> 0), true);
        host.writeMemory(at >>> 0, bytes);
    };

    /** @type {WeakMap<object, Caught[]>} */
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
    /** Exceptions thrown on each thread and not yet caught. @type {WeakMap<object, number>} */
    const inFlight = new WeakMap();

    let terminateHandler = 0;
    let unexpectedHandler = 0;
    let translator = 0;

    /** @param {number} descriptor */
    const typeName = descriptor=>(descriptor === 0
        ? '' : host.readCString(descriptor + TYPE_NAME >>> 0, 256));

    /**
     * Where a base lives inside an object: the member displacement, then, for
     * a virtual base, the offset its vbtable holds.
     *
     * @param {number} object @param {number} catchable
     */
    const adjust = (object, catchable)=>{
        const mdisp = read.i32(catchable + CATCHABLE.MDISP);
        const pdisp = read.i32(catchable + CATCHABLE.PDISP);
        const vdisp = read.i32(catchable + CATCHABLE.VDISP);
        let at = object + mdisp >>> 0;
        if (pdisp >= 0)
        {
            const vbtable = readPointer(object + pdisp);
            at = at + read.i32(vbtable + vdisp) + pdisp >>> 0;
        }
        return at;
    };

    /** @param {CxxHandler} handler */
    const isEllipsis = handler=>handler.type === 0 || typeName(handler.type) === '';

    /**
     * Whether a handler takes a thrown type, by the compiler's rule: the same
     * descriptor or the same decorated name, and the thrown object's
     * qualifiers all present on the handler.
     *
     * @param {CxxHandler} handler @param {number} catchable @param {number} throwInfo
     * @param {number} throwBase
     */
    const matches = (handler, catchable, throwInfo, throwBase)=>{
        if (isEllipsis(handler))
        {
            return true;
        }
        const offered = throwBase + read.u32(catchable + CATCHABLE.TYPE) >>> 0;
        if (handler.type !== offered && typeName(handler.type) !== typeName(offered))
        {
            return false;
        }
        const properties = read.u32(catchable + CATCHABLE.PROPERTIES);
        const attributes = read.u32(throwInfo + THROW_INFO.ATTRIBUTES);
        if ((properties & CT.BY_REFERENCE_ONLY) !== 0 && (handler.adjectives & HT.REFERENCE) === 0)
        {
            return false;
        }
        for (const [thrown, taken] of [
            [TI.CONST, HT.CONST], [TI.VOLATILE, HT.VOLATILE], [TI.UNALIGNED, HT.UNALIGNED],
        ])
        {
            if ((attributes & thrown) !== 0 && (handler.adjectives & taken) === 0)
            {
                return false;
            }
        }
        return true;
    };

    /**
     * The tables a frame's handler data names: its first word, the offset of
     * the function's tables.
     *
     * @param {import('../kernel32/seh64.js').FrameVisit} visit @param {3 | 4} format
     * @returns {CxxFunction | null}
     */
    const tablesOf = (visit, format)=>{
        const info = visit.fn.imageBase + read.u32(visit.handlerData) >>> 0;
        return format === 3
            ? readFuncInfo3(read, visit.fn.imageBase, info)
            : readFuncInfo4(read, visit.fn.imageBase, info, visit.fn.begin);
    };

    /**
     * Where a frame stands: the parent's frame its funclets address, its
     * state, and -- for a catch funclet -- the try block it belongs to, whose
     * catch region alone it searches. A catch funclet leaves its state for
     * the parent, which the walk reaches next; the parent takes it.
     *
     * @param {import('../kernel32/seh64.js').FrameVisit} visit @param {CxxFunction} fn
     */
    const locate = (visit, fn)=>{
        const state = fn.stateAt(visit.context.rip);
        /** @type {CxxTryBlock | null} */
        let inCatch = null;
        let parent = -1;
        for (let index = fn.tries.length - 1; index >= 0 && parent < 0; index--)
        {
            const block = fn.tries[index];
            if (fn.format === 3 && (state <= block.high || state > block.catchHigh))
            {
                continue;
            }
            const handler = block.handlers.find(entry=>entry.handler === visit.fn.begin >>> 0);
            if (handler)
            {
                inCatch = block;
                parent = readPointer(visit.establisher
                    + (fn.format === 3 ? handler.frame : fn.catchFrame));
            }
        }
        if (parent < 0 && fn.isCatch)
        {
            parent = readPointer(visit.establisher + fn.catchFrame);
        }
        if (parent >= 0)
        {
            visit.memo.set(`cxx:${parent >>> 0}`, state);
            return { frame: parent >>> 0, state, inCatch, funclet: true };
        }
        const key = `cxx:${visit.establisher >>> 0}`;
        const left = visit.memo.get(key);
        if (left !== undefined)
        {
            visit.memo.delete(key);
            return { frame: visit.establisher >>> 0, state: left, inCatch, funclet: false };
        }
        return { frame: visit.establisher >>> 0, state, inCatch, funclet: false };
    };

    /**
     * Runs the destructors from `from` back to `to`, each entry's after the
     * state has moved past it.
     *
     * @param {CxxFunction} fn @param {number} frame @param {number} from @param {number} to
     * @param {import('../kernel32/seh64.js').Pass} pass
     */
    const unwindState = async(fn, frame, from, to, pass)=>{
        let state = from;
        for (let guard = 0; state > to && state >= 0 && state < fn.unwind.length
            && guard < WALK_LIMIT; guard++)
        {
            const entry = fn.unwind[state];
            state = entry.to;
            if (entry.action === 0 || !host.isMapped(entry.action))
            {
                continue;
            }
            // A destructor of an object is called with it; a funclet with
            // nothing in RCX. Either finds the frame in RDX.
            let object = 0;
            if (entry.kind === UNWIND_KIND.OBJECT)
            {
                object = frame + entry.object >>> 0;
            }
            else if (entry.kind === UNWIND_KIND.POINTER_TO_OBJECT)
            {
                object = readPointer(frame + entry.object);
            }
            await pass.call(entry.action, { rcx: object, rdx: frame });
        }
    };

    /**
     * The C++ exception a record carries, or null for a foreign one.
     *
     * @param {import('../kernel32/seh64.js').ExceptionRecord} record
     */
    const thrownBy = record=>{
        const parameters = record.parameters ?? [];
        if (record.code >>> 0 !== EH_EXCEPTION_NUMBER || parameters.length < 3
            || parameters[0] < EH_MAGIC.V1 || parameters[0] > EH_MAGIC.V3)
        {
            return null;
        }
        const throwInfo = parameters[2] >>> 0;
        return {
            object: parameters[1] >>> 0,
            throwInfo,
            throwBase: parameters.length >= 4 ? parameters[3] >>> 0 : host.imageBaseOf(throwInfo),
        };
    };

    /**
     * Destroys a thrown object with the destructor its type named.
     *
     * @param {Caught} what @param {import('../kernel32/seh64.js').Pass} pass
     */
    const destroy = async(what, pass)=>{
        if (what.object === 0 || what.throwInfo === 0)
        {
            return;
        }
        const rva = read.u32(what.throwInfo + THROW_INFO.UNWIND);
        const destructor = what.throwBase + rva >>> 0;
        if (rva !== 0 && host.isMapped(destructor))
        {
            await pass.call(destructor, { rcx: what.object });
        }
    };

    /**
     * Builds the catch block's own object in the parent's frame: a reference
     * is a pointer to the thrown object, a plain type is copied, and a class
     * with a copy constructor is constructed by it.
     *
     * @param {number} frame @param {CxxHandler} handler @param {number} catchable
     * @param {Caught} thrown @param {import('../kernel32/seh64.js').Pass} pass
     */
    const buildCatchObject = async(frame, handler, catchable, thrown, pass)=>{
        if (catchable === 0 || handler.catchObject === 0 || isEllipsis(handler))
        {
            return;
        }
        const into = frame + handler.catchObject >>> 0;
        const properties = read.u32(catchable + CATCHABLE.PROPERTIES);
        const size = read.u32(catchable + CATCHABLE.SIZE);
        const copyRva = read.u32(catchable + CATCHABLE.COPY);
        const copy = thrown.throwBase + copyRva >>> 0;
        if ((handler.adjectives & HT.REFERENCE) !== 0)
        {
            writePointer(into, adjust(thrown.object, catchable));
            return;
        }
        if ((properties & CT.SIMPLE) !== 0)
        {
            host.writeMemory(into, host.readMemory(thrown.object, size).slice());
            // A pointer is caught as the base it is being caught as.
            if (size === 8 && readPointer(into) !== 0)
            {
                writePointer(into, adjust(readPointer(into), catchable));
            }
            return;
        }
        const source = adjust(thrown.object, catchable);
        if (copyRva === 0 || !host.isMapped(copy))
        {
            host.writeMemory(into, host.readMemory(source, size).slice());
            return;
        }
        await pass.call(copy, { rcx: into, rdx: source,
            ...(properties & CT.VIRTUAL_BASE) !== 0 ? { r8: 1 } : {} });
    };

    /**
     * The catch was found: everything from the unwind to the thread going on
     * after the block.
     *
     * @param {Object} found
     * @param {import('../kernel32/seh64.js').FrameVisit} found.visit
     * @param {import('../kernel32/seh64.js').Pass} found.pass
     * @param {number} found.frame
     * @param {CxxTryBlock} found.block
     * @param {CxxHandler} found.handler
     * @param {number} found.catchable  Zero for a catch (...) of a foreign exception.
     * @param {Caught} found.thrown
     */
    const catchIt = async({ visit, pass, frame, block, handler, catchable, thrown })=>{
        const { thread } = pass;
        inFlight.set(thread, Math.max(0, (inFlight.get(thread) ?? 1) - 1));
        // Every frame below, and this one's objects inside the try block.
        await pass.unwindTo({ frame: visit.establisher, ip: visit.context.rip, state: block.low });
        await buildCatchObject(frame, handler, catchable, thrown, pass);

        const list = caught(thread);
        /** @type {Caught} */
        const mine = { ...thrown };
        list.push(mine);
        /** Destroys the object unless another catch still holds it. */
        const release = async(/** @type {import('../kernel32/seh64.js').Pass} */ by)=>{
            const at = list.indexOf(mine);
            if (at >= 0)
            {
                list.splice(at, 1);
            }
            if (!list.some(other=>other.object === mine.object))
            {
                await destroy(mine, by);
            }
        };
        const answer = await pass.callNested(handler.handler, { rcx: 0, rdx: frame },
            visit.context, async by=>{
                // Left by an exception: the object goes on with it when it is
                // the one thrown again.
                if (thrownBy(by.record)?.object === mine.object)
                {
                    const at = list.indexOf(mine);
                    if (at >= 0)
                    {
                        list.splice(at, 1);
                    }
                    return;
                }
                await release(by);
            }) >>> 0;
        await release(pass);
        // FH4 may name the continuation in its tables; the funclet then
        // answers its index.
        const continuation = answer < handler.continuations.length
            ? handler.continuations[answer] : answer;
        return pass.continueAt({ ...visit.context, rip: continuation });
    };

    /**
     * The exception pass over one frame.
     *
     * @param {3 | 4} format
     * @returns {import('../kernel32/seh64.js').Interpreter['search']}
     */
    const search = format=>async(visit, pass)=>{
        const fn = tablesOf(visit, format);
        if (!fn)
        {
            host.divergence?.('__CxxFrameHandler3', 'a frame\'s tables carry a magic no compiler'
                + ' this runtime knows emits; the frame catches nothing');
            return null;
        }
        const { frame, state, inCatch } = locate(visit, fn);
        const thrown = thrownBy(pass.record);
        if (!thrown && translator !== 0)
        {
            host.divergence?.('_set_se_translator', 'a structured exception reached a C++'
                + ' frame of a 64-bit process with a translator installed; it is not called');
        }
        const catchables = thrown
            ? thrown.throwBase + read.u32(thrown.throwInfo + THROW_INFO.CATCHABLE_TYPES) >>> 0 : 0;
        const catchableCount = thrown ? Math.min(read.u32(catchables), WALK_LIMIT) : 0;
        for (const block of fn.tries)
        {
            if (state < block.low || state > block.high)
            {
                continue;
            }
            if (inCatch && (block.low <= inCatch.high || block.high > inCatch.catchHigh))
            {
                continue;
            }
            for (const handler of block.handlers)
            {
                if (!thrown)
                {
                    // A foreign exception is caught only by a catch (...), and
                    // not at all by code built to leave them alone.
                    if (isEllipsis(handler) && !fn.ehs)
                    {
                        return catchIt({ visit, pass, frame, block, handler, catchable: 0,
                            thrown: { object: 0, throwInfo: 0, throwBase: 0 } });
                    }
                    continue;
                }
                for (let type = 0; type < catchableCount; type++)
                {
                    const catchable = thrown.throwBase + read.u32(catchables + 4 + type * 4) >>> 0;
                    if (matches(handler, catchable, thrown.throwInfo, thrown.throwBase))
                    {
                        return catchIt({ visit, pass, frame, block, handler, catchable, thrown });
                    }
                }
            }
        }
        return null;
    };

    /**
     * The unwind pass over one frame: its objects back to the empty state, or
     * at the target back to the state the thread goes on in. A catch
     * funclet's objects are the parent's, destroyed when the walk reaches it.
     *
     * @param {3 | 4} format
     * @returns {import('../kernel32/seh64.js').Interpreter['unwind']}
     */
    const unwind = format=>async(visit, pass, target)=>{
        const fn = tablesOf(visit, format);
        if (!fn)
        {
            return;
        }
        const { frame, state, funclet } = locate(visit, fn);
        if (funclet && !target.at)
        {
            return;
        }
        const to = target.at ? target.state ?? fn.stateAt(target.ip) : -1;
        await unwindState(fn, frame, state, to, pass);
    };

    /** @type {Record<3 | 4, import('../kernel32/seh64.js').Interpreter>} */
    const interpreters = {
        3: { search: search(3), unwind: unwind(3) },
        4: { search: search(4), unwind: unwind(4) },
    };

    /**
     * A frame handler called by the program's own language handler, which
     * hands it the dispatcher context it was given.
     *
     * @param {3 | 4} format @param {string} name
     */
    const handedOn = (format, name)=>({
        argBytes: 16,
        lastError: false,
        /** @param {number[]} args */
        handler: ([, , , dispatcher])=>{
            const found = host.dispatcherContextAt(dispatcher >>> 0);
            if (!found)
            {
                host.divergence?.(name, 'called with a dispatcher context no walk of this'
                    + ' runtime made; the frame is passed over');
                return Disposition.CONTINUE_SEARCH;
            }
            const interpreter = interpreters[format];
            if (found.unwinding)
            {
                return interpreter.unwind(found.visit, found.pass, found.unwinding)
                    .then(()=>Disposition.CONTINUE_SEARCH);
            }
            return interpreter.search(found.visit, found.pass)
                .then(continuation=>continuation ?? Disposition.CONTINUE_SEARCH);
        },
    });

    /**
     * Ends the process the way `terminate` does: the program's own handler
     * first, then abort.
     *
     * @param {string} why
     */
    const terminate = async why=>{
        if (terminateHandler !== 0)
        {
            await host.callGuest(terminateHandler, [], host.currentThread());
        }
        host.abort(why);
        return new Promise(()=>{});
    };

    return {
        /** The interpreted handlers, for the dispatcher. */
        interpreters,

        /** The thrown object's record fields, for a reader of an exception. */
        thrownBy,

        table: {
            /**
             * EXCEPTION_DISPOSITION __CxxFrameHandler3(record, frame, context,
             *     dispatcher)
             *
             * Named in a frame's unwind data, the dispatcher reads its tables
             * itself rather than calling it; a program's own handler that
             * hands the frame on calls it with the dispatcher context, and
             * that finds the walk. `__CxxFrameHandler` and `2` read the same
             * tables.
             */
            __CxxFrameHandler: handedOn(3, '__CxxFrameHandler'),
            __CxxFrameHandler2: handedOn(3, '__CxxFrameHandler2'),
            __CxxFrameHandler3: handedOn(3, '__CxxFrameHandler3'),
            /** The compressed tables' handler, vcruntime140_1's. */
            __CxxFrameHandler4: handedOn(4, '__CxxFrameHandler4'),

            /**
             * void _CxxThrowException(void *pExceptionObject, _ThrowInfo *pThrowInfo)
             *
             * A `throw`; with neither argument `throw;`, which throws the
             * object of the innermost catch the thread is inside -- and with
             * none, there is nothing to rethrow and the program terminates.
             */
            _CxxThrowException: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([object, throwInfo])=>{
                    const thread = host.currentThread();
                    let thrown = { object: object >>> 0, throwInfo: throwInfo >>> 0,
                        throwBase: host.imageBaseOf(throwInfo >>> 0) };
                    if (thrown.throwInfo === 0)
                    {
                        const current = caught(thread).at(-1);
                        if (!current)
                        {
                            return terminate('throw; with no exception being handled');
                        }
                        thrown = { ...current };
                    }
                    inFlight.set(thread, (inFlight.get(thread) ?? 0) + 1);
                    return host.raise({
                        code: EH_EXCEPTION_NUMBER,
                        flags: EXCEPTION_NONCONTINUABLE,
                        parameters: [EH_MAGIC.V1, thrown.object, thrown.throwInfo,
                            thrown.throwBase],
                    });
                },
            },

            /** bool __uncaught_exception(void) */
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
                    return BigInt(previous);
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
                    return BigInt(previous);
                },
            },

            /**
             * _se_translator_function _set_se_translator(_se_translator_function)
             *
             * Kept and answered; a 64-bit frame does not call it (see `search`).
             */
            '?_set_se_translator@@YAP6AXIPEAU_EXCEPTION_POINTERS@@@ZP6AXI0@Z@Z': {
                convention: 'cdecl',
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([handler])=>{
                    const previous = translator;
                    translator = handler >>> 0;
                    return BigInt(previous);
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
