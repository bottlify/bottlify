/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The WebAssembly binary encoder: the one place cork writes wasm bytes.
 *
 * A module is built from parts in any order -- types, imports, globals, a
 * function table, functions with their bodies, element segments -- and laid
 * out in the section order the format requires when `toBytes()` is asked. A
 * body is an instruction stream with the block structure checked as it is
 * written, so a `block` left open is an error here, with a line to look at,
 * rather than a validation failure naming a byte offset.
 *
 * Only what the translator emits is here; nothing is generated from a table
 * of every instruction. Numbers are LEB128 as the format wants them, and
 * every helper that takes a signed constant encodes it signed.
 *
 * A branch can be marked unlikely (`Body.unlikely`): the module then carries
 * the `metadata.code.branch_hint` custom section, which an engine that reads
 * it (Chromium 141's V8 does by default, node 22's behind
 * `--experimental-wasm-branch-hinting`) takes to lay the branch's code out of
 * line and to spill there rather than on the path taken; one that does not
 * skips the section.
 */

/** Value types, by their byte. */
export const ValType = Object.freeze({
    i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b, funcref: 0x70,
});

/** The block type of a block that leaves nothing on the stack. */
export const EMPTY = 0x40;

/**
 * Unsigned LEB128.
 *
 * @param {number} value  0 .. 2^32 - 1
 * @returns {number[]}
 */
export function leb128u(value){
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    {
        throw new Error(`encoder: ${value} is not an unsigned 32-bit integer`);
    }
    const out = [];
    let rest = value;
    for (;;)
    {
        const byte = rest % 128;
        rest = Math.floor(rest / 128);
        out.push(rest > 0 ? byte | 0x80 : byte);
        if (rest === 0)
        {
            return out;
        }
    }
}

/**
 * Signed LEB128 of a 32-bit value (an i32 constant, a branch depth's
 * signed forms are not needed).
 *
 * @param {number} value  -2^31 .. 2^32 - 1, taken as its 32-bit pattern
 * @returns {number[]}
 */
export function leb128s32(value){
    const out = [];
    let rest = value | 0;
    for (;;)
    {
        const byte = rest & 0x7f;
        rest >>= 7;
        const done = (rest === 0 && (byte & 0x40) === 0) || (rest === -1 && (byte & 0x40) !== 0);
        out.push(done ? byte : byte | 0x80);
        if (done)
        {
            return out;
        }
    }
}

/**
 * Signed LEB128 of a 64-bit value.
 *
 * @param {bigint} value
 * @returns {number[]}
 */
export function leb128s64(value){
    const out = [];
    let rest = BigInt.asIntN(64, value);
    for (;;)
    {
        const byte = Number(rest & 0x7fn);
        rest >>= 7n;
        const done = (rest === 0n && (byte & 0x40) === 0) || (rest === -1n && (byte & 0x40) !== 0);
        out.push(done ? byte : byte | 0x80);
        if (done)
        {
            return out;
        }
    }
}

const UTF8 = new TextEncoder();

/** @param {string} text @returns {number[]} a name as the format writes one */
function name(text){
    // A batch names every function and export: ASCII, the names cork makes, is
    // its own UTF-8 without an encoder's round trip.
    let ascii = true;
    for (let i = 0; i < text.length && ascii; i++)
    {
        ascii = text.charCodeAt(i) < 0x80;
    }
    if (!ascii)
    {
        const bytes = [...UTF8.encode(text)];
        return [...leb128u(bytes.length), ...bytes];
    }
    const out = leb128u(text.length);
    for (let i = 0; i < text.length; i++)
    {
        out.push(text.charCodeAt(i));
    }
    return out;
}

/** @param {number[]} bytes @param {number} count @returns {number[]} a vector with its count */
function vector(bytes, count){
    return [...leb128u(count), ...bytes];
}

/** Memory access opcodes by kind, with the natural alignment of each. */
const LOADS = Object.freeze({
    i32: [0x28, 2], i64: [0x29, 3], f32: [0x2a, 2], f64: [0x2b, 3],
    i32_8s: [0x2c, 0], i32_8u: [0x2d, 0], i32_16s: [0x2e, 1], i32_16u: [0x2f, 1],
    i64_8s: [0x30, 0], i64_8u: [0x31, 0], i64_16s: [0x32, 1], i64_16u: [0x33, 1],
    i64_32s: [0x34, 2], i64_32u: [0x35, 2],
});
const STORES = Object.freeze({
    i32: [0x36, 2], i64: [0x37, 3], f32: [0x38, 2], f64: [0x39, 3],
    i32_8: [0x3a, 0], i32_16: [0x3b, 1], i64_8: [0x3c, 0], i64_16: [0x3d, 1], i64_32: [0x3e, 2],
});
/**
 * Atomic memory access, the threads proposal's 0xfe space, by operation and
 * width, with the natural alignment each must be written with: `load_i32`,
 * `store_i32_8`, `add_i32_16`, `cmpxchg_i64` and so on. The read-modify-writes
 * answer the value memory held before.
 */
