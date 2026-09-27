/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interpreter tier in wasm's float instructions against the JavaScript
 * interpreter, bit for bit: generated x87 programs over a stack of every
 * shape -- empty, full, underflowing and overflowing -- and operands on the
 * edges (zeros of both signs, denormals, infinities, quiet and signalling
 * NaNs, the extended formats' odd encodings), under every precision and
 * rounding control, each run on both from the same state, and every
 * register's bits, the top, the empty mask, the status and control words,
 * the integer registers, the flags and the data compared. The hardware corpus
 * (`interp-wasm.itest.js`) judges values to seven digits and leaves C1 out;
 * this holds the tier to its reference exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fault, Unsupported, blockState, interpret } from './interp.js';
import { WASM_INTERPRETER_AREA, WasmExit, createWasmInterpreter } from './interp-wasm.js';
import { ownLayout, pagesFor, Tables } from './runtime/layout.js';
import { createPageTable } from './runtime/pages.js';
import { eflagsOf } from './emit/flags.js';
import { fpremStatus, fpremValue } from './ir-x87.js';

const RAM = 1 << 20;
const CODE = 0x1000;
const DATA = 0x8000;
const DATA_SIZE = 256;
const STACK = 0x20000;
const ARITH = 0x8d5;

/** A machine in cork's own layout and the tier over it, `precise` unless asked not to be. */
function machine({ precise = true } = {}){
    const layout = ownLayout({ ramSize: RAM });
    const area = layout.tables + Tables.SIZE;
    const pages = pagesFor(layout, Tables.SIZE + WASM_INTERPRETER_AREA);
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const table = createPageTable(memory, layout);
    const tier = createWasmInterpreter({ memory, layout, area, hotThreshold: 2,
        trapPort: 0xb077, parkBase: 0x100000, precise });
    assert.ok(tier);
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    return { layout, memory, table, tier, bytes, view };
}

/** @param {number} seed */
function random(seed){
    let s = seed >>> 0;
    return (/** @type {number} */ n)=>{
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return (s >>> 8) % n;
    };
}

/** Doubles on the edges: signed zeros, halves that round both ways, the limits of
 * every integer width, denormals, infinities, NaNs quiet and signalling. */
const F64 = [
    0n, 0x8000000000000000n, 0x3ff0000000000000n, 0xbff0000000000000n, 0x3fe0000000000000n,
    0xbfe0000000000000n, 0x3ff8000000000000n, 0x4004000000000000n, 0xc004000000000000n,
    0x4008000000000000n, 0x3fd5555555555555n, 0x400921fb54442d18n, 0x7fefffffffffffffn,
    0x0010000000000000n, 0x000fffffffffffffn, 0x0000000000000001n, 0x8000000000000001n,
    0x7ff0000000000000n, 0xfff0000000000000n, 0x7ff8000000000000n, 0xfff8000000000000n,
    0x7ff0000000000001n, 0x7ff4000000000000n, 0x7ff8000000000123n, 0x43e0000000000000n,
    0xc3e0000000000000n, 0x41e0000000000000n, 0xc1e0000000000000n, 0x40dfffe000000000n,
    0x40e0000000000000n, 0xc0e0000000000000n, 0x41dfffffffc00000n, 0x3810000000000000n,
    0x36a0000000000000n, 0x47efffffe0000000n, 0x3ff0000010000000n, 0x3ff0000030000000n,
    0x3ff00000f0000000n, 0x4330000000000001n, 0x4059000000000000n, 0xc0a7700000000000n,
    0x3e7ad7f29abcaf48n, 0x4415af1d78b58c40n, 0x3ff000001fffffffn,
];
/** The signalling ones among them, which a fast load leaves signalling. */
const SIGNALLING = [0x7ff0000000000001n, 0x7ff4000000000000n];
/** Singles on the same edges. */
const F32 = [
    0, 0x80000000, 0x3f800000, 0xbf800000, 0x3f000000, 0xbf000000, 0x40200000, 0xc0200000,
    0x7f7fffff, 0x00800000, 0x007fffff, 0x00000001, 0x7f800000, 0xff800000, 0x7fc00000,
    0xffc00000, 0x7f800001, 0x7fa00000, 0x4f000000, 0xcf000000, 0x46fffe00, 0x47000000,
    0x3eaaaaab, 0x40490fdb, 0x5f000000, 0xdf000000,
];
/** Integers on the edges of every width. */
const INTS = [0, 1, -1, 2, 3, -7, 0x7fff, -0x8000, 0x7fffffff, -0x80000000, 0x12345678, 100,
    -1000, 0x10000, 65535];
/** Extended encodings: normals, the integer bit clear (unnormal and pseudo-denormal),
 * denormals, infinities, NaNs quiet and signalling, exponents past a double's. */
