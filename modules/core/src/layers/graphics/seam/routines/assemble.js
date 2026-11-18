/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How a device's guest routines are put together: the bytes of a routine with
 * labels and branches laid out (`assemble`), the prologue that finds the
 * object's block and leaves for the host when it cannot answer, the device's
 * lock taken and let go, and the trap a routine's slow label jumps to
 * (`routine`). The routines themselves are in the files beside this one.
 */

import { D3DERR_INVALIDCALL } from '../../d3d8/constants.js';
import { FLAG_SLOW_PATH, FLAG_STALE, HELD_GUEST, SHADOW, TEXTURE } from '../block.js';

/** @param {number} value @returns {number[]} */
export const dword = value=>[
    value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
];

/**
 * Lays out a routine whose branches name their targets, so that no
 * displacement is counted by hand: a part is bytes, a label, or a branch
 * `{ jcc, to }` that becomes two bytes once every label has a position --
 * or five or six, `jmp`/`jcc rel32`, when it says `near`. A short branch
 * that cannot be reached with a byte is a mistake in the routine and is
 * refused rather than truncated.
 *
 * @param {(number[] | { label: string } | { jcc: number, to: string, near?: boolean })[]} parts
 * @returns {Uint8Array}
 */
export function assemble(parts){
    /** @param {{ jcc: number, near?: boolean }} branch */
    const sizeOf = branch=>(!branch.near ? 2 : branch.jcc === 0xeb ? 5 : 6);
    /** @type {Map<string, number>} */
    const labels = new Map();
    let at = 0;
    for (const part of parts)
    {
        if (Array.isArray(part))
        {
            at += part.length;
        }
        else if ('label' in part)
        {
            labels.set(part.label, at);
        }
        else
        {
            at += sizeOf(part);
        }
    }
    /** @type {number[]} */
    const out = [];
    for (const part of parts)
    {
        if (Array.isArray(part))
        {
            out.push(...part);
        }
        else if ('jcc' in part)
        {
            const target = labels.get(part.to);
            if (target === undefined)
            {
                throw new Error(`shadow: no label ${part.to}`);
            }
            if (part.near)
            {
                const rel = target - (out.length + sizeOf(part));
                const opcode = part.jcc === 0xeb ? [0xe9] : [0x0f, part.jcc + 0x10];
                out.push(...opcode, ...dword(rel | 0));
                continue;
            }
            const rel = target - (out.length + 2);
            if (rel < -128 || rel > 127)
            {
                throw new Error(`shadow: branch to ${part.to} does not fit a byte`);
            }
            out.push(part.jcc, rel & 0xff);
        }
    }
    return new Uint8Array(out);
}

/** `jmp rel32` from `from` to `to`. @param {number} from @param {number} to */
const jump = (from, to)=>[0xe9, ...dword((to - (from + 5)) | 0)];

/**
 * `op reg, [esp+disp]` or `op [esp+disp], reg` (the ModR/M form of `opcode`,
 * `reg` a ModR/M register number or an opcode extension): a byte of
 * displacement where it fits. In long mode the same bytes address [rsp+disp].
 *
 * @param {number[]} opcode @param {number} reg @param {number} disp
 */
const onStack = (opcode, reg, disp)=>(disp < 0x80
    ? [...opcode, 0x44 | reg << 3, 0x24, disp]
    : [...opcode, 0x84 | reg << 3, 0x24, ...dword(disp)]);