const ATOMICS = Object.freeze(Object.fromEntries(
    /** @type {[string, number][]} */ ([['load', 0x10], ['store', 0x17], ['add', 0x1e],
        ['sub', 0x25], ['and', 0x2c], ['or', 0x33], ['xor', 0x3a], ['xchg', 0x41],
        ['cmpxchg', 0x48]])
        .flatMap(([operation, base])=>[[`${operation}_i32`, [base, 2]],
            [`${operation}_i64`, [base + 1, 3]], [`${operation}_i32_8`, [base + 2, 0]],
            [`${operation}_i32_16`, [base + 3, 1]]])));
/**
 * The type of the value a store of `kind` writes: `i32_8` an i32, `f64` an f64.
 *
 * @param {string} kind
 */
const valueOf = kind=>(kind.startsWith('i64') ? ValType.i64 : kind.startsWith('f32')
    ? ValType.f32 : kind.startsWith('f64') ? ValType.f64 : ValType.i32);
/** A float constant's little-endian bytes, written here and copied out. */
const FLOAT_BYTES = new Uint8Array(8);
const FLOAT_VIEW = new DataView(FLOAT_BYTES.buffer);
/** v128 memory access, as SIMD opcodes: `v128.load` and `v128.store`. */
const SIMD_LOAD = 0;
const SIMD_STORE = 11;
/** `v128.and`. */
const SIMD_AND = 78;
/**
 * The lane and zero-extending vector accesses by opcode as a wide window
 * makes them (`Body.simdScalar`): the scalar access, whether it stores, and
 * the splat (with the bytes of its first lane kept, `zero`) or the lane's
 * replace or extract.
 * @type {Map<number, { kind: string, store: boolean, zero?: number, lane: number }>}
 */
const SIMD_SCALAR = new Map([
    [92, { kind: 'i32', store: false, zero: 4, lane: 17 }],
    [93, { kind: 'i64', store: false, zero: 8, lane: 18 }],
    [84, { kind: 'i32_8u', store: false, lane: 23 }],
    [85, { kind: 'i32_16u', store: false, lane: 26 }],
    [86, { kind: 'i32', store: false, lane: 28 }],
    [87, { kind: 'i64', store: false, lane: 30 }],
    [88, { kind: 'i32_8', store: true, lane: 22 }],
    [89, { kind: 'i32_16', store: true, lane: 25 }],
    [90, { kind: 'i32', store: true, lane: 27 }],
    [91, { kind: 'i64', store: true, lane: 29 }],
]);

/**
 * An instruction stream, with the block nesting checked as it is written.
 *
 * The bytes go straight into a buffer that grows by doubling, each number
 * LEB128-encoded in place: a region's body is thousands of instructions, and
 * building each one's bytes as an array of its own would be most of the cost
 * of emitting it.
 */
export class Body {
    /**
     * @param {number} [capacity]  bytes to start with: sixty-four by default,
     *     which V8 keeps in the object itself, as a region makes a body for
     *     every exit's register stores; a body known to grow big starts big,
     *     where doubling from sixty-four copied a region's tens of kilobytes
     *     ten times over.
     */
    constructor(capacity = 64){
        /** @type {Uint8Array} */
        this.buffer = new Uint8Array(capacity);
        /** Bytes written. */
        this.length = 0;
        this.depth = 0;
        /** By local index: 1 when the body reads or writes it, 2 when it writes it. */
        this.touched = new Uint8Array(64);
        /** Where the branches marked unlikely start, in bytes. @type {number[]} */
        this.hints = [];
        /**
         * Where the locals written from now on are added too, when given: the
         * region emitter's account of what each block writes.
         * @type {Set<number> | null}
         */
        this.written = null;
        /**
         * Where the locals read or written from now on are added too, when
         * given: the long-mode emitter's account of what each block touches.
         * @type {Set<number> | null}
         */
        this.seen = null;
        /**
         * Where the locals read before this point's code wrote them are added
         * too, when given, and the locals it wrote at `mustDepth` -- code no
         * branch inside the block skips -- into `must`: the region emitter's
         * account of what a block needs from before it (`planReloads`).
         * @type {Set<number> | null}
         */
        this.exposed = null;
        /** @type {Set<number> | null} */
        this.must = null;
        this.mustDepth = -1;
        /**
         * A wide window's guest accesses (cork's `wideLayout`), when given: an
         * access marked `guest` goes to `memory`, a `memory64` one, at the i32
         * address it was given widened and or-ed with the i64 local `high`, the
         * value a store writes kept meanwhile in `scratch(type)`.
         * @type {{ memory: number, high: number, scratch: (type: number) => number } | null}
         */
        this.guest = null;
    }

