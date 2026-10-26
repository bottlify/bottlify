/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The heap's small blocks in a 64-bit process: the routines of
 * `guest-heap.js` in x86-64, over the same directory, records and control
 * blocks, which hold 32-bit addresses there too (every block of the arena
 * lies below 4 GiB).
 *
 * The arguments come in RCX, RDX, R8 and R9, and a call a routine does not
 * take is handed to the export's trap with them as they came: the 64-bit trap
 * reads them from those registers, so a routine works in RAX, R9 (where it is
 * no argument), R10 and R11, and what it does change of the four it puts back
 * before it hands over. A routine pushes RDI only to zero with `rep stos`.
 * Where the 32-bit routine took a quotient from `mul`'s EDX, which is an
 * argument here, a 64-bit `imul` and a shift give the same high half.
 *
 * A pointer or a handle is used as its low 32 bits, as the trap's handler is
 * handed it; a pointer a routine answers about is compared whole with the
 * cell it located, so one with an upper half is the host's. A size is
 * compared whole: SIZE_T is eight bytes.
 *
 * Each routine is `{ code, jump }`, the code ending with a `jmp rel32` to its
 * trap whose displacement, at `jump`, the loader fills in.
 */

import { assemble } from '../msvcrt/guest-code.js';
import { CACHE, CONTROL, HEAP_MAGIC, RECORD, SLAB_SHIFT, SMALL_LIMIT } from './guest-heap.js';

/** @typedef {import('./guest-heap.js').Placement} Placement */
/** @typedef {import('./code-arena.js').Piece} Piece */
/** @typedef {{ code: Uint8Array, jump: number }} LongRoutine */

/** @param {number} value @returns {number[]} */
const dword = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

const JZ = [0x0f, 0x84];
const JNZ = [0x0f, 0x85];
const JB = [0x0f, 0x82];
const JAE = [0x0f, 0x83];
const JBE = [0x0f, 0x86];
const JA = [0x0f, 0x87];

/** The flags HeapAlloc's own path takes, as at 32 bits. */
const ALLOC_FLAGS = 0x1 | 0x4 | 0x8;
/** And HeapReAlloc's. */
const REALLOC_FLAGS = ALLOC_FLAGS | 0x10;

/** `lock and dword [r10], 0`: the control block's lock given back. */
const UNLOCK = [0xf0, 0x41, 0x83, 0x22, 0x00];

/**
 * The pieces, ending at `slow` with the jump to the trap.
 *
 * @param {Piece[]} pieces
 * @returns {LongRoutine}
 */
function assembleLong(pieces){
    const code = assemble([...pieces, 'slow', [0xe9, 0, 0, 0, 0]]);
    return { code, jump: code.length - 4 };
}

/**
 * The pointer in R8 located: R9 its slab's record, R11 its cell's index --
 * or `bad` for anything that is not the start of a cell. RAX is changed.
 *
 * @param {Placement} p
 * @returns {Piece[]}
 */
function locate(p){
    return [
        [0x44, 0x89, 0xc0],                                  // mov eax, r8d
        [0x44, 0x8d, 0x88, ...dword(-p.dirBase)],            // lea r9d, [rax - dirBase]
        [0x41, 0x81, 0xf9, ...dword(p.dirSpan)],             // cmp r9d, dirSpan
        { jump: JAE, to: 'bad' },
        [0x41, 0xc1, 0xe9, SLAB_SHIFT],                      // shr r9d, 14
        [0x46, 0x8b, 0x0c, 0x8d, ...dword(p.directory)],     // mov r9d, [directory + r9*4]
        [0x45, 0x85, 0xc9],                                  // test r9d, r9d
        { jump: JZ, to: 'bad' },
        [0x41, 0x2b, 0x41, RECORD.BASE],                     // sub eax, [r9 + base]
        [0x45, 0x8b, 0x59, RECORD.RECIPROCAL],               // mov r11d, [r9 + reciprocal]
        [0x4c, 0x0f, 0xaf, 0xd8],                            // imul r11, rax
        [0x49, 0xc1, 0xeb, 0x20],                            // shr r11, 32: the index
        [0x45, 0x3b, 0x59, RECORD.CELLS],                    // cmp r11d, [r9 + cells]
        { jump: JAE, to: 'bad' },
        [0x44, 0x89, 0xd8],                                  // mov eax, r11d
        [0x41, 0x0f, 0xaf, 0x41, RECORD.CELL],               // imul eax, [r9 + cell]
        [0x41, 0x03, 0x41, RECORD.BASE],                     // add eax, [r9 + base]
        [0x4c, 0x39, 0xc0],                                  // cmp rax, r8: whole
        { jump: JNZ, to: 'bad' },
    ];
}

