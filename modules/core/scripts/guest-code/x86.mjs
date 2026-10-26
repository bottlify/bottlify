/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The i386 instructions the guest-code compiler emits, and an assembler that
 * lays them out: bytes, labels, jumps whose displacement is chosen once the
 * layout is known (a byte where it reaches, four where it does not), and
 * references from the code to the constant tables placed after it.
 *
 * Nothing here knows where the code will sit in guest memory: every transfer
 * is relative, and a table is reached through the address a `call` to the next
 * instruction pushes (`picBase`) -- in x86-64 code, the address a RIP-relative
 * `lea` takes there -- plus the distance the assembler fills in.
 *
 * The x86-64 back end emits the same instructions over the low halves of
 * the registers, R8 to R11 among them: a 32-bit operation zero-extends into
 * the whole register, so a register the code computed holds an address as it
 * is. A register past the eighth is named by its low three bits in the
 * instruction and its fourth in a REX prefix (`Rex`) before the opcode.
 */

export const EAX = 0;
export const ECX = 1;
export const EDX = 2;
export const EBX = 3;
export const ESP = 4;
export const EBP = 5;
export const ESI = 6;
export const EDI = 7;
export const R8 = 8;
export const R9 = 9;
export const R10 = 10;
export const R11 = 11;

/** A REX prefix's bits: a register past the eighth in the reg field, the index, the base or rm. */
export const Rex = Object.freeze({ PREFIX: 0x40, W: 0x08, R: 0x04, X: 0x02, B: 0x01 });

/** The prefixes that come before a REX prefix, which must be the last before the opcode. */
export const LEGACY_PREFIXES = new Set([0x66, 0xf2, 0xf3]);

/** The registers the x64 convention passes the first four integer arguments in. */
export const ARGUMENTS_64 = Object.freeze([ECX, EDX, R8, R9]);

/** REX.W, with REX.R where the reg field names R8 or above. @param {number} reg */
const rexW = reg=>0x48 | (reg >= 8 ? 0x04 : 0);

/** Condition codes, as the low nibble of `jcc`. */
export const CC = Object.freeze({
    o: 0x0, b: 0x2, ae: 0x3, e: 0x4, ne: 0x5, be: 0x6, a: 0x7,
    p: 0xa, np: 0xb, l: 0xc, ge: 0xd, le: 0xe, g: 0xf,
});

/** The condition that holds exactly when `cc` does not. @param {number} cc */
export const invert = cc=>cc ^ 1;

/** The ALU operations by their /r digit: `op eax, ecx` is `(digit << 3) | 1`. */
export const ALU = Object.freeze({ add: 0, or: 1, and: 4, sub: 5, xor: 6, cmp: 7 });

/** @param {number} value @returns {number[]} */
export const le32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff,
    value >>> 24 & 0xff];

/** @param {number} value */
export const fitsByte = value=>value >= -128 && value <= 127;

/**
 * The ModRM (and displacement) of `[ebp + disp]` with `reg` in the reg field.
 *
 * @param {number} reg @param {number} disp
 * @returns {number[]}
 */
export function frame(reg, disp){
    return fitsByte(disp)
        ? [0x45 | reg << 3, disp & 0xff]
        : [0x85 | reg << 3, ...le32(disp)];
}

/**
 * @typedef {Object} Memory
 * @property {number} base
 * @property {number} [index]  Not esp.
 * @property {1 | 2 | 4 | 8} [scale]
 * @property {number} [disp]
 */

/**
 * The ModRM, SIB and displacement of `[base + index * scale + disp]` with
 * `reg` in the reg field.
 *
 * @param {number} reg @param {Memory} operand
 * @returns {number[]}
 */
export function memory(reg, { base, index, scale = 1, disp = 0 }){
    const mod = disp === 0 && base !== EBP ? 0 : fitsByte(disp) ? 1 : 2;
    const tail = mod === 0 ? [] : mod === 1 ? [disp & 0xff] : le32(disp);
    if (index === undefined)
    {
        return base === ESP
            ? [mod << 6 | reg << 3 | 4, 0x24, ...tail]
            : [mod << 6 | reg << 3 | base, ...tail];
    }
    const ss = scale === 1 ? 0 : scale === 2 ? 1 : scale === 4 ? 2 : 3;
    return [mod << 6 | reg << 3 | 4, ss << 6 | index << 3 | base, ...tail];
}

