/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The forms the atomic variant's judge draws from: every instruction x86
 * lets `lock` prefix, at each width it has, on memory at addresses aligned to
 * their width and not -- where a wasm atomic would trap and the access leaves
 * for the interpreter -- with the register and flag setters that make a
 * compare-and-exchange find what it expects and a carry go in. Test support
 * only; the sequences, the model and the translator are `sequences-judge.js`'s.
 */

import { DATA } from './sequences.js';

/** @param {number} address */
const disp32 = address=>[address & 0xff, address >>> 8 & 0xff,
    address >>> 16 & 0xff, address >>> 24 & 0xff];

const LOCK = 0xf0;
/** Where the forms reach, in the data area's patterned upper half: a qword's
 * start, a dword's, a word's, and two that are none of those. */
const AT = { q: DATA + 0x40, d: DATA + 0x44, w: DATA + 0x4a, odd: DATA + 0x4d, d8: DATA + 0x4c };

/**
 * A ModR/M memory form of `[disp32]` with `reg` in its middle field.
 * @param {number} reg
 */
const modrm = reg=>0x05 | (reg << 3);

/** @type {import('./sequences.js').Form[]} */
export const LOCKED_POOL = [
    // --- what the locked forms read: registers, memory, the carry ---
    { name: 'mov eax, [q]', bytes: [0xa1, ...disp32(AT.q)] },
    { name: 'mov edx, [q+4]', bytes: [0x8b, 0x15, ...disp32(AT.q + 4)] },
    { name: 'mov eax, [d]', bytes: [0xa1, ...disp32(AT.d)] },
    { name: 'mov ebx, 0x7fffffff', bytes: [0xbb, 0xff, 0xff, 0xff, 0x7f] },
    { name: 'mov ecx, 9', bytes: [0xb9, 9, 0, 0, 0] },
    { name: 'mov edx, 0x21', bytes: [0xba, 0x21, 0, 0, 0] },
    // The bit strings' offsets, in registers no locked form writes: from a
    // register a form loads with memory's pattern, the bit would lie outside
    // the judge's RAM.
    { name: 'mov esi, 77', bytes: [0xbe, 77, 0, 0, 0] },
    { name: 'mov edi, -45', bytes: [0xbf, 0xd3, 0xff, 0xff, 0xff] },
    { name: 'stc', bytes: [0xf9] },
    { name: 'clc', bytes: [0xf8] },
];

for (const [where, address] of Object.entries(AT))
{
    const at = disp32(address);
    LOCKED_POOL.push(
        { name: `lock add [${where}], eax`, bytes: [LOCK, 0x01, modrm(0), ...at] },
        { name: `lock add byte [${where}], cl`, bytes: [LOCK, 0x00, modrm(1), ...at] },
        { name: `lock add word [${where}], bx`, bytes: [0x66, LOCK, 0x01, modrm(3), ...at] },
        { name: `lock sub [${where}], ebx`, bytes: [LOCK, 0x29, modrm(3), ...at] },
        { name: `lock and [${where}], ecx`, bytes: [LOCK, 0x21, modrm(1), ...at] },
        { name: `lock or word [${where}], ax`, bytes: [0x66, LOCK, 0x09, modrm(0), ...at] },
        { name: `lock xor byte [${where}], dl`, bytes: [LOCK, 0x30, modrm(2), ...at] },
        { name: `lock adc [${where}], eax`, bytes: [LOCK, 0x11, modrm(0), ...at] },
        { name: `lock sbb word [${where}], cx`, bytes: [0x66, LOCK, 0x19, modrm(1), ...at] },
        { name: `lock add dword [${where}], -3`, bytes: [LOCK, 0x83, modrm(0), ...at, 0xfd] },
        { name: `lock inc dword [${where}]`, bytes: [LOCK, 0xff, modrm(0), ...at] },
        { name: `lock dec byte [${where}]`, bytes: [LOCK, 0xfe, modrm(1), ...at] },
        { name: `lock neg dword [${where}]`, bytes: [LOCK, 0xf7, modrm(3), ...at] },
        { name: `lock not word [${where}]`, bytes: [0x66, LOCK, 0xf7, modrm(2), ...at] },
        { name: `lock xadd [${where}], ebx`, bytes: [LOCK, 0x0f, 0xc1, modrm(3), ...at] },
        { name: `lock xadd byte [${where}], al`, bytes: [LOCK, 0x0f, 0xc0, modrm(0), ...at] },
        { name: `xchg [${where}], ecx`, bytes: [0x87, modrm(1), ...at] },
        { name: `xchg byte [${where}], bl`, bytes: [0x86, modrm(3), ...at] },
        { name: `lock cmpxchg [${where}], ebx`, bytes: [LOCK, 0x0f, 0xb1, modrm(3), ...at] },
        { name: `lock cmpxchg word [${where}], cx`,
            bytes: [0x66, LOCK, 0x0f, 0xb1, modrm(1), ...at] },
        { name: `lock cmpxchg8b [${where}]`, bytes: [LOCK, 0x0f, 0xc7, modrm(1), ...at] },
        { name: `lock bts dword [${where}], 5`, bytes: [LOCK, 0x0f, 0xba, modrm(5), ...at, 5] },
        { name: `lock btr [${where}], esi`, bytes: [LOCK, 0x0f, 0xb3, modrm(6), ...at] },
        { name: `lock btc word [${where}], di`,
            bytes: [0x66, LOCK, 0x0f, 0xbb, modrm(7), ...at] },
    );
}