/** @type {[bigint, number][]} */
const F80 = [
    [0x8000000000000000n, 0x3fff], [0x8000000000000000n, 0xbfff], [0n, 0], [0n, 0x8000],
    [0xc90fdaa22168c235n, 0x4000], [0x8000000000000001n, 0x3fff], [0xffffffffffffffffn, 0x3ffe],
    [0x8000000000000000n, 0x7fff], [0x8000000000000000n, 0xffff], [0xc000000000000000n, 0x7fff],
    [0x8000000000000001n, 0x7fff], [0xc000000000000001n, 0xffff], [0x4000000000000000n, 0x3fff],
    [0x0000000000000001n, 0], [0x8000000000000000n, 0x0001], [0x8000000000000000n, 0x7ffe],
    [0x8000000000000000n, 0x0100], [0x8000000000000000n, 0x3c01], [0x8000000000000000n, 0x3bcd],
    [0x0000000000000000n, 0x3fff], [0xfffffffffffff800n, 0x43fe], [0xfffffffffffffc00n, 0x3fff],
];
const CONTROLS = [0x37f, 0x27f, 0x07f, 0x77f, 0xb7f, 0xf7f, 0x47f, 0x87f, 0xc7f, 0x37e, 0x07e];
const STATUS = [0, 0x4700, 0x0041, 0x0200, 0x4500, 0x3800];

/**
 * Sets the machine to a program's start: the data slots each of one type, the
 * stack of a random shape, the integer registers, the flags.
 *
 * @param {ReturnType<typeof machine>} m @param {number[]} code
 * @param {(n: number) => number} next
 * @param {boolean} [signalling] whether the data's doubles include signalling NaNs
 */
function reset(m, code, next, signalling = true){
    const { bytes, view, layout } = m;
    bytes.fill(0, 0, 512);
    bytes.fill(0, layout.ramBase, layout.ramBase + RAM);
    bytes.set(code, layout.ramBase + CODE);
    for (let slot = 0; slot < DATA_SIZE; slot += 16)
    {
        const at = layout.ramBase + DATA + slot;
        switch (next(5))
        {
            case 0:
            {
                const pick = ()=>{
                    const value = F64[next(F64.length)];
                    return signalling || !SIGNALLING.includes(value) ? value : 0n;
                };
                view.setBigUint64(at, pick(), true);
                view.setBigUint64(at + 8, pick(), true);
                break;
            }
            case 1:
                for (let i = 0; i < 16; i += 4)
                {
                    view.setUint32(at + i, F32[next(F32.length)], true);
                }
                break;
            case 2:
                for (let i = 0; i < 16; i += 4)
                {
                    view.setInt32(at + i, INTS[next(INTS.length)], true);
                }
                break;
            case 3:
            {
                const [low, high] = F80[next(F80.length)];
                view.setBigUint64(at, low, true);
                view.setUint16(at + 8, high, true);
                view.setUint16(at + 10, INTS[next(INTS.length)], true);
                break;
            }
            default:
                for (let i = 0; i < 16; i += 2)
                {
                    view.setInt16(at + i, INTS[next(INTS.length)], true);
                }
                break;
        }
    }
    for (let r = 0; r < 8; r++)
    {
        view.setUint32(layout.regs + r * 4, INTS[next(INTS.length)] >>> 0, true);
    }
    view.setUint32(layout.regs + 3 * 4, DATA + DATA_SIZE / 2, true);
    view.setUint32(layout.regs + 4 * 4, STACK, true);
    view.setUint32(layout.eflags, 2 | next(0x1000) & ARITH, true);
    for (let i = 0; i < 8; i++)
    {
        view.setBigUint64(layout.x87 + i * 16, F64[next(F64.length)], true);
    }
    view.setUint8(layout.x87Top, next(8));
    view.setUint8(layout.x87Empty, [0xff, 0, next(256), next(256), 0xfe, 0x7f][next(6)]);
    view.setUint16(layout.x87Control, CONTROLS[next(CONTROLS.length)], true);
    view.setUint16(layout.x87Status, STATUS[next(STATUS.length)] & ~0x3800, true);
    for (let word = 0; word < 32; word += 2)
    {
        const kind = next(3);
        const pick = kind === 0 ? F64[next(F64.length)]
            : BigInt(kind === 1 ? F32[next(F32.length)] : INTS[next(INTS.length)] >>> 0)
                | BigInt(F32[next(F32.length)]) << 32n;
        view.setBigUint64(layout.xmm + word * 4, pick, true);
    }
    view.setUint32(layout.mxcsr, 0x1f80 | next(4) << 13, true);
    view.setUint32(layout.eip, CODE, true);
}

/** Every x87 register form the decoder knows, by escape: the modrm bytes. */
const REGISTER_FORMS = [
    [0xc0, 0x100],
    [0xc0, 0xd1, 0xd8, 0xe2, 0xe4, 0xe6, 0xe8, 0xef, 0xf0, 0x100],
    [0xc0, 0xe0, 0xe9, 0xea],
    [0xc0, 0xe0, 0xe2, 0xe3, 0xe4, 0xe5, 0xe8, 0xf8],
    [0xc0, 0x100],
    [0xc0, 0xf0],
    [0xc0, 0xd8, 0xd9, 0xda, 0xe0, 0x100],
    [0xc0, 0xe1, 0xe8, 0xf8],
].map(ranges=>{
    /** @type {number[]} */
    const modrms = [];
    for (let at = 0; at < ranges.length; at += 2)
    {
        for (let m = ranges[at]; m < ranges[at + 1]; m++)
        {
            modrms.push(m);
        }
    }
    return modrms;
});

/** A memory operand in the data: [ebx + disp8], ebx at the data's middle so every
 * signed displacement lands in it. */
const memory = (/** @type {number} */ g, /** @type {number} */ disp)=>[0x43 | g << 3, disp];

/** The integer loads and stores by escape, their /r forms.
 * @type {[number, number[]][]} */