/** `mov [rsp + disp], reg64`. @param {number} reg @param {number} disp @returns {number[]} */
export const storeQuad = (reg, disp)=>[rexW(reg), 0x89, ...memory(reg & 7, { base: ESP, disp })];

/** `mov reg64, [rsp + disp]`. @param {number} reg @param {number} disp @returns {number[]} */
export const loadQuad = (reg, disp)=>[rexW(reg), 0x8b, ...memory(reg & 7, { base: ESP, disp })];

/**
 * `mov to, from` of two registers of x86-64 code: the whole of each with
 * `quad`, else their low halves, the destination zero-extended.
 *
 * @param {number} to @param {number} from @param {boolean} quad
 * @returns {number[]}
 */
export function moveRegister(to, from, quad){
    const rex = (quad ? Rex.W : 0) | (from >= 8 ? Rex.R : 0) | (to >= 8 ? Rex.B : 0);
    return [...rex === 0 ? [] : [Rex.PREFIX | rex], 0x89, 0xc0 | (from & 7) << 3 | to & 7];
}

/** `mov reg32, [rsp + disp]`, R8 to R15 among the registers. @param {number} reg @param {number} disp */
export const loadDword = (reg, disp)=>[...reg >= 8 ? [Rex.PREFIX | Rex.R] : [], 0x8b,
    ...memory(reg & 7, { base: ESP, disp })];

/**
 * `add rsp, bytes` (or `sub`, for a negative count): the whole register, which
 * a 32-bit form would cut to its low half.
 *
 * @param {number} bytes @returns {number[]}
 */
export function moveStack64(bytes){
    const digit = bytes < 0 ? 5 : 0;
    const size = Math.abs(bytes);
    return fitsByte(size) ? [0x48, 0x83, 0xc4 | digit << 3, size]
        : [0x48, 0x81, 0xc4 | digit << 3, ...le32(size)];
}

/**
 * @typedef {{ kind: 'bytes', bytes: number[] }
 *     | { kind: 'label', name: string }
 *     | { kind: 'jump', cc: number, to: string, long: boolean }
 *     | { kind: 'call', to: string }
 *     | { kind: 'ref', table: string, addend: number }
 *     | { kind: 'rip', table: string, addend: number }} Item
 *   jump: cc -1 is `jmp`; call: `call rel32` to a label; ref: four bytes, the table's offset
 *   less `picBase`'s, plus the addend; rip: four bytes ending an instruction, the table's
 *   offset plus the addend less the instruction's end, which a RIP-relative operand adds
 */

/**
 * @typedef {Object} Table
 * @property {string} name
 * @property {Uint8Array} bytes
 * @property {number} align
 */

export class Assembler {
    constructor(){
        /** @type {Item[]} */
        this.items = [];
        this.labels = 0;
        /** @type {Map<string, number>} Each label's offset, once `finish` has laid the code out. */
        this.offsets = new Map();
    }

    /** A label no other call returns. @param {string} hint */
    fresh(hint){
        return `${hint}.${this.labels++}`;
    }

    /** @param {...number} bytes */
    emit(...bytes){
        const last = this.items[this.items.length - 1];
        if (last?.kind === 'bytes')
        {
            last.bytes.push(...bytes);
        }
        else
        {
            this.items.push({ kind: 'bytes', bytes });
        }
        return this;
    }

    /** @param {string} name */
    label(name){
        this.items.push({ kind: 'label', name });
        return this;
    }

    /** `jcc`, or `jmp` for a cc of -1. @param {number} cc @param {string} to */
    jump(cc, to){
        this.items.push({ kind: 'jump', cc, to, long: false });
        return this;
    }

    /** `call rel32` to a label of this code. @param {string} to */
    call(to){
        this.items.push({ kind: 'call', to });
        return this;
    }