    /** Whether the body reads or writes a local. @param {number} index */
    uses(index){
        return index < this.touched.length && (this.touched[index] & 1) !== 0;
    }

    /** Whether the body writes a local. @param {number} index */
    writes(index){
        return index < this.touched.length && (this.touched[index] & 2) !== 0;
    }

    /** @param {number} index @param {number} how  1 read, 3 written */
    touch(index, how){
        if (index >= this.touched.length)
        {
            const grown = new Uint8Array(Math.max(index + 1, this.touched.length * 2));
            grown.set(this.touched);
            this.touched = grown;
        }
        this.touched[index] |= how;
        this.seen?.add(index);
        if (how === 3)
        {
            this.written?.add(index);
            if (this.depth === this.mustDepth)
            {
                this.must?.add(index);
            }
        }
        else if (this.must !== null && !this.must.has(index))
        {
            this.exposed?.add(index);
        }
    }

    /** The next instruction, an `if` or a `br_if`, is a branch rarely taken. */
    unlikely(){
        this.hints.push(this.length);
        return this;
    }

    /** Room for `count` more bytes. @param {number} count */
    reserve(count){
        if (this.length + count > this.buffer.length)
        {
            this.grow(count);
        }
    }

    /** @param {number} count */
    grow(count){
        let size = this.buffer.length * 2;
        while (size < this.length + count)
        {
            size *= 2;
        }
        const grown = new Uint8Array(size);
        grown.set(this.buffer.subarray(0, this.length));
        this.buffer = grown;
    }

    /** @param {number} value */
    byte(value){
        if (this.length === this.buffer.length)
        {
            this.grow(1);
        }
        this.buffer[this.length++] = value;
        return this;
    }

    /** Unsigned LEB128, 0 .. 2^32 - 1. @param {number} value */
    u32(value){
        this.reserve(5);
        let rest = value >>> 0;
        while (rest >= 0x80)
        {
            this.buffer[this.length++] = rest & 0x7f | 0x80;
            rest >>>= 7;
        }
        this.buffer[this.length++] = rest;
        return this;
    }

    /** Signed LEB128 of a 32-bit pattern. @param {number} value */
    s32(value){
        this.reserve(5);
        let rest = value | 0;
        for (;;)
        {
            const byte = rest & 0x7f;
            rest >>= 7;
            if ((rest === 0 && (byte & 0x40) === 0) || (rest === -1 && (byte & 0x40) !== 0))
            {
                this.buffer[this.length++] = byte;
                return this;
            }
            this.buffer[this.length++] = byte | 0x80;
        }
    }

    /**
     * Another body's bytes put in at `at`, a place this one kept for them
     * (the locals they name are not added to this one's).
     *
     * @param {number} at @param {Body} other
     */
    insert(at, other){
        this.reserve(other.length);
        this.buffer.copyWithin(at + other.length, at, this.length);
        this.buffer.set(other.buffer.subarray(0, other.length), at);
        this.length += other.length;
        if (other.hints.length > 0)
        {
            // In order still: the ones before, the other's, the ones moved on.
            this.hints = [...this.hints.filter(hint=>hint < at),
                ...other.hints.map(hint=>hint + at),
                ...this.hints.filter(hint=>hint >= at).map(hint=>hint + other.length)];
        }
        else
        {
            for (let i = this.hints.length - 1; i >= 0 && this.hints[i] >= at; i--)
            {
                this.hints[i] += other.length;
            }
        }
        return this;
    }

    /**
     * Other bodies put in at the places this one kept for them, in one pass:
     * what `insert` of each would leave, from the last place to the first,
     * where each `insert` moved the whole rest of the body along.
     *
     * @param {{ at: number, body: Body }[]} pieces  by place, and where two share one,
     *     in the order they are to follow each other
     */
    insertAll(pieces){
        let added = 0;
        for (const { body } of pieces)
        {
            added += body.length;
        }
        const out = new Uint8Array(Math.max(this.buffer.length, this.length + added));
        /** @type {number[]} */
        const hints = [];
        let from = 0;
        let written = 0;
        let hint = 0;
        for (const { at, body } of pieces)
        {
            out.set(this.buffer.subarray(from, at), written);
            // The body's own hints before the ones at its place: an insert puts
            // what was there after what it puts in.
            for (; hint < this.hints.length && this.hints[hint] < at; hint++)
            {
                hints.push(this.hints[hint] + written - from);
            }
            written += at - from;
            from = at;
            out.set(body.buffer.subarray(0, body.length), written);
            for (const one of body.hints)
            {
                hints.push(one + written);
            }
            written += body.length;
        }
        out.set(this.buffer.subarray(from, this.length), written);
        for (; hint < this.hints.length; hint++)
        {
            hints.push(this.hints[hint] + written - from);
        }
        this.buffer = out;
        this.length += added;
        this.hints = hints;
        return this;
    }