const INTEGER_FORMS = [[0xdb, [0, 1, 2, 3]], [0xdd, [1]], [0xdf, [0, 1, 2, 3, 5, 7]]];

/**
 * One generated x87 instruction, or a short sequence around one: a control word
 * loaded, flags a compare left read back.
 *
 * @param {(n: number) => number} next
 * @param {boolean} [observe] whether the status word may be stored where a comparison sees it
 * @returns {number[]}
 */
function x87Instruction(next, observe = true){
    const disp = (/** @type {number} */ align)=>next(DATA_SIZE / align - 2) * align;
    switch (next(16))
    {
        case 0: case 1: case 2:
        {
            // Arithmetic and compares with a memory operand: m32fp, m32int, m64fp, m16int.
            const escape = [0xd8, 0xda, 0xdc, 0xde][next(4)];
            return [escape, ...memory(next(8), disp(escape === 0xde ? 2 : 4))];
        }
        case 3:
            // fld, fst, fstp: m32fp, m64fp; fld, fstp m80fp at a slot's start.
            return next(3) === 0 ? [0xdb, ...memory([5, 7][next(2)], disp(16))]
                : [[0xd9, 0xdd][next(2)], ...memory([0, 2, 3][next(3)], disp(4))];
        case 4:
        {
            // fild, fisttp, fist, fistp: m32, m64, m16.
            const [escape, forms] = INTEGER_FORMS[next(INTEGER_FORMS.length)];
            return [escape, ...memory(forms[next(forms.length)], disp(2))];
        }
        case 5:
        {
            // A control word stored and loaded: every precision and rounding.
            const word = CONTROLS[next(CONTROLS.length)];
            const at = disp(2);
            return [0x66, 0xc7, 0x43, at, word & 0xff, word >>> 8, 0xd9, 0x6b, at];
        }
        case 6:
            // fnstcw, fnstsw to memory; fnstsw ax and sahf.
            return [[0xd9, ...memory(7, disp(2))], [0xdd, ...memory(7, disp(2))],
                [0xdf, 0xe0, 0x9e], [0xdf, 0xe0]][observe ? next(4) : 0];
        case 7:
        {
            // fcomi and the like, their flags read by a setcc.
            const escape = [0xdb, 0xdf][next(2)];
            return [escape, (next(2) ? 0xe8 : 0xf0) | next(8), 0x0f, 0x90 | next(16),
                0xc0 | next(8)];
        }
        case 8:
            // fcmov after a compare of two registers.
            return [0x39, 0xc0 | next(64), [0xda, 0xdb][next(2)], 0xc0 | next(32)];
        case 9:
            return [[0xdb, 0xe3], [0xdb, 0xe2], [0x9b]][next(3)];
        default:
        {
            const escape = next(8);
            const forms = REGISTER_FORMS[escape];
            const form = forms[next(forms.length)];
            // fnstsw ax, fnop in its place when the status word may not be seen.
            return escape === 7 && form === 0xe0 && !observe ? [0xd9, 0xd0] : [0xd8 + escape, form];
        }
    }
}

/** The SSE opcodes by the mandatory prefixes (none, 66, F3, F2) the decoder has them under,
 * and whether an immediate follows. @type {[number, number[], boolean][]} */
const SSE_FORMS = [
    [0x10, [0, 1, 2, 3], false], [0x11, [0, 1, 2, 3], false], [0x12, [0, 1, 2, 3], false],
    [0x13, [0, 1], false], [0x14, [0, 1], false], [0x15, [0, 1], false], [0x16, [0, 1, 2], false],
    [0x17, [0, 1], false], [0x28, [0, 1], false], [0x29, [0, 1], false], [0x2a, [2, 3], false],
    [0x2b, [0, 1], false], [0x2c, [2, 3], false], [0x2d, [2, 3], false], [0x2e, [0, 1], false],
    [0x2f, [0, 1], false], [0x50, [0, 1], false], [0x51, [0, 1, 2, 3], false],
    [0x52, [0, 2], false], [0x53, [0, 2], false], [0x54, [0, 1], false], [0x55, [0, 1], false],
    [0x56, [0, 1], false], [0x57, [0, 1], false], [0x58, [0, 1, 2, 3], false],
    [0x59, [0, 1, 2, 3], false], [0x5a, [0, 1, 2, 3], false], [0x5b, [0, 1, 2], false],
    [0x5c, [0, 1, 2, 3], false], [0x5d, [0, 1, 2, 3], false], [0x5e, [0, 1, 2, 3], false],
    [0x5f, [0, 1, 2, 3], false], [0x6e, [1], false], [0x6f, [1, 2], false], [0x70, [1, 2, 3], true],
    [0x7c, [1, 3], false], [0x7d, [1, 3], false], [0x7e, [1, 2], false], [0x7f, [1, 2], false],
    [0xc2, [0, 1, 2, 3], true], [0xc4, [1], true], [0xc5, [1], true], [0xc6, [0, 1], true],
    [0xd0, [1, 3], false], [0xd6, [1], false], [0xd7, [1], false], [0xe6, [1, 2, 3], false],
    [0xe7, [1], false], [0xf0, [3], false],
    ...[0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x74,
        0x75, 0x76, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf,
        0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef, 0xf1,
        0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe]
        .map(op=>/** @type {[number, number[], boolean]} */ ([op, [1], false])),
];
/** The prefix byte of each mandatory-prefix key. */
const PREFIX = [[], [0x66], [0xf3], [0xf2]];
/** The opcodes that write a general register named by the modrm's reg field, and by its r/m. */
const WRITES_G = new Set([0x2c, 0x2d, 0x50, 0xc5, 0xd7]);
const WRITES_E = new Set([0x7e]);
/** The forms whose r/m is a register alone, and memory alone. */
const REGISTER_ONLY = new Set([0x50, 0xc5, 0xd7]);
const MEMORY_ONLY = new Set([0x13, 0x17, 0x2b, 0xe7, 0xf0]);
/** MXCSR values: every rounding control. */
const MXCSRS = [0x1f80, 0x3f80, 0x5f80, 0x7f80];