/**
 * What a routine's code depends on the process's width for, so that one
 * source builds a routine for a 32-bit process and a 64-bit one alike.
 *
 * In a 32-bit process a method is stdcall: its arguments on the stack past
 * the return address, `this` first, popped by `ret n`. In a 64-bit one the
 * first four are in RCX, RDX, R8 and R9 and the rest past 32 bytes of home
 * space the caller leaves for them. The routine's first act there is to put
 * the four into their home slots (`entry`), after which argument `i` is at
 * [rsp + 8 + 8i] as it is at [esp + 4 + 4i] in the i386, the four registers
 * free; the slow way puts them back (`reload`) before the jump to the trap,
 * which reads the call as it came. What a routine keeps in its registers it
 * keeps in their low halves: a 32-bit operation zero-extends, so an address
 * made of them is the guest address below 4 GiB, and an argument that is a
 * pointer is the routine's only where its upper half is zero (`highZero`).
 *
 * An interface pointer's block is the word after the method table's: [this+4]
 * and [this+8] (`createVtables`), and a pointer a routine writes out is that
 * wide (`storePointer`).
 *
 * @typedef {Object} Width
 * @property {32 | 64} bits
 * @property {4 | 8} word  a pointer's bytes
 * @property {(reg: number, index: number, pushed?: number) => number[]} arg
 *     `mov reg, argument` - its low half - with `pushed` words pushed since the entry
 * @property {(opcode: number[], reg: number, index: number, pushed?: number) => number[]} argOp
 *     the ModR/M form of `opcode` with the argument's slot as its memory operand
 * @property {(index: number, slow: string, pushed?: number) => any[]} highZero
 *     to `slow` where an argument's upper half is not zero: nothing in a 32-bit process
 * @property {(dst: number, src: number) => number[]} blockOf  `mov dst, [src+word]`
 * @property {(base: number, src: number, disp: number) => number[]} storePointer
 *     `mov [base+disp], src` as a pointer, the upper half zero
 * @property {(args: number) => number[]} ret  the return of a method of `args` arguments
 * @property {() => number[]} entry @property {() => number[]} reload
 */

/** @type {Width} */
export const I386 = Object.freeze({
    bits: /** @type {32} */ (32),
    word: /** @type {4} */ (4),
    arg: (reg, index, pushed = 0)=>onStack([0x8b], reg, 4 * (1 + index + pushed)),
    argOp: (opcode, reg, index, pushed = 0)=>onStack(opcode, reg, 4 * (1 + index + pushed)),
    highZero: ()=>[],
    blockOf: (dst, src)=>[0x8b, 0x40 | dst << 3 | src, 4],
    storePointer: (base, src, disp)=>[0x89, 0x80 | src << 3 | base, ...dword(disp)],
    ret: args=>[0xc2, 4 * args, 0x00],
    entry: ()=>[],
    reload: ()=>[],
});

/** The four argument registers' home slots: mov [rsp+8], rcx .. mov [rsp+32], r9. */
const HOMES = [[0x48, 1, 8], [0x48, 2, 16], [0x4c, 0, 24], [0x4c, 1, 32]];

/** @type {Width} */
export const X64 = Object.freeze({
    bits: /** @type {64} */ (64),
    word: /** @type {8} */ (8),
    arg: (reg, index, pushed = 0)=>onStack([0x8b], reg, 8 * (1 + index + pushed)),
    argOp: (opcode, reg, index, pushed = 0)=>onStack(opcode, reg, 8 * (1 + index + pushed)),
    highZero: (index, slow, pushed = 0)=>[
        [...onStack([0x83], 7, 8 * (1 + index + pushed) + 4), 0x00], // cmp dword [rsp+d+4], 0
        { jcc: 0x75, to: slow, near: true },                         // jne slow
    ],
    blockOf: (dst, src)=>[0x8b, 0x40 | dst << 3 | src, 8],
    storePointer: (base, src, disp)=>[0x48, 0x89, 0x80 | src << 3 | base, ...dword(disp)],
    ret: ()=>[0xc3],
    entry: ()=>HOMES.flatMap(([rex, reg, disp])=>onStack([rex, 0x89], reg, disp)),
    reload: ()=>HOMES.flatMap(([rex, reg, disp])=>onStack([rex, 0x8b], reg, disp)),
});

/**
 * A part of a routine whose bytes depend on the process's width, written
 * where the routine reads an argument, checks a pointer argument's upper
 * half, finds an object's block or its count, or returns; `routine` lays
 * each out for its `Width`. A routine's pieces made apart from it - a
 * command's mirror, a guard - say so with these, and are the same data at
 * both widths.
 *
 * @typedef {{ argOp: number[], reg: number, index: number, tail: number[], pushed: number }
 *     | { high: number, to: string, pushed: number }
 *     | { block: [number, number] } | { count: [number, number] } | { ret: number }} Wide
 * @typedef {number[] | { label: string } | { jcc: number, to: string, near?: boolean }
 *     | Wide} Part
 */

