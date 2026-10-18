/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The forms the ordered variant's judge draws from: plain integer loads,
 * stores and read-modify-writes at each width, on memory at addresses aligned
 * to their width and not -- where the ordered variant's atomic access would
 * trap and it stays plain -- through a displacement, through a base register,
 * and through esp, which it leaves plain. Test support only; the sequences, the
 * model and the translator are `sequences-judge.js`'s.
 */

import { DATA } from './sequences.js';

/** @param {number} address */
const disp32 = address=>[address & 0xff, address >>> 8 & 0xff,
    address >>> 16 & 0xff, address >>> 24 & 0xff];

/** Where the forms reach: a dword's start, a word's, and two that are neither. */
const AT = { d: DATA + 0x44, w: DATA + 0x4a, odd: DATA + 0x4d, d8: DATA + 0x4c, q2: DATA + 0x42 };

/** `mov esi, data+0x40`: a base register into the data. */
const ESI = [0xbe, ...disp32(DATA + 0x40)];

/** A ModR/M memory form of `[disp32]` with `reg` in its middle field. @param {number} reg */
const modrm = reg=>0x05 | (reg << 3);

/** @type {import('./sequences.js').Form[]} */
export const ORDERED_POOL = [
    { name: 'mov eax, 0x80010203', bytes: [0xb8, 0x03, 0x02, 0x01, 0x80] },
    { name: 'mov ebx, 0x7fffffff', bytes: [0xbb, 0xff, 0xff, 0xff, 0x7f] },
    { name: 'mov ecx, 9', bytes: [0xb9, 9, 0, 0, 0] },
    // Through a base register into the data, set in the same form: the judge
    // restores the data alone, and a register a sequence left could point anywhere.
    { name: 'mov [esi+4], eax (esi the data)', bytes: [...ESI, 0x89, 0x46, 0x04] },
    { name: 'mov [esi+0xd], ecx (esi the data)', bytes: [...ESI, 0x89, 0x4e, 0x0d] },
    { name: 'mov dx, [esi+0xa] (esi the data)', bytes: [...ESI, 0x66, 0x8b, 0x56, 0x0a] },
    { name: 'add [esi+8], ebx (esi the data)', bytes: [...ESI, 0x01, 0x5e, 0x08] },
    // Through esp, a thread's own stack, left plain: written before it is read,
    // since the judge does not restore the stack.
    { name: 'mov [esp-8], eax; mov edi, [esp-8]',
        bytes: [0x89, 0x44, 0x24, 0xf8, 0x8b, 0x7c, 0x24, 0xf8] },
    { name: 'mov [esp-8], ebx; add [esp-6], cx; movzx edx, word [esp-6]',
        bytes: [0x89, 0x5c, 0x24, 0xf8, 0x66, 0x01, 0x4c, 0x24, 0xfa, 0x0f, 0xb7, 0x54, 0x24,
            0xfa] },
];

for (const [where, address] of Object.entries(AT))
{
    const at = disp32(address);
    ORDERED_POOL.push(
        { name: `mov [${where}], eax`, bytes: [0x89, modrm(0), ...at] },
        { name: `mov word [${where}], bx`, bytes: [0x66, 0x89, modrm(3), ...at] },
        { name: `mov byte [${where}], cl`, bytes: [0x88, modrm(1), ...at] },
        { name: `mov dword [${where}], 0x5a5aa5a5`,
            bytes: [0xc7, modrm(0), ...at, 0xa5, 0xa5, 0x5a, 0x5a] },
        { name: `mov edx, [${where}]`, bytes: [0x8b, modrm(2), ...at] },
        { name: `movzx eax, word [${where}]`, bytes: [0x0f, 0xb7, modrm(0), ...at] },
        { name: `movsx ecx, byte [${where}]`, bytes: [0x0f, 0xbe, modrm(1), ...at] },
        { name: `add [${where}], ecx`, bytes: [0x01, modrm(1), ...at] },
        { name: `sub word [${where}], 3`, bytes: [0x66, 0x83, modrm(5), ...at, 3] },
        { name: `inc dword [${where}]`, bytes: [0xff, modrm(0), ...at] },
        { name: `cmp [${where}], eax`, bytes: [0x39, modrm(0), ...at] },
        { name: `test byte [${where}], 0x81`, bytes: [0xf6, modrm(0), ...at, 0x81] },
        { name: `xadd [${where}], ebx`, bytes: [0x0f, 0xc1, modrm(3), ...at] },
        { name: `cmpxchg [${where}], ecx`, bytes: [0x0f, 0xb1, modrm(1), ...at] },
    );
}
