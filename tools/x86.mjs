/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A tiny 32-bit x86 assembler for the loader and marshaling fixtures.
 *
 * Hand-writing the bytes of a function that calls a dozen imports in sequence,
 * with a jump or two and a stack frame, is error-prone in a way that hides the
 * intent; this keeps the intent and fills in the displacements. It is a
 * fixture tool, not a code generator for the product: every instruction it
 * emits is fixed width, so an instruction's length is known before its
 * operands are, and two passes place the labels.
 *
 * Memory operands are `[base + disp]` with a 32-bit displacement, always; a
 * register operand is a name. Calls and jumps name a label, an import (through
 * the builder's `iat`), or a register. Addresses of code labels and of named
 * data come from the PE builder's `code` and `at`, so the assembler needs the
 * build context to resolve them, which `assemble` takes.
 */

/** @type {Record<string, number>} */
const REG = { eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7 };

/** @param {number} value @returns {number[]} */
const u16 = value=>[value & 0xff, (value >>> 8) & 0xff];
/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff,
    (value >>> 24) & 0xff];

/** @param {string} name @returns {number} */
const reg = name=>{
    if (!(name in REG))
    {
        throw new Error(`x86: no register ${name}`);
    }
    return REG[name];
};

/**
 * A jump's short conditions, by name.
 *
 * @type {Record<string, number>}
 */
const CONDITION = { e: 0x84, ne: 0x85, l: 0x8c, ge: 0x8d, g: 0x8f, le: 0x8e, b: 0x82, ae: 0x83 };

/**
 * @typedef {Object} BuildContext
 * @property {(name: string) => number} iat   The import's address slot.
 * @property {(name: string) => number} at    A named datum's address.
 * @property {(offset: number) => number} code  The VA of a code offset.
 */

/**
 * @typedef {Object} Piece
 * @property {number} length
 * @property {(ctx: BuildContext, base: number, labels: Map<string, number>, here: number)
 *     => number[]} emit
 */

/**
 * The assembler: methods build up pieces, `assemble(ctx)` resolves them.
 */
export class Asm {
    constructor(){
        /** @type {(Piece | { label: string })[]} */
        this.pieces = [];
    }

    /** @param {string} name */
    label(name){
        this.pieces.push({ label: name });
        return this;
    }

    /**
     * @param {number} length
     * @param {(ctx: BuildContext, base: number, labels: Map<string, number>, here: number)
     *     => number[]} emit
     */
    op(length, emit){
        this.pieces.push({ length, emit });
        return this;
    }

    /** @param {number[]} bytes */
    raw(bytes){
        return this.op(bytes.length, ()=>bytes);
    }

    /** @param {string} name  A register, or [base+disp] via the mem helpers below. */
    push(name){
        return this.op(1, ()=>[0x50 + reg(name)]);
    }

    /** @param {number} value */
    pushImm(value){
        return this.op(5, ()=>[0x68, ...u32(value)]);
    }

    /** push the address of a named datum. */
    /** @param {string} name */
    pushData(name){
        return this.op(5, ctx=>[0x68, ...u32(ctx.at(name))]);
    }

    /** push the address of a code label. */
    /** @param {string} name */
    pushLabel(name){
        return this.op(5, (ctx, base, labels)=>[0x68, ...u32(ctx.code(labelAt(labels, name)))]);
    }

    /** push dword [base + disp] */
    /** @param {string} base @param {number} disp */
    pushMem(base, disp){
        return this.op(6, ()=>[0xff, 0xb0 | reg(base), ...u32(disp)]);
    }

    /** @param {string} dst @param {number} value */
    movImm(dst, value){
        return this.op(5, ()=>[0xb8 + reg(dst), ...u32(value)]);
    }

    /** @param {string} dst @param {string} name */
    movData(dst, name){
        return this.op(5, ctx=>[0xb8 + reg(dst), ...u32(ctx.at(name))]);
    }

    /** @param {string} dst @param {string} name */
    movLabel(dst, name){
        return this.op(5, (ctx, base, labels)=>
            [0xb8 + reg(dst), ...u32(ctx.code(labelAt(labels, name)))]);
    }

    /** mov dst, [base + disp] */
    /** @param {string} dst @param {string} base @param {number} disp */
    load(dst, base, disp){
        return this.op(6, ()=>[0x8b, 0x80 | (reg(dst) << 3) | reg(base), ...u32(disp)]);
    }

    /** mov [base + disp], src */
    /** @param {string} base @param {number} disp @param {string} src */
    store(base, disp, src){
        return this.op(6, ()=>[0x89, 0x80 | (reg(src) << 3) | reg(base), ...u32(disp)]);
    }

    /** mov [base + disp], imm32 */
    /** @param {string} base @param {number} disp @param {number} value */
    storeImm(base, disp, value){
        return this.op(10, ()=>[0xc7, 0x80 | reg(base), ...u32(disp), ...u32(value)]);
    }

    /** mov [base + disp], &code label */
    /** @param {string} base @param {number} disp @param {string} name */
    storeLabel(base, disp, name){
        return this.op(10, (ctx, b, labels)=>
            [0xc7, 0x80 | reg(base), ...u32(disp), ...u32(ctx.code(labelAt(labels, name)))]);
    }

    /** mov [base + disp], &data */
    /** @param {string} base @param {number} disp @param {string} name */
    storeData(base, disp, name){
        return this.op(10, ctx=>[0xc7, 0x80 | reg(base), ...u32(disp), ...u32(ctx.at(name))]);
    }