/**
 * `op reg, argument` or `op argument, reg` - the ModR/M form of `opcode` with
 * argument `index` (`this` the first of a method) as its memory operand, then
 * `tail` (an immediate) - with `pushed` words pushed since the entry.
 *
 * @param {number[]} opcode @param {number} reg @param {number} index
 * @param {number[]} [tail] @param {number} [pushed]
 * @returns {Wide}
 */
export const argAt = (opcode, reg, index, tail = [], pushed = 0)=>({ argOp: opcode, reg, index,
    tail, pushed });

/**
 * To `to` where argument `index`'s upper half is not zero: a pointer the
 * routine reads through or records must be a guest address below 4 GiB.
 * Nothing in a 32-bit process.
 *
 * @param {number} index @param {string} to @param {number} [pushed]
 * @returns {Wide}
 */
export const highAt = (index, to, pushed = 0)=>({ high: index, to, pushed });

/** `mov dst, [src + word]`: an interface's block. @param {number} dst @param {number} src */
export const blockAt = (dst, src)=>/** @type {Wide} */ ({ block: [dst, src] });

/**
 * `mov dst, [src + 2*word]`: the word an interface's count is kept in, the
 * third of its block (`bridge/internal/vtable.js`).
 *
 * @param {number} dst @param {number} src
 */
export const countAt = (dst, src)=>/** @type {Wide} */ ({ count: [dst, src] });

/** The return of a method of `args` arguments, `this` among them. @param {number} args */
export const retOf = args=>/** @type {Wide} */ ({ ret: args });

/**
 * A routine's parts with each `Wide` one laid out for `width`.
 *
 * @param {Part[]} parts @param {Width} width
 * @returns {(number[] | { label: string } | { jcc: number, to: string, near?: boolean })[]}
 */
export const resolveParts = (parts, width)=>parts.flatMap(part=>{
    if (Array.isArray(part) || 'label' in part || 'jcc' in part)
    {
        return [part];
    }
    if ('argOp' in part)
    {
        return [[...width.argOp(part.argOp, part.reg, part.index, part.pushed), ...part.tail]];
    }
    if ('high' in part)
    {
        return width.highZero(part.high, part.to, part.pushed);
    }
    if ('block' in part)
    {
        return [width.blockOf(...part.block)];
    }
    if ('count' in part)
    {
        const [dst, src] = part.count;
        return [[0x8b, 0x40 | dst << 3 | src, 2 * width.word]];
    }
    return [width.ret(part.ret)];
});

/**
 * What every routine starts with: the object's block into ECX, and the two
 * cases that are the host's whatever the call -- no block, or the host's flag.
 *
 *     mov ecx, [esp+4]            ; this
 *     mov ecx, [ecx+4]            ; the block
 *     test ecx, ecx
 *     jz slow                     ; no block: the host's
 *     test dword [ecx], 1         ; the host wants the slow path?
 *     jnz slow
 *
 * @param {string} [slow]  The label those two cases go to.
 * @param {number} [flags] @param {Width} [width]
 * @returns {(number[] | { jcc: number, to: string })[]}
 */
export const prologue = (slow = 'slow', flags = FLAG_SLOW_PATH, width = I386)=>[
    width.arg(ECX, 0),                                       // mov ecx, [esp+4]
    width.blockOf(ECX, ECX),                                 // mov ecx, [ecx+4]
    [0x85, 0xc9],                                            // test ecx, ecx
    { jcc: 0x74, to: slow },                                 // jz slow
    [0xf7, 0x01, ...dword(flags)],                           // test dword [ecx], flags
    { jcc: 0x75, to: slow },                                 // jnz slow
];

/**
 * Counts a routine's leaving for the host in a word of the device's block,
 * `base` a ModR/M register number: a locked increment, as routines on other
 * executors count into the same word.
 *
 *     lock inc dword [base+word]
 *
 * @param {number} base @param {number} word
 */