    /** @param {number} opcode @param {number[]} [immediates] */
    op(opcode, immediates){
        if (!Number.isInteger(opcode))
        {
            // A misspelt name would otherwise encode as byte 0: unreachable.
            throw new Error(`encoder: no such opcode (${String(opcode)})`);
        }
        this.byte(opcode);
        if (immediates !== undefined)
        {
            this.reserve(immediates.length);
            for (const value of immediates)
            {
                this.buffer[this.length++] = value;
            }
        }
        return this;
    }

    /** A SIMD instruction by its number in the 0xfd space. @param {number} opcode */
    simd(opcode){
        return this.byte(0xfd).u32(opcode);
    }

    /**
     * A SIMD memory instruction: opcode, memarg and, for the lane forms, the
     * lane index.
     *
     * @param {number} opcode
     * @param {{ align: number, offset: number, lane?: number, memory?: number,
     *     guest?: boolean }} memarg  align as its log2; `guest` as `load`'s
     */
    simdMem(opcode, { align, offset, lane, memory, guest = false }){
        const scalar = SIMD_SCALAR.get(opcode);
        if (guest && this.guest !== null && scalar !== undefined)
        {
            return this.simdScalar(opcode, scalar, offset, lane ?? 0);
        }
        // A lane's load or store, and a whole store, take the vector above the address.
        memory = guest ? this.guestAddress(lane !== undefined || opcode === SIMD_STORE
            ? ValType.v128 : undefined, memory) : memory;
        this.byte(0xfd).u32(opcode).memarg(align, offset, memory);
        return lane === undefined ? this : this.byte(lane);
    }

    /**
     * A wide window's lane and zero-extending vector access as the scalar access
     * and the lane operation it comes to: V8 12 (node 22) reads a `load64_zero`,
     * `load32_zero` or lane load from a `memory64` memory at a computed address
     * past 4 GiB as zeros, where its scalar loads read the bytes there.
     *
     * @param {number} opcode @param {{ kind: string, store: boolean, zero?: number,
     *     lane: number }} scalar  the access, and the splat or the lane's replace or
     *     extract @param {number} offset @param {number} lane
     */
    simdScalar(opcode, scalar, offset, lane){
        const wide = /** @type {NonNullable<Body['guest']>} */ (this.guest);
        const type = scalar.kind.startsWith('i64') ? ValType.i64 : ValType.i32;
        if (scalar.zero !== undefined)
        {
            // A splat of the value, its first lane kept.
            const mask = new Array(16).fill(0).fill(0xff, 0, scalar.zero);
            this.load(/** @type {keyof typeof LOADS} */ (scalar.kind), { offset, guest: true });
            return this.simd(scalar.lane).v128const(mask).simd(SIMD_AND);
        }
        const held = wide.scratch(ValType.v128);
        this.localSet(held);
        if (scalar.store)
        {
            this.localGet(held).simd(scalar.lane).byte(lane);
            return this.store(/** @type {keyof typeof STORES} */ (scalar.kind),
                { offset, guest: true });
        }
        const value = wide.scratch(type);
        this.load(/** @type {keyof typeof LOADS} */ (scalar.kind), { offset, guest: true })
            .localSet(value);
        return this.localGet(held).localGet(value).simd(scalar.lane).byte(lane);
    }

    /**
     * A guest access's address made the wide window's (`guest`), the i32 below
     * the `above` value (none for a load) widened and its high half put in;
     * answers the memory the access goes to. 4 GiB's guest leaves it as it is.
     *
     * @param {number | undefined} above  the type of the value over the address
     * @param {number | undefined} memory
     * @returns {number | undefined}
     */
    guestAddress(above, memory){
        const wide = this.guest;
        if (wide === null)
        {
            return memory;
        }
        const scratch = above === undefined ? -1 : wide.scratch(above);
        if (scratch >= 0)
        {
            this.localSet(scratch);
        }
        this.widenGuest();
        if (scratch >= 0)
        {
            this.localGet(scratch);
        }
        return wide.memory;
    }

    /**
     * The i32 guest address on the stack as a wide window's i64 one, its high
     * half put in (`guest`); as it is in 4 GiB. What a helper given a guest
     * address takes in a wide window.
     */
    widenGuest(){
        return this.guest === null ? this : this.op(0xad).localGet(this.guest.high).op(0x84);
    }

    unreachable(){
        return this.byte(0x00);
    }

    nop(){
        return this.byte(0x01);
    }

    /** @param {number} type  A value type, or EMPTY. */
    block(type = EMPTY){
        this.depth++;
        return this.byte(0x02).byte(type);
    }

