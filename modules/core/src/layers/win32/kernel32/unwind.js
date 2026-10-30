/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * x64 unwinding: how a 64-bit frame is taken off the stack without running
 * any of its code.
 *
 * A 64-bit thread registers nothing at FS:[0]. What a function does to the
 * stack in its prologue -- the registers it pushes, what it allocates, the
 * frame register it sets -- the compiler writes down once, in the image: a
 * RUNTIME_FUNCTION in the exception directory (`.pdata`) for the function's
 * range of addresses, and an UNWIND_INFO (`.xdata`) holding those steps as
 * codes, in reverse order, with the function's language handler after them.
 * Undoing the codes gives the caller's registers; doing that from the
 * faulting instruction up is how a dispatcher finds every frame and its
 * handler, and how an unwind reaches its target.
 *
 * The layouts and the rules are Microsoft's x64 exception-handling
 * specification: a function with no entry is a leaf, which moved nothing and
 * whose return address is at RSP; inside a prologue only the codes for the
 * instructions already run are undone; inside an epilogue the remaining
 * instructions are simulated, since its codes describe a prologue the
 * epilogue has already half undone, and no handler is called for it.
 */

/** UNWIND_INFO flags, and the handler types RtlVirtualUnwind is asked for. */
export const UNW_FLAG = Object.freeze({ NHANDLER: 0, EHANDLER: 1, UHANDLER: 2, CHAININFO: 4 });

/** The unwind operations. */
const UWOP = Object.freeze({
    PUSH_NONVOL: 0,
    ALLOC_LARGE: 1,
    ALLOC_SMALL: 2,
    SET_FPREG: 3,
    SAVE_NONVOL: 4,
    SAVE_NONVOL_FAR: 5,
    // SAVE_XMM in version 1's first revision; EPILOG in version 2.
    EPILOG: 6,
    SPARE: 7,
    SAVE_XMM128: 8,
    SAVE_XMM128_FAR: 9,
    PUSH_MACHFRAME: 10,
});

/** RUNTIME_FUNCTION: three RVAs, the function's start and end and its unwind data. */
export const RUNTIME_FUNCTION_SIZE = 12;

/** RSP's number, as the codes and the encoding name the registers. */
const RSP = 4;

/** Chained entries followed at most before the data is taken as damaged. */
const CHAIN_LIMIT = 32;

/**
 * A thread's registers as the unwinder moves them: the sixteen general
 * registers whole, RIP, the flags, and the XMM registers' bytes -- the parts
 * of an x64 CONTEXT an unwind can change.
 *
 * @typedef {Object} UnwindContext
 * @property {bigint[]} gpr     rax..r15, in the encoding's order.
 * @property {number} rip
 * @property {number} eflags
 * @property {Uint8Array} xmm   Sixteen registers of sixteen bytes.
 * @property {number} mxcsr
 */

/**
 * @param {UnwindContext} context
 * @returns {UnwindContext}
 */
export const copyContext = context=>({
    gpr: context.gpr.slice(), rip: context.rip, eflags: context.eflags,
    xmm: context.xmm.slice(), mxcsr: context.mxcsr,
});

/**
 * RSP as an address: its low dword, every address lying below 4 GiB.
 *
 * @param {UnwindContext} context
 */
export const stackOf = context=>Number(BigInt.asUintN(32, context.gpr[RSP]));

/**
 * The function entry found for an address.
 *
 * @typedef {Object} FunctionEntry
 * @property {number} imageBase
 * @property {number} entry      The RUNTIME_FUNCTION's own address.
 * @property {number} begin      Absolute.
 * @property {number} end        Absolute, past the last byte.
 * @property {number} unwindInfo Absolute.
 */

/**
 * What undoing one frame found.
 *
 * @typedef {Object} Unwound
 * @property {number} handler      The language handler, absolute; zero for none.
 * @property {number} handlerData  Where its data begins, past the handler's RVA.
 * @property {number} establisher  The frame's establisher frame.
 */