export const countLeft = (base, word)=>[0xf0, 0xff, 0x80 | base, ...dword(word)];

/** Each `takeHeld` its own label. */
let heldSites = 0;

/**
 * Takes the device's lock (`SHADOW.HELD`) with the device's block in `base`
 * (a ModR/M register number), or leaves for `busy` -- the host -- when it is
 * held: by the host, or a routine on another executor, counted (`LEFT_HELD`).
 *
 *     mov eax, HELD_GUEST
 *     xchg [base+HELD], eax
 *     test eax, eax
 *     jz got
 *     lock inc dword [base+LEFT_HELD]
 *     jmp busy
 *   got:
 *
 * @param {number} base @param {string} busy
 * @returns {(number[] | { jcc: number, to: string, near?: boolean } | { label: string })[]}
 */
export const takeHeld = (base, busy)=>{
    const got = `held${heldSites++}`;
    return [
        [0xb8, ...dword(HELD_GUEST)],                        // mov eax, HELD_GUEST
        [0x87, 0x80 | base, ...dword(SHADOW.HELD)],          // xchg [base+HELD], eax
        [0x85, 0xc0],                                        // test eax, eax
        { jcc: 0x74, to: got },                              // jz got
        countLeft(base, SHADOW.LEFT_HELD),                   // lock inc dword [base+LEFT_HELD]
        { jcc: 0xeb, to: busy, near: true },                 // jmp busy
        { label: got },
    ];
};


/**
 * Lets the device's lock go, the device's block in `base`, with a locked
 * instruction rather than a `mov`: on several executors it is an atomic store,
 * whose order the host's taking of the lock reads everything the routine wrote
 * under it after. A plain store gives no such order where the host reorders
 * stores (arm64): the host found the lock free and the record, the buffer's
 * block or the vertices the program wrote before the call not yet there.
 * Every site's next instructions read no flags.
 *
 *     lock and dword [base+HELD], 0
 *
 * @param {number} base
 */
export const letHeldGo = base=>[0xf0, 0x83, 0xa0 | base, ...dword(SHADOW.HELD), 0x00];

/** ModR/M register numbers. */
export const EAX = 0;
export const ECX = 1;
export const EDX = 2;
export const EBX = 3;

/** A getter's prologue: a block the ring may have made stale is the host's too. */
/** @param {Width} [width] */
export const getterPrologue = (width = I386)=>prologue('slow', FLAG_SLOW_PATH | FLAG_STALE, width);

/**
 * The prologue of a function rather than a method: the block is the calling
 * thread's, in its TEB where Windows keeps the thread's current OpenGL
 * context (`GlContext`), written by the host when a context is made current.
 *
 *     mov ecx, fs:[TEB_GL_CONTEXT]
 *     test ecx, ecx
 *     jz slow                     ; no context current: the host's
 *     test dword [ecx], 1
 *     jnz slow
 *
 * @param {string} [slow]
 * @returns {(number[] | { jcc: number, to: string })[]}
 */
export const threadPrologue = (slow = 'slow')=>[
    [0x64, 0x8b, 0x0d, ...dword(TEB_GL_CONTEXT)],            // mov ecx, fs:[disp]
    [0x85, 0xc9],                                            // test ecx, ecx
    { jcc: 0x74, to: slow },                                 // jz slow
    [0xf7, 0x01, ...dword(FLAG_SLOW_PATH)],                  // test dword [ecx], 1
    { jcc: 0x75, to: slow },                                 // jnz slow
];