    /** @param {number} type */
    loop(type = EMPTY){
        this.depth++;
        return this.byte(0x03).byte(type);
    }

    /** @param {number} type */
    if(type = EMPTY){
        this.depth++;
        return this.byte(0x04).byte(type);
    }

    else(){
        if (this.depth === 0)
        {
            throw new Error('encoder: else outside any if');
        }
        return this.byte(0x05);
    }

    end(){
        if (this.depth === 0)
        {
            throw new Error('encoder: end with no block open');
        }
        this.depth--;
        return this.byte(0x0b);
    }

    /** @param {number} depth */
    br(depth){
        return this.byte(0x0c).u32(depth);
    }

    /** @param {number} depth */
    brIf(depth){
        return this.byte(0x0d).u32(depth);
    }

    /** @param {number[]} depths @param {number} fallback */
    brTable(depths, fallback){
        this.byte(0x0e).u32(depths.length);
        for (const depth of depths)
        {
            this.u32(depth);
        }
        return this.u32(fallback);
    }

    return(){
        return this.byte(0x0f);
    }

    /** @param {number} functionIndex */
    call(functionIndex){
        return this.byte(0x10).u32(functionIndex);
    }

    /** @param {number} typeIndex @param {number} table */
    callIndirect(typeIndex, table = 0){
        return this.byte(0x11).u32(typeIndex).u32(table);
    }

    /** A tail call. @param {number} functionIndex */
    returnCall(functionIndex){
        return this.byte(0x12).u32(functionIndex);
    }

    /** @param {number} typeIndex @param {number} table */
    returnCallIndirect(typeIndex, table = 0){
        return this.byte(0x13).u32(typeIndex).u32(table);
    }

    drop(){
        return this.byte(0x1a);
    }

    select(){
        return this.byte(0x1b);
    }

    /** @param {number} index */
    localGet(index){
        this.touch(index, 1);
        return this.byte(0x20).u32(index);
    }

    /** @param {number} index */
    localSet(index){
        this.touch(index, 3);
        return this.byte(0x21).u32(index);
    }

    /** @param {number} index */
    localTee(index){
        this.touch(index, 3);
        return this.byte(0x22).u32(index);
    }

    /** @param {number} index */
    globalGet(index){
        return this.byte(0x23).u32(index);
    }

    /** @param {number} index */
    globalSet(index){
        return this.byte(0x24).u32(index);
    }

    /**
     * A memarg: the alignment's log2 and the offset, and a memory other than
     * the first (multi-memory) as the alignment's bit 6 and the memory's index.
     *
     * @param {number} align @param {number} offset @param {number} [memory]
     */
    memarg(align, offset, memory){
        return memory ? this.u32(align | 0x40).u32(memory).u32(offset)
            : this.u32(align).u32(offset);
    }

    /**
     * @param {keyof typeof LOADS} kind
     * @param {{ offset?: number, align?: number, memory?: number, guest?: boolean }} [options]
     *     `align` as log2, natural by default; `memory` the module's memory, the first by
     *     default; `guest` for an access to the guest's RAM at an i32 address, which a wide
     *     window makes its own (`guestAddress`)
     */
    load(kind, { offset = 0, align, memory, guest = false } = {}){
        const [opcode, natural] = LOADS[kind];
        memory = guest ? this.guestAddress(undefined, memory) : memory;
        return this.byte(opcode).memarg(align ?? natural, offset, memory);
    }

    /**
     * @param {keyof typeof STORES} kind
     * @param {{ offset?: number, align?: number, memory?: number, guest?: boolean }} [options]
     */
    store(kind, { offset = 0, align, memory, guest = false } = {}){
        const [opcode, natural] = STORES[kind];
        memory = guest ? this.guestAddress(valueOf(kind), memory) : memory;
        return this.byte(opcode).memarg(align ?? natural, offset, memory);
    }

    /**
     * An atomic access (`ATOMICS`): sequentially consistent, and a trap where
     * the address is not a multiple of its width -- the caller tests that first.
     *
     * @param {string} kind
     * @param {{ offset?: number, memory?: number, guest?: boolean }} [options]
     */
    atomic(kind, { offset = 0, memory, guest = false } = {}){
        const entry = ATOMICS[/** @type {keyof typeof ATOMICS} */ (kind)];
        if (entry === undefined)
        {
            throw new Error(`encoder: no such atomic (${kind})`);
        }
        if (guest && this.guest !== null && kind.startsWith('cmpxchg'))
        {
            // Two values over the address: no wide window's code makes one yet.
            throw new Error(`encoder: ${kind} into a wide window's RAM`);
        }
        const [opcode, natural] = entry;
        memory = guest ? this.guestAddress(kind.startsWith('load') ? undefined
            : valueOf(kind.replace(/^[a-z]+_/, '')), memory) : memory;
        return this.byte(0xfe).u32(opcode).memarg(natural, offset, memory);
    }