/**
 * Allocation, R10 the control block and R8 the size (at most SMALL_LIMIT):
 * a cell off its class's cache under the heap's lock, its word written,
 * zeroed as `zero` says; to the trap when the lock is taken or the cache is
 * empty. RCX and RDX are not changed on the way there.
 *
 * @param {Placement} p
 * @param {number[] | 'always' | 'never'} zero  An instruction that leaves ZF
 *     clear when the block is to be zeroed, or always, or never.
 * @returns {Piece[]}
 */
function allocBody(p, zero){
    return [
        [0x45, 0x8d, 0x48, 0x07],                            // lea r9d, [r8 + 7]
        [0x41, 0xc1, 0xe9, 0x03],                            // shr r9d, 3
        [0x41, 0x0f, 0xb6, 0x81, ...dword(p.classMap)],      // movzx eax, byte [classMap + r9]
        [0xc1, 0xe0, CONTROL.CLASS_SHIFT],                   // shl eax, 10
        [0x41, 0x8d, 0x44, 0x02, CONTROL.CLASSES],           // lea eax, [r10 + rax + classes]
        [0x41, 0xb9, ...dword(1)],                           // mov r9d, 1
        [0x45, 0x87, 0x0a],                                  // xchg [r10], r9d: the lock
        [0x45, 0x85, 0xc9],                                  // test r9d, r9d
        { jump: JNZ, to: 'slow' },
        [0x44, 0x8b, 0x08],                                  // mov r9d, [rax]: the count
        [0x41, 0x83, 0xe9, 0x01],                            // sub r9d, 1
        { jump: JB, to: 'empty' },
        [0x44, 0x89, 0x08],                                  // mov [rax], r9d
        [0x46, 0x8d, 0x5c, 0xc8, CONTROL.ENTRIES],           // lea r11d, [rax + r9*8 + entries]
        [0x41, 0x8b, 0x03],                                  // mov eax, [r11]: the cell
        [0x45, 0x8b, 0x5b, 0x04],                            // mov r11d, [r11 + 4]: its word's
        [0x45, 0x8d, 0x48, 0x01],                            // lea r9d, [r8 + 1]
        [0x66, 0x45, 0x89, 0x0b],                            // mov [r11], r9w
        UNLOCK,
        ...zero === 'always' ? [{ jump: [0xe9], to: 'zero' }]
            : zero === 'never' ? [] : [zero, { jump: JNZ, to: 'zero' }],
        [0xc3],                                              // ret
        ...zero === 'never' ? [] : [
            'zero',
            [0x57],                                          // push rdi
            [0x48, 0x89, 0xc7],                              // mov rdi, rax
            [0x49, 0x89, 0xc1],                              // mov r9, rax
            [0x41, 0x8d, 0x48, 0x03],                        // lea ecx, [r8 + 3]
            [0xc1, 0xe9, 0x02],                              // shr ecx, 2
            [0x31, 0xc0],                                    // xor eax, eax
            [0xf3, 0xab],                                    // rep stosd
            [0x4c, 0x89, 0xc8],                              // mov rax, r9
            [0x5f],                                          // pop rdi
            [0xc3],                                          // ret
        ],
        'empty',
        UNLOCK,
    ];
}

/**
 * LPVOID HeapAlloc(HANDLE hHeap, DWORD dwFlags, SIZE_T dwBytes): the heap in
 * RCX taken when its block lies in the arena and says it is a heap.
 *
 * @param {Placement} p
 * @returns {LongRoutine}
 */
export function heapAllocLongCode(p){
    return assembleLong([
        [0xf7, 0xc2, ...dword(~ALLOC_FLAGS)],                // test edx, ~flags
        { jump: JNZ, to: 'slow' },
        [0x49, 0x81, 0xf8, ...dword(SMALL_LIMIT)],           // cmp r8, 1024
        { jump: JA, to: 'slow' },
        [0x41, 0x89, 0xca],                                  // mov r10d, ecx
        [0x41, 0x8d, 0x82, ...dword(-p.dirBase)],            // lea eax, [r10 - dirBase]
        [0x3d, ...dword(p.dirSpan - CONTROL.SIZE)],          // cmp eax, dirSpan - control
        { jump: JA, to: 'slow' },
        [0x41, 0x81, 0x7a, CONTROL.MAGIC, ...dword(HEAP_MAGIC)], // cmp dword [r10 + 4], 'HEAP'
        { jump: JNZ, to: 'slow' },
        ...allocBody(p, [0xf6, 0xc2, 0x08]),                 // test dl, HEAP_ZERO_MEMORY
    ]);
}