/**
 * One generated SSE instruction, or a short sequence around one: an MXCSR loaded,
 * the flags a compare left read back.
 *
 * @param {(n: number) => number} next
 * @returns {number[]}
 */
function sseInstruction(next){
    const disp = (/** @type {number} */ align)=>next(DATA_SIZE / align - 2) * align;
    const choice = next(24);
    if (choice === 0)
    {
        // An MXCSR stored and loaded (ldmxcsr), or stored back (stmxcsr).
        const word = MXCSRS[next(MXCSRS.length)];
        const at = disp(4);
        return next(3) === 0 ? [0x0f, 0xae, 0x5b, at]
            : [0xc7, 0x43, at, ...[0, 8, 16, 24].map(s=>word >>> s & 0xff), 0x0f, 0xae, 0x53, at];
    }
    if (choice === 1)
    {
        // A shift by an immediate: psrl /2, psra /4, psll /6, and the byte shifts of 73.
        const op = 0x71 + next(3);
        const kinds = op === 0x73 ? [2, 3, 6, 7] : [2, 4, 6];
        return [0x66, 0x0f, op, 0xc0 | kinds[next(kinds.length)] << 3 | next(8),
            [0, 1, 7, 8, 15, 16, 31, 32, 63, 64, 200][next(11)]];
    }
    const [op, keys, immediate] = SSE_FORMS[next(SSE_FORMS.length)];
    const key = keys[next(keys.length)];
    let reg = next(8);
    if (WRITES_G.has(op))
    {
        reg = [0, 1, 2, 5, 6, 7][next(6)];
    }
    const register = REGISTER_ONLY.has(op) || (!MEMORY_ONLY.has(op) && next(3) === 0);
    const modrm = !register ? [0x43 | reg << 3, disp(4)]
        : [0xc0 | reg << 3 | (WRITES_E.has(op) ? [0, 1, 2, 5, 6, 7][next(6)] : next(8))];
    const bytes = [...PREFIX[key], 0x0f, op, ...modrm];
    if (immediate)
    {
        bytes.push(op === 0xc2 ? next(10) : next(256));
    }
    // comiss and the like, their flags read by a setcc.
    return op === 0x2e || op === 0x2f ? [...bytes, 0x0f, 0x90 | next(16), 0xc0 | next(8)] : bytes;
}

/** Every bit a program leaves. */
function outcome(/** @type {ReturnType<typeof machine>} */ m, /** @type {string} */ ended){
    const { view, layout, bytes } = m;
    return {
        ended,
        regs: Array.from({ length: 8 }, (_, r)=>view.getUint32(layout.regs + r * 4, true)),
        eip: view.getUint32(layout.eip, true),
        flags: eflagsOf(view, layout) & ARITH,
        data: Array.from(bytes.subarray(layout.ramBase + DATA, layout.ramBase + DATA + DATA_SIZE)),
        st: Array.from({ length: 8 }, (_, i)=>view.getBigUint64(layout.x87 + i * 16, true)
            .toString(16)),
        top: view.getUint8(layout.x87Top) & 7,
        empty: view.getUint8(layout.x87Empty),
        status: view.getUint16(layout.x87Status, true) & ~0x3800,
        control: view.getUint16(layout.x87Control, true),
        xmm: Array.from({ length: 32 }, (_, word)=>view.getUint32(layout.xmm + word * 4, true)),
        mxcsr: view.getUint32(layout.mxcsr, true),
    };
}

/** @param {unknown} e */
function ending(e){
    if (e instanceof Fault)
    {
        return `fault ${e.vector}`;
    }
    if (e instanceof Unsupported)
    {
        return `unsupported ${e.op}`;
    }
    throw e;
}

function runJs(/** @type {ReturnType<typeof machine>} */ m){
    const state = blockState({ memory: m.memory, layout: m.layout });
    state.syncIn();
    let ended;
    try
    {
        interpret(state, 10_000);
        ended = state.halted ? 'halt' : 'budget';
    }
    catch (e){
        ended = ending(e);
        state.eip = /** @type {{ eip: number }} */ (e).eip;
    }
    state.syncOut();
    return outcome(m, ended);
}

/**
 * Runs on the wasm tier, the JavaScript interpreter taking what it leaves; counts the
 * x87 instructions it left.
 *
 * @param {ReturnType<typeof machine>} m @param {{ left: number }} count
 */
