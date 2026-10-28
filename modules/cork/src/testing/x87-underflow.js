/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The x87 stack underflow as the processor answers it, with the invalid
 * operation masked: directed cases every executor of x87 is held to -- the
 * model (`ir-x87.test.js`), the wasm interpreter tier
 * (`interp-wasm-float.test.js`) and the translator (`emit/x87.test.js`).
 *
 * Measured on an Intel Xeon @ 2.80GHz (x86-64 Linux, gcc inline asm): each
 * case's state loaded by `frstor`, its code run, the state read by `fnsave`.
 * What they show, beside the IE and SF every underflow raises:
 *
 * - A register an instruction writes is held after it, the QNaN indefinite a
 *   stack fault writes included: `fchs` on an empty ST0 leaves ST0 held, the
 *   arithmetic its destination, `fpatan` its ST1 before the pop.
 * - `fcmovcc` with ST0 or ST(i) empty writes the indefinite into ST0 whatever
 *   the condition.
 * - `fxch` makes each empty register of the two the indefinite, then
 *   exchanges them.
 * - An underflow clears C1.
 * - The value an empty register still holds is no operand: a stale zero
 *   raises no ZE.
 * - `fxam` on an empty ST0 sets C1 from the sign of what the register still
 *   holds.
 *
 * Test support only: nothing in the product reads it.
 */

/** The QNaN indefinite. */
const INDEFINITE = NaN;

/** `mov eax, 3; or eax, 1`: ZF and CF clear. */
const NZ = [0xb8, 0x03, 0x00, 0x00, 0x00, 0x83, 0xc8, 0x01];
/** `xor eax, eax`: ZF set, CF clear. */
const Z = [0x31, 0xc0];

/** What every empty register holds unless a case says otherwise. */
export const STALE = -2.5;

/**
 * One case: the state it starts from -- the top, the physical registers held
 * and their values, what every other register still holds, C1 -- with the
 * control word `fninit` leaves and nothing else raised; the code; and what
 * the processor left: the top, the empty mask, the status word without the
 * top, and the value of every register held (NaN for the indefinite, whose
 * bits are cork's `0xfff8000000000000`).
 *
 * @typedef {Object} UnderflowCase
 * @property {string} name
 * @property {{ top: number, held?: Record<number, number>, stale?: number, c1?: boolean }} start
 * @property {number[]} code
 * @property {{ top: number, empty: number, status: number, regs: Record<number, number> }} want
 */