    /** `atomic.fence`: every access before it is seen before any after it. */
    atomicFence(){
        return this.byte(0xfe).u32(0x03).byte(0);
    }

    /** @param {{ offset?: number, align?: number, memory?: number, guest?: boolean }} [options] */
    loadV128({ offset = 0, align = 4, memory, guest = false } = {}){
        memory = guest ? this.guestAddress(undefined, memory) : memory;
        return this.byte(0xfd).u32(SIMD_LOAD).memarg(align, offset, memory);
    }

    /** @param {{ offset?: number, align?: number, memory?: number, guest?: boolean }} [options] */
    storeV128({ offset = 0, align = 4, memory, guest = false } = {}){
        memory = guest ? this.guestAddress(ValType.v128, memory) : memory;
        return this.byte(0xfd).u32(SIMD_STORE).memarg(align, offset, memory);
    }

    /** @param {number} value */
    i32const(value){
        return this.byte(0x41).s32(value);
    }

    /** @param {bigint} value */
    i64const(value){
        return this.op(0x42, leb128s64(value));
    }

    /** @param {number} value */
    f32const(value){
        FLOAT_VIEW.setFloat32(0, value, true);
        this.reserve(5);
        this.buffer[this.length++] = 0x43;
        for (let i = 0; i < 4; i++)
        {
            this.buffer[this.length++] = FLOAT_BYTES[i];
        }
        return this;
    }

    /** @param {number} value */
    f64const(value){
        FLOAT_VIEW.setFloat64(0, value, true);
        this.reserve(9);
        this.buffer[this.length++] = 0x44;
        for (let i = 0; i < 8; i++)
        {
            this.buffer[this.length++] = FLOAT_BYTES[i];
        }
        return this;
    }

    /** Sixteen bytes as a v128 constant. @param {Uint8Array | number[]} lanes */
    v128const(lanes){
        if (lanes.length !== 16)
        {
            throw new Error('encoder: a v128 constant is sixteen bytes');
        }
        return this.byte(0xfd).u32(12).op(lanes[0], [...lanes].slice(1));
    }

    /** The bytes written so far, a copy. */
    get bytes(){
        return this.buffer.slice(0, this.length);
    }

    /** The finished body's instructions, `end` included. @returns {Uint8Array<ArrayBuffer>} */
    toBytes(){
        if (this.depth !== 0)
        {
            throw new Error(`encoder: block left open (${this.depth} deep)`);
        }
        const out = new Uint8Array(this.length + 1);
        out.set(this.buffer.subarray(0, this.length));
        out[this.length] = 0x0b;
        return out;
    }
}

/**
 * A module under construction.
 */
export class ModuleBuilder {
    constructor(){
        /** @type {string[]} signatures, as "params|results" keys, by type index */
        this.types = [];
        /** @type {number[][]} */
        this.typeBytes = [];
        /** @type {number[][]} import entries, in declaration order */
        this.imports = [];
        this.importedFunctions = 0;
        this.importedGlobals = 0;
        /** @type {{ typeIndex: number, locals: number[], body: Uint8Array, hints: number[] }[]} */
        this.functions = [];
        /** @type {number[][]} */
        this.globals = [];
        /** @type {number[][]} */
        this.exports = [];
        /** @type {number | null} */
        this.tableMin = null;
        this.importedTable = false;
        /** @type {{ offset: number, functions: number[] }[]} */
        this.elements = [];
        /** @type {[number, string][]} function index and name, for the `name` section */
        this.functionNames = [];
    }

    /**
     * A function type, deduplicated.
     *
     * @param {{ params: number[], results: number[] }} signature
     * @returns {number} the type index
     */
    type({ params, results }){
        const key = `${params.join(',')}|${results.join(',')}`;
        const known = this.types.indexOf(key);
        if (known >= 0)
        {
            return known;
        }
        this.types.push(key);
        this.typeBytes.push([
            0x60, ...vector(params, params.length), ...vector(results, results.length),
        ]);
        return this.types.length - 1;
    }

    /**
     * @param {string} module @param {string} field
     * @param {{ min: number, max?: number, shared?: boolean, index64?: boolean }} limits  in
     *     pages; `index64` for a `memory64` memory, addressed with i64
     */
    importMemory(module, field, { min, max, shared = false, index64 = false }){
        const flag = (max === undefined ? 0 : 1) | (shared ? 2 : 0) | (index64 ? 4 : 0);
        const limits = [flag, ...leb128u(min), ...(max === undefined ? [] : leb128u(max))];
        this.imports.push([...name(module), ...name(field), 0x02, ...limits]);
        return this;
    }

