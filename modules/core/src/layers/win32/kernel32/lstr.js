/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * lstrlenA, lstrlenW, lstrcpyA and lstrcpyW as guest code.
 *
 * What these add to strlen and strcpy is that a bad pointer answers 0 rather
 * than faulting: Windows runs them under an exception handler. The guest
 * cannot catch its own fault here, so a routine takes only pointers it can
 * read without one -- at or above the null region's 64 KiB and below the top
 * of RAM, a string that ends there and a copy that fits there -- and hands
 * every other call to the host's handler, which answers a pointer it cannot
 * read with 0. Memory below the top of RAM reads under every engine, and a
 * part no region maps reads as the zeroes nothing ever wrote there, which is
 * an empty string.
 */

import { assembleTo } from './code-arena.js';

/** The null region: Windows never maps the first 64 KiB. */
const LOWEST = 0x10000;

/** @param {number} value @returns {number[]} */
const dword = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

const JZ = [0x0f, 0x84];
const JB = [0x0f, 0x82];
const JA = [0x0f, 0x87];
const JAE = [0x0f, 0x83];
const JMP = [0xe9];

/** @typedef {import('./code-arena.js').Piece} Piece */

/**
 * `cmp reg, LOWEST; jb slow; cmp reg, top; jae slow` for EDX or ECX.
 *
 * @param {number} modrm  0xfa for EDX, 0xf9 for ECX
 * @param {number} top
 * @returns {Piece[]}
 */
const readable = (modrm, top)=>[
    [0x81, modrm, ...dword(LOWEST)], { jump: JB, to: 'slow' },
    [0x81, modrm, ...dword(top)], { jump: JAE, to: 'slow' },
];

/**
 * EAX from EDX to the string's terminator: `found` with EAX at it, or the
 * trap when the string runs to the top of RAM.
 *
 * @param {1 | 2} unit @param {number} top
 * @returns {Piece[]}
 */
const scan = (unit, top)=>[
    [0x89, 0xd0],                                            // mov eax, edx
    'scan',
    unit === 1 ? [0x80, 0x38, 0x00] : [0x66, 0x83, 0x38, 0x00], // cmp byte|word [eax], 0
    { jump: JZ, to: 'found' },
    unit === 1 ? [0x40] : [0x83, 0xc0, 0x02],                // inc eax | add eax, 2
    [0x3d, ...dword(top - (unit - 1))],                      // cmp eax, top
    { jump: JB, to: 'scan' },
    { jump: JMP, to: 'slow' },
    'found',
];

/**
 * int lstrlenA(LPCSTR) / int lstrlenW(LPCWSTR): 0 for a null pointer.
 *
 * @param {1 | 2} unit @param {number} at @param {number} trap @param {number} top
 */
export function lstrlenCode(unit, at, trap, top){
    return assembleTo([
        [0x8b, 0x54, 0x24, 0x04],                            // mov edx, [esp + 4]
        [0x85, 0xd2],                                        // test edx, edx
        { jump: JZ, to: 'zero' },
        ...readable(0xfa, top),
        ...scan(unit, top),
        [0x29, 0xd0],                                        // sub eax, edx
        ...unit === 2 ? [[0xd1, 0xe8]] : [],                 // shr eax, 1
        [0xc2, 0x04, 0x00],                                  // ret 4
        'zero',
        [0x31, 0xc0],                                        // xor eax, eax
        [0xc2, 0x04, 0x00],                                  // ret 4
    ], at, trap);
}

/**
 * LPSTR lstrcpyA(LPSTR, LPCSTR) / LPWSTR lstrcpyW(LPWSTR, LPCWSTR): the source
 * and its terminator, as if read whole first -- a destination inside the
 * source is copied from the end, as the handler, which reads before it
 * writes, leaves it.
 *
 * @param {1 | 2} unit @param {number} at @param {number} trap @param {number} top
 */
export function lstrcpyCode(unit, at, trap, top){
    return assembleTo([
        [0x8b, 0x4c, 0x24, 0x04],                            // mov ecx, [esp + 4]: to
        [0x8b, 0x54, 0x24, 0x08],                            // mov edx, [esp + 8]: from
        ...readable(0xf9, top),
        ...readable(0xfa, top),
        ...scan(unit, top),
        [0x29, 0xd0],                                        // sub eax, edx
        [0x83, 0xc0, unit],                                  // add eax, unit: the terminator
        [0x56, 0x57],                                        // push esi; push edi
        [0x8d, 0x3c, 0x01],                                  // lea edi, [ecx + eax]
        [0x81, 0xff, ...dword(top)],                         // cmp edi, top
        { jump: JA, to: 'restore' },
        [0x89, 0xd6],                                        // mov esi, edx
        [0x89, 0xcf],                                        // mov edi, ecx
        [0x89, 0xc1],                                        // mov ecx, eax
        [0x89, 0xf8],                                        // mov eax, edi
        [0x29, 0xf0],                                        // sub eax, esi
        [0x39, 0xc8],                                        // cmp eax, ecx
        { jump: JB, to: 'backward' },
        [0xf3, 0xa4],                                        // rep movsb
        { jump: JMP, to: 'done' },
        'backward',
        [0x8d, 0x74, 0x0e, 0xff],                            // lea esi, [esi + ecx - 1]
        [0x8d, 0x7c, 0x0f, 0xff],                            // lea edi, [edi + ecx - 1]
        [0xfd, 0xf3, 0xa4, 0xfc],                            // std; rep movsb; cld
        'done',
        [0x5f, 0x5e],                                        // pop edi; pop esi
        [0x8b, 0x44, 0x24, 0x04],                            // mov eax, [esp + 4]
        [0xc2, 0x08, 0x00],                                  // ret 8
        'restore',
        [0x5f, 0x5e],                                        // pop edi; pop esi
    ], at, trap);
}

