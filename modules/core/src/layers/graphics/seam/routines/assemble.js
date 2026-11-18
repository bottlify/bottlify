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
 * @returns {(number[] | { jcc: number, to: string })[]}
 */
export const prologue = (slow = 'slow', flags = FLAG_SLOW_PATH)=>[
    [0x8b, 0x4c, 0x24, 0x04],                                // mov ecx, [esp+4]
    [0x8b, 0x49, 0x04],                                      // mov ecx, [ecx+4]
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
export const ECX = 1;
export const EDX = 2;
export const EBX = 3;

/** A getter's prologue: a block the ring may have made stale is the host's too. */
export const getterPrologue = ()=>prologue('slow', FLAG_SLOW_PATH | FLAG_STALE);

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
 * @param {'rect' | 'box'} kind @param {string} slow
 * @returns {(number[] | { jcc: number, to: string })[]}
 */
export const dirtyPrologue = (kind, slow)=>[
    ...prologue(slow),
    [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
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
 * A routine's bytes: its body, then a jump for each of `exits` -- a label the
 * body branches to, and the address outside it the label goes on to -- and
 * last the jump to the trap its slow label lands on.
 *
 * @param {number} at @param {number} trap
 * @param {(number[] | { label: string } | { jcc: number, to: string, near?: boolean })[]} parts
 * @param {Record<string, number>} [exits]
 */
export const routine = (at, trap, parts, exits = {})=>{
    const names = Object.keys(exits);
    const body = assemble([...parts,
        ...names.flatMap(name=>[{ label: name }, [0xe9, 0, 0, 0, 0]]), { label: 'slow' }]);
    names.forEach((name, i)=>{
        const from = body.length - (names.length - i) * 5;
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
 * @param {number} popped
 * @returns {(number[] | { label: string })[]}
 */
export const invalidTail = popped=>[
    { label: 'invalid' },
    [0xb8, ...dword(D3DERR_INVALIDCALL)],                        // mov eax, D3DERR_INVALIDCALL
    [0xc2, popped, 0x00],                                        // ret n
];