function runWasm(m, count){
    const state = blockState({ memory: m.memory, layout: m.layout });
    let left = 10_000;
    for (;;)
    {
        const code = m.tier.run(left);
        left -= m.tier.retired();
        if (code === WasmExit.HALT)
        {
            return outcome(m, 'halt');
        }
        if (code === WasmExit.FAULT)
        {
            return outcome(m, `fault ${m.tier.exitValue()}`);
        }
        if (code === WasmExit.UNSUPPORTED)
        {
            const eip = m.view.getUint32(m.layout.eip, true);
            let at = m.layout.ramBase + eip;
            while ([0x66, 0xf2, 0xf3].includes(m.bytes[at]))
            {
                at++;
            }
            const first = m.bytes[at];
            count.left += (first >= 0xd8 && first <= 0xdf) || first === 0x0f ? 1 : 0;
            state.syncIn();
            state.eip = eip;
            state.halted = false;
            try
            {
                left -= interpret(state, 1);
            }
            catch (e){
                const ended = ending(e);
                state.eip = /** @type {{ eip: number }} */ (e).eip;
                state.syncOut();
                return outcome(m, ended);
            }
            state.syncOut();
            if (state.halted)
            {
                return outcome(m, 'halt');
            }
        }
        if (left <= 0)
        {
            return outcome(m, 'budget');
        }
    }
}

/**
 * Generated programs on the tier and on the JavaScript interpreter, from the same
 * state, compared.
 *
 * @param {ReturnType<typeof machine>} m @param {number} seed @param {number} count
 * @param {{ status: number, signalling: boolean }} [fast] the status bits a fast tier
 *     may leave otherwise -- the programs then store no status word -- and whether the
 *     data may hold signalling NaNs
 * @param {(next: (n: number) => number, observe: boolean) => number[]} [make] an
 *     instruction, x87 unless said
 * @param {number} [share] the share of instructions the tier may leave
 */
function generated(m, seed, count, fast, make = x87Instruction, share = 1 / 20){
    const next = random(seed);
    const left = { left: 0 };
    let instructions = 0;
    for (let index = 0; index < count; index++)
    {
        /** @type {number[]} */
        const code = [];
        const length = 1 + next(16);
        for (let i = 0; i < length; i++)
        {
            code.push(...make(next, fast === undefined));
        }
        instructions += length;
        code.push(0xf4);
        const start = next(1 << 30);
        reset(m, code, random(start), fast?.signalling ?? true);
        const expected = runJs(m);
        reset(m, code, random(start), fast?.signalling ?? true);
        const actual = runWasm(m, left);
        if (fast !== undefined)
        {
            expected.status &= ~fast.status;
            actual.status &= ~fast.status;
        }
        assert.deepEqual(actual, expected, `program ${index}: ${code.map(b=>b.toString(16)
            .padStart(2, '0')).join(' ')}`);
    }
    // Only forms the decoder has no entry for, or the tier leaves by design, reach the
    // JavaScript tier.
    assert.ok(left.left < instructions * share, `${left.left} of ${instructions} left`);
}

test('generated x87 programs leave what the JavaScript interpreter leaves, bit for bit', ()=>{
    // X87_PROGRAMS and X87_SEED run more, or others.
    generated(machine(), Number(process.env.X87_SEED ?? 0x87),
        Number(process.env.X87_PROGRAMS ?? 6000));
});

test('unless precise, they differ only in IE, ZE, UE and C1', ()=>{
    // With no signalling NaN to load, which a fast m64 load leaves signalling.
    generated(machine({ precise: false }), Number(process.env.X87_SEED ?? 0x87) + 1,
        Number(process.env.X87_PROGRAMS ?? 6000),
        { status: 0x1 | 0x4 | 0x10 | 0x200, signalling: false });
});

/**
 * A program over an empty stack, round to nearest and extended precision, run on the tier
 * to its halt, with the data's first bytes (at ebx) set.
 *
 * @param {number[]} code @param {(view: DataView, at: number) => void} data
 * @param {number} [first] a first run of this many instructions, the rest in a second
 */
function onEmptyStack(code, data, first = 0){
    const m = machine();
    reset(m, [...code, 0xf4], random(5));
    m.view.setUint8(m.layout.x87Top, 0);
    m.view.setUint8(m.layout.x87Empty, 0xff);
    m.view.setUint16(m.layout.x87Status, 0, true);
    m.view.setUint16(m.layout.x87Control, 0x37f, true);
    const at = m.layout.ramBase + DATA + DATA_SIZE / 2;
    data(m.view, at);
    if (first > 0)
    {
        assert.equal(m.tier.run(first), WasmExit.BUDGET);
    }
    assert.equal(m.tier.run(100), WasmExit.HALT);
    return { m, at };
}

