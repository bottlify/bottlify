/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Single precision (PC = 00), as Direct3D leaves it: regions compiled for it
 * round every arithmetic result with no test of their own, a module that is
 * not `precise` rounds by Veltkamp's split, and the rounding is the one the
 * interpreter does -- bit for bit when `precise`, and in fast mode everywhere
 * but where the split is documented to differ (a double's denormals, and
 * magnitudes from 2^995 - 2^966 up), under every rounding control.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { blockState, interpret } from '../interp.js';

const CODE = 0x1000;
const ONE = 0x1ff8;
const DATA = 0x2000;
/** @param {number} a */
const at = a=>[a & 255, a >> 8 & 255, a >> 16 & 255, a >>> 24];

/** Every value run through `fld qword; fmul qword [ONE]; fstp qword`: the product is the value. */
const LOOP = (/** @type {number} */ count)=>[
    0xbe, ...at(DATA), // mov esi, DATA
    0xb9, ...at(count), // mov ecx, count
    0xdd, 0x06, // L: fld qword [esi]
    0xdc, 0x0d, ...at(ONE), // fmul qword [ONE]
    0xdd, 0x1e, // fstp qword [esi]
    0x83, 0xc6, 0x08, // add esi, 8
    0x49, // dec ecx
    0x75, 0xf0, // jnz L
    0xf4, // hlt
];

const bits = new Float64Array(1);
const words = new BigUint64Array(bits.buffer);
/** @param {bigint} b */
const fromBits = b=>{
    words[0] = b;
    return bits[0];
};
/** @param {number} x */
const bitsOf = x=>{
    bits[0] = x;
    return words[0];
};

/** The interpreter's rounding: at bit 29 of the double's bits, to nearest even. @param {number} x */
function integerRound(x){
    const t = bitsOf(x);
    if ((t & 0x7ff0000000000000n) === 0x7ff0000000000000n)
    {
        return x;
    }
    return fromBits((t + ((t >> 29n) & 1n) + 0x0fffffffn) & 0xffffffffe0000000n);
}

/** The value rounded to 24 significant bits, to nearest even, whatever its exponent. @param {number} x */
function significant24(x){
    if (!Number.isFinite(x) || x === 0)
    {
        return x;
    }
    const t = bitsOf(Math.abs(x));
    const biased = Number(t >> 52n);
    let m = biased === 0 ? t : t & 0xfffffffffffffn | 1n << 52n;
    let e = biased === 0 ? -1074 : biased - 1075;
    const shift = m.toString(2).length - 24;
    if (shift > 0)
    {
        const rest = m & ((1n << BigInt(shift)) - 1n);
        const half = 1n << BigInt(shift - 1);
        m >>= BigInt(shift);
        m += rest > half || (rest === half && (m & 1n) === 1n) ? 1n : 0n;
        e += shift;
    }
    // m <= 2^24 and e >= -1074: exact until it overflows.
    return Math.sign(x) * (e > 900 ? Number(m) * 2 ** 900 * 2 ** (e - 900) : Number(m) * 2 ** e);
}

/** Values of every kind the rounding meets. */
function values(){
    /** @type {number[]} */
    const list = [0, -0, 1, -1, 1 / 3, -2 / 3, Math.PI, 1e-30, 3.4e38, 1e300,
        Infinity, -Infinity, 2 ** -1022, 2 ** -1074, 3 * 2 ** -1074, 2 ** -1030 * 1.1];
    let seed = 0x2545f491;
    const random = ()=>{
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return seed >>> 0;
    };
    for (let k = 0; k < 200; k++)
    {
        // A tie, its two neighbours and the carry out of all ones, at random kept bits.
        const kept = BigInt(random() & 0x7fffff);
        const exponent = BigInt(1023 + (random() % 200) - 100);
        for (const low of [0x10000000n, 0x0fffffffn, 0x10000001n, 0x1fffffffn])
        {
            list.push(fromBits(exponent << 52n | kept << 29n | low) * (k & 1 ? -1 : 1));
        }
        list.push(fromBits(BigInt(random()) << 32n | BigInt(random())) % 1e30);
    }
    // A double's denormals, whose kept bits sit at a place of their own.
    for (let k = 0; k < 40; k++)
    {
        list.push(fromBits(BigInt(random()) << 20n | BigInt(random() & 0xfffff)));
    }
    // Around 2^995 - 2^966, where the split's c overflows.
    for (const b of [0x7e1ffffffeffffffn, 0x7e1fffffff000000n, 0x7e1fffffff000001n,
        0x7e20000010000000n, 0x7fefffffffffffffn, 0x7e1fffffe0000000n])
    {
        list.push(fromBits(b), -fromBits(b));
    }
    list.push(NaN);
    return list;
}

/**
 * Runs the values through the program under a control word, translated
 * (`precise` or not) or on the interpreter, and answers what was stored.
 *
 * @param {number[]} list @param {number} control @param {'interpreter' | boolean} how
 */
