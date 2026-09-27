/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GLU32 exports that are more than one computation: a frame on the stack
 * for what the arithmetic (`inguest.js`, compiled) writes, a call into it,
 * and then OPENGL32's own entry points with what it wrote -- the calls GLU
 * makes on Windows, through the addresses OPENGL32's exports are placed at.
 *
 * Each routine is stdcall, as GLU32's exports are, and keeps what a callee
 * owes its caller: EBX, ESI, EDI and EBP go through the compiled code and the
 * GL calls untouched, and the frame is gone by the `ret`. The compiled
 * function a routine calls is placed right after it, and reached with a
 * relative call, so the bytes do not depend on where they land.
 *
 * Every routine copies its own arguments onto the stack for the call it
 * makes. The copy is a run of `push dword [esp + d]` with one displacement:
 * each push moves ESP down a word as the next argument wanted is a word
 * lower, so the same `d` reads them all, last first.
 */

import { assemble } from '../../win32/msvcrt/guest-code.js';
import { COMPILED } from './inguest.x86.js';

/** @param {number} value */
const dword = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** A double's high word: 1.0 and -1.0 have nothing in their low one. */
const ONE_HIGH = 0x3ff00000;
const MINUS_ONE_HIGH = 0xbff00000;

/**
 * `push dword [esp + at]`, `count` times.
 *
 * @param {number} at @param {number} count @returns {number[]}
 */
const pushes = (at, count)=>{
    const one = at < 0x80 ? [0xff, 0x74, 0x24, at] : [0xff, 0xb4, 0x24, ...dword(at)];
    return Array.from({ length: count }, ()=>one).flat();
};

/** `sub esp, n` / `add esp, n` @param {number} n */
const reserve = n=>[0x81, 0xec, ...dword(n)];
const release = (/** @type {number} */ n)=>[0x81, 0xc4, ...dword(n)];
/** `lea eax, [esp + n]; push eax`: a pointer to the frame. @param {number} n */
const pushFrame = n=>[0x8d, 0x44, 0x24, n, 0x50];
/** `mov eax, target; call eax` @param {number} target */
const callAt = target=>[0xb8, ...dword(target), 0xff, 0xd0];
/** `ret n` @param {number} n */
const ret = n=>[0xc2, n & 0xff, n >>> 8];
/** `call helper`, to the compiled function after the routine. */
const callHelper = { jump: [0xe8], to: 'helper' };
/** `test eax, eax; jz done` */
const unlessZero = (/** @type {string} */ to)=>[[0x85, 0xc0], { jump: [0x74], to, short: true }];

/**
 * The routine's bytes with the compiled function it calls after them.
 *
 * @param {(number[] | string | { jump: number[], to: string, short?: boolean })[]} body
 * @param {keyof typeof COMPILED} [helper]
 */
const withHelper = (body, helper)=>assemble([
    ...body,
    ...helper ? ['helper', [...COMPILED[helper].code]] : [],
]);

/**
 * The entry points of OPENGL32 a routine calls, by name.
 *
 * @typedef {Record<'glMultMatrixd' | 'glTranslated' | 'glScaled' | 'glOrtho', number>} GlEntries
 */

/**
 * void gluPerspective(GLdouble fovy, GLdouble aspect, GLdouble zNear, GLdouble zFar)
 *
 *     sub esp, 128                  ; the matrix
 *     push dword [esp+160] x8       ; the four doubles
 *     lea eax, [esp+32]
 *     push eax
 *     call gluPerspectiveMatrix
 *     test eax, eax
 *     jz done                       ; no projection: the matrix stays
 *     mov eax, esp                  ; the matrix
 *     push eax
 *     mov eax, glMultMatrixd
 *     call eax
 *   done:
 *     add esp, 128
 *     ret 32
 *
 * @param {GlEntries} gl
 */
export const perspectiveCode = gl=>withHelper([
    reserve(128),
    pushes(128 + 4 + 28, 8),
    pushFrame(32),
    callHelper,
    ...unlessZero('done'),
    [0x89, 0xe0, 0x50],
    callAt(gl.glMultMatrixd),
    'done',
    release(128),
    ret(32),
], 'gluPerspectiveMatrix');

/**
 * void gluLookAt(GLdouble eyeX, eyeY, eyeZ, centerX, centerY, centerZ, upX, upY, upZ)
 *
 *     sub esp, 152                  ; the matrix, then the eye negated
 *     push dword [esp+224] x18
 *     lea eax, [esp+72]
 *     push eax
 *     call gluLookAtMatrix
 *     mov eax, esp
 *     push eax
 *     mov eax, glMultMatrixd
 *     call eax
 *     push dword [esp+148] x6       ; the negated eye
 *     mov eax, glTranslated
 *     call eax
 *     add esp, 152
 *     ret 72
 *
 * @param {GlEntries} gl
 */
export const lookAtCode = gl=>withHelper([
    reserve(152),
    pushes(152 + 4 + 68, 18),
    pushFrame(72),
    callHelper,
    [0x89, 0xe0, 0x50],
    callAt(gl.glMultMatrixd),
    pushes(128 + 20, 6),
    callAt(gl.glTranslated),
    release(152),
    ret(72),
], 'gluLookAtMatrix');