/**
 * void *malloc(size_t size) on a heap known when it is placed.
 *
 * @param {Placement} p @param {number} heap
 * @returns {LongRoutine}
 */
export function mallocLongCode(p, heap){
    return assembleLong([
        [0x48, 0x81, 0xf9, ...dword(SMALL_LIMIT)],           // cmp rcx, 1024
        { jump: JA, to: 'slow' },
        [0x49, 0x89, 0xc8],                                  // mov r8, rcx
        [0x41, 0xba, ...dword(heap)],                        // mov r10d, heap
        ...allocBody(p, 'never'),
    ]);
}

/**
 * void *calloc(size_t count, size_t size): both under 2^32, so that the
 * product is whole in 64 bits, and the product at most a kilobyte; zeroed.
 *
 * @param {Placement} p @param {number} heap
 * @returns {LongRoutine}
 */
export function callocLongCode(p, heap){
    return assembleLong([
        [0x48, 0x89, 0xc8],                                  // mov rax, rcx
        [0x48, 0x09, 0xd0],                                  // or rax, rdx
        [0x48, 0xc1, 0xe8, 0x20],                            // shr rax, 32
        { jump: JNZ, to: 'slow' },
        [0x49, 0x89, 0xc8],                                  // mov r8, rcx
        [0x4c, 0x0f, 0xaf, 0xc2],                            // imul r8, rdx
        [0x49, 0x81, 0xf8, ...dword(SMALL_LIMIT)],           // cmp r8, 1024
        { jump: JA, to: 'slow' },
        [0x41, 0xba, ...dword(heap)],                        // mov r10d, heap
        ...allocBody(p, 'always'),
    ]);
}

/**
 * The cell located (R9 its record, R11 its index, R8 the pointer) given back
 * under its heap's lock, R10 the heap: its word cleared and it pushed onto
 * its class's cache. A cell already free, a cache already full, and a lock
 * another thread holds are the host's.
 *
 * @param {number | null} answer  What the caller is told, or nothing.
 * @returns {Piece[]}
 */
function freeBody(answer){
    return [
        [0x47, 0x8d, 0x5c, 0x59, RECORD.SIZES],              // lea r11d, [r9 + r11*2 + sizes]
        [0xb8, ...dword(1)],                                 // mov eax, 1
        [0x41, 0x87, 0x02],                                  // xchg [r10], eax: the lock
        [0x85, 0xc0],                                        // test eax, eax
        { jump: JNZ, to: 'bad' },
        [0x66, 0x41, 0x83, 0x3b, 0x00],                      // cmp word [r11], 0
        { jump: JZ, to: 'unlock' },
        [0x41, 0x0f, 0xb6, 0x41, RECORD.CLASS],              // movzx eax, byte [r9 + class]
        [0xc1, 0xe0, CONTROL.CLASS_SHIFT],                   // shl eax, 10
        [0x41, 0x8d, 0x44, 0x02, CONTROL.CLASSES],           // lea eax, [r10 + rax + classes]
        [0x44, 0x8b, 0x08],                                  // mov r9d, [rax]: the count
        [0x41, 0x83, 0xf9, CACHE],                           // cmp r9d, 127
        { jump: JAE, to: 'unlock' },
        [0x66, 0x41, 0xc7, 0x03, 0x00, 0x00],                // mov word [r11], 0
        [0x46, 0x89, 0x44, 0xc8, CONTROL.ENTRIES],           // mov [rax + r9*8 + 8], r8d
        [0x46, 0x89, 0x5c, 0xc8, CONTROL.ENTRIES + 4],       // mov [rax + r9*8 + 12], r11d
        [0x41, 0xff, 0xc1],                                  // inc r9d
        [0x44, 0x89, 0x08],                                  // mov [rax], r9d
        UNLOCK,
        'done',
        ...answer === null ? [] : answer === 0 ? [[0x31, 0xc0]] // xor eax, eax
            : [[0xb8, ...dword(answer)]],                    // mov eax, answer
        [0xc3],                                              // ret
        'unlock',
        UNLOCK,
        'bad',
    ];
}

/**
 * BOOL HeapFree(HANDLE hHeap, DWORD dwFlags, LPVOID lpMem): a null pointer
 * is TRUE, a cell of this heap is taken back, anything else is the host's.
 *
 * @param {Placement} p
 * @returns {LongRoutine}
 */