    /**
     * @param {string} module @param {string} field @param {number} typeIndex
     * @returns {number} the function index
     */
    importFunction(module, field, typeIndex){
        if (this.functions.length > 0)
        {
            throw new Error('encoder: imports come before functions, which index after them');
        }
        this.imports.push([...name(module), ...name(field), 0x00, ...leb128u(typeIndex)]);
        return this.importedFunctions++;
    }

    /**
     * @param {string} module @param {string} field @param {number} valType @param {boolean} mutable
     * @returns {number} the global index
     */
    importGlobal(module, field, valType, mutable){
        if (this.globals.length > 0)
        {
            throw new Error('encoder: imported globals come before defined ones');
        }
        this.imports.push([...name(module), ...name(field), 0x03, valType, mutable ? 1 : 0]);
        return this.importedGlobals++;
    }

    /**
     * A defined global with a constant initialiser.
     *
     * @param {number} valType @param {boolean} mutable @param {number | bigint} init
     * @returns {number} the global index
     */
    global(valType, mutable, init){
        const initial = new Body();
        switch (valType)
        {
            case ValType.i32: initial.i32const(Number(init)); break;
            case ValType.i64: initial.i64const(BigInt(init)); break;
            case ValType.f32: initial.f32const(Number(init)); break;
            case ValType.f64: initial.f64const(Number(init)); break;
            default:
                throw new Error(`encoder: no initialiser for value type 0x${valType.toString(16)}`);
        }
        this.globals.push([valType, mutable ? 1 : 0, ...initial.toBytes()]);
        return this.importedGlobals + this.globals.length - 1;
    }

    /** One funcref table. @param {number} min */
    table(min){
        if (this.tableMin !== null || this.importedTable)
        {
            throw new Error('encoder: one table');
        }
        this.tableMin = min;
        return 0;
    }

    /**
     * The one table, imported instead: the host's, shared between modules.
     *
     * @param {string} module @param {string} field @param {number} min
     * @returns {number} the table index
     */
    importTable(module, field, min){
        if (this.tableMin !== null || this.importedTable)
        {
            throw new Error('encoder: one table');
        }
        this.importedTable = true;
        this.imports.push([...name(module), ...name(field), 0x01, ValType.funcref, 0x00,
            ...leb128u(min)]);
        return 0;
    }

    /**
     * A function's index handed out before its body is written, for a function
     * written first that calls it: `function` with `at` writes it there. Until
     * then it is a function of that type that traps, so a module whose writer
     * failed between the two is still whole.
     *
     * @param {number} typeIndex
     * @returns {number} the function index
     */
    reserveFunction(typeIndex){
        const index = this.importedFunctions + this.functions.length;
        this.functions.push({ typeIndex, locals: [], body: Uint8Array.of(0x00, 0x0b), hints: [] });
        return index;
    }

    /**
     * @param {number} typeIndex
     * @param {number[]} locals  value types, one entry per local
     * @param {Uint8Array} body  from `Body.toBytes()`
     * @param {{ exportAs?: string, hints?: number[], at?: number }} [options]  hints: the
     *     body's `hints`; at: an index `reserveFunction` handed out, written here
     * @returns {number} the function index
     */
    function(typeIndex, locals, body, { exportAs, hints = [], at = undefined } = {}){
        const index = at ?? this.importedFunctions + this.functions.length;
        if (at === undefined)
        {
            this.functions.push({ typeIndex, locals, body, hints });
        }
        else
        {
            this.functions[at - this.importedFunctions] = { typeIndex, locals, body, hints };
        }
        if (exportAs !== undefined)
        {
            this.exports.push([...name(exportAs), 0x00, ...leb128u(index)]);
        }
        return index;
    }

    /**
     * Names a function in the module's custom `name` section, which a
     * browser's profiler reads: a region function named by its address shows
     * in a CPU profile as itself rather than as `wasm-function[0]`.
     *
     * @param {number} functionIndex @param {string} functionName
     */
    nameFunction(functionIndex, functionName){
        this.functionNames.push([functionIndex, functionName]);
        return this;
    }

    /** @param {string} field @param {number} functionIndex */
    exportFunction(field, functionIndex){
        const entry = name(field);
        entry.push(0x00);
        for (const byte of leb128u(functionIndex))
        {
            entry.push(byte);
        }
        this.exports.push(entry);
        return this;
    }

    /** @param {string} field @param {number} globalIndex */
    exportGlobal(field, globalIndex){
        this.exports.push([...name(field), 0x03, ...leb128u(globalIndex)]);
        return this;
    }

    /** @param {string} field */
    exportTable(field){
        this.exports.push([...name(field), 0x01, 0x00]);
        return this;
    }

    /** Functions placed into the table from `offset`. @param {number} offset @param {number[]} functions */
    element(offset, functions){
        this.elements.push({ offset, functions });
        return this;
    }