/**
 * void gluOrtho2D(GLdouble left, GLdouble right, GLdouble bottom, GLdouble top):
 * glOrtho with a depth range of [-1, 1].
 *
 *     push 0x3ff00000               ; zFar, 1.0
 *     push 0
 *     push 0xbff00000               ; zNear, -1.0
 *     push 0
 *     push dword [esp+48] x8        ; top .. left
 *     mov eax, glOrtho
 *     call eax
 *     ret 32
 *
 * @param {GlEntries} gl
 */
export const ortho2DCode = gl=>withHelper([
    [0x68, ...dword(ONE_HIGH), 0x6a, 0x00, 0x68, ...dword(MINUS_ONE_HIGH), 0x6a, 0x00],
    pushes(4 + 16 + 28, 8),
    callAt(gl.glOrtho),
    ret(32),
]);

/**
 * void gluPickMatrix(GLdouble x, GLdouble y, GLdouble delX, GLdouble delY, GLint *viewport)
 *
 *     sub esp, 48                   ; the translation, then the scale
 *     push dword [esp+84] x9
 *     lea eax, [esp+36]
 *     push eax
 *     call gluPickMatrixArgs
 *     test eax, eax
 *     jz done                       ; a region of no size
 *     push dword [esp+20] x6
 *     mov eax, glTranslated
 *     call eax
 *     push dword [esp+44] x6
 *     mov eax, glScaled
 *     call eax
 *   done:
 *     add esp, 48
 *     ret 36
 *
 * @param {GlEntries} gl
 */
export const pickMatrixCode = gl=>withHelper([
    reserve(48),
    pushes(48 + 4 + 32, 9),
    pushFrame(36),
    callHelper,
    ...unlessZero('done'),
    pushes(20, 6),
    callAt(gl.glTranslated),
    pushes(24 + 20, 6),
    callAt(gl.glScaled),
    'done',
    release(48),
    ret(36),
], 'gluPickMatrixArgs');

/**
 * GLint gluUnProject(GLdouble winX, winY, winZ, const GLdouble *model,
 *     const GLdouble *proj, const GLint *viewport, GLdouble *objX, *objY, *objZ)
 *
 *     sub esp, 32                   ; the point
 *     push 0x3ff00000               ; far, 1.0
 *     push 0
 *     push 0                        ; near, 0.0
 *     push 0
 *     push 0x3ff00000               ; w, 1.0
 *     push 0
 *     push dword [esp+80] x6        ; winZ, winY, winX
 *     push dword [esp+116] x3       ; viewport, proj, model
 *     lea eax, [esp+60]
 *     push eax
 *     call gluUnProjectPoint
 *     test eax, eax
 *     jz done                       ; no inverse: GL_FALSE
 *     push dword [esp+80] x3        ; objZ, objY, objX
 *     lea eax, [esp+12]
 *     push eax
 *     call gluUnProjectDivide       ; its answer is the call's
 *   done:
 *     add esp, 32
 *     ret 48
 *
 * The divide is placed after the point's code, reached through a second
 * label.
 */
export const unProjectCode = ()=>assemble([
    reserve(32),
    [0x68, ...dword(ONE_HIGH), 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
        0x68, ...dword(ONE_HIGH), 0x6a, 0x00],
    pushes(36 + 20 + 24, 6),
    pushes(36 + 32 + 48, 3),
    pushFrame(60),
    callHelper,
    ...unlessZero('done'),
    pushes(36 + 44, 3),
    pushFrame(12),
    { jump: [0xe8], to: 'divide' },
    'done',
    release(32),
    ret(48),
    'helper', [...COMPILED.gluUnProjectPoint.code],
    'divide', [...COMPILED.gluUnProjectDivide.code],
]);

/**
 * GLint gluUnProject4(GLdouble winX, winY, winZ, clipW, const GLdouble *model,
 *     const GLdouble *proj, const GLint *viewport, GLdouble nearVal, farVal,
 *     GLdouble *objX, *objY, *objZ, *objW)
 *
 *     sub esp, 32
 *     push dword [esp+92] x4        ; far, near
 *     push dword [esp+80] x8        ; clipW, winZ, winY, winX
 *     push dword [esp+124] x3       ; viewport, proj, model
 *     lea eax, [esp+60]
 *     push eax
 *     call gluUnProjectPoint
 *     test eax, eax
 *     jz done
 *     push dword [esp+108] x4       ; objW, objZ, objY, objX
 *     lea eax, [esp+16]
 *     push eax
 *     call gluUnProjectStore
 *   done:
 *     add esp, 32
 *     ret 76
 */
export const unProject4Code = ()=>assemble([
    reserve(32),
    pushes(36 + 56, 4),
    pushes(36 + 28 + 16, 8),
    pushes(36 + 40 + 48, 3),
    pushFrame(60),
    callHelper,
    ...unlessZero('done'),
    pushes(36 + 72, 4),
    pushFrame(16),
    { jump: [0xe8], to: 'store' },
    'done',
    release(32),
    ret(76),
    'helper', [...COMPILED.gluUnProjectPoint.code],
    'store', [...COMPILED.gluUnProjectStore.code],
]);