test('a quadword fild stored by a quadword fistp or fisttp copies all eight bytes', ()=>{
    // As the JavaScript interpreter keeps it (`exactWrites`): an exchange and a
    // register copy carry the quadword with its value, a write rounds it through
    // the double, and a run starts with none exact.
    const FILD = [0xdf, 0x6b, 0x00];    // fild qword [ebx]
    const FISTP = [0xdf, 0x7b, 0x08];   // fistp qword [ebx+8]
    const FISTTP = [0xdd, 0x4b, 0x08];  // fisttp qword [ebx+8]
    const between = {
        nothing: [],
        'fld1; fxch st1': [0xd9, 0xe8, 0xd9, 0xc9],
        'fld st0; fstp st1': [0xd9, 0xc0, 0xdd, 0xd9],
        'fnstsw ax': [0xdf, 0xe0],
    };
    /** @param {number[]} code @param {bigint} value @param {number} [first] */
    const quad = (code, value, first)=>{
        const { m, at } = onEmptyStack(code, (view, where)=>view.setBigInt64(where, value, true),
            first);
        return { stored: m.view.getBigInt64(at + 8, true), status: m.view.getUint16(
            m.layout.x87Status, true) };
    };
    for (const value of [0x7fffffffffffffffn, 0x0123456789abcdefn, (1n << 53n) + 1n,
        -((1n << 60n) + 3n), -0x8000000000000000n])
    {
        for (const [name, middle] of Object.entries(between))
        {
            for (const store of [FISTP, FISTTP])
            {
                const { stored, status } = quad([...FILD, ...middle, ...store], value);
                assert.equal(stored, value, `${value} with ${name} between`);
                assert.equal(status & 1, 0, 'no invalid operation');
            }
        }
    }
    const value = 0x0123456789abcdefn;
    assert.equal(quad([...FILD, 0xd9, 0xe0, 0xd9, 0xe0, ...FISTP], value).stored,
        0x0123456789abcdf0n, 'fchs twice rounds');
    assert.equal(quad([...FILD, ...FISTP], value, 1).stored, 0x0123456789abcdf0n,
        'a second run rounds');
});

test('fprem and fprem1 leave the model\'s exact remainder, and its quotient bits', ()=>{
    // [ST0, ST1, fprem's remainder and quotient mod 8, fprem1's], as ir.test.js has them.
    /** @type {[number, number, number, number, number, number][]} */
    const cases = [
        [3736.3244596153145, 7.049668791727009, 7.04966879172678, 1, -2.291500322826323e-13, 2],
        [1e17, 7, 5, 5, -2, 6],
        [-1e17, 7, -5, 5, 2, 6],
        [2 ** 63 + 2 ** 11, 3, 1, 5, 1, 5],
        [100, 2 * Math.PI, 5.7522203923062065, 7, -0.5309649148733797, 0],
    ];
    /** @param {number} low */
    const bits = low=>((low & 4) !== 0 ? 0x100 : 0) | ((low & 2) !== 0 ? 0x4000 : 0)
        | ((low & 1) !== 0 ? 0x200 : 0);
    for (const [a, c, rem, low, rem1, low1] of cases)
    {
        for (const [opcode, want, quotient] of [[0xf8, rem, low], [0xf5, rem1, low1]])
        {
            // fld qword [ebx+8]; fld qword [ebx]; fprem/fprem1; fstp qword [ebx+16]
            const { m, at } = onEmptyStack([0xdd, 0x43, 0x08, 0xdd, 0x43, 0x00, 0xd9, opcode,
                0xdd, 0x5b, 0x10], (view, where)=>{
                view.setFloat64(where, a, true);
                view.setFloat64(where + 8, c, true);
            });
            const name = `${opcode === 0xf8 ? 'fprem' : 'fprem1'}(${a}, ${c})`;
            assert.equal(m.view.getFloat64(at + 16, true), want, name);
            assert.equal(m.view.getUint16(m.layout.x87Status, true) & 0x4700, bits(quotient),
                `${name}: C0 C1 C2 C3`);
        }
    }
});

test('fxtract of an infinity, a NaN, a zero and a denormal is the model\'s', ()=>{
    // [the value, the significand (ST0), the exponent (ST1)]: an infinity is its
    // own significand with an exponent of +inf, a NaN both, a zero its own with
    // -inf, a denormal normalised.
    /** @type {[bigint, bigint, bigint][]} */
    const cases = [
        [0x7ff0000000000000n, 0x7ff0000000000000n, 0x7ff0000000000000n],
        [0xfff0000000000000n, 0xfff0000000000000n, 0x7ff0000000000000n],
        [0x7ff8000000000123n, 0x7ff8000000000123n, 0x7ff8000000000123n],
        [0xfff8000000000000n, 0xfff8000000000000n, 0xfff8000000000000n],
        [0x8000000000000000n, 0x8000000000000000n, 0xfff0000000000000n],
        [0x8000000000000003n, 0xbff8000000000000n, 0xc090c40000000000n],
    ];
    for (const [value, significand, exponent] of cases)
    {
        // fld qword [ebx]; fxtract; fstp qword [ebx+8]; fstp qword [ebx+16]
        const { m, at } = onEmptyStack([0xdd, 0x03, 0xd9, 0xf4, 0xdd, 0x5b, 0x08, 0xdd, 0x5b, 0x10],
            (view, where)=>view.setBigUint64(where, value, true));
        const name = `fxtract of 0x${value.toString(16)}`;
        assert.equal(m.view.getBigUint64(at + 8, true), significand, `${name}: the significand`);
        assert.equal(m.view.getBigUint64(at + 16, true), exponent, `${name}: the exponent`);
    }
});