/**
 * The prologue of a texture's AddDirtyRect or AddDirtyBox: the object's block
 * is the texture's (`TEXTURE`), which the rectangle or box must lie within,
 * not empty along any axis, as the device takes one; then the device's block,
 * whose ring the record goes into, is the routine's. None -- all of the
 * texture -- is the host's, and so is one the checks refuse, which the host
 * refuses. Unsigned compares refuse a negative edge with the rest.
 *
 *     mov ecx, [esp+4]
 *     mov ecx, [ecx+4]            ; the texture's block
 *     test ecx, ecx
 *     jz slow
 *     test dword [ecx], 1
 *     jnz slow
 *     mov eax, [esp+8]            ; the rectangle or box
 *     test eax, eax
 *     jz slow
 *     mov edx, [eax+8]            ; right
 *     cmp edx, [ecx+WIDTH]
 *     ja slow
 *     cmp [eax], edx              ; left
 *     jae slow
 *     (bottom and top against HEIGHT, [back and front against DEPTH])
 *     mov ecx, [ecx+DEVICE]
 *     test ecx, ecx
 *     jz slow
 *     test dword [ecx], 1
 *     jnz slow
 *
 * @param {'rect' | 'box'} kind @param {string} slow @param {Width} [width]
 * @returns {Part[]}
 */
export const dirtyPrologue = (kind, slow, width = I386)=>[
    ...prologue(slow, FLAG_SLOW_PATH, width),
    highAt(1, slow),                                         // (64 bits: below 4 GiB)
    argAt([0x8b], EAX, 1),                                   // mov eax, [esp+8]
    [0x85, 0xc0],                                            // test eax, eax
    { jcc: 0x74, to: slow },                                 // jz slow
    ...[[8, 0, TEXTURE.WIDTH], [12, 4, TEXTURE.HEIGHT],
        ...(kind === 'box' ? [[20, 16, TEXTURE.DEPTH]] : [])].flatMap(([far, near, extent])=>[
        [0x8b, 0x50, far],                                   // mov edx, [eax+far]
        [0x3b, 0x51, extent],                                // cmp edx, [ecx+extent]
        { jcc: 0x77, to: slow },                             // ja slow
        [0x39, 0x50, near],                                  // cmp [eax+near], edx
        { jcc: 0x73, to: slow },                             // jae slow
    ]),
    [0x8b, 0x49, TEXTURE.DEVICE],                            // mov ecx, [ecx+76]
    [0x85, 0xc9],                                            // test ecx, ecx
    { jcc: 0x74, to: slow },                                 // jz slow
    [0xf7, 0x01, ...dword(FLAG_SLOW_PATH)],                  // test dword [ecx], 1
    { jcc: 0x75, to: slow },                                 // jnz slow
];

/** Where a thread's block is in its TEB: the slot Windows keeps its GL context in. */
export const TEB_GL_CONTEXT = 0xbf0;

/**
 * A routine's bytes: its entry (`Width`), its body, then a jump for each of
 * `exits` -- a label the body branches to, and the address outside it the
 * label goes on to -- and last the jump to the trap its slow label lands on,
 * the argument registers put back first in a 64-bit process.
 *
 * @param {number} at @param {number} trap @param {Part[]} parts
 * @param {Record<string, number>} [exits]
 * @param {Width} [width]
 */
export const routine = (at, trap, parts, exits = {}, width = I386)=>{
    const names = Object.keys(exits);
    const reload = width.reload();
    const body = assemble([width.entry(), ...resolveParts(parts, width),
        ...names.flatMap(name=>[{ label: name }, [0xe9, 0, 0, 0, 0]]), { label: 'slow' }, reload]);
    names.forEach((name, i)=>{
        const from = body.length - reload.length - (names.length - i) * 5;
        body.set(jump(at + from, exits[name]), from);
    });
    return new Uint8Array([...body, ...jump(at + body.length, trap)]);
};

/**
 * The tail a routine answers an argument out of range with: the refusal the
 * interface documents, without a crossing to fetch it.
 *
 *   invalid:
 *     mov eax, D3DERR_INVALIDCALL
 *     ret n
 *
 * @param {number} popped  the bytes a 32-bit process's method pops @param {Width} [width]
 * @returns {(number[] | { label: string })[]}
 */
export const invalidTail = (popped, width = I386)=>[
    { label: 'invalid' },
    [0xb8, ...dword(D3DERR_INVALIDCALL)],                        // mov eax, D3DERR_INVALIDCALL
    width.ret(popped / 4),                                       // ret n
];