/**
 * @typedef {Object} UnwindHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number) => { base: number, size: number,
 *     table: { address: number, size: number } | null } | null} imageOf
 *     The image an address lies in and its exception directory, an RVA and a
 *     size; null outside every image.
 */

/**
 * How many slots an operation takes, its own included.
 *
 * @param {number} op @param {number} info @param {number} version
 */
const slotsOf = (op, info, version)=>{
    switch (op)
    {
        case UWOP.ALLOC_LARGE:
            return info === 0 ? 2 : 3;
        case UWOP.SAVE_NONVOL:
        case UWOP.SAVE_XMM128:
            return 2;
        case UWOP.SAVE_NONVOL_FAR:
        case UWOP.SAVE_XMM128_FAR:
        case UWOP.SPARE:
            return 3;
        case UWOP.EPILOG:
            return version >= 2 ? 1 : 2;
        default:
            return 1;
    }
};

/**
 * @param {UnwindHost} host
 */
export function createUnwinder(host){
    /** @param {number} at @param {number} length */
    const view = (at, length)=>{
        const bytes = host.readMemory(at >>> 0, length);
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    const readU32 = (/** @type {number} */ at)=>view(at, 4).getUint32(0, true);
    const readU64 = (/** @type {number} */ at)=>view(at, 8).getBigUint64(0, true);

    /**
     * Tables a program added for code it made at run time
     * (RtlAddFunctionTable): an array of entries relative to its own base.
     *
     * @type {{ table: number, count: number, base: number }[]}
     */
    const dynamic = [];

    /**
     * The entry of a table of `count` sorted RUNTIME_FUNCTIONs at `table`
     * whose range holds `rva`, by bisection.
     *
     * @param {number} table @param {number} count @param {number} rva
     * @returns {number} the entry's address, or zero
     */
    const search = (table, count, rva)=>{
        let low = 0;
        let high = count - 1;
        while (low <= high)
        {
            const middle = (low + high) >>> 1;
            const at = table + middle * RUNTIME_FUNCTION_SIZE >>> 0;
            const entry = view(at, 8);
            if (rva < entry.getUint32(0, true))
            {
                high = middle - 1;
            }
            else if (rva >= entry.getUint32(4, true))
            {
                low = middle + 1;
            }
            else
            {
                return at;
            }
        }
        return 0;
    };

    /**
     * @param {number} imageBase @param {number} entry
     * @returns {FunctionEntry}
     */
    const entryAt = (imageBase, entry)=>{
        const fields = view(entry, RUNTIME_FUNCTION_SIZE);
        return {
            imageBase,
            entry,
            begin: imageBase + fields.getUint32(0, true) >>> 0,
            end: imageBase + fields.getUint32(4, true) >>> 0,
            unwindInfo: imageBase + fields.getUint32(8, true) >>> 0,
        };
    };

    /**
     * RtlLookupFunctionEntry: the entry for the function holding `pc`, from
     * its image's exception directory or a table added at run time.
     *
     * @param {number} pc
     * @returns {FunctionEntry | null}
     */
    const lookup = pc=>{
        const at = pc >>> 0;
        const image = host.imageOf(at);
        if (image && image.table && image.table.size >= RUNTIME_FUNCTION_SIZE)
        {
            const found = search(image.base + image.table.address >>> 0,
                Math.floor(image.table.size / RUNTIME_FUNCTION_SIZE), at - image.base >>> 0);
            if (found !== 0)
            {
                return entryAt(image.base, found);
            }
        }
        for (const { table, count, base } of dynamic)
        {
            const found = at >= base ? search(table, count, at - base >>> 0) : 0;
            if (found !== 0)
            {
                return entryAt(base, found);
            }
        }
        return null;
    };

    /**
     * Whether code at `pc` is any image's, or a table added at run time
     * describes it: a frame whose return leads anywhere else is past the
     * last one the program's code made.
     *
     * @param {number} pc
     */
    const known = pc=>host.imageOf(pc >>> 0) !== null || lookup(pc) !== null;

    /** @param {UnwindContext} context @param {number} index */
    const low = (context, index)=>Number(BigInt.asUintN(32, context.gpr[index]));

    /**
     * The return a frame ends in: RIP from the stack, the stack past it.
     *
     * @param {UnwindContext} context
     */
    const returnFrom = context=>{
        const rsp = stackOf(context);
        context.rip = Number(BigInt.asUintN(32, readU64(rsp)));
        context.gpr[RSP] = BigInt(rsp + 8 >>> 0);
    };

    /**
     * Whether the instructions at `pc` are the rest of an epilogue, as the
     * specification allows one to be written -- `add rsp, n` or
     * `lea rsp, [frame register + n]` at most once, pops of non-volatile
     * registers, then a return or a jump out of the function -- and if so
     * the context as it is once they have run.
     *
     * @param {FunctionEntry} fn @param {number} pc @param {UnwindContext} context
     * @param {number} frameRegister
     * @returns {UnwindContext | null}
     */
    const epilogue = (fn, pc, context, frameRegister)=>{
        const code = host.readMemory(pc >>> 0, 48);
        const after = copyContext(context);
        let at = 0;
        /** @param {number} offset */
        const s8 = offset=>(code[offset] << 24 >> 24);
        /** @param {number} offset */
        const s32 = offset=>(code[offset] | code[offset + 1] << 8 | code[offset + 2] << 16
            | code[offset + 3] << 24);
        const wide = (code[at] & 0xf8) === 0x48;
        if (wide && code[at + 1] === 0x83 && code[at + 2] === 0xc4)
        {
            after.gpr[RSP] = BigInt(stackOf(after) + s8(at + 3) >>> 0);
            at += 4;
        }
        else if (wide && code[at + 1] === 0x81 && code[at + 2] === 0xc4)
        {
            after.gpr[RSP] = BigInt(stackOf(after) + s32(at + 3) >>> 0);
            at += 7;
        }
        else if (wide && (code[at] & 4) === 0 && code[at + 1] === 0x8d
            && (code[at + 2] & 0x38) === 0x20 && (code[at + 2] & 0xc0) !== 0xc0)
        {
            // lea rsp, [base + displacement]: only through the frame register.
            const modrm = code[at + 2];
            const base = (modrm & 7) | ((code[at] & 1) << 3);
            const mod = modrm >> 6;
            if (frameRegister === 0 || base !== frameRegister || (modrm & 7) === 4)
            {
                return null;
            }
            const displacement = mod === 1 ? s8(at + 3) : mod === 2 ? s32(at + 3) : 0;
            after.gpr[RSP] = BigInt(low(after, base) + displacement >>> 0);
            at += 3 + (mod === 1 ? 1 : mod === 2 ? 4 : 0);
        }
        for (;;)
        {
            const rex = (code[at] & 0xf0) === 0x40 ? code[at] : 0;
            const op = code[at + (rex ? 1 : 0)];
            if (op >= 0x58 && op <= 0x5f && (rex & 0x0e) === 0)
            {
                const register = (op - 0x58) | ((rex & 1) << 3);
                const rsp = stackOf(after);
                after.gpr[register] = readU64(rsp);
                after.gpr[RSP] = BigInt(rsp + 8 >>> 0);
                at += rex ? 2 : 1;
                continue;
            }
            break;
        }
        const op = code[at];
        const rexOp = (code[at] & 0xf0) === 0x40 ? code[at + 1] : -1;
        const target = (/** @type {number} */ length, /** @type {number} */ displacement)=>
            pc + at + length + displacement >>> 0;
        const outside = (/** @type {number} */ address)=>address < fn.begin || address >= fn.end;
        const ends = op === 0xc3
            || op === 0xc2
            || op === 0xf3 && code[at + 1] === 0xc3
            || op === 0xe9 && outside(target(5, s32(at + 1)))
            || op === 0xeb && outside(target(2, s8(at + 1)))
            // jmp [rip + n], or through a register: a tail call.
            || op === 0xff && (code[at + 1] === 0x25 || (code[at + 1] & 0xf8) === 0xe0)
            || rexOp === 0xff && (code[at + 2] === 0x25 || (code[at + 2] & 0xf8) === 0xe0);
        if (!ends)
        {
            return null;
        }
        returnFrom(after);
        return after;
    };

    /**
     * RtlVirtualUnwind: undoes the frame of `fn` that `context` stands in at
     * `pc`, leaving the caller's registers in it.
     *
     * @param {number} type  Which handler is wanted: UNW_FLAG.EHANDLER, UHANDLER, or NHANDLER.
     * @param {FunctionEntry} fn
     * @param {number} pc
     * @param {UnwindContext} context
     * @returns {Unwound}
     */
    const virtualUnwind = (type, fn, pc, context)=>{
        const header = (/** @type {number} */ info)=>{
            const bytes = host.readMemory(info, 4);
            return {
                version: bytes[0] & 7, flags: bytes[0] >> 3, prolog: bytes[1], count: bytes[2],
                frameRegister: bytes[3] & 15, frameOffset: bytes[3] >> 4,
            };
        };
        let info = fn.unwindInfo;
        let head = header(info);
        const at = pc >>> 0;
        const inPrologue = at >= fn.begin && at - fn.begin < head.prolog;
        let prologOffset = inPrologue ? at - fn.begin : Infinity;
        let establisher = stackOf(context);

        if (!inPrologue)
        {
            if (head.frameRegister !== 0)
            {
                establisher = low(context, head.frameRegister)
                    - head.frameOffset * 16 >>> 0;
            }
            const finished = epilogue(fn, at, context, head.frameRegister);
            if (finished)
            {
                Object.assign(context, finished);
                return { handler: 0, handlerData: 0, establisher };
            }
        }

        let machineFrame = false;
        for (let chained = 0; ; chained++)
        {
            const codes = host.readMemory(info + 4, head.count * 2 + 8);
            const slot = (/** @type {number} */ index)=>codes[index * 2] | codes[index * 2 + 1] << 8;
            const far = (/** @type {number} */ index)=>(slot(index) | slot(index + 1) << 16) >>> 0;
            const setsFrame = head.frameRegister !== 0 && Array.from({ length: head.count },
                (_, index)=>index).some(index=>(codes[index * 2 + 1] & 15) === UWOP.SET_FPREG
                && codes[index * 2] <= prologOffset);
            // Saves are addressed from the frame base: the frame register's
            // value less its offset once it is set, RSP before that.
            const frame = setsFrame
                ? low(context, head.frameRegister) - head.frameOffset * 16 >>> 0
                : stackOf(context);
            for (let index = 0; index < head.count;)
            {
                const offset = codes[index * 2];
                const op = codes[index * 2 + 1] & 15;
                const opInfo = codes[index * 2 + 1] >> 4;
                const size = slotsOf(op, opInfo, head.version);
                if (offset > prologOffset)
                {
                    index += size;
                    continue;
                }
                const rsp = stackOf(context);
                switch (op)
                {
                    case UWOP.PUSH_NONVOL:
                        context.gpr[opInfo] = readU64(rsp);
                        context.gpr[RSP] = BigInt(rsp + 8 >>> 0);
                        break;
                    case UWOP.ALLOC_LARGE:
                        context.gpr[RSP] = BigInt(rsp + (opInfo === 0 ? slot(index + 1) * 8
                            : far(index + 1)) >>> 0);
                        break;
                    case UWOP.ALLOC_SMALL:
                        context.gpr[RSP] = BigInt(rsp + opInfo * 8 + 8 >>> 0);
                        break;
                    case UWOP.SET_FPREG:
                        establisher = low(context, head.frameRegister)
                    - head.frameOffset * 16 >>> 0;
                        context.gpr[RSP] = BigInt(establisher);
                        break;
                    case UWOP.SAVE_NONVOL:
                        context.gpr[opInfo] = readU64(frame + slot(index + 1) * 8 >>> 0);
                        break;
                    case UWOP.SAVE_NONVOL_FAR:
                        context.gpr[opInfo] = readU64(frame + far(index + 1) >>> 0);
                        break;
                    case UWOP.SAVE_XMM128:
                        context.xmm.set(host.readMemory(frame + slot(index + 1) * 16 >>> 0, 16),
                            opInfo * 16);
                        break;
                    case UWOP.SAVE_XMM128_FAR:
                        context.xmm.set(host.readMemory(frame + far(index + 1) >>> 0, 16),
                            opInfo * 16);
                        break;
                    case UWOP.PUSH_MACHFRAME:
                    {
                    // An interrupt's frame: RIP, CS, EFLAGS, RSP, SS, after an
                    // error code when the info says one was pushed.
                        const base = rsp + (opInfo === 1 ? 8 : 0) >>> 0;
                        context.rip = Number(BigInt.asUintN(32, readU64(base)));
                        context.eflags = Number(BigInt.asUintN(32, readU64(base + 16)));
                        context.gpr[RSP] = readU64(base + 24);
                        machineFrame = true;
                        break;
                    }
                    default:
                    // EPILOG and SPARE describe nothing a prologue did.
                        break;
                }
                index += size;
            }
            if ((head.flags & UNW_FLAG.CHAININFO) === 0 || chained >= CHAIN_LIMIT)
            {
                break;
            }
            // The rest is the primary entry's, whose prologue has run in full.
            fn = entryAt(fn.imageBase, info + 4 + (head.count + 1 & ~1) * 2);
            info = fn.unwindInfo;
            head = header(info);
            prologOffset = Infinity;
        }

        let handler = 0;
        let handlerData = 0;
        if (!inPrologue && (head.flags & type) !== 0 && type !== UNW_FLAG.NHANDLER)
        {
            const handlerAt = info + 4 + (head.count + 1 & ~1) * 2;
            handler = fn.imageBase + readU32(handlerAt) >>> 0;
            handlerData = handlerAt + 4 >>> 0;
        }
        if (!machineFrame)
        {
            returnFrom(context);
        }
        return { handler, handlerData, establisher };
    };

    /**
     * One frame off a leaf -- a function with no entry, which moved nothing.
     *
     * @param {UnwindContext} context
     */
    const unwindLeaf = context=>returnFrom(context);

    return {
        lookup,
        /**
         * The base of the image an address lies in, zero outside every image.
         *
         * @param {number} pc
         */
        imageBase: pc=>host.imageOf(pc >>> 0)?.base ?? 0,
        virtualUnwind,
        unwindLeaf,
        known,

        /**
         * A function entry built from its RUNTIME_FUNCTION pointer, for
         * RtlVirtualUnwind, which is handed the entry rather than the address.
         *
         * @param {number} imageBase @param {number} entry
         */
        entryAt: (imageBase, entry)=>entryAt(imageBase, entry),

        /**
         * RtlAddFunctionTable: entries for code made at run time.
         *
         * @param {number} table @param {number} count @param {number} base
         */
        add(table, count, base){
            if (count === 0 || dynamic.some(added=>added.table === table >>> 0))
            {
                return false;
            }
            dynamic.push({ table: table >>> 0, count: count >>> 0, base: base >>> 0 });
            return true;
        },

        /** RtlDeleteFunctionTable. @param {number} table */
        remove(table){
            const at = dynamic.findIndex(added=>added.table === table >>> 0);
            if (at < 0)
            {
                return false;
            }
            dynamic.splice(at, 1);
            return true;
        },
    };
}