/**
 * In a 64-bit process the pointer comes in RCX or RDX, and one with an upper
 * half is the host's too: `mov eax, reg; cmp rax, reg; jne slow`.
 *
 * @param {number} reg  0 for RCX, 2 for RDX
 * @returns {Piece[]}
 */
const below4G = reg=>[
    [0x89, 0xc0 | reg << 3],                                 // mov eax, ecx | edx
    [0x48, 0x39, 0xc0 | reg << 3],                           // cmp rax, rcx | rdx
    { jump: [0x0f, 0x85], to: 'slow' },
];

/**
 * lstrlenA and lstrlenW in a 64-bit process, as `lstrlenCode`: the string in
 * RCX, the trap's jump at the end for the loader to fill in.
 *
 * @param {1 | 2} unit @param {number} top
 */
export function lstrlenLongCode(unit, top){
    return assembleTo([
        [0x48, 0x85, 0xc9],                                  // test rcx, rcx
        { jump: JZ, to: 'zero' },
        ...below4G(1),
        ...readable(0xf9, top),
        [0x89, 0xc8],                                        // mov eax, ecx
        'scan',
        unit === 1 ? [0x80, 0x38, 0x00] : [0x66, 0x83, 0x38, 0x00], // cmp byte|word [rax], 0
        { jump: JZ, to: 'found' },
        unit === 1 ? [0xff, 0xc0] : [0x83, 0xc0, 0x02],      // inc eax | add eax, 2
        [0x3d, ...dword(top - (unit - 1))],                  // cmp eax, top
        { jump: JB, to: 'scan' },
        { jump: JMP, to: 'slow' },
        'found',
        [0x29, 0xc8],                                        // sub eax, ecx
        ...unit === 2 ? [[0xd1, 0xe8]] : [],                 // shr eax, 1
        [0xc3],                                              // ret
        'zero',
        [0x31, 0xc0],                                        // xor eax, eax
        [0xc3],                                              // ret
    ], 0, 0);
}

/**
 * lstrcpyA and lstrcpyW in a 64-bit process, as `lstrcpyCode`: the
 * destination in RCX and the source in RDX, each left as it came until the
 * copy is sure, RSI and RDI pushed only for it, the destination answered
 * from R8.
 *
 * @param {1 | 2} unit @param {number} top
 */
export function lstrcpyLongCode(unit, top){
    return assembleTo([
        ...below4G(1),
        ...below4G(2),
        ...readable(0xf9, top),
        ...readable(0xfa, top),
        [0x89, 0xd0],                                        // mov eax, edx
        'scan',
        unit === 1 ? [0x80, 0x38, 0x00] : [0x66, 0x83, 0x38, 0x00], // cmp byte|word [rax], 0
        { jump: JZ, to: 'found' },
        unit === 1 ? [0xff, 0xc0] : [0x83, 0xc0, 0x02],      // inc eax | add eax, 2
        [0x3d, ...dword(top - (unit - 1))],                  // cmp eax, top
        { jump: JB, to: 'scan' },
        { jump: JMP, to: 'slow' },
        'found',
        [0x29, 0xd0],                                        // sub eax, edx
        [0x83, 0xc0, unit],                                  // add eax, unit: the terminator
        [0x44, 0x8d, 0x0c, 0x01],                            // lea r9d, [rcx + rax]
        [0x41, 0x81, 0xf9, ...dword(top)],                   // cmp r9d, top
        { jump: JA, to: 'slow' },
        [0x56, 0x57],                                        // push rsi; push rdi
        [0x49, 0x89, 0xc8],                                  // mov r8, rcx
        [0x89, 0xd6],                                        // mov esi, edx
        [0x89, 0xcf],                                        // mov edi, ecx
        [0x89, 0xc1],                                        // mov ecx, eax
        [0x89, 0xf8],                                        // mov eax, edi
        [0x29, 0xf0],                                        // sub eax, esi
        [0x39, 0xc8],                                        // cmp eax, ecx
        { jump: JB, to: 'backward' },
        [0xf3, 0xa4],                                        // rep movsb
        { jump: JMP, to: 'done' },
        'backward',
        [0x8d, 0x74, 0x0e, 0xff],                            // lea esi, [rsi + rcx - 1]
        [0x8d, 0x7c, 0x0f, 0xff],                            // lea edi, [rdi + rcx - 1]
        [0xfd, 0xf3, 0xa4, 0xfc],                            // std; rep movsb; cld
        'done',
        [0x5f, 0x5e],                                        // pop rdi; pop rsi
        [0x4c, 0x89, 0xc0],                                  // mov rax, r8
        [0xc3],                                              // ret
    ], 0, 0);
}