function round(list, control, how){
    const m = createTestMachine({ precise: how !== false });
    const view = new DataView(m.memory.buffer);
    view.setUint16(m.layout.x87Control, control, true);
    view.setFloat64(m.layout.ramBase + ONE, 1, true);
    list.forEach((x, i)=>view.setFloat64(m.layout.ramBase + DATA + i * 8, x, true));
    m.write(CODE, LOOP(list.length));
    m.setReg('esp', 0x80000);
    if (how === 'interpreter')
    {
        view.setUint32(m.layout.eip, CODE, true);
        const state = blockState({ memory: m.memory, layout: m.layout });
        state.syncIn();
        interpret(state, 10 * list.length + 10);
        state.syncOut();
        assert.equal(state.halted, true);
    }
    else
    {
        const exit = m.runProgram(CODE);
        assert.equal(exit.kind, 3, 'the program halts');
        // Wide first, then single seen: every value after the first went through the
        // region compiled for single.
        assert.equal(exit.regions, 2);
    }
    return list.map((_, i)=>view.getBigUint64(m.layout.ramBase + DATA + i * 8, true));
}

const LIST = values();

for (const rc of [0, 1, 2, 3])
{
    const control = 0x07f | rc << 10;
    test(`single precision under rounding control ${rc}: precise and the interpreter agree bit`
        + ' for bit, the fast split everywhere it is documented to', ()=>{
        const interpreted = round(LIST, control, 'interpreter');
        const precise = round(LIST, control, true);
        const fast = round(LIST, control, false);
        LIST.forEach((x, i)=>{
            const label = `${x} (${bitsOf(x).toString(16)})`;
            assert.equal(precise[i], interpreted[i], `precise ${label}`);
            if (Number.isNaN(x))
            {
                assert.ok(Number.isNaN(fromBits(fast[i])), `fast ${label}`);
                return;
            }
            assert.equal(interpreted[i], bitsOf(integerRound(x)),
                `the interpreter rounds at bit 29 whatever the rounding control: ${label}`);
            const huge = Math.abs(x) >= 2 ** 995 - 2 ** 966 && Number.isFinite(x);
            const denormal = x !== 0 && Math.abs(x) < 2 ** -1022;
            const want = huge ? x : denormal ? significant24(x) : integerRound(x);
            assert.equal(fast[i], bitsOf(want), `fast ${label}`);
        });
    });
}

test('a region compiled for single rounds with no test of its own and leaves when another'
    + ' precision is set, the machine then testing at every rounding instruction', ()=>{
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    view.setUint16(m.layout.x87Control, 0x07f, true);
    // 1.0f, 3.0f, two results, and a double-precision control word at +24.
    m.write(DATA, [0, 0, 0x80, 0x3f, 0, 0, 0x40, 0x40, ...new Array(16).fill(0), 0x7f, 0x02]);
    // fld dword [DATA]; fdiv dword [DATA+4]; fstp qword [DATA+8]; fldcw [DATA+24];
    // fld dword [DATA]; fdiv dword [DATA+4]; fstp qword [DATA+16]; hlt
    const divide = [0xd9, 0x05, ...at(DATA), 0xd8, 0x35, ...at(DATA + 4)];
    m.write(CODE, [...divide, 0xdd, 0x1d, ...at(DATA + 8), 0xd9, 0x2d, ...at(DATA + 24),
        ...divide, 0xdd, 0x1d, ...at(DATA + 16), 0xf4]);
    m.setReg('esp', 0x80000);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3);
    // Wide, then single at the first division, then both at the second.
    assert.equal(exit.regions, 3);
    assert.equal(view.getFloat64(m.layout.ramBase + DATA + 8, true), Math.fround(1 / 3));
    assert.equal(view.getFloat64(m.layout.ramBase + DATA + 16, true), 1 / 3);
    // local.get x87Control; i32.const 0x300; i32.and; (i32.eqz;) if: a test of single set,
    // or of another set.
    const single = [0x20, 0x23, 0x41, 0x80, 0x06, 0x71, 0x45, 0x04];
    const other = [0x20, 0x23, 0x41, 0x80, 0x06, 0x71, 0x04];
    /** @param {Uint8Array} bytes @param {number[]} pattern */
    const count = (bytes, pattern)=>bytes.reduce((n, _, i)=>n
        + (pattern.every((byte, k)=>bytes[i + k] === byte) ? 1 : 0), 0);
    // fld dword [DATA]; fdiv dword [DATA+4]; fmul dword [DATA+4]; fstp qword [DATA+8]; hlt
    m.write(CODE, [...divide, 0xd8, 0x0d, ...at(DATA + 4), 0xdd, 0x1d, ...at(DATA + 8), 0xf4]);
    const narrow = m.translate(CODE, { narrow: true }).bytes;
    const generic = m.translate(CODE, {}).bytes;
    assert.equal(count(generic, single), 2, 'a test at each rounding instruction');
    assert.equal(count(narrow, single), 0);
    assert.equal(count(narrow, other), 1, 'one test in the block, and none at the rounding');
});
