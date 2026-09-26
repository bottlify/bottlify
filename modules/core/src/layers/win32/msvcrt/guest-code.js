/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runtime functions that are code in the guest's own msvcrt rather than
 * handlers on the host: an export whose data is these bytes is called as any
 * function is, and the translator runs it with the program's own code. A
 * function that calls back into the program -- qsort's comparator -- then
 * makes an ordinary `call`, where a handler had to run the guest from the host
 * once a comparison.
 */

/**
 * A few instructions and the labels between them, assembled with every jump's
 * displacement filled in: each piece is bytes, a label, or a jump to one.
 *
 * @param {(number[] | string | { jump: number[], to: string, short?: boolean })[]} pieces
 * @returns {Uint8Array}
 */
export function assemble(pieces){
    /** @type {Map<string, number>} */
    const labels = new Map();
    let at = 0;
    for (const piece of pieces)
    {
        if (typeof piece === 'string')
        {
            labels.set(piece, at);
        }
        else if (Array.isArray(piece))
        {
            at += piece.length;
        }
        else
        {
            at += piece.jump.length + (piece.short ? 1 : 4);
        }
    }
    /** @type {number[]} */
    const out = [];
    for (const piece of pieces)
    {
        if (typeof piece === 'string')
        {
            continue;
        }
        if (Array.isArray(piece))
        {
            out.push(...piece);
            continue;
        }
        const target = labels.get(piece.to);
        if (target === undefined)
        {
            throw new Error(`assemble: no label ${piece.to}`);
        }
        out.push(...piece.jump);
        const rel = target - (out.length + (piece.short ? 1 : 4));
        if (piece.short)
        {
            if (rel < -128 || rel > 127)
            {
                throw new Error(`assemble: ${piece.to} is out of a short jump's reach`);
            }
            out.push(rel & 0xff);
        }
        else
        {
            out.push(rel & 0xff, rel >>> 8 & 0xff, rel >>> 16 & 0xff, rel >>> 24 & 0xff);
        }
    }
    return Uint8Array.from(out);
}

const JE = [0x0f, 0x84];
const JAE = [0x0f, 0x83];
const JB = [0x0f, 0x82];
const JLE = [0x0f, 0x8e];
const JMP = [0xe9];
const JNZ = [0x75];

/**
 * void qsort(void *base, size_t num, size_t width, int (*compare)(const void *, const void *))
 *
 * Shell's sort with the gaps halved, in place: the elements are swapped in
 * the program's memory as they move, so the comparator is always handed the
 * real addresses of the array as it stands. The order of equal elements is
 * not kept -- the standard promises none, and msvcrt's own sort keeps none.
 * cdecl, the arguments at [ebp+8..20]; the gap at [ebp-16] and the outer
 * index at [ebp-20]; esi the inner index, edi and ebx the two elements.
 */
export const QSORT_CODE = assemble([
    [0x55, 0x89, 0xe5, 0x53, 0x56, 0x57],       // push ebp; mov ebp, esp; push ebx, esi, edi
    [0x83, 0xec, 0x08],                         // sub esp, 8
    [0x83, 0x7d, 0x10, 0x00],                   // cmp dword [width], 0
    { jump: JE, to: 'done' },
    [0x8b, 0x45, 0x0c, 0xd1, 0xe8],             // mov eax, [num]; shr eax, 1
    [0x89, 0x45, 0xf0],                         // mov [gap], eax
    'outer',
    [0x83, 0x7d, 0xf0, 0x00],                   // cmp dword [gap], 0
    { jump: JE, to: 'done' },
    [0x8b, 0x45, 0xf0, 0x89, 0x45, 0xec],       // mov eax, [gap]; mov [i], eax
    'nextElement',
    [0x8b, 0x45, 0xec, 0x3b, 0x45, 0x0c],       // mov eax, [i]; cmp eax, [num]
    { jump: JAE, to: 'halve' },
    [0x89, 0xc6],                               // mov esi, eax
    'shift',
    [0x3b, 0x75, 0xf0],                         // cmp esi, [gap]
    { jump: JB, to: 'advance' },
    [0x89, 0xf0, 0x2b, 0x45, 0xf0],             // mov eax, esi; sub eax, [gap]
    [0x0f, 0xaf, 0x45, 0x10, 0x03, 0x45, 0x08], // imul eax, [width]; add eax, [base]
    [0x89, 0xc7],                               // mov edi, eax      ; element j - gap
    [0x89, 0xf0],                               // mov eax, esi
    [0x0f, 0xaf, 0x45, 0x10, 0x03, 0x45, 0x08], // imul eax, [width]; add eax, [base]
    [0x89, 0xc3],                               // mov ebx, eax      ; element j
    [0x53, 0x57, 0xff, 0x55, 0x14],             // push ebx; push edi; call [compare]
    [0x83, 0xc4, 0x08, 0x85, 0xc0],             // add esp, 8; test eax, eax
    { jump: JLE, to: 'advance' },
    [0x8b, 0x4d, 0x10],                         // mov ecx, [width]
    'swap',
    [0x8a, 0x07, 0x8a, 0x13, 0x88, 0x17, 0x88, 0x03], // mov al, [edi]; mov dl, [ebx]; swap them
    [0x47, 0x43, 0x49],                         // inc edi; inc ebx; dec ecx
    { jump: JNZ, to: 'swap', short: true },
    [0x2b, 0x75, 0xf0],                         // sub esi, [gap]
    { jump: JMP, to: 'shift' },
    'advance',
    [0xff, 0x45, 0xec],                         // inc dword [i]
    { jump: JMP, to: 'nextElement' },
    'halve',
    [0xd1, 0x6d, 0xf0],                         // shr dword [gap], 1
    { jump: JMP, to: 'outer' },
    'done',
    [0x83, 0xc4, 0x08, 0x5f, 0x5e, 0x5b, 0x5d, 0xc3], // add esp, 8; pop edi, esi, ebx, ebp; ret
]);