export function heapFreeLongCode(p){
    return assembleLong([
        [0x4d, 0x85, 0xc0],                                  // test r8, r8
        { jump: JZ, to: 'done' },
        ...locate(p),
        [0x45, 0x8b, 0x11],                                  // mov r10d, [r9 + heap]
        [0x41, 0x39, 0xca],                                  // cmp r10d, ecx: the heap
        { jump: JNZ, to: 'bad' },
        ...freeBody(1),
    ]);
}

/**
 * void free(void *block): a cell of any heap.
 *
 * @param {Placement} p
 * @returns {LongRoutine}
 */
export function freeLongCode(p){
    return assembleLong([
        [0x48, 0x85, 0xc9],                                  // test rcx, rcx
        { jump: JZ, to: 'done' },
        [0x49, 0x89, 0xc8],                                  // mov r8, rcx
        ...locate(p),
        [0x45, 0x8b, 0x11],                                  // mov r10d, [r9 + heap]
        ...freeBody(null),
    ]);
}

/**
 * The size of the live cell located, in RAX; a free one is the host's.
 *
 * @returns {Piece[]}
 */
function sizeBody(){
    return [
        [0x43, 0x0f, 0xb7, 0x44, 0x59, RECORD.SIZES],        // movzx eax, word [r9+r11*2+sizes]
        [0x85, 0xc0],                                        // test eax, eax
        { jump: JZ, to: 'bad' },
        [0xff, 0xc8],                                        // dec eax
        [0xc3],                                              // ret
        'bad',
    ];
}

/**
 * SIZE_T HeapSize(HANDLE hHeap, DWORD dwFlags, LPCVOID lpMem).
 *
 * @param {Placement} p
 * @returns {LongRoutine}
 */
export function heapSizeLongCode(p){
    return assembleLong([
        ...locate(p),
        [0x41, 0x39, 0x09],                                  // cmp [r9 + heap], ecx
        { jump: JNZ, to: 'bad' },
        ...sizeBody(),
    ]);
}

/**
 * size_t _msize(void *block): a cell of any heap.
 *
 * @param {Placement} p
 * @returns {LongRoutine}
 */
export function msizeLongCode(p){
    return assembleLong([
        [0x49, 0x89, 0xc8],                                  // mov r8, rcx
        ...locate(p),
        ...sizeBody(),
    ]);
}

/**
 * A live cell located (R9, R11, R8), resized in place to the size in R10
 * when that fits its cell: its word rewritten, and with `zero` the bytes it
 * gains zeroed when the flags in EDX have HEAP_ZERO_MEMORY. Answers the
 * pointer; R10 is not changed.
 *
 * @param {boolean} zero
 * @returns {Piece[]}
 */
function resizeBody(zero){
    return [
        [0x49, 0x81, 0xfa, ...dword(SMALL_LIMIT)],           // cmp r10, 1024
        { jump: JA, to: 'bad' },
        [0x45, 0x3b, 0x51, RECORD.CELL],                     // cmp r10d, [r9 + cell]
        { jump: JA, to: 'bad' },
        [0x47, 0x8d, 0x5c, 0x59, RECORD.SIZES],              // lea r11d, [r9 + r11*2 + sizes]
        [0x41, 0x0f, 0xb7, 0x03],                            // movzx eax, word [r11]
        [0x85, 0xc0],                                        // test eax, eax
        { jump: JZ, to: 'bad' },
        [0x44, 0x8d, 0x48, 0xff],                            // lea r9d, [rax - 1]: the old size
        [0x41, 0x8d, 0x42, 0x01],                            // lea eax, [r10 + 1]: the new word
        [0x66, 0x41, 0x89, 0x03],                            // mov [r11], ax
        ...zero ? [
            [0xf6, 0xc2, 0x08],                              // test dl, HEAP_ZERO_MEMORY
            { jump: JZ, to: 'resized' },
            [0x45, 0x39, 0xca],                              // cmp r10d, r9d
            { jump: JBE, to: 'resized' },
            [0x57],                                          // push rdi
            [0x44, 0x89, 0xd1],                              // mov ecx, r10d
            [0x44, 0x29, 0xc9],                              // sub ecx, r9d: what it gained
            [0x43, 0x8d, 0x3c, 0x08],                        // lea edi, [r8 + r9]: the old end
            [0x31, 0xc0],                                    // xor eax, eax
            [0xf3, 0xaa],                                    // rep stosb
            [0x5f],                                          // pop rdi
        ] : [],
        'resized',
        [0x4c, 0x89, 0xc0],                                  // mov rax, r8
        [0xc3],                                              // ret
        'bad',
    ];
}