    /** @returns {Uint8Array<ArrayBuffer>} */
    toBytes(){
        // The module's pieces, laid out once into its bytes at the end: a body is
        // a typed array and stays one, never spread through a JavaScript array
        // nor copied into a buffer of its own function's first (a batch of
        // hundreds of regions spent longer being assembled than compiled).
        /** @type {(number[] | Uint8Array)[]} */
        const parts = [];
        let total = 0;
        /** @param {number[] | Uint8Array} piece */
        const put = piece=>{
            parts.push(piece);
            total += piece.length;
        };
        /** @param {number[]} out @param {ArrayLike<number>} bytes */
        const append = (out, bytes)=>{
            for (let i = 0; i < bytes.length; i++)
            {
                out.push(bytes[i]);
            }
            return out;
        };
        /** A section with its id and size, or nothing when its content is empty.
         * @param {number} id @param {number[]} content */
        const section = (id, content)=>{
            if (content.length > 0)
            {
                put(append([id], leb128u(content.length)));
                put(content);
            }
        };
        /** @param {number[][]} entriesOf */
        const entries = entriesOf=>{
            const out = leb128u(entriesOf.length);
            for (const entry of entriesOf)
            {
                append(out, entry);
            }
            return out;
        };

        // The branch hints, by function: its index and count, then an offset, a size of
        // 1 and 0 (unlikely) each -- written into one buffer, as a region can have
        // hundreds and a batch hundreds of regions.
        const hints = new Body();
        let hinted = 0;
        /** Each function's size, local declarations and body, in order. @type {(number[] | Uint8Array)[]} */
        const codes = [];
        let codeLength = 0;
        for (let at = 0; at < this.functions.length; at++)
        {
            const { locals, body, hints: marked } = this.functions[at];
            // Runs of one type are one entry: "3 × i32, 1 × f64".
            /** @type {number[][]} */
            const runs = [];
            for (const local of locals)
            {
                const last = runs[runs.length - 1];
                if (last && last[1] === local)
                {
                    last[0]++;
                }
                else
                {
                    runs.push([1, local]);
                }
            }
            const declared = leb128u(runs.length);
            for (const [count, type] of runs)
            {
                append(declared, leb128u(count)).push(type);
            }
            if (marked.length > 0)
            {
                // In the order the body was written, which inserts keep; an offset
                // counts from the body's start, its local declarations included.
                hinted++;
                hints.u32(this.importedFunctions + at).u32(marked.length);
                for (const offset of marked)
                {
                    hints.u32(declared.length + offset).byte(1).byte(0);
                }
            }
            const size = leb128u(declared.length + body.length);
            codes.push(size, declared, body);
            codeLength += size.length + declared.length + body.length;
        }
        const functionTypes = leb128u(this.functions.length);
        for (const { typeIndex } of this.functions)
        {
            append(functionTypes, leb128u(typeIndex));
        }
        const table = this.tableMin === null
            ? []
            : [ValType.funcref, 0x00, ...leb128u(this.tableMin)];
        const elements = this.elements.map(({ offset, functions })=>[
            0x00, ...new Body().i32const(offset).toBytes(),
            ...vector(functions.flatMap(index=>leb128u(index)), functions.length),
        ]);

        put([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
        section(1, entries(this.typeBytes));
        section(2, entries(this.imports));
        section(3, functionTypes);
        section(4, this.tableMin === null ? [] : vector(table, 1));
        section(6, entries(this.globals));
        section(7, entries(this.exports));
        section(9, entries(elements));
        if (hinted > 0)
        {
            // Custom, but before the code section: an engine reads it while it compiles.
            const title = name('metadata.code.branch_hint');
            const count = leb128u(hinted);
            const content = hints.buffer.subarray(0, hints.length);
            put(append([0x00], leb128u(title.length + count.length + content.length)));
            put(title);
            put(count);
            put(content);
        }
        if (this.functions.length > 0)
        {
            const count = leb128u(this.functions.length);
            put(append([10], leb128u(count.length + codeLength)));
            put(count);
            for (const piece of codes)
            {
                put(piece);
            }
        }
        if (this.functionNames.length > 0)
        {
            // The custom `name` section, last: its function-names subsection (1)
            // maps indices to names.
            // In the order of the indices, as the section has them: a function
            // written into a reserved index is named after the ones above it.
            const map = leb128u(this.functionNames.length);
            for (const [index, functionName] of [...this.functionNames].sort((a, b)=>a[0] - b[0]))
            {
                append(append(map, leb128u(index)), name(functionName));
            }
            const head = append(append(name('name'), [0x01]), leb128u(map.length));
            put(append([0x00], leb128u(head.length + map.length)));
            put(head);
            put(map);
        }

        const out = new Uint8Array(total);
        let at = 0;
        for (const piece of parts)
        {
            out.set(piece, at);
            at += piece.length;
        }
        return out;
    }
}