/** @type {readonly UnderflowCase[]} */
export const UNDERFLOW_CASES = [
    {
        name: 'fcmove st0, st1 on an empty stack, the condition false',
        start: { top: 0 },
        code: [...NZ, 0xda, 0xc9],
        want: { top: 0, empty: 0xfe, status: 0x41, regs: { 0: INDEFINITE } },
    },
    {
        name: 'fcmove st0, st1 on an empty stack, the condition true',
        start: { top: 0 },
        code: [...Z, 0xda, 0xc9],
        want: { top: 0, empty: 0xfe, status: 0x41, regs: { 0: INDEFINITE } },
    },
    {
        name: 'fcmovne st0, st1 with ST1 empty, the condition true',
        start: { top: 7, held: { 7: 1.5 } },
        code: [...NZ, 0xdb, 0xc9],
        want: { top: 7, empty: 0x7f, status: 0x41, regs: { 7: INDEFINITE } },
    },
    {
        name: 'fcmovne st0, st1 with ST1 empty, the condition false',
        start: { top: 7, held: { 7: 1.5 } },
        code: [...Z, 0xdb, 0xc9],
        want: { top: 7, empty: 0x7f, status: 0x41, regs: { 7: INDEFINITE } },
    },
    {
        name: 'fcmovb st0, st1 with ST0 empty, the condition false',
        start: { top: 6, held: { 7: 2.5 } },
        code: [...Z, 0xda, 0xc1],
        want: { top: 6, empty: 0x3f, status: 0x41, regs: { 6: INDEFINITE, 7: 2.5 } },
    },
    {
        name: 'fcmove st0, st1 on an empty stack clears C1',
        start: { top: 0, c1: true },
        code: [...Z, 0xda, 0xc9],
        want: { top: 0, empty: 0xfe, status: 0x41, regs: { 0: INDEFINITE } },
    },
    {
        name: 'fcmove st0, st1 with both held keeps C1',
        start: { top: 6, held: { 6: 1.5, 7: 2.5 }, c1: true },
        code: [...Z, 0xda, 0xc9],
        want: { top: 6, empty: 0x3f, status: 0x200, regs: { 6: 2.5, 7: 2.5 } },
    },
    {
        name: 'fxam on an empty ST0 holding a stale +1',
        start: { top: 0, stale: 1 },
        code: [0xd9, 0xe5],
        want: { top: 0, empty: 0xff, status: 0x4100, regs: {} },
    },
    {
        name: 'fxam on an empty ST0 holding a stale -1',
        start: { top: 0, stale: -1 },
        code: [0xd9, 0xe5],
        want: { top: 0, empty: 0xff, status: 0x4300, regs: {} },
    },
    {
        name: 'fld1; fchs; fstp st0; fxam: ST0 is the register below the -1',
        start: { top: 0, stale: 1 },
        code: [0xd9, 0xe8, 0xd9, 0xe0, 0xdd, 0xd8, 0xd9, 0xe5],
        want: { top: 0, empty: 0xff, status: 0x4100, regs: {} },
    },
    {
        name: 'fld1; fchs; ffree st0; fxam: ST0 is the freed -1',
        start: { top: 0, stale: 1 },
        code: [0xd9, 0xe8, 0xd9, 0xe0, 0xdd, 0xc0, 0xd9, 0xe5],
        want: { top: 7, empty: 0xff, status: 0x4300, regs: {} },
    },
    {
        name: 'fchs on an empty ST0',
        start: { top: 0, c1: true },
        code: [0xd9, 0xe0],
        want: { top: 0, empty: 0xfe, status: 0x41, regs: { 0: INDEFINITE } },
    },
    {
        name: 'fadd st1, st0 on an empty stack',
        start: { top: 0 },
        code: [0xdc, 0xc1],
        want: { top: 0, empty: 0xfd, status: 0x41, regs: { 1: INDEFINITE } },
    },
    {
        name: 'faddp st1, st0 with ST1 empty',
        start: { top: 7, held: { 7: 1.5 } },
        code: [0xde, 0xc1],
        want: { top: 0, empty: 0xfe, status: 0x41, regs: { 0: INDEFINITE } },
    },
    {
        name: 'fpatan on an empty stack',
        start: { top: 0 },
        code: [0xd9, 0xf3],
        want: { top: 1, empty: 0xfd, status: 0x41, regs: { 1: INDEFINITE } },
    },
    {
        name: 'fxch st1 with ST1 empty',
        start: { top: 7, held: { 7: 1.5 } },
        code: [0xd9, 0xc9],
        want: { top: 7, empty: 0x7e, status: 0x41, regs: { 0: 1.5, 7: INDEFINITE } },
    },
    {
        name: 'fxch st1 with ST0 empty',
        start: { top: 6, held: { 7: 2.5 } },
        code: [0xd9, 0xc9],
        want: { top: 6, empty: 0x3f, status: 0x41, regs: { 6: 2.5, 7: INDEFINITE } },
    },
    {
        name: 'fxch st1 on an empty stack',
        start: { top: 0, c1: true },
        code: [0xd9, 0xc9],
        want: { top: 0, empty: 0xfc, status: 0x41, regs: { 0: INDEFINITE, 1: INDEFINITE } },
    },
    {
        name: 'fsincos on an empty stack',
        start: { top: 0 },
        code: [0xd9, 0xfb],
        want: { top: 7, empty: 0x7e, status: 0x41, regs: { 0: INDEFINITE, 7: INDEFINITE } },
    },
    {
        name: 'fxtract on an empty ST0 holding a stale zero',
        start: { top: 0, stale: 0 },
        code: [0xd9, 0xf4],
        want: { top: 7, empty: 0x7e, status: 0x41, regs: { 0: INDEFINITE, 7: INDEFINITE } },
    },
    {
        name: 'fyl2x with ST0 empty holding a stale zero',
        start: { top: 6, held: { 7: 2.5 }, stale: 0 },
        code: [0xd9, 0xf1],
        want: { top: 7, empty: 0x7f, status: 0x41, regs: { 7: INDEFINITE } },
    },
    {
        name: 'fdiv st0, st1 with ST1 empty holding a stale zero',
        start: { top: 7, held: { 7: 1.5 }, stale: 0 },
        code: [0xd8, 0xf1],
        want: { top: 7, empty: 0x7f, status: 0x41, regs: { 7: INDEFINITE } },
    },
    {
        name: 'fst st1 with ST0 empty clears C1',
        start: { top: 0, c1: true },
        code: [0xdd, 0xd1],
        want: { top: 0, empty: 0xfd, status: 0x41, regs: { 1: INDEFINITE } },
    },
];

/**
 * Writes a case's starting x87 state into a state block of cork's f64 layout.
 *
 * @param {DataView} view
 * @param {{ x87: number, x87Top: number, x87Empty: number, x87Status: number,
 *     x87Control: number }} layout
 * @param {UnderflowCase['start']} start
 */
export function enterCase(view, layout, { top, held = {}, stale = STALE, c1 = false }){
    let empty = 0;
    for (let p = 0; p < 8; p++)
    {
        const isHeld = Object.hasOwn(held, p);
        empty |= isHeld ? 0 : 1 << p;
        view.setFloat64(layout.x87 + p * 16, isHeld ? held[p] : stale, true);
    }
    view.setUint8(layout.x87Top, top);
    view.setUint8(layout.x87Empty, empty);
    view.setUint16(layout.x87Status, c1 ? 0x200 : 0, true);
    view.setUint16(layout.x87Control, 0x37f, true);
}

/**
 * What a case left in the state block, as its `want` has it: the indefinite's
 * bits checked exactly, any other NaN reported as its bits.
 *
 * @param {DataView} view
 * @param {{ x87: number, x87Top: number, x87Empty: number, x87Status: number }} layout
 * @returns {{ top: number, empty: number, status: number, regs: Record<number, number | string> }}
 */
export function leftByCase(view, layout){
    const empty = view.getUint8(layout.x87Empty);
    /** @type {Record<number, number | string>} */
    const regs = {};
    for (let p = 0; p < 8; p++)
    {
        if ((empty >>> p & 1) === 0)
        {
            const word = view.getBigUint64(layout.x87 + p * 16, true);
            const value = view.getFloat64(layout.x87 + p * 16, true);
            regs[p] = Number.isNaN(value) && word !== 0xfff8000000000000n
                ? `NaN ${word.toString(16)}` : value;
        }
    }
    return {
        top: view.getUint8(layout.x87Top) & 7,
        empty,
        status: view.getUint16(layout.x87Status, true) & ~0x3800,
        regs,
    };
}