test('fprem and fprem1 over random operands are the model\'s remainder and bits', ()=>{
    // The tier's own long division against `remainder` in ir-x87.js, which
    // the JavaScript interpreter calls: magnitudes across the whole range,
    // subnormals, quotients past 2^64 (a partial reduction), and dividends a
    // step below a multiple of the divisor.
    const next = random(31);
    const unit = ()=>next(1 << 24) / (1 << 24);
    const bits = new DataView(new ArrayBuffer(8));
    /** @type {[number, number][]} */
    const pairs = [[-0, 3], [7, -Infinity], [5e-324, 3e-323], [3e-323, 5e-324], [0.75, 1],
        [-0.75, -1], [0.5, 1], [2.5, 1], [3.5, 1], [1e300, 3], [2 ** 63 + 2 ** 11, 3]];
    while (pairs.length < 3000)
    {
        const c = (unit() + 0.5) * 2 ** (next(2100) - 1080) * (next(2) === 0 ? -1 : 1);
        let a = pairs.length % 2 === 0 ? (unit() + 0.5) * 2 ** (next(2100) - 1080)
            : (next(1000) + 1) * c * 2 ** (next(80) - 4);
        if (pairs.length % 3 === 0 && Number.isFinite(a) && a !== 0)
        {
            bits.setFloat64(0, a);
            bits.setBigUint64(0, bits.getBigUint64(0) - 1n);
            a = bits.getFloat64(0);
        }
        if (Number.isFinite(a) && Number.isFinite(c) && c !== 0)
        {
            pairs.push([next(2) === 0 ? a : -a, c]);
        }
    }
    const PAIRS = 0x40000;
    const OUT = 0x60000;
    /** @param {number} value */
    const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
    for (const [opcode, nearest] of [[0xf8, 0], [0xf5, 1]])
    {
        const m = machine();
        reset(m, [
            0xbe, ...u32(PAIRS), 0xbf, ...u32(OUT), 0xb9, ...u32(pairs.length),
            0xdd, 0x46, 0x08, 0xdd, 0x06,       // fld qword [esi+8] (c); fld qword [esi] (a)
            0xd9, opcode, 0xdf, 0xe0,           // fprem or fprem1; fnstsw ax
            0xdd, 0x1f, 0xdd, 0xd8,             // fstp qword [edi]; fstp st0
            0x89, 0x47, 0x08,                   // mov [edi+8], eax
            0x83, 0xc6, 0x10, 0x83, 0xc7, 0x10, // add esi, 16; add edi, 16
            0x49, 0x75, 0xe7,                   // dec ecx; jnz the loop
            0xf4,
        ], random(5));
        m.view.setUint8(m.layout.x87Top, 0);
        m.view.setUint8(m.layout.x87Empty, 0xff);
        m.view.setUint16(m.layout.x87Control, 0x37f, true);
        pairs.forEach(([a, c], i)=>{
            m.view.setFloat64(m.layout.ramBase + PAIRS + i * 16, a, true);
            m.view.setFloat64(m.layout.ramBase + PAIRS + i * 16 + 8, c, true);
        });
        // A jump back that turns hot leaves for the runtime, which enters again.
        let exit = m.tier.run(1e6);
        while (exit === WasmExit.HOT)
        {
            exit = m.tier.run(1e6);
        }
        assert.equal(exit, WasmExit.HALT);
        pairs.forEach(([a, c], i)=>{
            const at = m.layout.ramBase + OUT + i * 16;
            const name = `${nearest ? 'fprem1' : 'fprem'}(${a}, ${c})`;
            assert.ok(Object.is(m.view.getFloat64(at, true), fpremValue(a, c, nearest)), name);
            assert.equal(m.view.getUint32(at + 8, true) & 0x4700, fpremStatus(a, c, nearest),
                `${name}: C0 C1 C2 C3`);
        });
    }
});