/**
 * LPVOID HeapReAlloc(HANDLE hHeap, DWORD dwFlags, LPVOID lpMem, SIZE_T dwBytes):
 * a size that fits the block's cell answered in place; the size kept in R10
 * while R9 locates, and given back to R9 before a hand-over.
 *
 * @param {Placement} p
 * @returns {LongRoutine}
 */
export function heapReAllocLongCode(p){
    return assembleLong([
        [0x4d, 0x89, 0xca],                                  // mov r10, r9: the size
        [0xf7, 0xc2, ...dword(~REALLOC_FLAGS)],              // test edx, ~flags
        { jump: JNZ, to: 'bad' },
        ...locate(p),
        [0x41, 0x39, 0x09],                                  // cmp [r9 + heap], ecx
        { jump: JNZ, to: 'bad' },
        ...resizeBody(true),
        [0x4d, 0x89, 0xd1],                                  // mov r9, r10
    ]);
}

/**
 * void *realloc(void *block, size_t size): in place when the size fits the
 * block's cell; a null block, a size of zero and a move are the host's.
 *
 * @param {Placement} p
 * @returns {LongRoutine}
 */
export function reallocLongCode(p){
    return assembleLong([
        [0x48, 0x85, 0xc9],                                  // test rcx, rcx
        { jump: JZ, to: 'slow' },
        [0x48, 0x85, 0xd2],                                  // test rdx, rdx
        { jump: JZ, to: 'slow' },
        [0x49, 0x89, 0xc8],                                  // mov r8, rcx
        [0x49, 0x89, 0xd2],                                  // mov r10, rdx
        ...locate(p),
        ...resizeBody(false),
    ]);
}

/**
 * HGLOBAL GlobalAlloc(UINT uFlags, SIZE_T dwBytes): HeapAlloc's routine on
 * the process heap, GMEM_ZEROINIT zeroing; a request for no bytes, which the
 * host answers with a block of one, is the host's.
 *
 * @param {Placement} p @param {number} heap
 * @returns {LongRoutine}
 */
export function globalAllocLongCode(p, heap){
    return assembleLong([
        [0x48, 0x85, 0xd2],                                  // test rdx, rdx
        { jump: JZ, to: 'slow' },
        [0x48, 0x81, 0xfa, ...dword(SMALL_LIMIT)],           // cmp rdx, 1024
        { jump: JA, to: 'slow' },
        [0x49, 0x89, 0xd0],                                  // mov r8, rdx
        [0x41, 0xba, ...dword(heap)],                        // mov r10d, heap
        ...allocBody(p, [0xf6, 0xc1, 0x40]),                 // test cl, GMEM_ZEROINIT
    ]);
}

/**
 * HGLOBAL GlobalFree(HGLOBAL hMem): NULL for a cell of the process heap
 * taken back, and for NULL; anything else goes to the host's GlobalFree.
 *
 * @param {Placement} p @param {number} heap
 * @returns {LongRoutine}
 */
export function globalFreeLongCode(p, heap){
    return assembleLong([
        [0x48, 0x85, 0xc9],                                  // test rcx, rcx
        { jump: JZ, to: 'done' },
        [0x49, 0x89, 0xc8],                                  // mov r8, rcx
        ...locate(p),
        [0x45, 0x8b, 0x11],                                  // mov r10d, [r9 + heap]
        [0x41, 0x81, 0xfa, ...dword(heap)],                  // cmp r10d, heap
        { jump: JNZ, to: 'bad' },
        ...freeBody(0),
    ]);
}

/** @typedef {{ register: (trap: any) => number, jump: (at: number, target: number) => void }} LongBuilder */

/**
 * A routine handed to the loader's builder, its jump to the trap registered:
 * or, given none (an arena with no room for the guest's tables, a heap that
 * is not the guest's), the trap alone.
 *
 * @param {LongBuilder} builder @param {LongRoutine | null} routine
 * @param {{ argBytes: number, handler: Function, convention?: string }} trap
 * @returns {Uint8Array}
 */
export function bindLong(builder, routine, trap){
    const { code, jump } = routine ?? { code: Uint8Array.of(0xe9, 0, 0, 0, 0), jump: 1 };
    builder.jump(jump, builder.register(trap));
    return code;
}