    /** lea dst, [base + disp] */
    /** @param {string} dst @param {string} base @param {number} disp */
    lea(dst, base, disp){
        return this.op(6, ()=>[0x8d, 0x80 | (reg(dst) << 3) | reg(base), ...u32(disp)]);
    }

    /** @param {string} dst @param {string} src */
    mov(dst, src){
        return this.op(2, ()=>[0x89, 0xc0 | (reg(src) << 3) | reg(dst)]);
    }

    /** @param {string} dst @param {number} value */
    addImm(dst, value){
        return this.op(6, ()=>[0x81, 0xc0 | reg(dst), ...u32(value)]);
    }

    /** @param {string} dst @param {number} value */
    subImm(dst, value){
        return this.op(6, ()=>[0x81, 0xe8 | reg(dst), ...u32(value)]);
    }

    /** @param {string} dst @param {number} value */
    andImm(dst, value){
        return this.op(6, ()=>[0x81, 0xe0 | reg(dst), ...u32(value)]);
    }

    /** @param {string} dst @param {string} src */
    add(dst, src){
        return this.op(2, ()=>[0x01, 0xc0 | (reg(src) << 3) | reg(dst)]);
    }

    /** @param {string} dst @param {number} value */
    cmpImm(dst, value){
        return this.op(6, ()=>[0x81, 0xf8 | reg(dst), ...u32(value)]);
    }

    /** @param {string} left @param {string} right */
    test(left, right){
        return this.op(2, ()=>[0x85, 0xc0 | (reg(right) << 3) | reg(left)]);
    }

    /** @param {string} name */
    xor(name){
        return this.op(2, ()=>[0x31, 0xc0 | (reg(name) << 3) | reg(name)]);
    }

    /** call dword [iat import] */
    /** @param {string} name */
    callImport(name){
        return this.op(6, ctx=>[0xff, 0x15, ...u32(ctx.iat(name))]);
    }

    /** @param {string} name */
    call(name){
        return this.op(5, (ctx, base, labels, here)=>
            [0xe8, ...u32((ctx.code(labelAt(labels, name)) - ctx.code(here + 5)) >>> 0)]);
    }

    /** @param {string} name */
    callReg(name){
        return this.op(2, ()=>[0xff, 0xd0 | reg(name)]);
    }

    /** @param {string} name */
    jmp(name){
        return this.op(5, (ctx, base, labels, here)=>
            [0xe9, ...u32((ctx.code(labelAt(labels, name)) - ctx.code(here + 5)) >>> 0)]);
    }

    /** @param {string} condition @param {string} name */
    jcc(condition, name){
        if (!(condition in CONDITION))
        {
            throw new Error(`x86: no condition ${condition}`);
        }
        return this.op(6, (ctx, base, labels, here)=>
            [0x0f, CONDITION[condition], ...u32((ctx.code(labelAt(labels, name))
                - ctx.code(here + 6)) >>> 0)]);
    }

    /** mov dst, dword [import]: the address an import was bound to. */
    /** @param {string} dst @param {string} name */
    loadImport(dst, name){
        return this.op(6, ctx=>[0x8b, 0x05 | (reg(dst) << 3), ...u32(ctx.iat(name))]);
    }

    /** A dword in the code stream: a table the code points at. */
    /** @param {number} value */
    dword(value){
        return this.op(4, ()=>u32(value));
    }

    /** A dword holding a code label's address. */
    /** @param {string} name */
    dwordLabel(name){
        return this.op(4, (ctx, base, labels)=>u32(ctx.code(labelAt(labels, name))));
    }

    /** Bytes in the code stream: a string or a format string the code points at. */
    /** @param {number[]} bytes */
    bytes(bytes){
        return this.raw(bytes);
    }

    /** mov edx, fs:[0]; a segment-overridden absolute load, for the SEH chain head. */
    loadTeb(){
        return this.op(7, ()=>[0x64, 0x8b, 0x15, ...u32(0)]);
    }

    /** mov fs:[0], eax */
    storeTeb(){
        return this.op(7, ()=>[0x64, 0x89, 0x05, ...u32(0)]);
    }

    ret(){
        return this.op(1, ()=>[0xc3]);
    }

    /** @param {number} bytes */
    retN(bytes){
        return this.op(3, ()=>[0xc2, ...u16(bytes)]);
    }

    /** The code's length in bytes, once every op is placed. */
    get length(){
        return this.pieces.reduce((total, piece)=>total + ('length' in piece ? piece.length : 0),
            0);
    }

    /**
     * The bytes, with every label, call and address resolved.
     *
     * @param {BuildContext} ctx
     * @returns {number[]}
     */
    assemble(ctx){
        /** @type {Map<string, number>} */
        const labels = new Map();
        let at = 0;
        for (const piece of this.pieces)
        {
            if ('label' in piece)
            {
                if (labels.has(piece.label))
                {
                    throw new Error(`x86: label ${piece.label} twice`);
                }
                labels.set(piece.label, at);
            }
            else
            {
                at += piece.length;
            }
        }
        /** @type {number[]} */
        const out = [];
        let here = 0;
        for (const piece of this.pieces)
        {
            if ('label' in piece)
            {
                continue;
            }
            const bytes = piece.emit(ctx, 0, labels, here);
            if (bytes.length !== piece.length)
            {
                throw new Error(`x86: an op said ${piece.length} bytes and emitted ${bytes.length}`);
            }
            out.push(...bytes);
            here += piece.length;
        }
        return out;
    }
}

/** @param {Map<string, number>} labels @param {string} name */
function labelAt(labels, name){
    const at = labels.get(name);
    if (at === undefined)
    {
        throw new Error(`x86: no label ${name}`);
    }
    return at;
}