    /**
     * Four bytes: where a table starts, relative to the `picBase` label, plus
     * a constant.
     *
     * @param {string} table @param {number} [addend]
     */
    ref(table, addend = 0){
        this.items.push({ kind: 'ref', table, addend });
        return this;
    }

    /**
     * The four bytes that end an instruction with a RIP-relative operand:
     * where a table starts, plus a constant, from the instruction's end.
     *
     * @param {string} table @param {number} [addend]
     */
    rip(table, addend = 0){
        this.items.push({ kind: 'rip', table, addend });
        return this;
    }

    /** @param {Assembler} other */
    append(other){
        this.items.push(...other.items);
        return this;
    }

    /**
     * The code and, after it, each table at its alignment.
     *
     * Jumps start short and each one that does not reach grows to its long
     * form, until none changes: a jump only ever grows, so the lengths settle.
     *
     * @param {Table[]} [tables]
     * @returns {Uint8Array}
     */
    finish(tables = []){
        /** @type {Map<string, number>} */
        let at = new Map();
        let changed = true;
        let end = 0;
        while (changed)
        {
            changed = false;
            at = new Map();
            let offset = 0;
            for (const item of this.items)
            {
                if (item.kind === 'label')
                {
                    at.set(item.name, offset);
                }
                offset += sizeOf(item);
            }
            end = offset;
            offset = 0;
            for (const item of this.items)
            {
                if (item.kind === 'jump' && !item.long)
                {
                    const target = at.get(item.to);
                    if (target === undefined)
                    {
                        throw new Error(`x86: no label ${item.to}`);
                    }
                    if (!fitsByte(target - (offset + sizeOf(item))))
                    {
                        item.long = true;
                        changed = true;
                    }
                }
                offset += sizeOf(item);
            }
        }
        /** @type {Map<string, number>} */
        const placed = new Map();
        let tail = end;
        for (const table of tables)
        {
            tail = Math.ceil(tail / table.align) * table.align;
            placed.set(table.name, tail);
            tail += table.bytes.length;
        }
        const out = new Uint8Array(tail).fill(0xcc);
        let offset = 0;
        for (const item of this.items)
        {
            if (item.kind === 'bytes')
            {
                out.set(item.bytes, offset);
            }
            else if (item.kind === 'jump')
            {
                const size = sizeOf(item);
                const rel = /** @type {number} */ (at.get(item.to)) - (offset + size);
                const head = item.cc < 0
                    ? [item.long ? 0xe9 : 0xeb]
                    : item.long ? [0x0f, 0x80 | item.cc] : [0x70 | item.cc];
                out.set([...head, ...item.long ? le32(rel) : [rel & 0xff]], offset);
            }
            else if (item.kind === 'call')
            {
                const target = at.get(item.to);
                if (target === undefined)
                {
                    throw new Error(`x86: no label ${item.to}`);
                }
                out.set([0xe8, ...le32(target - (offset + 5))], offset);
            }
            else if (item.kind === 'ref')
            {
                const table = placed.get(item.table);
                const base = at.get('picBase');
                if (table === undefined || base === undefined)
                {
                    throw new Error(`x86: table ${item.table} referred to without a place`);
                }
                out.set(le32(table - base + item.addend), offset);
            }
            else if (item.kind === 'rip')
            {
                const table = placed.get(item.table);
                if (table === undefined)
                {
                    throw new Error(`x86: table ${item.table} referred to without a place`);
                }
                out.set(le32(table + item.addend - (offset + 4)), offset);
            }
            offset += sizeOf(item);
        }
        for (const table of tables)
        {
            out.set(table.bytes, /** @type {number} */ (placed.get(table.name)));
        }
        this.offsets = at;
        return out;
    }
}

/** @param {Item} item */
function sizeOf(item){
    switch (item.kind)
    {
        case 'bytes':
            return item.bytes.length;
        case 'label':
            return 0;
        case 'ref':
        case 'rip':
            return 4;
        case 'call':
            return 5;
        default:
            if (!item.long)
            {
                return 2;
            }
            return item.cc < 0 ? 5 : 6;
    }
}