test('unless precise, the sticky flags are not raised and a signalling NaN loaded is not seen',
    ()=>{
        /** @param {boolean} precise @param {number[]} code @param {(m: ReturnType<typeof machine>) => void} [set] */
        const run = (precise, code, set)=>{
            const m = machine({ precise });
            reset(m, [...code, 0xf4], random(3));
            m.view.setUint8(m.layout.x87Top, 0);
            m.view.setUint8(m.layout.x87Empty, 0xff);
            m.view.setUint16(m.layout.x87Status, 0, true);
            m.view.setUint16(m.layout.x87Control, 0x37f, true);
            set?.(m);
            assert.equal(m.tier.run(100), WasmExit.HALT);
            return outcome(m, 'halt');
        };
        const at = DATA + DATA_SIZE / 2;
        /** @param {bigint} bits */
        const double = bits=>(/** @type {ReturnType<typeof machine>} */ m)=>{
            m.view.setBigUint64(m.layout.ramBase + at, bits, true);
        };
        // fld1; fldz; fdivp: 1 / 0 -- the infinity either way, ZE only precise.
        for (const precise of [true, false])
        {
            const out = run(precise, [0xd9, 0xe8, 0xd9, 0xee, 0xde, 0xf9]);
            assert.equal(out.st[7], '7ff0000000000000');
            assert.equal(out.status & 0x4, precise ? 0x4 : 0, `ZE, precise ${precise}`);
        }
        // fld qword [ebx] of a signalling NaN: quieted with IE only precise.
        const snan = double(0x7ff0000000000001n);
        const exact = run(true, [0xdd, 0x03], snan);
        const fast = run(false, [0xdd, 0x03], snan);
        assert.deepEqual([exact.st[7], exact.status & 1], ['7ff8000000000001', 1]);
        assert.deepEqual([fast.st[7], fast.status & 1], ['7ff0000000000001', 0]);
        // fld qword [ebx] of a NaN; fcomp st0 (after fld1): C3 C2 C0 either way, IE only precise.
        const qnan = double(0x7ff8000000000000n);
        for (const precise of [true, false])
        {
            const out = run(precise, [0xdd, 0x03, 0xd9, 0xe8, 0xd8, 0xd9], qnan);
            assert.equal(out.status & 0x4500, 0x4500, 'unordered');
            assert.equal(out.status & 1, precise ? 1 : 0, `IE, precise ${precise}`);
        }
        // fld qword [ebx] of 1e300; fistp dword [ebx+8]: the integer indefinite either way.
        for (const precise of [true, false])
        {
            const out = run(precise, [0xdd, 0x03, 0xdb, 0x5b, 0x08], double(0x7e37e43c8800759cn));
            assert.deepEqual(out.data.slice(DATA_SIZE / 2 + 8, DATA_SIZE / 2 + 12), [0, 0, 0, 0x80]);
            assert.equal(out.status & 1, precise ? 1 : 0, `IE, precise ${precise}`);
        }
        // C1 set before a push that does not overflow: cleared only precise; an overflow
        // (fld1 onto a full stack) sets C1 and faults with IE and SF either way.
        const c1 = (/** @type {ReturnType<typeof machine>} */ m)=>{
            m.view.setUint16(m.layout.x87Status, 0x200, true);
        };
        assert.equal(run(true, [0xd9, 0xe8], c1).status & 0x200, 0);
        assert.equal(run(false, [0xd9, 0xe8], c1).status & 0x200, 0x200);
        for (const precise of [true, false])
        {
            const out = run(precise, [0xd9, 0xe8], m=>m.view.setUint8(m.layout.x87Empty, 0));
            assert.equal(out.status & 0x241, 0x241, `overflow, precise ${precise}`);
            assert.equal(out.st[7], 'fff8000000000000', 'the indefinite');
        }
        // fnstsw ax and fnstsw [ebx]: counted as reads that may see a relaxed bit, unless precise.
        for (const precise of [true, false])
        {
            const m = machine({ precise });
            reset(m, [0xdf, 0xe0, 0xdd, 0x3b, 0xf4], random(4));
            assert.equal(m.tier.run(100), WasmExit.HALT);
            assert.equal(m.tier.relaxedReads(), precise ? 0 : 2);
        }
    });

test('generated SSE programs leave what the JavaScript interpreter leaves, bit for bit', ()=>{
    // SSE_PROGRAMS and SSE_SEED run more, or others.
    generated(machine(), Number(process.env.SSE_SEED ?? 0x55e),
        Number(process.env.SSE_PROGRAMS ?? 6000), undefined, sseInstruction, 1 / 8);
});

test('an x87 access faults before its effect, and a store into translated code leaves after it',
    ()=>{
        const m = machine();
        const next = random(1);
        // mov eax, past RAM; fld dword [eax]; hlt
        reset(m, [0xb8, 0, 0, 0xff, 0x7f, 0xd9, 0x00, 0xf4], next);
        m.view.setUint8(m.layout.x87Empty, 0xff);
        m.view.setUint8(m.layout.x87Top, 3);
        assert.equal(m.tier.run(100), WasmExit.FAULT);
        assert.equal(m.tier.exitValue(), 13);
        assert.equal(m.view.getUint32(m.layout.eip, true), CODE + 5);
        assert.equal(m.view.getUint8(m.layout.x87Top), 3, 'nothing pushed');
        // fstp qword [ebx+8]; hlt -- translated code at ebx..ebx+0x1f.
        reset(m, [0xdd, 0x5b, 0x08, 0xf4], next);
        const at = m.view.getUint32(m.layout.regs + 12, true);
        m.view.setUint8(m.layout.x87Empty, 0xfe);
        m.view.setUint8(m.layout.x87Top, 0);
        m.view.setFloat64(m.layout.x87, 2.5, true);
        m.table.markCode(at, 0x20);
        assert.equal(m.tier.run(100), WasmExit.CODE_WRITE);
        assert.equal(m.tier.exitValue(), at + 8);
        assert.equal(m.tier.exitSize(), 8);
        assert.equal(m.view.getFloat64(m.layout.ramBase + at + 8, true), 2.5);
        assert.equal(m.view.getUint32(m.layout.eip, true), CODE + 3, 'past the store');
        assert.equal(m.view.getUint8(m.layout.x87Top), 1, 'popped');
    });

test('fcomi\'s flags replace a lazy record, and fcmov reads one folded', ()=>{
    const m = machine();
    // cmp eax, ecx (a lazy record); fcomi st0, st1; setb dl; cmp eax, ecx; fcmovb st0, st1; hlt
    reset(m, [0x39, 0xc8, 0xdb, 0xf1, 0x0f, 0x92, 0xc2, 0x39, 0xc8, 0xda, 0xc1, 0xf4], random(2));
    const { view, layout } = m;
    view.setUint32(layout.regs, 1, true);
    view.setUint32(layout.regs + 4, 2, true);
    view.setUint8(layout.x87Top, 0);
    view.setUint8(layout.x87Empty, 0xfc);
    view.setFloat64(layout.x87, 1, true);
    view.setFloat64(layout.x87 + 16, 3, true);
    assert.equal(m.tier.run(100), WasmExit.HALT);
    assert.equal(view.getUint32(layout.regs + 8, true) & 0xff, 1, '1 < 3: CF');
    assert.equal(view.getFloat64(layout.x87, true), 3, '1 - 2 borrows: moved');
});
